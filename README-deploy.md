# aws-dashboard — c2a deployment guide

Target: deploy `aws-dashboard` as a Knative service on the c2a platform
(`control` project namespace), reachable at
`aws-dashboard.control.apps.clue2.app`. All API endpoints require a valid
c2a JWT with `userType == "SYSTEM"`.

---

## 1. IAM policy for the Cost Explorer read-only user

Create a dedicated IAM user (e.g. `aws-dashboard-ce-reader`) with only the
permissions this app needs. Cost Explorer is a us-east-1-only service, so
regardless of where the app runs the client must be pinned to us-east-1.

Attach this inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CostExplorerRead",
      "Effect": "Allow",
      "Action": [
        "ce:GetCostAndUsage",
        "ce:GetCostAndUsageWithResources",
        "ce:GetCostForecast",
        "ce:GetDimensionValues",
        "ce:GetTags",
        "ce:GetReservationUtilization",
        "ce:GetSavingsPlansUtilization",
        "ce:DescribeCostCategoryDefinition",
        "ce:ListCostCategoryDefinitions"
      ],
      "Resource": "*"
    },
    {
      "Sid": "OrgReadForAccountNames",
      "Effect": "Allow",
      "Action": [
        "organizations:ListAccounts",
        "organizations:DescribeAccount"
      ],
      "Resource": "*"
    }
  ]
}
```

Generate an access key pair for this user. You'll paste both halves into
c2a as env vars in step 3.

> Note: `GetCostAndUsageWithResources` is required for `/api/costs/top-resources`.
> If you don't need that endpoint, drop it plus the `organizations:*` block.

---

## 2. Create the c2a app

The repo layout has the FastAPI service under `aws-dashboard/backend/`. The
kpack Image must point at that subdirectory so the Paketo Python buildpack
sees `requirements.txt` + `Procfile` at the build-context root.

### 2a. Via `c2a` CLI

```bash
c2a use project control

c2a create app \
  --name aws-dashboard \
  --repo https://github.com/clue2solve/clue2app \
  --branch main \
  --subdirectory aws-dashboard/backend \
  --runtime python \
  --port 8080
