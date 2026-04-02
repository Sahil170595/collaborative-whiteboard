# Frontend Guide

## Component Hierarchy

```
App (App.tsx)
 |-- routing via discriminated union Page type
 |
 +-- Auth (components/Auth.tsx)
 |     Card-based login/signup form with SVG logo and branded heading.
 |     Toggles between login and signup modes internally.
 |     Calls api.ts, stores token via authStore.ts.
 |
 +-- CanvasList (components/CanvasList.tsx)
 |     Responsive grid of canvas cards (auto-fill, minmax 180px).
 |     Each card has a preview area and name/date footer.
 |     Create form. Logout button.
 |
 +-- CanvasPage (components/CanvasPage.tsx)
       The main whiteboard. Manages all real-time state.
       Includes WebSocket reconnection with exponential backoff.
       |
       +-- Toolbar (components/Toolbar.tsx)
       |     Floating bottom toolbar (fixed, centered, dark background).
       |     Inline SVG icons for tools (select, rectangle, ellipse, line, text).
       |     Fill/stroke color palette with custom color picker. Undo/redo.
       |     Separate back button fixed at top-left.
       |
       +-- <canvas> (HTML5 Canvas element)
       |     Rendered by canvasRenderer.ts with dot grid background.
       |     Mouse events handled by CanvasPage.
       |
       +-- InvitePanel (components/InvitePanel.tsx)
       |     Avatar row (top-right): colored circle per online user with initial.
       |     Plus button toggles invite dropdown. Invite by username or email.
       |
       +-- Connection status indicator (bottom-left)
             Shows connected/reconnecting/disconnected with colored dot.
```

### Component Responsibilities

| Component | State Owned | Network Calls |
|-----------|-------------|---------------|
| `App` | `page: Page` (discriminated union) | None |
| `Auth` | Form fields, mode (login/signup), error, loading | `api.signup()`, `api.login()` |
| `CanvasList` | Canvas array, new name input, loading, error | `api.getCanvases()`, `api.createCanvas()` |
| `CanvasPage` | All whiteboard state (see below) | `api.getCanvasDetail()`, WebSocket |
| `Toolbar` | None (controlled component) | None |
| `InvitePanel` | Invite input, message, expanded toggle | `api.inviteToCanvas()` |

---

## State Management Strategy

### The ref vs. state split

CanvasPage uses two categories of state:

**`useRef` for high-frequency, non-rendering data:**

| Ref | Type | Why ref |
|-----|------|---------|
| `shapesRef` | `Shape[]` | Updated on every op (local and remote). Re-rendering React on every shape change would be expensive; canvas is repainted via `requestAnimationFrame` instead. |
| `cursorsRef` | `Map<string, CursorInfo>` | Updated every ~30ms per remote user. Rendered directly to canvas. |
| `undoStackRef` | `UndoEntry[]` | Modified on every action. Only the count needs to trigger re-render. |
| `redoStackRef` | `UndoEntry[]` | Same. |
| `pendingOpsRef` | `Set<string>` | Mutated on send and on echo receipt. No UI depends on this. |
| `selectedIdRef` | `string \| null` | Changes on click. Canvas repaint handles selection box. |
| `dragModeRef` | `DragMode` | Changes on mousedown/move/up. High-frequency during drag. |
| `wsRef` | `WebSocket \| null` | Singleton connection reference. |
| `seqRef` | `number` | Updated on every op echo. Informational only. |
| `lastCursorSendRef` | `number` | Timestamp for cursor throttling. |
| `mountedRef` | `boolean` | StrictMode double-mount guard. |
| `wsInitReceivedRef` | `boolean` | Prevents HTTP-loaded shapes from overwriting WS init. |
| `reconnectAttemptRef` | `number` | Current reconnect attempt count for exponential backoff. |
| `reconnectTimerRef` | `setTimeout \| null` | Active reconnect timer so cleanup can cancel it. |
| `shouldReconnectRef` | `boolean` | Whether to attempt reconnection on close. |
| `connectWsFnRef` | `(() => void) \| null` | Stored `connectWebSocket` function for manual reconnect. |
| `cursorTargetsRef` | `Map<string, {x, y, timestamp}>` | Target positions for cursor lerp interpolation. |
| `lerpAnimFrameRef` | `number` | Animation frame ID for the cursor lerp loop. |

**`useState` for UI that needs re-renders:**

