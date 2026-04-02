# PRD: Collaborative Canvas

## Overview

A real-time collaborative whiteboard where 2–5 users draw, move, and resize shapes on a shared canvas with live cursor presence. Think "Excalidraw-lite" — no hand-drawn aesthetic, no infinite plugin system, just a tight loop of shape CRUD over WebSocket with LWW conflict resolution and per-user undo.

**Target implementer:** AI coding agent (Claude, Codex, etc.) working from this spec alone.

---

## Tech Stack (Locked)

| Layer | Technology | Version Floor |
|---|---|---|
| Frontend | React 19, Vite 6, TypeScript 5 | — |
| Rendering | Raw Canvas 2D API | — |
| Backend | FastAPI ≥ 0.115, Python 3.12 | — |
| Database | PostgreSQL 16, asyncpg ≥ 0.30 | — |
| Real-time | WebSocket (native, via FastAPI) | — |
| Auth | JWT (access + refresh tokens) | — |
| Passwords | bcrypt or argon2id | — |

No additional rendering libraries (no react-konva, no fabric.js). Raw `CanvasRenderingContext2D` for all drawing.

---

## Data Model

### Shape (discriminated union)

Every shape shares a base, then specializes by `type`.

```typescript
interface ShapeBase {
  id: string;            // UUIDv4
  canvasId: string;      // FK → Canvas
  type: ShapeType;       // discriminator
  x: number;             // top-left x (canvas coords)
  y: number;             // top-left y (canvas coords)
  width: number;
  height: number;
  rotation: number;      // radians
  fill: string;          // CSS color
  stroke: string;        // CSS color
  strokeWidth: number;
  opacity: number;       // 0–1
  zIndex: number;
  version: number;       // monotonic, incremented on every mutation
  versionNonce: number;  // random tiebreaker for same-version conflicts
  createdBy: string;     // FK → User
  createdAt: string;     // ISO 8601
  updatedAt: string;     // ISO 8601
}

type ShapeType = "rectangle" | "ellipse" | "line" | "text";

interface RectangleShape extends ShapeBase {
  type: "rectangle";
  borderRadius: number;
}

interface EllipseShape extends ShapeBase {
  type: "ellipse";
}

interface LineShape extends ShapeBase {
  type: "line";
  points: [number, number][]; // array of [x, y] relative to shape origin
}

interface TextShape extends ShapeBase {
  type: "text";
  content: string;
  fontSize: number;
  fontFamily: string;
  textAlign: "left" | "center" | "right";
}

type Shape = RectangleShape | EllipseShape | LineShape | TextShape;
```

### Canvas

```typescript
interface Canvas {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}
```

### User

```typescript
interface User {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;   // bcrypt/argon2id — never sent to client
  createdAt: string;
}
```

### CanvasMembership

```typescript
interface CanvasMembership {
  canvasId: string;
  userId: string;
  role: "owner" | "editor" | "viewer";
  joinedAt: string;
}
```

### PostgreSQL Schema

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE canvases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id UUID REFERENCES users(id) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE canvas_memberships (
  canvas_id UUID REFERENCES canvases(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (canvas_id, user_id)
);

CREATE TABLE shapes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id UUID REFERENCES canvases(id) ON DELETE CASCADE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('rectangle', 'ellipse', 'line', 'text')),
  data JSONB NOT NULL,          -- full shape payload minus id/canvas_id/type
  version INTEGER NOT NULL DEFAULT 1,
  version_nonce INTEGER NOT NULL,
  created_by UUID REFERENCES users(id) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_shapes_canvas ON shapes(canvas_id);
