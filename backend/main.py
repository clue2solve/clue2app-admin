from fastapi import FastAPI, HTTPException, Request, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
import base64
import boto3
import jwt
import json
import subprocess
import os
import threading
import time
from pathlib import Path
from typing import Optional, List, Any, Dict, Tuple

from aws_rates import (
    ABSOLUTE_FALLBACK_HR,
    EC2_MONTHLY_RATES_USD,
    EKS_CONTROL_PLANE_HOURLY,
    FALLBACK_PER_VCPU_HR,
    MONTHLY_HOURS,
    SPOT_MULTIPLIER,
)

# Load configuration from config.json
# Try multiple paths to support both local dev and Docker
config_paths = [
    Path(__file__).parent.parent / "config.json",  # Local dev
    Path(__file__).parent / "config.json",         # Docker (same dir as main.py)
    Path("/app/config.json"),                       # Docker absolute
]
config = None
for config_path in config_paths:
    if config_path.exists():
        with open(config_path) as f:
            config = json.load(f)
        break
if config is None:
    raise FileNotFoundError("config.json not found in any expected location")

BACKEND_PORT = config["ports"]["backend"]
FRONTEND_PORT = config["ports"]["frontend"]
IDENTITY_STORE_ID = config["aws"]["identityStoreId"]
SSO_INSTANCE_ARN = config["aws"]["ssoInstanceArn"]
ACCOUNT_ID = config["aws"]["accountId"]

app = FastAPI(title="AWS Dashboard API", version="1.0.0")


# Pydantic models for request bodies
class CreateUserRequest(BaseModel):
    username: str
    givenName: str
    familyName: str
    email: str
    title: Optional[str] = None
    userType: Optional[str] = None


class AddUserToGroupRequest(BaseModel):
    userId: str
    groupId: str


class RemoveUserFromGroupRequest(BaseModel):
    userId: str
    groupId: str


app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"http://localhost:{FRONTEND_PORT}"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# JWT AUTHENTICATION (SYSTEM users only)
# ============================================================================
#
# HS256 shared-secret JWT minted by the c2a coordinator/auth service. The env
# var C2A_JWT_SECRET is BASE64-encoded (matches the java-jwt Keys.hmacShaKeyFor
# convention on the coordinator side) — it MUST be base64-decoded before being
# passed to PyJWT, otherwise signature verification silently fails.
#
# Enforcement is done via an ASGI HTTP middleware so we don't have to modify
# the body of every existing route. /api/health is exempt (Knative probes).
# ============================================================================

JWT_ALG = "HS256"
_JWT_SECRET_B64 = os.environ.get("C2A_JWT_SECRET", "")
try:
    JWT_SECRET_BYTES = base64.b64decode(_JWT_SECRET_B64) if _JWT_SECRET_B64 else b""
except Exception:
    JWT_SECRET_BYTES = b""

# Endpoints that skip auth entirely. Knative liveness/readiness probes need
# these. Everything else requires a valid SYSTEM-user Bearer token.
AUTH_EXEMPT_PATHS = {"/api/health"}


def _json_error(status: int, error: str, message: str) -> JSONResponse:
    """Consistent error shape matching the coordinator's JwtAuthenticationFilter."""
    return JSONResponse(status_code=status, content={"error": error, "message": message})


def _verify_token(token: str) -> Dict[str, Any]:
    """Decode+verify a JWT. Raises HTTPException on failure."""
    if not JWT_SECRET_BYTES:
        raise HTTPException(status_code=500, detail="C2A_JWT_SECRET not configured")
    try:
        claims = jwt.decode(
            token,
            JWT_SECRET_BYTES,
            algorithms=[JWT_ALG],
            options={
                "require": ["exp", "sub"],
                "verify_signature": True,
                "verify_exp": True,
            },
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="token expired")
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=401, detail=f"invalid token: {e}")
    return claims


def _extract_token(request: Request) -> Optional[str]:
    """Pull the JWT from Authorization: Bearer <t>, falling back to ?token=."""
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth[7:].strip()
    qp = request.query_params.get("token")
    if qp:
        return qp.strip()
    return None


@app.middleware("http")
async def jwt_auth_middleware(request: Request, call_next):
    """Enforce SYSTEM-user JWT on every /api/* endpoint except AUTH_EXEMPT_PATHS.
    Non-/api/ routes (static SPA files) pass through untouched."""
    path = request.url.path

    # Only guard /api/* routes. Static SPA files are public.
    if not path.startswith("/api/"):
        return await call_next(request)

    # CORS preflight — let the CORS middleware handle it.
    if request.method == "OPTIONS":
        return await call_next(request)

    if path in AUTH_EXEMPT_PATHS:
        return await call_next(request)

    token = _extract_token(request)
    if not token:
        return _json_error(401, "UNAUTHORIZED", "missing bearer token")

    try:
        claims = _verify_token(token)
    except HTTPException as e:
        code = "UNAUTHORIZED" if e.status_code == 401 else "SERVER_ERROR"
        return _json_error(e.status_code, code, str(e.detail))

    if claims.get("userType") != "SYSTEM":
        return _json_error(403, "FORBIDDEN", "SYSTEM users only")

    # Stash claims on request state for any downstream handler that wants them.
    request.state.jwt_claims = claims
    return await call_next(request)


def require_system_user(request: Request) -> Dict[str, Any]:
    """FastAPI dependency form of the same check.

    The HTTP middleware above already enforces auth cluster-wide, but exposing
    this dependency lets new endpoints (the cost endpoints below) declare their
    auth requirement explicitly at the route level for clarity/testability."""
    token = _extract_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="missing bearer token")
    claims = _verify_token(token)
    if claims.get("userType") != "SYSTEM":
        raise HTTPException(status_code=403, detail="SYSTEM users only")
    return claims


# ============================================================================
# COST EXPLORER ENDPOINTS
# ============================================================================
#
# All responses are shaped to the design contract in the accompanying design
# doc: USD, 2-decimal rounding, ISO-8601 dates, `generated_at` UTC timestamp.
# Cost Explorer is us-east-1 only and each call costs $0.01 — we cache every
# response in-memory for 15 minutes.
# ============================================================================

_CE_CACHE_TTL_SECONDS = 15 * 60
_ce_cache: Dict[str, Tuple[float, Any]] = {}
_ce_cache_lock = threading.Lock()


def _ce_client():
    return boto3.client("ce", region_name="us-east-1")


def _cache_get(key: str) -> Optional[Any]:
    with _ce_cache_lock:
        entry = _ce_cache.get(key)
        if entry is None:
            return None
        ts, value = entry
        if time.time() - ts > _CE_CACHE_TTL_SECONDS:
            _ce_cache.pop(key, None)
            return None
        return value


def _cache_put(key: str, value: Any) -> None:
    with _ce_cache_lock:
        _ce_cache[key] = (time.time(), value)


def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _month_start(dt) -> str:
    return dt.strftime("%Y-%m-01")


def _ce_error_response(exc: Exception) -> JSONResponse:
    return _json_error(502, "COST_EXPLORER_ERROR", str(exc))


@app.get("/api/costs/summary")
def costs_summary(_: Dict[str, Any] = Depends(require_system_user)):
    """Hero-card summary: MTD vs previous-month-to-date."""
    from datetime import date, timedelta

    cache_key = "summary"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    today = date.today()
    mtd_start = today.replace(day=1)
    # CE End is exclusive. For the current month we ask for [1st, today], and
    # if today IS the 1st we widen by a day so CE has a non-empty window.
    mtd_query_end = today if today > mtd_start else mtd_start + timedelta(days=1)

    # Previous full month
    if mtd_start.month == 1:
        prev_month_start = mtd_start.replace(year=mtd_start.year - 1, month=12, day=1)
    else:
        prev_month_start = mtd_start.replace(month=mtd_start.month - 1, day=1)
    prev_month_end = mtd_start  # exclusive — day 1 of current month

    # Previous month-to-date (same day-of-month window as current MTD)
    day_offset = (today - mtd_start).days
    prev_mtd_start = prev_month_start
    prev_mtd_end = prev_month_start + timedelta(days=day_offset) if day_offset > 0 else prev_month_start

    ce = _ce_client()

    def _total(start, end):
        if start >= end:
            return 0.0
        resp = ce.get_cost_and_usage(
            TimePeriod={"Start": start.isoformat(), "End": end.isoformat()},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
        )
        total = 0.0
        for r in resp.get("ResultsByTime", []):
            total += float(r.get("Total", {}).get("UnblendedCost", {}).get("Amount", 0))
        return total

    try:
        mtd_cost = _total(mtd_start, mtd_query_end)
        prev_month_cost = _total(prev_month_start, prev_month_end)
        prev_mtd_cost = _total(prev_mtd_start, prev_mtd_end) if prev_mtd_end > prev_mtd_start else 0.0
    except Exception as e:
        return _ce_error_response(e)

    if prev_mtd_cost == 0:
        delta_pct = None
    else:
        delta_pct = round((mtd_cost - prev_mtd_cost) / prev_mtd_cost * 100, 2)

    result = {
        "currency": "USD",
        "mtd": {
            "start": mtd_start.isoformat(),
            "end": today.isoformat(),
            "cost": round(mtd_cost, 2),
        },
        "previous_month": {
            "start": prev_month_start.isoformat(),
            "end": (prev_month_end - timedelta(days=1)).isoformat(),
            "cost": round(prev_month_cost, 2),
        },
        "previous_month_to_date": {
            "start": prev_mtd_start.isoformat(),
            "end": prev_mtd_end.isoformat(),
            "cost": round(prev_mtd_cost, 2),
            "note": "same day-of-month window as mtd, for fair comparison",
        },
        "delta_pct": delta_pct,
        "delta_pct_basis": "mtd_vs_previous_month_to_date",
        "generated_at": _iso_now(),
    }
    _cache_put(cache_key, result)
    return result