| State | Type | Triggers |
|-------|------|----------|
| `currentTool` | `Tool` | Toolbar highlight, cursor style |
| `fillColor` | `string` | Color picker value |
| `strokeColor` | `string` | Color picker value |
| `undoCount` | `number` | Undo button enabled/disabled |
| `redoCount` | `number` | Redo button enabled/disabled |
| `onlineUsers` | `PresenceUser[]` | InvitePanel user list |
| `wsConnected` | `boolean` | Connection status indicator |
| `wsStatus` | `"connected" \| "disconnected" \| "reconnecting"` | Tri-state connection indicator |
| `reconnectFailed` | `boolean` | Shows manual reconnect banner after max attempts |
| `error` | `string` | Error banner |

### Why this approach

From CLAUDE.md React 19 gotchas:

1. **Stale closures in WS handlers.** `onmessage` captures state at render time. If shapes were in `useState`, the handler would see stale data. Using `useRef` means every handler always reads the latest value from `shapesRef.current`.

2. **State batching drops WS messages.** React 18/19 batches `setState` calls in the same microtask. Rapid sequential WS messages (common during collaboration) could overwrite each other. Refs bypass batching entirely.

3. **StrictMode double-mount.** The `mountedRef` guard prevents the WebSocket connection from being established twice in development mode. The first mount sets `mountedRef.current = true`; the second mount returns early.

---

## Drawing Flow

```
mousedown                          mousemove (repeated)              mouseup
    |                                    |                              |
    v                                    v                              v
[select tool?]                   [update previewShape]          [finalize shape]
    |                             dimensions from delta              |
    +-- YES: hitTest() for       between cursor and startX/Y        +-- Check min size
    |   selection or move/resize                                    |   (width > 2 or
    |                                                               |    height > 2)
    +-- NO (draw tool):                                             |
        create previewShape                                         +-- Build forward op:
        with zero dimensions,                                       |   { kind: "add",
        current fill/stroke                                         |     shape: finalized }
        set dragMode to "draw"                                      |
                                                                    +-- Build reverse op:
                                                                    |   { kind: "delete",
                                                                    |     shapeId }
                                                                    |
                                                                    +-- doAction(fwd, rev)
                                                                         |
                                                                         +-- push to undoStack
                                                                         +-- clear redoStack
                                                                         +-- sendOp(forward)
                                                                              |
                                                                              +-- apply optimistically
                                                                              +-- generate opId
                                                                              +-- add to pendingOps
                                                                              +-- ws.send()
```

### Text tool special case

Text does not use the drag flow. On mousedown with the text tool:
1. `prompt("Enter text:")` collects text input.
2. A text shape is created at click position with estimated width (`text.length * fontSize * 0.6`).
3. The shape is immediately committed via `doAction`.

---

## Interaction Modes (DragMode)

`DragMode` is a discriminated union stored in `dragModeRef`:

```typescript
type DragMode =
  | { kind: "none" }
  | { kind: "draw"; startX: number; startY: number; previewShape: Shape }
  | { kind: "move"; shapeId: string; startX: number; startY: number;
      origX: number; origY: number }
  | { kind: "resize"; shapeId: string; corner: string;
      startX: number; startY: number;
      origX: number; origY: number; origW: number; origH: number };
```

| Mode | Trigger | mousemove Behavior | mouseup Behavior |
|------|---------|-------------------|-----------------|
| `none` | Default | Send cursor only | No-op |
| `draw` | mousedown with draw tool | Update previewShape dimensions from drag delta | Finalize shape via doAction if large enough |
| `move` | mousedown on existing shape (select tool) | Update shape x,y locally for live preview | Revert to original position, then commit via doAction |
| `resize` | mousedown on selection handle | Update x,y,width,height based on corner and drag delta | Revert to original dimensions, then commit via doAction |

### Move and Resize: Revert-then-Commit Pattern

During drag, the shape position/size is updated directly in `shapesRef.current` for immediate visual feedback. On mouseup, the local change is **reverted** to the original position, and then the final position is committed through `doAction` which:
1. Pushes to the undo stack
2. Sends the op to the server
3. Applies the op optimistically

This ensures the undo stack captures the complete before/after state correctly.

---

## Hit Testing

Implemented in `canvasRenderer.ts`. Shapes are tested in reverse z-order (topmost shape first).

