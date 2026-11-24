"""Tests for the /api/agents/<path> proxy and its console CORS rule.

What is covered:
  * auth: jwt_auth_middleware (SYSTEM users only) answers before the proxy
    handler on every allowlisted route, and nothing is sent upstream;
  * the (method, path) allowlist, and 404 / 405 for everything else;
  * path tricks (dots, encodings, separators, `@`, absolute URLs) never reach
    the upstream, and the upstream host never changes;
  * only safe headers go upstream, plus the service token; the caller's
    Authorization header, cookies and ?token= do not;
  * error mapping, timeouts, and that upstream bodies are not echoed or logged;
  * audit: one line per refused call with a fixed reason code and never a
    refused raw path; POSTs and failures that reached upstream as before;
  * CORS for the console origins on GET /api/agents/costs[/...] only.

No network: the upstream is an httpx.MockTransport. The JWT signing key and
the service token are generated per test with `secrets`.
"""

import asyncio
import json
import secrets
import time
from types import SimpleNamespace
from typing import Callable, Dict, List, Optional, Tuple

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

import main

client = TestClient(main.app)

UPSTREAM = "http://agents.test"
CONSOLE = "https://console.clue2.app"
CONSOLE_CONTROL = "https://console.control.apps.clue2.app"

# One concrete call per allowlisted route: (method, path incl. query, body).
ROUTE_EXAMPLES: List[Tuple[str, str, Optional[dict]]] = [
    ("GET", "dashboard", None),
    ("GET", "agents/ecr-healer/status", None),
    ("GET", "agents/ecr-healer/history?limit=50", None),
    ("POST", "agents/ecr-healer/start", None),
    ("POST", "agents/ecr-healer/stop", None),
    ("POST", "agents/ecr-healer/check", None),
    ("POST", "heal", {"agent": "ecr-healer", "dry_run": True}),
    ("GET", "costs", None),
    ("GET", "costs/summary", None),
    ("GET", "costs/trends?period=daily&months=3", None),
    ("GET", "costs/pricing-model", None),
    ("GET", "costs/metrics-history?hours=24", None),
]


# ---------------------------------------------------------------------------
# fixtures + helpers
# ---------------------------------------------------------------------------


class Upstream:
    """Stand-in agents service: records each request, answers via `respond`."""

    def __init__(self) -> None:
        self.requests: List[httpx.Request] = []
        self.timeouts: List[httpx.Timeout] = []
        self.respond: Callable[[httpx.Request], httpx.Response] = lambda _req: httpx.Response(
            200, json={"ok": True}
        )

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.respond(request)


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    key = secrets.token_bytes(32)
    monkeypatch.setattr(main, "JWT_SECRET_BYTES", key)
    service_token = secrets.token_hex(24)
    monkeypatch.setenv("AGENTS_SERVICE_TOKEN", service_token)
    monkeypatch.setenv("AGENTS_INTERNAL_URL", UPSTREAM)
    return SimpleNamespace(key=key, service_token=service_token)


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch) -> Upstream:
    up = Upstream()
    transport = httpx.MockTransport(up.handler)

    def fake_client(timeout: httpx.Timeout) -> httpx.AsyncClient:
        up.timeouts.append(timeout)
        return httpx.AsyncClient(
            transport=transport, timeout=timeout, follow_redirects=False, trust_env=False
        )

    monkeypatch.setattr(main, "_agents_http_client", fake_client)
    return up


def mint(env: SimpleNamespace, user_type: str = "SYSTEM", exp_in: int = 600) -> str:
    return jwt.encode(
        {"sub": "u-test", "userType": user_type, "exp": int(time.time()) + exp_in},
        env.key,
        algorithm="HS256",
    )


def bearer(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def call(method: str, path: str, *, headers=None, body=None, **kw) -> httpx.Response:
    if body is not None:
        kw["json"] = body
    return client.request(method, "/api/agents/" + path, headers=headers or {}, **kw)


def raw_asgi(method: str, raw_path: bytes, headers: Dict[str, str]) -> Tuple[int, bytes]:
    """Drive the ASGI app directly so the path arrives byte-for-byte as given.

    httpx (and so TestClient) collapses a literal `..` before sending; a raw
    HTTP client does not, and uvicorn passes it on as-is."""

    async def run() -> Tuple[int, bytes]:
        from urllib.parse import unquote

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": unquote(raw_path.decode("latin-1")),
            "raw_path": raw_path,
            "root_path": "",
            "query_string": b"",
            "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
            "client": ("127.0.0.1", 50000),
            "server": ("testserver", 80),
        }
        sent: List[dict] = []
        done = asyncio.Event()
        request_read = False

        async def receive() -> dict:
            nonlocal request_read
            if not request_read:
                request_read = True
                return {"type": "http.request", "body": b"", "more_body": False}
            await done.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            sent.append(message)
            if message["type"] == "http.response.body" and not message.get("more_body"):
                done.set()

        await main.app(scope, receive, send)
        status = next(m["status"] for m in sent if m["type"] == "http.response.start")
        body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
        return status, body

    return asyncio.run(run())


