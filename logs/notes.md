# AI Interaction Logs

## Tools Used

- **Claude Code CLI** (Claude Opus 4.6, 1M context) — primary tool for all implementation
- Multiple parallel Claude Code sessions via the Agent/subagent system
- **Swarm skill** (/swarm) for contract-first multi-agent orchestration

## Session Overview

1. **Architect session** — contract design, code review, security audit, dispatch, validation fixes, test writing
2. **Session 1: infra-runtime** — schema.sql, db.py, main.py, deps.py, pyproject.toml, Dockerfiles, docker-compose.yml
3. **Session 2: backend-auth-canvas** — auth.py (signup/login/me), canvas.py (CRUD + invite + delete)
4. **Session 3: backend-realtime-persistence** — ws.py (WebSocket handler, op persistence, presence, heartbeat)
5. **Session 4: frontend-whiteboard** — full React client (auth UI, canvas list, whiteboard, shape tools, undo/redo, cursors)
6. **Session 5: integration-hardening** — router wiring, validator fix pass, cross-boundary fixes

## Detailed Workflow

### Phase 0: Audit and Contract Design

1. Cloned the scaffold repo and performed a full code review + security audit.
   - Identified: hardcoded credentials, broken Dockerfile build order, missing CORS, no auth, no input validation, Docker networking mismatch.
2. Invoked `/swarm` to generate a contract-first multi-agent scaffold:
   - `BUILD_CONTRACT.md` — human source of truth for all frozen schemas and ownership
   - `client/src/types.ts` — canonical TypeScript contract types
   - `server/app/types.py` — Python mirror of contract types
   - `validation-instructions.md` — validator checklist (TP, I, A, R, F, H, D checks)
3. Human review of contract identified 4 issues:
   - **P1**: No authoritative op ordering for concurrent edits — fixed by adding server-assigned `seq` and echo-to-all-clients pattern with `opId` for optimistic reconciliation
   - **P1**: Undo/redo underspecified for concurrent edits — fixed with explicit field-level LWW semantics
   - **P1**: 2-session split didn't match planned 5-session execution — split into infra-runtime, backend-auth-canvas, backend-realtime-persistence, frontend-whiteboard, integration-hardening
   - **P2**: Type parity drift risk — added TP1/TP2/TP3 validator checks

### Phase 1: Parallel Build (infra + frontend)

4. Dispatched session 1 (infra-runtime) and session 4 (frontend-whiteboard) in parallel.
   - Session 1 handled by a separate Claude Code instance
   - Session 4 handled by a separate Claude Code instance

### Phase 2: Parallel Build (backend modules)

5. Dispatched session 2 (backend-auth-canvas) via two parallel subagents:
   - One agent built `server/app/auth.py` (signup, login, me with JWT + bcrypt)
   - One agent built `server/app/canvas.py` (CRUD, invite, membership guards)
   - Post-build fix: changed canvas.py from HTTPException to JSONResponse for contract-compliant error payloads

### Phase 3: Validation and Fixes

6. First validator pass identified 5 findings:
   - **P0**: Cross-canvas shape mutation — ws.py update/delete scoped only by `id`, not `(canvas_id, id)`. Fixed by adding `AND canvas_id = $N` to WHERE clauses.
   - **P0**: App.tsx still placeholder — was already fixed (stale finding).
   - **P1**: Shape type mutation allowed — `_ALLOWED_UPDATE_COLS` didn't exclude `type`. Fixed by adding `type` to exclusion set.
   - **P1**: Undo fabricates placeholder shape — `reverseOp` created a bogus zero-size rectangle when snapshot missing. Fixed to return `null`.
   - **P2**: UUID parsing crash — `canvas.py` called `UUID(canvas_id)` without try/except. Fixed with error handling returning 404.

7. Second validator pass identified 4 findings:
   - **P1**: Z-order lost on reload — `ORDER BY id` (random UUIDs). Fixed by adding `created_at` column to shapes table and `ORDER BY created_at, id`.
   - **P2**: Hit-test vs render disagree — **false positive**, hitTest already iterates in correct reverse order.
   - **P2**: Heartbeat cleanup assumes task exists — `heartbeat_task` referenced before assignment if init fails. Fixed with `heartbeat_task = None` guard.
   - **P2**: Presence overwrite on second tab — old socket disconnect removes newer connection. Fixed by checking `info["ws"] is ws` before popping.

### Phase 4: Testing

