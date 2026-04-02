# Backend Guide

## Module Responsibilities

```
server/
  app/
    __init__.py        # empty package marker
    main.py            # FastAPI app factory, lifespan, CORS, exception handler, router wiring
    db.py              # asyncpg pool singleton (get_pool / close_pool)
    deps.py            # get_current_user JWT dependency for HTTP routes
    types.py           # Shared contract types (read-only, mirrors client/src/types.ts)
    auth.py            # auth_router: signup, login, /me
    canvas.py          # canvas_router: list, create, detail, invite, delete
    ws.py              # websocket_endpoint: real-time ops, cursors, presence
  schema.sql           # PostgreSQL DDL (mounted as initdb script)
  pyproject.toml       # Python project config and dependencies
  Dockerfile           # Multi-stage build
```

---

## main.py -- App Factory

### Lifespan

```python
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    await get_pool()    # initialize DB pool on startup
    yield
    await close_pool()  # close DB pool on shutdown
```

### CORS

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

Only allows the Vite dev server origin. In production, this would need to be configured for the actual domain.

### Global Exception Handler

```python
@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    detail = exc.detail if isinstance(exc.detail, str) else "error"
    return JSONResponse(status_code=exc.status_code, content={"error": detail})
```

Converts FastAPI's default error format to the contract envelope `{ "error": "<code>" }`. This ensures all HTTP errors follow the same shape regardless of which route raised them.

### Router Wiring

```python
app.include_router(auth_router, prefix="/api/auth")
app.include_router(canvas_router, prefix="/api/canvases")
app.add_websocket_route("/ws", websocket_endpoint)
```

### Health Check

```python
@app.get("/health")
async def health():
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn:
        await conn.fetchval("SELECT 1")
    return {"ok": True}
```

Verifies database connectivity. The `timeout=5` on `pool.acquire` prevents hanging if the pool is exhausted.

---

## db.py -- Connection Pool

```python
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgres://whiteboard:whiteboard@localhost:5432/whiteboard",
)

pool: asyncpg.Pool | None = None

async def get_pool() -> asyncpg.Pool:
    global pool
    if pool is None:
        pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=20)
    return pool

async def close_pool() -> None:
    global pool
    if pool is not None:
        await pool.close()
        pool = None
```

- Lazy singleton pattern. Pool created on first call to `get_pool()`.
- `min_size=2`: Two connections kept alive at all times.
- `max_size=20`: Upper bound for concurrent connections.
- All callers use `async with pool.acquire(timeout=5) as conn:` to prevent pool exhaustion hangs.

---

## Authentication

### JWT Creation (auth.py)

```python
JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret-do-not-use-in-prod")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 24

def _create_token(user_id: str, username: str, email: str) -> str:
    payload = {
        "sub": user_id,        # UUID as string
        "username": username,
        "email": email,
        "exp": now + timedelta(hours=24),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")
```

### JWT Validation -- HTTP (deps.py)

```python
async def get_current_user(authorization: str = Header(default="")) -> AuthUser:
    # 1. Check "Bearer " prefix
    # 2. jwt.decode(token, secret, algorithms=["HS256"])
    # 3. Extract sub, username, email from payload
    # 4. Return AuthUser(id=sub, username=username, email=email)
    # Any failure -> HTTPException(401, "unauthorized")
```

Used as a FastAPI dependency: `user: AuthUser = Depends(get_current_user)`.

### JWT Validation -- WebSocket (ws.py)

```python
def _decode_token(token: str) -> AuthUser | None:
    # Same logic as deps.py but returns None instead of raising
    # Because WebSocket needs to close with a specific code, not raise HTTP errors
```

FastAPI's `Depends()` does not work the same way for WebSocket endpoints. The token is passed as a query parameter (`?token=<jwt>`) and decoded manually before `ws.accept()`.

### Password Hashing (auth.py)

```python
def _hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

def _verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
```

Uses the `bcrypt` library directly (not passlib). Passwords are encoded to UTF-8 bytes for bcrypt.

---

## Database Access Patterns

### Parameterized Queries

All queries use asyncpg's `$1`, `$2` placeholder syntax. No string formatting of SQL.

```python
row = await conn.fetchrow(
    "SELECT id, username, email FROM users WHERE username = $1",
    body.username,
)
```

