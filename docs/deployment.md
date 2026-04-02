# Deployment Guide

## Docker Compose Setup

### Starting all services

```bash
docker compose up --build
```

This starts three services:

| Service | Image | Host Port | Container Port | Purpose |
|---------|-------|-----------|----------------|---------|
| `db` | `postgres:16-alpine` | 5432 | 5432 | PostgreSQL database |
| `server` | Built from `./server/Dockerfile` | 3001 | 3001 | FastAPI backend (uvicorn) |
| `client` | Built from `./client/Dockerfile` | 5173 | 5173 | Vite dev server |

Open http://localhost:5173 in a browser after all services are healthy.

### Service dependency chain

```
db (postgres:16-alpine)
  |
  +-- healthcheck: pg_isready -U whiteboard
  |   interval: 2s, timeout: 5s, retries: 10
  |
  v
server (./server/Dockerfile)
  |
  +-- depends_on: db (condition: service_healthy)
  |
  v
client (./client/Dockerfile)
  |
  +-- no dependency declared (independent)
```

### Stopping and resetting

```bash
# Stop all services
docker compose down

# Stop and DELETE all data (resets database)
docker compose down -v
```

The `-v` flag removes the `pgdata` named volume, which forces `schema.sql` to run again on the next startup.

---

## Local Development Setup (Recommended)

Run the database in Docker, and the server + client natively on the host. This gives you the best development experience with hot reload on both sides.

### Step 1: Start the database

```bash
docker compose up db
```

### Step 2: Initialize the schema (first time only)

```bash
psql postgres://whiteboard:whiteboard@localhost:5432/whiteboard -f server/schema.sql
```

Or let the Docker init script handle it (runs automatically on first boot with an empty volume).

### Step 3: Start the backend

```bash
cd server
pip install -e .
JWT_SECRET=dev-secret-do-not-use-in-prod uvicorn app.main:app --reload --port 3001
```

The `--reload` flag enables auto-restart on file changes. `JWT_SECRET` must be set in the environment.

### Step 4: Start the frontend

```bash
cd client
npm install
npm run dev
```

Vite dev server starts on http://localhost:5173 with proxy rules forwarding `/api` and `/ws` to `localhost:3001`.

---

## Environment Variables

| Variable | Used By | Default | Required | Description |
|----------|---------|---------|----------|-------------|
| `DATABASE_URL` | server | `postgres://whiteboard:whiteboard@localhost:5432/whiteboard` | No | asyncpg connection string. In Docker Compose, overridden to `postgres://whiteboard:whiteboard@db:5432/whiteboard`. |
| `JWT_SECRET` | server | `dev-secret-do-not-use-in-prod` (fallback in deps.py) | Yes | HS256 signing secret for JWT tokens. Set to `dev-secret-do-not-use-in-prod` in docker-compose.yml. Must be a strong random string in production. |
| `VITE_WS_URL` | client | `ws://localhost:3001` | No | WebSocket server URL. Only used if the client bypasses the Vite proxy (not used in current code -- the client constructs the WS URL from `window.location`). |
| `VITE_API_URL` | client | `http://localhost:3001` | No | API server URL. Only used if the client bypasses the Vite proxy (not used in current code -- all API calls go through relative paths like `/api/...`). |
| `POSTGRES_USER` | db | -- | Yes (Docker) | PostgreSQL superuser name. Set to `whiteboard` in docker-compose.yml. |
| `POSTGRES_PASSWORD` | db | -- | Yes (Docker) | PostgreSQL superuser password. Set to `whiteboard` in docker-compose.yml. |
| `POSTGRES_DB` | db | -- | Yes (Docker) | Database name. Set to `whiteboard` in docker-compose.yml. |

---

## Dockerfile Details

### Server (server/Dockerfile) -- Multi-Stage Build

```dockerfile
# Stage 1: Builder -- installs Python packages with C extensions
FROM python:3.12-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends gcc libpq-dev
WORKDIR /app
COPY pyproject.toml ./
RUN mkdir -p app && touch app/__init__.py  # minimal package for pip resolve
RUN pip install --no-cache-dir .

# Stage 2: Runtime -- copies installed packages, no build tools
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libpq5
WORKDIR /app
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY . .
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3001"]
```

