# SCRATCH.md -- Comprehensive Codebase Reference

## 1. Project Overview

**What:** A real-time collaborative whiteboard. Multiple users share a canvas, draw shapes, see each other's cursors, and persist state across sessions.

**Deployment context:** 2-5 people on a video call doing synchronous design reviews. Sessions run 30-90 minutes. Teams revisit canvases later. Concurrent same-object edits are common.

**Origin:** Mechanize take-home interview assignment (3-hour solo block, followed by a defense call).

**Tech Stack (locked):**

| Layer       | Technology                                   |
|-------------|----------------------------------------------|
| Frontend    | React 19, TypeScript 5.6, Vite 6             |
| Backend     | FastAPI (Starlette), Python 3.12, Uvicorn    |
| Database    | PostgreSQL 16                                |
| DB driver   | asyncpg (async, `$1` param syntax)           |
| Auth        | JWT (HS256) via PyJWT, bcrypt password hashes |
| Transport   | Single WebSocket per user per canvas + HTTP for auth/CRUD |
| Containers  | Docker Compose (db, server, client)          |

---

## 2. Architecture Diagram

```
+---------------------------+       +----------------------------+
|        Browser (React)    |       |        Browser (React)     |
|                           |       |                            |
|  Auth -> localStorage     |       |  Auth -> localStorage      |
|  CanvasPage -> <canvas>   |       |  CanvasPage -> <canvas>    |
|                           |       |                            |
|  HTTP: /api/auth/*        |       |  HTTP: /api/auth/*         |
|  HTTP: /api/canvases/*    |       |  HTTP: /api/canvases/*     |
|  WS:   /ws?canvasId&token |       |  WS:   /ws?canvasId&token  |
+----------+-------+--------+       +--------+--------+----------+
           |       |                          |        |
     HTTP  |       | WS                 HTTP  |        | WS
           |       |                          |        |
+----------v-------v--------------------------v--------v----------+
|                    FastAPI Server (:3001)                        |
|                                                                 |
|  main.py          -- lifespan, CORS, error handler, route wiring|
|  auth.py          -- POST /signup, /login, GET /me              |
|  canvas.py        -- GET/POST /canvases, GET /:id, POST /invite |
|  ws.py            -- WS /ws: auth, init, ops, cursors, presence |
|  deps.py          -- get_current_user (JWT decode from header)  |
|  db.py            -- asyncpg pool singleton                     |
|  types.py         -- shared TypedDicts (mirror of types.ts)     |
|                                                                 |
|  In-memory state (ws.py module globals):                        |
|    presence{}     -- canvas_id -> user_id -> {ws, color, ...}   |
|    seq_counters{} -- canvas_id -> int (monotonic)               |
|    canvas_locks{} -- canvas_id -> asyncio.Lock                  |
+--------------------------+--------------------------------------+
                           |
                           | asyncpg (TCP :5432)
                           |
            +--------------v--------------+
            |     PostgreSQL 16 (:5432)   |
            |                             |
            |  users                      |
            |  canvases                   |
            |  canvas_members             |
            |  shapes                     |
            +-----------------------------+

Data flow summary:
  HTTP: auth + canvas CRUD (JSON over fetch)
  WS:   ops + cursors + presence (JSON over single socket per user per canvas)
  DB:   shapes are mutated per-op (no op log); presence is memory-only
```

---

## 3. File Map

### Root

| File | Purpose |
|------|---------|
| `BUILD_CONTRACT.md` | Frozen contract: schemas, protocols, ownership map, dispatch prompts |
| `CLAUDE.md` | AI agent instructions: stack, conventions, gotchas, CVEs |
| `AGENTS.md` | Multi-agent ownership boundaries, handoff format, review checklist |
| `README.md` | Take-home assignment instructions and evaluation criteria |
| `SETUP.md` | How to run (Docker Compose and local dev) |
| `docker-compose.yml` | Three services: db (PG 16), server (FastAPI), client (Vite) |
| `package.json` | Monorepo root; npm workspaces pointing to `client/` |
| `.gitignore` | Excludes node_modules, dist, .env, __pycache__, .venv |

### Server

