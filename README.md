# GarudAI — Multi-Tenant AI CCTV SaaS

AI-powered CCTV monitoring for businesses. Each customer signs up, gets a fully
**isolated organization/workspace**, and manages their own sites, cameras, AI
rules, events, evidence, alerts, reports, users and billing.

The number-one design goal is **absolute customer data isolation**: Organization
A can never see, query, modify, download, stream, or infer any data belonging to
Organization B — enforced at the database, backend, and storage layers, and
proven by an automated cross-tenant security test suite.

---

## Security model (defense in depth)

Isolation is enforced at **three independent layers**, so a bug in one layer is
still caught by the others:

1. **PostgreSQL Row Level Security (deepest layer).** Every tenant-owned table
   has `organization_id UUID NOT NULL` and RLS policies for
   SELECT/INSERT/UPDATE/DELETE. The application connects as a **non-superuser
   role (`garudai_app`) with `NOBYPASSRLS`**, so the database itself refuses to
   return or mutate rows outside the caller's organization. Policies read the
   current tenant from transaction-local settings:

   ```sql
   SET LOCAL app.current_org       = '<org uuid>';
   SET LOCAL app.current_user      = '<user uuid>';
   SET LOCAL app.is_platform_admin = 'off';
   ```

   If `app.current_org` is unset, every policy evaluates to **false → zero rows,
   no writes** (fail closed). Migrations run as a separate superuser role that is
   never used to serve user requests.

2. **Backend authorization.** A per-request tenant context is derived from the
   authenticated **server-side session** (never from client-supplied ids). The
   centralized helpers live in `server/src/middleware/context.ts`:
   `requireAuth`, `getAuthenticatedUser`, `requireOrganizationMembership`,
   `getCurrentOrganization`, `requirePermission`, `requirePlatformAdmin`,
   `tenantDb`, `platformDb`. Every tenant query runs inside `tenantDb(req, …)`
   which opens a transaction and applies the `SET LOCAL` GUCs above.

3. **Frontend (display only).** The React app renders whatever the API returns
   and enforces nothing security-relevant. All authorization happens server-side.

### Key properties

- **No global tenant state.** Tenant context is transaction-local, resolved
  independently per request — safe under concurrency (see the concurrency test).
- **IDOR → 404.** Requesting another tenant's resource returns `404` (not `403`)
  so an attacker cannot even confirm a resource id exists elsewhere.
- **Client can never switch tenants** by changing an id / URL / body / header /
  query param — the active org comes from the verified session + membership.
- **Encrypted camera credentials** (AES-256-GCM) — never returned to the browser,
  never logged, decrypted only server-side.
- **Private evidence storage** with short-lived HMAC-signed URLs bound to
  `{organization, key, expiry}`; access also re-checks org membership.
- **Tenant-scoped cache keys** (`tenant:{org}:…`), **per-org WebSocket channels**
  (no global broadcast), **tenant-scoped search / reports / exports / billing /
  audit**, and **background jobs that re-validate resource ownership** under RLS.
- **Fail closed everywhere**: unauthenticated / unresolved tenant / unverified
  ownership → deny.

---

## Architecture

```
Platform
 └─ Organizations (tenants)
     └─ Users (via organization_members: OWNER / ADMIN / OPERATOR / VIEWER)
     └─ Sites → Zones → Cameras → AI Rules
                                   └─ Events → Detections / Evidence
     └─ Notifications / Notification Rules
     └─ Reports / Subscriptions / Invoices / Audit Logs
```

Event pipeline (tenant context preserved at every step):

```
Camera → Media service → AI inference → rule engine → event → evidence
       → notification (tenant recipients only) → dashboard (tenant WebSocket)
```

### Tech stack

- **Backend:** Node.js + TypeScript + Express, `pg`, `argon2`, `ws`, `zod`,
  `helmet`, rate limiting. PostgreSQL 16 with RLS.
