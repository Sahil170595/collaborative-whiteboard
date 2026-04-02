# BUILD CONTRACT: Collaborative Whiteboard

## Status
- State: `planning`
- Owner: architect (human review before dispatch)
- Status files: unnecessary - 5 sessions with clear phase gates and explicit ownership

## Goal
- User outcome: 2-5 people on a call can draw on a shared canvas in real time, with undo/redo and persistence across sessions.
- Technical outcome: React + FastAPI + PostgreSQL whiteboard with WebSocket collaboration, JWT auth, shape CRUD, cursor presence, and server-authoritative operation ordering.
- Success criteria: all required features work end to end, and concurrent same-object edits converge to identical state on all clients.

## Scope
- In: signup/login/logout, canvas CRUD, invite by username/email, rectangle/ellipse/line/text shapes, select/move/resize/delete/recolor, undo/redo, live cursors, persistent canvas state.
- Out: collaborative text editing within text elements, granular permissions, rich text/images/uploads, zoom/pan/infinite canvas, export, version history, mobile/touch.
- Deferred: none. Everything listed as in-scope ships in this pass.

## Architecture Decisions
- Stack: React 19 + TypeScript + Vite on the client, FastAPI + Python 3.12 + uvicorn on the server, PostgreSQL 16.
- Auth: JWT (HS256). HTTP uses `Authorization: Bearer <token>`. WebSocket uses `?token=<jwt>`. Secret comes from `JWT_SECRET`. Expiry is 24 hours. Passwords are hashed with bcrypt.
- Transport: a single WebSocket at `/ws?canvasId=<uuid>&token=<jwt>` carries board operations and cursors. HTTP is only for auth and canvas CRUD.
- Ordering: server-authoritative. Server assigns a per-canvas monotonic `seq` to each successful op and echoes it to all clients, including the sender.
- Concurrency model: last-write-wins at field level, ordered by server arrival. No OT. No CRDT.
- Persistence: per-operation mutation of the `shapes` table. No operation log. The database stores current board state only.
- Error model: HTTP errors return `{ "error": "<code>" }` with an appropriate status. WebSocket errors send `{ "type": "error", "message": "<text>" }`.
- Undo/redo: client-side stacks only. Server sees undo and redo as normal operations.

## Shared Contract Files

| File | Role | Editor |
|------|------|--------|
| `BUILD_CONTRACT.md` | Human source of truth | Architect only |
| `client/src/types.ts` | Canonical machine contract | Architect only |
| `server/app/types.py` | Python mirror of TypeScript contract | Architect only |

Builders import from these files. They never redefine shared types locally. The validator compares every exported contract type in `types.ts` and `types.py`, including client-only aliases used for parity checks.

---

## Frozen Schemas

### Shape Schema

```typescript
type ShapeType = "rectangle" | "ellipse" | "line" | "text";

interface Shape {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  text?: string;
  fontSize?: number;
}

interface ShapeProps {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  text?: string;
  fontSize?: number;
}

type ShapePatch = Partial<ShapeProps>;
```

All shapes use the bounding-box model. For a line, `(x, y)` is the start point and `(x + width, y + height)` is the end point.

### Board Operation Protocol

```typescript
type Operation =
  | { kind: "add"; shape: Shape }
  | { kind: "update"; shapeId: string; props: ShapePatch }
  | { kind: "delete"; shapeId: string };
```

`ShapeProps` are the mutable fields on a shape. `ShapePatch` is the partial update payload sent in `update`.

Server-side processing:
- `add` -> `INSERT` into `shapes`. If the id already exists, ignore it without broadcasting.
- `update` -> `UPDATE` only the columns present in `props`. If the shape does not exist, ignore it without broadcasting.
- `delete` -> `DELETE` the row. If the shape does not exist, ignore it without broadcasting.
- Successful ops are persisted, assigned a `seq`, and broadcast to all clients.
- Ignored ops do not get a `seq`.