| File | Purpose |
|------|---------|
| `server/schema.sql` | DDL: users, canvases, canvas_members, shapes tables + indexes |
| `server/pyproject.toml` | Python project: fastapi, uvicorn, asyncpg, pyjwt, bcrypt |
| `server/Dockerfile` | Multi-stage build: compile C extensions in builder, slim runtime |
| `server/app/__init__.py` | Empty package marker |
| `server/app/main.py` | FastAPI app: lifespan (pool init/close), CORS, error handler, route wiring, `/health` |
| `server/app/db.py` | asyncpg pool singleton (`get_pool()`, `close_pool()`) |
| `server/app/deps.py` | `get_current_user()`: JWT decode from Authorization header, returns `AuthUser` |
| `server/app/types.py` | Python TypedDicts mirroring `types.ts`: Shape, Operation, all messages, mappings |
| `server/app/auth.py` | `auth_router`: POST /signup, POST /login, GET /me |
| `server/app/canvas.py` | `canvas_router`: GET /, POST /, GET /{id}, POST /{id}/invite |
| `server/app/ws.py` | `websocket_endpoint()`: auth, init, op persist+broadcast, cursor relay, presence |

### Client

| File | Purpose |
|------|---------|
| `client/package.json` | React 19, Vite 6, TypeScript 5.6 dependencies |
| `client/tsconfig.json` | Strict mode, ES2022 target, react-jsx, bundler resolution |
| `client/vite.config.ts` | Dev proxy: `/api` -> `:3001`, `/ws` -> `ws://:3001` |
| `client/index.html` | SPA shell: `<div id="root">`, loads `/src/main.tsx` |
| `client/Dockerfile` | Node 22 Alpine, `npm install`, `npm run dev` |
| `client/src/types.ts` | CANONICAL shared contract: Shape, Operation, all message types |
| `client/src/main.tsx` | React 19 entry: StrictMode + createRoot |
| `client/src/App.tsx` | Root component: client-side routing via `Page` discriminated union |
| `client/src/api.ts` | HTTP client: typed fetch wrappers for all API endpoints |
| `client/src/authStore.ts` | localStorage-based token/user persistence |
| `client/src/operations.ts` | `applyOp()`: applies Operation to Shape[]; `reverseOp()`: builds undo inverse |
| `client/src/canvasRenderer.ts` | Canvas 2D rendering: shapes, selection box, handles, cursors, hit testing |
| `client/src/components/Auth.tsx` | Login/signup form with error handling |
| `client/src/components/CanvasList.tsx` | Lists user's canvases, create new canvas |
| `client/src/components/CanvasPage.tsx` | Main whiteboard: WS connection, mouse/keyboard handlers, undo/redo, rendering loop |
| `client/src/components/Toolbar.tsx` | Tool buttons, color pickers, undo/redo buttons |
| `client/src/components/InvitePanel.tsx` | Expandable panel: online users list, invite by username/email |

---

## 4. Data Flow

### 4a. Auth Flow

```
User fills signup form
  -> Auth.tsx handleSubmit()
    -> api.ts signup({ username, email, password })
      -> POST /api/auth/signup (JSON body)
        -> auth.py: hash password with bcrypt, INSERT INTO users
        -> Return { token: JWT, user: AuthUser }
      <- api.ts returns AuthResponse
    -> authStore.ts storeAuth(token, user) -- saves to localStorage
    -> App.tsx handleAuth() -- setPage({ kind: "canvases" })

Subsequent requests:
  -> api.ts authHeaders() reads token from localStorage
  -> Sends Authorization: Bearer <token>
  -> deps.py get_current_user() decodes JWT, returns AuthUser
  -> If expired/invalid: 401 -> ApiError -> redirect to login

JWT payload: { sub: userId, username, email, exp: now + 24h }
Signed with JWT_SECRET (HS256)
```

### 4b. Canvas CRUD Flow