- **Frontend:** React 18 + TypeScript + Vite + React Router.
- **Tests:** Vitest + Supertest against a real, migrated PostgreSQL database.

### RBAC roles

| Role     | Capability |
|----------|------------|
| `OWNER`  | Full control incl. billing + user management |
| `ADMIN`  | Operational management (sites, cameras, rules, users) |
| `OPERATOR` | Camera monitoring + incident handling (ack/resolve) |
| `VIEWER` | Read-only |
| `PLATFORM_ADMIN` | Global flag (not an org role) — controlled platform-level access |

---

## Repository layout

```
server/                Backend (Express + PostgreSQL RLS)
  src/db/migrations/    SQL migrations incl. all RLS policies
  src/middleware/       Tenant context + auth + RBAC
  src/services/         auth, membership, storage, cache, stream, notifications…
  src/routes/           REST API (/api/*)
  src/jobs/worker.ts    Tenant-validating AI job processor
  src/realtime/         Per-tenant WebSocket hub
  src/tests/            61 automated security/isolation tests
web/                   Frontend (React SPA), built + served by the API in prod
scripts/
  with-postgres.sh      Boots an ephemeral PostgreSQL + runs a command against it
  pentest-gate.sh       Live-server cross-tenant penetration gate
```

---

## Getting started

> **Deploying for free?** See **[DEPLOY.md](./DEPLOY.md)** for a step-by-step
> zero-cost setup — Web UI on **Vercel**, API on **Render** free tier, Postgres
> on **Neon** free tier, mapped to a custom domain (GoDaddy DNS). The live
> camera/AI pipeline runs locally (no free always-on host for continuous video).

### Prerequisites

- Node.js ≥ 20
- PostgreSQL 16 (or use the bundled ephemeral harness — see below)

### Install

```bash
npm install
cp .env.example .env   # then fill in strong secrets
```

Generate secrets:

```bash
openssl rand -hex 32   # SESSION_SECRET / STORAGE_URL_SIGNING_KEY
openssl rand -hex 32   # CREDENTIAL_ENCRYPTION_KEY (must be 64 hex chars)
```

### Database roles

Create two roles (see `.env.example` for connection strings):

- `garudai_app` — `NOSUPERUSER NOBYPASSRLS` (application / RLS-enforced)
- a superuser — migrations only (never serves requests)

### Run migrations + seed a demo org

```bash
npm run db:migrate
npm run db:seed        # creates the isolated DEMO organization
```

### Develop

```bash
npm run dev:server     # API on :4000
npm run dev:web        # Vite dev server on :5173 (proxies /api and /ws)
```

### Production build

```bash
npm run build          # builds server (dist) + web (dist)
npm --workspace server start   # serves API + the built SPA as one unit
```

---

## Testing (the important part)

This repo ships a **self-contained Postgres harness** (`scripts/with-postgres.sh`)
that boots an ephemeral PostgreSQL 16 instance, creates the app DB + the
`NOBYPASSRLS` app role, runs your command, then tears everything down — so tests
run against a **real database with RLS actually enforced**, with no external
setup.

```bash
# Full security + functional suite (migrations + 99 tests)
npm test

# Live-server cross-tenant penetration gate (BUILD → BREAK → verify)
npm run pentest
```

### What is tested (99 automated tests: 61 core + 38 safety/security)

- **Database RLS** — SELECT/UPDATE/DELETE/INSERT blocked cross-tenant; fail-closed
  with no context; app role confirmed `NOBYPASSRLS`.
- **Cross-tenant IDOR** — GET/POST/PATCH/DELETE against the other tenant's ids,
  both directions; every attempt denied (404) and no data returned.
- **Data leakage** — no B identifier appears in any A endpoint or CSV export; no
  credential fields ever serialized.
- **Storage** — signed evidence URLs bound to org+key+expiry; membership
  re-checked; tampered params rejected.
- **Stream / cache / WebSocket** — stream tokens bound to the camera; cache keys
  tenant-namespaced; a publish reaches only the target org's subscribers.