# ---------------------------------------------------------------------------
# auth — the existing SYSTEM middleware covers every proxied route
# ---------------------------------------------------------------------------


def test_agents_paths_are_not_auth_exempt():
    assert not any(p.startswith("/api/agents") for p in main.AUTH_EXEMPT_PATHS)


@pytest.mark.parametrize("method,path,body", ROUTE_EXAMPLES)
def test_no_token_is_rejected_by_the_middleware(upstream, method, path, body):
    resp = call(method, path, body=body)
    assert resp.status_code == 401
    # The middleware's error shape (the route dependency would say "detail").
    assert resp.json() == {"error": "UNAUTHORIZED", "message": "missing bearer token"}
    assert upstream.requests == []


@pytest.mark.parametrize("method,path,body", ROUTE_EXAMPLES)
@pytest.mark.parametrize("user_type", ["USER", "ACCOUNT_ADMIN", ""])
def test_non_system_user_is_rejected_by_the_middleware(env, upstream, method, path, body, user_type):
    resp = call(method, path, headers=bearer(mint(env, user_type)), body=body)
    assert resp.status_code == 403
    assert resp.json() == {"error": "FORBIDDEN", "message": "SYSTEM users only"}
    assert upstream.requests == []


def test_expired_token_is_rejected(env, upstream):
    resp = call("GET", "dashboard", headers=bearer(mint(env, exp_in=-60)))
    assert resp.status_code == 401
    assert upstream.requests == []


def test_token_signed_with_another_key_is_rejected(upstream):
    forged = jwt.encode(
        {"sub": "u", "userType": "SYSTEM", "exp": int(time.time()) + 600},
        secrets.token_bytes(32),
        algorithm="HS256",
    )
    resp = call("GET", "dashboard", headers=bearer(forged))
    assert resp.status_code == 401
    assert upstream.requests == []


# ---------------------------------------------------------------------------
# allowlist
# ---------------------------------------------------------------------------


def test_allowlist_is_exactly_the_routes_the_uis_call():
    # Tripwire: a new route must be added here on purpose, with its caller.
    assert set(main.AGENTS_PROXY_ALLOWLIST) == {
        ("GET", "dashboard"),
        ("GET", "agents/[a-z0-9][a-z0-9_-]{0,63}/status"),
        ("GET", "agents/[a-z0-9][a-z0-9_-]{0,63}/history"),
        ("POST", "agents/[a-z0-9][a-z0-9_-]{0,63}/start"),
        ("POST", "agents/[a-z0-9][a-z0-9_-]{0,63}/stop"),
        ("POST", "agents/[a-z0-9][a-z0-9_-]{0,63}/check"),
        ("POST", "heal"),
        ("GET", "costs"),
        ("GET", "costs/summary"),
        ("GET", "costs/trends"),
        ("GET", "costs/pricing-model"),
        ("GET", "costs/metrics-history"),
    }


@pytest.mark.parametrize("method,path,body", ROUTE_EXAMPLES)
def test_allowlisted_route_is_forwarded_to_the_fixed_upstream(env, upstream, method, path, body):
    resp = call(method, path, headers=bearer(mint(env)), body=body)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True}
    assert len(upstream.requests) == 1
    sent = upstream.requests[0]
    assert sent.method == method
    assert str(sent.url) == f"{UPSTREAM}/{path}"
    assert sent.url.host == "agents.test"


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "stats"),
        ("GET", "health"),
        ("GET", "agents"),
        ("GET", "agents/ecr-healer"),
        ("POST", "start-all"),
        ("POST", "stop-all"),
        ("POST", "heal/ecr"),
        ("POST", "heal/disk"),
        ("POST", "heal/nodes"),
        ("POST", "heal/builders"),
        ("POST", "heal/platform"),
        # No UI calls it: the console reads costs only.
        ("POST", "heal/costs"),
        ("GET", "heal/costs"),
        ("GET", "costs/by-project"),
        ("GET", "costs/projections"),
        ("GET", "costs/some-service"),
        ("GET", "agents/ECR-HEALER/status"),
        ("GET", "agents/-x/status"),
        ("GET", "agents/ecr-healer/status/extra"),
        ("GET", "dashboard/extra"),
    ],
)
def test_route_outside_the_allowlist_is_404(env, upstream, method, path):
    resp = call(method, path, headers=bearer(mint(env)))
    assert resp.status_code == 404
    assert resp.json()["error"] == "NOT_FOUND"
    assert upstream.requests == []


