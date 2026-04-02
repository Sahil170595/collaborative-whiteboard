# AI Interaction Logs

## Tools Used

- **Claude Code CLI** (Claude Opus 4.6, 1M context) — primary tool for all implementation
- Multiple parallel Claude Code sessions via the Agent/subagent system

## Session Overview

1. **Architect session** (this session) — contract design, code review, dispatch, validation fixes
2. **Session 1: infra-runtime** — schema.sql, db.py, main.py, deps.py, Dockerfiles, docker-compose
3. **Session 2: backend-auth-canvas** — auth.py (signup/login/me), canvas.py (CRUD + invite)
4. **Session 3: backend-realtime-persistence** — ws.py (WebSocket handler, op persistence, presence)
5. **Session 4: frontend-whiteboard** — full React client (auth UI, canvas, shape tools, undo/redo, cursors)
6. **Session 5: integration-hardening** — router wiring, validator fix pass

## Workflow

1. Started with a code review and security audit of the scaffold repo.
2. Created a contract pack (BUILD_CONTRACT.md, validation-instructions.md, shared types) using the /swarm skill.
3. Iterated on the contract after human review: added server-authoritative op ordering (seq + opId), field-level LWW undo semantics, and split from 2-session to 5-session ownership.
4. Dispatched sessions in parallel phases:
   - Phase 1: infra-runtime + frontend-whiteboard
   - Phase 2: backend-auth-canvas + backend-realtime-persistence
5. Ran validation pass and fixed findings:
   - P0: cross-canvas shape isolation (ws.py update/delete scoped by canvas_id)
   - P1: shape type mutation blocked (excluded from allowed update cols)
   - P1: undo placeholder fabrication removed (reverseOp returns null)
   - P2: UUID parsing crash guard (canvas.py try/except on malformed IDs)
6. Integration hardening: wired routers, applied post-validation fixes.

## How to export full Claude Code logs

Run after the session ends:
```bash
# Find session files
ls ~/.claude/sessions/

# Or use the resume picker to find session IDs
claude --resume
```

Session transcripts are stored in `~/.claude/` and can be copied into this directory.