Ordering guarantee:
- Server processes ops for a given canvas under a per-canvas `asyncio.Lock`.
- `seq` is strictly monotonic per canvas.
- Writes for the same canvas never interleave.

### WebSocket Event Protocol

Connection:
- `WS /ws?canvasId=<uuid>&token=<jwt>`
- Server validates JWT and canvas membership before accepting.
- Reject with close code `4001` for auth failure and `4003` for non-membership.

Client to server:

```typescript
| { type: "op"; op: Operation; opId: string }
| { type: "cursor"; x: number; y: number }
```

Server to client:

```typescript
| { type: "init"; shapes: Shape[]; users: PresenceUser[]; seq: number }
| { type: "op"; op: Operation; userId: string; seq: number; opId: string }
| { type: "cursor"; userId: string; username: string; x: number; y: number }
| { type: "join"; user: PresenceUser }
| { type: "leave"; userId: string }
| { type: "error"; message: string }
```

Server op processing flow:
1. Receive `{ type: "op", op, opId }`.
2. Acquire the per-canvas lock.
3. Persist the op to the database.
4. If the op was a no-op, release the lock and stop. No broadcast. No `seq`.
5. Increment the canvas `seq`.
6. Release the lock.
7. Broadcast `{ type: "op", op, userId, seq, opId }` to all clients on the canvas, including the sender.

Client optimistic reconciliation:
1. Client generates a UUIDv4 `opId`, applies the op locally, sends it, and adds the id to `pendingOps`.
2. When a server `op` arrives:
   - If `opId` is in `pendingOps`, remove it and skip applying.
   - Otherwise apply the op to local state.
3. If the server ignored the op, the optimistic state may briefly diverge and self-correct on reconnect when the client receives a fresh `init`.

Other flows:
- On connect, server sends `init` with current shapes, online users, and current `seq`.
- `cursor` messages are broadcast to other clients only and are never persisted.
- On connect, server broadcasts `join` to other clients on the same canvas.
- On disconnect, server removes the user from presence and broadcasts `leave`.

### Cursor Presence Protocol

- Server stores presence in memory as `dict[str, dict[str, {username, color, ws}]]` keyed by canvas id then user id.
- On connect, server assigns a color from `CURSOR_PALETTE` using round-robin assignment.
- On `cursor`, server broadcasts to other clients on the same canvas.
- On disconnect, server removes the user from presence and broadcasts `leave`.
- Presence is never persisted.

### Undo/Redo Semantics

Ownership:
- Undo and redo are client-side only.
- Server just applies the resulting forward or reverse operation.

Stacks:
- `undoStack: UndoEntry[]`
- `redoStack: UndoEntry[]`

| Local action | Forward op | Reverse op |
|---|---|---|
| Add shape S | `{ kind: "add", shape: S }` | `{ kind: "delete", shapeId: S.id }` |
| Delete shape S | `{ kind: "delete", shapeId: S.id }` | `{ kind: "add", shape: <snapshot before delete> }` |
| Update shape S fields F | `{ kind: "update", shapeId: S.id, props: <new values of F> }` | `{ kind: "update", shapeId: S.id, props: <old values of F> }` |

Stack operations:
- Do: push `{ forward, reverse }` onto `undoStack`, clear `redoStack`, apply `forward` optimistically, send `forward`.
- Undo: pop from `undoStack`, push to `redoStack`, apply `reverse` optimistically, send `reverse`.
- Redo: pop from `redoStack`, push to `undoStack`, apply `forward` optimistically, send `forward`.

Concurrent edit behavior:
- Reverse update ops include only the fields changed by the original op.
- Different-field edits do not clobber each other.
- Same-field concurrent edits use last-write-wins by server arrival order.
- Undo add sends delete, even if others changed the shape later.
- Undo delete sends add with the pre-delete snapshot, even if later changes are lost.
- If the target shape no longer exists, the server ignores the op.