@pytest.mark.parametrize(
    "method,path,allow",
    [
        ("GET", "heal", "POST"),
        ("GET", "agents/ecr-healer/start", "POST"),
        ("POST", "dashboard", "GET"),
        ("POST", "costs/summary", "GET"),
        ("POST", "agents/ecr-healer/status", "GET"),
    ],
)
def test_wrong_method_on_an_allowlisted_path_is_405(env, upstream, method, path, allow):
    resp = call(method, path, headers=bearer(mint(env)))
    assert resp.status_code == 405
    assert resp.headers["allow"] == allow
    assert upstream.requests == []


@pytest.mark.parametrize("method", ["PUT", "PATCH", "DELETE"])
def test_other_methods_are_not_routed(env, upstream, method):
    resp = call(method, "dashboard", headers=bearer(mint(env)))
    assert resp.status_code == 405
    assert upstream.requests == []


# ---------------------------------------------------------------------------
# path tricks
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "%2e%2e/dashboard",
        "%2E%2E/dashboard",
        "agents/%2e%2e/%2e%2e/api/users",
        "agents%2fecr-healer%2fstatus",
        "agents%2Fecr-healer%2Fstatus",
        "%2fdashboard",
        "%252e%252e/dashboard",
        "dashboard%00",
        "agents/ecr-healer%5cstatus",
        "agents/ecr%40evil.test/status",
        "/dashboard",
        "dashboard/",
        "agents//status",
        "agents/x@evil.test/status",
        "agents/ecr-healer/status;x=1",
        "http:/evil.test/dashboard",
        "http://evil.test/dashboard",
        "https:%2F%2Fevil.test%2Fdashboard",
        "agents/ecr healer/status",
        "agents/ecr-healer\\status",
        "",
    ],
)
def test_path_tricks_are_rejected_before_any_upstream_call(env, upstream, path):
    resp = client.get("/api/agents/" + path, headers=bearer(mint(env)))
    assert resp.status_code in (400, 404), (path, resp.status_code)
    assert upstream.requests == []


@pytest.mark.parametrize(
    "raw",
    [
        b"/api/agents/../dashboard",
        b"/api/agents/./dashboard",
        b"/api/agents/agents/../../users",
        b"/api/agents/agents/ecr-healer/..",
        b"/api/agents/..\\dashboard",
        b"/api/agents/http://evil.test/dashboard",
        b"/api/agents/@evil.test/dashboard",
        b"/api/agents/dashboard/.",
    ],
)
def test_literal_dot_and_url_segments_are_rejected(env, upstream, raw):
    status, body = raw_asgi("GET", raw, bearer(mint(env)))
    assert status == 400, (raw, status, body)
    assert json.loads(body) == {"error": "BAD_REQUEST", "message": "invalid agents path"}
    assert upstream.requests == []


def test_rejected_path_is_not_echoed(env, upstream):
    marker = "zz" + secrets.token_hex(6)
    resp = client.get(f"/api/agents/%2e%2e/{marker}", headers=bearer(mint(env)))
    assert resp.status_code == 400
    assert marker not in resp.text


@pytest.mark.parametrize(
    "path,ok",
    [
        ("dashboard", True),
        ("agents/ecr-healer/status", True),
        ("costs/metrics-history", True),
        ("a/b/c/d/e/f/g/h", True),
        ("a/b/c/d/e/f/g/h/i", False),
        ("x" * 257, False),
        ("", False),
        ("..", False),
        (".", False),
        ("a/../b", False),
        ("a//b", False),
        ("a/", False),
        ("/a", False),
        ("a%2fb", False),
        ("a@b", False),
        ("a:b", False),
        ("a\\b", False),
        ("a b", False),
        ("a\nb", False),
        ("ä", False),
    ],
)
def test_path_rule(path, ok):
    assert main._agents_path_is_clean(path) is ok


# ---------------------------------------------------------------------------
# query string, headers, the service token
# ---------------------------------------------------------------------------


def test_query_string_is_forwarded_without_the_callers_token(env, upstream):
    caller_jwt = mint(env)
    # ?token= is how _extract_token also accepts the caller's JWT.
    resp = client.get(
        f"/api/agents/costs/metrics-history?hours=6&token={caller_jwt}&Token=x&hours=12"
    )
    assert resp.status_code == 200
    sent = upstream.requests[0]
    assert sent.url.params.multi_items() == [("hours", "6"), ("hours", "12")]
    assert caller_jwt not in str(sent.url)


