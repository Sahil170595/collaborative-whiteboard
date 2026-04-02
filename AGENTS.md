# AGENTS.md

Use this file for scoped handoffs and post-build review in this repository. Read `CLAUDE.md` first.

## Non-Negotiables

- Stay on the provided stack. Do not swap React, FastAPI, PostgreSQL, or Vite.
- Work on `main`. Commit early and often. Push directly to `main`. No PR workflow.
- Optimize for the actual deployment context: 2-5 users, same canvas, same call, simultaneous edits, 30-90 minute sessions, persistence across sessions.
- Correctness for required features matters more than polishing out-of-scope features.
- Keep collaborative text editing simple. Treat text edits as whole-object updates.
- Prefer simple, explicit conflict behavior over clever distributed systems work. Last-write-wins is acceptable here.

## Shared Review Priorities

Every builder and reviewer should care about these first:

1. Client and server agree on canvas object and websocket payload shapes.
2. Undo and redo semantics are internally consistent and do not corrupt persisted state.
3. Simultaneous edits to the same object have defined behavior.
4. Presence and cursor updates are ephemeral and do not pollute persisted board state.
5. Canvas state reloads correctly across sessions.
6. Authentication and canvas access are enforced on both HTTP and websocket paths.

## Canonical Ownership

If work is split, keep ownership boundaries clean.

### Agent: `infra-runtime` (session-1)

- Scope:
  - `server/schema.sql`
  - `server/app/db.py`
  - `server/app/main.py`
  - `server/app/deps.py`
  - `server/pyproject.toml`
  - `server/Dockerfile`
  - `docker-compose.yml`
- Responsibilities:
  - deterministic local startup
  - Docker networking fixes
  - health and readiness behavior
  - environment-variable wiring
  - schema DDL
  - CORS configuration
  - auth dependency (`get_current_user`)
- Must not own:
  - whiteboard domain logic
  - websocket protocol design
  - client canvas behavior

### Agent: `backend-auth-canvas` (session-2)

- Scope:
  - `server/app/auth.py`
  - `server/app/canvas.py`
- Responsibilities:
  - auth endpoints (signup, login, me)
  - canvas CRUD and invite flow
- Must not own:
  - websocket protocol
  - React component structure
  - Docker or infra changes

### Agent: `backend-realtime-persistence` (session-3)

- Scope:
  - `server/app/ws.py`
- Responsibilities:
  - websocket auth and connection lifecycle
  - op processing, persistence, and broadcast
  - per-canvas locking and seq ordering
  - cursor broadcast and presence management
- Must not own:
  - HTTP auth or canvas routes
  - React component structure
  - Docker or infra changes

### Agent: `frontend-whiteboard` (session-4)

- Scope:
  - `client/src/` except `client/src/types.ts`
- Responsibilities:
  - auth screens and session state
  - canvas list, creation, and invite UI
  - whiteboard rendering and shape interactions
  - undo and redo with client-side stacks
  - websocket client integration and optimistic ops
  - live cursor rendering
  - state rehydration after refresh
- Must not own:
  - backend protocol changes without updating the shared contract first
  - Docker or DB changes unless explicitly reassigned
  - shared contract types (`client/src/types.ts`)

### Agent: `integration-hardening` (session-5)

- Scope:
  - cross-boundary fixes only after validation
- Responsibilities:
  - wire routers (`auth_router`, `canvas_router`, `websocket_endpoint`) into `server/app/main.py`
  - fix validator findings without changing the frozen contract
  - resolve integration mismatches between client and server
  - end-to-end manual verification
- Must not own:
  - `BUILD_CONTRACT.md`, `client/src/types.ts`, or `server/app/types.py` unless the architect explicitly reopens the contract

### Agent: `reviewer`

- Scope:
  - read-only across the whole repo
- Responsibilities:
  - code review after feature work
  - identify regressions, risks, missing validation, and protocol mismatches
  - verify required features against the take-home rubric
- Must not do:
  - opportunistic refactors
  - style-only feedback unless style causes defects
  - implementation work unless explicitly asked

## Handoff Requirements

Any handoff should include:

- exact write scope
- files changed
- public exports added or changed
- API routes added or changed
- websocket message types added or changed
- schema changes
- follow-up blockers
- what still needs validation

Use this format:

```md
## Handoff
- Scope:
- Files changed:
- Routes changed:
- Websocket messages changed:
- Schema changes:
- New env vars:
- Risks or blockers:
- Next validator checks:
```

## Builder Prompt Template

```text
Read CLAUDE.md and AGENTS.md first.
Own only [write-scope].
Implement [task].
Preserve the provided stack and current repo conventions.
Do not change shapes, websocket payloads, or persistence semantics outside your scope without calling it out explicitly.
At the end, provide a handoff using the AGENTS.md format.
```

## Reviewer Prompt Template

```text
Read CLAUDE.md and AGENTS.md first.
Review the finished implementation in a code-review mindset.
Prioritize bugs, robustness gaps, behavioral regressions, protocol mismatches, missing validation, and missing tests.
Focus on the actual take-home requirements and the synchronous-collaboration deployment context.
Do not fix code. Report findings first, ordered by severity, with file references.
```

## Whiteboard-Specific Review Checklist

The reviewer should explicitly check:

- accounts: signup, login, logout actually work
- canvas access: create, open, invite work end to end
- persistence: reloading a canvas restores the latest state
- shapes: rectangle, ellipse, line, and text all round-trip correctly
- manipulation: select, move, resize, recolor, delete work locally and remotely
- collaboration: two users see each other's edits promptly
- cursor presence: cursors render for other users and disappear on disconnect
- websocket auth: unauthorized users cannot attach to arbitrary canvases
- undo and redo: behavior is predictable under concurrent edits
- conflict handling: same-object edits do not crash or corrupt board state
- reconnect behavior: stale or disconnected clients do not leave broken presence state behind

## Recommended Review Order

1. `server/schema.sql`
2. `server/app/**` auth, canvas, invite, websocket, persistence
3. `client/src/**` state model and websocket integration
4. cross-check shared payload shapes between client and server
5. Docker and local run flow

## Stop Conditions

Pause and escalate instead of pushing ahead when:

- client and server payload shapes diverge
- undo and redo behavior is undefined under concurrent edits
- websocket messages are added ad hoc without a stable envelope
- auth is implemented for HTTP but not websocket access
- canvas persistence and live collaboration use different shape models

## Notes For This Repo

- The current scaffold is minimal. Expect most required behavior to be built from scratch.
- `server/schema.sql` is the canonical place for DDL.
- `asyncpg` uses `$1`, `$2` placeholders. Do not use string-formatted SQL.
- The frontend should talk through `/api/*` and `/ws`, not hardcoded server ports.
- If a contract file is introduced later, treat it as architect-owned and keep reviewers focused on contract compliance.
