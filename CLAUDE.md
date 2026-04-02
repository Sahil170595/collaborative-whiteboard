# CLAUDE.md — Collaborative Whiteboard Take-Home

## Project Overview

Real-time collaborative whiteboard for synchronous design reviews. 2-5 users on a call, same canvas, editing simultaneously. Sessions run 30-90 minutes. Canvas state persists across sessions.

Source: Mechanize take-home interview assignment (3-hour time limit).

## Stack (locked — do not swap)

| Layer      | Tech                                    |
|------------|-----------------------------------------|
| Frontend   | React 19, TypeScript 5.6, Vite 6        |
| Backend    | FastAPI, Python 3.12, Uvicorn            |
| Database   | PostgreSQL 16                            |
| WebSocket  | FastAPI built-in (Starlette)             |
| DB driver  | asyncpg (async, uses `$1` param syntax)  |
| Containers | Docker Compose                           |

Adding npm/pip packages is allowed. Swapping frameworks or DB is not.

## Repo Structure

```
├── client/                  # React frontend
│   ├── src/
│   │   ├── main.tsx         # Entry point (StrictMode, createRoot)
│   │   └── App.tsx          # Root component (placeholder)
│   ├── vite.config.ts       # Dev proxy: /api -> :3001, /ws -> ws://:3001
│   ├── tsconfig.json        # strict: true, target: ES2022, jsx: react-jsx
│   ├── package.json         # type: "module"
│   ├── index.html
│   └── Dockerfile
├── server/
│   ├── app/
│   │   ├── main.py          # FastAPI app, lifespan, /health, /ws endpoint
│   │   ├── db.py            # asyncpg pool singleton (get_pool / close_pool)
│   │   └── __init__.py
│   ├── schema.sql           # Runs on first PG start (currently empty)
│   ├── pyproject.toml       # deps: fastapi, uvicorn, websockets, asyncpg
│   └── Dockerfile
├── docker-compose.yml       # db(:5432), server(:3001), client(:5173)
├── package.json             # npm workspaces: ["client"]
└── package-lock.json
```

## Current State (Scaffold Only)

Everything below is what exists today. All business logic is TODO.

- **`server/app/main.py`**: FastAPI app with lifespan (init/close pool). One `GET /health` that runs `SELECT 1`. One `websocket /ws` that accepts and loops `receive_text()` but does nothing with the data. Only catches `WebSocketDisconnect`.
- **`server/app/db.py`**: Module-global `asyncpg.Pool` singleton. Reads `DATABASE_URL` env var with hardcoded fallback `postgres://whiteboard:whiteboard@localhost:5432/whiteboard`.
- **`server/schema.sql`**: Two comment lines. No tables.
- **`client/src/App.tsx`**: Returns `<div>Whiteboard</div>`.
- **`client/src/main.tsx`**: Standard React 19 entry with StrictMode.
- **`client/vite.config.ts`**: Proxy config for `/api` and `/ws` to `localhost:3001`.

## Required Features (from PRD)

- [ ] User accounts (signup, login, logout)
- [ ] Create a canvas, open an existing canvas
- [ ] Invite other users to a canvas (by username or email)
- [ ] Shapes: rectangle, ellipse, line, text
- [ ] Select, move, resize, delete, change color
- [ ] Undo / redo
- [ ] See other users' cursors
- [ ] Canvas state persists across sessions

## Explicitly Out of Scope

- Collaborative text editing within text elements
- Granular permissions (viewer/editor/owner roles)
- Rich text, images, file uploads
- Canvas zoom, pan, infinite canvas
- Export (PNG, SVG, PDF)
- Version history / named snapshots
- Mobile / touch support

## Known Scaffold Issues (from audit)