### Per-shape algorithms

**Rectangle and Text (AABB):**
```
px >= shape.x - margin &&
px <= shape.x + shape.width + margin &&
py >= shape.y - margin &&
py <= shape.y + shape.height + margin
```
Margin = 4 pixels for easier selection.

**Ellipse (standard equation):**
```
cx = shape.x + shape.width / 2
cy = shape.y + shape.height / 2
rx = |shape.width / 2| + margin
ry = |shape.height / 2| + margin
(dx^2 / rx^2) + (dy^2 / ry^2) <= 1
```

**Line (segment distance):**
```
dist = distToSegment(px, py, x1, y1, x2, y2)
hit = dist <= strokeWidth / 2 + margin + 4
```

`distToSegment` computes the perpendicular distance from the point to the line segment by projecting the point onto the segment and clamping the parameter `t` to `[0, 1]`.

### Handle hit testing

Selection handles are 8x8px squares at the four corners of the selected shape. `hitTestHandle` returns the corner name (`"nw"`, `"ne"`, `"sw"`, `"se"`) or `null`.

---

## Canvas Rendering Pipeline

### renderScene (canvasRenderer.ts)

Called via `requestAnimationFrame` on every state change.

```
1. ctx.save()
2. ctx.setTransform(dpr, 0, 0, dpr, 0, 0)     // HiDPI scaling
3. Fill background (#f8f9fb)
4. Draw dot grid (1px dots at 20px spacing, color #d4d5db)
5. for each shape in shapes (EXCEPT selected shape):
     drawShape(ctx, shape)
6. Draw selected shape LAST (z-order lift for visual prominence)
7. if previewShape:
     drawShape(ctx, previewShape)               // live drawing preview
8. if selection:
     drawSelectionBox(ctx, selectedShape)        // dashed rect + corner handles
9. for each cursor in cursors:
     drawCursor(ctx, cursor)                     // arrow + username label (respects cursor.opacity)
10. ctx.restore()
```

**Changes from earlier version:** The background is now a filled rect + dot grid (not `clearRect`). Selected shapes are drawn last for a z-order "lift" effect. Cursor rendering respects an `opacity` field for idle fade-out.

### HiDPI Scaling

Canvas dimensions are set to `clientWidth * devicePixelRatio` by `clientHeight * devicePixelRatio`. The context is scaled by `dpr` so drawing coordinates remain in CSS pixels. This prevents blurriness on Retina/4K displays.

```typescript
const dpr = window.devicePixelRatio || 1;
canvas.width = rect.width * dpr;
canvas.height = rect.height * dpr;
// Then in renderScene:
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
```

### Shape Drawing

| Shape Type | Drawing Method |
|------------|---------------|
| Rectangle | `fillRect` + `strokeRect` |
| Ellipse | `ctx.ellipse(cx, cy, rx, ry, ...)` with `fill` + `stroke` |
| Line | `moveTo(x, y)` + `lineTo(x+w, y+h)` with `stroke` |
| Text | `fillText` at `(x, y + fontSize)`, optional `strokeText` |

### Selection Visualization

- Dashed blue rectangle 2px outside the shape bounds.
- Four solid blue 8x8px squares at corners for resize handles.

### Cursor Rendering

- Colored arrow polygon at cursor position.
- Rounded rectangle label with white text showing the username.
- `globalAlpha` is set from `cursor.opacity` (defaults to 1; fades to 0.3 after 5 seconds of inactivity via the lerp loop).

---

## Undo/Redo Stack Management

### Data Structure

```typescript
undoStackRef = useRef<UndoEntry[]>([]);
redoStackRef = useRef<UndoEntry[]>([]);
```

### Operations

| Action | undoStack | redoStack | Op Sent |
|--------|-----------|-----------|---------|
| Do (new action) | push `{forward, reverse}` | CLEAR | `forward` |
| Undo (Ctrl+Z) | pop last entry | push popped entry | `reverse` |
| Redo (Ctrl+Shift+Z / Ctrl+Y) | push popped entry | pop last entry | `forward` |

### Reverse Operation Construction (operations.ts)

`reverseOp(op, shapes)` builds the inverse:

| Forward op | Reverse op |
|-----------|------------|
| `add shape S` | `delete S.id` |
| `delete S.id` | `add snapshot-of-S` (captured before delete) |
| `update S.id props P` | `update S.id props {old values of P's keys}` |

