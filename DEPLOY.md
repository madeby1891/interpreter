# DEPLOY — 1891 Interpreter

**The single source of truth for how this project ships.** Deploy knowledge used to be scattered across `CLAUDE.md`, `PROJECT_GUIDE.md`, `HANDOFF.md`, `deployment/`, and `workers/interpreter-data/MIGRATION.md`. It now lives here. The other files point back to this one.

> Extends the workspace deploy contract in `~/Desktop/1891/CLAUDE.md`. Read that first. This file is the interpreter-specific layer.

---

## 0. The one rule

Agents own `git add` + `git commit` + `git push` **and** the deploy **and** the post-deploy smoke — in the same turn as the change. Never paste code into a dashboard. Never ask Anthony to run `clasp push` or `wrangler deploy`. The **only** thing Anthony does by hand is the 4-click Apps Script "Manage deployments" publish (Material listboxes need trusted clicks) — and only when a `.gs` change needs publishing outside the scripted path. When you need it, drop the exact `https://script.google.com/d/<SCRIPT_ID>/edit` URL in a 🚨 callout.

---

## 1. Three deploy tiers

| Tier | What | Command | Notes |
|---|---|---|---|
| **Static site** | `site/` → GoDaddy cPanel | `bash deployment/deploy.sh` | Builds, lints, PII-scans, rsyncs, smokes. `--dry-run` first when unsure. |
| **Workers** | `workers/*` (api, interpreter-data, captions, …) | **`git push`** (CI auto-deploys) | `deploy-workers.yml` deploys + `/healthz`-smokes on push. Manual fallback: `cd workers/<name> && npx wrangler deploy`. |
| **Apps Script** | `apps-script/*.gs` | `shared/ops/clasp-deploy.sh apps-script "<desc>"` | Does `clasp push` + `clasp deploy -i <deploymentId>` end-to-end. Account `anthonymowl`; deploymentId in `apps-script/.clasp.json`. |

**Worker CI** (fixed 2026-06-03): the repo's `CLOUDFLARE_API_TOKEN` secret ("Edit Cloudflare Workers" token) makes `git push` the deploy for api + interpreter-data + captions (covers queue + D1 bindings). Manual `wrangler deploy` is the fallback only.

**Site deploy without touching the worker:** `DEPLOY_WORKER=0 bash deployment/deploy.sh` (default is off; pass it explicitly so the next reader knows the flag exists). Set `DEPLOY_WORKER=1` to `wrangler deploy` `workers/api` before the rsync.

---

## 2. Deploy timing (HARD — admin preference)

- **Never deploy 7–10am ET on a weekday** — that's the schedulers' Tetris hour.
- **Default maintenance window:** Saturday 11pm – Sunday 3am ET.
- **Agency owners get a heads-up email 48h before any non-trivial deploy.**
- **Who to notify when something ships:** Anthony + Fallon (always). Each agency owner gets a changelog email after a non-trivial deploy. Schedulers get an in-app toast on next login.

---

## 3. `deployment/deploy.sh` pipeline (static site)

Runs in order; any FAIL aborts (global bypass: `FORCE=1`).

1. **Godview auto-registration lint** — `shared/ops/godview-lint-gate.sh` (spec: `GODVIEW_AUTO_REGISTRATION.md`).
2. **Voice / language lint** — `shared/ops/voice-lint.py` (HARD RULE vendor names, banned voice words — see §6).
3. **SMS-consent lint** — `shared/ops/sms-consent-lint.py` (spec: `SMS.md` — consent, STOP/HELP, rate-limit).
4. **Parallel-agent branch lint** — `shared/ops/branch-watch.py` (blocks if an unmerged origin branch touches this project; override `ACK_BRANCHES="branch:reason"`; spec: `PARALLEL_AGENT_DISCIPLINE.md`).
5. **Dashboard-contract lint** — `shared/ops/dashboard-contract-lint.py --surface=admin` (spec: `DASHBOARD_CONTRACT.md`).
6. **Test gate** — `npx vitest run` (worker suite).
7. **Pre-flight** — refuses to deploy if `site/.htaccess` or `site/404.html` is missing, or the SSH key is absent.
8. **PII safety scan** — greps `site/` for personal emails, SSNs, phone numbers; aborts on a hit (allowlist documented in the script).
9. **Build** — `_build/build.py`, then `_build/strip_html_urls.py` (clean URLs), then the umbrella `inject-chrome.py --consent-only` post-build pass (UMBRELLA-CONSENT must run AFTER build or the regen wipes the sentinel).
10. **Rsync** `site/` → host (excludes `_build`, `deployment`, `apps-script`, `.git`, `godview.json`, `package*.json`).
11. **Smoke** — `deployment/smoke.sh` against the live URL.