### Persistence Boundary

Persisted:
- users
- canvases
- canvas memberships
- shapes (current state)

Not persisted:
- cursor positions
- undo/redo stacks
- operation history
- online presence
- per-canvas `seq` counters

`seq` resets on server restart. Clients recover from a fresh `init` after reconnect.

### Database Schema

Exact DDL for `server/schema.sql`:

```sql
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
    id           UUID PRIMARY KEY,
    canvas_id    UUID NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    type         TEXT NOT NULL,
    x            DOUBLE PRECISION NOT NULL DEFAULT 0,
    y            DOUBLE PRECISION NOT NULL DEFAULT 0,
    width        DOUBLE PRECISION NOT NULL DEFAULT 0,
    height       DOUBLE PRECISION NOT NULL DEFAULT 0,
    fill         TEXT NOT NULL DEFAULT '',
    stroke       TEXT NOT NULL DEFAULT '#000000',
    stroke_width DOUBLE PRECISION NOT NULL DEFAULT 2,
    text         TEXT,
    font_size    DOUBLE PRECISION
);

CREATE INDEX idx_shapes_canvas ON shapes(canvas_id);
CREATE INDEX idx_canvas_members_user ON canvas_members(user_id);
```

Database columns use `snake_case`. Wire format uses `camelCase`. Server maps:
- `stroke_width` <-> `strokeWidth`
- `font_size` <-> `fontSize`
- `owner_id` <-> `ownerId`
- `created_at` <-> `createdAt`

### Auth / Canvas / Invite API Surface

All HTTP routes are under `/api`. All responses are JSON. Auth-protected routes require `Authorization: Bearer <token>`.

Auth:

| Method | Path | Body | Response | Errors |
|--------|------|------|----------|--------|
| POST | `/api/auth/signup` | `SignupRequest` | `AuthResponse` | 409 `username_taken`, 409 `email_taken` |
| POST | `/api/auth/login` | `LoginRequest` | `AuthResponse` | 401 `invalid_credentials` |
| GET | `/api/auth/me` | none | `AuthUser` | 401 `unauthorized` |

Canvas:

| Method | Path | Body | Response | Errors |
|--------|------|------|----------|--------|
| GET | `/api/canvases` | none | `CanvasSummary[]` | 401 `unauthorized` |
| POST | `/api/canvases` | `CreateCanvasRequest` | `CanvasSummary` | 401 `unauthorized` |
| GET | `/api/canvases/{canvasId}` | none | `CanvasDetail` | 401 `unauthorized`, 403 `not_a_member`, 404 `not_found` |
| POST | `/api/canvases/{canvasId}/invite` | `InviteRequest` | `{ ok: true }` | 401 `unauthorized`, 403 `not_a_member`, 404 `user_not_found`, 404 `canvas_not_found` |

Canvas creator is automatically added to `canvas_members`. `GET /api/canvases` returns canvases where the user is a member.

---

## Ownership Map

| Module | Owner | Write Scope | Blocked By | Done When |
|--------|-------|-------------|------------|-----------|
| `infra-runtime` | session-1 | `server/schema.sql`, `server/app/db.py`, `server/app/main.py`, `server/app/deps.py`, `server/pyproject.toml`, `server/Dockerfile`, `docker-compose.yml` | contract | Schema applies, health check passes, auth dependency works, CORS is configured |
| `backend-auth-canvas` | session-2 | `server/app/auth.py`, `server/app/canvas.py` | infra-runtime | Auth and canvas HTTP endpoints match the contract |
| `backend-realtime-persistence` | session-3 | `server/app/ws.py` | infra-runtime | WebSocket auth, `init`, op echo, seq ordering, presence, and persistence match the contract |
| `frontend-whiteboard` | session-4 | `client/src/` except `types.ts` | contract | Auth flow, canvas list/create/invite, shape tools, live cursors, optimistic ops, undo/redo, and refresh persistence work against the contract |
| `integration-hardening` | session-5 | cross-boundary fixes only after validation | all builders + validation report | Routers are wired, validator findings are fixed, and the manual end-to-end flow passes |

