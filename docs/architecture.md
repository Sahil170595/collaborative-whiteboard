# System Architecture

## High-Level Architecture

```
+------------------+          +------------------+          +------------------+
|                  |  HTTP    |                  |  SQL     |                  |
|   React Client   |--------->|   FastAPI Server  |--------->|   PostgreSQL 16  |
|   (Vite :5173)   |<---------|   (Uvicorn :3001) |<---------|   (:5432)        |
|                  |  JSON    |                  |  asyncpg |                  |
+--------+---------+          +--------+---------+          +------------------+
         |                             |
         |   WebSocket /ws             |
         +---------------------------->+
         |<----------------------------+
         |   JSON messages             |
```

### Data flow summary

| Path | Protocol | Purpose |
|------|----------|---------|
| Client -> `/api/auth/*` | HTTP POST/GET | Signup, login, token refresh |
| Client -> `/api/canvases/*` | HTTP GET/POST | Canvas CRUD, invite |
| Client -> `/ws?canvasId=&token=` | WebSocket | Real-time ops, cursors, presence |
| Server -> PostgreSQL | asyncpg (TCP) | Shape persistence, user/canvas queries |

### Vite Dev Proxy

In local development, the Vite dev server proxies requests so the client never hardcodes the server port:

```
Browser :5173
    |
    +-- /api/*  --> http://localhost:3001/api/*    (HTTP reverse proxy)
    +-- /ws     --> ws://localhost:3001/ws          (WebSocket upgrade proxy)
```

Configured in `client/vite.config.ts`. This only works when Vite runs on the host machine. Inside Docker, the proxy target must change to `http://server:3001`.

---

## Server Module Dependency Graph

```
                          main.py
                       (FastAPI app)
                      /      |      \
                     /       |       \
                    v        v        v
              auth.py   canvas.py    ws.py
            (APIRouter) (APIRouter) (websocket_endpoint)
                \        |         /
                 \       |        /
                  v      v       v
                     deps.py
               (get_current_user)
                       |
                       v
                     db.py
               (asyncpg pool)
                       |
                       v
                  PostgreSQL
```

### Module responsibilities

| Module | Export | Role |
|--------|--------|------|
| `main.py` | `app` | FastAPI factory, CORS, exception handler, router wiring, lifespan |
| `db.py` | `get_pool`, `close_pool` | asyncpg connection pool singleton |
| `deps.py` | `get_current_user` | JWT validation dependency for HTTP routes |
| `types.py` | TypedDicts, constants | Shared contract types (read-only) |
| `auth.py` | `auth_router` | Signup, login, `/me` endpoints |
| `canvas.py` | `canvas_router` | Canvas list, create, detail, invite endpoints |
| `ws.py` | `websocket_endpoint` | WebSocket handler: auth, init, ops, cursors, presence, ping/pong heartbeat |

---

## Client Component Tree

```
<StrictMode>
  <App>
    |
    +-- page.kind === "login" | "signup"
    |     |
    |     +-- <Auth>
    |           (card-based login/signup with SVG logo, calls api.ts, stores token)
    |
    +-- page.kind === "canvases"
    |     |
    |     +-- <CanvasList>
    |           (responsive grid of canvas cards, create form, logout)
    |
    +-- page.kind === "canvas"
          |
          +-- <CanvasPage key={canvasId}>
                |
                +-- <Toolbar>
                |     (floating bottom bar with SVG icons, color palette, undo/redo)
                |     (back button fixed top-left, separate from toolbar)
                |
                +-- <canvas> (HTML5 Canvas element)
                |     (rendered by canvasRenderer.ts: dot grid, shapes, selection, cursors)
                |
                +-- <InvitePanel>
                |     (avatar row top-right, invite dropdown)
                |
                +-- Connection status indicator (bottom-left)
                      (tri-state: connected/reconnecting/disconnected)
```

### Non-component modules

| Module | Purpose |
|--------|---------|
| `types.ts` | Canonical shared types (read-only contract) |
| `api.ts` | HTTP client wrapping `fetch` with auth headers and error handling |
| `authStore.ts` | localStorage wrapper for token and user profile |
| `operations.ts` | `applyOp` (apply operation to shape array), `reverseOp` (build undo inverse) |
| `canvasRenderer.ts` | `renderScene` (dot grid, z-order lift, cursor opacity), `hitTest`, `hitTestHandle`, shape/cursor drawing |

---

## Technology Choices

| Choice | Rationale |
|--------|-----------|
| React 19 + Vite | Modern DX, fast HMR, strict TypeScript. No SSR needed for this SPA. |
| FastAPI + Uvicorn | Async-native Python with first-class WebSocket support via Starlette. |
| PostgreSQL 16 | Relational schema fits the user/canvas/membership/shape model cleanly. UUID primary keys via `pgcrypto`. |
| asyncpg | Async PostgreSQL driver with native parameterized queries (`$1` syntax). No ORM -- queries are explicit. |
| WebSocket (not SSE/polling) | Bidirectional real-time transport for ops and cursors. Single connection per user per canvas. |
| JWT (HS256) | Stateless auth. Token passed as query param on WS connect (no cookie/session needed). |
| bcrypt | Industry-standard password hashing. |
| Last-write-wins | Sufficient for 2-5 users. No CRDT/OT complexity. |
| Client-side undo stacks | Server sees undo as normal inverse operations. No server-side undo log needed. |
| Docker Compose | Three-service local deployment with health checks. |

---

## Deployment Topology (Docker Compose)

```
+---------------------------------------------------+
|                Docker Compose Network              |
|                                                    |
|  +-----------+    +-----------+    +------------+  |
|  |    db     |    |  server   |    |   client   |  |
|  | postgres  |    |  uvicorn  |    |  vite dev  |  |
|  |  :5432    |    |  :3001    |    |   :5173    |  |
|  +-----------+    +-----------+    +------------+  |
|        ^                ^                          |
|        |                |                          |
|        +--- asyncpg ----+                          |
+---------------------------------------------------+
         |                |                |
     host:5432       host:3001        host:5173
```

### Services

| Service | Image | Port | Depends On | Notes |
|---------|-------|------|------------|-------|
| `db` | `postgres:16-alpine` | 5432 | -- | `schema.sql` mounted as `/docker-entrypoint-initdb.d/schema.sql` |
| `server` | Built from `./server/Dockerfile` | 3001 | `db` (service_healthy) | Multi-stage build. `JWT_SECRET` and `DATABASE_URL` set in environment. |
| `client` | Built from `./client/Dockerfile` | 5173 | -- | Runs `npm run dev` (Vite dev server). Not a production build. |

### Healthcheck

The `db` service has a healthcheck (`pg_isready -U whiteboard`) with 2s interval and 10 retries. The `server` service uses `condition: service_healthy` to wait for PostgreSQL to be ready before starting.

### Volumes

- `pgdata`: Named volume for PostgreSQL data directory. `schema.sql` only runs on first boot (empty volume). Run `docker compose down -v` to reset.

### Environment Variables

| Variable | Service | Value in Compose |
|----------|---------|-----------------|
| `POSTGRES_USER` | db | `whiteboard` |
| `POSTGRES_PASSWORD` | db | `whiteboard` |
| `POSTGRES_DB` | db | `whiteboard` |
| `DATABASE_URL` | server | `postgres://whiteboard:whiteboard@db:5432/whiteboard` |
| `JWT_SECRET` | server | `dev-secret-do-not-use-in-prod` |
| `VITE_WS_URL` | client | `ws://localhost:3001` |
| `VITE_API_URL` | client | `http://localhost:3001` |