```

The `data` column holds all shape-specific fields (x, y, width, height, fill, stroke, etc.) as JSONB. This avoids schema migrations when shape properties change.

---

## Conflict Resolution: Last-Writer-Wins (LWW)

Follows the Excalidraw model. No CRDTs.

**Rules:**

1. Every shape mutation increments `version` on the client before sending.
2. On the server, an incoming shape update is accepted if and only if `incoming.version > stored.version`, OR `incoming.version == stored.version AND incoming.versionNonce > stored.versionNonce`.
3. If the incoming update is rejected (stale), the server responds with the current authoritative shape so the client can reconcile.
4. The server is the source of truth. Clients apply optimistic updates, but roll back if the server rejects.

**Why not CRDT:** For 2–5 users editing distinct shapes most of the time, LWW is simpler, debuggable, and sufficient. True concurrent edits to the same shape property are rare in whiteboard use cases; when they happen, last-write-wins is an acceptable UX tradeoff.

---

## WebSocket Protocol

Single WebSocket connection per user per canvas at `/ws/{canvas_id}?token={jwt}`.

### Connection Lifecycle

```
Client                          Server
  |--- GET /ws/{cid}?token=jwt --->|
  |                                | validate JWT
  |                                | verify canvas membership
  |                                | ws.accept()
  |<-- canvas:init (full state) ---|
  |                                |
  |--- shape:create -------------->| validate, store, broadcast
  |<-- shape:created (confirmed) --|
  |                                |
  |--- cursor:move --------------->| broadcast to others (no persist)
  |<-- cursor:update (from other) -|
  |                                |
  |--- ping ---------------------->|
  |<-- pong -----------------------|
```

### Message Envelope

All messages are JSON with a `type` discriminator:

```typescript
type ClientMessage =
  | { type: "shape:create"; shape: Shape }
  | { type: "shape:update"; shape: Shape }
  | { type: "shape:delete"; shapeId: string }
  | { type: "cursor:move"; x: number; y: number }
  | { type: "ping" };

type ServerMessage =
  | { type: "canvas:init"; shapes: Shape[]; users: PresenceUser[] }
  | { type: "shape:created"; shape: Shape }
  | { type: "shape:updated"; shape: Shape }
  | { type: "shape:deleted"; shapeId: string }
  | { type: "shape:rejected"; shape: Shape; reason: string }
  | { type: "cursor:update"; userId: string; x: number; y: number; displayName: string }
  | { type: "user:joined"; user: PresenceUser }
  | { type: "user:left"; userId: string }
  | { type: "pong" }
  | { type: "error"; message: string };

interface PresenceUser {
  userId: string;
  displayName: string;
  cursorX: number;
  cursorY: number;
  color: string;  // assigned server-side from a palette
}
```

### Auth on WebSocket

Browsers cannot set custom headers on WebSocket connections. JWT is passed as a query parameter. The server **must** validate the JWT and verify canvas membership **before** calling `ws.accept()`. If validation fails, close with 4001 (unauthorized) or 4003 (forbidden).

---

## WebSocket Reconnection (Required)

Without reconnection, users lose their live view after any network blip during a 30–90 minute session. This is not optional.

### Client Reconnection Logic

```
on disconnect:
  1. Set state to RECONNECTING (show UI indicator)
  2. Attempt reconnect with exponential backoff:
     - delays: 1s, 2s, 4s, 8s, 16s, 30s (cap)
     - add jitter: delay * (0.5 + Math.random() * 0.5)
  3. On each attempt:
     a. Check if access token is expired → refresh first
     b. Open new WebSocket to /ws/{canvas_id}?token={fresh_jwt}
     c. Server sends canvas:init with full current state
     d. Client replaces local shape map with server state
     e. Re-apply any unconfirmed optimistic operations
     f. Set state to CONNECTED
  4. After 10 consecutive failures → set state to DISCONNECTED
     - Show "Connection lost. Click to retry." banner
     - Manual retry resets the backoff counter