```
CanvasList mounts
  -> useEffect calls api.getCanvases()
    -> GET /api/canvases (authed)
      -> canvas.py: SELECT canvases JOIN canvas_members WHERE user_id = $1
      -> Returns CanvasSummary[]

User creates canvas:
  -> handleCreate() -> api.createCanvas({ name })
    -> POST /api/canvases (authed)
      -> canvas.py: INSERT canvases + INSERT canvas_members (transaction)
      -> Returns CanvasSummary

User clicks canvas:
  -> onSelectCanvas(canvasId) -> App sets page to { kind: "canvas", canvasId }
  -> CanvasPage mounts -> loads detail + connects WS (see 4c)

User invites:
  -> InvitePanel handleInvite()
    -> api.inviteToCanvas(canvasId, { identifier })
      -> POST /api/canvases/{id}/invite
        -> canvas.py: look up user by username, then email
        -> INSERT canvas_members ON CONFLICT DO NOTHING
        -> Returns { ok: true }
```

### 4c. Drawing Flow (shape creation)

```
User selects Rectangle tool, mousedown on canvas
  -> handleMouseDown(): creates previewShape with crypto.randomUUID()
  -> dragModeRef = { kind: "draw", startX, startY, previewShape }

User drags mouse
  -> handleMouseMove(): updates previewShape dimensions
  -> requestRender() -> renderScene() draws preview on canvas

User releases mouse
  -> handleMouseUp():
    -> if shape has size > 2px:
      -> Build forward = { kind: "add", shape }
      -> Build reverse = { kind: "delete", shapeId }
      -> doAction(forward, reverse):
        -> Push { forward, reverse } onto undoStack, clear redoStack
        -> sendOp(forward):
          -> Apply optimistically: shapesRef.current = applyOp(shapes, op)
          -> Generate opId = crypto.randomUUID()
          -> Add opId to pendingOps
          -> ws.send({ type: "op", op, opId })

Server receives op (ws.py):
  -> Acquire canvas_locks[canvasId]
  -> _persist_add(): INSERT INTO shapes ... ON CONFLICT DO NOTHING
  -> If inserted (modified=True):
    -> Increment seq_counters[canvasId]
    -> Release lock
    -> _broadcast_all(): send { type: "op", op, userId, seq, opId } to ALL clients

Sender receives echo:
  -> ws.onmessage "op":
    -> pendingOps.has(opId) = true -> delete it
    -> op.kind === "add" -> skip (already applied optimistically)

Other client receives op:
  -> pendingOps.has(opId) = false
    -> applyOp(shapes, op) -> shape added to their shapesRef
    -> requestRender() -> shape appears on their canvas
```

### 4d. Undo/Redo Flow

```
Undo (Ctrl+Z):
  -> undo():
    -> Pop last entry from undoStack
    -> Push to redoStack
    -> sendOp(entry.reverse):
      -> Apply reverse op optimistically
      -> Send as normal op over WS
  -> Server persists the reverse op (e.g., DELETE for an add's undo)
  -> Server broadcasts to all clients

Redo (Ctrl+Shift+Z):
  -> redo():
    -> Pop last entry from redoStack
    -> Push to undoStack
    -> sendOp(entry.forward)
  -> Same persist + broadcast cycle

Reverse op construction (operations.ts reverseOp()):
  - add -> delete (shapeId)
  - delete -> add (snapshot of shape before deletion)
  - update -> update (only changed fields' old values)
  - Returns null if shape not found (already deleted by another user)

Key: server sees undo/redo as normal ops. No special undo protocol.
```

### 4e. Cursor Presence Flow

```
User moves mouse on canvas
  -> handleMouseMove():
    -> Throttle check: Date.now() - lastCursorSendRef >= 30ms
    -> sendWs({ type: "cursor", x, y })

Server receives cursor (ws.py):
  -> _broadcast() to all clients EXCEPT sender:
    -> { type: "cursor", userId, username, x, y }

Other client receives cursor:
  -> ws.onmessage "cursor":
    -> cursorsRef.current.set(userId, { x, y, username, color })
    -> requestRender()
    -> canvasRenderer.ts drawCursor(): arrow + username label

User connects:
  -> Server adds to presence[canvasId][userId]
  -> Assigns color from CURSOR_PALETTE (round-robin by current count)
  -> Sends "init" with all current users
  -> Broadcasts "join" to others

User disconnects:
  -> Server removes from presence
  -> Broadcasts "leave" to remaining clients
  -> Client removes cursor from map on "leave" message
```

