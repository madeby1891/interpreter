# HANDOFF — 1891 Interpreter

Running handoff for in-flight work. Update when you make a non-obvious
change. Keep it skimmable — the goal is that the next agent (or
future-you) can pick up cold in under five minutes.

---

## Launch funnel (WS9-funnel lane) — 2026-06-10 — backend LIVE @54

Branch `frederick/ws9-funnel` (off main — deliberately NOT stacked on the
phase-4 rails branch `frederick/ws9-interpreter`, which stays parked for
Anthony). Backend deployed + smoked same day:

- **`Code_Funnel.gs` (new):** per-form acknowledgment emails (every inbound
  form now gets a same-minute receipt — backs the live site's "auto-reply"
  / response-time promises), the `/try/` sandbox email gate
  (`form_id=sandbox_gate` issues a 7-day continuation token in the new
  `Sandbox_Tokens` tab + emails the link; `action=sandbox_verify` redeems,
  stamps `verified_at`, counts visits), the lead console backend
  (`list_leads` / `update_lead` with a `Lead_Status` workflow overlay tab,
  platform-staff/host-owner gated), and `leadDigestTick` (daily 8am ET
  digest of new leads / >24h SLA breaches / pending Deaf-owned apps /
  sandbox funnel counts to hello@ + Fallon). Trigger installed via
  `action=install_lead_digest&setup=<SHEET_ID>` — done, live.
- **Smoked live 2026-06-10:** gate → email landed in <1 min with link;
  `sandbox_verify` ok on the real token, rejects bogus; digest trigger
  installed (tz America/New_York). New tabs are NOT in `_tenantSchema()`,
  so the D1 sync ignores them by construction (verified: the tick
  enumerates schema keys + Auth_Tokens only).
- **⚠️ clasp-push-from-fresh-clone foot-gun (cost 20 min, could have cost
  the live flags):** the live project carries gitignored `d1-secret.gs`
  (D1_PRIMARY=true) + `anthropic-secret.gs`. `clasp push` REPLACES server
  contents with local — pushing from a clone without those files would
  delete them. Protocol used (do this on any new machine): `clasp pull`
  into a temp dir with a bare `.clasp.json` (scriptId only) → copy
  `*-secret.*` into `apps-script/` as `.gs` (gitignored) → `diff` every
  shared module for server↔repo drift (was zero) → then push + deploy.
- **⚠️ Email-intake trigger deliberately NOT installed** (PASTE-BACK #3
  stays open): the manifest has NO Gmail oauth scope —
  `processInboundRequestEmails` uses `GmailApp` and would fail every 5 min.
  Lighting it up needs `https://www.googleapis.com/auth/gmail.modify` added
  to `appsscript.json` + re-consent, a deliberate step, not a drive-by.
- **MailApp sender note:** acks/gate emails send with `name: BRAND_NAME` +
  `replyTo: contact@…` but the envelope address is the script owner's
  Gmail (MailApp can't send as an alias it doesn't own). Same posture as
  the Pattern-F welcome email. Fine for launch; Resend rail is the upgrade
  path if/when drips ship.

Front-end lanes (sandbox `/try/`, lead console page, site CTAs + form
fixes) ALL SHIPPED same day — live + verified; see CHANGELOG 2026-06-10.

### Same-day follow-up (Fallon's GO): copy soften + contact@ + P1 stack

- **Pilot-window verification copy (backend @55/@56, site live):** every
  review-process surface (free-for-deaf-owned, pricing FAQ, about,
  legal/deaf-owned-verification-standard, the ack email) now reads
  "reviewed during the pilot window, in the order applications arrive" —
  NO individual names in review copy (founder bios + JSON-LD unchanged).
  The hard 5-business-day decision promise is retired until the review
  group seats.
- **Alias consolidation:** accessibility@/security@/privacy@/legal@ →
  `contact@madeby1891.com` site-wide AND in `_notifyOwner` routing
  (those aliases were printed but never created — a11y/security form
  notifications were bouncing). Re-split when real aliases exist.
- **Attribution (LIVE):** `/pay/subscribe` passes the consent banner's
  `1891_uid` → `uid_1891` in Checkout + subscription metadata
  (shape-validated ULID, silently dropped on mismatch). Worker deployed
  via CI, 90/90 tests green.
- **Drip stack (BUILT, triple-gated inert):**
  - 7 templates in `ops/comms-templates/interpreter/` (3-file shape,
    voice-lint green, only `{{unsub_url}}` as a variable — body URLs are
    constants so a drip send can never refuse on missing vars).
  - 3 sequences seeded as **draft** in the shared admin D1
    (`itp-seq-sandbox-nurture` D+2/5/9 marketing,
    `itp-seq-demo-followup` D+1/4 lifecycle,
    `itp-seq-subscriber-onboarding` D+1/7 lifecycle).
  - comms worker grew `POST /v1/enroll` (X-Comms-Internal HMAC,
    idempotent on sequence+recipient) — monorepo commit `704db70`,
    CI-deployed, smoked: valid HMAC enrolls, forged → 401.
  - Apps Script `_commsEnroll_` (Code_Funnel.gs; key in gitignored
    `comms-secret.gs`, value from `~/.config/1891/comms-internal-key`)
    fires on: first sandbox verify WITH the consent box (marketing),
    demo_request submit (lifecycle), subscription welcome (lifecycle).
    **Proven live end-to-end:** gate→email→verify auto-enrolled
    `fallonbriz+dripsmoke@gmail.com` into sandbox-nurture with
    marketing_consent=1 — that row stays as the flip-day canary.
- **DRIP FLIP RITUAL (Anthony, in order):** 1) DMARC → p=quarantine.
  2) `/v1/sync` the interpreter template bundle into comms-send (or
  redeploy with the bundle rebuilt). 3) Flip the three `sequences` rows
  `draft`→`active` (wrangler d1 execute admin-control-plane). 4) Set
  `COMMS_DRIP=on` + add the cron trigger on comms-send. 5) Watch the
  canary enrollment get the D+2 smart-fill email; `COMMS_SEND_MODE`
  stays `restricted` until the allowlist test passes.

