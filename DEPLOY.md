# Deploy SentriAI for FREE on `garudai.in`

This guide deploys the SentriAI SaaS at **$0/month** using three free tiers:

| Piece | Host (free) | URL |
|-------|-------------|-----|
| Web UI (React) | **Vercel** | `https://garudai.in` |
| API (Express) | **Render** free web service | `https://api.garudai.in` |
| Database | **Neon** free Postgres | (internal) |

> **What runs free vs not.** The full multi-tenant SaaS — signup, organizations,
> users/RBAC, sites, cameras, AI **events**, evidence, alerts, reports, billing,
> audit logs, dashboards, Security Center — runs entirely on these free tiers.
> The **live RTSP camera ingest + real-time AI inference** need an always-on
> machine (no free tier for continuous video/CV), so you run those **on your own
> computer** when you want to demo real cameras (Step 6). Until then the UI
> correctly shows **"Inference Offline"** — never fake AI.
>
> **Render free caveat:** the API **sleeps after ~15 min idle** and cold-starts
> (~30–60s) on the next request. Fine for a demo/portfolio. Always-on is ~$7/mo
> if you ever want it (not required).

You need free accounts on **GitHub** (you have it), **Neon**, **Render**, and
**Vercel**. Total time ~30–40 min.

---

## Step 1 — Database on Neon (free Postgres)

1. Go to <https://neon.tech> → sign up (use "Continue with GitHub").
2. **Create project** → name `sentriai`, region closest to you (e.g. AWS
   `ap-southeast-1` Singapore). Postgres 16.
3. After creation, open **Dashboard → Connection Details**. Copy the
   **pooled** connection string (it contains `-pooler` in the host). It looks like:
   ```
   postgresql://neondb_owner:XXXX@ep-xxxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```
   This is your **owner** URL (runs migrations) → you'll use it as
   `ADMIN_DATABASE_URL`.
4. **Create the RLS app role.** Open Neon's **SQL Editor** and run (pick your own
   strong password):
   ```sql
   CREATE ROLE sentriai_app LOGIN PASSWORD 'PUT_A_STRONG_PASSWORD'
     NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
   GRANT USAGE ON SCHEMA public TO sentriai_app;
   ```
   > This is **required for security**: the API connects as this NOBYPASSRLS role
   > so PostgreSQL Row Level Security is enforced (tenant isolation). The owner
   > role is used only for migrations.
5. Build the **app** URL by taking the owner URL and swapping the
   username:password for `sentriai_app:PUT_A_STRONG_PASSWORD` (keep the same host
   / `?sslmode=require`). This is your `APP_DATABASE_URL`.

   You now have two strings:
   - `ADMIN_DATABASE_URL` = the `neondb_owner:...` one
   - `APP_DATABASE_URL`   = the `sentriai_app:...` one

> Migrations create the schema + all RLS policies automatically on first API
> boot — you don't run anything manually. The app grants the new tables to
> `sentriai_app` as part of the migration.

---

## Step 2 — Generate secrets

On any machine with `openssl` (Mac/Linux/WSL/Git-Bash), run:
```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # STORAGE_URL_SIGNING_KEY
openssl rand -hex 32   # CREDENTIAL_ENCRYPTION_KEY   (must be exactly 64 hex chars)
openssl rand -hex 32   # MEDIA_WORKER_TOKEN
```
Keep these somewhere safe. (Render can auto-generate `SESSION_SECRET`,
`STORAGE_URL_SIGNING_KEY`, and `MEDIA_WORKER_TOKEN` for you — but
`CREDENTIAL_ENCRYPTION_KEY` must be exactly **64 hex characters**, so generate
that one yourself.)

---

## Step 3 — API on Render (free web service)