def test_only_safe_headers_and_the_service_token_go_upstream(env, upstream):
    caller_jwt = mint(env)
    resp = call(
        "POST",
        "heal",
        body={"agent": "ecr-healer", "dry_run": True},
        headers={
            **bearer(caller_jwt),
            "Cookie": "session=abc",
            "X-Forwarded-For": "203.0.113.9",
            "X-Forwarded-Host": "evil.test",
            "X-Real-IP": "203.0.113.9",
            "Forwarded": "for=203.0.113.9",
            "Origin": "https://evil.test",
            "Referer": "https://evil.test/page",
            "X-Custom": "1",
            "Proxy-Authorization": "Basic abc",
            "User-Agent": "browser/1.0",
        },
    )
    assert resp.status_code == 200
    sent = upstream.requests[0]
    assert sent.headers["authorization"] == f"Bearer {env.service_token}"
    assert sent.headers["host"] == "agents.test"
    assert sent.headers["accept"] == "application/json"
    assert sent.headers["content-type"] == "application/json"
    assert sent.headers["user-agent"] == "clue2app-admin-agents-proxy/1.0"
    for name in (
        "cookie",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-real-ip",
        "forwarded",
        "origin",
        "referer",
        "x-custom",
        "proxy-authorization",
    ):
        assert name not in sent.headers, name
    assert all(caller_jwt not in v for v in sent.headers.values())


def test_service_token_is_sent_and_differs_from_the_callers(env, upstream):
    caller_jwt = mint(env)
    call("GET", "dashboard", headers=bearer(caller_jwt))
    auth = upstream.requests[0].headers.get_list("authorization")
    assert auth == [f"Bearer {env.service_token}"]
    assert caller_jwt not in auth[0]


@pytest.mark.parametrize("value", [None, "", "   ", "two words", "line\nbreak", "tab\tbed"])
def test_missing_or_unusable_service_token_is_503(env, upstream, monkeypatch, value):
    if value is None:
        monkeypatch.delenv("AGENTS_SERVICE_TOKEN", raising=False)
    else:
        monkeypatch.setenv("AGENTS_SERVICE_TOKEN", value)
    resp = call("GET", "dashboard", headers=bearer(mint(env)))
    assert resp.status_code == 503
    assert resp.json()["error"] == "AGENTS_PROXY_NOT_CONFIGURED"
    assert upstream.requests == []


@pytest.mark.parametrize(
    "value",
    ["ftp://agents.test", "agents.test", "http://agents.test/?x=1", "http://someone@agents.test", "http://"],
)
def test_unusable_internal_url_is_503(env, upstream, monkeypatch, value):
    monkeypatch.setenv("AGENTS_INTERNAL_URL", value)
    resp = call("GET", "dashboard", headers=bearer(mint(env)))
    assert resp.status_code == 503
    assert upstream.requests == []


def test_default_internal_url_is_the_in_cluster_service(env, upstream, monkeypatch):
    monkeypatch.delenv("AGENTS_INTERNAL_URL", raising=False)
    call("GET", "dashboard", headers=bearer(mint(env)))
    assert str(upstream.requests[0].url) == (
        "http://clue2app-agents.control.svc.cluster.local/dashboard"
    )


@pytest.mark.parametrize(
    "base,expected",
    [
        ("http://agents.test/", "http://agents.test/costs/summary"),
        ("http://agents.test:8080", "http://agents.test:8080/costs/summary"),
        ("http://agents.test/prefix/", "http://agents.test/prefix/costs/summary"),
    ],
)
def test_internal_url_forms(env, upstream, monkeypatch, base, expected):
    monkeypatch.setenv("AGENTS_INTERNAL_URL", base)
    call("GET", "costs/summary", headers=bearer(mint(env)))
    assert str(upstream.requests[0].url) == expected


def test_timeouts(env, upstream):
    call("GET", "dashboard", headers=bearer(mint(env)))
    call("POST", "heal", headers=bearer(mint(env)), body={"agent": "ecr-healer"})
    get_t, post_t = upstream.timeouts
    assert (get_t.connect, get_t.read) == (3.0, 15.0)
    assert (post_t.connect, post_t.read) == (3.0, 120.0)


def test_real_upstream_client_does_not_follow_redirects_or_read_env():
    # The other tests swap this factory out, so check the real one directly.
    real = main._agents_http_client(httpx.Timeout(1.0))
    try:
        assert real.follow_redirects is False
        assert real.trust_env is False
    finally:
        asyncio.run(real.aclose())