---

## 5. Database Schema

```sql
-- pgcrypto enables gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT UNIQUE NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE canvases (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    owner_id   UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE canvas_members (
    canvas_id UUID NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (canvas_id, user_id)
);

CREATE TABLE shapes (
    id           UUID PRIMARY KEY,              -- client-generated, no default
    canvas_id    UUID NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    type         TEXT NOT NULL,                  -- rectangle|ellipse|line|text
    x            DOUBLE PRECISION NOT NULL DEFAULT 0,
    y            DOUBLE PRECISION NOT NULL DEFAULT 0,
    width        DOUBLE PRECISION NOT NULL DEFAULT 0,
    height       DOUBLE PRECISION NOT NULL DEFAULT 0,
    fill         TEXT NOT NULL DEFAULT '',
    stroke       TEXT NOT NULL DEFAULT '#000000',
    stroke_width DOUBLE PRECISION NOT NULL DEFAULT 2,
    text         TEXT,                           -- nullable, for text shapes
    font_size    DOUBLE PRECISION                -- nullable, for text shapes
);

CREATE INDEX idx_shapes_canvas ON shapes(canvas_id);
CREATE INDEX idx_canvas_members_user ON canvas_members(user_id);
```

**Relationships:**
- `canvases.owner_id` -> `users.id` (no cascade -- owner deletion not handled)
- `canvas_members` is a join table: composite PK `(canvas_id, user_id)`, both FK with CASCADE
- `shapes.canvas_id` -> `canvases.id` ON DELETE CASCADE

**Column naming:**
- DB uses `snake_case`: `stroke_width`, `font_size`, `owner_id`, `created_at`
- Wire format uses `camelCase`: `strokeWidth`, `fontSize`, `ownerId`, `createdAt`
- Mapping defined in `types.py`: `SHAPE_DB_TO_WIRE` / `SHAPE_WIRE_TO_DB`

---

## 6. WebSocket Protocol

### Connection

```
WS /ws?canvasId=<uuid>&token=<jwt>
```

Server validates JWT and canvas membership BEFORE `ws.accept()`.
- Close `4001`: auth failure (bad/missing token, bad canvasId)
- Close `4003`: not a canvas member

### Client -> Server

| Type | Fields | Description |
|------|--------|-------------|
| `op` | `type: "op"`, `op: Operation`, `opId: string` | Board operation (add/update/delete) with client-generated UUID |
| `cursor` | `type: "cursor"`, `x: number`, `y: number` | Cursor position in canvas coordinates |

`Operation` is one of:
- `{ kind: "add", shape: Shape }` -- full Shape object with client-generated id
- `{ kind: "update", shapeId: string, props: ShapePatch }` -- partial field update
- `{ kind: "delete", shapeId: string }` -- remove by id

### Server -> Client

| Type | Fields | Description |
|------|--------|-------------|
| `init` | `type`, `shapes: Shape[]`, `users: PresenceUser[]`, `seq: number` | Sent on connect. Full current state. |
| `op` | `type`, `op: Operation`, `userId: string`, `seq: number`, `opId: string` | Persisted op echoed to ALL clients (including sender) |
| `cursor` | `type`, `userId: string`, `username: string`, `x: number`, `y: number` | Cursor position from another user (never sent to self) |
| `join` | `type`, `user: PresenceUser` | New user connected (sent to others) |
| `leave` | `type`, `userId: string` | User disconnected (sent to others) |
| `error` | `type`, `message: string` | Error message |

`PresenceUser`: `{ userId, username, color }`

### Server Op Processing (steps from contract)

1. Receive `{ type: "op", op, opId }`
2. Acquire per-canvas `asyncio.Lock`
3. Persist to DB (INSERT/UPDATE/DELETE)
4. If no-op (row not modified): release lock, stop. No broadcast, no seq.
5. Increment `seq_counters[canvasId]`
6. Release lock
7. Broadcast `{ type: "op", op, userId, seq, opId }` to all clients

---

## 7. Key Design Decisions

### 7a. Server-Authoritative LWW with Seq Numbers