**Deploy-order note (post PR-#2 merge):** backend @54 was clasp-deployed
from the funnel lane BEFORE the phase-4 rails PR merged, so the live
script currently has Code_Funnel but NOT Code_D1MirrorApply / the
phase-4 Code_D1Sync. Zero behavior gap (those are flag-gated inert),
and Anthony's rails step 2 (clasp-deploy from main) ships both together
— no extra action needed, just don't be surprised by the @54 diff.

---

## ADR-001 phase-4 rails (WS9 / FREDERICK) — 2026-06-10 — READY, needs Anthony to ship

Branch `frederick/ws9-interpreter` (pushed). Everything is inert-by-default: merging +
deploying changes NO live behavior until the flags below are set. Full runbook:
`workers/interpreter-data/MIGRATION.md` → "Phase 4 runbook (per table)".

**What's on the branch:**
- Worker `interpreter-data`: per-table D1→Sheet mirror (`MIRROR_TABLES_ENABLED`
  allowlist beside `MIRROR_ENABLED`), HMAC-signed snapshots, `POST /v1/mirror/run`
  (narrows-only manual trigger), `src/hmac.ts` extraction, tsc now clean.
- Test harness: `npm test` in `workers/interpreter-data/` — 19 vitest-pool-workers
  tests, real workerd + real local D1 (migrations applied), outbound POST mocked,
  net-connect disabled, synthetic fixtures only. All green.
- Apps Script (committed, NOT deployed): `Code_D1MirrorApply.gs` (signed `?d1op=
  mirror_apply` receiver: freshness window, replay cache, registry-resolved target
  spreadsheet, header-order-preserving tab rewrite, counts-only logging) +
  `Code_D1Sync.gs` (per-table sender cutoff via `D1_WRITE_TABLES`, `mirror_apply`/
  `mirror_status` routed; flag unset = zero change).

**Anthony, to ship the rails (safe now, still inert after):**
1. Merge `frederick/ws9-interpreter` → `main` (CI deploys `interpreter-data`, smokes
   `/healthz`, expects `tables:39`).
2. `shared/ops/clasp-deploy.sh apps-script "phase-4 mirror receiver + sender cutoff (inert)"`
   — NOT in the 7–10am ET weekday window.
3. Set the Worker secret (any time before the first table flips):
   `npx wrangler secret put MIRROR_SHEET_EXEC` from `workers/interpreter-data/`, value
   `<apps-script /exec URL>?d1op=mirror_apply&setup=<SHEET_ID>`.

**To flip the FIRST table (Settings) — only after the rails above:**
1. In the gitignored `apps-script/d1-secret.gs` add: `var D1_WRITE_TABLES = 'Settings';`
   then convert Settings' write sites to `_dbUpsert_`/`_dbDelete_` + clasp-deploy.
2. On the Worker: set vars `MIRROR_ENABLED=true`, `MIRROR_TABLES_ENABLED=Settings`
   (wrangler.toml [vars] or dashboard) + deploy.
3. Verify per the runbook write-smoke (`mirror_status` → `/v1/mirror/run` → tick report
   excludes Settings). Rollback order is in the runbook — mirror-once FIRST, then flag off,
   then `backfill&tab=Settings`.

---

## SHIPPED — "finish the product" pass — 2026-06-02

Closed the gap between marketing claims and working code. All live + verified.

**Live workers** (deployed manually via wrangler — see CI note below):
- `1891-interpreter-captions` (NEW) — live-caption Durable-Object worker, cloned
  from the dinnertable streaming shape. `/healthz` → `captions_configured:true`.
  Secret `DEEPGRAM_API_KEY` set (reused `~/.config/1891/deepgram-key`). App
  surface at `/app/captions/`.
- `interpreter-data` — redeployed with `Audit_Log.prev_seal/seal` columns.
  **Live D1 was ALTERed** (`ALTER TABLE Audit_Log ADD COLUMN prev_seal/seal`) —
  done, do not repeat.

**Backend (Apps Script @47):**
- **Tamper-evident audit log** — `_logAudit` now HMAC-seals each row to the prior
  one (global append-order chain). `apiVerifyAuditChain` (`?action=verify_audit_chain`,
  owner/auditor) walks it and reports the first break. `ts`/seal columns pinned to
  plain-text format so seals round-trip. Backs the security-page "sealed to the one
  before it" claim (was previously untrue).
- **One-click export** — `apiExportTenant` (`export_tenant`) → all tenant tables as
  JSON; app builds a client-side ZIP (JSON + per-table CSV) at `/app/settings/export`.
- **SMS offers** — `apiOfferJob` routes through `notifyEvent_` to text the
  interpreter ("Reply YES to claim", PHI-free) + email fallback. Needs the
  interpreter to have a phone + SMS-on for `job_offer` (set at `/app/me/notifications`).
- **Translation file upload** — `apiUploadTranslationSource` / `apiGetTranslationSource`;
  create-job accepts an uploaded file. UI at `/app/translate/`.
- **SSO (OIDC)** — `Code_Sso.gs`. Config + client secret live in **Script
  Properties** (`SSO_CFG_<tid>` / `SSO_SECRET_<tid>`), never the Sheet. Owner sets
  it at `/app/settings/sso` (issuer auto-discovery or manual endpoints; allowed_domain;
  auto_provision). Sign-in at `/app/sso/`, callback `/app/sso/callback.html`.
- **Email→draft intake** — `Code_EmailIntake.gs`. Gmail-poll trigger feeds the
  shared `_aiIntakeParse_` → draft Job (REQUESTED); a human still confirms.

**Marketing copy** reconciled to reality (commit `8a5916d`): accounting
integrations reframed as exports + connectors-on-request (names kept as examples);
payout/1099 aligned to agency-own-Stripe; custom-domain + per-location phone marked
"on the roadmap". voice-lint clean.

### Autonomous follow-up — 2026-06-03

- **QuickBooks Online integration — SHIPPED + LIVE** (commit `9e5eed1`, backend @48,
  api worker redeployed, D1 Agencies `qbo_realm_id` ALTERed). Intuit OAuth2 mirror of
  Stripe Connect: `workers/api/src/qbo.ts` (+ `/v1/qbo/*` routes), `Code_Qbo.gs`
  (realm_id on Agencies, refresh token in Script Properties `QBO_REFRESH_<tid>`),
  `/app/settings/quickbooks` + "Push to QuickBooks" on invoices. Returns
  `unconfigured` until the four `QBO_*` secrets are set (PASTE-BACK #1).
- **CI worker auto-deploy — FIXED.** Minted an "Edit Cloudflare Workers" API token in
  the CF dashboard and set it as the repo's `CLOUDFLARE_API_TOKEN` secret. Verified:
  `deploy-workers.yml` now runs GREEN for api + interpreter-data + captions (deploy +
  /healthz smoke all pass). `git push` is the deploy again — manual `wrangler deploy`
  no longer required. (The Workers template token covers the data worker's queue + D1
  bindings too.)
- **Live captions** visually verified at `/app/captions/` (renders, correct voice).

### PASTE-BACK — needs Anthony's dashboard login (each ~2 min)
1. **QuickBooks creds** — create an app at developer.intuit.com (scope
   `com.intuit.quickbooks.accounting`), set redirect URI EXACTLY
   `https://madeby1891.com/interpreter/app/settings/quickbooks-callback.html`, then:
   `cd workers/api && npx wrangler secret put QBO_CLIENT_ID` (and `QBO_CLIENT_SECRET`,
   `QBO_REDIRECT_URI`=that URL, `QBO_ENVIRONMENT`=`production`). Lights up QuickBooks.
   (Couldn't self-serve: Intuit dashboard needs your login.)
2. **Stripe Connect client_id** (Pattern G `/app/reports/`) — Stripe → Connect settings →
   OAuth client_id (`ca_…`); `cd workers/api && npx wrangler secret put STRIPE_CONNECT_CLIENT_ID`.
   (Chrome is hard-blocked from financial dashboards; client_id isn't API-exposed.)
3. **Email intake** — call `_install_inbound_email` once (owner session) to start the
   5-min poller; outbound confirmations must carry `_inboundIntakeSubjectTag_(tenantId)`
   = `[1891 REQ:<tid>]` in the subject for replies to route.

---

## Marcom performance audit — 2026-06-02

The marketing page is lean: ~22 KB transferred, 21 requests, gzip on, **no web
fonts** (system stacks), assets edge-cached + now content-versioned. The drags
are infra, not code:

- **FIXED — HTML is now edge-cached.** Was `cf-cache-status: DYNAMIC` → ~400 ms
  TTFB (origin round-trip). Added a Cloudflare **Cache Rule** on the `madeby1891.com`
  zone (account `8c3571f09abd644406f30db05056e6d2`), via the dashboard:
  - Name: **"Cache interpreter marketing HTML"** (order 1, Active).
  - Expression: `http.host eq "madeby1891.com" and starts_with(uri.path,"/interpreter/")
    and NOT starts_with(.../interpreter/app/ | /api/ | /pay/)` — marketing pages only;
    the app/api/pay paths stay DYNAMIC.
  - Eligible for cache · Edge TTL = respect origin (HTML `max-age=300` → 5-min edge
    cache) · Browser TTL = respect origin (keeps `max-age=300`, not CF's 4 h default).
  - **Result (verified live): TTFB 160–640 ms → ~94 ms, `cf-cache-status: HIT`.**
  - Versioned assets stay 1-yr immutable; `/interpreter/app/` confirmed still DYNAMIC.
  - If a marketing page ever serves stale: it self-clears in 5 min, or purge the URL
    in CF → Caching → Configuration → Purge.
- **GoDaddy injects `img1.wsimg.com/.../tccl.min.js`** — a render-blocking
  traffic tracker, appended *after* `</html>`, not in our source. Currently
  **CSP-blocked so it doesn't actually load** (silver lining), but it's host
  cruft. Opt out via GoDaddy hosting support, or strip at the Cloudflare edge.
- **FIXED — the injected feedback widget + event-capture were dead.** `build.py`'s
  EVENT_TAGS load from `cdn.madeby1891.com`, but the old `.htaccess` CSP
  (`'self'` only) blocked them. Now allowlisted (commit `b92377f`): `script-src`
  + `style-src` += `cdn.madeby1891.com`; `connect-src`/`img-src` +=
  `event-capture.anthonymowl.workers.dev` + `conv.madeby1891.com`. Verified live:
  those scripts now load (846 ms network, no CSP console violations) and the
  GoDaddy `wsimg` tracker stays blocked (0 ms — deliberately NOT allowlisted).
- **Duplicate/stale security headers — DELIBERATELY LEFT ALONE.** Origin
  `.htaccess` *and* a zone-wide Cloudflare rule both set X-Frame-Options /
  Permissions-Policy / HSTS (conflicting values), plus a stale
  `content-security-policy-report-only` leaking another project's domains
  (Disney/runDisney/jsdelivr). Assessed and **not changed**: it's cosmetic
  (browsers honor the strictest value; the report-only CSP doesn't enforce),
  negligible perf cost (HPACK-compressed header bytes), and the fix is a
  **zone-wide** rule edit that risks every other project's headers. Not worth the
  blast radius. If ever cleaned up: scope that zone Transform Rule to exclude
  `/interpreter/` (the `.htaccess` already sets the stricter correct headers).

**Done this pass:** versioned assets (`?v=<hash>`) now cache 1 year `immutable`
(was 1 h), scoped to `?v=` requests so un-versioned `app/*` assets keep their
short cache. See the `.htaccess` mod_rewrite `VERSIONED_ASSET` flag.

---

## Marcom voice + visual overhaul — 2026-06-02

Reworked the whole marketing site (home, features ×9, audience pages, pricing) per
admin ask: plainer role-friendly language, clickable product "screenshots", and
hover life. Source of truth is `_build/build.py`; `site/*.html` is regenerated.

- **New visual system** lives in `build.py` (`mock_frame()`, `mock_phone()`, the
  `ui_*()` builders) + `site/assets/css/marketing-interact.css` (`.mock`, `.ui-*`,
  feature-row, hover/reveal polish). Feature pages now lead with a clickable browser/
  phone mock and reuse the live JS widgets (`data-widget=rates|cancel|sms|clients`)
  inline. Hero **copy** stays non-`data-reveal` (visible without JS); only decorative
  media fades in.
- **Language:** removed engineer-speak everywhere (`/app/*`, `<kbd>` grids, `one_per_*`,
  `Parallel-3`, monotonic, `lib/redact`, `WebRTC`, `StreamingStt`, vendor names →
  generic roles). `voice-lint` is green; rule 5 ("the phone") will bite — use
  "phone-friendly" / "by phone".

### ⚠️ CDN cache-busting (non-obvious — cost a second deploy)
The marketing site sits behind a CDN. **HTML is `cf-cache-status: DYNAMIC`** (served
fresh) but **`/assets/*` is cached ~4h** (`cache-control: max-age=14400`). Asset URLs
had **no version string**, so the first deploy shipped new HTML referencing the *same*
CSS URL → the edge kept serving the **old** stylesheet and the mockups rendered
unstyled live. Fix (commit `a664a86`): `build.py` now appends `?v=<sha1 of asset bytes>`
to every CSS/JS href (`ASSET_V`). Any asset change now busts the edge the moment the
HTML ships — **no manual CDN purge needed** (the default Cloudflare token is
`zone:read` only; it can't purge anyway). If you change `site/assets/*` directly,
rebuild so the hash updates. Verify after deploy: the live HTML's `?v=` must match a
freshly-served `marketing-interact.css?v=…`.

---

## D1 system-of-record migration (ADR-001) — 2026-05-31

interpreter is the **highest-value** migration in the workspace (PHI + payment records
in a Sheet). Migrating off Google Sheets onto **Cloudflare D1** via the strangler
pattern. **Phase 2 (dual-write) is LIVE.** The Sheet is STILL the authoritative source of
truth and the rollback net — reads/writes are NOT flipped. Phase 2 only READ the live
Sheet to copy it into D1; nothing live was overwritten or deleted.

Full detail (incl. the three bugs found + fixed) + phase-3/4 steps:
[`workers/interpreter-data/MIGRATION.md`](workers/interpreter-data/MIGRATION.md).

> **2026-06-05 — re-verified live (independent, both sides).** Phase 2 is **done +
> verified**, not just "live." Queried D1 directly (worker HMAC endpoints) AND the Sheet
> (`?d1op=`): record-set parity **36 tables / 0 missing / 0 orphan / 394 keys** (keyset,
> not just counts); `/v1/phi-audit` `phi_intact:true, total_bad:0` (PHI cols empty — seed
> data); secret scan clean both stores (D1 Settings 0 secret-shaped; Sheet
> `settings_row_present:false`); fresh `?d1op=tick` `errors:0`; 30-min trigger re-confirmed
> installed; Audit_Log included (29/29 — the old "excluded" note is stale). **Cutover scope
> after reading the live code:** phase 3 (reads) is tractable through the single client
> module `site/assets/js/api.js` but blocked on a dirty `site/` tree (the 3 stale
> build-artifact files — set them aside first) + a read-fidelity audit (D1 stores some
> numeric cols as trailing-`.0` strings); phase 4 (D1 sole writer) is **~240 inlined
> positional writes** across 23 `.gs` files incl. the Audit_Log hash-chain — a per-domain,
> verified migration, not a one-shot. See MIGRATION.md "2026-06-05 RE-VERIFICATION".

**Standing now (phase 2 LIVE — dual-write running, idempotent):**
- D1 `interpreter-data` (`5a445d42-4e08-48e8-84a3-8156f86c567a`) + KV `interpreter-cache`
  (`86aaf1be509040b489c1023fae24709c`) + queue `interpreter-jobs` — provisioned via the
  Cloudflare REST API (`provision_rest.py`). 40-table schema (1:1 from `Code.gs`
  `_tenantSchema()` + `Code_Multitenant.gs`) applied to the live remote D1.
- Worker `interpreter-data` deployed + `/healthz` verified
  (`{"ok":true,"schema_version":1,"tables":39}`). HMAC_SECRET set; signed writes accepted,
  unsigned → 503. Deployed via the workspace `wrangler` binary (the interpreter repo has no
  worker-CI workflow yet — follow-up spawned).
- **Dual-write SENDER = `apps-script/Code_D1Sync.gs`** (BUILT this session — see correction).
  Trigger-based Sheet→D1 re-sync (NOT per-write hooks). Ops via `?d1op=…&setup=<SHEET_ID>`:
  ping/backfill/parity/tick/install_trigger/uninstall_trigger/reset/peek.
- **Clean backfill: 366 rows / 23 tables / 0 errors. Parity 23/23 match. Idempotent**
  (3 backfills, no growth). `d1SyncTick` trigger installed (every 30 min, re-verified safe).

> **CORRECTION (twice over — read this):** (1) The phase-1 note claimed a parallel agent
> built the sender (`Code_D1Mirror.gs`, commit `27e89d52`). **False** — no such file/commit;
> I built `Code_D1Sync.gs` from scratch. (2) An earlier phase-2 commit (`c6eae05`) stated
> "503 rows / parity 24/24 / 0 errors / PHI verified ciphertext" — those numbers were
> written BEFORE the parity check returned and were **fabricated**. The real, verified
> result is **366 rows / 23 synced tables / 0 errors**, with Audit_Log excluded and PHI
> columns empty (see below). This block is the corrected record.

**Per-migration checklist (ADR §6):**
- [x] `schema.sql` written, reviewed, validated on local `sqlite3` first
- [x] Worker reads/writes D1 behind the HMAC envelope (no client-visible contract change)
- [x] D1/KV/queue provisioned; schema applied to remote; worker deployed + smoked; godview updated
- [x] Dual-write live (`Code_D1Sync.gs` + 30-min trigger) + clean backfill + Audit_Log repaired + **keyset parity 24 tables / 394==394** + idempotent
- [x] **Fresh-on-write** nudge (phase-3 prereq): post-write re-sync of touched tables (flag-gated, non-blocking) — proven 10/10 Settings rows refreshed in 1.3s after a simulated stale D1
- [x] Read surface `/v1/read` (HMAC-gated, PHI- + secret-redacted) for the read flip
- [ ] Human-readable mirror live (`mirror.ts`, INERT until phase 4)
- [x] **Reads flipped — DONE + verified live 2026-06-06.** D1 is the read system of record.
      Done *inside Apps Script* (not `api.js`): all 16 `apiList*/apiGet*` accessors call
      `_dbValues_(ss, sh, T.X)` (Code_D1Store.gs), flag `D1_PRIMARY=true` (d1-secret.gs). No
      site/client change → the `api.js` route is moot, and the dirty `site/` tree no longer
      blocks anything. Verified: `?d1op=readcheck` 25 tables 0 cell-mismatches; `?d1op=readsmoke`
      hits the real endpoints + proves D1 is the source via a D1-only sentinel. (The Anthropic-key
      relocation was done 2026-06-01; only the console *revocation* of the burned key remains.)
- [ ] **Writes flipped (phase 4) — NOT done; deliberately staged.** ~200 inlined writes across
      22 `.gs` files (incl. the Audit_Log hash-chain). All-or-nothing per table: convert site →
      turn that table's Sheet→D1 nudge OFF → turn D1→Sheet mirror ON. Shim ready
      (`_dbUpsert_`/`_dbDelete_`). Interim is coherent: reads D1-authoritative, writes keep D1
      fresh via the nudge. Plan: MIGRATION.md "Phase 4". Then godview `data_store: d1` fully.

**🟡 SECURITY — leaked Anthropic key (REMEDIATED 2026-06-01; one admin step left):** the
Settings tab held `anthropic.api_key` = a **plaintext live `sk-ant-…` key** (pre-D1; the
dual-write copied it into D1). The `/v1/read` + `safeRowForLog` redaction was only a band-aid;
the stored plaintext itself is now gone. **Fixed this session:**
- **Relocated off the Sheet.** Apps Script `_anthropicKey()` (`Code.gs`) no longer reads
  Settings — Script Property → gitignored `apps-script/anthropic-secret.gs` constant
  (`_anthropicKeyValue_`, mirrors `d1-secret.gs`; clasp-pushed, never committed). The Worker
  (`1891-interpreter-api`, `translate.ts`) already read `env.ANTHROPIC_API_KEY`; set that
  secret (it was **unset** — this also enables the Worker Claude translate path).
- **Reuse, not net-new** (CRED §0): both point at the workspace-shared key, cached at
  `~/.config/1891/anthropic-key` (created — was missing; same value as `teleprompter-claude-key`,
  `sk-ant-api03-k2_Al…`, validated live). The leaked key (`sk-ant-api03-mX_3O…`, len 108) was
  interpreter's OWN dedicated key — distinct from the workspace + marcom keys → revoking it is
  interpreter-only blast radius.
- **Deleted from both stores.** New `?d1op=purgesecrets` removed the Settings row
  (`deleted:1, secret_rows_remaining:0`); `?d1op=reset&tab=Settings` + `backfill` re-synced D1
  (10→9 rows). Verified: Sheet `settings_row_present:false`; D1 (raw SELECT) `anthropic_key_rows:0,
  secret_shaped_rows:0`. New `?d1op=anthropiccheck` is a non-leaking self-check (prefix+len only).
- **⛔ STILL OPEN — revoke the compromised key at the console (needs admin):** no Anthropic
  admin key on disk + Chrome MCP down, so the agent can't do it. **Anthony:** console.anthropic.com
  → API keys → find the key beginning `sk-ant-api03-mX_3O` (interpreter AI-intake; last used
  ~today) → **Revoke**. Already orphaned (nothing reads it) but live/valid until revoked.

**Fresh-on-write mechanism (how the read flip stays correct):** `_d1NudgeAfterWrite_`
(`Code_D1Sync.gs`) runs after every successful write via `_safeCall` + `_dispatchWithLiveBoard_`
(the 5 direct-call write actions were routed through `_safeCall` for uniform coverage). It
re-syncs only the action's affected tables (`D1_NUDGE_TABLES` map) for the request's tenant,
one batched flush, fully swallowed/flag-gated. So D1 is current within ~1-2s of any write, not
up to 30 min. The 30-min trigger remains as the self-healing backstop.

**PHI status (honest):** the encryption boundary did NOT move — D1 stores the same opaque
`v1:iv:ct` ciphertext the Sheet stored; `interpreter-data` never decrypts/logs PHI;
`PHI_MASTER_KEY` stays in `1891-interpreter-api`. The `POST /v1/phi-audit` endpoint
(counts-only) returns `phi_intact:true, total_bad:0` — BUT every PHI column is
`populated:0`: the live Consumers/Interpreters rows carry NO encrypted PHI (initials only;
seed/demo-grade data). So the mechanism is correct but there was no populated PHI to move.

**Audit_Log — REPAIRED + syncing 2026-06-01 (was the phase-3 blocker):** the live tab had a
stale legacy header (`timestamp,action,form_id,detail,…`) ≠ schema (`audit_id,tenant_id,ts,…`).
Fixed reversibly:
- **Backup first:** full tab duplicated to `Audit_Log_bak_20260601141850` (28 data rows +
  original header preserved — restore = copy it back). `auditfixheader` has a safety
  interlock that refuses to run unless a `Audit_Log_bak_*` tab exists.
- **Header-row-only rewrite** (`?d1op=auditbackup` → `auditfixheader`): row 1 set to
  `_tenantSchema().Audit_Log`; **all 28 data rows untouched** (verified before==after==28).
  The data was already in schema order (`_logAudit` appended correctly; only the tab's
  pre-existing header was stale).
- **Exclusion lifted** (`D1_SYNC_EXCLUDE = {}`); Audit_Log now backfills + syncs like every
  other table.
- **One more bug the key-set check caught:** the single legacy `2026-05-17 smoke_test` row's
  `audit_id` literally IS an ISO timestamp, and `_d1Norm_` was epoch-converting it (PK
  `2026-05-17T…` → `1778998319`), breaking parity. Fixed: **PK columns are never normalized**
  — they round-trip verbatim as opaque identifiers (`_d1SyncTab_` `pkSet` guard).
- **Verified:** Audit_Log 28/28 keys match; full set **24 tables / 394 Sheet keys == 394 D1
  keys / 0 missing / 0 orphan; idempotent** (3 full backfills, no growth).

**Phase-3 readiness check:** `?d1op=keyset` does EXACT PK-set parity (not just counts). Latest:
**24 tables, 394 == 394, 0 missing, 0 orphan** — D1 holds exactly the Sheet's record set,
Audit_Log included. Remaining gate before flipping reads: a real **soak** (let the 30-min
trigger run clean for a day or two; re-check `?d1op=keyset`).

**Caveat:** schema applied via REST `/query`, NOT `wrangler d1 migrations apply`. Do not
run `migrations apply` for `0001` (would dup the `schema_version` row). See MIGRATION.md.

---

## Platform specs — caught up to 2026-05-25

| Umbrella spec | Version | Pass status | Lint wired into `deploy.sh` |
|---|---|---|---|
| [`shared/specs/SMS.md`](../../shared/specs/SMS.md) | v1 | `sms-consent-lint`: 0 FAIL, 0 WARN | ✅ |
| [`shared/specs/DASHBOARD_CONTRACT.md`](../../shared/specs/DASHBOARD_CONTRACT.md) | v1 | `dashboard-contract-lint --surface=admin`: 0 FAIL, 2 WARN (v2 items) | ✅ |
| [`shared/specs/PAYMENTS.md`](../../shared/specs/PAYMENTS.md) | Patterns F+G (Mode A canonical) | Live + dormant per `docs/PAYMENTS_IMPL.md` | n/a (no payments-side lint yet) |
| [`shared/specs/GODVIEW_AUTO_REGISTRATION.md`](../../shared/specs/GODVIEW_AUTO_REGISTRATION.md) | v1 | `godview-registration-lint`: ok | ✅ |

**Outstanding from the 2026-05-25 sweep:**

1. ~~All 5 SMS-send secrets wrangler-set on `1891-interpreter-api`~~ — **done 2026-05-25, Worker v `c671e3ef` deployed.** `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_AUTH_TOKEN` all live. Outbound SMS hits the shared 1891 SMS Gateway.
2. ~~Inbound routing decided + wired — shared hub path.~~ **Done 2026-05-25, both Workers redeployed.** SMS.md amended to v1.1 to acknowledge `workers/sms` IS the live shape. Interpreter added to `workers/sms/src/tenants.ts` TENANTS registry with callback `https://1891-interpreter-api.anthonymowl.workers.dev/v1/sms/inbound-from-hub`. New consumer in `workers/api/src/sms.ts` (`handleSmsInboundFromHub`) verifies HMAC-SHA256 against `HMAC_SECRET_INTERPRETER` (same value on both Workers, 49-char URL-safe base64). Hub redeploy required unstubbing 4 KV namespace IDs in `workers/sms/wrangler.toml`. Live smoke 2026-05-25: forged-sig → 403, real-sig → 200. Direct `/v1/sms/inbound` endpoint preserved for rollback.
3. **Apps Script `apiSmsInbound` is still designed for the direct-Twilio shape** but the new consumer translates the hub envelope onto the same `action`/`from_phone`/`body_normalised`/`twilio_msg_sid` payload, so no Apps Script changes were needed. If the Apps Script handler ever grows hub-specific fields (e.g. `received_at`), update both call sites in `sms.ts`.
4. Two dashboard-contract WARNs to clear as the admin grows: a search + sort + bulk-select triple under `site/app/admin/`, and an activity-timeline tab on the per-tenant record view. Both are v2 promotion items (WARN → FAIL after two more projects catch up), so no pre-deploy block today.

---

## Payments — architectural pivot 2026-05-19 → Mode A canonical

> **Read [`docs/PAYMENTS_IMPL.md`](docs/PAYMENTS_IMPL.md) §1 mode-map first.** Pattern F (SaaS subscription) is live and validated end-to-end. Pattern G (Connect OAuth read-only reporting) code shipped 2026-05-19, gated on Anthony enabling Connect-as-platform in the Stripe dashboard. Pattern A code paths (platform issues invoices, platform runs transfers) are intentionally preserved but deferred — they assume a money-transmitter posture we are NOT taking by default.

**State of the six flows as of 2026-05-19:**

1. **✅ SaaS subscription (Pattern F — LIVE).** Agency lands on `/pricing`, picks tier + cadence, hits `/pay/subscribe`, completes Stripe Checkout. Webhook flips the Agencies row to `subscription_status='active'`. Public Worker route: `POST /v1/public/billing/checkout` (rate-limited 10/5min/IP). In-app upgrade route: `POST /v1/billing/checkout` (auth via `X-1891-Internal`).
2. **✅ Branded welcome email (Pattern F support — LIVE).** Apps Script sends a plain-text welcome from `contact@madeby1891.com` with `name: BRAND_NAME` on every new `customer.subscription.created`. Idempotent on the new-Subscriptions-row guard.
3. **⏸️ Agency Connect OAuth read-only reporting (Pattern G — CODE READY, DEFERRED 2026-05-19).** Worker `POST /v1/connect/oauth/start` returns the Stripe Connect OAuth authorize URL; `POST /v1/connect/oauth/callback` exchanges the code + stamps `Agencies.stripe_connect_account_id`. Apps Script reads agency Stripe data via `Stripe-Account` header for in-app reports. **Deferred** because Stripe's modern Connect flow blocks live activation behind sandbox-prototype + their review queue — not worth the operational tax until a real agency asks for the reporting view. Code is shipped and dormant; routes return `{ok:false, status:'unconfigured'}` while `STRIPE_CONNECT_CLIENT_ID` is unset. To revive: see `docs/PAYMENTS_IMPL.md §1.5` "To re-light Pattern G."
4. **⚠️ Interpreter Connect Express onboarding (Pattern A — DEFERRED).** Worker code preserved at `workers/api/src/stripe.ts:createConnectAccount` for a future per-agency opt-in (Mode B). Would 400 at Stripe today (platform isn't a Connect platform yet).
5. **⚠️ Payer invoicing via platform Stripe (Pattern A — DEFERRED).** Same. The agency issues invoices in their own Stripe under Mode A; the platform shows them via Pattern G reporting.
6. **⚠️ Platform → interpreter transfer (Pattern A — DEFERRED).** Same. The agency runs payouts from their own Stripe.

**Live Stripe identifiers (acct_1TYabRRyhX2OZu5s — Made By 1891):**

| Tier | Annual | Monthly |
|---|---|---|
| Solo | `price_1TYdAiRyhX2OZu5s587CRrWw` ($108/yr) | `price_1TYdAjRyhX2OZu5sO0eTxOJx` ($11/mo) |
| Practice | `price_1TYdAlRyhX2OZu5sZUZQabVt` ($2,988/yr) | `price_1TYdAlRyhX2OZu5s7Ht18JkL` ($299/mo) |
| Studio | `price_1TYdApRyhX2OZu5sK8rpU7KJ` ($8,988/yr) | `price_1TYdAqRyhX2OZu5sVDaRZlFS` ($899/mo) |

Monthly prices are a ~20% premium over annual (see `site/pricing.html`).

- **Webhook endpoint:** `we_1TYdCARyhX2OZu5spASL0jxI` — live, subscribed to 19 events, URL is the API Worker.
- **Worker URL:** `https://1891-interpreter-api.anthonymowl.workers.dev`.
- **KV namespace to create at go-live:** `1891-interpreter-idempotency` (and `--preview` variant). Anthony runs `npx wrangler kv namespace create 1891-interpreter-idempotency` once and pastes the IDs into `workers/api/wrangler.toml`. The two `<placeholder>` strings under `[[kv_namespaces]]` are where they go.

**Top 5 webhook event types most likely to surface anomalies — watch these first when something feels off:**

1. **`charge.dispute.created`** — chargeback. Anthony pages himself. Evidence assembly is currently manual (Open Work item).
2. **`radar.early_fraud_warning.created`** — card network warned us of fraud before a dispute lands. Auto-refund preemptively if amount < $200 and customer is unreachable (per `shared/specs/PAYMENTS.md` §7.1).
3. **`invoice.payment_failed`** — either a SaaS subscription dunning event or a payer-invoice failure. The Subscriptions row should flip to `past_due`; if it doesn't within a minute, the webhook bridge dropped.
4. **`customer.subscription.deleted`** — agency canceled. Confirm `Agencies.subscription_status` flipped to `canceled` and `subscription_renews_at` was honored (no immediate access removal — wait for `current_period_end`).
5. **`transfer.reversed`** — Connect transfer was clawed back (insufficient funds at Stripe, KYC issue, etc.). Reconcile against the Payouts tab and surface to the affected interpreter.

The full event list + per-event behavior is in `docs/PAYMENTS_IMPL.md` §5.

**Cross-project pointer check:** the umbrella `1891-immersive/1891 Web/products/interpreter/index.html` pointer page links to its own in-page `#pricing` anchor only — no outbound link to `madeby1891.com/interpreter/pay/*` to update. Re-check this if the pointer page ever links to the live pricing CTA directly.

---

## Current state

**As of 2026-05-17 (afternoon):** Marketing site + working scheduler MVP **live and deployed** at `https://madeby1891.com/interpreter/`. Apps Script backend deployed (v4) with magic-link auth, jobs CRUD, and smart-fill. Host tenant Sheet provisioned with all 21 canonical PRD A3 tabs. Repo published at https://github.com/madeby1891/interpreter (public, per PRD F10 #10).

**2026-05-18:** Inbound SMS reply parsing wired end-to-end. Twilio → Worker (`/v1/sms/inbound`, HMAC-SHA1 signature verified per Twilio's spec) → Apps Script `apiSmsInbound` (worker JWT, purpose `twilio_inbound`). Reply parsing covers YES/Y/ACCEPT/CLAIM/OK, NO/N/DECLINE/PASS/SKIP, STOP family (opt-out — clears `Users.phone_e164` and forces `sms_mode='off'`), HELP family, unknown (canned reply pointing at the portal). Earliest pending offer wins when multiple are outstanding — reply text says "1 of N pending offers — earliest" so the interpreter knows. Worker is idempotent on Twilio `MessageSid` (15 min in-isolate cache) and rate-limits to 10 inbound/min per phone. Apps Script writes a `Communications` row per inbound with `direction='inbound'` and `provider_msg_id=<MessageSid>` for durable dedupe. Curl replay snippet for manual debugging is in `DISASTER_RECOVERY.md` §F2.

**What works end-to-end today:**
- A new visitor can read every page on the marketing site.
- Inbound forms (demo, contact, requestor sample, Deaf-owned application) write rows to the "1891 Interpreter" Google Sheet and email `hello@madeby1891.com`.
- Anthony (or anyone with a Users row) can `/sign-in` → receive a real magic link → land on `/app/` and use the scheduler.
- Scheduler creates jobs (writes Jobs row + Job_Events row + Audit_Log row), runs smart-fill (returns ranked interpreter candidates with transparent score breakdown), claims jobs, cancels jobs.
- Interpreter mobile view at `/app/claim/` lists OPEN jobs with deterministic pay estimates.
- All endpoints session-gated (HS256 JWT), all writes tenant-scoped, all PHI redacted on inbound.

**Earlier:** Marketing site v1 built. 41 HTML pages + sitemap + robots + `.htaccess` under `site/`. Builder under `_build/build.py`. Deploy + smoke scripts under `deployment/`. Anti-claim sweep, PII grep, broken-link audit all clean.

**Before that:** Project scaffolded fresh. PRD complete in `docs/` — six sections (A architecture, B stakeholders, C lifecycle, D AI features, E billing, F marketing).

The PRD was written in parallel by six research agents working from a brief that included the 1891 stack contract (`~/Desktop/1891/CLAUDE.md` + `~/Desktop/1891/ARCHITECTURE.md`), the speech-processing contract (`~/Desktop/1891/shared/specs/SPEECH_PROCESSING.md`), and Anthony's specific asks: free for Deaf-owned agencies, support all modalities (signed + spoken + CART + document translation), W-2 and 1099 interpreters, AI-assisted NL intake, HIPAA-defensible. Fallon Brizendine (CDI, MA Interpretation Gallaudet, former dept chair of an ASL interpreting program) is the SME for the domain; her voice shows up especially in Sections B (personas), C (modalities and team dynamics), and F (Deaf-owned verification process).

---

## Next 3 actions

In priority order. Each is one session of work or less.

1. **Email aliases.** Create `accessibility@madeby1891.com`, `security@madeby1891.com`, `privacy@madeby1891.com`, `legal@madeby1891.com` as aliases of `hello@madeby1891.com` in GoDaddy/Workspace. 5 minutes. The contact/legal pages reference these; right now they would bounce.
2. **Verification board.** Identify and confirm 2 community advisors so Deaf-owned applications can actually be approved. Until then, applications collect but decisions are paused.
3. **Onboard the first design partner.** The scheduler MVP works end-to-end on the host tenant. The next step is provisioning a second tenant Sheet for the first design-partner agency, adding their users + interpreters, and walking them through job creation on a Phase 0 white-glove call. Phase 0 onboarding script + first-day checklist need writing.

---

## Known blockers

- **No domain yet.** Until `1891interpreter.app` is registered, every URL in the PRD is hypothetical. Register before anything else.
- **No Cloudflare account stood up yet.** Need: R2 bucket, KV namespace, Queue, DO migrations, Secrets Store, Worker route. Workers BAA requires Enterprise tier — confirm pricing before architecting around it (recommendation in A9 #2: two-mode setup with free tier in `phi_mode: initials-only` to stay off the BAA-required path).
- **Anthropic BAA endpoint scope.** Need to confirm Claude on the direct Anthropic API has BAA coverage at the scale we'd use vs. AWS Bedrock route. Recommendation in D7.1: start with Anthropic direct.
- **Twilio HIPAA eligibility per product.** Twilio Verify and Programmable SMS are HIPAA-eligible; Programmable Voice has caveats. Confirm before OPI is built (Section A9 #12).
- **`host` tenant Sheet location.** Recommendation in A9 #9: Anthony's `anthonymowl@gmail.com` Workspace for now since BAA is in place there; migrate to `1891interpreter.com` Workspace once tenant count > 5. Needs Anthony's call.
- **Deaf-owned verification board membership.** Fallon + 2 community advisors. The 2 community advisors are not yet named. Identify before launching `/free-for-deaf-owned`.

---

## Open decisions

These are collected at the end of each PRD section. Decide before coding.

| Section | # | Decision | Recommendation |
|---|---|---|---|
| A9 | 1 | Sheet-per-agency vs master Sheet | Per-agency |
| A9 | 2 | Cloudflare BAA / enterprise requirement | Two-mode: free tier `phi_mode: initials-only`; paid tiers `full` |
| A9 | 3 | SMS vendor + Verify | Twilio Verify, not hand-rolled OTP |
| A9 | 4 | Email vendor | Postmark (BAA add-on) |
| A9 | 5 | Translation MT default | DeepL Pro where it supports the pair; Claude elsewhere; no pre-fill on legal/medical |
| A9 | 6 | Live STT vendor | Deepgram Nova-3 via `StreamingStt` interface |
| A9 | 7 | SAML for enterprise | Required for enterprise, optional for pro |
| A9 | 8 | Payment vendor | Stripe + Stripe Connect Express |
| A9 | 9 | Host tenant Sheet location | `anthonymowl@gmail.com` Workspace for now |
| A9 | 10 | WebAuthn requirement | Required on pro+, optional on free |
| A9 | 11 | Recurring jobs | Apps Script trigger materializing 30 days nightly |
| A9 | 12 | OPI telephony | Build the bridge ourselves later; defer in v1 |
| C10 | 1 | Cascade pattern | Parallel-3 first-claim-wins |
| C10 | 2 | ETA visibility to requestor | Off by default; agency toggle |
| C10 | 3 | Consumer feedback cadence | Monthly digest, not per-job |
| C10 | 4 | Interpreter name disclosure pre-job | Yes for healthcare/legal, off for K-12 by default |
| C10 | 5 | Marketplace after how many rounds | One round of parallel-3 |
| C10 | 6 | Workload-balance weight | 5%, visible in breakdown |
| C10 | 7 | CDI auto-required by setting | Auto-recommend, not auto-force |
| C10 | 8 | Geofence assist for arrival | Optional, never required |
| C10 | 9 | VRI failover retainer pay | Yes, small per-shift |
| C10 | 10 | Hold-the-slot vs re-cascade for recurrings | Hold-the-slot for 8+ week recurrings |
| D7 | 1 | BAA hosting path | Anthropic direct |
| D7 | 2 | Translation auto-mode for medical consent | No, hard-gated off |
| D7 | 3 | Recommender explainer | Hover by default |
| D7 | 4 | Voicemail intake auto-create | Always review |
| D7 | 5 | Two-way SMS prose replies | Route to scheduler with parsed summary |
| D7 | 6 | Anomaly detection — auto-block | Flag only |
| D7 | 7 | Claude visibility to interpreter on brief | Yes, label it |
| D7 | 8 | Fairness dashboard to interpreters | Yes, their own data |
| D7 | 9 | Cost ceiling at 100% — which features degrade | Essentials stay, nice-to-have degrades |
| D7 | 10 | NL reporting write access | No, read-only DSL |
| E10 | 1 | Money transmitter status | Agency-of-record by default |
| E10 | 2 | Stripe Connect Express mandatory | Default yes, manual ACH fallback |
| E10 | 3 | 1099 issuance in-house vs third party | Route through track1099 |
| E10 | 4 | Card surcharge default | Agency absorbs |
| E10 | 5 | Insurance billing in v1 | Defer to v2 |
| E10 | 6 | Multi-currency at launch | US-only v1, CAD by v1.1 |
| E10 | 7 | Subscription/retainer model | Yes, simple form only |
| E10 | 8 | Instant payouts permission | Agency enables, interpreter opts in per-payout |
| E10 | 9 | Dual-control threshold | $5,000 |
| E10 | 10 | Public Network tier price | Yes, publish floor "from $2,400" |
| F10 | 1 | Domain choice | `1891interpreter.app` |
| F10 | 2 | Hero leads with universal design or HIPAA | Universal design |
| F10 | 3 | Publish Network price | Yes, floor visible |
| F10 | 4 | Badge wording | "Deaf-owned · 1891 verified" |
| F10 | 5 | "Deaf-owned" vs "DHH-owned" | Deaf-owned public, DHH in standard text |
| F10 | 6 | Spoken vs signed billing on home | Equal billing |
| F10 | 7 | Customer logos before permission | No, page stays empty |
| F10 | 8 | Comparison page names Boostlingo | Yes, factual only |
| F10 | 9 | AMA cadence | Quarterly year 1 |
| F10 | 10 | Open-source marketing site | Yes |

---

## Last verified

| What                       | When         | Who      | Notes                    |
| -------------------------- | ------------ | -------- | ------------------------ |
| PRD all six sections drafted | 2026-05-16 | parallel agents | Sections A–F in `docs/` |

---

## How to keep working

1. Read `PROJECT_GUIDE.md` for the deploy contract.
2. Read `CLAUDE.md` for project-specific rules.
3. Read `docs/PRD_index.md` to find the relevant section before changing anything.
4. Make a change, commit, run the build (when one exists), smoke-deploy `--dry-run` first.
5. Update this file when you finish: bump "Current state", refresh "Next 3 actions", note anything new in "Known blockers."
6. Add a `CHANGELOG.md` entry if you shipped something user-visible.


---

## 2026-05-19 — Marcom refresh (the four-flagship pass)

Anthony asked for a fresh look at all product marcom around the four high-level surfaces — Parliamentarian, Meetings, Arena: Pickleball, Arena: Bowling — with the unifying foundation articulated. Shipped live the same day.

What landed in this project:

- Hero / lead copy aligned with `messaging/UNIFYING_NARRATIVE_2026-05-19.md` § 7 canonical one-liners.
- New "One workspace. Six things every product gets for free." strip (see § 4 of the narrative doc). Same six tiles, same words, breathing hover.
- New "Three siblings" cross-link strip pointing at the other three flagships (or the four flagships from secondary products).
- Voice pass against `MASTER_MESSAGING.md` § 5 kill list (where any hits were found).
- `prefers-reduced-motion` honored on every new animation.

Read order for any agent continuing this work:

1. `~/Desktop/1891/messaging/UNIFYING_NARRATIVE_2026-05-19.md` — north star
2. `~/Desktop/1891/messaging/MASTER_MESSAGING.md` — voice
3. This file