**Why multi-stage:** asyncpg and uvicorn[standard] compile C extensions that require `gcc` and `libpq-dev`. The builder stage installs these build dependencies, compiles the extensions, and the runtime stage copies only the compiled packages plus the minimal `libpq5` runtime library. This keeps the final image small and free of build tools.

**Build order fix:** The original scaffold had `pip install .` before `COPY . .`. The current Dockerfile creates a minimal `app/__init__.py` so pip can resolve the package from `pyproject.toml` alone, then copies the full source in stage 2.

### Client (client/Dockerfile)

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
CMD ["npm", "run", "dev"]
```

This runs the Vite development server inside Docker. It is NOT a production build.

**Known issue:** `package-lock.json` is not copied before `npm install`, making builds non-deterministic. For a production setup, copy the lockfile and use `npm ci`.

---

## Known Docker Gotchas

### 1. initdb only runs on first boot

`schema.sql` is mounted at `/docker-entrypoint-initdb.d/schema.sql`. PostgreSQL only executes init scripts when the data directory is empty (first boot of a fresh volume). If you change `schema.sql`, you must:

```bash
docker compose down -v   # remove the pgdata volume
docker compose up --build
```

### 2. Vite proxy targets localhost

`vite.config.ts` proxies to `http://localhost:3001` and `ws://localhost:3001`. This works when Vite runs on the host machine but NOT inside Docker (where `localhost` refers to the container itself, not the server container). The Docker Compose setup works because the client container runs Vite dev server and the browser connects directly to `localhost:3001` on the host.

### 3. HMR polling in Docker

Native filesystem events may not propagate across Docker volume mounts (especially on Windows/macOS). If HMR is not working inside Docker, add to `vite.config.ts`:

```typescript
server: {
  watch: { usePolling: true },
  hmr: { clientPort: 5173 },
}
```

### 4. Database connection on server startup

The `depends_on` with `condition: service_healthy` in docker-compose.yml ensures the server waits for PostgreSQL. The healthcheck uses `pg_isready -U whiteboard` with 2-second intervals and 10 retries, giving PostgreSQL up to 20 seconds to become ready.

### 5. Stale connections after DB restart

asyncpg does not auto-reconnect pooled connections. If you restart the `db` service while the server is running, existing connections in the pool become stale. Restart the server or the entire stack:

```bash
docker compose restart server
```

---

## Development Commands

### Docker

```bash
# Start all services
docker compose up --build

# Start only the database
docker compose up db

# View logs
docker compose logs -f server
docker compose logs -f client

# Reset database (delete volume and re-run initdb)
docker compose down -v && docker compose up --build

# Rebuild a single service
docker compose build server
```

### Backend (local)

```bash
cd server

# Install in development mode
pip install -e .

# Start with auto-reload
JWT_SECRET=dev-secret-do-not-use-in-prod uvicorn app.main:app --reload --port 3001

# Run linter
ruff check .

# Run linter with auto-fix
ruff check --fix .
```

### Frontend (local)

```bash
cd client

# Install dependencies
npm install

# Start dev server (port 5173)
npm run dev

# TypeScript type check
npx tsc --noEmit

# Production build
npm run build
```

### Database

```bash
# Connect to the database
psql postgres://whiteboard:whiteboard@localhost:5432/whiteboard

# Apply schema manually
psql postgres://whiteboard:whiteboard@localhost:5432/whiteboard -f server/schema.sql

# Check if tables exist
psql postgres://whiteboard:whiteboard@localhost:5432/whiteboard -c "\dt"
```

---

## Ports Summary

| Port | Service | Protocol |
|------|---------|----------|
| 5432 | PostgreSQL | TCP (asyncpg) |
| 3001 | FastAPI (uvicorn) | HTTP + WebSocket |
| 5173 | Vite dev server | HTTP (proxies /api and /ws to 3001) |