# ---------------------------------------------------------------------------
# request bodies
# ---------------------------------------------------------------------------


def test_json_body_is_forwarded_unchanged(env, upstream):
    resp = call("POST", "heal", headers=bearer(mint(env)), body={"agent": "ecr-healer", "dry_run": True})
    assert resp.status_code == 200
    sent = upstream.requests[0]
    assert json.loads(sent.content) == {"agent": "ecr-healer", "dry_run": True}


def test_post_without_body_sends_none(env, upstream):
    call("POST", "agents/ecr-healer/start", headers=bearer(mint(env)))
    sent = upstream.requests[0]
    assert sent.content == b""
    assert "content-type" not in sent.headers


def test_get_body_is_not_forwarded(env, upstream):
    client.request(
        "GET",
        "/api/agents/dashboard",
        headers={**bearer(mint(env)), "Content-Type": "application/json"},
        content=b'{"a": 1}',
    )
    assert upstream.requests[0].content == b""


def test_non_json_body_is_415(env, upstream):
    resp = client.post(
        "/api/agents/heal",
        headers={**bearer(mint(env)), "Content-Type": "text/plain"},
        content=b"agent=ecr-healer",
    )
    assert resp.status_code == 415
    assert upstream.requests == []


def test_invalid_json_body_is_400(env, upstream):
    resp = client.post(
        "/api/agents/heal",
        headers={**bearer(mint(env)), "Content-Type": "application/json"},
        content=b"{not json",
    )
    assert resp.status_code == 400
    assert upstream.requests == []


def test_oversized_body_is_413(env, upstream):
    resp = call("POST", "heal", headers=bearer(mint(env)), body={"pad": "x" * (64 * 1024)})
    assert resp.status_code == 413
    assert upstream.requests == []


# ---------------------------------------------------------------------------
# response + error mapping
# ---------------------------------------------------------------------------


def test_success_passes_json_through_with_safe_headers_only(env, upstream):
    upstream.respond = lambda _r: httpx.Response(
        200,
        json={"agents": [{"name": "ecr-healer"}]},
        headers={"Set-Cookie": "a=b", "X-Upstream-Internal": "1", "Server": "uvicorn"},
    )
    resp = call("GET", "dashboard", headers=bearer(mint(env)))
    assert resp.status_code == 200
    assert resp.json() == {"agents": [{"name": "ecr-healer"}]}
    assert resp.headers["content-type"] == "application/json"
    assert resp.headers["cache-control"] == "no-store"
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert "set-cookie" not in resp.headers
    assert "x-upstream-internal" not in resp.headers


def test_empty_2xx_passes_through(env, upstream):
    upstream.respond = lambda _r: httpx.Response(204)
    resp = call("POST", "agents/ecr-healer/stop", headers=bearer(mint(env)))
    assert resp.status_code == 204
    assert resp.content == b""


@pytest.mark.parametrize("status", [404, 409, 422, 429])
def test_client_errors_pass_through_with_their_json(env, upstream, status):
    upstream.respond = lambda _r: httpx.Response(status, json={"detail": "Agent 'x' not found"})
    resp = call("GET", "agents/x/status", headers=bearer(mint(env)))
    assert resp.status_code == status
    assert resp.json() == {"detail": "Agent 'x' not found"}


def test_non_json_client_error_is_replaced(env, upstream):
    upstream.respond = lambda _r: httpx.Response(404, text="<html>nope</html>")
    resp = call("POST", "agents/ecr-healer/check", headers=bearer(mint(env)))
    assert resp.status_code == 404
    assert resp.json()["error"] == "AGENTS_REQUEST_REJECTED"
    assert "html" not in resp.text


@pytest.mark.parametrize("status", [401, 403])
def test_upstream_auth_refusal_is_502_never_401(env, upstream, capsys, status):
    marker = "zz" + secrets.token_hex(8)
    upstream.respond = lambda _r: httpx.Response(status, json={"error": "unauthorized", "m": marker})
    resp = call("POST", "agents/ecr-healer/start", headers=bearer(mint(env)))
    # A 401 here would make the SPA drop the user's session.
    assert resp.status_code == 502
    assert resp.json()["error"] == "AGENTS_UPSTREAM_AUTH"
    assert marker not in resp.text
    assert marker not in capsys.readouterr().out


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_server_errors_are_502_without_the_upstream_body(env, upstream, capsys, status):
    marker = "zz" + secrets.token_hex(8)
    upstream.respond = lambda _r: httpx.Response(status, json={"trace": marker})
    resp = call("GET", "dashboard", headers=bearer(mint(env)))
    assert resp.status_code == 502
    assert resp.json() == {
        "error": "AGENTS_UPSTREAM_ERROR",
        "message": f"agents service returned HTTP {status}",
    }
    assert marker not in resp.text
    assert marker not in capsys.readouterr().out