1. Go to <https://render.com> → sign up with GitHub.
2. **New → Web Service** → connect the `Rish866/ai-cctv-platform` repo.
   (The repo already includes `render.yaml`; if Render offers "Blueprint", you
   can use that instead and it prefills most of this.)
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm ci && npm --workspace server run build`
   - **Start command:** `node server/dist/index.js`
   - **Plan:** Free
   - **Health check path:** `/api/health`
4. **Environment → add these variables:**

   | Key | Value |
   |-----|-------|
   | `NODE_ENV` | `production` |
   | `APP_DATABASE_URL` | *(the `sentriai_app` Neon URL from Step 1.5)* |
   | `ADMIN_DATABASE_URL` | *(the `neondb_owner` Neon URL from Step 1.3)* |
   | `DATABASE_SSL` | `true` |
   | `SESSION_SECRET` | *(from Step 2)* |
   | `STORAGE_URL_SIGNING_KEY` | *(from Step 2)* |
   | `CREDENTIAL_ENCRYPTION_KEY` | *(64-hex from Step 2)* |
   | `MEDIA_WORKER_TOKEN` | *(from Step 2)* |
   | `REQUIRE_INFERENCE` | `false` |
   | `COOKIE_SECURE` | `true` |
   | `WEB_ORIGIN` | `https://garudai.in,https://www.garudai.in` |

5. **Create Web Service.** Watch the deploy log — you should see
   `[migrate] up to date` then `SentriAI API listening`. Render gives you a URL
   like `https://sentriai-api.onrender.com`.
6. Test it: open `https://sentriai-api.onrender.com/api/health` → `{"ok":true,...}`.

> If the log shows a DB connection error, re-check the two Neon URLs (they must
> end with `?sslmode=require`) and that `sentriai_app` was created in Step 1.4.

---

## Step 4 — Web UI on Vercel (free)

1. Go to <https://vercel.com> → sign up with GitHub → **Add New → Project** →
   import `Rish866/ai-cctv-platform`.
2. Vercel reads the repo's `vercel.json`, so leave the framework as **Other**.
   Confirm:
   - **Build Command:** `npm ci && npm --workspace web run build`
   - **Output Directory:** `web/dist`
3. **Environment Variables → add:**

   | Key | Value |
   |-----|-------|
   | `VITE_API_URL` | `https://api.garudai.in` |

   > This bakes the API origin into the frontend at build time so it calls your
   > Render API (with cookies) instead of itself. You must set this **before** the
   > first build (or redeploy after adding it).
4. **Deploy.** You get a `https://<project>.vercel.app` URL. Open it — the
   landing page loads. (Login won't work until DNS/HTTPS + custom domains are set,
   because cross-site cookies need the real `garudai.in` / `api.garudai.in`
   HTTPS origins — see Step 5.)

---

## Step 5 — Point `garudai.in` (GoDaddy DNS) at Vercel + Render

You'll map:
- `garudai.in` (+ `www`) → **Vercel** (web UI)
- `api.garudai.in` → **Render** (API)

### 5a. Add the custom domains in each dashboard first
- **Vercel:** Project → **Settings → Domains** → add `garudai.in` **and**
  `www.garudai.in`. Vercel shows the exact DNS records to create (an **A record**
  for the apex and a **CNAME** for `www`). Use whatever Vercel displays — the
  common values are:
  - Apex `garudai.in` → **A** → `76.76.21.21`
  - `www` → **CNAME** → `cname.vercel-dns.com`
- **Render:** Service → **Settings → Custom Domains** → add `api.garudai.in`.
  Render shows a **CNAME target** like `sentriai-api.onrender.com`.

### 5b. Create the records in GoDaddy
GoDaddy → **My Products → Domains → garudai.in → DNS → Manage Zones** (or
"Manage DNS"). Add/edit:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `@` | `76.76.21.21` *(use the IP Vercel shows)* | 1 hr |
| CNAME | `www` | `cname.vercel-dns.com` *(use what Vercel shows)* | 1 hr |
| CNAME | `api` | `sentriai-api.onrender.com` *(the target Render shows)* | 1 hr |