```

### Server-Side

- Ping/pong heartbeat every 30 seconds. If no pong received within 10 seconds, close the connection.
- On client disconnect, broadcast `user:left` to remaining users.
- On client reconnect, broadcast `user:joined` and send `canvas:init`.

---

## Presence System

### Cursor Broadcasting

- Client sends `cursor:move` throttled to every 50ms (max 20 messages/sec).
- Server broadcasts to all other users in the canvas room. No database persistence.
- Server assigns each user a color from a fixed palette on join, included in `user:joined` and `canvas:init`.

### Client-Side Interpolation

Remote cursors are lerped (linearly interpolated) on each animation frame to smooth out the 50ms update interval. Implementation:

```typescript
// On receiving cursor:update, store target position + timestamp
// On each requestAnimationFrame:
//   currentPos = lerp(currentPos, targetPos, 0.15)
//   render cursor at currentPos with user's color and displayName label
```

### Cursor Rendering

Each remote cursor is rendered on the canvas as:
- A small arrow/pointer shape in the user's assigned color
- A name label (displayName) offset below the cursor
- Fade out after 5 seconds of no movement (user idle)

---

## Undo/Redo

Per-user operation stacks on the client. Each user has independent undo history — undoing your action does not undo someone else's.

### Operation Model

```typescript
interface Operation {
  type: "create" | "update" | "delete";
  shapeId: string;
  forward: Partial<Shape> | null;   // the change that was applied
  inverse: Partial<Shape> | null;   // the change that reverses it
}
```

**How it works:**

- **Create** → inverse is a delete. Undo sends `shape:delete`.
- **Delete** → inverse is a create with the full shape data. Undo sends `shape:create`.
- **Update** → inverse is an update with the previous property values. Undo sends `shape:update` with the old values.

Undo pops from the undo stack, sends the inverse operation through the normal WebSocket flow (so it gets broadcast to all users and conflict-resolved), and pushes onto the redo stack.

Any new operation clears the redo stack.

---

## Canvas Rendering

### Architecture: Separate Document State from UI State

Following tldraw's pattern:

| Category | What | Synced via WS? |
|---|---|---|
| Document state | `Map<string, Shape>` — the shapes | Yes |
| UI state | Selection, viewport pan/zoom, drag state, tool mode | No (local only) |

### Render Loop

```
requestAnimationFrame loop:
  1. Clear canvas
  2. Apply viewport transform (pan + zoom)
  3. Draw shapes sorted by zIndex:
     - Rectangle: ctx.fillRect / ctx.strokeRect (with borderRadius via ctx.roundRect)
     - Ellipse: ctx.ellipse
     - Line: ctx.beginPath + ctx.moveTo/lineTo through points
     - Text: ctx.fillText (with word wrapping)
  4. Draw selection handles (if any shape selected)
  5. Draw remote cursors (interpolated positions)
  6. Draw selection rectangles of other users (optional, low priority)
```

### Interaction Handling

All pointer events go through a single handler that delegates based on current tool mode:

```
Tool modes: "select" | "rectangle" | "ellipse" | "line" | "text"

pointerdown:
  if mode == "select":
    hit-test shapes (reverse zIndex order) → start drag/resize
  else:
    start creating new shape at pointer position

pointermove:
  if dragging: update shape position (optimistic)
  if resizing: update shape dimensions (optimistic)
  if creating: update preview shape dimensions
  always: send throttled cursor:move

pointerup:
  finalize shape create/update → send via WebSocket
  push operation to undo stack
```

### Hit Testing

For each shape type, implement point-in-shape:
- **Rectangle:** AABB check (accounting for rotation via inverse transform)
- **Ellipse:** Distance from center ≤ 1 in normalized ellipse space
- **Line:** Distance from point to each line segment < threshold (e.g., 5px)
- **Text:** Bounding box check

### Selection Handles

When a shape is selected, draw 8 resize handles (corners + edge midpoints) as small squares. Dragging a handle resizes the shape from that anchor.

### Viewport (Pan & Zoom)

- **Pan:** Middle-click drag or Space+left-click drag. Translate the canvas transform.
- **Zoom:** Scroll wheel. Scale around the cursor position. Clamp to 10%–500%.
- All shape coordinates are in canvas space. `screenToCanvas(screenX, screenY)` and `canvasToScreen(canvasX, canvasY)` convert using the current viewport transform.

---

## REST API

### Auth Endpoints

```
POST /api/auth/register
  Body: { email, password, displayName }
  Response: { user, accessToken, refreshToken }

POST /api/auth/login
  Body: { email, password }
  Response: { user, accessToken, refreshToken }

POST /api/auth/refresh
  Body: { refreshToken }
  Response: { accessToken, refreshToken }
```

### Canvas Endpoints

```
POST   /api/canvases              — create canvas
GET    /api/canvases              — list canvases for current user
GET    /api/canvases/{id}         — get canvas + shapes (initial load)
DELETE /api/canvases/{id}         — delete canvas (owner only)