Execution phases:
```text
Phase 1 (parallel):  session-1 infra-runtime + session-4 frontend-whiteboard
Phase 2 (parallel):  session-2 backend-auth-canvas + session-3 backend-realtime-persistence
Validation pass:     fresh read-only validator using validation-instructions.md
Phase 3:             session-5 integration-hardening
```

Cross-boundary edits are forbidden until session-5 begins.

Integration touch points:
- Wire `auth_router` into `/api/auth`.
- Wire `canvas_router` into `/api/canvases`.
- Wire `websocket_endpoint` into `/ws`.
- Fix validator failures without changing the frozen contract unless the architect explicitly updates it.

## Naming Rules

Server:
- Files use `snake_case.py`.
- Functions use `snake_case`.
- Routers export `auth_router` in `auth.py` and `canvas_router` in `canvas.py`.
- WebSocket module exports `websocket_endpoint` from `ws.py`.
- `get_current_user` lives in `deps.py`.
- Imports are absolute from `app`.

Client:
- Components use `PascalCase.tsx`.
- Non-component modules use `camelCase.ts`.
- Hooks and helpers use `camelCase`.
- Shared types always import from `./types.ts`.

Wire format:
- JSON keys use `camelCase`.
- HTTP error payloads use `{ "error": "snake_code" }`.

## Config and Environment

| Variable | Used By | Default | Required |
|----------|---------|---------|----------|
| `DATABASE_URL` | server | `postgres://whiteboard:whiteboard@localhost:5432/whiteboard` | no |
| `JWT_SECRET` | server | none | yes |
| `VITE_WS_URL` | client | `ws://localhost:3001` | no |
| `VITE_API_URL` | client | `http://localhost:3001` | no |

Session-1 sets `JWT_SECRET=dev-secret-do-not-use-in-prod` in `docker-compose.yml` for local development.
Session-1 adds `pyjwt` and `bcrypt` to `server/pyproject.toml`.

## Dispatch Prompts

### Session 1: infra-runtime

```text
Read BUILD_CONTRACT.md and server/app/types.py.
You own only: server/schema.sql, server/app/db.py, server/app/main.py, server/app/deps.py,
server/pyproject.toml, server/Dockerfile, docker-compose.yml.

Implement:
1. server/schema.sql with the exact DDL from the Database Schema section.
2. server/app/db.py by preserving the existing asyncpg pool pattern.
3. server/app/main.py with FastAPI lifespan, DB-backed GET /health, and CORS allowing http://localhost:5173.
4. server/app/deps.py exporting get_current_user that reads Authorization: Bearer <token>, decodes HS256 JWTs from JWT_SECRET, and returns AuthUser or raises HTTPException(401).
5. server/pyproject.toml with pyjwt>=2.8.0 and bcrypt>=4.0.0.
6. server/Dockerfile so builds actually work.
7. docker-compose.yml with JWT_SECRET in the server environment.

Do not wire routers or the websocket route yet.
Do not edit shared contract files.
```

### Session 2: backend-auth-canvas

