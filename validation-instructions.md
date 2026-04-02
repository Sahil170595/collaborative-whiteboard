# Validation Instructions

Validate the implementation against `BUILD_CONTRACT.md`, `client/src/types.ts`, and `server/app/types.py`.
Start from a fresh session. Do not rely on builder context.
Report only. Do not modify code.

## Report Format

```md
## [module-name]
### [check-name]
- Verdict: PASS | FAIL
- Reason:
- Evidence: file:line
- Fix:
```

---

## Type Parity (run first and block all other checks)

### TP1: Exported Contract Type Parity
Compare every exported contract type in `client/src/types.ts` against its mirror in `server/app/types.py`.

At minimum, compare:
- `Shape`
- `ShapeProps`
- `ShapePatch`
- `Operation`
- `UndoEntry`
- `ClientMessage`
- `ServerMessage`
- `PresenceUser`
- `AuthUser`
- `SignupRequest`
- `LoginRequest`
- `AuthResponse`
- `CanvasSummary`
- `CanvasMember`
- `CanvasDetail`
- `CreateCanvasRequest`
- `InviteRequest`
- `ErrorResponse`

Verify the same field names, compatible field types, and matching optionality.
Any mismatch is an immediate FAIL.

### TP2: Message Variant Parity
Verify `ClientMessage` and `ServerMessage` have the same variant count, same `type` discriminators, and matching fields, including `opId` and `seq`.

### TP3: Operation Variant Parity
Verify `Operation` has the same variant count, same `kind` discriminators, and matching fields, including `shape`, `shapeId`, and `props`.

---

## Infra-Runtime Checks

### I1: Schema Match
Verify `server/schema.sql` matches the exact DDL in the Database Schema section of `BUILD_CONTRACT.md`.

### I2: Dependencies
Verify `pyjwt` and `bcrypt` are present in `server/pyproject.toml`.

### I3: Auth Dependency
Verify `server/app/deps.py` exports `get_current_user`, reads `Authorization: Bearer <token>`, decodes JWT with `JWT_SECRET`, returns an `AuthUser`-shaped object, and raises 401 on failure.

### I4: CORS
Verify `server/app/main.py` enables CORS for `http://localhost:5173` at minimum.

### I5: Health Check
Verify GET `/health` acquires a database connection and returns `{ "ok": true }`.

### I6: Docker and Env
Verify `server/Dockerfile` builds successfully and `docker-compose.yml` includes `JWT_SECRET` for the server.

---

## Backend-Auth-Canvas Checks

### A1: Signup
Verify POST `/api/auth/signup` accepts `SignupRequest`, hashes the password with bcrypt, inserts the user, returns `AuthResponse`, and returns 409 `username_taken` or 409 `email_taken` on duplicates.

### A2: Login
Verify POST `/api/auth/login` accepts `LoginRequest`, verifies bcrypt, returns `AuthResponse`, and returns 401 `invalid_credentials` on failure.

### A3: Me
Verify GET `/api/auth/me` uses `get_current_user`, returns `AuthUser`, and returns 401 `unauthorized` on missing or invalid auth.

### A4: JWT Shape
Verify JWT payload contains `sub`, `username`, and `exp`, and is signed with HS256 using `JWT_SECRET`.

### A5: Canvas List
Verify GET `/api/canvases` returns `CanvasSummary[]` for canvases where the user is a member.

### A6: Canvas Create
Verify POST `/api/canvases` creates the canvas, adds the creator to `canvas_members`, and returns `CanvasSummary`.

### A7: Canvas Detail
Verify GET `/api/canvases/{canvasId}` returns `CanvasDetail`, returns 403 `not_a_member` for non-members, and 404 `not_found` for missing canvases.

### A8: Invite
Verify POST `/api/canvases/{canvasId}/invite` accepts `InviteRequest`, resolves by username or email, inserts membership, returns `{ ok: true }`, and returns 404 `user_not_found` or `canvas_not_found`, plus 403 `not_a_member`.

### A9: Router Export
Verify `auth.py` exports `auth_router` and `canvas.py` exports `canvas_router`.

### A10: Ownership
Verify this module only changed `server/app/auth.py` and `server/app/canvas.py`.

---

## Backend-Realtime-Persistence Checks