- **Search / reports / billing / audit** — every surface scoped to the caller.
- **RBAC** — role permission matrix; unauthenticated requests denied.
- **Background jobs** — a forged job referencing another tenant's camera is
  rejected (validated under RLS) and creates nothing.
- **Concurrency** — interleaved A/B requests never leak context.
- **Demo mode** — demo org data never appears in a real customer's views.
- **Safety & Security (add-on):** fire/smoke event creation, fire+smoke
  correlation, alert cooldown/dedup, all security event types, false-positive
  threshold control, incident lifecycle + notes, config CRUD, tenant-scoped
  reports, cross-tenant attacks on every new resource (both directions),
  DB-layer RLS on the 5 new tables, and forged-job rejection.

---

## AI capabilities

Person detection, vehicle detection, restricted-area intrusion, line crossing,
loitering, crowd detection, helmet detection, safety-vest detection. The rule /
event model is extensible for future models.

---

## Safety & Security AI (add-on)

An additive module that extends — never replaces — the existing AI event
pipeline (camera → inference → rule engine → event → evidence → notification →
dashboard). It is fully tenant-isolated like everything else.

### Detection categories
- **Fire & Safety:** `FIRE` (CRITICAL), `SMOKE` (HIGH), `FIRE_AND_SMOKE` (CRITICAL).
- **Theft / Security:** `UNAUTHORIZED_ENTRY`, `AFTER_HOURS_ACTIVITY`,
  `OBJECT_REMOVED`, `LOITERING_SECURITY`, `UNAUTHORIZED_VEHICLE`,
  `RESTRICTED_ZONE_ACTIVITY`.

The UI uses professional, non-overclaiming language ("Potential Theft",
"Unauthorized Activity", "Fire Detected" with confidence + evidence) — it never
asserts criminal intent. No face recognition or biometric identification.

### Fire + smoke correlation
If FIRE and SMOKE are detected on the same camera within a 60s window they are
correlated into a single `FIRE_AND_SMOKE` critical incident — not thousands of
duplicate alerts.

### Alert cooldown / deduplication
Each `{camera, category}` has a configurable cooldown (durable, tenant-scoped in
`alert_cooldowns`). Continuous fire produces ONE incident + one alert, then
evidence/updates are appended; a new alert is only sent after the cooldown
expires. This prevents alert storms (100 emails/SMS per continuous fire).

### False-positive control
Per-rule `min_confidence` threshold and `min_duration_ms` minimum observed
duration must both be satisfied before a critical incident is created.

### Incident workflow
Statuses extended to `OPEN → ACKNOWLEDGED → INVESTIGATING → RESOLVED`, plus
`FALSE_POSITIVE` and `DISMISSED`. Operators add notes (`incident_notes`); every
status change and note is written to the existing audit log.

### Configuration (all tenant-scoped)
- **AI rules** per camera/zone: type, severity, confidence, cooldown, min
  duration, notification channels (`EMAIL`/`SMS`/`WHATSAPP`/`PUSH`/`IN_APP`/`WEBHOOK`), model.
- **Zone schedules** (`zone_schedules`) for after-hours activity (per org/site/zone).
- **Monitored objects** (`monitored_objects`) for object-removed detection.
- **AI models** (`ai_models`) — the model abstraction (type/version/threshold).

### AI model architecture & environment limitations
The platform is model-agnostic: `server/src/ai/model.ts` defines an
`InferenceAdapter` interface and a registry keyed by model type (person,
vehicle, fire, smoke, object-tracking, generic-security). **Production**
deployments register real, GPU-backed inference adapters (e.g. a fire/smoke
classifier and object detector served as a microservice).