POST   /api/canvases/{id}/members — add member { userId, role }
DELETE /api/canvases/{id}/members/{userId} — remove member
```

All endpoints require `Authorization: Bearer {accessToken}` header. All responses are JSON. Standard HTTP status codes (201 created, 400 bad request, 401 unauthorized, 403 forbidden, 404 not found).

---

## Frontend Architecture

```
src/
├── main.tsx                     — React entry, router setup
├── App.tsx                      — route definitions
├── api/
│   ├── http.ts                  — fetch wrapper with token refresh
│   └── ws.ts                    — WebSocket manager (connect, reconnect, message dispatch)
├── auth/
│   ├── AuthContext.tsx           — React context for auth state
│   ├── LoginPage.tsx
│   └── RegisterPage.tsx
├── canvas/
│   ├── CanvasPage.tsx           — top-level canvas view
│   ├── CanvasRenderer.ts        — the requestAnimationFrame render loop (NOT a React component)
│   ├── ShapeRenderer.ts         — draw functions per shape type
│   ├── HitTest.ts               — point-in-shape for each type
│   ├── InteractionManager.ts    — pointer event → tool mode dispatch
│   ├── ViewportTransform.ts     — pan/zoom matrix math
│   ├── SelectionManager.ts      — selection state, resize handles
│   ├── UndoManager.ts           — per-user undo/redo stacks
│   ├── CursorRenderer.ts        — draw remote cursors with lerp
│   └── Toolbar.tsx              — tool mode selector, color picker, shape props
├── store/
│   ├── canvasStore.ts           — Map<string, Shape> + mutation methods
│   └── presenceStore.ts         — remote cursor positions
├── hooks/
│   ├── useCanvas.ts             — init renderer, wire up WS, cleanup
│   └── useAuth.ts               — login/register/refresh helpers
├── types/
│   └── index.ts                 — Shape, Canvas, User, WS message types
└── utils/
    └── math.ts                  — lerp, clamp, rotation transforms
