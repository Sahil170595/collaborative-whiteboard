# WebSocket Protocol

## Connection Lifecycle

```
Client                              Server
  |                                    |
  |--- WS /ws?canvasId=X&token=T ---->|
  |                                    | 1. Parse canvasId and token from query params
  |                                    | 2. Decode JWT (HS256, JWT_SECRET)
  |                                    | 3. Query canvas_members for membership
  |                                    |
  |    [if auth fails]                 |
  |<--- close(4001) ------------------|
  |                                    |
  |    [if not a member]               |
  |<--- close(4003) ------------------|
  |                                    |
  |    [if valid]                      |
  |<--- accept() ---------------------|
  |                                    | 4. Assign cursor color from CURSOR_PALETTE
  |                                    | 5. Add to presence map
  |                                    | 6. Load shapes from DB
  |<--- { type: "init", ... } --------|
  |                                    | 7. Broadcast "join" to OTHER clients
  |                                    | 8. Start heartbeat loop
  |                                    |
  |--- { type: "op", ... } ---------->| (message loop)
  |<--- { type: "op", ... } ----------|
  |--- { type: "cursor", ... } ------>|
  |<--- { type: "cursor", ... } ------|
  |                                    |
  |<--- { type: "ping" } -------------|  (every 30s)
  |--- { type: "pong" } ------------->|
  |         ...                        |
  |                                    |
  |--- [disconnect] ----------------->|
  |                                    | 9. Cancel heartbeat task
  |                                    | 10. Remove from presence
  |                                    | 11. Broadcast "leave" to remaining clients
```

### Pre-accept Validation