### Infrastructure Bugs
- **Server Dockerfile build order broken**: `pip install .` runs before source is copied. Needs restructuring.
- **Client Dockerfile missing lockfile**: `npm install` without `package-lock.json` = non-deterministic builds.
- **Docker networking mismatch**: Vite proxy targets `localhost:3001` which inside a container means the container itself, not the server service. Should target `http://server:3001` in Docker context.
- **No DB readiness check**: `depends_on: [db]` doesn't wait for PG to accept connections. Server may crash on startup race.
- **Both containers run as root**: No `USER` directive in either Dockerfile.

### Security Gaps
- **Hardcoded DB credentials**: `whiteboard:whiteboard` in `db.py:7` and `docker-compose.yml:6,19`. Should use `.env` (already gitignored).
- **No authentication**: Zero auth anywhere. WebSocket is open to any client.
- **No CORS middleware**: Cross-origin requests from `:5173` to `:3001` will fail outside Vite proxy.
- **No input validation**: WebSocket receives raw text, never parses or validates.
- **No rate limiting**: No connection or message rate limits.
- **Health endpoint leaks stack traces**: Unhandled DB errors return raw 500 with traceback.

### Code Quality
- `data` variable in websocket handler is assigned but never used (dead code).
- Only `WebSocketDisconnect` caught; other exceptions crash the handler silently.
- No structured logging anywhere in the backend.

## Conventions to Follow

- **Python**: Use `asyncpg` parameterized queries (`$1`, `$2`) for all DB access. Never string-format SQL.
- **TypeScript**: `strict: true` is on. Do not disable it. Use `type: "module"` (ESM).
- **Vite proxy**: Client talks to server via `/api/*` and `/ws` paths. Do not hardcode ports in client code.
- **Docker Compose**: `schema.sql` is mounted as PG init script. Put all DDL there.
- **Monorepo**: Root `package.json` uses npm workspaces with `client` as the only workspace.
- **Linter**: `ruff` is configured as a dev dependency for the server. Run with `ruff check`.
- **Branch**: All work on `main`. Push directly, no PRs.

## Development Commands

```bash
# Docker (all services)
docker compose up --build

# Local dev (DB in Docker, app native)
docker compose up db
cd server && pip install -e . && uvicorn app.main:app --reload --port 3001
cd client && npm install && npm run dev

# Linting
cd server && ruff check .

# TypeScript check
cd client && npx tsc --noEmit
```

## Known CVEs (as of April 2026)

- **Vite < 6.0.12 — CVE-2025-30208**: Arbitrary file read on dev server via special URL chars. Dev-server-only. Fix: ensure `package-lock.json` resolves to >= 6.0.12. Run `npm audit` after install.
- **Vite < 6.0.12 — CVE-2025-31125**: SSRF on dev server. Same fix as above.
- **Starlette / python-multipart — CVE-2024-24762**: DoS via malformed Content-Type. Fixed in python-multipart >= 0.0.7. FastAPI >= 0.115 pulls the patched version — already covered.
- **asyncpg, React 19, PostgreSQL 16**: No known active CVEs.

Note: Docker Compose runs `npm run dev` (Vite dev server) in the client container, so the Vite CVEs are live in that setup until the lockfile is updated.

## Packages To Add During Implementation

| Purpose | Package | Side |
|---------|---------|------|
| Password hashing | `passlib[bcrypt]` | server (pip) |
| JWT tokens | `python-jose[cryptography]` or `PyJWT` | server (pip) |
| Client state | `zustand` | client (npm) |
| CSS (optional) | Tailwind, CSS modules, or plain CSS | client |
| Testing (if time) | `pytest` + `pytest-asyncio` / `vitest` | both |

Do NOT add an ORM. asyncpg with parameterized queries is the right choice for this app's complexity.

## Architecture Decisions to Make

When implementing, these are the key design choices:

1. **Auth mechanism**: JWT tokens (stateless) vs session cookies. JWT is simpler for WebSocket auth (pass token as query param on connect).
2. **WebSocket protocol**: JSON message envelope with `type` discriminator field. All board ops, cursor updates, and sync messages go through one `/ws` connection per user per canvas.
3. **Conflict resolution**: Last-write-wins is sufficient for the 2-5 user, 30-90 min session use case. No CRDT/OT needed.
4. **Undo/redo**: Client-side per-user undo/redo stacks (not persisted). Server sees undo as a normal inverse operation. Concurrent edits use field-level last-write-wins.
5. **Canvas persistence**: Save full shape state to PG. Load on canvas open. Broadcast deltas via WebSocket during session.
6. **Cursor presence**: Ephemeral, no persistence needed. Broadcast cursor positions via WebSocket at throttled rate (~50ms).

## Stack-Specific Gotchas (Reference for All Agents)

Every agent working on this repo MUST be aware of these known pitfalls. They are specific to the exact versions and patterns used here.

### FastAPI + WebSocket Gotchas

1. **No auto-reconnect.** WS connections silently drop from idle timeouts and network changes. Implement client-side heartbeat/ping every 30s. Server must clean up state on `WebSocketDisconnect`.

2. **Broadcast fan-out blocks the event loop.** Never do `for conn in conns: await conn.send()`. One slow client stalls all others. Use `asyncio.gather(*[send(c, msg) for c in conns], return_exceptions=True)` or a per-connection outbound `asyncio.Queue` with a dedicated writer task.

3. **No built-in WS auth.** FastAPI `Depends()` with OAuth2 works differently for WebSocket. The HTTP handshake is the only chance to authenticate. Validate token in query params or headers *before* `await ws.accept()`. Reject by closing with code 4001.

4. **`WebSocketDisconnect` not always raised.** Starlette only raises it on the next `receive()`/`send()` after disconnect. If the code awaits something else, the stale connection lingers. Use `asyncio.wait` with both the receive task and a cancellation event.

5. **Concurrent `send_text()` interleaves frames.** Starlette does NOT serialize sends from multiple async tasks to the same socket. Two concurrent `send_text()` calls can corrupt the message. Use a single writer task per connection consuming from a queue.

### asyncpg + PostgreSQL Gotchas

1. **Pool exhaustion.** Default pool is 10 connections. Every WS message handler that queries DB holds one. The 11th concurrent query blocks forever. Size pool to expected concurrent handlers + headroom. Use `pool.acquire(timeout=5)` to fail fast.

2. **Stale connections after DB restart.** asyncpg does NOT auto-reconnect pooled connections. A connection open during a PG restart returns `ConnectionDoesNotExistError`. Add retry logic with backoff. Use the `reset` parameter on `create_pool` (asyncpg >= 0.28).

3. **Leaked connections.** If an exception occurs between bare `acquire()` and `release()`, the connection is never returned. ALWAYS use `async with pool.acquire() as conn:` — never bare acquire/release.

4. **Module-global pool + multiple Uvicorn workers.** Each worker gets its own pool copy, silently multiplying DB connections. For this project (single worker), this is fine, but be aware. The proper pattern is storing on `app.state` and accessing via `request.app.state`.

5. **Transaction handling.** You cannot use `pool.execute()` for multi-statement transactions. You must `acquire()` a dedicated connection, then open a transaction on it with `async with conn.transaction():`.

### React 19 Gotchas

1. **StrictMode double-mount.** In dev, `useEffect` fires twice (mount, unmount, remount). A WebSocket opened in `useEffect` without cleanup creates two live connections and duplicate messages. ALWAYS return a cleanup function calling `ws.close()`. Use a `useRef` guard or a singleton module outside the React tree.

2. **Stale closures in WS handlers.** `onmessage` handlers capture state at render time. If state changes but the effect doesn't re-run, the handler sees stale data. Use functional `setState(prev => ...)` or `useRef` for latest state. For high-frequency data (cursors, drawing), bypass React state entirely.

3. **State batching drops WS messages.** React 18/19 batches `setState` calls in the same microtask — rapid sequential WS messages can overwrite each other. Use functional updates or an external store (Zustand, Valtio, plain mutable ref).

### Canvas Rendering Gotchas