def test_redirect_is_not_followed_or_passed_on(env, upstream):
    upstream.respond = lambda _r: httpx.Response(
        307, headers={"Location": "http://elsewhere.test/x"}
    )
    resp = call("GET", "dashboard", headers=bearer(mint(env)), follow_redirects=False)
    assert resp.status_code == 502
    assert "location" not in resp.headers
    assert len(upstream.requests) == 1


def test_non_json_success_is_502(env, upstream):
    upstream.respond = lambda _r: httpx.Response(200, html="<script>alert(1)</script>")
    resp = call("GET", "dashboard", headers=bearer(mint(env)))
    assert resp.status_code == 502
    assert "script" not in resp.text


def test_timeout_is_504(env, upstream):
    def boom(request):
        raise httpx.ReadTimeout("slow", request=request)

    upstream.respond = boom
    resp = call("POST", "heal", headers=bearer(mint(env)), body={"agent": "ecr-healer"})
    assert resp.status_code == 504
    assert resp.json()["error"] == "AGENTS_TIMEOUT"


def test_unreachable_is_502(env, upstream):
    def boom(request):
        raise httpx.ConnectError("refused", request=request)

    upstream.respond = boom
    resp = call("GET", "dashboard", headers=bearer(mint(env)))
    assert resp.status_code == 502
    assert resp.json()["error"] == "AGENTS_UNREACHABLE"


def test_oversized_response_is_502(env, upstream, monkeypatch):
    monkeypatch.setattr(main, "_AGENTS_MAX_RESPONSE_BYTES", 64)
    upstream.respond = lambda _r: httpx.Response(200, json={"pad": "x" * 200})
    resp = call("GET", "costs/metrics-history?hours=24", headers=bearer(mint(env)))
    assert resp.status_code == 502


def test_oversized_streamed_response_is_502(env, upstream, monkeypatch):
    monkeypatch.setattr(main, "_AGENTS_MAX_RESPONSE_BYTES", 64)

    async def chunks():
        for _ in range(10):
            yield b"x" * 16

    upstream.respond = lambda _r: httpx.Response(
        200, headers={"content-type": "application/json"}, content=chunks()
    )
    resp = call("GET", "costs/metrics-history?hours=24", headers=bearer(mint(env)))
    assert resp.status_code == 502


# ---------------------------------------------------------------------------
# audit logging
# ---------------------------------------------------------------------------


def _audit_lines(out: str) -> List[dict]:
    rows = []
    for line in out.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("event") == "agents.proxy":
            rows.append(row)
    return rows


def test_mutating_call_is_audited_without_secrets(env, upstream, capsys):
    caller_jwt = mint(env)
    call("POST", "agents/ecr-healer/start", headers=bearer(caller_jwt))
    out = capsys.readouterr().out
    rows = _audit_lines(out)
    assert len(rows) == 1
    assert rows[0]["method"] == "POST"
    assert rows[0]["path"] == "agents/ecr-healer/start"
    assert rows[0]["status"] == 200
    assert rows[0]["upstream_status"] == 200
    assert rows[0]["outcome"] == "ok"
    assert "reason" not in rows[0]
    assert rows[0]["actor"] == "u-test"
    assert env.service_token not in out
    assert caller_jwt not in out


def test_successful_read_is_not_logged(env, upstream, capsys):
    call("GET", "dashboard", headers=bearer(mint(env)))
    assert _audit_lines(capsys.readouterr().out) == []


def test_failed_read_is_logged_without_secrets(env, upstream, capsys):
    upstream.respond = lambda _r: httpx.Response(500, json={})
    caller_jwt = mint(env)
    call("GET", "dashboard", headers=bearer(caller_jwt))
    out = capsys.readouterr().out
    rows = _audit_lines(out)
    assert [r["outcome"] for r in rows] == ["error"]
    assert env.service_token not in out
    assert caller_jwt not in out


def _one_refusal(out: str, status: int, reason: str) -> dict:
    """The single audit line a refused call must write."""
    rows = _audit_lines(out)
    assert len(rows) == 1, rows
    row = rows[0]
    assert row["outcome"] == "rejected"
    assert row["reason"] == reason
    assert row["status"] == status
    assert row["upstream_status"] is None
    assert row["actor"] == "u-test"
    return row


def test_refusal_reasons_are_a_fixed_set():
    assert main.AGENTS_REJECT_REASONS == {
        "bad_path",
        "not_allowlisted",
        "method_not_allowed",
        "not_configured",
        "body_too_large",
        "unsupported_media_type",
        "invalid_json",
    }