```

### Key Architectural Decisions

1. **CanvasRenderer is not a React component.** It's a plain class that owns a `<canvas>` ref and runs its own rAF loop. React re-renders must not interfere with 60fps rendering. React only manages UI chrome (toolbar, modals, auth pages).

2. **Store is a simple Map, not Redux/Zustand.** The canvas renderer reads from `canvasStore` directly. When the WS receives a shape update, it mutates the store and the next rAF frame picks it up. No React state, no re-renders for shape changes.

3. **WebSocket manager** handles connection lifecycle, reconnection, and message routing. It dispatches incoming messages to the appropriate store (shape messages → canvasStore, cursor messages → presenceStore).

4. **React 19 StrictMode double-mount gotcha:** In development, StrictMode mounts components twice. The WebSocket connection must be established in a `useEffect` with proper cleanup to avoid duplicate connections. The WS manager should be a singleton — if a connection already exists for the canvas, reuse it.

---

## Backend Architecture

```
app/
├── main.py                      — FastAPI app, CORS, lifespan (DB pool)
├── config.py                    — env vars (DATABASE_URL, JWT_SECRET, etc.)
├── db.py                        — asyncpg pool creation/teardown
├── auth/
│   ├── router.py                — /api/auth/* endpoints
│   ├── service.py               — register, login, refresh logic
│   ├── jwt.py                   — create/verify JWT tokens
│   └── dependencies.py          — get_current_user dependency
├── canvases/
│   ├── router.py                — /api/canvases/* endpoints
│   ├── service.py               — CRUD + membership logic
│   └── models.py                — Pydantic schemas
├── ws/
│   ├── router.py                — /ws/{canvas_id} endpoint
│   ├── manager.py               — ConnectionManager (rooms, broadcast)
│   ├── handlers.py              — handle_shape_create/update/delete, handle_cursor
│   └── auth.py                  — validate JWT from query param before accept
└── shapes/
    ├── service.py               — shape CRUD with LWW logic
    └── models.py                — Pydantic schemas for shape types
```

### Connection Manager

```python
class ConnectionManager:
    """Manages WebSocket connections grouped by canvas_id."""

    def __init__(self):
        self.rooms: dict[str, dict[str, WebSocket]] = {}
        # rooms[canvas_id][user_id] = websocket

    async def connect(self, canvas_id: str, user_id: str, ws: WebSocket):
        ...

    async def disconnect(self, canvas_id: str, user_id: str):
        ...

    async def broadcast(self, canvas_id: str, message: dict, exclude_user: str | None = None):
        """Send to all users in a canvas room, optionally excluding sender."""
        ...
```

### LWW Implementation (Server)

```python
async def apply_shape_update(pool, incoming_shape: dict) -> dict | None:
    """
    Attempt to apply a shape update using LWW.
    Returns the accepted shape if successful, None if rejected (stale).
    On rejection, returns the current server shape for client reconciliation.
    """
    async with pool.acquire() as conn:
        current = await conn.fetchrow(
            "SELECT version, version_nonce FROM shapes WHERE id = $1",
            incoming_shape["id"]
        )
        if current is None:
            return None  # shape doesn't exist

        if (incoming_shape["version"] > current["version"] or
            (incoming_shape["version"] == current["version"] and
             incoming_shape["versionNonce"] > current["version_nonce"])):
            # Accept update
            await conn.execute(
                "UPDATE shapes SET data = $1, version = $2, version_nonce = $3, updated_at = now() WHERE id = $4",
                json.dumps(incoming_shape["data"]),
                incoming_shape["version"],
                incoming_shape["versionNonce"],
                incoming_shape["id"]
            )
            return incoming_shape
        else:
            # Reject — return current state for reconciliation
            return None  # caller fetches and sends shape:rejected
```

**Critical: all SQL uses asyncpg parameterized queries ($1, $2...). Never string-format SQL.**

---

## Security Checklist

These are implementation requirements, not suggestions:

- [ ] Validate JWT **before** `ws.accept()`. Unauthenticated WebSocket connections must be closed immediately with code 4001.
- [ ] Verify canvas membership on every WS connect. A valid JWT is not enough — the user must be a member of the canvas.
- [ ] Hash passwords with bcrypt (cost 12) or argon2id. Never store plaintext.
- [ ] All SQL queries use asyncpg parameterized syntax (`$1`, `$2`). Zero string formatting in queries.
- [ ] Access tokens expire in 15 minutes. Refresh tokens expire in 7 days.
- [ ] Rate-limit auth endpoints (5 attempts per minute per IP).
- [ ] CORS configured to allow only the frontend origin in production.
- [ ] Shape mutations validate that the user has `editor` or `owner` role. Viewers can connect to WS (for presence) but cannot create/update/delete shapes.

---

## Implementation Phases

### Phase 1: Foundation

Deliverables: User can register, log in, create a canvas, and see an empty canvas page.

- Database schema + migrations
- Auth endpoints (register, login, refresh)
- Canvas CRUD endpoints
- Frontend auth pages + routing
- Empty canvas page with toolbar UI

### Phase 2: Single-User Drawing

Deliverables: One user can create, select, move, resize, and delete all 4 shape types on the canvas.

- Canvas renderer (rAF loop)
- Shape rendering for all 4 types
- Hit testing
- Selection + resize handles
- Tool modes (select, rectangle, ellipse, line, text)
- Viewport pan + zoom
- Undo/redo (local only, no WS yet)

### Phase 3: Real-Time Collaboration

Deliverables: Multiple users see each other's changes in real-time with cursor presence.

- WebSocket endpoint with JWT auth + membership check
- Connection manager (rooms, broadcast)
- Shape CRUD over WS with LWW conflict resolution
- Canvas init (full state on connect)
- Cursor broadcasting + client-side lerp
- User join/leave presence

### Phase 4: Resilience

Deliverables: The app survives network blips and extended sessions.

- WebSocket reconnection with exponential backoff + jitter
- Token refresh during reconnection
- Full state resync on reconnect
- Heartbeat ping/pong (30s interval, 10s timeout)
- Connection status UI (connected / reconnecting / disconnected)
- Optimistic operation replay after resync

---

## Acceptance Criteria

The build is complete when:

1. Two users in separate browsers can simultaneously draw shapes on the same canvas and see each other's changes within 200ms.
2. Cursor presence shows other users' positions with smooth interpolation.
3. Closing a laptop lid for 30 seconds and reopening results in automatic reconnection and full state resync without user action.
4. Each user can undo their own actions without affecting the other user's shapes.
5. A viewer-role user can see live updates and cursors but cannot create or modify shapes.
6. All four shape types (rectangle, ellipse, line, text) can be created, selected, moved, resized, and deleted.
7. Pan and zoom work and all interactions remain correct at non-default viewport transforms.
8. No raw SQL string formatting exists anywhere in the codebase.
9. Passwords are hashed, JWTs are validated before WebSocket accept, and canvas membership is enforced.

---

## Out of Scope

Explicitly excluded from this build:

- Image/media upload on canvas
- Export (PNG, SVG, PDF)
- Comments or sticky notes
- Templates or pre-built components
- Real-time text co-editing within a single text shape (text shapes are LWW atomic — last writer wins on the whole content string)
- Mobile/touch support
- Offline mode
- Shape grouping
- Snap-to-grid or alignment guides
- Reactions/stamps/emoji
- Version history / time travel
- Share via link (invite-only via membership API)