### R1: WS Auth
Verify the WebSocket connects at `/ws?canvasId=<uuid>&token=<jwt>`, validates JWT and canvas membership, and rejects with close code 4001 or 4003 as specified in the contract.

### R2: Init Message
Verify connect sends `{ type: "init", shapes, users, seq }` with shapes from the database and users from presence.

### R3: Op Echo to All
Verify successful ops are persisted, assigned `seq`, and broadcast as `{ type: "op", op, userId, seq, opId }` to all clients including the sender.

### R4: Op Serialization
Verify per-canvas op processing is serialized under a per-canvas `asyncio.Lock` or equivalent, and `seq` is strictly monotonic per canvas.

### R5: No-Op Handling
Verify missing-target updates or deletes, and duplicate-id adds, are silently ignored with no broadcast and no `seq` increment.

### R6: Persistence
Verify add uses `INSERT`, update touches only specified columns, delete removes the row, and all queries are parameterized.

### R7: Cursor Broadcast
Verify cursor messages broadcast only to other clients and are never persisted.

### R8: Presence Join and Leave
Verify connect assigns a cursor color, adds presence, and broadcasts `join`. Verify disconnect removes presence and broadcasts `leave`.

### R9: Export
Verify `server/app/ws.py` exports `websocket_endpoint`.

### R10: Ownership
Verify this module only changed `server/app/ws.py`.

---

## Frontend-Whiteboard Checks

### F1: Auth Flow
Verify signup, login, logout, token storage, and protected navigation all work.

### F2: Canvas List and Create
Verify the client fetches GET `/api/canvases`, renders canvases, and creates a canvas with POST `/api/canvases`.

### F3: Invite
Verify the client sends POST `/api/canvases/{canvasId}/invite` and shows success or error feedback.

### F4: Shape Rendering
Verify rectangle, ellipse, line, and text all render correctly.

### F5: Shape Tools
Verify the UI supports drawing the four shape types plus fill and stroke color selection.

### F6: Interactions
Verify select, move, resize, recolor, and delete all produce the correct `Operation` payloads.

### F7: Undo and Redo
Verify Ctrl+Z and Ctrl+Shift+Z or Ctrl+Y work, `UndoEntry` stacks are used, reverse update ops only include originally changed fields, and a new action clears the redo stack.

### F8: WebSocket and Optimistic Updates
Verify the client connects to `/ws?canvasId=<id>&token=<jwt>`, generates UUIDv4 `opId` values, applies ops optimistically, tracks `pendingOps`, skips echoed ops with matching `opId`, and handles every `ServerMessage` variant including `seq`.

### F9: Live Cursors
Verify cursor updates are throttled, rendered with username and color, appear after `join`, update on `cursor`, and disappear on `leave`.

### F10: Type Compliance
Verify the client imports shared types from `./types.ts` and does not redefine contract types locally.

### F11: Ownership
Verify this module only changed `client/src/` and did not edit `client/src/types.ts`.

---

## Integration-Hardening Checks

### H1: Route Wiring
Verify `server/app/main.py` wires `auth_router` to `/api/auth`, `canvas_router` to `/api/canvases`, and `websocket_endpoint` to `/ws`.

### H2: Contract Preservation
Verify session-5 did not edit `BUILD_CONTRACT.md`, `client/src/types.ts`, or `server/app/types.py` unless the architect explicitly reopened the contract.

### H3: Validator Fix Coverage
Verify each FAIL reported by the validation pass has either been fixed or explicitly called out as remaining work.

---

## Semantic Drift Checks

### D1: Operation Shape
Verify server and client encode `Operation` identically with the same `kind` discriminators and camelCase keys.

### D2: WebSocket Message Shape
Verify server and client agree on every `ServerMessage` and `ClientMessage` variant, especially `seq` and `opId` on op messages.

### D3: Error Codes
Verify HTTP error codes and strings match between server responses and client handling.

### D4: Auth Token Transport
Verify HTTP uses `Authorization: Bearer <token>` and WebSocket uses `?token=<jwt>` on both sides.

### D5: Manual Flow
Verify the full manual flow works:
- signup
- login
- create canvas
- invite second user
- both connect to the same canvas
- draw and observe remote updates
- concurrent same-object edit converges
- undo and redo work
- refresh restores persisted shapes