**This repository ships only an explicitly-labelled DEMO adapter** (`isDemo =
true`) used for sales demos and the automated test suite; it performs no real
computer vision and is enabled only when `NODE_ENV !== 'production'`. It can
never masquerade as a production model — if no production adapter is registered,
inference fails loudly rather than fabricating detections. **Real fire/smoke/
object detection therefore requires:** (1) a trained model + inference service
(GPU recommended), (2) live camera/RTSP feeds reachable by the media service,
and (3) registering the corresponding adapter at startup. The full API,
pipeline, storage, alerting, cooldown, correlation, incident workflow, RLS and
UI are production-ready and independent of which adapter is plugged in.

### New API endpoints (all auth + membership + RBAC + RLS enforced)
`GET/POST/PATCH/DELETE /api/ai-models`, `GET/POST/DELETE /api/zone-schedules`,
`GET/POST/DELETE /api/monitored-objects`, `GET /api/events/security/list`,
`GET/POST /api/events/:id/notes`, `GET /api/dashboard/security`,
`GET /api/reports/fire-safety/data`, `GET /api/reports/security/data`. Existing
`/api/events/ingest` and the background worker now route safety/security types
through the detection engine (camera ownership re-validated under RLS first).

---

## Secrets

Never commit real secrets. `.env` is git-ignored; use `.env.example` as a
template. Camera credentials, storage credentials, session/encryption/signing
keys and DB passwords all come from environment variables.


---

## Real CCTV / RTSP + production AI inference (add-on)

GarudAI can connect to a real IP camera/NVR over RTSP, continuously ingest
frames, run **real** computer-vision inference, and drive the existing event →
evidence → notification → dashboard pipeline — all tenant-isolated. This is an
additive layer; nothing in the existing platform changed.

### Architecture

```
IP camera / NVR ──RTSP──▶ Media worker (FFmpeg)
                            ├─ frame sampler (inference_fps)
                            └─ RTSP→HLS transcode (on demand)
   frames ──▶ Inference service (FastAPI + OpenCV/ONNX)  ──detections──▶
   Media worker ──POST /api/internal/detections (worker token)──▶ API
     └─ rule engine (zone/schedule/tracking) ─▶ processDetection
        └─ event ─▶ evidence (private, signed URL) ─▶ notification ─▶ WebSocket ─▶ dashboard
   Browser ──GET /api/cameras/:id/live──▶ authorized HLS (never RTSP/credentials)
```

Three separate processes: **API** (`server/dist/index.js`), **media worker**
(`server/dist/media-worker.entry.js`), **inference service**
(`inference-service/`). Heavy FFmpeg/CV work never blocks the API.

### Security invariants (new surface)
- **RTSP credentials** are encrypted at rest, decrypted only server-side inside
  the media/HLS path, redacted in every log (`rtsp://user:***@host`), and never
  returned to the browser, put in WebSocket payloads, or embedded in stream URLs.
- **Live streaming** is HLS only; the browser gets a short-lived **signed**
  manifest URL. Manifest/segment requests re-verify authentication + org
  membership + camera ownership (RLS) + signature. HLS output is written to a
  private, org-namespaced directory.
- **Internal media-worker API** (`/api/internal/*`) requires a bearer worker
  token AND still validates every job's `organizationId`/`cameraId` under RLS —
  the token grants no cross-tenant power. A forged job (org A + camera B) returns
  404 and creates nothing.
- New tenant tables (`camera_health_events`, `inference_stats`) have
  `organization_id NOT NULL` + FORCE RLS + 4 policies, like everything else.

### No fake production AI
- The inference service performs **real** analysis: OpenCV HOG people detection,
  a classical HSV/segmentation fire/smoke detector, and an optional ONNX
  object-detection backend. It never fabricates or randomly generates detections.
- The Node `ProductionInferenceAdapter` fails **closed**: if the service is
  unreachable/times out/returns malformed data, the pipeline reports
  `INFERENCE_UNAVAILABLE` — it never invents a detection and never silently falls
  back to the demo adapter.
- In **production** the demo adapter is disabled and the API **refuses to start**
  without `INFERENCE_SERVICE_URL`. The UI shows the real mode: **AI Active**
  (production adapter reachable), **Demo AI** (dev/test only), or **Inference
  Offline** — sourced from backend state, never hardcoded.