Authentication happens BEFORE `ws.accept()`. This means an unauthorized client never gets a live connection. The server decodes the JWT manually (FastAPI's `Depends()` does not work for WebSocket query params). The JWT validation logic in `ws.py` (`_decode_token`) mirrors `deps.py` (`get_current_user`).

### Rejection Close Codes

| Code | Meaning | Triggered When |
|------|---------|----------------|
| 4001 | Auth failure | Missing `canvasId` or `token`, invalid/expired JWT, invalid UUID format |
| 4003 | Not a member | JWT is valid but user is not in `canvas_members` for the requested canvas |

---

## Server Op Processing Flow

The 7-step flow from BUILD_CONTRACT.md, implemented in `ws.py`:

```
1. Receive { type: "op", op, opId }
         |
         v
2. Acquire per-canvas asyncio.Lock
         |
         v
3. Persist op to database
   |-- add:    INSERT ... ON CONFLICT (id) DO NOTHING
   |-- update: UPDATE shapes SET ... WHERE id=$N AND canvas_id=$M
   |-- delete: DELETE FROM shapes WHERE id=$N AND canvas_id=$M
         |
         v
4. Check if op was a no-op
   |-- add:    conflict (id exists)        -> modified = False
   |-- update: 0 rows updated             -> modified = False
   |-- delete: 0 rows deleted             -> modified = False
   |
   |-- If no-op: release lock, STOP. No broadcast, no seq.
         |
         v
5. Increment seq_counters[canvas_id]
         |
         v
6. Release the lock
         |
         v
7. Broadcast { type: "op", op, userId, seq, opId }
   to ALL clients on the canvas (including sender)
```

### Per-Canvas Locking

```python
canvas_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
```

One `asyncio.Lock` per canvas ID. This serializes all op processing for a given canvas, guaranteeing:
- `seq` is strictly monotonic per canvas
- Database writes for the same canvas never interleave
- No lost updates from concurrent writes to the same shape

The lock scope covers steps 2-6 (persist + seq increment). Broadcasting (step 7) happens OUTSIDE the lock to avoid holding the lock during slow network sends.

### Sequence Numbers

```python
seq_counters: dict[str, int] = defaultdict(int)
```

- Per-canvas, in-memory counter. Starts at 0.
- Only incremented when an op successfully modifies the database.
- No-op operations (duplicate add, update/delete on missing shape) do not consume a seq.
- Resets to 0 on server restart. Clients recover via a fresh `init` on reconnect.
- Not persisted to the database.

---

## Client Optimistic Reconciliation

### The pendingOps Set

```typescript
const pendingOpsRef = useRef<Set<string>>(new Set());
```

Flow for a client-initiated operation:

```
1. Generate opId = crypto.randomUUID()
2. Apply op locally to shapesRef.current (optimistic)
3. Add opId to pendingOps
4. Send { type: "op", op, opId } to server
5. Re-render canvas

... later, server broadcasts echo ...

6. Receive { type: "op", op, userId, seq, opId }
7. Check: is opId in pendingOps?
   |-- YES (own echo):
   |     Remove opId from pendingOps
   |     If op.kind === "add": SKIP applying (shape already in local array)
   |     If op.kind === "update" or "delete": RE-APPLY from server
   |         (ensures server-authoritative ordering under concurrent edits)
   |
   |-- NO (remote op):
         Apply op to local state normally
```

### Why update/delete echoes are re-applied

For `add` ops, the shape was added optimistically and already exists in the local array. Applying it again would create a duplicate. So the echo is skipped.

For `update` and `delete` ops, the local state may have diverged if another user edited the same shape concurrently. Re-applying the server echo ensures the client converges to server-authoritative state. This is the key insight of the last-write-wins model: the server's echo is the source of truth for field values.

### Divergence and recovery

If the server ignores an op (no-op), the client never receives an echo. The optimistic state briefly diverges. On the next reconnect, the client receives a fresh `init` message that replaces all local state, correcting the divergence.

---

## Cursor Presence Protocol

### Server State

```python
# canvas_id -> user_id -> {username, color, ws, send_lock}
presence: dict[str, dict[str, dict]] = defaultdict(dict)
```

### Color Assignment

```python
CURSOR_PALETTE = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6"]

color_index = len(canvas_presence) % len(CURSOR_PALETTE)
color = CURSOR_PALETTE[color_index]
```

Round-robin based on the number of users currently on the canvas when the new user connects. Not persisted.

### Cursor Broadcast

- Client sends `{ type: "cursor", x, y }` throttled to every 30ms.
- Server broadcasts to OTHER clients only (excludes sender): `{ type: "cursor", userId, username, x, y }`.
- Cursor messages are never persisted to the database.
- On the receiving client, cursor position is stored in `cursorsRef` (a `Map<string, CursorInfo>`) and rendered on the next animation frame.

### Join/Leave

- On connect: server adds user to presence, sends `init` to the new client, broadcasts `{ type: "join", user: PresenceUser }` to others.
- On disconnect: server removes user from presence, broadcasts `{ type: "leave", userId }` to remaining clients.
- Client removes the cursor from `cursorsRef` on `leave` to prevent ghost cursors.

### Cleanup

On disconnect, the server cancels the heartbeat task, removes the user from presence, and broadcasts a `leave` message. Per-canvas state (`canvas_locks`, `seq_counters`) is intentionally kept even when the last user leaves, to avoid race conditions on simultaneous disconnect and to prevent seq from resetting if a user quickly reconnects.

---

## Ping/Pong Heartbeat

The server sends periodic pings to detect dead connections. This is an application-level heartbeat (JSON messages), not WebSocket protocol-level ping/pong frames.

### Message Types

| Direction | Message | Purpose |
|-----------|---------|---------|
| Server -> Client | `{ "type": "ping" }` | Liveness check |
| Client -> Server | `{ "type": "pong" }` | Liveness response |

### Timing

- **Ping interval:** 30 seconds after the last ping.
- **Pong timeout:** 10 seconds. If the client does not respond within this window, the server closes the connection with code 1000 and reason `"pong timeout"`.

### Flow

```
Server                              Client
  |                                    |
  |  [30s since last ping or connect]  |
  |--- { type: "ping" } ------------->|
  |                                    |  [client responds immediately]
  |<--- { type: "pong" } -------------|
  |                                    |
  |  [30s later...]                    |
  |--- { type: "ping" } ------------->|
  |                                    |  [no response within 10s]
  |--- close(1000, "pong timeout") -->|
```

### Client Implementation

The client handles `ping` in `ws.onmessage` before the typed `ServerMessage` switch statement, since `ping`/`pong` are not part of the typed message union. On receiving `{ "type": "ping" }`, it immediately sends `{ "type": "pong" }`.

---

## Message Sequence Diagrams

### Single-User Draw

```
Client A                    Server                    Database
   |                          |                          |
   |  mousedown               |                          |
   |  [create preview shape]  |                          |
   |  mousemove...            |                          |
   |  mouseup                 |                          |
   |  [finalize shape S]      |                          |
   |                          |                          |
   |  op: {add, S}, opId=X   |                          |
   |  [optimistic: add S]     |                          |
   |------------------------->|                          |
   |                          |  INSERT INTO shapes ...  |
   |                          |------------------------->|
   |                          |  INSERT 0 1              |
   |                          |<-------------------------|
   |                          |  seq++ => 1              |
   |                          |                          |
   |  op: {add,S}, seq=1,    |                          |
   |       opId=X             |                          |
   |<-------------------------|                          |
   |  [opId in pendingOps]    |                          |
   |  [skip: add echo]        |                          |
```

### Concurrent Same-Object Edit

```
Client A                    Server                    Client B
   |                          |                          |
   |  update S: fill=red      |                          |
   |  opId=X1                 |                          |
   |  [optimistic: fill=red]  |                          |
   |------------------------->|                          |
   |                          |                          |  update S: fill=blue
   |                          |                          |  opId=X2
   |                          |                          |  [optimistic: fill=blue]
   |                          |<-------------------------|
   |                          |                          |
   |                          |  [lock canvas]           |
   |                          |  UPDATE shapes SET       |
   |                          |    fill='red'            |
   |                          |  seq=1                   |
   |                          |  [release lock]          |
   |                          |                          |
   |  op:{update,fill=red}    |  op:{update,fill=red}   |
   |  seq=1, opId=X1          |  seq=1, opId=X1          |
   |<-------------------------|------------------------->|
   |  [own echo: re-apply]    |  [remote: apply red]     |
   |  fill=red (confirmed)    |  fill=red (overrides     |
   |                          |   optimistic blue)       |
   |                          |                          |
   |                          |  [lock canvas]           |
   |                          |  UPDATE shapes SET       |
   |                          |    fill='blue'           |
   |                          |  seq=2                   |
   |                          |  [release lock]          |
   |                          |                          |
   |  op:{update,fill=blue}   |  op:{update,fill=blue}  |
   |  seq=2, opId=X2          |  seq=2, opId=X2          |
   |<-------------------------|------------------------->|
   |  [remote: apply blue]    |  [own echo: re-apply]   |
   |                          |                          |
   |  BOTH: fill=blue         |  BOTH: fill=blue        |
   |  (converged)             |  (converged)             |
```

Last-write-wins by server arrival order. Both clients converge.

### Undo After Remote Edit

```
Client A                    Server                    Client B
   |                          |                          |
   |  [A adds shape S,        |                          |
   |   undoStack has           |                          |
   |   {fwd:add, rev:delete}] |                          |
   |                          |                          |
   |                          |  B moves S to (200,300)  |
   |  op:{update S, x:200}   |                          |
   |<-------------------------|                          |
   |  [apply: S.x=200]        |                          |
   |                          |                          |
   |  [A hits Ctrl+Z]         |                          |
   |  [pop undo: rev=delete]  |                          |
   |  op: {delete, S}         |                          |
   |  [optimistic: remove S]  |                          |
   |------------------------->|                          |
   |                          |  DELETE FROM shapes      |
   |                          |  WHERE id=S              |
   |                          |  seq++                   |
   |                          |                          |
   |  op:{delete S}, seq=N    |  op:{delete S}, seq=N   |
   |<-------------------------|------------------------->|
   |  [own echo: re-apply     |  [remote: remove S]     |
   |   delete, shape gone]    |                          |
   |                          |                          |
   |  Shape S deleted on both |  clients.               |
   |  B's move is lost -- this is the expected behavior  |
   |  under LWW undo semantics.                          |
```

A's undo of "add" sends a "delete" op. The server does not know it was an undo -- it processes a normal delete. B's earlier move is lost because the shape no longer exists. This is the documented trade-off of client-side undo with last-write-wins.

---

## Persistence Boundary

| Data | Persisted? | Where |
|------|-----------|-------|
| Users | Yes | `users` table |
| Canvases | Yes | `canvases` table |
| Canvas memberships | Yes | `canvas_members` table |
| Shape current state | Yes | `shapes` table |
| Operation history | No | Not stored |
| Undo/redo stacks | No | Client-side only |
| Cursor positions | No | In-memory on server |
| Online presence | No | In-memory on server |
| Per-canvas seq | No | In-memory on server, resets on restart |

### Safe Send and Broadcast

All WebSocket sends are wrapped in `_safe_send` which acquires a per-connection `asyncio.Lock` before sending. This prevents frame interleaving when multiple async tasks try to send to the same connection concurrently (Starlette does not serialize `send_text` calls).

Broadcasts use `asyncio.gather(*targets, return_exceptions=True)` so one slow/dead client does not block delivery to others.