The server is the single source of truth. There is no OT or CRDT. Every successful mutation gets a per-canvas monotonic `seq` number. Clients track `seqRef` but currently don't use it for ordering -- they apply ops as they arrive. `seq` primarily exists to detect how far behind a client is and to enable future reconnection logic.

Conflict resolution is **last-write-wins at field level by server arrival order**. If User A sets `fill: red` and User B sets `fill: blue`, whichever the server processes second wins. Because `ShapePatch` is partial, different-field edits (e.g., A changes fill, B changes x) never conflict.

### 7b. Optimistic Updates with opId Reconciliation

```typescript
// CanvasPage.tsx sendOp():
const opId = crypto.randomUUID();
shapesRef.current = applyOp(shapesRef.current, op);  // optimistic
pendingOpsRef.current.add(opId);
ws.send({ type: "op", op, opId });
```

When the server echo comes back:

```typescript
// ws.onmessage "op":
const isOwnEcho = pendingOpsRef.current.has(msg.opId);
if (isOwnEcho) pendingOpsRef.current.delete(msg.opId);

if (isOwnEcho && msg.op.kind === "add") {
  // Skip -- shape already in array from optimistic add
} else {
  shapesRef.current = applyOp(shapesRef.current, msg.op);
  // Re-applies update/delete even for own ops
}
```

**Why update/delete echoes are re-applied for own ops:** Under concurrent edits, the optimistic local state may have been overwritten by a remote op that arrived between the local apply and the server echo. Re-applying the server-authoritative version ensures convergence. For `add`, re-applying would create a duplicate, so it's skipped.

If the server ignores a no-op (e.g., deleting an already-deleted shape), the pending opId is never removed. The optimistic state diverges until the next `init` on reconnect corrects it. This is an acceptable tradeoff given the deployment context.

### 7c. Per-Canvas asyncio.Lock for Op Serialization

```python
# ws.py
canvas_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

async with lock:
    async with pool.acquire(timeout=5) as conn:
        modified = await _persist_add(conn, canvas_id, shape)
    if modified:
        seq_counters[canvas_id] += 1
        seq = seq_counters[canvas_id]
# Lock released BEFORE broadcast
```

One lock per canvas ensures ops for the same canvas are serialized -- no interleaved reads/writes to shapes, no seq races. Different canvases are fully parallel. The lock is released before the broadcast to avoid holding it during potentially slow network I/O.

### 7d. Client-Side Undo/Redo with Field-Level Reverse Ops

```typescript
// operations.ts reverseOp():
case "update": {
  const reverseProps: ShapePatch = {};
  for (const key of Object.keys(op.props)) {
    reverseProps[key] = shape[key];  // capture old value of ONLY changed fields
  }
  return { kind: "update", shapeId, props: reverseProps };
}
```

Undo/redo are purely client-side stacks. The server never sees "undo" as a concept -- it receives the reverse operation as a normal op. This means:

- Different-field concurrent edits survive undo (field-level capture, not snapshot)
- Undo of "add" sends "delete" -- even if others modified the shape
- Undo of "delete" sends "add" with a pre-delete snapshot -- later concurrent changes are lost
- If the target shape no longer exists, the server ignores the op (no-op)
- `reverseOp()` returns `null` if the shape is already gone, and the caller skips pushing to the undo stack

### 7e. Refs vs useState Split in React

CanvasPage uses two categories of state:

**Refs** (high-frequency, no re-render needed):
- `shapesRef` -- shapes array (updated 60fps during drag, on every WS op)
- `cursorsRef` -- remote cursor positions (updated on every WS cursor message)
- `dragModeRef` -- current drag interaction state
- `selectedIdRef` -- currently selected shape
- `pendingOpsRef` -- Set of opIds awaiting server echo
- `undoStackRef` / `redoStackRef` -- undo stacks
- `seqRef` -- latest server seq
- `wsRef` -- WebSocket instance
- `lastCursorSendRef` -- throttle timestamp

**useState** (triggers re-renders for UI):
- `currentTool`, `fillColor`, `strokeColor` -- toolbar state
- `undoCount`, `redoCount` -- enables/disables undo/redo buttons
- `onlineUsers` -- user list in invite panel
- `wsConnected` -- connection indicator
- `error` -- error banner