### Run the full stack with Docker

```bash
cp .env.example .env    # set SESSION_SECRET, CREDENTIAL_ENCRYPTION_KEY,
                        # STORAGE_URL_SIGNING_KEY, MEDIA_WORKER_TOKEN (openssl rand -hex 32)
docker compose up --build
# API + web UI on http://localhost:4000  (inference + worker stay on the private network)
```

Services: `db` (Postgres, creates the `garudai_app` NOBYPASSRLS role),
`inference` (FastAPI CV service), `api` (API + built SPA), `media-worker`.
For GPU inference, install the NVIDIA container toolkit and uncomment the `deploy`
block under the `inference` service; supply a trained detection model via
`ONNX_MODEL_PATH` + `ONNX_LABELS`.

### Run locally without Docker (dev)

```bash
# 1) DB + migrate + seed (see the earlier Testing section for the ephemeral harness)
npm run db:migrate && npm run db:seed
# 2) Inference service (real CV)
cd inference-service && python -m venv .venv && . .venv/bin/activate \
  && pip install -r requirements.txt && uvicorn app.main:app --port 8100
# 3) API  (set INFERENCE_SERVICE_URL=http://localhost:8100 in .env)
npm run dev:server
# 4) Media worker
npm --workspace server run dev:media-worker
# 5) Web
npm run dev:web
```

### Connect a real IP camera (step by step)

1. **Find the RTSP URL.** Consult your camera/NVR manual — the path varies by
   manufacturer, e.g. Hikvision `/Streaming/Channels/101`, Dahua
   `/cam/realmonitor?channel=1&subtype=0`, generic `/stream1`. Format:
   `rtsp://USERNAME:PASSWORD@CAMERA_IP:554/STREAM_PATH` (placeholders only — never
   commit a real password).
2. **Create the camera** in GarudAI (Cameras → Add camera): name, site, RTSP
   host/IP, port, path, stream profile, username, password, and optionally enable
   AI inference + set inference FPS.
3. **Test connection** — click *Test*. The server probes the RTSP stream with
   ffprobe and shows a safe result (`CONNECTED` + latency/resolution, or
   `AUTH_FAILED` / `UNREACHABLE` / `INVALID_STREAM`). Credentials are never shown.
4. **Start the media worker** (Docker service, or `dev:media-worker`). It picks
   up enabled cameras, samples frames at `inference_fps`, and runs inference.
5. **Ensure the inference service is running** (Docker service, or step 2 above).
   The Live Monitoring page shows **AI Active** when it's reachable.
6. **View the live stream** — open Live Monitoring and click a camera tile. The
   browser plays authorized HLS (via hls.js / native). The RTSP URL never reaches
   the browser.
7. **Generate a real event** — walk into view / trigger a monitored condition;
   the worker's detections flow through the rule engine into events + evidence.
8. **View evidence** — open the event; evidence loads via a short-lived signed
   URL. **Receive alerts** — configure notification rules (Alerts page); matching
   events dispatch to your org's recipients only.

### Local test camera (no physical CCTV)

For development/testing without hardware, set `ALLOW_VIDEO_FILE_SOURCE=true` and
create a camera with `sourceKind=VIDEO_FILE_TEST_SOURCE` pointing at a local MP4.
The video source is simulated, but frames still flow through the **real** FFmpeg
→ inference → event pipeline. This is clearly labelled and cannot be enabled in
production unless explicitly configured.

### Environment / model requirements
- **FFmpeg + ffprobe** must be installed for the API (probing/HLS) and media
  worker (ingest). The provided Docker images include them.
- **Real object detection** (person/vehicle beyond HOG, production-grade
  fire/smoke) requires a trained model served by the inference service (ONNX via
  `ONNX_MODEL_PATH`, GPU recommended for multiple cameras / real-time FPS). The
  bundled OpenCV detectors are real but classical and CPU-oriented.