@pytest.mark.parametrize(
    "method,path,kw,status,reason",
    [
        ("GET", "stats", {}, 404, "not_allowlisted"),
        ("POST", "start-all", {}, 404, "not_allowlisted"),
        ("POST", "stop-all", {}, 404, "not_allowlisted"),
        ("POST", "heal/costs", {}, 404, "not_allowlisted"),
        ("POST", "dashboard", {}, 405, "method_not_allowed"),
        ("GET", "heal", {}, 405, "method_not_allowed"),
        (
            "POST",
            "heal",
            {"content": b"agent=ecr-healer", "headers": {"Content-Type": "text/plain"}},
            415,
            "unsupported_media_type",
        ),
        (
            "POST",
            "heal",
            {"content": b"{not json", "headers": {"Content-Type": "application/json"}},
            400,
            "invalid_json",
        ),
        (
            # Deeply nested JSON under the size cap makes json.loads raise
            # RecursionError, which must be refused and audited, not a 500.
            "POST",
            "heal",
            {"content": b"[" * 30000 + b"]" * 30000, "headers": {"Content-Type": "application/json"}},
            400,
            "invalid_json",
        ),
        ("POST", "heal", {"json": {"pad": "x" * (64 * 1024)}}, 413, "body_too_large"),
    ],
)
def test_each_refusal_writes_one_audit_line(env, upstream, capsys, method, path, kw, status, reason):
    kw = dict(kw)
    caller_jwt = mint(env)
    headers = {**bearer(caller_jwt), **kw.pop("headers", {})}
    resp = client.request(method, "/api/agents/" + path, headers=headers, **kw)
    assert resp.status_code == status
    out = capsys.readouterr().out
    row = _one_refusal(out, status, reason)
    assert row["method"] == method
    # This path passed the path rules, so the validated path is logged.
    assert row["path"] == path
    assert upstream.requests == []
    assert env.service_token not in out
    assert caller_jwt not in out


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_not_configured_refusal_is_audited(env, upstream, capsys, monkeypatch, method):
    monkeypatch.delenv("AGENTS_SERVICE_TOKEN", raising=False)
    path = "dashboard" if method == "GET" else "agents/ecr-healer/stop"
    resp = call(method, path, headers=bearer(mint(env)))
    assert resp.status_code == 503
    row = _one_refusal(capsys.readouterr().out, 503, "not_configured")
    assert row["path"] == path
    assert upstream.requests == []


@pytest.mark.parametrize(
    "template",
    [
        "%2e%2e/{m}",
        "agents%2f{m}%2fstatus",
        "%252e%252e/{m}",
        "agents/{m}%5cstatus",
        "{m}/",
        "agents//{m}",
        "agents/{m}@evil.test/status",
        # The route matches up to a trailing newline; the raw-path check
        # refuses it.
        "{m}%0a",
    ],
)
def test_bad_path_refusal_is_audited_without_the_path(env, upstream, capsys, template):
    marker = "zz" + secrets.token_hex(6)
    resp = client.get("/api/agents/" + template.format(m=marker), headers=bearer(mint(env)))
    assert resp.status_code == 400
    out = capsys.readouterr().out
    row = _one_refusal(out, 400, "bad_path")
    assert "path" not in row
    assert marker not in out
    assert upstream.requests == []


def test_forged_log_line_in_path_never_reaches_the_proxy(env, upstream, capsys):
    # A newline inside the path doesn't match the route at all, so a forged
    # JSON line can't be written as an agents.proxy entry.
    marker = "zz" + secrets.token_hex(6)
    forged = "%0a%7B%22audit%22%3Atrue%2C%22event%22%3A%22agents.proxy%22%7D"
    resp = client.get(f"/api/agents/{marker}{forged}", headers=bearer(mint(env)))
    assert resp.status_code == 404
    out = capsys.readouterr().out
    assert _audit_lines(out) == []
    assert marker not in out
    assert upstream.requests == []


def test_literal_dot_refusal_is_audited_without_the_path(env, upstream, capsys):
    marker = "zz" + secrets.token_hex(6)
    status, _ = raw_asgi("POST", f"/api/agents/agents/../{marker}".encode(), bearer(mint(env)))
    assert status == 400
    out = capsys.readouterr().out
    row = _one_refusal(out, 400, "bad_path")
    assert row["method"] == "POST"
    assert "path" not in row
    assert marker not in out
    assert upstream.requests == []