@app.get("/api/costs/by-service")
def costs_by_service(
    months: int = Query(1, ge=1, le=12),
    _: Dict[str, Any] = Depends(require_system_user),
):
    """Cost broken down by AWS service over the trailing `months` months."""
    from datetime import date, timedelta

    cache_key = f"by-service:{months}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    end = date.today()
    # Approximate month arithmetic — trailing N*30 days is close enough for
    # CE's own MONTHLY buckets and matches how the frontend labels the range.
    start = end - timedelta(days=months * 30)

    ce = _ce_client()
    try:
        resp = ce.get_cost_and_usage(
            TimePeriod={"Start": start.isoformat(), "End": end.isoformat()},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
    except Exception as e:
        return _ce_error_response(e)

    # Aggregate across the time buckets CE returns
    totals: Dict[str, float] = {}
    for bucket in resp.get("ResultsByTime", []):
        for group in bucket.get("Groups", []):
            name = group["Keys"][0]
            amt = float(group["Metrics"]["UnblendedCost"]["Amount"])
            totals[name] = totals.get(name, 0.0) + amt

    total_all = sum(totals.values())
    services = []
    for name, cost in sorted(totals.items(), key=lambda kv: kv[1], reverse=True):
        pct = round((cost / total_all * 100), 2) if total_all > 0 else 0.0
        services.append({
            "service": name,
            "cost": round(cost, 2),
            "pct_of_total": pct,
        })

    result = {
        "currency": "USD",
        "period": {"start": start.isoformat(), "end": end.isoformat()},
        "total": round(total_all, 2),
        "services": services,
        "generated_at": _iso_now(),
    }
    _cache_put(cache_key, result)
    return result


@app.get("/api/costs/historical")
def costs_historical(
    months: int = Query(6, ge=1, le=24),
    _: Dict[str, Any] = Depends(require_system_user),
):
    """Trailing-N-month monthly cost series."""
    from datetime import date

    cache_key = f"historical:{months}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    today = date.today()

    # Compute the first-of-month `months-1` months ago.
    y, m = today.year, today.month
    back = months - 1
    for _i in range(back):
        if m == 1:
            m = 12
            y -= 1
        else:
            m -= 1
    start = date(y, m, 1)
    # CE End is exclusive; using today covers the current (partial) month.
    end = today

    ce = _ce_client()
    try:
        resp = ce.get_cost_and_usage(
            TimePeriod={"Start": start.isoformat(), "End": end.isoformat()},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
        )
    except Exception as e:
        return _ce_error_response(e)

    by_month: Dict[str, float] = {}
    for bucket in resp.get("ResultsByTime", []):
        period_start = bucket.get("TimePeriod", {}).get("Start")
        if period_start:
            by_month[period_start] = float(
                bucket.get("Total", {}).get("UnblendedCost", {}).get("Amount", 0)
            )

    # Walk month-by-month from `start` to `today`, emitting 0.0 for gaps.
    series = []
    cy, cm = start.year, start.month
    while (cy, cm) <= (today.year, today.month):
        key = date(cy, cm, 1).isoformat()
        series.append({"date": key, "cost": round(by_month.get(key, 0.0), 2)})
        if cm == 12:
            cm = 1
            cy += 1
        else:
            cm += 1

    result = {
        "currency": "USD",
        "granularity": "MONTHLY",
        "series": series,
        "generated_at": _iso_now(),
    }
    _cache_put(cache_key, result)
    return result


@app.get("/api/costs/top-resources")
def costs_top_resources(
    days: int = Query(14, ge=1, le=14),
    limit: int = Query(20, ge=1, le=100),
    _: Dict[str, Any] = Depends(require_system_user),
):
    """Top-N cost-driving resources over the trailing `days` days.
    AWS CE requires DAILY granularity + 14-day hard cap when
    GroupBy=RESOURCE_ID; misleading error says 'hourly'.

    Uses CE's RESOURCE_ID dimension. Note: enabling resource-level CE data
    requires opt-in in the AWS account; if the account hasn't opted in, CE
    returns an error which we surface as 502 COST_EXPLORER_ERROR."""
    from datetime import date, timedelta

    cache_key = f"top-resources:{days}:{limit}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    end = date.today()
    start = end - timedelta(days=days)

    ce = _ce_client()
    try:
        resp = ce.get_cost_and_usage_with_resources(
            TimePeriod={"Start": start.isoformat(), "End": end.isoformat()},
            Granularity="DAILY",
            Metrics=["UnblendedCost"],
            GroupBy=[
                {"Type": "DIMENSION", "Key": "SERVICE"},
                {"Type": "DIMENSION", "Key": "RESOURCE_ID"},
            ],
            Filter={
                "Not": {
                    "Dimensions": {
                        "Key": "RECORD_TYPE",
                        "Values": ["Credit", "Refund"],
                    }
                }
            },
        )
    except Exception as e:
        # Resource-level CE data requires an explicit opt-in in the
        # payer account's Cost Explorer Settings. Detect that specific
        # AccessDeniedException and return a 200 with a structured
        # opt-in-needed payload — the frontend renders a helpful empty
        # state with a link to AWS settings rather than a scary 502.
        msg = str(e)
        if "Resource-level data granularity is an opt-in" in msg or (
            "AccessDeniedException" in msg and "opt-in" in msg
        ):
            payload = {
                "resources": [],
                "resourceLevelEnabled": False,
                "message": (
                    "Resource-level Cost Explorer data is not enabled on this AWS account. "
                    "Enable it in the payer account's Billing → Cost Explorer → Preferences. "
                    "Data starts populating within ~24 hours; history is not backfilled."
                ),
                "helpUrl": "https://console.aws.amazon.com/cost-management/home#/settings",
                "days": days,
                "limit": limit,
            }
            _cache_put(cache_key, payload)
            return payload
        return _ce_error_response(e)

    # Aggregate cost per (resource_id, service) across time buckets
    agg: Dict[Tuple[str, str], float] = {}
    for bucket in resp.get("ResultsByTime", []):
        for group in bucket.get("Groups", []):
            keys = group.get("Keys", [])
            # GroupBy order: SERVICE first, RESOURCE_ID second
            service = keys[0] if len(keys) > 0 else ""
            resource_id = keys[1] if len(keys) > 1 else ""
            if not resource_id or resource_id == "NoResourceId":
                continue
            amt = float(group["Metrics"]["UnblendedCost"]["Amount"])
            agg[(resource_id, service)] = agg.get((resource_id, service), 0.0) + amt

    ranked = sorted(agg.items(), key=lambda kv: kv[1], reverse=True)[:limit]

    resources = []
    for (resource_id, service), cost in ranked:
        # CE doesn't return tags in the groups response — we intentionally
        # leave `tags` empty rather than paying for a second CE call per row.
        resources.append({
            "resource_id": resource_id,
            "service": service,
            "cost": round(cost, 2),
            "tags": {},
        })

    result = {
        "currency": "USD",
        "period": {"start": start.isoformat(), "end": end.isoformat()},
        "total_resources_reported": len(resources),
        "resources": resources,
        "generated_at": _iso_now(),
    }
    _cache_put(cache_key, result)
    return result


def get_boto_clients():
    return {
        # Cost Explorer is us-east-1 only — pinned in code so the legacy
        # /api/services endpoint doesn't silently 400 if AWS_REGION is
        # overridden away from us-east-1.
        "ce": boto3.client("ce", region_name="us-east-1"),
        "identitystore": boto3.client("identitystore"),
        "sso_admin": boto3.client("sso-admin"),
        "resourcegroupstaggingapi": boto3.client("resourcegroupstaggingapi"),
        "eks": boto3.client("eks"),
        "ec2": boto3.client("ec2"),
    }


@app.get("/api/health")
def health_check():
    return {"status": "healthy"}


@app.get("/api/services")
def get_services():
    """Get all AWS services in use with costs and resource counts."""
    clients = get_boto_clients()

    # Get services by cost
    from datetime import datetime, timedelta
    end_date = datetime.now().strftime("%Y-%m-%d")
    start_date = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")

    try:
        cost_response = clients["ce"].get_cost_and_usage(
            TimePeriod={"Start": start_date, "End": end_date},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )

        services = []
        for group in cost_response.get("ResultsByTime", [{}])[0].get("Groups", []):
            service_name = group["Keys"][0]
            cost = float(group["Metrics"]["UnblendedCost"]["Amount"])
            if cost > 0:
                services.append({
                    "name": service_name,
                    "cost": round(cost, 2),
                    "status": "active"
                })

        # Sort by cost descending
        services.sort(key=lambda x: x["cost"], reverse=True)
        return {"services": services}
    except Exception as e:
        return {"services": [], "error": str(e)}


@app.get("/api/resources")
def get_resources():
    """Get resource counts by service type."""
    clients = get_boto_clients()

    try:
        response = clients["resourcegroupstaggingapi"].get_resources()
        resource_counts = {}

        for resource in response.get("ResourceTagMappingList", []):
            arn = resource["ResourceARN"]
            # Extract service from ARN: arn:aws:SERVICE:...
            parts = arn.split(":")
            if len(parts) >= 3:
                service = parts[2]
                resource_counts[service] = resource_counts.get(service, 0) + 1

        resources = [
            {"service": k, "count": v}
            for k, v in sorted(resource_counts.items(), key=lambda x: -x[1])
        ]
        return {"resources": resources}
    except Exception as e:
        return {"resources": [], "error": str(e)}


# ============================================================================
# EC2 HELPERS — cluster membership, use hints, monthly cost estimate
# ============================================================================

# Cache for describe_instance_types vCPU lookups (per process).
_VCPU_CACHE: Dict[str, int] = {}


def _detect_parent_cluster(tags: Dict[str, str]) -> Tuple[Optional[str], Optional[str], List[str]]:
    """
    Inspect instance tags for EKS/self-managed cluster membership.

    Detection precedence:
      1. `aws:eks:cluster-name`  (authoritative — managed nodegroup)
      2. `eks:cluster-name`      (older managed convention)
      3. `kubernetes.io/cluster/<X>` == "owned"  (self-managed or older kOps)

    Returns:
        (parent_cluster, node_role_hint, conflicts)
        - parent_cluster: cluster name, or None if no membership tags
        - node_role_hint: `eks:nodegroup-name` value if present; "self-managed"
          if only pattern (3) matched; None otherwise
        - conflicts: list of distinct cluster names seen across all matched
          patterns (empty if consistent). The UI can surface this without
          the endpoint failing.
    """
    if not tags:
        return None, None, []

    candidates: List[str] = []
    # Pattern (1) — managed nodegroup (authoritative)
    managed = tags.get("aws:eks:cluster-name")
    if managed:
        candidates.append(managed)
    # Pattern (2) — older managed convention
    legacy_managed = tags.get("eks:cluster-name")
    if legacy_managed and legacy_managed not in candidates:
        candidates.append(legacy_managed)
    # Pattern (3) — kubernetes.io/cluster/<X>=owned
    self_managed_names: List[str] = []
    for key, value in tags.items():
        if key.startswith("kubernetes.io/cluster/") and value == "owned":
            name = key[len("kubernetes.io/cluster/"):]
            if name:
                self_managed_names.append(name)
    for name in self_managed_names:
        if name not in candidates:
            candidates.append(name)

    if not candidates:
        return None, None, []

    parent_cluster = candidates[0]
    node_role_hint = tags.get("eks:nodegroup-name")
    if not node_role_hint and managed is None and legacy_managed is None:
        # Only pattern (3) matched — self-managed
        node_role_hint = "self-managed"

    conflicts = candidates if len(candidates) > 1 else []
    return parent_cluster, node_role_hint, conflicts


def _extract_use_hints(tags: Dict[str, str], iam_instance_profile_arn: Optional[str]) -> Dict[str, Optional[str]]:
    """
    Distill best-guess identification from tags + IAM profile for the UI.

    Populated for ALL instances (cluster nodes get name/env/owner chips too;
    orphans lean on env/owner/c2a_project/iam_profile).

    c2a tag keys support two conventions: dash (`c2a-account`) and colon
    (`c2a:account`). When both are present, prefer the colon form (newer
    per platform memory).
    """
    if not tags:
        tags = {}

    def _first(*keys: str) -> Optional[str]:
        for k in keys:
            v = tags.get(k)
            if v:
                return v
        return None

    iam_profile: Optional[str] = None
    if iam_instance_profile_arn:
        # Arn shape: arn:aws:iam::<acct>:instance-profile/<NAME>
        iam_profile = iam_instance_profile_arn.rsplit("/", 1)[-1] or None

    return {
        "name": tags.get("Name"),
        "environment": _first("Environment", "environment", "env", "Env"),
        "owner": _first("Owner", "owner"),
        # Colon form preferred (newer convention)
        "c2a_account": _first("c2a:account", "c2a-account"),
        "c2a_project": _first("c2a:project", "c2a-project"),
        "iam_profile": iam_profile,
    }


def _instance_type_vcpu(instance_type: str) -> Optional[int]:
    """Return vCPU count for an instance type, cached per process. None on failure."""
    if instance_type in _VCPU_CACHE:
        return _VCPU_CACHE[instance_type]
    try:
        ec2 = boto3.client("ec2")
        resp = ec2.describe_instance_types(InstanceTypes=[instance_type])
        infos = resp.get("InstanceTypes") or []
        if not infos:
            return None
        vcpu = infos[0].get("VCpuInfo", {}).get("DefaultVCpus")
        if isinstance(vcpu, int) and vcpu > 0:
            _VCPU_CACHE[instance_type] = vcpu
            return vcpu
    except Exception:
        pass
    return None


def _estimate_monthly(
    instance_type: Optional[str],
    state: str = "running",
    lifecycle: Optional[str] = None,
) -> Tuple[float, float, bool]:
    """
    Estimate hourly + monthly USD cost for an instance.

    Returns:
        (hourly, monthly, estimated)
        - hourly: rate applied (post spot-multiplier if lifecycle == 'spot')
        - monthly: hourly * MONTHLY_HOURS, or 0.0 if state != 'running'
        - estimated: True if a fallback path was used (unknown type, spot,
          or absolute floor)
    """
    if not instance_type:
        return 0.0, 0.0, True

    estimated = False
    base_hourly = EC2_MONTHLY_RATES_USD.get(instance_type)

    if base_hourly is None:
        estimated = True
        vcpu = _instance_type_vcpu(instance_type)
        if vcpu:
            base_hourly = vcpu * FALLBACK_PER_VCPU_HR
        else:
            base_hourly = ABSOLUTE_FALLBACK_HR

    hourly = base_hourly
    if lifecycle == "spot":
        hourly = base_hourly * SPOT_MULTIPLIER
        estimated = True

    # Stopped/terminated instances contribute $0/mo to steady-state cost.
    monthly = hourly * MONTHLY_HOURS if state == "running" else 0.0
    return round(hourly, 6), round(monthly, 2), estimated


# ============================================================================
# EC2 ENDPOINTS
# ============================================================================

@app.get("/api/ec2/instances")
def get_ec2_instances(
    group_by: Optional[str] = Query(None, description="Set to 'cluster' for pre-bucketed response"),
):
    """
    Get all EC2 instances with details.

    Enriches each instance with:
      - parent_cluster:   parent EKS cluster (if any) detected from Tags
      - node_role_hint:   nodegroup name (managed) or "self-managed"
      - use_hints:        {name, environment, owner, c2a_account, c2a_project, iam_profile}
      - monthly_estimate: {hourly, monthly, estimated}
      - parent_cluster_conflict: list of cluster names if the instance carries
        conflicting membership tags (rare — a warning, not an error)

    When `group_by=cluster` is passed, response uses the {groups: [...]}
    shape (cluster buckets + an __orphans__ bucket) so the ComputeTab can
    render section headers without re-grouping client-side.
    """
    clients = get_boto_clients()

    try:
        response = clients["ec2"].describe_instances()
        instances: List[Dict[str, Any]] = []
        cluster_summary: Dict[str, Dict[str, Any]] = {}
        orphan_count = 0

        for reservation in response.get("Reservations", []):
            for instance in reservation.get("Instances", []):
                tags_map: Dict[str, str] = {t["Key"]: t["Value"] for t in instance.get("Tags", [])}
                name = tags_map.get("Name", "")

                # Calculate uptime
                launch_time = instance.get("LaunchTime")
                uptime = ""
                if launch_time:
                    from datetime import datetime, timezone
                    now = datetime.now(timezone.utc)
                    delta = now - launch_time
                    days = delta.days
                    hours = delta.seconds // 3600
                    if days > 0:
                        uptime = f"{days}d {hours}h"
                    else:
                        uptime = f"{hours}h"

                state = instance.get("State", {}).get("Name", "unknown")
                instance_type = instance.get("InstanceType")
                lifecycle = instance.get("InstanceLifecycle")  # 'spot' | 'scheduled' | None
                iam_arn = (instance.get("IamInstanceProfile") or {}).get("Arn")

                parent_cluster, node_role_hint, conflicts = _detect_parent_cluster(tags_map)
                use_hints = _extract_use_hints(tags_map, iam_arn)
                hourly, monthly, estimated = _estimate_monthly(instance_type, state, lifecycle)

                item: Dict[str, Any] = {
                    "instanceId": instance.get("InstanceId"),
                    "name": name,
                    "state": state,
                    "instanceType": instance_type,
                    "privateIp": instance.get("PrivateIpAddress"),
                    "publicIp": instance.get("PublicIpAddress"),
                    "launchTime": str(launch_time) if launch_time else None,
                    "uptime": uptime,
                    "availabilityZone": instance.get("Placement", {}).get("AvailabilityZone"),
                    "vpcId": instance.get("VpcId"),
                    "subnetId": instance.get("SubnetId"),
                    "platform": instance.get("PlatformDetails", "Linux/UNIX"),
                    "architecture": instance.get("Architecture"),
                    "tags": tags_map,
                    "parent_cluster": parent_cluster,
                    "node_role_hint": node_role_hint,
                    "use_hints": use_hints,
                    "lifecycle": lifecycle,  # 'spot' | 'scheduled' | None
                    "monthly_estimate": {
                        "hourly": hourly,
                        "monthly": monthly,
                        "estimated": estimated,
                    },
                }
                if conflicts:
                    item["parent_cluster_conflict"] = conflicts

                if parent_cluster:
                    summary = cluster_summary.setdefault(
                        parent_cluster, {"nodeCount": 0, "instanceTypes": {}}
                    )
                    summary["nodeCount"] += 1
                    if instance_type:
                        summary["instanceTypes"][instance_type] = (
                            summary["instanceTypes"].get(instance_type, 0) + 1
                        )
                else:
                    orphan_count += 1

                instances.append(item)

        # Sort by name (running first)
        instances.sort(key=lambda x: (x["state"] != "running", (x["name"] or "").lower()))

        if group_by == "cluster":
            # Two buckets: one per cluster + __orphans__
            groups_by_key: Dict[str, Dict[str, Any]] = {}
            orphans: List[Dict[str, Any]] = []
            for inst in instances:
                pc = inst.get("parent_cluster")
                if pc:
                    bucket = groups_by_key.setdefault(
                        pc,
                        {"key": pc, "kind": "cluster", "clusterName": pc, "instances": []},
                    )
                    bucket["instances"].append(inst)
                else:
                    orphans.append(inst)
            groups: List[Dict[str, Any]] = sorted(groups_by_key.values(), key=lambda g: g["clusterName"])
            groups.append({"key": "__orphans__", "kind": "orphans", "instances": orphans})
            return {
                "groups": groups,
                "clusterSummary": cluster_summary,
                "orphanCount": orphan_count,
            }

        return {
            "instances": instances,
            "clusterSummary": cluster_summary,
            "orphanCount": orphan_count,
        }
    except Exception as e:
        return {"instances": [], "error": str(e)}


@app.get("/api/ec2/instances/{instance_id}")
def get_ec2_instance_details(instance_id: str):
    """Get detailed information about a specific EC2 instance."""
    clients = get_boto_clients()

    try:
        response = clients["ec2"].describe_instances(InstanceIds=[instance_id])
        if not response.get("Reservations"):
            raise HTTPException(status_code=404, detail="Instance not found")

        instance = response["Reservations"][0]["Instances"][0]

        # Get security groups details
        security_groups = []
        for sg in instance.get("SecurityGroups", []):
            sg_response = clients["ec2"].describe_security_groups(GroupIds=[sg["GroupId"]])
            if sg_response.get("SecurityGroups"):
                sg_details = sg_response["SecurityGroups"][0]
                security_groups.append({
                    "groupId": sg_details.get("GroupId"),
                    "groupName": sg_details.get("GroupName"),
                    "inboundRules": len(sg_details.get("IpPermissions", [])),
                    "outboundRules": len(sg_details.get("IpPermissionsEgress", [])),
                })

        # Get volumes
        volumes = []
        for mapping in instance.get("BlockDeviceMappings", []):
            ebs = mapping.get("Ebs", {})
            if ebs.get("VolumeId"):
                vol_response = clients["ec2"].describe_volumes(VolumeIds=[ebs["VolumeId"]])
                if vol_response.get("Volumes"):
                    vol = vol_response["Volumes"][0]
                    volumes.append({
                        "volumeId": vol.get("VolumeId"),
                        "deviceName": mapping.get("DeviceName"),
                        "size": vol.get("Size"),
                        "volumeType": vol.get("VolumeType"),
                        "iops": vol.get("Iops"),
                        "encrypted": vol.get("Encrypted"),
                    })

        name = ""
        for tag in instance.get("Tags", []):
            if tag["Key"] == "Name":
                name = tag["Value"]
                break

        return {
            "instanceId": instance.get("InstanceId"),
            "name": name,
            "state": instance.get("State", {}).get("Name"),
            "instanceType": instance.get("InstanceType"),
            "privateIp": instance.get("PrivateIpAddress"),
            "publicIp": instance.get("PublicIpAddress"),
            "launchTime": str(instance.get("LaunchTime")),
            "availabilityZone": instance.get("Placement", {}).get("AvailabilityZone"),
            "vpcId": instance.get("VpcId"),
            "subnetId": instance.get("SubnetId"),
            "platform": instance.get("PlatformDetails"),
            "architecture": instance.get("Architecture"),
            "amiId": instance.get("ImageId"),
            "keyName": instance.get("KeyName"),
            "iamRole": instance.get("IamInstanceProfile", {}).get("Arn"),
            "securityGroups": security_groups,
            "volumes": volumes,
            "tags": {t["Key"]: t["Value"] for t in instance.get("Tags", [])},
            "monitoring": instance.get("Monitoring", {}).get("State"),
            "cpuOptions": instance.get("CpuOptions"),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/ec2/instances/{instance_id}/start")
def start_ec2_instance(instance_id: str):
    """Start an EC2 instance."""
    clients = get_boto_clients()

    try:
        response = clients["ec2"].start_instances(InstanceIds=[instance_id])
        return {
            "success": True,
            "instanceId": instance_id,
            "previousState": response["StartingInstances"][0]["PreviousState"]["Name"],
            "currentState": response["StartingInstances"][0]["CurrentState"]["Name"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/ec2/instances/{instance_id}/stop")
def stop_ec2_instance(instance_id: str):
    """Stop an EC2 instance."""
    clients = get_boto_clients()

    try:
        response = clients["ec2"].stop_instances(InstanceIds=[instance_id])
        return {
            "success": True,
            "instanceId": instance_id,
            "previousState": response["StoppingInstances"][0]["PreviousState"]["Name"],
            "currentState": response["StoppingInstances"][0]["CurrentState"]["Name"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/ec2/instances/{instance_id}/reboot")
def reboot_ec2_instance(instance_id: str):
    """Reboot an EC2 instance."""
    clients = get_boto_clients()

    try:
        clients["ec2"].reboot_instances(InstanceIds=[instance_id])
        return {
            "success": True,
            "instanceId": instance_id,
            "message": "Reboot initiated",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/ec2/summary")
def get_ec2_summary():
    """Get EC2 summary statistics."""
    clients = get_boto_clients()

    try:
        response = clients["ec2"].describe_instances()

        summary = {
            "total": 0,
            "running": 0,
            "stopped": 0,
            "pending": 0,
            "terminated": 0,
            "byType": {},
            "byAz": {},
        }

        for reservation in response.get("Reservations", []):
            for instance in reservation.get("Instances", []):
                state = instance.get("State", {}).get("Name", "unknown")
                instance_type = instance.get("InstanceType", "unknown")
                az = instance.get("Placement", {}).get("AvailabilityZone", "unknown")

                summary["total"] += 1
                if state == "running":
                    summary["running"] += 1
                elif state == "stopped":
                    summary["stopped"] += 1
                elif state == "pending":
                    summary["pending"] += 1
                elif state == "terminated":
                    summary["terminated"] += 1

                summary["byType"][instance_type] = summary["byType"].get(instance_type, 0) + 1
                summary["byAz"][az] = summary["byAz"].get(az, 0) + 1

        return summary
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/ec2/orphans")
def get_ec2_orphans(
    include_stopped: bool = Query(False, description="Include stopped instances"),
):
    """
    Instances NOT part of any EKS/self-managed cluster.

    Same instance shape as /api/ec2/instances. Pre-filtered so the
    ComputeTab \"Not in a cluster\" section can lazy-load if the operator has
    hundreds of nodes. `include_stopped` defaults to False — stopped orphans
    are rarely interesting for cost identification.
    """
    clients = get_boto_clients()

    try:
        response = clients["ec2"].describe_instances()
        orphans: List[Dict[str, Any]] = []

        for reservation in response.get("Reservations", []):
            for instance in reservation.get("Instances", []):
                tags_map: Dict[str, str] = {t["Key"]: t["Value"] for t in instance.get("Tags", [])}
                parent_cluster, _node_role_hint, _conflicts = _detect_parent_cluster(tags_map)
                if parent_cluster is not None:
                    continue

                state = instance.get("State", {}).get("Name", "unknown")
                if state != "running" and not include_stopped:
                    continue

                launch_time = instance.get("LaunchTime")
                uptime = ""
                if launch_time:
                    from datetime import datetime, timezone
                    now = datetime.now(timezone.utc)
                    delta = now - launch_time
                    days = delta.days
                    hours = delta.seconds // 3600
                    uptime = f"{days}d {hours}h" if days > 0 else f"{hours}h"

                instance_type = instance.get("InstanceType")
                lifecycle = instance.get("InstanceLifecycle")
                iam_arn = (instance.get("IamInstanceProfile") or {}).get("Arn")
                use_hints = _extract_use_hints(tags_map, iam_arn)
                hourly, monthly, estimated = _estimate_monthly(instance_type, state, lifecycle)

                orphans.append({
                    "instanceId": instance.get("InstanceId"),
                    "name": tags_map.get("Name", ""),
                    "state": state,
                    "instanceType": instance_type,
                    "privateIp": instance.get("PrivateIpAddress"),
                    "publicIp": instance.get("PublicIpAddress"),
                    "launchTime": str(launch_time) if launch_time else None,
                    "uptime": uptime,
                    "availabilityZone": instance.get("Placement", {}).get("AvailabilityZone"),
                    "vpcId": instance.get("VpcId"),
                    "subnetId": instance.get("SubnetId"),
                    "platform": instance.get("PlatformDetails", "Linux/UNIX"),
                    "architecture": instance.get("Architecture"),
                    "tags": tags_map,
                    "parent_cluster": None,
                    "node_role_hint": None,
                    "use_hints": use_hints,
                    "lifecycle": lifecycle,
                    "monthly_estimate": {
                        "hourly": hourly,
                        "monthly": monthly,
                        "estimated": estimated,
                    },
                })

        orphans.sort(key=lambda x: (x["state"] != "running", (x["name"] or "").lower()))
        return {"instances": orphans, "count": len(orphans)}
    except Exception as e:
        return {"instances": [], "count": 0, "error": str(e)}


@app.get("/api/users")
def get_users():
    """Get all IAM Identity Center users."""
    clients = get_boto_clients()

    try:
        response = clients["identitystore"].list_users(IdentityStoreId=IDENTITY_STORE_ID)
        users = []

        for user in response.get("Users", []):
            emails = user.get("Emails", [])
            primary_email = next((e["Value"] for e in emails if e.get("Primary")), None)

            users.append({
                "id": user["UserId"],
                "username": user["UserName"],
                "displayName": user.get("DisplayName", ""),
                "givenName": user.get("Name", {}).get("GivenName", ""),
                "familyName": user.get("Name", {}).get("FamilyName", ""),
                "email": primary_email,
                "title": user.get("Title", ""),
                "userType": user.get("UserType", ""),
            })

        return {"users": users}
    except Exception as e:
        return {"users": [], "error": str(e)}


@app.get("/api/groups")
def get_groups():
    """Get all IAM Identity Center groups with their members."""
    clients = get_boto_clients()

    try:
        groups_response = clients["identitystore"].list_groups(IdentityStoreId=IDENTITY_STORE_ID)
        groups = []

        for group in groups_response.get("Groups", []):
            group_id = group["GroupId"]

            # Get group members
            members_response = clients["identitystore"].list_group_memberships(
                IdentityStoreId=IDENTITY_STORE_ID,
                GroupId=group_id
            )

            member_ids = [
                m["MemberId"]["UserId"]
                for m in members_response.get("GroupMemberships", [])
            ]

            # Get member details
            members = []
            for user_id in member_ids:
                try:
                    user = clients["identitystore"].describe_user(
                        IdentityStoreId=IDENTITY_STORE_ID,
                        UserId=user_id
                    )
                    members.append({
                        "id": user_id,
                        "username": user["UserName"],
                        "displayName": user.get("DisplayName", "")
                    })
                except:
                    pass

            groups.append({
                "id": group_id,
                "name": group["DisplayName"],
                "description": group.get("Description", ""),
                "memberCount": len(members),
                "members": members
            })

        return {"groups": groups}
    except Exception as e:
        return {"groups": [], "error": str(e)}


@app.get("/api/permission-sets")
def get_permission_sets():
    """Get all permission sets."""
    clients = get_boto_clients()

    try:
        ps_response = clients["sso_admin"].list_permission_sets(InstanceArn=SSO_INSTANCE_ARN)
        permission_sets = []

        for ps_arn in ps_response.get("PermissionSets", []):
            ps_details = clients["sso_admin"].describe_permission_set(
                InstanceArn=SSO_INSTANCE_ARN,
                PermissionSetArn=ps_arn
            )
            ps = ps_details["PermissionSet"]

            # Get attached policies
            try:
                policies_response = clients["sso_admin"].list_managed_policies_in_permission_set(
                    InstanceArn=SSO_INSTANCE_ARN,
                    PermissionSetArn=ps_arn
                )
                policies = [p["Name"] for p in policies_response.get("AttachedManagedPolicies", [])]
            except:
                policies = []

            permission_sets.append({
                "arn": ps_arn,
                "name": ps["Name"],
                "description": ps.get("Description", ""),
                "sessionDuration": ps.get("SessionDuration", ""),
                "policies": policies
            })

        return {"permissionSets": permission_sets}
    except Exception as e:
        return {"permissionSets": [], "error": str(e)}


@app.get("/api/account-assignments")
def get_account_assignments():
    """Get which groups have which permission sets."""
    clients = get_boto_clients()

    try:
        # Get all permission sets
        ps_response = clients["sso_admin"].list_permission_sets(InstanceArn=SSO_INSTANCE_ARN)
        assignments = []

        for ps_arn in ps_response.get("PermissionSets", []):
            # Get assignments for this permission set
            assign_response = clients["sso_admin"].list_account_assignments(
                InstanceArn=SSO_INSTANCE_ARN,
                AccountId=ACCOUNT_ID,
                PermissionSetArn=ps_arn
            )

            ps_details = clients["sso_admin"].describe_permission_set(
                InstanceArn=SSO_INSTANCE_ARN,
                PermissionSetArn=ps_arn
            )
            ps_name = ps_details["PermissionSet"]["Name"]

            for assignment in assign_response.get("AccountAssignments", []):
                principal_id = assignment["PrincipalId"]
                principal_type = assignment["PrincipalType"]

                # Get principal name
                principal_name = principal_id
                if principal_type == "GROUP":
                    try:
                        group = clients["identitystore"].describe_group(
                            IdentityStoreId=IDENTITY_STORE_ID,
                            GroupId=principal_id
                        )
                        principal_name = group["DisplayName"]
                    except:
                        pass
                elif principal_type == "USER":
                    try:
                        user = clients["identitystore"].describe_user(
                            IdentityStoreId=IDENTITY_STORE_ID,
                            UserId=principal_id
                        )
                        principal_name = user.get("DisplayName", user["UserName"])
                    except:
                        pass

                assignments.append({
                    "permissionSetName": ps_name,
                    "permissionSetArn": ps_arn,
                    "principalType": principal_type,
                    "principalId": principal_id,
                    "principalName": principal_name
                })

        return {"assignments": assignments}
    except Exception as e:
        return {"assignments": [], "error": str(e)}


@app.post("/api/users")
def create_user(request: CreateUserRequest):
    """Create a new IAM Identity Center user."""
    clients = get_boto_clients()

    try:
        response = clients["identitystore"].create_user(
            IdentityStoreId=IDENTITY_STORE_ID,
            UserName=request.username,
            Name={
                "GivenName": request.givenName,
                "FamilyName": request.familyName,
            },
            DisplayName=f"{request.givenName} {request.familyName}",
            Emails=[
                {
                    "Value": request.email,
                    "Type": "work",
                    "Primary": True,
                }
            ],
            **({"Title": request.title} if request.title else {}),
            **({"UserType": request.userType} if request.userType else {}),
        )

        return {
            "success": True,
            "userId": response["UserId"],
            "message": f"User {request.username} created successfully",
        }
    except clients["identitystore"].exceptions.ConflictException:
        raise HTTPException(status_code=409, detail=f"User {request.username} already exists")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/groups/add-member")
def add_user_to_group(request: AddUserToGroupRequest):
    """Add a user to a group."""
    clients = get_boto_clients()

    try:
        response = clients["identitystore"].create_group_membership(
            IdentityStoreId=IDENTITY_STORE_ID,
            GroupId=request.groupId,
            MemberId={"UserId": request.userId},
        )

        return {
            "success": True,
            "membershipId": response["MembershipId"],
            "message": "User added to group successfully",
        }
    except clients["identitystore"].exceptions.ConflictException:
        raise HTTPException(status_code=409, detail="User is already a member of this group")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/groups/remove-member")
def remove_user_from_group(request: RemoveUserFromGroupRequest):
    """Remove a user from a group."""
    clients = get_boto_clients()

    try:
        # First, find the membership ID
        memberships = clients["identitystore"].list_group_memberships(
            IdentityStoreId=IDENTITY_STORE_ID,
            GroupId=request.groupId,
        )

        membership_id = None
        for membership in memberships.get("GroupMemberships", []):
            if membership["MemberId"].get("UserId") == request.userId:
                membership_id = membership["MembershipId"]
                break

        if not membership_id:
            raise HTTPException(status_code=404, detail="User is not a member of this group")

        clients["identitystore"].delete_group_membership(
            IdentityStoreId=IDENTITY_STORE_ID,
            MembershipId=membership_id,
        )

        return {
            "success": True,
            "message": "User removed from group successfully",
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/users/{user_id}/groups")
def get_user_groups(user_id: str):
    """Get all groups a user belongs to."""
    clients = get_boto_clients()

    try:
        response = clients["identitystore"].list_group_memberships_for_member(
            IdentityStoreId=IDENTITY_STORE_ID,
            MemberId={"UserId": user_id},
        )

        groups = []
        for membership in response.get("GroupMemberships", []):
            group_id = membership["GroupId"]
            try:
                group = clients["identitystore"].describe_group(
                    IdentityStoreId=IDENTITY_STORE_ID,
                    GroupId=group_id,
                )
                groups.append({
                    "id": group_id,
                    "name": group["DisplayName"],
                    "membershipId": membership["MembershipId"],
                })
            except:
                pass

        return {"groups": groups}
    except Exception as e:
        return {"groups": [], "error": str(e)}


# ==================== AWS EKS Cluster Management ====================

@app.get("/api/eks/clusters")
def get_eks_clusters():
    """Get all EKS clusters from AWS."""
    clients = get_boto_clients()

    try:
        response = clients["eks"].list_clusters()
        cluster_names = response.get("clusters", [])

        clusters = []
        for name in cluster_names:
            try:
                details = clients["eks"].describe_cluster(name=name)
                cluster = details.get("cluster", {})
                clusters.append({
                    "name": cluster.get("name"),
                    "status": cluster.get("status"),
                    "version": cluster.get("version"),
                    "endpoint": cluster.get("endpoint"),
                    "arn": cluster.get("arn"),
                    "createdAt": cluster.get("createdAt").isoformat() if cluster.get("createdAt") else None,
                    "platformVersion": cluster.get("platformVersion"),
                    "vpcId": cluster.get("resourcesVpcConfig", {}).get("vpcId"),
                    "subnetIds": cluster.get("resourcesVpcConfig", {}).get("subnetIds", []),
                    "securityGroups": cluster.get("resourcesVpcConfig", {}).get("securityGroupIds", []),
                    "publicAccess": cluster.get("resourcesVpcConfig", {}).get("endpointPublicAccess"),
                    "privateAccess": cluster.get("resourcesVpcConfig", {}).get("endpointPrivateAccess"),
                })
            except Exception as e:
                clusters.append({"name": name, "error": str(e)})

        return {"clusters": clusters}
    except Exception as e:
        return {"clusters": [], "error": str(e)}


@app.get("/api/eks/clusters/{cluster_name}")
def get_eks_cluster_details(cluster_name: str):
    """Get detailed information about an EKS cluster."""
    clients = get_boto_clients()

    try:
        response = clients["eks"].describe_cluster(name=cluster_name)
        cluster = response.get("cluster", {})

        return {
            "cluster": {
                "name": cluster.get("name"),
                "status": cluster.get("status"),
                "version": cluster.get("version"),
                "endpoint": cluster.get("endpoint"),
                "arn": cluster.get("arn"),
                "roleArn": cluster.get("roleArn"),
                "createdAt": cluster.get("createdAt").isoformat() if cluster.get("createdAt") else None,
                "platformVersion": cluster.get("platformVersion"),
                "vpcConfig": {
                    "vpcId": cluster.get("resourcesVpcConfig", {}).get("vpcId"),
                    "subnetIds": cluster.get("resourcesVpcConfig", {}).get("subnetIds", []),
                    "securityGroupIds": cluster.get("resourcesVpcConfig", {}).get("securityGroupIds", []),
                    "clusterSecurityGroupId": cluster.get("resourcesVpcConfig", {}).get("clusterSecurityGroupId"),
                    "endpointPublicAccess": cluster.get("resourcesVpcConfig", {}).get("endpointPublicAccess"),
                    "endpointPrivateAccess": cluster.get("resourcesVpcConfig", {}).get("endpointPrivateAccess"),
                    "publicAccessCidrs": cluster.get("resourcesVpcConfig", {}).get("publicAccessCidrs", []),
                },
                "logging": cluster.get("logging"),
                "identity": cluster.get("identity"),
                "certificateAuthority": cluster.get("certificateAuthority", {}).get("data", "")[:50] + "..." if cluster.get("certificateAuthority") else None,
                "tags": cluster.get("tags", {}),
            }
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/eks/clusters/{cluster_name}/nodegroups")
def get_eks_nodegroups(cluster_name: str):
    """Get all node groups for an EKS cluster."""
    clients = get_boto_clients()

    try:
        response = clients["eks"].list_nodegroups(clusterName=cluster_name)
        nodegroup_names = response.get("nodegroups", [])

        nodegroups = []
        for name in nodegroup_names:
            try:
                details = clients["eks"].describe_nodegroup(
                    clusterName=cluster_name,
                    nodegroupName=name
                )
                ng = details.get("nodegroup", {})
                nodegroups.append({
                    "name": ng.get("nodegroupName"),
                    "status": ng.get("status"),
                    "capacityType": ng.get("capacityType"),
                    "instanceTypes": ng.get("instanceTypes", []),
                    "amiType": ng.get("amiType"),
                    "diskSize": ng.get("diskSize"),
                    "desiredSize": ng.get("scalingConfig", {}).get("desiredSize"),
                    "minSize": ng.get("scalingConfig", {}).get("minSize"),
                    "maxSize": ng.get("scalingConfig", {}).get("maxSize"),
                    "subnets": ng.get("subnets", []),
                    "labels": ng.get("labels", {}),
                    "createdAt": ng.get("createdAt").isoformat() if ng.get("createdAt") else None,
                })
            except Exception as e:
                nodegroups.append({"name": name, "error": str(e)})

        return {"nodegroups": nodegroups}
    except Exception as e:
        return {"nodegroups": [], "error": str(e)}


@app.get("/api/eks/clusters/{cluster_name}/addons")
def get_eks_addons(cluster_name: str):
    """Get all addons for an EKS cluster."""
    clients = get_boto_clients()

    try:
        response = clients["eks"].list_addons(clusterName=cluster_name)
        addon_names = response.get("addons", [])

        addons = []
        for name in addon_names:
            try:
                details = clients["eks"].describe_addon(
                    clusterName=cluster_name,
                    addonName=name
                )
                addon = details.get("addon", {})
                addons.append({
                    "name": addon.get("addonName"),
                    "version": addon.get("addonVersion"),
                    "status": addon.get("status"),
                    "createdAt": addon.get("createdAt").isoformat() if addon.get("createdAt") else None,
                })
            except Exception as e:
                addons.append({"name": name, "error": str(e)})

        return {"addons": addons}
    except Exception as e:
        return {"addons": [], "error": str(e)}


def _rollup_cluster_cost(cluster_name: str, cluster_status: Optional[str]) -> Dict[str, Any]:
    """
    Compute the honest monthly cost for an EKS cluster:
      control_plane_monthly + node_monthly

    Node cost uses the static us-west-2 on-demand rate table
    (aws_rates.EC2_MONTHLY_RATES_USD) × 730h/mo, with a per-vCPU fallback and
    a 0.30× spot multiplier. Stopped instances contribute $0. Rows with
    an unknown instanceType or a spot lifecycle are flagged estimated=true.

    Node discovery: describe_instances filtered by
    `tag:kubernetes.io/cluster/<name>=owned` OR `tag:aws:eks:cluster-name=<name>`.
    Rather than issue two calls we do one filter on the kubernetes.io tag
    (present on both managed + self-managed nodes) and then re-check the
    managed tag in-Python so nothing slips through.
    """
    ec2 = boto3.client("ec2")

    # Membership filter — the kubernetes.io/cluster/<X>=owned tag is present
    # on both managed and self-managed EKS nodes. Managed nodes ALSO carry
    # aws:eks:cluster-name, so we OR the two filters via two calls only when
    # needed. Start with the k8s.io tag which covers ~everything.
    running_types: Dict[str, Dict[str, Any]] = {}
    running_count = 0
    total_count = 0
    seen_instance_ids: set = set()

    def _consume(reservations: List[Dict[str, Any]]) -> None:
        nonlocal running_count, total_count
        for reservation in reservations:
            for instance in reservation.get("Instances", []):
                iid = instance.get("InstanceId")
                if not iid or iid in seen_instance_ids:
                    continue
                seen_instance_ids.add(iid)
                state = instance.get("State", {}).get("Name", "unknown")
                if state == "terminated":
                    continue
                total_count += 1
                instance_type = instance.get("InstanceType") or "unknown"
                lifecycle = instance.get("InstanceLifecycle")
                capacity_type = "SPOT" if lifecycle == "spot" else "ON_DEMAND"
                key = (instance_type, capacity_type)
                bucket = running_types.setdefault(
                    key,
                    {
                        "instanceType": instance_type,
                        "capacityType": capacity_type,
                        "count": 0,
                        "runningCount": 0,
                    },
                )
                bucket["count"] += 1
                if state == "running":
                    bucket["runningCount"] += 1
                    running_count += 1

    try:
        resp = ec2.describe_instances(
            Filters=[
                {"Name": f"tag:kubernetes.io/cluster/{cluster_name}", "Values": ["owned"]}
            ]
        )
        _consume(resp.get("Reservations", []))
    except Exception:
        pass

    try:
        resp2 = ec2.describe_instances(
            Filters=[
                {"Name": "tag:aws:eks:cluster-name", "Values": [cluster_name]}
            ]
        )
        _consume(resp2.get("Reservations", []))
    except Exception:
        pass

    # Materialize per-type rows using the running count for monthly math.
    node_types: List[Dict[str, Any]] = []
    node_monthly_total = 0.0
    any_estimated = False
    for _key, bucket in running_types.items():
        instance_type = bucket["instanceType"]
        capacity_type = bucket["capacityType"]
        running = bucket["runningCount"]
        lifecycle = "spot" if capacity_type == "SPOT" else None
        # Use "running" so the fallback returns non-zero hourly, then multiply by running count.
        hourly, monthly_per_instance, estimated = _estimate_monthly(instance_type, "running", lifecycle)
        row_monthly = round(monthly_per_instance * running, 2)
        node_monthly_total += row_monthly
        if estimated:
            any_estimated = True
        node_types.append({
            "instanceType": instance_type,
            "count": bucket["count"],
            "runningCount": running,
            "hourly": hourly,
            "monthly": row_monthly,
            "capacityType": capacity_type,
            "estimated": estimated,
        })

    node_types.sort(key=lambda r: (-r["monthly"], r["instanceType"]))

    # Control plane fee — $0.10/hr × 730h unless the cluster isn't billable.
    non_billable = (cluster_status or "").upper() in {"CREATING", "DELETING", "FAILED"}
    control_plane_monthly = 0.0 if non_billable else round(EKS_CONTROL_PLANE_HOURLY * MONTHLY_HOURS, 2)

    total_monthly = round(control_plane_monthly + node_monthly_total, 2)

    from datetime import datetime, timezone
    return {
        "clusterName": cluster_name,
        "control_plane_monthly": control_plane_monthly,
        "node_monthly": round(node_monthly_total, 2),
        "total_monthly": total_monthly,
        "node_count": total_count,
        "running_node_count": running_count,
        "node_types": node_types,
        "estimated": any_estimated,
        "currency": "USD",
        "asOf": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }


@app.get("/api/eks/clusters/{cluster_name}/cost")
def get_eks_cluster_cost_rollup(cluster_name: str):
    """
    Honest monthly rollup for a single EKS cluster: control plane + nodes.

    Distinct from /api/eks/clusters/{cluster_name}/costs (with the trailing
    `s`) which returns 30d/7d/1d Cost Explorer numbers for the control plane
    only. This endpoint is the transparency rollup the ClusterTab needs to
    show the operator what the cluster ACTUALLY costs each month.

    Node cost is estimated from a static on-demand rate table (see
    aws_rates.py) — actual billing may differ due to Savings Plans,
    Reserved Instances, or spot price float. The `estimated` flag is true
    if any row used a fallback.
    """
    clients = get_boto_clients()

    # Look up cluster status for control-plane-billable check. Not fatal if
    # this fails — we'll assume billable and let the rollup proceed.
    cluster_status: Optional[str] = None
    try:
        details = clients["eks"].describe_cluster(name=cluster_name)
        cluster_status = details.get("cluster", {}).get("status")
    except Exception:
        cluster_status = None

    try:
        return _rollup_cluster_cost(cluster_name, cluster_status)
    except Exception as e:
        return {
            "clusterName": cluster_name,
            "control_plane_monthly": 0.0,
            "node_monthly": 0.0,
            "total_monthly": 0.0,
            "node_count": 0,
            "running_node_count": 0,
            "node_types": [],
            "estimated": True,
            "currency": "USD",
            "error": str(e),
        }


@app.get("/api/eks/clusters/{cluster_name}/costs")
def get_eks_cluster_costs(cluster_name: str):
    """Get cost breakdown for an EKS cluster (30 days, 7 days, 1 day)."""
    clients = get_boto_clients()
    from datetime import datetime, timedelta

    try:
        results = {}

        # Define time periods
        periods = {
            "last30Days": 30,
            "last7Days": 7,
            "lastDay": 1,
        }

        for period_name, days in periods.items():
            end_date = datetime.now().strftime("%Y-%m-%d")
            start_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")

            try:
                # Query Cost Explorer for EKS costs filtered by cluster
                cost_response = clients["ce"].get_cost_and_usage(
                    TimePeriod={"Start": start_date, "End": end_date},
                    Granularity="DAILY" if days <= 7 else "MONTHLY",
                    Metrics=["UnblendedCost"],
                    Filter={
                        "And": [
                            {
                                "Dimensions": {
                                    "Key": "SERVICE",
                                    "Values": ["Amazon Elastic Container Service for Kubernetes"]
                                }
                            },
                            {
                                "Tags": {
                                    "Key": "eks:cluster-name",
                                    "Values": [cluster_name]
                                }
                            }
                        ]
                    }
                )

                total_cost = 0
                for result in cost_response.get("ResultsByTime", []):
                    total_cost += float(result.get("Total", {}).get("UnblendedCost", {}).get("Amount", 0))

                results[period_name] = round(total_cost, 2)
            except Exception:
                # If tag-based filtering fails, try service-level cost divided by cluster count
                try:
                    cost_response = clients["ce"].get_cost_and_usage(
                        TimePeriod={"Start": start_date, "End": end_date},
                        Granularity="DAILY" if days <= 7 else "MONTHLY",
                        Metrics=["UnblendedCost"],
                        Filter={
                            "Dimensions": {
                                "Key": "SERVICE",
                                "Values": ["Amazon Elastic Container Service for Kubernetes"]
                            }
                        }
                    )

                    total_cost = 0
                    for result in cost_response.get("ResultsByTime", []):
                        total_cost += float(result.get("Total", {}).get("UnblendedCost", {}).get("Amount", 0))

                    # Get cluster count to estimate per-cluster cost
                    clusters_response = clients["eks"].list_clusters()
                    cluster_count = len(clusters_response.get("clusters", [])) or 1

                    results[period_name] = round(total_cost / cluster_count, 2)
                except Exception:
                    results[period_name] = None

        return {
            "clusterName": cluster_name,
            "costs": results,
        }
    except Exception as e:
        return {"clusterName": cluster_name, "costs": {}, "error": str(e)}


@app.get("/api/eks/costs-summary")
def get_all_eks_costs(
    withNodes: bool = Query(True, description="Include node EC2 cost rollup per cluster"),
):
    """
    Cost summary for all EKS clusters.

    Backward-compatible: last30Days/last7Days/lastDay are still populated for
    each cluster from Cost Explorer (control-plane spend attributed to the
    EKS service). When `withNodes=true` (default), each cluster also gets
    controlPlaneMonthly / nodeMonthly / totalMonthly plus a top-level
    grandTotalMonthly — the honest number the operator wants to see.

    Node cost is computed via a static us-west-2 on-demand rate table
    × 730h/mo × running instance count. We make ONE describe_instances call
    (no filter) and partition by cluster in-Python so we don't pay N calls
    when there are many clusters.
    """
    clients = get_boto_clients()
    from datetime import datetime, timedelta, timezone

    try:
        # Get all cluster names
        clusters_response = clients["eks"].list_clusters()
        cluster_names = clusters_response.get("clusters", [])

        # Get cluster statuses so we don't attribute a $73/mo control plane fee
        # to a CREATING/DELETING/FAILED cluster.
        cluster_statuses: Dict[str, str] = {}
        for name in cluster_names:
            try:
                details = clients["eks"].describe_cluster(name=name)
                cluster_statuses[name] = details.get("cluster", {}).get("status", "")
            except Exception:
                cluster_statuses[name] = ""

        # Get total EKS costs
        end_date = datetime.now().strftime("%Y-%m-%d")

        periods = {
            "last30Days": 30,
            "last7Days": 7,
            "lastDay": 1,
        }

        total_costs = {}
        for period_name, period_days in periods.items():
            start_date = (datetime.now() - timedelta(days=period_days)).strftime("%Y-%m-%d")

            try:
                cost_response = clients["ce"].get_cost_and_usage(
                    TimePeriod={"Start": start_date, "End": end_date},
                    Granularity="DAILY" if period_days <= 7 else "MONTHLY",
                    Metrics=["UnblendedCost"],
                    Filter={
                        "Dimensions": {
                            "Key": "SERVICE",
                            "Values": ["Amazon Elastic Container Service for Kubernetes"]
                        }
                    }
                )

                total_cost = 0
                for result in cost_response.get("ResultsByTime", []):
                    total_cost += float(result.get("Total", {}).get("UnblendedCost", {}).get("Amount", 0))

                total_costs[period_name] = round(total_cost, 2)
            except Exception:
                total_costs[period_name] = None

        # Estimate per-cluster CE costs (rough — CE control-plane spend split evenly)
        cluster_count = len(cluster_names) or 1
        per_cluster_costs: Dict[str, Dict[str, Any]] = {}
        for cluster_name in cluster_names:
            per_cluster_costs[cluster_name] = {
                "last30Days": round(total_costs.get("last30Days", 0) / cluster_count, 2) if total_costs.get("last30Days") else None,
                "last7Days": round(total_costs.get("last7Days", 0) / cluster_count, 2) if total_costs.get("last7Days") else None,
                "lastDay": round(total_costs.get("lastDay", 0) / cluster_count, 2) if total_costs.get("lastDay") else None,
            }

        grand_total_monthly: Optional[float] = None

        if withNodes and cluster_names:
            # ONE describe_instances call, partition per cluster in-Python.
            # Rows shape per cluster:
            #   {instanceType, capacityType, count, runningCount, hourly, monthly, estimated}
            per_cluster_nodes: Dict[str, Dict[Tuple[str, str], Dict[str, Any]]] = {
                name: {} for name in cluster_names
            }
            unknown_cluster_membership: Dict[str, int] = {}

            try:
                ec2_resp = clients["ec2"].describe_instances()
                for reservation in ec2_resp.get("Reservations", []):
                    for instance in reservation.get("Instances", []):
                        state = instance.get("State", {}).get("Name", "unknown")
                        if state == "terminated":
                            continue
                        tags_map: Dict[str, str] = {
                            t["Key"]: t["Value"] for t in instance.get("Tags", [])
                        }
                        parent, _hint, _conflicts = _detect_parent_cluster(tags_map)
                        if not parent:
                            continue
                        instance_type = instance.get("InstanceType") or "unknown"
                        lifecycle = instance.get("InstanceLifecycle")
                        capacity_type = "SPOT" if lifecycle == "spot" else "ON_DEMAND"

                        if parent not in per_cluster_nodes:
                            # Self-managed / unrecognized-cluster tag — track separately
                            # so ClusterTab doesn't corrupt real cluster totals.
                            unknown_cluster_membership[parent] = (
                                unknown_cluster_membership.get(parent, 0) + 1
                            )
                            continue

                        buckets = per_cluster_nodes[parent]
                        key = (instance_type, capacity_type)
                        bucket = buckets.setdefault(
                            key,
                            {
                                "instanceType": instance_type,
                                "capacityType": capacity_type,
                                "count": 0,
                                "runningCount": 0,
                            },
                        )
                        bucket["count"] += 1
                        if state == "running":
                            bucket["runningCount"] += 1
            except Exception:
                # If describe_instances fails, leave per_cluster_nodes empty —
                # node fields will show 0 with estimated=true.
                pass

            grand_total_monthly = 0.0
            for name in cluster_names:
                node_monthly_total = 0.0
                any_estimated = False
                node_count = 0
                running_count = 0
                for _key, bucket in per_cluster_nodes.get(name, {}).items():
                    running = bucket["runningCount"]
                    lifecycle = "spot" if bucket["capacityType"] == "SPOT" else None
                    _hourly, per_instance_monthly, estimated = _estimate_monthly(
                        bucket["instanceType"], "running", lifecycle
                    )
                    node_monthly_total += per_instance_monthly * running
                    if estimated:
                        any_estimated = True
                    node_count += bucket["count"]
                    running_count += running

                non_billable = (cluster_statuses.get(name) or "").upper() in {
                    "CREATING",
                    "DELETING",
                    "FAILED",
                }
                control_plane_monthly = 0.0 if non_billable else round(
                    EKS_CONTROL_PLANE_HOURLY * MONTHLY_HOURS, 2
                )
                node_monthly_rounded = round(node_monthly_total, 2)
                total_monthly = round(control_plane_monthly + node_monthly_rounded, 2)

                per_cluster_costs[name].update({
                    "controlPlaneMonthly": control_plane_monthly,
                    "nodeMonthly": node_monthly_rounded,
                    "totalMonthly": total_monthly,
                    "nodeCount": node_count,
                    "runningNodeCount": running_count,
                    "estimated": any_estimated,
                })
                grand_total_monthly += total_monthly

            grand_total_monthly = round(grand_total_monthly, 2)

        result: Dict[str, Any] = {
            "totalCosts": total_costs,
            "perClusterCosts": per_cluster_costs,
            "clusterCount": cluster_count,
        }
        if grand_total_monthly is not None:
            result["grandTotalMonthly"] = grand_total_monthly
        return result
    except Exception as e:
        return {"totalCosts": {}, "perClusterCosts": {}, "error": str(e)}


@app.get("/api/eks/versions")
def get_eks_versions():
    """Get available EKS Kubernetes versions."""
    clients = get_boto_clients()

    try:
        # Get supported versions from addon versions API
        response = clients["eks"].describe_addon_versions()
        versions = set()
        for addon in response.get("addons", []):
            for addon_version in addon.get("addonVersions", []):
                for compat in addon_version.get("compatibilities", []):
                    if compat.get("clusterVersion"):
                        versions.add(compat["clusterVersion"])

        sorted_versions = sorted(versions, key=lambda v: [int(x) for x in v.split(".")])
        latest_version = sorted_versions[-1] if sorted_versions else None

        return {
            "versions": sorted_versions,
            "latestVersion": latest_version,
        }
    except Exception as e:
        return {"versions": [], "latestVersion": None, "error": str(e)}


@app.get("/api/eks/clusters/{cluster_name}/upgrade-status")
def get_eks_upgrade_status(cluster_name: str):
    """Check if an EKS cluster needs an upgrade."""
    clients = get_boto_clients()

    try:
        # Get cluster version
        cluster_response = clients["eks"].describe_cluster(name=cluster_name)
        current_version = cluster_response["cluster"]["version"]

        # Get available versions
        versions_response = clients["eks"].describe_addon_versions()
        versions = set()
        for addon in versions_response.get("addons", []):
            for addon_version in addon.get("addonVersions", []):
                for compat in addon_version.get("compatibilities", []):
                    if compat.get("clusterVersion"):
                        versions.add(compat["clusterVersion"])

        sorted_versions = sorted(versions, key=lambda v: [int(x) for x in v.split(".")])
        latest_version = sorted_versions[-1] if sorted_versions else current_version

        # Find available upgrades (versions higher than current)
        current_parts = [int(x) for x in current_version.split(".")]
        available_upgrades = [
            v for v in sorted_versions
            if [int(x) for x in v.split(".")] > current_parts
        ]

        return {
            "clusterName": cluster_name,
            "currentVersion": current_version,
            "latestVersion": latest_version,
            "isUpToDate": current_version == latest_version,
            "availableUpgrades": available_upgrades,
            "upgradeRecommended": len(available_upgrades) > 0,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class ScaleNodeGroupRequest(BaseModel):
    desiredSize: int
    minSize: Optional[int] = None
    maxSize: Optional[int] = None


@app.get("/api/eks/clusters/{cluster_name}/scaling-status")
def get_cluster_scaling_status(cluster_name: str):
    """Get current scaling status of all node groups in a cluster."""
    clients = get_boto_clients()

    try:
        response = clients["eks"].list_nodegroups(clusterName=cluster_name)
        nodegroup_names = response.get("nodegroups", [])

        nodegroups = []
        total_desired = 0
        total_current = 0

        for name in nodegroup_names:
            try:
                details = clients["eks"].describe_nodegroup(
                    clusterName=cluster_name,
                    nodegroupName=name
                )
                ng = details.get("nodegroup", {})
                scaling = ng.get("scalingConfig", {})

                desired = scaling.get("desiredSize", 0)
                min_size = scaling.get("minSize", 0)
                max_size = scaling.get("maxSize", 0)

                total_desired += desired

                nodegroups.append({
                    "name": ng.get("nodegroupName"),
                    "status": ng.get("status"),
                    "desiredSize": desired,
                    "minSize": min_size,
                    "maxSize": max_size,
                    "capacityType": ng.get("capacityType"),
                    "instanceTypes": ng.get("instanceTypes", []),
                })
            except Exception as e:
                nodegroups.append({"name": name, "error": str(e)})

        # Determine cluster state
        cluster_state = "running" if total_desired > 0 else "scaled_down"

        return {
            "clusterName": cluster_name,
            "clusterState": cluster_state,
            "totalDesiredNodes": total_desired,
            "nodegroups": nodegroups,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/eks/clusters/{cluster_name}/nodegroups/{nodegroup_name}/scale")
def scale_nodegroup(cluster_name: str, nodegroup_name: str, request: ScaleNodeGroupRequest):
    """Scale a node group to a specific size."""
    clients = get_boto_clients()

    try:
        # Get current config
        details = clients["eks"].describe_nodegroup(
            clusterName=cluster_name,
            nodegroupName=nodegroup_name
        )
        current_scaling = details["nodegroup"]["scalingConfig"]

        # Prepare new scaling config
        new_scaling = {
            "desiredSize": request.desiredSize,
            "minSize": request.minSize if request.minSize is not None else min(request.desiredSize, current_scaling["minSize"]),
            "maxSize": request.maxSize if request.maxSize is not None else max(request.desiredSize, current_scaling["maxSize"]),
        }

        # Update node group
        clients["eks"].update_nodegroup_config(
            clusterName=cluster_name,
            nodegroupName=nodegroup_name,
            scalingConfig=new_scaling
        )

        return {
            "success": True,
            "message": f"Scaling {nodegroup_name} to {request.desiredSize} nodes",
            "newConfig": new_scaling,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/eks/clusters/{cluster_name}/scale-down")
def scale_down_cluster(cluster_name: str):
    """Scale down all node groups to 0 (shutdown cluster workers)."""
    clients = get_boto_clients()

    try:
        response = clients["eks"].list_nodegroups(clusterName=cluster_name)
        nodegroup_names = response.get("nodegroups", [])

        results = []
        for name in nodegroup_names:
            try:
                # Get current config to preserve max
                details = clients["eks"].describe_nodegroup(
                    clusterName=cluster_name,
                    nodegroupName=name
                )
                current_scaling = details["nodegroup"]["scalingConfig"]

                # Scale to 0
                clients["eks"].update_nodegroup_config(
                    clusterName=cluster_name,
                    nodegroupName=name,
                    scalingConfig={
                        "desiredSize": 0,
                        "minSize": 0,
                        "maxSize": current_scaling["maxSize"],
                    }
                )
                results.append({"nodegroup": name, "status": "scaling_down"})
            except Exception as e:
                results.append({"nodegroup": name, "error": str(e)})

        return {
            "success": True,
            "message": f"Scaling down {len(nodegroup_names)} node groups to 0",
            "results": results,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/eks/clusters/{cluster_name}/scale-up")
def scale_up_cluster(cluster_name: str, desired_per_nodegroup: int = 2):
    """Scale up all node groups (startup cluster workers)."""
    clients = get_boto_clients()

    try:
        response = clients["eks"].list_nodegroups(clusterName=cluster_name)
        nodegroup_names = response.get("nodegroups", [])

        results = []
        for name in nodegroup_names:
            try:
                # Get current config
                details = clients["eks"].describe_nodegroup(
                    clusterName=cluster_name,
                    nodegroupName=name
                )
                current_scaling = details["nodegroup"]["scalingConfig"]

                # Scale up (use previous desired or default)
                desired = max(desired_per_nodegroup, current_scaling.get("minSize", 1))

                clients["eks"].update_nodegroup_config(
                    clusterName=cluster_name,
                    nodegroupName=name,
                    scalingConfig={
                        "desiredSize": desired,
                        "minSize": min(desired, current_scaling.get("minSize", 1)),
                        "maxSize": current_scaling["maxSize"],
                    }
                )
                results.append({"nodegroup": name, "status": "scaling_up", "desiredSize": desired})
            except Exception as e:
                results.append({"nodegroup": name, "error": str(e)})

        return {
            "success": True,
            "message": f"Scaling up {len(nodegroup_names)} node groups",
            "results": results,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/eks/clusters/{cluster_name}/connect")
def connect_to_eks_cluster(cluster_name: str):
    """Shells out to aws/kubectl CLIs — not in Paketo runtime image.
    Return 501 so the UI can gracefully disable Cluster tab actions.
    Full boto3+kubernetes-client rewrite tracked separately."""
    raise HTTPException(
        status_code=501,
        detail=(
            "EKS cluster inspection is not yet supported in the cloud "
            "deploy of Platform Admin. This endpoint shells out to the "
            "aws + kubectl CLIs which are not present in the runtime "
            "image. Rewrite to use boto3 + python-kubernetes tracked in "
            "the backlog. Meanwhile, use the local dev build."
        ),
    )


# ==================== Kubernetes Cluster Management ====================

def run_kubectl(args: List[str], context: Optional[str] = None) -> dict:
    """Run a kubectl command and return the JSON output."""
    cmd = ["kubectl"]
    if context:
        cmd.extend(["--context", context])
    cmd.extend(args)
    cmd.extend(["-o", "json"])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            return {"error": result.stderr}
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        return {"error": "Command timed out"}
    except json.JSONDecodeError:
        return {"error": "Failed to parse kubectl output"}
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/clusters")
def get_clusters():
    """Get all available Kubernetes clusters/contexts."""
    try:
        result = subprocess.run(
            ["kubectl", "config", "get-contexts", "-o", "name"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            return {"clusters": [], "error": result.stderr}

        contexts = [c.strip() for c in result.stdout.strip().split("\n") if c.strip()]

        # Get current context
        current_result = subprocess.run(
            ["kubectl", "config", "current-context"],
            capture_output=True, text=True, timeout=10
        )
        current_context = current_result.stdout.strip() if current_result.returncode == 0 else None

        clusters = []
        for ctx in contexts:
            clusters.append({
                "name": ctx,
                "isCurrent": ctx == current_context,
            })

        return {"clusters": clusters, "currentContext": current_context}
    except Exception as e:
        return {"clusters": [], "error": str(e)}


@app.get("/api/clusters/{context}/info")
def get_cluster_info(context: str):
    """Get cluster information for a specific context."""
    try:
        result = subprocess.run(
            ["kubectl", "--context", context, "cluster-info"],
            capture_output=True, text=True, timeout=15
        )
        return {
            "info": result.stdout if result.returncode == 0 else None,
            "error": result.stderr if result.returncode != 0 else None,
        }
    except Exception as e:
        return {"info": None, "error": str(e)}


@app.get("/api/clusters/{context}/namespaces")
def get_namespaces(context: str):
    """Get all namespaces in a cluster."""
    data = run_kubectl(["get", "namespaces"], context)
    if "error" in data:
        return {"namespaces": [], "error": data["error"]}

    namespaces = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        status = item.get("status", {})
        namespaces.append({
            "name": metadata.get("name"),
            "status": status.get("phase", "Unknown"),
            "createdAt": metadata.get("creationTimestamp"),
            "labels": metadata.get("labels", {}),
        })

    return {"namespaces": namespaces}


@app.get("/api/clusters/{context}/all-pods")
def get_all_pods(context: str):
    """Get all pods across all namespaces (like k9s 'all' view)."""
    data = run_kubectl(["get", "pods", "--all-namespaces"], context)
    if "error" in data:
        return {"pods": [], "error": data["error"]}

    pods = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        status = item.get("status", {})
        spec = item.get("spec", {})

        container_statuses = status.get("containerStatuses", [])
        ready_count = sum(1 for c in container_statuses if c.get("ready", False))
        total_count = len(container_statuses)
        restarts = sum(c.get("restartCount", 0) for c in container_statuses)

        pods.append({
            "namespace": metadata.get("namespace"),
            "name": metadata.get("name"),
            "status": status.get("phase", "Unknown"),
            "ready": f"{ready_count}/{total_count}",
            "restarts": restarts,
            "age": metadata.get("creationTimestamp"),
            "node": spec.get("nodeName"),
            "containers": [c.get("name") for c in spec.get("containers", [])],
        })

    return {"pods": pods}


@app.get("/api/clusters/{context}/all-deployments")
def get_all_deployments(context: str):
    """Get all deployments across all namespaces."""
    data = run_kubectl(["get", "deployments", "--all-namespaces"], context)
    if "error" in data:
        return {"deployments": [], "error": data["error"]}

    deployments = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        status = item.get("status", {})
        spec = item.get("spec", {})

        deployments.append({
            "namespace": metadata.get("namespace"),
            "name": metadata.get("name"),
            "ready": f"{status.get('readyReplicas', 0)}/{spec.get('replicas', 0)}",
            "upToDate": status.get("updatedReplicas", 0),
            "available": status.get("availableReplicas", 0),
            "age": metadata.get("creationTimestamp"),
            "containers": [c.get("name") for c in spec.get("template", {}).get("spec", {}).get("containers", [])],
            "images": [c.get("image") for c in spec.get("template", {}).get("spec", {}).get("containers", [])],
        })

    return {"deployments": deployments}


@app.get("/api/clusters/{context}/all-services")
def get_all_services(context: str):
    """Get all services across all namespaces."""
    data = run_kubectl(["get", "services", "--all-namespaces"], context)
    if "error" in data:
        return {"services": [], "error": data["error"]}

    services = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        spec = item.get("spec", {})

        ports = []
        for port in spec.get("ports", []):
            port_str = f"{port.get('port')}"
            if port.get("targetPort"):
                port_str += f":{port.get('targetPort')}"
            if port.get("nodePort"):
                port_str += f":{port.get('nodePort')}"
            port_str += f"/{port.get('protocol', 'TCP')}"
            ports.append(port_str)

        services.append({
            "namespace": metadata.get("namespace"),
            "name": metadata.get("name"),
            "type": spec.get("type", "ClusterIP"),
            "clusterIP": spec.get("clusterIP"),
            "externalIP": spec.get("externalIPs", [None])[0] if spec.get("externalIPs") else None,
            "ports": ports,
            "age": metadata.get("creationTimestamp"),
        })

    return {"services": services}


@app.get("/api/clusters/{context}/all-configmaps")
def get_all_configmaps(context: str):
    """Get all configmaps across all namespaces."""
    data = run_kubectl(["get", "configmaps", "--all-namespaces"], context)
    if "error" in data:
        return {"configmaps": [], "error": data["error"]}

    configmaps = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        data_keys = list(item.get("data", {}).keys()) if item.get("data") else []

        configmaps.append({
            "namespace": metadata.get("namespace"),
            "name": metadata.get("name"),
            "dataCount": len(data_keys),
            "age": metadata.get("creationTimestamp"),
        })

    return {"configmaps": configmaps}


@app.get("/api/clusters/{context}/all-secrets")
def get_all_secrets(context: str):
    """Get all secrets across all namespaces (names only, not values)."""
    data = run_kubectl(["get", "secrets", "--all-namespaces"], context)
    if "error" in data:
        return {"secrets": [], "error": data["error"]}

    secrets = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        data_keys = list(item.get("data", {}).keys()) if item.get("data") else []

        secrets.append({
            "namespace": metadata.get("namespace"),
            "name": metadata.get("name"),
            "type": item.get("type", "Opaque"),
            "dataCount": len(data_keys),
            "age": metadata.get("creationTimestamp"),
        })

    return {"secrets": secrets}


@app.get("/api/clusters/{context}/all-ingresses")
def get_all_ingresses(context: str):
    """Get all ingresses across all namespaces."""
    data = run_kubectl(["get", "ingresses", "--all-namespaces"], context)
    if "error" in data:
        return {"ingresses": [], "error": data["error"]}

    ingresses = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        spec = item.get("spec", {})
        status = item.get("status", {})

        hosts = []
        for rule in spec.get("rules", []):
            if rule.get("host"):
                hosts.append(rule["host"])

        load_balancer = status.get("loadBalancer", {}).get("ingress", [])
        address = load_balancer[0].get("hostname") or load_balancer[0].get("ip") if load_balancer else None

        ingresses.append({
            "namespace": metadata.get("namespace"),
            "name": metadata.get("name"),
            "class": spec.get("ingressClassName"),
            "hosts": hosts,
            "address": address,
            "age": metadata.get("creationTimestamp"),
        })

    return {"ingresses": ingresses}


@app.get("/api/clusters/{context}/all-pvcs")
def get_all_pvcs(context: str):
    """Get all PersistentVolumeClaims across all namespaces."""
    data = run_kubectl(["get", "pvc", "--all-namespaces"], context)
    if "error" in data:
        return {"pvcs": [], "error": data["error"]}

    pvcs = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        spec = item.get("spec", {})
        status = item.get("status", {})

        pvcs.append({
            "namespace": metadata.get("namespace"),
            "name": metadata.get("name"),
            "status": status.get("phase"),
            "volume": spec.get("volumeName"),
            "capacity": status.get("capacity", {}).get("storage"),
            "accessModes": spec.get("accessModes", []),
            "storageClass": spec.get("storageClassName"),
            "age": metadata.get("creationTimestamp"),
        })

    return {"pvcs": pvcs}


@app.get("/api/clusters/{context}/all-jobs")
def get_all_jobs(context: str):
    """Get all jobs across all namespaces."""
    data = run_kubectl(["get", "jobs", "--all-namespaces"], context)
    if "error" in data:
        return {"jobs": [], "error": data["error"]}

    jobs = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        spec = item.get("spec", {})
        status = item.get("status", {})

        jobs.append({
            "namespace": metadata.get("namespace"),
            "name": metadata.get("name"),
            "completions": f"{status.get('succeeded', 0)}/{spec.get('completions', 1)}",
            "duration": status.get("completionTime"),
            "age": metadata.get("creationTimestamp"),
            "active": status.get("active", 0),
            "failed": status.get("failed", 0),
        })

    return {"jobs": jobs}


@app.get("/api/clusters/{context}/all-cronjobs")
def get_all_cronjobs(context: str):
    """Get all cronjobs across all namespaces."""
    data = run_kubectl(["get", "cronjobs", "--all-namespaces"], context)
    if "error" in data:
        return {"cronjobs": [], "error": data["error"]}

    cronjobs = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        spec = item.get("spec", {})
        status = item.get("status", {})

        cronjobs.append({
            "namespace": metadata.get("namespace"),
            "name": metadata.get("name"),
            "schedule": spec.get("schedule"),
            "suspend": spec.get("suspend", False),
            "active": len(status.get("active", [])),
            "lastSchedule": status.get("lastScheduleTime"),
            "age": metadata.get("creationTimestamp"),
        })

    return {"cronjobs": cronjobs}


@app.get("/api/clusters/{context}/all-statefulsets")
def get_all_statefulsets(context: str):
    """Get all statefulsets across all namespaces."""
    data = run_kubectl(["get", "statefulsets", "--all-namespaces"], context)
    if "error" in data:
        return {"statefulsets": [], "error": data["error"]}

    statefulsets = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        spec = item.get("spec", {})
        status = item.get("status", {})

        statefulsets.append({
            "namespace": metadata.get("namespace"),
            "name": metadata.get("name"),
            "ready": f"{status.get('readyReplicas', 0)}/{spec.get('replicas', 0)}",
            "age": metadata.get("creationTimestamp"),
        })

    return {"statefulsets": statefulsets}


@app.get("/api/clusters/{context}/all-daemonsets")
def get_all_daemonsets(context: str):
    """Get all daemonsets across all namespaces."""
    data = run_kubectl(["get", "daemonsets", "--all-namespaces"], context)
    if "error" in data:
        return {"daemonsets": [], "error": data["error"]}

    daemonsets = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        status = item.get("status", {})

        daemonsets.append({
            "namespace": metadata.get("namespace"),
            "name": metadata.get("name"),
            "desired": status.get("desiredNumberScheduled", 0),
            "current": status.get("currentNumberScheduled", 0),
            "ready": status.get("numberReady", 0),
            "upToDate": status.get("updatedNumberScheduled", 0),
            "available": status.get("numberAvailable", 0),
            "age": metadata.get("creationTimestamp"),
        })

    return {"daemonsets": daemonsets}


@app.get("/api/clusters/{context}/all-replicasets")
def get_all_replicasets(context: str):
    """Get all replicasets across all namespaces."""
    data = run_kubectl(["get", "replicasets", "--all-namespaces"], context)
    if "error" in data:
        return {"replicasets": [], "error": data["error"]}

    replicasets = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        spec = item.get("spec", {})
        status = item.get("status", {})

        replicasets.append({
            "namespace": metadata.get("namespace"),
            "name": metadata.get("name"),
            "desired": spec.get("replicas", 0),
            "current": status.get("replicas", 0),
            "ready": status.get("readyReplicas", 0),
            "age": metadata.get("creationTimestamp"),
        })

    return {"replicasets": replicasets}


@app.get("/api/clusters/{context}/nodes")
def get_nodes(context: str):
    """Get all nodes in the cluster."""
    data = run_kubectl(["get", "nodes"], context)
    if "error" in data:
        return {"nodes": [], "error": data["error"]}

    nodes = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        status = item.get("status", {})
        spec = item.get("spec", {})

        # Get node conditions
        conditions = {c["type"]: c["status"] for c in status.get("conditions", [])}
        node_status = "Ready" if conditions.get("Ready") == "True" else "NotReady"

        # Get capacity
        capacity = status.get("capacity", {})
        allocatable = status.get("allocatable", {})

        # Get node info
        node_info = status.get("nodeInfo", {})

        nodes.append({
            "name": metadata.get("name"),
            "status": node_status,
            "roles": [k.replace("node-role.kubernetes.io/", "") for k in metadata.get("labels", {}).keys() if k.startswith("node-role.kubernetes.io/")],
            "age": metadata.get("creationTimestamp"),
            "version": node_info.get("kubeletVersion"),
            "os": node_info.get("osImage"),
            "kernel": node_info.get("kernelVersion"),
            "container": node_info.get("containerRuntimeVersion"),
            "cpu": capacity.get("cpu"),
            "memory": capacity.get("memory"),
            "pods": capacity.get("pods"),
            "internalIP": next((a["address"] for a in status.get("addresses", []) if a["type"] == "InternalIP"), None),
            "externalIP": next((a["address"] for a in status.get("addresses", []) if a["type"] == "ExternalIP"), None),
        })

    return {"nodes": nodes}


@app.get("/api/clusters/{context}/all-events")
def get_all_events(context: str):
    """Get recent events across all namespaces."""
    data = run_kubectl(["get", "events", "--all-namespaces", "--sort-by=.lastTimestamp"], context)
    if "error" in data:
        return {"events": [], "error": data["error"]}

    events = []
    for item in data.get("items", [])[-100:]:  # Last 100 events
        metadata = item.get("metadata", {})
        involved_object = item.get("involvedObject", {})

        events.append({
            "namespace": metadata.get("namespace"),
            "name": metadata.get("name"),
            "type": item.get("type"),
            "reason": item.get("reason"),
            "message": item.get("message"),
            "object": f"{involved_object.get('kind', '')}/{involved_object.get('name', '')}",
            "count": item.get("count", 1),
            "firstSeen": item.get("firstTimestamp"),
            "lastSeen": item.get("lastTimestamp"),
            "age": item.get("lastTimestamp"),
        })

    return {"events": events}


@app.get("/api/clusters/{context}/all-summary")
def get_all_namespaces_summary(context: str):
    """Get summary of all resources across all namespaces."""
    pods_data = run_kubectl(["get", "pods", "--all-namespaces"], context)
    deployments_data = run_kubectl(["get", "deployments", "--all-namespaces"], context)
    services_data = run_kubectl(["get", "services", "--all-namespaces"], context)

    pods = pods_data.get("items", []) if "error" not in pods_data else []
    deployments = deployments_data.get("items", []) if "error" not in deployments_data else []
    services = services_data.get("items", []) if "error" not in services_data else []

    # Count by namespace
    ns_counts = {}
    for pod in pods:
        ns = pod.get("metadata", {}).get("namespace", "default")
        if ns not in ns_counts:
            ns_counts[ns] = {"pods": 0, "deployments": 0, "services": 0}
        ns_counts[ns]["pods"] += 1

    for dep in deployments:
        ns = dep.get("metadata", {}).get("namespace", "default")
        if ns not in ns_counts:
            ns_counts[ns] = {"pods": 0, "deployments": 0, "services": 0}
        ns_counts[ns]["deployments"] += 1

    for svc in services:
        ns = svc.get("metadata", {}).get("namespace", "default")
        if ns not in ns_counts:
            ns_counts[ns] = {"pods": 0, "deployments": 0, "services": 0}
        ns_counts[ns]["services"] += 1

    # Pod status counts
    pod_status_counts = {}
    for pod in pods:
        status = pod.get("status", {}).get("phase", "Unknown")
        pod_status_counts[status] = pod_status_counts.get(status, 0) + 1

    return {
        "totalCounts": {
            "pods": len(pods),
            "deployments": len(deployments),
            "services": len(services),
            "namespaces": len(ns_counts),
        },
        "podStatuses": pod_status_counts,
        "byNamespace": ns_counts,
    }


@app.get("/api/clusters/{context}/namespaces/{namespace}/pods")
def get_pods(context: str, namespace: str):
    """Get all pods in a namespace."""
    data = run_kubectl(["get", "pods", "-n", namespace], context)
    if "error" in data:
        return {"pods": [], "error": data["error"]}

    pods = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        status = item.get("status", {})
        spec = item.get("spec", {})

        container_statuses = status.get("containerStatuses", [])
        ready_count = sum(1 for c in container_statuses if c.get("ready", False))
        total_count = len(container_statuses)

        restarts = sum(c.get("restartCount", 0) for c in container_statuses)

        pods.append({
            "name": metadata.get("name"),
            "status": status.get("phase", "Unknown"),
            "ready": f"{ready_count}/{total_count}",
            "restarts": restarts,
            "age": metadata.get("creationTimestamp"),
            "node": spec.get("nodeName"),
            "containers": [c.get("name") for c in spec.get("containers", [])],
        })

    return {"pods": pods}


@app.get("/api/clusters/{context}/namespaces/{namespace}/deployments")
def get_deployments(context: str, namespace: str):
    """Get all deployments in a namespace."""
    data = run_kubectl(["get", "deployments", "-n", namespace], context)
    if "error" in data:
        return {"deployments": [], "error": data["error"]}

    deployments = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        status = item.get("status", {})
        spec = item.get("spec", {})

        deployments.append({
            "name": metadata.get("name"),
            "ready": f"{status.get('readyReplicas', 0)}/{spec.get('replicas', 0)}",
            "upToDate": status.get("updatedReplicas", 0),
            "available": status.get("availableReplicas", 0),
            "age": metadata.get("creationTimestamp"),
            "containers": [c.get("name") for c in spec.get("template", {}).get("spec", {}).get("containers", [])],
            "images": [c.get("image") for c in spec.get("template", {}).get("spec", {}).get("containers", [])],
        })

    return {"deployments": deployments}


@app.get("/api/clusters/{context}/namespaces/{namespace}/services")
def get_services(context: str, namespace: str):
    """Get all services in a namespace."""
    data = run_kubectl(["get", "services", "-n", namespace], context)
    if "error" in data:
        return {"services": [], "error": data["error"]}

    services = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        spec = item.get("spec", {})

        ports = []
        for port in spec.get("ports", []):
            port_str = f"{port.get('port')}"
            if port.get("targetPort"):
                port_str += f":{port.get('targetPort')}"
            if port.get("nodePort"):
                port_str += f":{port.get('nodePort')}"
            port_str += f"/{port.get('protocol', 'TCP')}"
            ports.append(port_str)

        services.append({
            "name": metadata.get("name"),
            "type": spec.get("type", "ClusterIP"),
            "clusterIP": spec.get("clusterIP"),
            "externalIP": spec.get("externalIPs", [None])[0] if spec.get("externalIPs") else None,
            "ports": ports,
            "age": metadata.get("creationTimestamp"),
        })

    return {"services": services}


@app.get("/api/clusters/{context}/namespaces/{namespace}/configmaps")
def get_configmaps(context: str, namespace: str):
    """Get all configmaps in a namespace."""
    data = run_kubectl(["get", "configmaps", "-n", namespace], context)
    if "error" in data:
        return {"configmaps": [], "error": data["error"]}

    configmaps = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        data_keys = list(item.get("data", {}).keys()) if item.get("data") else []

        configmaps.append({
            "name": metadata.get("name"),
            "dataKeys": data_keys,
            "age": metadata.get("creationTimestamp"),
        })

    return {"configmaps": configmaps}


@app.get("/api/clusters/{context}/namespaces/{namespace}/secrets")
def get_secrets(context: str, namespace: str):
    """Get all secrets in a namespace (names only, not values)."""
    data = run_kubectl(["get", "secrets", "-n", namespace], context)
    if "error" in data:
        return {"secrets": [], "error": data["error"]}

    secrets = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        data_keys = list(item.get("data", {}).keys()) if item.get("data") else []

        secrets.append({
            "name": metadata.get("name"),
            "type": item.get("type", "Opaque"),
            "dataKeys": data_keys,
            "age": metadata.get("creationTimestamp"),
        })

    return {"secrets": secrets}


@app.get("/api/clusters/{context}/namespaces/{namespace}/summary")
def get_namespace_summary(context: str, namespace: str):
    """Get a summary of all resources in a namespace."""
    pods_data = run_kubectl(["get", "pods", "-n", namespace], context)
    deployments_data = run_kubectl(["get", "deployments", "-n", namespace], context)
    services_data = run_kubectl(["get", "services", "-n", namespace], context)

    pods = pods_data.get("items", []) if "error" not in pods_data else []
    deployments = deployments_data.get("items", []) if "error" not in deployments_data else []
    services = services_data.get("items", []) if "error" not in services_data else []

    # Count pod statuses
    pod_status_counts = {}
    for pod in pods:
        status = pod.get("status", {}).get("phase", "Unknown")
        pod_status_counts[status] = pod_status_counts.get(status, 0) + 1

    return {
        "namespace": namespace,
        "counts": {
            "pods": len(pods),
            "deployments": len(deployments),
            "services": len(services),
        },
        "podStatuses": pod_status_counts,
    }


@app.post("/api/clusters/switch-context")
def switch_context(context: str):
    """Switch to a different Kubernetes context."""
    try:
        result = subprocess.run(
            ["kubectl", "config", "use-context", context],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            raise HTTPException(status_code=400, detail=result.stderr)
        return {"success": True, "message": f"Switched to context: {context}"}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Command timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# K9S-STYLE RESOURCE ACTIONS
# ============================================================================

@app.get("/api/clusters/{cluster}/pods/{namespace}/{name}/logs")
def get_pod_logs(cluster: str, namespace: str, name: str, container: Optional[str] = None, previous: bool = False, tail: int = 500):
    """Get logs from a pod."""
    context = get_eks_context(cluster)
    cmd = ["logs", name, "-n", namespace, f"--tail={tail}"]
    if container:
        cmd.extend(["-c", container])
    if previous:
        cmd.append("--previous")

    try:
        result = subprocess.run(
            ["kubectl", "--context", context] + cmd,
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            return {"error": result.stderr, "logs": ""}
        return {"logs": result.stdout, "error": None}
    except subprocess.TimeoutExpired:
        return {"error": "Command timed out", "logs": ""}
    except Exception as e:
        return {"error": str(e), "logs": ""}


@app.get("/api/clusters/{cluster}/resources/{resource_type}/{namespace}/{name}/describe")
def describe_resource(cluster: str, resource_type: str, namespace: str, name: str):
    """Describe a Kubernetes resource."""
    context = get_eks_context(cluster)
    cmd = ["describe", resource_type, name, "-n", namespace]

    try:
        result = subprocess.run(
            ["kubectl", "--context", context] + cmd,
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            return {"error": result.stderr, "describe": ""}
        return {"describe": result.stdout, "error": None}
    except subprocess.TimeoutExpired:
        return {"error": "Command timed out", "describe": ""}
    except Exception as e:
        return {"error": str(e), "describe": ""}


@app.get("/api/clusters/{cluster}/resources/{resource_type}/{namespace}/{name}/yaml")
def get_resource_yaml(cluster: str, resource_type: str, namespace: str, name: str):
    """Get YAML definition of a Kubernetes resource."""
    context = get_eks_context(cluster)
    cmd = ["get", resource_type, name, "-n", namespace, "-o", "yaml"]

    try:
        result = subprocess.run(
            ["kubectl", "--context", context] + cmd,
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            return {"error": result.stderr, "yaml": ""}
        return {"yaml": result.stdout, "error": None}
    except subprocess.TimeoutExpired:
        return {"error": "Command timed out", "yaml": ""}
    except Exception as e:
        return {"error": str(e), "yaml": ""}


@app.delete("/api/clusters/{cluster}/resources/{resource_type}/{namespace}/{name}")
def delete_resource(cluster: str, resource_type: str, namespace: str, name: str, force: bool = False):
    """Delete a Kubernetes resource."""
    context = get_eks_context(cluster)
    cmd = ["delete", resource_type, name, "-n", namespace]
    if force:
        cmd.extend(["--force", "--grace-period=0"])

    try:
        result = subprocess.run(
            ["kubectl", "--context", context] + cmd,
            capture_output=True, text=True, timeout=60
        )
        if result.returncode != 0:
            raise HTTPException(status_code=400, detail=result.stderr)
        return {"success": True, "message": result.stdout}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Command timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/clusters/{cluster}/deployments/{namespace}/{name}/restart")
def restart_deployment(cluster: str, namespace: str, name: str):
    """Restart a deployment (rollout restart)."""
    context = get_eks_context(cluster)
    cmd = ["rollout", "restart", "deployment", name, "-n", namespace]

    try:
        result = subprocess.run(
            ["kubectl", "--context", context] + cmd,
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            raise HTTPException(status_code=400, detail=result.stderr)
        return {"success": True, "message": result.stdout}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Command timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/clusters/{cluster}/deployments/{namespace}/{name}/scale")
def scale_deployment(cluster: str, namespace: str, name: str, replicas: int):
    """Scale a deployment."""
    context = get_eks_context(cluster)
    cmd = ["scale", "deployment", name, "-n", namespace, f"--replicas={replicas}"]

    try:
        result = subprocess.run(
            ["kubectl", "--context", context] + cmd,
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            raise HTTPException(status_code=400, detail=result.stderr)
        return {"success": True, "message": result.stdout}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Command timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/clusters/{cluster}/statefulsets/{namespace}/{name}/restart")
def restart_statefulset(cluster: str, namespace: str, name: str):
    """Restart a statefulset (rollout restart)."""
    context = get_eks_context(cluster)
    cmd = ["rollout", "restart", "statefulset", name, "-n", namespace]

    try:
        result = subprocess.run(
            ["kubectl", "--context", context] + cmd,
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            raise HTTPException(status_code=400, detail=result.stderr)
        return {"success": True, "message": result.stdout}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Command timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/clusters/{cluster}/daemonsets/{namespace}/{name}/restart")
def restart_daemonset(cluster: str, namespace: str, name: str):
    """Restart a daemonset (rollout restart)."""
    context = get_eks_context(cluster)
    cmd = ["rollout", "restart", "daemonset", name, "-n", namespace]

    try:
        result = subprocess.run(
            ["kubectl", "--context", context] + cmd,
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            raise HTTPException(status_code=400, detail=result.stderr)
        return {"success": True, "message": result.stdout}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Command timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/clusters/{cluster}/cronjobs/{namespace}/{name}/trigger")
def trigger_cronjob(cluster: str, namespace: str, name: str):
    """Trigger a CronJob manually (create a Job from it)."""
    context = get_eks_context(cluster)
    job_name = f"{name}-manual-{int(__import__('time').time())}"
    cmd = ["create", "job", job_name, f"--from=cronjob/{name}", "-n", namespace]

    try:
        result = subprocess.run(
            ["kubectl", "--context", context] + cmd,
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            raise HTTPException(status_code=400, detail=result.stderr)
        return {"success": True, "message": result.stdout, "jobName": job_name}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Command timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/clusters/{cluster}/nodes/{name}/cordon")
def cordon_node(cluster: str, name: str):
    """Cordon a node (mark as unschedulable)."""
    context = get_eks_context(cluster)
    cmd = ["cordon", name]

    try:
        result = subprocess.run(
            ["kubectl", "--context", context] + cmd,
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            raise HTTPException(status_code=400, detail=result.stderr)
        return {"success": True, "message": result.stdout}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Command timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/clusters/{cluster}/nodes/{name}/uncordon")
def uncordon_node(cluster: str, name: str):
    """Uncordon a node (mark as schedulable)."""
    context = get_eks_context(cluster)
    cmd = ["uncordon", name]

    try:
        result = subprocess.run(
            ["kubectl", "--context", context] + cmd,
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            raise HTTPException(status_code=400, detail=result.stderr)
        return {"success": True, "message": result.stdout}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Command timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/clusters/{cluster}/nodes/{name}/drain")
def drain_node(cluster: str, name: str, force: bool = False, ignore_daemonsets: bool = True):
    """Drain a node (evict all pods)."""
    context = get_eks_context(cluster)
    cmd = ["drain", name, "--delete-emptydir-data"]
    if force:
        cmd.append("--force")
    if ignore_daemonsets:
        cmd.append("--ignore-daemonsets")

    try:
        result = subprocess.run(
            ["kubectl", "--context", context] + cmd,
            capture_output=True, text=True, timeout=120
        )
        if result.returncode != 0:
            raise HTTPException(status_code=400, detail=result.stderr)
        return {"success": True, "message": result.stdout}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Command timed out - drain may still be in progress")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/clusters/{cluster}/pods/{namespace}/{name}/containers")
def get_pod_containers(cluster: str, namespace: str, name: str):
    """Get list of containers in a pod."""
    context = get_eks_context(cluster)
    data = run_kubectl(["get", "pod", name, "-n", namespace], context)

    if "error" in data:
        return {"containers": [], "error": data["error"]}

    containers = []
    spec = data.get("spec", {})

    # Regular containers
    for c in spec.get("containers", []):
        containers.append({"name": c.get("name"), "type": "container"})

    # Init containers
    for c in spec.get("initContainers", []):
        containers.append({"name": c.get("name"), "type": "init"})

    return {"containers": containers, "error": None}


@app.get("/api/clusters/{cluster}/events")
def get_cluster_events(cluster: str, namespace: Optional[str] = None, field_selector: Optional[str] = None, limit: int = 100):
    """Get cluster events, optionally filtered by namespace or field selector."""
    context = get_eks_context(cluster)
    cmd = ["get", "events", "--sort-by=.lastTimestamp", f"--limit={limit}"]

    if namespace and namespace != "__all__":
        cmd.extend(["-n", namespace])
    else:
        cmd.append("-A")

    if field_selector:
        cmd.extend(["--field-selector", field_selector])

    data = run_kubectl(cmd, context)

    if "error" in data:
        return {"events": [], "error": data["error"]}

    events = []
    for item in data.get("items", []):
        metadata = item.get("metadata", {})
        involved = item.get("involvedObject", {})
        events.append({
            "namespace": metadata.get("namespace", ""),
            "name": metadata.get("name", ""),
            "type": item.get("type", ""),
            "reason": item.get("reason", ""),
            "message": item.get("message", ""),
            "source": item.get("source", {}).get("component", ""),
            "involvedObject": f"{involved.get('kind', '')}/{involved.get('name', '')}",
            "count": item.get("count", 1),
            "firstTimestamp": item.get("firstTimestamp", ""),
            "lastTimestamp": item.get("lastTimestamp", ""),
            "age": calculate_age(metadata.get("creationTimestamp", "")),
        })

    return {"events": events, "error": None}


# ============================================================================
# OPS · CI TRIGGERS (SCK — on-demand GitHub Actions workflow_dispatch)
# ============================================================================
#
# On-demand button for verification workflows the operator wants to fire
# outside cron — e.g. "verify a fresh PyPI install of the CLI still works
# end-to-end". Every entry is server-side allowlisted; the UI never dispatches
# a filename the caller made up.
#
# Auth: SYSTEM-only (both the ASGI JWT middleware above and the per-route
# `require_system_user` dependency). Audit lines land on stdout so fluent-bit
# in the control ns picks them up per the ns-label pattern.
#
# GitHub auth: fine-scoped PAT with `actions:write` on the allowlisted repos,
# read from env `GH_OPS_DISPATCH_TOKEN`. Missing/empty → 503 with a friendly
# "not configured" body (safe soft-launch — the Run button surfaces the
# server-side reason rather than blowing up).
# ============================================================================

import httpx  # noqa: E402  — grouped with the ops block for locality
from datetime import datetime, timezone as _tz  # noqa: E402


class CiTrigger(BaseModel):
    """Public shape returned from GET /api/ops/ci-triggers."""

    id: str
    name: str
    description: str
    target_repo: str  # "owner/repo"
    workflow_filename: str
    ref: str


# v0 allowlist. Adding a new entry is a code change on purpose — the whole
# point of an allowlist is that the surface area is grep-able. New rows land
# with a follow-up PR (no runtime config, no DB row, no admin form).
CI_TRIGGERS_ALLOWLIST: List[CiTrigger] = [
    CiTrigger(
        id="int-tests-pypi-fresh-install",
        name="Verify fresh PyPI install works",
        description=(
            "Runs the integration-tests harness that installs the c2a CLI "
            "from PyPI into a clean venv and exercises the smoke path — "
            "catches PyPI publish regressions before customers do."
        ),
        target_repo="clue2solve/clue2app-integration-tests",
        workflow_filename="pypi-fresh-install.yml",
        ref="main",
    ),
]

_CI_TRIGGERS_INDEX: Dict[str, CiTrigger] = {t.id: t for t in CI_TRIGGERS_ALLOWLIST}


def _gh_token() -> Optional[str]:
    tok = os.environ.get("GH_OPS_DISPATCH_TOKEN", "").strip()
    return tok or None


def _gh_headers(token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "clue2app-admin-ops-ci/1.0",
    }


def _audit_log(event: str, **fields: Any) -> None:
    """Structured JSON audit line on stdout. Fluent-bit in the control ns
    scoops it via the ns label pattern per fluentbit_log_capture memo.
    Fire-and-forget: audit never blocks the mutation."""
    try:
        payload = {
            "audit": True,
            "event": event,
            "ts": datetime.now(_tz.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            **fields,
        }
        # print is line-buffered under uvicorn — one line per audit row.
        print(json.dumps(payload, default=str), flush=True)
    except Exception:
        # Never let audit-log formatting break the request.
        pass


def _fetch_last_run(trigger: CiTrigger, token: str) -> Optional[Dict[str, Any]]:
    """Ask GH for the most recent workflow_dispatch run on this workflow.
    Returns a compact shape the UI renders directly, or None on any error
    (the UI treats missing last-run as "no history yet")."""
    owner, repo = trigger.target_repo.split("/", 1)
    url = (
        f"https://api.github.com/repos/{owner}/{repo}"
        f"/actions/workflows/{trigger.workflow_filename}/runs"
    )
    try:
        with httpx.Client(timeout=8.0) as client:
            resp = client.get(
                url,
                headers=_gh_headers(token),
                params={"per_page": 1, "event": "workflow_dispatch"},
            )
        if resp.status_code != 200:
            return None
        runs = resp.json().get("workflow_runs") or []
        if not runs:
            return None
        r = runs[0]
        return {
            "run_id": r.get("id"),
            "run_number": r.get("run_number"),
            "status": r.get("status"),  # queued | in_progress | completed
            "conclusion": r.get("conclusion"),  # success | failure | cancelled | ...
            "html_url": r.get("html_url"),
            "created_at": r.get("created_at"),
            "updated_at": r.get("updated_at"),
            "actor": (r.get("actor") or {}).get("login"),
            "event": r.get("event"),
        }
    except Exception:
        return None


@app.get("/api/ops/ci-triggers")
def list_ci_triggers(claims: Dict[str, Any] = Depends(require_system_user)):
    """List the on-demand CI triggers the operator is allowed to fire.
    Includes the last workflow_dispatch run (or null) for each row so the
    UI shows outcome state at first paint."""
    _ = claims
    token = _gh_token()
    triggers_out: List[Dict[str, Any]] = []
    for t in CI_TRIGGERS_ALLOWLIST:
        row: Dict[str, Any] = t.model_dump()
        row["last_run"] = _fetch_last_run(t, token) if token else None
        triggers_out.append(row)
    return {
        "triggers": triggers_out,
        "gh_token_configured": token is not None,
    }


@app.post("/api/ops/ci-triggers/{trigger_id}/run")
def run_ci_trigger(
    trigger_id: str, claims: Dict[str, Any] = Depends(require_system_user)
):
    """Fire the allowlisted workflow_dispatch.
    Server-side allowlist enforcement — the client can't dispatch anything
    that isn't in `CI_TRIGGERS_ALLOWLIST` (unknown id → 404, and even a
    matched id maps to a fixed repo+workflow_filename+ref the client can't
    override). Missing GH token → 503 with a clear reason."""
    trigger = _CI_TRIGGERS_INDEX.get(trigger_id)
    if trigger is None:
        # Do not echo `trigger_id` into the error (defence-in-depth against
        # log-injection from a hostile caller — cheap and easy).
        raise HTTPException(status_code=404, detail="unknown ci trigger id")

    token = _gh_token()
    if token is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "GH_OPS_DISPATCH_TOKEN not configured on this admin instance "
                "— an operator must mint a fine-scoped PAT with actions:write "
                "on the target repo and mount it before this button will fire."
            ),
        )

    actor = claims.get("sub") or claims.get("email") or "unknown"
    owner, repo = trigger.target_repo.split("/", 1)
    url = (
        f"https://api.github.com/repos/{owner}/{repo}"
        f"/actions/workflows/{trigger.workflow_filename}/dispatches"
    )
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(
                url, headers=_gh_headers(token), json={"ref": trigger.ref}
            )
    except httpx.HTTPError as e:
        _audit_log(
            "ops.ci.dispatch",
            actor=actor,
            trigger_id=trigger.id,
            target_repo=trigger.target_repo,
            workflow_filename=trigger.workflow_filename,
            ref=trigger.ref,
            outcome="network_error",
            error=str(e),
        )
        raise HTTPException(status_code=502, detail=f"GitHub dispatch failed: {e}")

    _audit_log(
        "ops.ci.dispatch",
        actor=actor,
        trigger_id=trigger.id,
        target_repo=trigger.target_repo,
        workflow_filename=trigger.workflow_filename,
        ref=trigger.ref,
        outcome="dispatched" if resp.status_code == 204 else "gh_error",
        gh_status=resp.status_code,
    )

    if resp.status_code != 204:
        # GH's error body is JSON; surface `message` to help the operator
        # (missing scope, wrong ref, workflow not found on the ref, …).
        gh_message: Optional[str] = None
        try:
            gh_message = (resp.json() or {}).get("message")
        except Exception:
            pass
        raise HTTPException(
            status_code=502,
            detail=(
                f"GitHub dispatch returned {resp.status_code}"
                + (f": {gh_message}" if gh_message else "")
            ),
        )

    # GH's dispatches endpoint returns 204 with no body and no run id — the
    # new run appears asynchronously on the workflow's runs listing. Give
    # it a beat, then look up the latest run so the UI can jump straight
    # to it (Actions API is eventually consistent — best-effort).
    last_run = _fetch_last_run(trigger, token)

    return {
        "trigger_id": trigger.id,
        "dispatched": True,
        "last_run": last_run,
    }


# Serve static frontend files if they exist (for production Docker deployment)
static_path = Path(__file__).parent / "static"
if static_path.exists():
    # Serve static assets
    app.mount("/assets", StaticFiles(directory=static_path / "assets"), name="assets")

    # Catch-all route for SPA - must be last
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        # If it's an API route, let it 404 naturally
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        # Serve index.html for all other routes (SPA routing)
        return FileResponse(static_path / "index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=BACKEND_PORT)
