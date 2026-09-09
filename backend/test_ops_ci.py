"""Unit tests for the ops CI-trigger endpoints.

Covers the two load-bearing guardrails from the ticket spec:

1. Allowlist is enforced server-side — an arbitrary workflow filename or an
   id the caller made up cannot be dispatched.
2. `require_system_user` guards both routes — a non-SYSTEM caller is 403'd
   before any GitHub call is made.

The tests do not talk to real GitHub. They mock the httpx client at the
module level so a broken/missing PAT doesn't matter and the CI runner
doesn't need network egress.
"""

import base64
import os
from unittest.mock import MagicMock, patch

import jwt
import pytest

# Configure required env before importing main so the JWT middleware and
# ops routes have deterministic secrets.
_SECRET = b"unit-test-secret-value"
os.environ.setdefault("C2A_JWT_SECRET", base64.b64encode(_SECRET).decode())
os.environ.setdefault("GH_OPS_DISPATCH_TOKEN", "ghp_unit_test_token")

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402


client = TestClient(main.app)


def _mint(user_type: str, sub: str = "u-test") -> str:
    """Mint a JWT the backend's middleware and dependency accept."""
    return jwt.encode(
        {"sub": sub, "userType": user_type, "exp": 9999999999},
        _SECRET,
        algorithm="HS256",
    )


def _auth(user_type: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint(user_type)}"}


class _FakeResp:
    def __init__(self, status_code: int, body: dict | None = None):
        self.status_code = status_code
        self._body = body or {}

    def json(self) -> dict:
        return self._body


class _FakeClient:
    """Minimal httpx.Client stand-in for the two calls the ops code makes."""

    def __init__(self, *, post_status: int = 204, runs: list[dict] | None = None):
        self.post_status = post_status
        self.runs = runs if runs is not None else []
        self.post_calls: list[tuple[str, dict]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def get(self, url, headers=None, params=None):  # noqa: ARG002
        return _FakeResp(200, {"workflow_runs": self.runs})

    def post(self, url, headers=None, json=None):  # noqa: ARG002
        self.post_calls.append((url, json or {}))
        return _FakeResp(self.post_status)


# ---------------------------------------------------------------------------
# RBAC — require_system_user
# ---------------------------------------------------------------------------


def test_list_requires_system_user():
    resp = client.get("/api/ops/ci-triggers", headers=_auth("USER"))
    assert resp.status_code == 403


def test_run_requires_system_user():
    resp = client.post(
        "/api/ops/ci-triggers/int-tests-pypi-fresh-install/run",
        headers=_auth("USER"),
    )
    assert resp.status_code == 403


def test_list_unauthenticated_401():
    # No Authorization header at all — the middleware short-circuits before
    # the dependency runs.
    resp = client.get("/api/ops/ci-triggers")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Allowlist enforcement
# ---------------------------------------------------------------------------


def test_run_rejects_unknown_trigger_id():
    fake = _FakeClient()
    with patch.object(main.httpx, "Client", return_value=fake):
        resp = client.post(
            "/api/ops/ci-triggers/arbitrary-workflow.yml/run",
            headers=_auth("SYSTEM"),
        )
    assert resp.status_code == 404
    # And no HTTP call was made to GH — the allowlist rejects before any
    # network I/O.
    assert fake.post_calls == []


def test_run_ignores_client_supplied_workflow_filename():
    # Even a valid id can't be tricked into hitting a different workflow —
    # the workflow_filename is read from the server's allowlist entry, not
    # from the request. This test just confirms the dispatched URL matches
    # the allowlisted file.
    fake = _FakeClient(post_status=204)
    with patch.object(main.httpx, "Client", return_value=fake):
        resp = client.post(
            "/api/ops/ci-triggers/int-tests-pypi-fresh-install/run"
            "?workflow_filename=evil.yml",
            headers=_auth("SYSTEM"),
        )
    assert resp.status_code == 200
    assert len(fake.post_calls) == 1
    url, body = fake.post_calls[0]
    assert url.endswith("/actions/workflows/pypi-fresh-install.yml/dispatches")
    assert body == {"ref": "main"}


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_list_returns_allowlist_and_token_status():
    fake = _FakeClient(
        runs=[
            {
                "id": 42,
                "run_number": 7,
                "status": "completed",
                "conclusion": "success",
                "html_url": "https://github.com/x/y/actions/runs/42",
                "created_at": "2026-09-01T00:00:00Z",
                "updated_at": "2026-09-01T00:05:00Z",
                "actor": {"login": "someone"},
                "event": "workflow_dispatch",
            }
        ]
    )
    with patch.object(main.httpx, "Client", return_value=fake):
        resp = client.get("/api/ops/ci-triggers", headers=_auth("SYSTEM"))
    assert resp.status_code == 200
    body = resp.json()
    assert body["gh_token_configured"] is True
    ids = [t["id"] for t in body["triggers"]]
    assert "int-tests-pypi-fresh-install" in ids
    row = next(t for t in body["triggers"] if t["id"] == "int-tests-pypi-fresh-install")
    assert row["last_run"]["conclusion"] == "success"


def test_run_dispatches_and_returns_last_run():
    fake = _FakeClient(
        post_status=204,
        runs=[
            {
                "id": 99,
                "run_number": 8,
                "status": "queued",
                "conclusion": None,
                "html_url": "https://github.com/x/y/actions/runs/99",
                "created_at": "2026-09-09T00:00:00Z",
                "updated_at": "2026-09-09T00:00:00Z",
                "actor": {"login": "sys"},
                "event": "workflow_dispatch",
            }
        ],
    )
    with patch.object(main.httpx, "Client", return_value=fake):
        resp = client.post(
            "/api/ops/ci-triggers/int-tests-pypi-fresh-install/run",
            headers=_auth("SYSTEM"),
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["dispatched"] is True
    assert body["last_run"]["run_id"] == 99
    # Exactly one dispatch call, aimed at the allowlisted workflow.
    assert len(fake.post_calls) == 1
    assert fake.post_calls[0][0].endswith(
        "clue2app-integration-tests/actions/workflows/pypi-fresh-install.yml/dispatches"
    )


def test_run_returns_503_when_token_missing(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("GH_OPS_DISPATCH_TOKEN", raising=False)
    fake = _FakeClient()
    with patch.object(main.httpx, "Client", return_value=fake):
        resp = client.post(
            "/api/ops/ci-triggers/int-tests-pypi-fresh-install/run",
            headers=_auth("SYSTEM"),
        )
    assert resp.status_code == 503
    assert "GH_OPS_DISPATCH_TOKEN" in resp.json()["detail"]
    # No GH call was made.
    assert fake.post_calls == []


def test_run_surfaces_gh_error_as_502():
    fake = _FakeClient(post_status=422)
    with patch.object(main.httpx, "Client", return_value=fake):
        resp = client.post(
            "/api/ops/ci-triggers/int-tests-pypi-fresh-install/run",
            headers=_auth("SYSTEM"),
        )
    assert resp.status_code == 502
