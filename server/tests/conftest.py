"""Shared fixtures for server tests.

Requires a running PostgreSQL with the schema applied.
Use: docker compose up db, then run pytest from server/.
"""

from __future__ import annotations

import os
import uuid

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# Force test JWT secret before any app imports
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault(
    "DATABASE_URL",
    "postgres://whiteboard:whiteboard@localhost:5432/whiteboard",
)

from app.main import app  # noqa: E402
import app.db as _db_mod  # noqa: E402
import app.auth as _auth_mod  # noqa: E402


@pytest_asyncio.fixture(autouse=True)
async def _reset_pool():
    """Reset the module-global DB pool so each test gets one on the current loop.

    pytest-asyncio creates a fresh event loop per test. asyncpg pools are bound
    to the loop they were created on. Without this reset, test N+1 tries to use
    a pool from test N's (now-closed) loop and crashes.
    """
    # Clear rate limit state from prior tests
    _auth_mod._rate_limits.clear()

    # Close stale pool from prior test (different event loop)
    if _db_mod.pool is not None:
        try:
            await _db_mod.pool.close()
        except Exception:
            pass
        _db_mod.pool = None

    yield

    # Truncate after test
    pool = await _db_mod.get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "TRUNCATE shapes, canvas_members, canvases, users CASCADE"
        )

    # Close pool so next test creates a fresh one
    if _db_mod.pool is not None:
        try:
            await _db_mod.pool.close()
        except Exception:
            pass
        _db_mod.pool = None


@pytest_asyncio.fixture
async def client() -> AsyncClient:
    """Async HTTP client wired to the FastAPI app."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ── Helper functions ─────────────────────────────────────────


async def create_user(
    client: AsyncClient,
    username: str | None = None,
    email: str | None = None,
    password: str = "testpass123",
) -> dict:
    """Sign up a user and return {"token": ..., "user": ...}."""
    username = username or f"user_{uuid.uuid4().hex[:8]}"
    email = email or f"{username}@test.com"
    resp = await client.post(
        "/api/auth/signup",
        json={"username": username, "email": email, "password": password},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def auth_header(token: str) -> dict[str, str]:
    """Build an Authorization header dict."""
    return {"Authorization": f"Bearer {token}"}


async def create_canvas(
    client: AsyncClient, token: str, name: str = "Test Canvas"
) -> dict:
    """Create a canvas and return the CanvasSummary."""
    resp = await client.post(
        "/api/canvases",
        json={"name": name},
        headers=auth_header(token),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()