```

(`--subdirectory` maps to the kpack Image `source.git.subPath` field. Verify
with `kubectl -n control get image aws-dashboard -o yaml | grep -A3 source:`.)

### 2b. Via the console UI

1. Log in as a SYSTEM user at <https://console.clue2.app>.
2. Project → `control` → **Add app**.
3. GitHub source → repo `clue2solve/clue2app`, branch `main`.
4. **Root directory** field: `aws-dashboard/backend` (this is the critical
   knob — leave it blank and kpack tries to build the monorepo root and
   fails).
5. Runtime: Python (Paketo). Port: `8080`.
6. Save. First build takes ~4 minutes.

### 2c. Frontend static assets

> **Current source of `backend/static/`:** branch `static-src/sck-755`, the
> deployed frontend baseline (670ecfc) plus the agents call-site change from
> #69. Until the frontend upgrade (MUI 9 / React 19) ships in its own PR,
> rebuild `backend/static/` from that branch, not from `frontend/` on `main`:
> `git worktree add /tmp/admin-static origin/static-src/sck-755`, then
> `npm ci && npm run build` in its `frontend/`, and copy `dist/**` into
> `backend/static/`.

`build.sh` builds the React frontend and copies `frontend/dist/**` into
`backend/static/`. For the c2a kpack build to serve the SPA, that static
directory must exist at build time. Two options:

- **Recommended for now**: commit `backend/static/` to the repo (add a
  `frontend-build` step to your release workflow so the committed copy is
  always current).
- **Later**: split into two c2a apps — a Node app for the frontend build and
  this Python app for the API + reverse-proxy the SPA in front. Overkill for
  phase 1.

---

## 3. Env-var injection

The app reads five runtime env vars. Set them via `c2a` after the app exists.

### 3a. `C2A_JWT_SECRET` — reuse the platform secret (do not mint a new one)

The coordinator + auth-service already have `JWT_SECRET_KEY` set to a
base64-encoded HMAC secret. aws-dashboard needs the **same value** under the
name `C2A_JWT_SECRET`. The recommended path is to bind directly to the
existing platform secret so rotations propagate automatically:

```bash
# List platform secrets to confirm the source name.
c2a secrets list -n control | grep -i jwt

# Bind the coordinator's JWT secret into aws-dashboard as C2A_JWT_SECRET.
c2a secrets bind \
  --app aws-dashboard \
  --secret jwt-secret-key \
  --key JWT_SECRET_KEY \
  --as C2A_JWT_SECRET
```

(Under the hood this goes through `PUT /api/kn-service/{name}` — see
`service_binding_architecture.md` in MEMORY. Do NOT `kubectl patch` the
envFrom directly; `serviceBindingCreateUpdate` will overwrite it on the
next lifecycle event.)

Verify:

```bash
kubectl -n control get ksvc aws-dashboard -o yaml | grep -A2 C2A_JWT_SECRET
```

### 3b. `C2A_LOGIN_URL` — plain env var

```bash
c2a set env --app aws-dashboard \
  C2A_LOGIN_URL=https://console.clue2.app/login
```

(Frontend uses the `/sso-handoff` route added on the console side —
`https://console.control.apps.clue2.app/sso-handoff?returnTo=<url>` — but the
`C2A_LOGIN_URL` fallback stays available for any legacy redirect path.)

### 3c. AWS Cost Explorer credentials

Create a c2a secret from the IAM access key you generated in step 1, then
bind it:

```bash
c2a secrets create aws-dashboard-ce \
  --from-literal AWS_ACCESS_KEY_ID=AKIA... \
  --from-literal AWS_SECRET_ACCESS_KEY=...

c2a secrets bind --app aws-dashboard --secret aws-dashboard-ce

c2a set env --app aws-dashboard AWS_REGION=us-east-1
```

Cost Explorer only lives in us-east-1 — the workload region is irrelevant,
but the boto3 client MUST use us-east-1.

### 3d. Full env-var summary

| Var                     | Source                                                | Purpose                                     |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------- |
| `C2A_JWT_SECRET`        | bound from `jwt-secret-key` secret (base64 HMAC)      | Verify JWTs; base64-decode before PyJWT     |
| `C2A_LOGIN_URL`         | plain env                                             | Fallback console URL for unauth redirects   |
| `AWS_ACCESS_KEY_ID`     | `aws-dashboard-ce` secret                             | boto3 Cost Explorer client                  |
| `AWS_SECRET_ACCESS_KEY` | `aws-dashboard-ce` secret                             | boto3 Cost Explorer client                  |
| `AWS_REGION`            | plain env, always `us-east-1`                         | Cost Explorer regional endpoint             |
| `PORT`                  | injected by Knative (usually 8080)                    | Uvicorn bind port (Procfile reads `$PORT`)  |

---

## 4. Custom domain

```bash
c2a domains assign \
  --app aws-dashboard \
  --domain aws-dashboard.control.apps.clue2.app
```

The `control.apps.clue2.app` wildcard is already provisioned, so no DNS
changes are needed — the assignment propagates through Knative's
DomainMapping in ~30 seconds.

Confirm:

```bash
c2a domains status --app aws-dashboard
curl -I https://aws-dashboard.control.apps.clue2.app/api/health
```

---

## 5. Post-deploy smoke check

Wait for build + rollout (`c2a build list --app aws-dashboard` should show
the latest build `Succeeded`, and `kubectl -n control get ksvc
aws-dashboard` should show `READY=True`).

### 5a. Health check (no auth)

```bash
curl -sSf https://aws-dashboard.control.apps.clue2.app/api/health
# → 200 { "status": "healthy" }
```

### 5b. Unauth request → 401

```bash
curl -si https://aws-dashboard.control.apps.clue2.app/api/costs/summary
# → HTTP/2 401
# → { "error": "UNAUTHORIZED", "message": "missing bearer token" }
```

### 5c. Authenticated SYSTEM user request → 200

Grab a JWT from a browser session (SYSTEM user only):

```bash
# In the console tab devtools console:
#   copy(sessionStorage.getItem("c2a_token"))

TOKEN='<paste>'

curl -si \
  -H "Authorization: Bearer $TOKEN" \
  https://aws-dashboard.control.apps.clue2.app/api/costs/summary
# → HTTP/2 200
# → { "currency": "USD", "mtd": { ... }, "generated_at": "...Z" }
```

### 5d. ACCOUNT user token → 403

Any non-SYSTEM JWT should fail closed:

```bash
curl -si \
  -H "Authorization: Bearer $ACCOUNT_TOKEN" \
  https://aws-dashboard.control.apps.clue2.app/api/costs/summary
# → HTTP/2 403
# → { "error": "FORBIDDEN", "message": "SYSTEM users only" }
```

If 5c returns 401 with `"invalid token"`, the most common cause is
forgetting to base64-decode `C2A_JWT_SECRET` inside `require_system_user`.
The secret in the env var is base64-encoded; PyJWT needs the raw bytes. See
`design contract → jwt_verify_recipe` for the reference implementation.

---

## Rollback

```bash
c2a build list --app aws-dashboard
c2a rebuild app --app aws-dashboard --build <previous-succeeded-build-id>
```

Or, for env-var mistakes, unset then re-set:

```bash
c2a set env --app aws-dashboard --unset C2A_LOGIN_URL
```

Knative will roll a new revision on any env change; traffic shifts to 100%
of the new revision after readiness. The previous revision remains
addressable via its `-<hash>` subdomain if you need to A/B while
debugging.
