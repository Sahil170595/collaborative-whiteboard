# Collaborative Whiteboard

A real-time collaborative whiteboard where small teams can sketch, annotate, and brainstorm together on a shared canvas. Built for synchronous design reviews — 2-5 people on a call, drawing and editing at the same time.

![Stack](https://img.shields.io/badge/React_19-TypeScript-blue) ![Stack](https://img.shields.io/badge/FastAPI-Python_3.12-green) ![Stack](https://img.shields.io/badge/PostgreSQL-16-blue) ![Stack](https://img.shields.io/badge/WebSocket-Realtime-orange)

---

## What It Does

- **Draw shapes** — rectangles, ellipses, lines, and text with customizable fill, stroke, opacity, and border radius
- **Edit in real time** — select, move, resize, delete, and recolor shapes; changes broadcast instantly to all connected users
- **Live cursors** — see where teammates are pointing with smooth interpolated cursors and username labels
- **Undo / redo** — per-user history stacks that work correctly under concurrent edits (field-level inverse operations)
- **Canvas persistence** — everything saves to PostgreSQL automatically; close the tab, come back later, it's all there
- **User accounts** — signup/login with JWT auth; create canvases and invite collaborators by username or email
- **Resilient connections** — automatic WebSocket reconnection with exponential backoff, pending op replay, and server heartbeat

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/Sahil170595/collaborative-whiteboard.git
cd collaborative-whiteboard
docker compose up --build
```

Open `http://localhost:5173`, create an account, and start drawing.

### Local Development

```bash
# Start the database
docker compose up db

# Backend
cd server
pip install -e .
uvicorn app.main:app --reload --port 3001

# Frontend (separate terminal)
cd client
npm install
npm run dev
```

## Architecture

```
Browser (React 19)                    Server (FastAPI)              PostgreSQL
┌─────────────────┐    WebSocket     ┌──────────────────┐         ┌──────────┐
│  Canvas 2D API  │◄───────────────►│  /ws endpoint     │────────►│  shapes  │
│  Optimistic UI  │    JSON ops      │  seq counter      │         │  users   │
│  Undo/Redo      │                  │  broadcast fan-out│         │  canvas  │
│  Cursor lerp    │    REST API      │  /api/auth        │         │  members │
│  Reconnect      │◄───────────────►│  /api/canvases    │         └──────────┘
└─────────────────┘                  └──────────────────┘
```

**Key design decisions:**

- **Server-authoritative ordering** — each canvas has a monotonic `seq` counter; the server assigns sequence numbers to operations, making ordering deterministic across all clients
- **Optimistic updates** — the client applies operations immediately for zero-latency feel, then reconciles when the server echoes them back with a `seq` number
- **Last-writer-wins at field level** — concurrent edits to *different* fields on the same shape merge cleanly; same-field conflicts resolve by server ordering
- **Per-user undo stacks** — undo only reverses *your* operations, not teammates'; inverse ops contain only the fields you changed
- **Single WebSocket per session** — all shape ops, cursor positions, and presence events flow through one connection per user per canvas

## Tech Stack

| Layer      | Technology                            |
|------------|---------------------------------------|
| Frontend   | React 19, TypeScript 5.6, Vite 6     |
| Backend    | FastAPI, Python 3.12, Uvicorn         |
| Database   | PostgreSQL 16, asyncpg                |
| Realtime   | WebSocket (Starlette built-in)        |
| Auth       | JWT (PyJWT) + bcrypt                  |
| Containers | Docker Compose                        |

## Project Structure

```
client/
  src/
    components/
      Auth.tsx            # Login / signup card
      CanvasList.tsx      # Canvas grid with create / delete
      CanvasPage.tsx      # Main whiteboard (WS, rendering, input)
      Toolbar.tsx         # Shape tools, colors, opacity, font size
      InvitePanel.tsx     # Collaborator avatars + invite form
    canvasRenderer.ts     # Canvas 2D rendering, hit-testing, cursors
    operations.ts         # applyOp / reverseOp logic
    api.ts                # Typed HTTP client
    authStore.ts          # Token persistence (localStorage)
    types.ts              # Shared TypeScript types
  Dockerfile

server/
  app/
    main.py               # FastAPI app, lifespan, CORS, routing
    auth.py               # Signup, login, me endpoints
    canvas.py             # Canvas CRUD, invite, delete
    ws.py                 # WebSocket: ops, presence, heartbeat
    db.py                 # asyncpg connection pool
    deps.py               # JWT auth dependency
    types.py              # Python type definitions
  schema.sql              # Database DDL
  tests/                  # 38 integration tests (pytest)
  Dockerfile

docs/                     # Architecture, API, data model, WS protocol
docker-compose.yml
```

## Development

```bash
# Lint Python
cd server && ruff check .

# Type-check TypeScript
cd client && npx tsc --noEmit

# Run server tests (38 tests)
cd server && pytest

# Run client tests (28 tests)
cd client && npx vitest run
```

## WebSocket Protocol

All real-time communication uses a JSON message envelope over a single WebSocket connection:

```jsonc
// Client → Server
{ "type": "add", "opId": "uuid", "shape": { ... } }
{ "type": "update", "opId": "uuid", "id": "shape-id", "props": { "fill": "#ff0000" } }
{ "type": "delete", "opId": "uuid", "id": "shape-id" }
{ "type": "cursor", "x": 120, "y": 340 }

// Server → Client
{ "type": "init", "shapes": [...], "members": [...], "presence": [...] }
{ "type": "add", "seq": 42, "opId": "uuid", "shape": { ... } }
{ "type": "join", "userId": "...", "username": "..." }
{ "type": "cursor", "userId": "...", "x": 120, "y": 340 }
```

## License

MIT
