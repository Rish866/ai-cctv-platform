# SentriAI — Multi-Tenant AI CCTV SaaS

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
   role (`sentriai_app`) with `NOBYPASSRLS`**, so the database itself refuses to
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

- `sentriai_app` — `NOSUPERUSER NOBYPASSRLS` (application / RLS-enforced)
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
# Full security + functional suite (migrations + 61 tests)
npm test

# Live-server cross-tenant penetration gate (BUILD → BREAK → verify)
npm run pentest
```

### What is tested (61 automated tests)

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

---

## AI capabilities

Person detection, vehicle detection, restricted-area intrusion, line crossing,
loitering, crowd detection, helmet detection, safety-vest detection. The rule /
event model is extensible for future models.

---

## Secrets

Never commit real secrets. `.env` is git-ignored; use `.env.example` as a
template. Camera credentials, storage credentials, session/encryption/signing
keys and DB passwords all come from environment variables.