Notes:
- If GoDaddy already has a default `A @ → Parked` record, **edit** it to the
  Vercel IP (don't create a duplicate).
- If GoDaddy won't let you CNAME the apex, that's fine — the apex uses the **A**
  record above; only `www` and `api` use CNAMEs.
- Remove any GoDaddy "Domain Forwarding" on the apex or it can override DNS.

### 5c. Wait for propagation + HTTPS
DNS takes ~10–60 min. Vercel and Render **auto-issue free HTTPS (Let's Encrypt)**
once DNS resolves — no action needed. When the dashboards show the domains as
"Valid/Active", open:
- `https://garudai.in` → the app
- `https://api.garudai.in/api/health` → `{"ok":true}`

Now sign up / log in on `https://garudai.in` — the session cookie is set with
`SameSite=None; Secure` (configured by `COOKIE_SECURE=true`), so it works across
`garudai.in` → `api.garudai.in`.

> **Optional (cleaner cookies across subdomains):** add `COOKIE_DOMAIN=.garudai.in`
> to the Render env. Not required — the app already works without it because both
> hosts share the `garudai.in` registrable domain.

---

## Step 6 — (Optional) Real cameras + AI, run locally for free

The cloud API has AI **off** (shows "Inference Offline"). To demo **real** RTSP
cameras + real CV inference at $0, run the media worker + inference service on
**your own computer** and point them at the cloud API:

```bash
# On your PC (needs Node 20+, Python 3.11, FFmpeg installed):
git clone https://github.com/Rish866/ai-cctv-platform && cd ai-cctv-platform
npm ci

# 1) Inference service (real OpenCV/ONNX CV)
cd inference-service && python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8100         # http://localhost:8100
```
Then run the media worker in another terminal, pointed at your **cloud** API and
DB (so detections land in the same tenant data):
```bash
export APP_DATABASE_URL="<your Neon sentriai_app URL>"
export ADMIN_DATABASE_URL="<your Neon owner URL>"
export CREDENTIAL_ENCRYPTION_KEY="<same 64-hex as Render>"
export MEDIA_WORKER_TOKEN="<same as Render>"
export MEDIA_API_BASE_URL="https://api.garudai.in"
export INFERENCE_SERVICE_URL="http://localhost:8100"
npm --workspace server run build
npm --workspace server run start:media-worker
```
Add a camera in the UI (Cameras → Add camera) with its RTSP details, click
**Test Connection**, enable AI, and open **Live Monitoring**. The RTSP URL +
password never leave your machine / the server; the browser only gets authorized
HLS. See the "Real CCTV / RTSP" section of `README.md` for camera specifics
(RTSP path per manufacturer, `VIDEO_FILE_TEST_SOURCE` for testing without a
camera, GPU notes).

> To run AI **in the cloud too**, you'd deploy the inference service + media
> worker on an always-on paid host (Render paid, Railway, Fly.io, a VM) and set
> `INFERENCE_SERVICE_URL` (and `REQUIRE_INFERENCE=true` for full fail-closed mode)
> on the API. That's the only part that isn't free.

---

## Redeploys

- **Push to the branch** → Render and Vercel auto-redeploy (autoDeploy on).
- Changed an env var on Render/Vercel? Trigger a **manual redeploy** so it takes
  effect (Vercel envs are baked at build time).

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| `FUNCTION_INVOCATION_FAILED` on Vercel | You deployed the **API** to Vercel. Don't — the API goes on **Render**; only the **web** app goes on Vercel (this repo's `vercel.json` builds only `web/`). |
| API 500 on boot / crash loop | Check Render logs: usually a bad `APP_/ADMIN_DATABASE_URL` (must be the Neon **pooled** URLs with `?sslmode=require`) or `CREDENTIAL_ENCRYPTION_KEY` not 64 hex chars. |
| Login "fails"/no session | `COOKIE_SECURE=true` + HTTPS custom domains must be live; `WEB_ORIGIN` on Render must include your exact web origin(s). |
| CORS error in browser console | Add your web origin to `WEB_ORIGIN` on Render (comma-separated), redeploy. |
| First request very slow | Render free tier cold start (~30–60s). Normal; hit it again. |
| "Inference Offline" badge | Expected on the free cloud API. Run the worker + inference service locally (Step 6) to see live AI. |