1. **HiDPI blurriness.** Not accounting for `devicePixelRatio` makes canvas blurry on Retina/4K. Always set `canvas.width = clientWidth * devicePixelRatio` and scale the 2D context accordingly.

2. **Canvas hit-testing.** No DOM nodes for drawn shapes means click/hover detection requires manual geometry math (point-in-rect, point-in-path). Maintain an in-memory scene graph (array of shape objects) separate from the canvas pixel buffer.

3. **Full re-render kills frame rate.** Re-drawing the entire canvas on every change or cursor move causes frame drops. Use dirty-rect tracking or layer the canvas (static shapes layer + active/drawing layer + cursor overlay layer).

4. **Text editing on canvas.** Canvas has no native text input. Overlay a hidden HTML `<input>` or `<textarea>` positioned over the shape being edited. Remove it when editing completes and render text to canvas.

### Undo/Redo Gotchas (Multi-User)

1. **Global undo stack is wrong.** If User A draws, User B draws, User A hits undo — a global stack undoes B's work, not A's. MUST use per-user undo stacks.

2. **Undo must be inverse operations, not state snapshots.** Undoing "add rect #7" means emitting "delete rect #7" and broadcasting to all clients. Restoring a previous full state would overwrite other users' concurrent changes.

3. **Causal dependencies.** If User A creates a shape and User B moves it, then User A undoes creation — the orphaned move operation becomes invalid. Handle with tombstoning (mark deleted, keep record) or cascade.

4. **Use operation IDs.** Every operation gets a UUID. Undo references that specific operation, not a stack index. Avoids off-by-one errors when operations arrive out of order.

### Cursor Presence Gotchas

1. **Ghost cursors.** Server must broadcast "user_left" on WS close. Client must also implement a heartbeat timeout (no heartbeat in 10s = remove cursor). Never rely solely on WS disconnect detection — it can be delayed.

2. **Coordinate space mismatch.** Cursor positions must be transmitted in document/world space, not viewport space. Each receiving client applies its own viewport transform. (Not critical for this project since zoom/pan is out of scope, but the pattern should be correct.)

3. **Jitter.** Raw cursor positions jump due to network latency variance. Smooth remote cursors with lerp (linear interpolation) over 50-100ms using `requestAnimationFrame`.

4. **Throttle outbound.** Sending cursor position on every `mousemove` (~60fps) wastes bandwidth. Throttle to 20-30fps for outbound broadcasts. Render interpolation on the receiving side fills the gaps.

### Docker Compose + Infrastructure Gotchas

1. **`depends_on` race condition.** Only waits for container start, not PG readiness. Fix: add `healthcheck` with `pg_isready -U whiteboard` and `condition: service_healthy` on the server service.

2. **`initdb.d` only runs on first boot.** If `pgdata` volume exists from a prior run, `schema.sql` changes are silently ignored. Run `docker compose down -v` to reset the volume, then `docker compose up`.

3. **Vite proxy targets `localhost` inside container.** Inside the client container, `localhost:3001` means the container itself, not the server. Change to `http://server:3001` when running in Docker. The current config only works for local dev (Vite on host, server on host).

4. **Vite HMR broken in Docker.** Native filesystem events don't propagate across Docker volume mounts (especially Windows/macOS). Add `watch: { usePolling: true }` and `hmr: { clientPort: 5173 }` to `vite.config.ts` server config.

5. **python:3.12-slim missing build deps.** `asyncpg` compiles a C extension needing `gcc` and `libpq-dev`. `uvicorn[standard]` needs `uvloop` and `httptools` (also C extensions). Install build deps before pip install, or use multi-stage build.

6. **Server Dockerfile build order broken.** `pip install .` on line 4 runs before `COPY . .` on line 5 — the source code isn't there yet. The install fails. Fix: either copy everything first, or separate dependency installation from package installation.

7. **Client Dockerfile missing lockfile.** `COPY package.json ./` then `npm install` without the lockfile = non-deterministic builds. Copy `package-lock.json` too and use `npm ci` instead.