---

## 4. Infrastructure & identifiers

| Thing | Value |
|---|---|
| **Live site** | `https://madeby1891.com/interpreter/` (planned domain `1891interpreter.app`, not yet registered) |
| **SSH key** | `~/.ssh/ftd_godaddy_deploy` (shared 1891 deploy key) |
| **GoDaddy host** | `f6chtbdjctic@50.62.140.157:22`, path `public_html/madeby1891.com/interpreter` |
| **API Worker** | `https://1891-interpreter-api.anthonymowl.workers.dev` (`/health` → `stripe_mode`) |
| **Data Worker** | `interpreter-data` — `/healthz` → `{"ok":true,"schema_version":1,"tables":39}` |
| **Captions Worker** | `1891-interpreter-captions` — `/healthz` → `captions_configured:true` |
| **D1** | `interpreter-data` `5a445d42-4e08-48e8-84a3-8156f86c567a` |
| **KV (cache)** | `interpreter-cache` `86aaf1be509040b489c1023fae24709c` |
| **KV (idempotency)** | `1891-interpreter-idempotency` (+ `--preview`) — webhook dedupe |
| **Queue** | `interpreter-jobs` |
| **CF zone** | `madeby1891.com` account `8c3571f09abd644406f30db05056e6d2` |

### Stripe (acct `acct_1TYabRRyhX2OZu5s` — Made By 1891, LIVE)

| Tier | Annual | Monthly |
|---|---|---|
| Solo | `price_1TYdAiRyhX2OZu5s587CRrWw` ($108/yr) | `price_1TYdAjRyhX2OZu5sO0eTxOJx` ($11/mo) |
| Practice | `price_1TYdAlRyhX2OZu5sZUZQabVt` ($2,988/yr) | `price_1TYdAlRyhX2OZu5s7Ht18JkL` ($299/mo) |
| Studio | `price_1TYdApRyhX2OZu5sK8rpU7KJ` ($8,988/yr) | `price_1TYdAqRyhX2OZu5sVDaRZlFS` ($899/mo) |

- **Webhook endpoint:** `we_1TYdCARyhX2OZu5spASL0jxI` (live, 19 events, URL = API Worker).

### Worker secrets (where each lives)

`wrangler secret put <NAME>` from the worker dir. Apps Script secrets live in **Script Properties** or **gitignored `*-secret.gs`** files — never the Sheet, never committed.

- **api worker:** `STRIPE_API_KEY` (`rk_live_…`), `STRIPE_WEBHOOK_SECRET` (`whsec_…`), `STRIPE_CONNECT_CLIENT_ID` (`ca_…`, Pattern G), `ANTHROPIC_API_KEY`, `PHI_MASTER_KEY`, `HMAC_SECRET`, `HMAC_SECRET_INTERPRETER`, the 5 Twilio secrets (`TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_AUTH_TOKEN`), the 4 `QBO_*` secrets.
- **interpreter-data:** `HMAC_SECRET`, `MIRROR_SHEET_EXEC` (phase-4 mirror target `<exec URL>?d1op=mirror_apply&setup=<SHEET_ID>`).
- **captions:** `DEEPGRAM_API_KEY`.
- **Apps Script (gitignored `.gs`):** `d1-secret.gs` (`D1_PRIMARY=true`, `D1_WRITE_TABLES`), `anthropic-secret.gs` (`_anthropicKeyValue_`), `comms-secret.gs` (comms-internal key). Shared key cache: `~/.config/1891/anthropic-key`, `~/.config/1891/comms-internal-key`, `~/.config/1891/deepgram-key`.

---

## 5. Non-obvious gotchas (each one cost a real incident — read before deploying)