Returns `null` if the target shape does not exist (already deleted by another user). Callers skip the undo entry in this case.

### Field-Level Reverse

For update operations, only the changed fields are captured in the reverse:

```typescript
// Forward: { kind: "update", shapeId: S, props: { fill: "red" } }
// Reverse: { kind: "update", shapeId: S, props: { fill: "<original fill>" } }
```

This means concurrent edits to different fields do not clobber each other on undo. If User A changes fill and User B changes stroke, undoing A's fill change does not affect B's stroke change.

---

## Auth Flow and Routing

### State-based routing (no react-router)

```typescript
type Page =
  | { kind: "login" }
  | { kind: "signup" }
  | { kind: "canvases" }
  | { kind: "canvas"; canvasId: string };
```

`App` uses `useState<Page>` to switch between views. Initial state checks `isAuthenticated()` (presence of token in localStorage).

### Auth lifecycle

```
1. App mounts
   |-- token in localStorage? -> { kind: "canvases" }
   |-- no token?              -> { kind: "login" }

2. Auth component
   |-- signup/login -> calls api.ts -> storeAuth(token, user) -> onAuth() -> canvases

3. CanvasList / CanvasPage
   |-- 401 from API -> clearAuth() -> onLogout() -> login

4. Logout button
   |-- clearAuth() -> onLogout() -> login
```

### Token storage

- `authStore.ts` wraps `localStorage` with `getStoredToken()`, `getStoredUser()`, `storeAuth()`, `clearAuth()`, `isAuthenticated()`.
- `api.ts` reads the token from localStorage for the `Authorization: Bearer` header.
- `CanvasPage` reads the token for the WebSocket URL query parameter.

---

## WebSocket Reconnection

CanvasPage implements automatic reconnection with exponential backoff and jitter:

- **Max attempts:** 10
- **Backoff delays:** 1s, 2s, 4s, 8s, 16s, 30s (capped), each multiplied by a random jitter factor `(0.5 + Math.random() * 0.5)`.
- **Auth failures (close codes 4001/4003)** are not retried. Code 4001 triggers logout.
- After the first connection succeeds, `shouldReconnectRef` is set to `true`. If the very first connection attempt fails (server not yet ready), it still retries.
- On reconnection, the server sends a fresh `init` message. The client clears undo/redo stacks, pendingOps, and cursor state on `init` to avoid stale data.
- After max attempts, a clickable "Connection lost" banner appears. Clicking it resets the attempt counter and retries.
- A tri-state status indicator (bottom-left corner) shows `connected` (green), `reconnecting` (yellow), or `disconnected` (red).

### Ping/Pong Heartbeat (client side)

The server sends `{ type: "ping" }` messages every 30 seconds. The client responds with `{ type: "pong" }`. This is handled in `ws.onmessage` before the typed `ServerMessage` switch, since `ping` is not part of the typed message union.

---

## Cursor Lerp Interpolation

Remote cursor positions are smoothed using linear interpolation (lerp) rather than snapping directly to received coordinates:

- Incoming cursor messages update `cursorTargetsRef` (target position + timestamp) but do not move the displayed cursor directly.
- A dedicated `requestAnimationFrame` loop (`lerpLoop`) runs continuously and interpolates each cursor toward its target at `LERP_FACTOR = 0.15` per frame.
- **Idle fade:** If a cursor target has not been updated for 5 seconds, its opacity is reduced to 0.3, providing a visual indication that the user is idle.
- The lerp loop only triggers a re-render when at least one cursor position or opacity actually changed.

---

## Canvas Resize

The canvas is resized based on its container (`containerRef`) rather than `window.innerWidth/innerHeight`. On `window.resize`, `resizeCanvas()` reads `container.getBoundingClientRect()`, sets the canvas CSS dimensions and backing store dimensions (`width * dpr`, `height * dpr`), then re-renders. This ensures the canvas fills its container correctly even if other UI elements affect layout.

---

## Input Guard on Keyboard Shortcuts

The `handleKeyDown` handler checks the event target's tag name before processing shortcuts. If the target is an `INPUT`, `TEXTAREA`, or `contentEditable` element, the handler returns early. This prevents undo/redo/delete shortcuts from firing while the user types in the invite panel or other form fields.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Ctrl+Y | Redo |
| Delete / Backspace | Delete selected shape |