def test_upstream_host_check_refusal_is_audited(env, upstream, capsys, monkeypatch):
    # Not reachable through the path rules; force it to test the last line.
    class OtherHostBase:
        scheme, host, port, path = "http", "agents.test", None, ""

        def copy_with(self, path: str) -> httpx.URL:
            return httpx.URL("http://elsewhere.test" + path)

    monkeypatch.setattr(main, "_agents_base_url", lambda: OtherHostBase())
    resp = call("GET", "dashboard", headers=bearer(mint(env)))
    assert resp.status_code == 400
    row = _one_refusal(capsys.readouterr().out, 400, "bad_path")
    assert "path" not in row
    assert upstream.requests == []


# ---------------------------------------------------------------------------
# CORS — console origins, GET /api/agents/costs[/...] only
# ---------------------------------------------------------------------------


def preflight(path: str, origin: str, method: str = "GET", headers: str = "authorization"):
    h = {"Origin": origin, "Access-Control-Request-Method": method}
    if headers:
        h["Access-Control-Request-Headers"] = headers
    return client.options("/api/agents/" + path, headers=h)


@pytest.mark.parametrize("origin", [CONSOLE, CONSOLE_CONTROL])
@pytest.mark.parametrize("path", ["costs", "costs/summary", "costs/metrics-history"])
def test_console_preflight_for_costs_read_is_allowed(upstream, origin, path):
    resp = preflight(path, origin)
    assert resp.status_code == 204
    assert resp.headers["access-control-allow-origin"] == origin
    assert resp.headers["access-control-allow-methods"] == "GET"
    assert resp.headers["access-control-allow-headers"] == "Authorization"
    assert "access-control-allow-credentials" not in resp.headers
    assert "Origin" in resp.headers["vary"]
    assert upstream.requests == []


@pytest.mark.parametrize(
    "path,origin,method,headers",
    [
        ("costs/summary", "https://evil.test", "GET", "authorization"),
        ("costs/summary", "https://console.clue2.app.evil.test", "GET", "authorization"),
        ("costs/summary", "http://console.clue2.app", "GET", "authorization"),
        ("costs/summary", "https://evilconsole.clue2.app", "GET", "authorization"),
        ("costs/summary", "null", "GET", "authorization"),
        ("costs/summary", CONSOLE, "POST", "authorization"),
        ("costs/summary", CONSOLE, "GET", "authorization, x-custom"),
        ("costs/summary", CONSOLE, "GET", "cookie"),
        ("heal/costs", CONSOLE, "POST", "authorization"),
        ("dashboard", CONSOLE, "GET", "authorization"),
        ("agents/ecr-healer/start", CONSOLE_CONTROL, "POST", "authorization"),
        ("costsx", CONSOLE, "GET", "authorization"),
    ],
)
def test_other_preflights_get_no_cors_grant(upstream, path, origin, method, headers):
    resp = preflight(path, origin, method, headers)
    assert "access-control-allow-origin" not in resp.headers
    assert upstream.requests == []


@pytest.mark.parametrize("origin", [CONSOLE, CONSOLE_CONTROL])
def test_console_costs_read_gets_cors_headers_without_credentials(env, upstream, origin):
    resp = client.get(
        "/api/agents/costs/summary", headers={**bearer(mint(env)), "Origin": origin}
    )
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == origin
    assert "access-control-allow-credentials" not in resp.headers
    assert "origin" in resp.headers["vary"].lower()
    assert "origin" not in upstream.requests[0].headers


def test_console_costs_read_without_token_is_a_readable_401(upstream):
    resp = client.get("/api/agents/costs", headers={"Origin": CONSOLE})
    assert resp.status_code == 401
    assert resp.headers["access-control-allow-origin"] == CONSOLE
    assert upstream.requests == []


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("GET", "dashboard", None),
        ("GET", "agents/ecr-healer/status", None),
        ("POST", "heal/costs", None),
        ("POST", "heal", {"agent": "ecr-healer"}),
        # A non-GET on a costs path gets no grant either (route answers 405).
        ("POST", "costs/summary", None),
        ("POST", "costs", None),
    ],
)
def test_console_origin_gets_no_cors_outside_costs_reads(env, upstream, method, path, body):
    resp = call(method, path, headers={**bearer(mint(env)), "Origin": CONSOLE}, body=body)
    assert "access-control-allow-origin" not in resp.headers


def test_other_origin_gets_no_cors_on_costs_read(env, upstream):
    resp = client.get(
        "/api/agents/costs/summary", headers={**bearer(mint(env)), "Origin": "https://evil.test"}
    )
    assert "access-control-allow-origin" not in resp.headers


def test_local_dev_cors_is_unchanged(upstream):
    origin = f"http://localhost:{main.FRONTEND_PORT}"
    resp = preflight("dashboard", origin)
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == origin