### Connection Pooling

Every database operation acquires a connection from the pool using the context manager:

```python
async with pool.acquire(timeout=5) as conn:
    row = await conn.fetchrow("SELECT ...", ...)
```

The `timeout=5` prevents indefinite blocking when the pool is exhausted. The context manager guarantees the connection is returned even if an exception occurs.

### Transactions

Used in canvas creation (canvas.py) to atomically insert the canvas and the creator's membership:

```python
async with conn.transaction():
    row = await conn.fetchrow("INSERT INTO canvases ...", ...)
    await conn.execute("INSERT INTO canvas_members ...", ...)
```

### Canvas Deletion (canvas.py)

`DELETE /{canvas_id}` checks that the authenticated user is the canvas owner (`canvases.owner_id`). Non-owners receive 403 `not_owner`. On success, the canvas row is deleted and all associated shapes and memberships are removed by PostgreSQL's `ON DELETE CASCADE` foreign keys.

---

## WebSocket Handler Internals (ws.py)

### Module-Level State

```python
# canvas_id -> user_id -> {username, color, ws, send_lock}
presence: dict[str, dict[str, dict]] = defaultdict(dict)

# canvas_id -> int (monotonically increasing)
seq_counters: dict[str, int] = defaultdict(int)

# canvas_id -> asyncio.Lock
canvas_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
```

This state lives in the Python process memory. It is NOT shared across workers (single worker assumed). It resets on server restart.

### Per-Connection Send Lock

```python
send_lock = asyncio.Lock()
```

Each WebSocket connection gets its own send lock. All sends go through `_safe_send`:

```python
async def _safe_send(ws, data, send_lock):
    try:
        async with send_lock:
            await ws.send_text(data)
    except Exception:
        pass  # connection already closed
```

This prevents frame interleaving when multiple coroutines send to the same socket concurrently (a known Starlette issue where concurrent `send_text` calls can corrupt messages).

### Broadcast Fan-Out

```python
async def _broadcast(canvas_id, message, *, exclude_user=None):
    payload = json.dumps(message)
    targets = []
    for uid, info in presence.get(canvas_id, {}).items():
        if uid == exclude_user:
            continue
        targets.append(_safe_send(info["ws"], payload, info["send_lock"]))
    if targets:
        await asyncio.gather(*targets, return_exceptions=True)
```

- `_broadcast`: Sends to all clients except one (used for cursor, join, leave).
- `_broadcast_all`: Sends to ALL clients including sender (used for op echoes).
- `asyncio.gather(*targets, return_exceptions=True)` ensures one slow client does not block others.

### Ping/Pong Heartbeat

The server runs a per-connection heartbeat loop to detect dead clients:

```python
PING_INTERVAL = 30  # seconds between pings
PONG_TIMEOUT = 10   # seconds to wait for pong reply
```

- On connect, an `asyncio.Task` running `_heartbeat_loop` is created.
- Every 30 seconds it sends `{ "type": "ping" }` to the client and waits up to 10 seconds for a `pong` message.
- If no pong is received within the timeout, the connection is closed with code 1000 ("pong timeout").
- The client responds to `ping` by sending `{ "type": "pong" }`, handled in the message loop before op/cursor dispatch.
- Two `asyncio.Event` objects coordinate the loop: `pong_event` (set when pong received) and `cancel_heartbeat` (set during cleanup to stop the loop).
- The heartbeat task is cancelled in the `finally` cleanup block on disconnect.

### Per-Canvas Locking and Seq Ordering

```python
lock = canvas_locks[canvas_id]
async with lock:
    async with pool.acquire(timeout=5) as conn:
        modified = await _persist_add/update/delete(conn, ...)
    if modified:
        seq_counters[canvas_id] += 1
        seq = seq_counters[canvas_id]
```

The lock ensures:
- No two ops for the same canvas are processed concurrently.
- The seq counter is incremented atomically with the database write.
- Broadcasting happens AFTER lock release (to minimize lock hold time).

---

## Column Whitelisting (SQL Injection Prevention)

Dynamic INSERT and UPDATE queries in ws.py accept field names from client-provided data. To prevent SQL injection through crafted key names, column names are checked against a whitelist:

```python
_ALLOWED_SHAPE_COLS = frozenset({
    "id", "type", "x", "y", "width", "height",
    "fill", "stroke", "stroke_width", "text", "font_size",
    "opacity", "border_radius",
})

_ALLOWED_UPDATE_COLS = _ALLOWED_SHAPE_COLS - {"id", "type"}
```

In `_shape_to_columns` (for INSERT):
```python
for wire_key, value in shape.items():
    db_key = SHAPE_WIRE_TO_DB.get(wire_key) or _EXTRA_WIRE_TO_DB.get(wire_key, wire_key)
    if db_key not in _ALLOWED_SHAPE_COLS:
        continue  # silently drop unknown keys
```

In `_persist_update` (for UPDATE):
```python
for wire_key, value in props.items():
    db_key = SHAPE_WIRE_TO_DB.get(wire_key) or _EXTRA_WIRE_TO_DB.get(wire_key, wire_key)
    if db_key not in _ALLOWED_UPDATE_COLS:
        continue  # silently drop unknown keys
```

ws.py defines local extra mapping dicts (`_EXTRA_DB_TO_WIRE`, `_EXTRA_WIRE_TO_DB`) for `borderRadius` <-> `border_radius`. The `opacity` column has the same name on the wire and in the DB, so it needs no mapping entry.

Only whitelisted column names are interpolated into SQL. Values always go through parameterized placeholders (`$1`, `$2`, ...).

---

## UUID Conversion at the Boundary

asyncpg requires `uuid.UUID` objects for UUID columns, not strings. The server converts at several boundaries:

**canvas.py:**
```python
uid = _uuid.UUID(user["id"])  # AuthUser.id is a string
cid = _uuid.UUID(canvas_id)   # Path parameter is a string
```

**ws.py:**
```python
# In _shape_to_columns:
if db_key == "id" and isinstance(value, str):
    value = _uuid.UUID(value)

# In _persist_update/_persist_delete:
_uuid.UUID(shape_id) if isinstance(shape_id, str) else shape_id
_uuid.UUID(canvas_id) if isinstance(canvas_id, str) else canvas_id
```

Invalid UUIDs are caught:
- In canvas.py: `try/except (ValueError, AttributeError)` returns 404.
- In ws.py: Pre-accept check returns close code 4001.

---

## Error Handling

### HTTP Routes

1. **Global exception handler** in main.py converts all `HTTPException` to `{ "error": "<code>" }`.
2. **auth.py** returns `JSONResponse` directly for known errors (409, 401) to avoid FastAPI's default error serialization.
3. **canvas.py** returns `JSONResponse` directly for 403, 404 errors.
4. **deps.py** raises `HTTPException(401, detail="unauthorized")` which the global handler converts.

### WebSocket

1. **Pre-accept errors**: Close with specific codes (4001, 4003) before accepting.
2. **Message loop errors**: Malformed JSON is silently ignored (`continue`). Invalid op structure is silently ignored.
3. **Connection cleanup**: A `try/except/finally` wraps the entire message loop. The `finally` block always removes presence and broadcasts leave, regardless of how the connection ended (clean disconnect, error, or unexpected exception).

```python
try:
    # ... send init, message loop ...
except WebSocketDisconnect:
    pass
except Exception:
    # send error message to client before cleanup
    pass
finally:
    cancel_heartbeat.set()
    heartbeat_task.cancel()
    canvas_presence.pop(user_id, None)
    await _broadcast(canvas_id, {"type": "leave", "userId": user_id})
```

Note: `canvas_locks` and `seq_counters` are intentionally NOT cleaned up when the last user disconnects. This avoids a race condition on simultaneous disconnect and prevents seq from resetting mid-session if a user quickly reconnects.

---

## Dependencies (pyproject.toml)

| Package | Version | Purpose |
|---------|---------|---------|
| `fastapi` | >= 0.115.0 | Web framework |
| `uvicorn[standard]` | >= 0.32.0 | ASGI server (with uvloop, httptools) |
| `websockets` | >= 14.0 | WebSocket protocol implementation |
| `asyncpg` | >= 0.30.0 | Async PostgreSQL driver |
| `pyjwt` | >= 2.8.0 | JWT encoding/decoding |
| `bcrypt` | >= 4.0.0 | Password hashing |
| `ruff` | >= 0.8.0 | Linter (dev only) |