```text
Read BUILD_CONTRACT.md, server/app/types.py, and server/app/deps.py.
You own only: server/app/auth.py and server/app/canvas.py.

Implement:
1. server/app/auth.py exporting auth_router = APIRouter().
   - POST /signup accepts SignupRequest, hashes the password with bcrypt, inserts the user, returns AuthResponse, and returns 409 username_taken or email_taken on duplicates.
   - POST /login accepts LoginRequest, verifies bcrypt, returns AuthResponse, and returns 401 invalid_credentials on failure.
   - GET /me uses get_current_user and returns AuthUser.
   - JWT payload includes sub, username, and exp = now + 24h. Sign with JWT_SECRET using HS256.
2. server/app/canvas.py exporting canvas_router = APIRouter().
   - GET / returns CanvasSummary[] for canvases where the user is a member.
   - POST / creates a canvas, inserts canvas membership for the creator, and returns CanvasSummary.
   - GET /{canvas_id} returns CanvasDetail with shapes and members, 403 not_a_member, 404 not_found.
   - POST /{canvas_id}/invite accepts InviteRequest, looks up user by username or email, adds membership, returns { ok: true }, and returns 404 user_not_found or canvas_not_found, 403 not_a_member.

Import shared types from app.types and get_current_user from app.deps.
Map snake_case DB columns to camelCase wire fields.
Do not touch any files outside your scope.
```

### Session 3: backend-realtime-persistence

```text
Read BUILD_CONTRACT.md, server/app/types.py, and server/app/db.py.
You own only: server/app/ws.py.

Implement websocket_endpoint(ws: WebSocket) -> None.

Requirements:
- Parse canvasId and token from query params.
- Validate JWT using JWT_SECRET and verify the user is a canvas member.
- Reject with close code 4001 for auth failure and 4003 for non-membership.
- Maintain module-level presence, seq_counters, and canvas_locks maps keyed by canvas id.
- On connect: assign cursor color from CURSOR_PALETTE, add presence entry, send init with shapes/users/current seq, and broadcast join to others.
- On op: acquire the per-canvas lock, persist add/update/delete, detect no-ops, increment seq only for successful ops, and broadcast op with seq and opId to all clients including the sender.
- On cursor: broadcast only to other clients and never persist.
- On disconnect: remove presence and broadcast leave.

Use parameterized asyncpg queries only.
Map snake_case DB columns to camelCase wire fields.
Do not edit any files outside your scope.
```

### Session 4: frontend-whiteboard

```text
Read BUILD_CONTRACT.md and client/src/types.ts.
You own only: client/src/ except client/src/types.ts.

Implement:
1. Auth UI for signup, login, logout, token storage, and protected navigation.
2. Canvas list, canvas creation, and canvas invite flow.
3. Whiteboard rendering for rectangle, ellipse, line, and text.
4. Shape interactions: select, move, resize, recolor, delete.
5. Undo and redo with client-side UndoEntry stacks.
6. WebSocket client with init/op/cursor/join/leave/error handling.
7. Optimistic op application using UUIDv4 opId values and pendingOps reconciliation.
8. Live cursors with username and color labels.
9. State rehydration after refresh via init and HTTP canvas detail loading.

Import all shared types from ./types.ts.
Use the existing Vite dev proxy for /api and /ws.
Do not redefine shared types and do not edit files outside your scope.
```

### Session 5: integration-hardening

```text
Read BUILD_CONTRACT.md, validation-instructions.md, the validator report, and the builder handoffs.
You start only after sessions 1-4 finish and a read-only validation pass is complete.

You own cross-boundary fixes needed to make the implementation land cleanly on main.

Tasks:
1. Wire auth_router into /api/auth, canvas_router into /api/canvases, and websocket_endpoint into /ws from server/app/main.py.
2. Fix validator FAIL items without changing the frozen contract unless the architect explicitly approves a contract update.
3. Resolve integration mismatches between client and server payload shapes, error handling, or route usage.
4. Run the manual end-to-end flow:
   signup -> login -> create canvas -> invite second user ->
   both connect to the same canvas -> draw -> observe remote updates ->
   same-object concurrent edit -> verify convergence ->
   undo/redo -> refresh -> verify persistence.

Do not edit BUILD_CONTRACT.md, client/src/types.ts, or server/app/types.py unless the architect explicitly reopens the contract.
```

### Validator Pass (out of band)

Use a fresh read-only session, ideally a different model family. Read `validation-instructions.md`. Do not modify code.

## Open Questions

None. The contract is complete enough to dispatch.