- **⚠️ CDN cache-busting.** Marketing HTML is served fresh, but `/assets/*` is edge-cached. `build.py` appends `?v=<sha1 of asset bytes>` (`ASSET_V`) to every CSS/JS href so any asset change busts the edge the moment the HTML ships — **no manual purge** (the default CF token is `zone:read`, can't purge anyway). If you hand-edit `site/assets/*`, **rebuild** so the hash updates. Verify post-deploy: the live HTML's `?v=` must match the freshly-served `…css?v=…`.
- **⚠️ clasp-push-from-a-fresh-clone foot-gun.** The live Apps Script project carries gitignored `d1-secret.gs` (`D1_PRIMARY=true`) + `anthropic-secret.gs` + `comms-secret.gs`. `clasp push` REPLACES server contents with local — pushing from a clone without those files **deletes them** (and would flip reads back to the Sheet). Protocol on any new machine: `clasp pull` into a temp dir (bare `.clasp.json`, scriptId only) → copy `*-secret.*` into `apps-script/` as gitignored `.gs` → `diff` every shared module for drift → then push + deploy.
- **⚠️ D1 schema was applied via REST `/query`, NOT `wrangler d1 migrations apply`.** Do **not** run `migrations apply` for `0001` — it would duplicate the `schema_version` row. See `MIGRATION.md`.
- **CF cache rule for HTML.** A zone Cache Rule ("Cache interpreter marketing HTML", order 1) edge-caches marketing pages (`/interpreter/` minus `/app/`, `/api/`, `/pay/`) at the origin's `max-age=300` (5-min). App/api/pay stay `DYNAMIC`. Stale page self-clears in 5 min, or purge the URL in CF → Caching → Configuration → Purge.
- **GoDaddy injects `img1.wsimg.com/.../tccl.min.js`** after `</html>` — a render-blocking tracker, currently CSP-blocked so it never loads. Leave it blocked.
- **Duplicate security headers** (origin `.htaccess` + a zone-wide CF rule) are **deliberately left alone** — cosmetic, and the fix is a zone-wide edit that risks every other project. Don't "clean it up."
- **`site/` must be clean before an Apps Script deploy that touches reads** — stale build artifacts in `site/` have blocked migration steps before.

---

## 6. Voice / language gate (blocks deploy)

`voice-lint` runs in `deploy.sh`. Anti-claims (non-negotiable, PRD F1.3): **no "AI-powered," no "revolutionary," no "cutting-edge," no "empowering"/"empowerment," no "underserved community."** Also: vendor names HARD RULE, deprecated tier vocab, device-name surfaces, brand spelling. Rule 5 ("the phone") bites — say "phone-friendly" / "by phone." If a draft trips a rule, rewrite before commit (or `FORCE=1` to bypass, sparingly).

---

## 7. Smoke checks (`deployment/smoke.sh [BASE_URL]`)

Must be all green post-deploy. Covers: marketing pages 200; `.html` → clean-URL 301; bad path → real 404; `/deployment/`, `/_build/`, `/CLAUDE.md` → 403; security headers present (HSTS, X-Frame-Options, X-Content-Type-Options, CSP, Referrer-Policy); **Worker `/health` → ok:true**; **webhook bogus-sig → 400** (signature correctly rejected); pricing page has a Subscribe CTA (one retry — flaky mid-suite); `/pay/subscribe` + `/pay/success` → 200.

---

## 8. Runbooks (live procedures — kept where they are, linked here)

- **Payments live-mode go-live / secret rotation:** `deployment/PAYMENTS_LIVE_DEPLOY.md`. Anthony runs it; agents prep. Covers worker secrets + idempotency KV creation, the migration + 4-click Apps Script deploy, site deploy, smoke, real-card end-to-end verification, and rollback (`wrangler rollback`, refund, disable webhook endpoint).
- **D1 phase-4 (sole-writer) per-table flip:** `workers/interpreter-data/MIGRATION.md` → "Phase 4 runbook (per table)". Rails staged 2026-06-10 (inert until flags set). To ship rails: merge `frederick/ws9-interpreter` → main (CI deploys interpreter-data), `clasp-deploy.sh apps-script "phase-4 mirror (inert)"` (NOT 7–10am ET), set `MIRROR_SHEET_EXEC`. First table = Settings; flip order is in the runbook (mirror-once FIRST on rollback, then flag off, then `backfill&tab=<table>`).
- **Disaster recovery (outages, leaks, cross-tenant, consent):** `DISASTER_RECOVERY.md`.

---

## 9. Rollback quick-reference

- **Worker:** `cd workers/<name> && npx wrangler rollback`.
- **Static site:** re-deploy the previous commit (`git checkout <sha> -- site && bash deployment/deploy.sh`), or rely on the 5-min edge TTL for content.
- **Apps Script:** re-publish the prior version via Manage deployments.
- **Stripe webhook misbehaving:** dashboard → Developers → Webhooks → `we_1TYdCARyhX2OZu5spASL0jxI` → Disable; re-enable after fix (Stripe retries queued events).
- **D1 table flip:** see the MIGRATION.md per-table rollback order.

Document anything beyond a "small bug, fixed, re-deployed" in `HANDOFF.md` and `DISASTER_RECOVERY.md`.