**Why:** React 19 batches setState calls, and rapid WS messages would either cause stale closures or dropped updates if shapes were in useState. By keeping shapes in a ref and using `requestAnimationFrame` for rendering, the canvas bypasses React's reconciliation entirely. The canvas 2D context is imperatively drawn, not declaratively rendered.

### 7f. Per-Connection Send Locks (Frame Interleaving Prevention)

```python
# ws.py
async def _safe_send(ws, data, send_lock):
    try:
        async with send_lock:
            await ws.send_text(data)
    except Exception:
        pass  # connection closed; cleanup happens in finally block

# Each connection gets its own lock:
send_lock = asyncio.Lock()
canvas_presence[user_id] = { "ws": ws, "send_lock": send_lock, ... }
```

Starlette does NOT serialize concurrent `send_text()` calls on the same WebSocket. If two async tasks broadcast simultaneously, their frames can interleave and corrupt messages. The per-connection `asyncio.Lock` serializes all sends to a given client. The lock is per-connection, not per-canvas, so sends to different clients remain parallel.

### 7g. Column Whitelisting for SQL Injection Prevention

```python
# ws.py
_ALLOWED_SHAPE_COLS = frozenset({
    "id", "type", "x", "y", "width", "height",
    "fill", "stroke", "stroke_width", "text", "font_size",
})

def _shape_to_columns(shape: dict):
    for wire_key, value in shape.items():
        db_key = SHAPE_WIRE_TO_DB.get(wire_key, wire_key)
        if db_key not in _ALLOWED_SHAPE_COLS:
            continue  # silently drop unknown keys
```

Because shape data comes from the WebSocket (untrusted JSON), and column names are interpolated into SQL via f-strings (`INSERT INTO shapes ({col_names})`), a malicious client could inject SQL through crafted key names. The whitelist ensures only known column names are ever placed into queries. Values always go through asyncpg's parameterized `$N` placeholders.

The same pattern applies to `_ALLOWED_UPDATE_COLS` (which additionally excludes `id` and `type` since those are immutable).

---

## 8. Known Issues / Integration Notes

### 8a. Error Envelope Handler in main.py

```python
@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    detail = exc.detail if isinstance(exc.detail, str) else "error"
    return JSONResponse(status_code=exc.status_code, content={"error": detail})
```

This overrides FastAPI's default exception handler so ALL HTTPExceptions return `{"error": "<code>"}` instead of `{"detail": "<message>"}`. This is critical for the client's `ApiError` class, which reads `err.error` from the response body. Without this handler, auth failures would return `{"detail": "unauthorized"}` and the client would see `error: "unknown"`.

Note that `auth.py` and `canvas.py` return `JSONResponse` directly for error cases (not raising HTTPException), so this handler only catches errors from `deps.py get_current_user()` and any unhandled FastAPI validation errors.

### 8b. UUID String-to-Object Conversion in ws.py

asyncpg requires `uuid.UUID` objects for UUID columns, not strings. The WebSocket handler receives shape IDs as strings from JSON and must convert them:

```python
if db_key == "id" and isinstance(value, str):
    value = _uuid.UUID(value)
```

This conversion happens in `_shape_to_columns()` for inserts, and explicitly in `_persist_update()` and `_persist_delete()` for WHERE clauses. Canvas ID and user ID are similarly converted at the top of `websocket_endpoint()`. Failure to convert would cause asyncpg `DataError`.

### 8c. StrictMode Double-Mount Guard

```typescript
// CanvasPage.tsx
const mountedRef = useRef(false);

useEffect(() => {
    if (mountedRef.current) return;  // skip second mount in StrictMode
    mountedRef.current = true;
    // ... connect WS, load canvas ...
    return () => {
        mountedRef.current = false;
        ws.close();
    };
}, [canvasId]);
```

React 19 StrictMode in development double-fires effects (mount -> unmount -> remount). Without this guard, two WebSocket connections would open simultaneously, causing duplicate messages and presence entries. The `mountedRef` flag ensures only the first mount actually connects.