8. Designed test strategy prioritizing integration/WS tests over unit tests.
9. Wrote 66 tests across server and client:
   - `server/tests/conftest.py` — DB pool reset per test, rate limit clear, truncate cleanup
   - `server/tests/test_auth.py` — 9 tests (signup, login, me, duplicates, bad creds)
   - `server/tests/test_canvas.py` — 14 tests (CRUD, invite, membership, delete, malformed IDs)
   - `server/tests/test_ws.py` — 15 tests (auth reject, init, op echo, seq monotonicity, update/delete persistence, no-op handling, type immutability, canvas isolation, two-client broadcast, persistence across reconnect, join/leave presence, cursor broadcast)
   - `client/src/operations.test.ts` — 16 tests (applyOp, reverseOp, undo round-trips)
   - `client/src/canvasRenderer.test.ts` — 12 tests (hitTest, getHandlePositions, hitTestHandle)
10. Fixed test infrastructure issues:
    - asyncpg pool bound to wrong event loop between tests — fixed by resetting module-global pool per test
    - In-memory rate limiter blocking tests — fixed by clearing state per test
    - Starlette TestClient WS context manager usage — rewrote WS tests as sync tests
    - Accept-then-close WS auth pattern — adjusted rejection tests to expect WebSocketDisconnect with correct close codes
11. All 66 tests passing (server: 38, client: 28).

## Key Decisions Made During This Session

- **Error response format**: Used `JSONResponse(content={"error": "..."})` instead of `HTTPException(detail=...)` to match the contract's `{"error": "<code>"}` shape.
- **Canvas isolation**: All shape mutations in ws.py are scoped by both `canvas_id` AND `shape_id` in WHERE clauses.
- **Z-order persistence**: Added `created_at` column to shapes table; shapes ordered by creation time on load.
- **Presence safety**: Cleanup only removes presence entry if the stored WebSocket reference matches the disconnecting socket.
- **Test architecture**: WS tests use Starlette's synchronous TestClient (manages its own event loop); HTTP tests use httpx AsyncClient with ASGITransport.

### Phase 5: UI Polish & PRD Features (this session continuation)

12. UI overhaul using frontend-design skill:
    - Floating bottom toolbar (dark, multi-row, SVG icons with labels)
    - 8-color preset palette + custom color picker
    - Compact avatar row for presence (top-right)
    - Dot-grid canvas background
    - Refined auth card + canvas list grid cards with hover lift
    - Opacity slider in toolbar
    - Font size dropdown (12-64px) for text shapes
13. Resilience features (built on feature/resilience branch via subagent, merged to main):
    - WebSocket reconnection with exponential backoff (1s-30s cap, jitter, 10 max retries, manual retry banner)
    - Server ping/pong heartbeat (30s interval, 10s pong timeout, cleans ghost connections)
    - Cursor lerp interpolation (rAF loop, 0.15 factor, 5s idle fade to 0.3 opacity)
    - Selected shape renders on top (z-order lift)
14. Additional PRD features (parallel subagents):
    - DELETE /api/canvases/{id} endpoint (owner-only, CASCADE) + UI delete button on cards
    - Shape opacity (DB column, globalAlpha rendering)
    - Rectangle borderRadius (DB column, roundRect rendering)
    - Text hit-testing fix (ctx.measureText for accurate bounding box)
    - Auth rate limiting (5/min per IP, in-memory, 429 rate_limited response)
    - Optimistic op replay on reconnect (pending ops re-sent with new opIds after init)
15. Post-merge bug fixes from external code review:
    - First WS failure now enters reconnect loop (shouldReconnectRef was never set)
    - Undo/redo blocked while disconnected (prevents burning history silently)
    - Resize normalizes negative width/height from cross-edge drag
    - Keyboard shortcuts skip INPUT/TEXTAREA focus (no hijacking invite field)
    - Shape queries use ORDER BY created_at, id (added created_at column to shapes)
16. Documentation maintained via parallel subagents throughout:
    - SCRATCH.md updated 3 times
    - docs/ folder (7 files) updated 2 times
    - All kept in sync with code changes

## How to Export Full Claude Code Logs

Run after each session ends:
```bash
# Find session files
ls ~/.claude/sessions/

# Or use the resume picker to find session IDs
claude --resume

# Copy relevant session transcripts
cp ~/.claude/sessions/<session-id>.json logs/
```

Session transcripts are stored in `~/.claude/` and can be copied into the `logs/` directory.

## Codex Logs Added

- Marker message for Codex export: `from this message on, can we do what LOGS.md wants to do?`
- Main Codex thread exported from that marker onward to `logs/codex-main-from-logs-marker.jsonl`
- Additional Codex review threads copied to:
  - `logs/codex-review-1-backend-bugs.jsonl`
  - `logs/codex-review-2-frontend-regressions.jsonl`
  - `logs/codex-review-3-backend-correctness.jsonl`
  - `logs/codex-review-4-frontend-canvas.jsonl`
  - `logs/codex-review-5-backend-correctness-bugs.jsonl`
  - `logs/codex-review-6-frontend-bugs.jsonl`

If more Codex conversation happens after this note, refresh `logs/codex-main-from-logs-marker.jsonl` again right before the final commit so it includes the latest tail of the main thread.
