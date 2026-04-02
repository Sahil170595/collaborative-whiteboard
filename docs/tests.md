# Test Suite

## Summary

| Suite | Tests | Time | Runner |
|-------|-------|------|--------|
| Server: auth | 9 | ~2s | pytest + pytest-asyncio |
| Server: canvas | 14 | ~3s | pytest + pytest-asyncio |
| Server: websocket | 15 | ~10s | pytest + starlette TestClient |
| Client: operations | 16 | <1s | vitest |
| Client: renderer | 12 | <1s | vitest |
| **Total** | **66** | **~15s** | |

## Running Tests

```bash
# Requires PostgreSQL running
docker compose up db -d

# Server tests
cd server
pip install -e ".[dev]"
python -m pytest tests/ -v

# Client tests
cd client
npm install
npm test
```

## Server Tests

### `server/tests/test_auth.py` (9 tests)

| Test | What it verifies |
|------|-----------------|
| `test_signup_returns_token_and_user` | POST /signup returns AuthResponse with token and user |
| `test_signup_duplicate_username` | 409 `username_taken` on duplicate username |
| `test_signup_duplicate_email` | 409 `email_taken` on duplicate email |
| `test_login_success` | POST /login returns AuthResponse for valid creds |
| `test_login_wrong_password` | 401 `invalid_credentials` on wrong password |
| `test_login_nonexistent_user` | 401 `invalid_credentials` for unknown user |
| `test_me_returns_user` | GET /me returns AuthUser from JWT |
| `test_me_no_token` | 401 when no Authorization header |
| `test_me_bad_token` | 401 when JWT is malformed |

### `server/tests/test_canvas.py` (14 tests)

| Test | What it verifies |
|------|-----------------|
| `test_create_canvas` | POST /canvases creates canvas, returns CanvasSummary |
| `test_list_canvases_shows_own` | GET /canvases returns user's canvases |
| `test_list_canvases_excludes_others` | GET /canvases excludes non-member canvases |
| `test_get_canvas_detail` | GET /canvases/:id returns CanvasDetail with shapes and members |
| `test_get_canvas_not_found` | 404 `not_found` for missing canvas |
| `test_get_canvas_not_member` | 403 `not_a_member` for non-member |
| `test_get_canvas_malformed_id` | 404 on malformed UUID (not 500) |
| `test_invite_by_username` | Invite by username adds membership |
| `test_invite_by_email` | Invite by email adds membership |
| `test_invite_user_not_found` | 404 `user_not_found` for unknown user |
| `test_invite_not_a_member` | 403 `not_a_member` when requester has no access |
| `test_invite_idempotent` | Re-inviting same user succeeds silently |
| `test_delete_canvas_owner` | Owner can delete canvas |
| `test_delete_canvas_not_owner` | 403 `not_owner` for non-owner member |

### `server/tests/test_ws.py` (15 tests)

| Test | What it verifies |
|------|-----------------|
| `test_ws_auth_rejected_no_token` | Close 4001 when token missing |
| `test_ws_auth_rejected_bad_token` | Close 4001 when JWT invalid |
| `test_ws_auth_rejected_not_member` | Close 4003 when user not a canvas member |
| `test_ws_init_sends_empty_canvas` | Init message has empty shapes, user list, and seq |
| `test_ws_add_op_echoed_with_seq` | Add op echoed to sender with seq and opId |
| `test_ws_seq_monotonic` | 5 sequential ops get strictly increasing seq numbers |
| `test_ws_update_persists_and_echoes` | Update modifies DB and echoes |
| `test_ws_delete_persists` | Delete removes shape from DB |
| `test_ws_noop_no_broadcast` | Delete on non-existent shape produces no broadcast |
| `test_ws_type_immutable` | Update cannot change shape type (contract: immutable after creation) |
| `test_ws_canvas_isolation` | User on canvas B cannot delete shapes from canvas A |
| `test_ws_two_clients_see_ops` | Two clients on same canvas both receive op broadcasts |
| `test_ws_persistence_across_reconnect` | Shapes appear in init after reconnect |
| `test_ws_join_leave_presence` | Join broadcast on connect, leave broadcast on disconnect |
| `test_ws_cursor_broadcast` | Cursor messages reach other clients |

## Client Tests

### `client/src/operations.test.ts` (16 tests)

| Group | Tests | What it verifies |
|-------|-------|-----------------|
| applyOp | 6 | add appends, update modifies only target, delete removes, non-existent ids are no-ops, immutability of input array |
| reverseOp | 7 | add reverses to delete, delete reverses to add with snapshot, update reverses with only changed fields, null on missing shape, snapshot is a copy not a reference |
| undo round-trip | 3 | add+undo, delete+undo, update+undo all restore original state |

### `client/src/canvasRenderer.test.ts` (12 tests)

| Group | Tests | What it verifies |
|-------|-------|-----------------|
| hitTest | 8 | Point inside rect, point outside, overlapping shapes return topmost, ellipse bounds, line stroke tolerance, empty array |
| getHandlePositions | 1 | Returns 4 handles (nw, ne, sw, se) |
| hitTestHandle | 3 | Detects NW handle, SE handle, returns null when not on handle |

## Test Infrastructure

- **DB isolation**: Each server test truncates all tables after running via an autouse fixture.
- **Pool management**: The asyncpg pool is reset between tests to avoid event-loop binding issues.
- **Rate limit reset**: In-memory rate limiter state is cleared before each test.
- **WS tests use Starlette's sync TestClient** which manages its own event loop internally, avoiding async/sync conflicts with the WebSocket handler.