### 8d. HTTP/WS Init Race Condition Fix

```typescript
// CanvasPage.tsx
const wsInitReceivedRef = useRef(false);

// HTTP load (fallback):
getCanvasDetail(canvasId).then((detail) => {
    if (!wsInitReceivedRef.current) {
        shapesRef.current = detail.shapes;
    }
});

// WS init (authoritative):
case "init":
    wsInitReceivedRef.current = true;
    shapesRef.current = msg.shapes;
```

Both an HTTP GET and a WebSocket connection are initiated on mount. The HTTP response might arrive first with stale data, then the WS `init` arrives with the correct current state (including any ops that occurred between the HTTP response and WS connection). The `wsInitReceivedRef` flag ensures that if the WS init has already arrived, the HTTP response doesn't overwrite it with potentially stale data.

### 8e. What's NOT Implemented

| Feature | Status |
|---------|--------|
| **WebSocket reconnection** | Not implemented. If WS drops, user sees "Disconnected" but must manually navigate away and back. |
| **Ping/pong heartbeat** | Not implemented. Idle connections may be killed by proxies/firewalls without detection. |
| **Cursor interpolation (lerp)** | Not implemented. Remote cursors jump to new positions. No smoothing. |
| **Reconnect state recovery** | No incremental sync. A reconnect would need a fresh `init` (which happens naturally on remount). |
| **Rate limiting** | No connection or message rate limits on WS or HTTP. |
| **Input validation** | Minimal. WS messages with missing fields are silently ignored, but no schema validation. |
| **Text editing in-place** | Text creation uses `window.prompt()`. No in-canvas text editing overlay. |
| **Z-order manipulation** | Shapes are z-ordered by creation time (array index). No bring-to-front/send-to-back. |
| **Multi-select** | Only single shape selection. No box select or Shift+click. |
| **Pending ops divergence recovery** | If server ignores an op (no-op), the pendingOps set grows unboundedly until reconnect. |
| **seq counter persistence** | seq resets on server restart. Clients self-correct on reconnect via fresh `init`. |
| **Connection pool tuning for WS** | Pool is min=2, max=20. Each WS op holds a connection briefly. Could exhaust under load. |
| **Structured logging** | No logging anywhere in the backend. Errors are silently caught in WS handler. |

---

## 9. How to Run

### Docker Compose (all services)

```bash
docker compose up --build
```

This starts:
- PostgreSQL on `:5432` (schema.sql runs on first boot via initdb.d mount)
- FastAPI server on `:3001` (waits for PG health check)
- Vite dev server on `:5173`

Open `http://localhost:5173`.

**Reset database** (if schema.sql changes):
```bash
docker compose down -v   # removes pgdata volume
docker compose up --build
```

### Local Dev (DB in Docker, app native)

```bash
# Terminal 1: Start just the database
docker compose up db

# Terminal 2: Initialize schema and start backend
psql postgres://whiteboard:whiteboard@localhost:5432/whiteboard -f server/schema.sql
cd server
pip install -e .
uvicorn app.main:app --reload --port 3001

# Terminal 3: Start frontend
cd client
npm install
npm run dev
```

### Key Environment Variables

| Variable | Used By | Default | Required |
|----------|---------|---------|----------|
| `DATABASE_URL` | server | `postgres://whiteboard:whiteboard@localhost:5432/whiteboard` | No |
| `JWT_SECRET` | server | `dev-secret-do-not-use-in-prod` | Yes (has fallback) |
| `VITE_WS_URL` | client (Docker only) | `ws://localhost:3001` | No |
| `VITE_API_URL` | client (Docker only) | `http://localhost:3001` | No |

In local dev, the Vite proxy handles routing `/api` and `/ws` to `:3001`, so `VITE_*` vars are unnecessary. The client code constructs the WS URL from `window.location`:

```typescript
const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const host = window.location.host;
const wsUrl = `${protocol}//${host}/ws?canvasId=${canvasId}&token=${token}`;
```

### Linting / Type Checking

```bash
cd server && ruff check .        # Python linting
cd client && npx tsc --noEmit    # TypeScript type checking
```
