# CHANGELOG — 1891 Interpreter

Dated history of changes. Newest entries at the top. Note user-visible changes only; engineering refactors that don't change behavior can stay out.

---

## 2026-05-17 — v11: Document translation pipeline + Stripe Connect + track1099 + Plaid

Two more parallel agents shipped, all integrated.

### Apps Script v11 (5 .gs files deployed, version 13)

- **`Code_Translate.gs`** (29 KB) — full translation workflow: REQUESTED → IN_TRANSLATION → IN_REVIEW → APPROVED → DELIVERED. State machine refuses to skip review (no auto-approval on legal/medical). PDF export reuses the invoice template with a sworn-translation footer when service_type is `legal` or `gov`. Full source/target text lives in lazy-created `Translation_Sources` / `Translation_Targets` tabs to keep main Documents rows small.
- **`Code_Payments.gs`** (34 KB) — Stripe Connect onboarding, transfers, invoice send, 1099-NEC issuance via track1099, Plaid scaffolding. Provides `_payMintInternalSession` so the Worker can call back into Apps Script with a synthesized internal session JWT.
- **`Code.gs`** router extended with 19 new routes:
  - GET: `list_documents`, `get_document`, `download_translation`, `list_stripe_accounts`, `list_1099_forms`, `payment_setup_status`
  - POST: `create_translation_job`, `start_translation`, `submit_translation_review`, `approve_translation`, `reject_translation`, `cancel_translation`, `connect_account_link`, `connect_account_refresh`, `payout_send`, `invoice_send`, `issue_1099_nec`, and 3 credential-setup endpoints

### Cloudflare Worker v2 (deployed, 48 KB, version `93a56dcb`)

- **`src/translate.ts`** — `/v1/translate/prefill` (DeepL or Claude based on language pair + hard-gate) and `/v1/translate/glossary`. DeepL allowlist hard-coded: `en, es, de, fr, it, ja, pt-PT, pt-BR, ru, zh-CN, zh-TW, ko, nl, pl, sv, tr, ar`. ASL/PSE/ProTactile/CDI never route to DeepL. PHI scrubber is a TS port of `_redactForModel`.
- **`src/stripe.ts`** — Stripe API client + HMAC-SHA256 webhook signature verification + event router (invoice.paid → mark_invoice_paid, transfer.paid → mark_payout_paid, account.updated → update_interpreter). Constant-time signature compare.
- **`src/track1099.ts`** — 1099-NEC create + status fetch, sandbox base override, dash-stripping TIN handling.
- **`src/internal.ts`** — `X-1891-Internal` header verify (constant-time) for machine-to-machine callbacks from Stripe webhooks back into Apps Script.
- **71/71 vitest passing** (cors 18 + jwt 6 + proxy 5 + translate 24 + stripe 21 + track1099 8)

### New /app/ pages (all live)

- **`/app/translate/`** — list + filter chips + "+ New translation" modal + two-pane source/target editor + glossary panel with click-to-paste + hard-gate banner for `medical, mental-health, legal, gov` service types (translator must work from scratch, no MT pre-fill) + state-aware action buttons + timeline + redaction summary chips
- **`/app/payments/`** — integration status grid (Stripe / track1099 / Plaid configured?), interpreter Stripe Connect status table (charges enabled, payouts enabled, requirements due), 1099-NEC issuance table with year picker + IRS-deadline gate
- **`/app/payments/connect.html`** — interpreter-facing onboarding return page (after they finish Stripe's hosted flow)
- **`/app/payments/setup.html`** — agency-owner setup: Stripe Connect platform credentials, track1099 API token, Plaid client_id/secret

### Stripe webhook endpoint (to register in Stripe Dashboard when you're ready)

```
https://1891-interpreter-api.anthonymowl.workers.dev/v1/stripe/webhook
```

Subscribe to: `invoice.paid`, `invoice.payment_succeeded`, `transfer.paid`, `transfer.created`, `account.updated`, `charge.dispute.created`, `charge.refunded`, `charge.failed`.

### Worker secrets to set when you have accounts

```
wrangler secret put STRIPE_API_KEY          # sk_test_... in dev, sk_live_... in prod
wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_... from Stripe Dashboard
wrangler secret put TRACK1099_API_KEY
wrangler secret put PLAID_CLIENT_ID
wrangler secret put PLAID_SECRET
wrangler secret put DEEPL_API_KEY           # optional; if missing, falls through to Claude
wrangler secret put ANTHROPIC_API_KEY       # for the Worker-side translate prefill
```

Site CSP already allows the Worker domain; nothing else to change to flip these on.

### Known follow-up

Stripe webhook callback into Apps Script uses `X-1891-Internal` header, but Apps Script doesn't expose request headers to script code. The Worker should mint an internal session JWT (it has the shared HMAC secret) and pass it as `&session=<jwt>` instead. ~30 min fix, queued for v12.

---

## 2026-05-17 — v10: PDF generation + white-label theming + Cloudflare Worker LIVE

The three follow-ups from v9 all shipped.

### Cloudflare Worker — `https://1891-interpreter-api.anthonymowl.workers.dev`

- Deployed via `wrangler deploy`. Durable Object binding `JOB_BOARD_ROOM` active. Worker version `c40760ca-0084`.
- `JWT_SECRET` set via `wrangler secret put`. Apps Script `HMAC_SECRET` rotated to match via the one-shot `?action=_rotate_hmac&setup=<sheet_id>&new=<secret>` endpoint. Same signing key both sides → Worker can verify Apps Script-issued session JWTs.
- `site/assets/js/api.js` and `main.js` now point at `https://1891-interpreter-api.anthonymowl.workers.dev/v1/proxy/exec`. **JSONP is no longer required** — the Worker adds `Access-Control-Allow-Origin: https://madeby1891.com` so browser fetches read the JSON response directly. JSONP still works as a fallback (Worker passes `callback` through to the upstream).
- CSP in `.htaccess` extended with `script-src` + `connect-src` + `wss:` for the Worker subdomain.
- All existing sessions invalidated by the HMAC rotation. Sign in again.

### PDF generation (`Code_Invoicing.gs`, appended)

- `apiInvoicePdf(?id=...)` — renders a real branded invoice from agency name + brand color + line items + payer info. HTML → PDF via `Utilities.newBlob(html, 'text/html').getAs('application/pdf')` (Drive's converter). PDF is returned to the browser inside an HTML wrapper that embeds it via `data:application/pdf` URL — opens inline in any modern browser, savable from the embed.
- `apiPayoutPdf(?id=...)` — same shape, pulls assignment-level "lines" from Job_Events `payout_included` ledger, renders an interpreter-facing pay statement with optional Stripe transfer ID.
- "Download PDF" buttons on `/app/invoices/` and `/app/payouts/` detail views now actually work.
- Audit-logs `invoice.pdf_generated` / `payout.pdf_generated` on every render.

### White-label theming

- `apiWhoami` now returns `agency: { tenant_id, legal_name, tier, brand_color, timezone, phi_mode }` alongside the user object.
- New `site/assets/js/whitelabel.js` (loaded before `api.js` on every `/app/*` page):
  - Reads cached theme from localStorage and applies CSS-var overrides synchronously on first paint (no flash of default branding)
  - After fresh whoami: derives `--1891int-bloom-deep` (22% darker), `--1891int-bloom-soft` (45% lighter), `--1891int-bloom-tint` (72% lighter) from the agency's brand_color
  - Replaces the "1891 Scheduler" header lockup with `<Agency name>` + a quiet "powered by 1891" subtext
  - Prefixes document.title with the agency name
- Cross-page sweep: Python script patched all 12 `/app/*/index.html` pages to load `whitelabel.js` and call `IntTheme.apply(r.agency)` after whoami. The change is one-and-done.

### Other fixes in this push

- Recovered `site/assets/js/main.js` (also a xattr-loss victim) — marketing forms now POST through the Worker proxy with `mode: 'cors'`, so we read real responses instead of fire-and-forget.

### What's now real that wasn't 30 minutes ago

- **PDF invoices and payouts** — every agency can hand a real branded PDF to a payer or interpreter
- **Tenants have their own brand identity** — when a tenant sets `brand_color`, it propagates through the entire app shell on next page load
- **Live edge proxy** — the foundation Worker for live job-board WebSockets, request-level caching, future RPC into AgencyHub DOs

### Still on the vaporware list (now smaller)

- Stripe Connect Express payouts / track1099 / QuickBooks-Xero-NetSuite-Bill.com
- Document translation pipeline (DeepL Pro + Claude fallback per PRD)
- VRI WebRTC client / OPI Twilio bridge / Deepgram live STT
- SSO/SAML, WebAuthn passkey enforcement
- Logo upload (brand color is enough for now; full logo support needs file storage in R2)
- Email aliases + verification board members (your call, can't automate)

---

## 2026-05-17 — v9: Invoicing + Payouts + Multi-tenant provisioning + Cloudflare Worker

Three parallel agents shipped, all integrated into the same `/exec` deployment.

### Apps Script v9 (deployed) — 4 files now in the project

- **`Code.gs`** (the main router) — added convention-based dispatcher `_safeCall(fnName, e)` that lets satellite `.gs` files register their endpoints. Pre-wired routes for invoicing (`list_invoices`, `get_invoice`, `create_invoice`, `update_invoice`, `mark_invoice_paid`, `void_invoice`, `list_payouts`, `get_payout`, `create_payout`, `mark_payout_paid`) and multi-tenant (`list_tenants`, `get_tenant`, `list_tenant_owners`, `provision_tenant`, `switch_tenant`, `add_tenant_owner`). `switch_tenant` routed under both GET (for JSONP read of the new session) and POST.

- **`Code_Invoicing.gs`** (29 KB) — Agent A:
  - `apiCreateInvoice` auto-includes COMPLETED jobs in range not already on an Invoice_Line. Computes hours from claimed Assignment's `billable_minutes` (falls back to scheduled span). Rate-card cascade: `rate_card.<svc>.<mod>.<team>.hourly_cents` → `rate_card.<svc>.on-site.solo.hourly_cents` → 9500 floor. Enforces `rate_card.minimum.<svc>.hours` (2.0 default). `dry_run=true` returns line preview without writing. Line descriptions use `display_initials` — never names.
  - `apiMarkInvoicePaid` flips status and writes `Job_Events` 'invoice_paid' per linked job.
  - `apiVoidInvoice` (owner/admin) deletes Invoice_Lines rows so jobs become re-billable. Refuses to void a paid invoice.
  - `apiCreatePayout` pulls claimed assignments tied to COMPLETED jobs in range that aren't already in `Job_Events.payout_included` (dedupe ledger). Pay rate from `pay_rate_snapshot.hourly_cents` or 60% of bill-side rate.
  - 1099 YTD computed paid-only, calendar-year, per-interpreter.

- **`Code_Multitenant.gs`** (26 KB) — Agent B:
  - `_ensureControlSheet()` — idempotent; reads `PropertiesService.CONTROL_SHEET_ID`, creates the `1891-interpreter-control` Sheet via `SpreadsheetApp.create()` if missing, ensures `Tenants` / `Tenant_Owners` / `Sys_Log` tabs with documented headers.
  - `_resolveTenantSheetId(tenantId)` — `host` short-circuits to the hard-coded `SHEET_ID`; everyone else resolves via the control Sheet. Future endpoints in `Code.gs` should call this with `session.payload.tid` instead of the global `SHEET_ID` directly (migration deferred to a later session).
  - `apiProvisionTenant` (host-owner-gated) creates a new `1891-interpreter-<slug>` Sheet, runs full schema bootstrap on it, adds Tenants + Tenant_Owners + Sys_Log rows, emails the new owner a sign-in link.
  - `apiSwitchTenant` mints a fresh session JWT with the new `tid` claim — only if the user is in `Tenant_Owners` for that tenant OR is the host owner.
  - `apiListTenants` always surfaces the `host` row (since it isn't in the control Sheet by design). `spreadsheet_id` is masked from non-host owners.

### New /app/ pages (all live)

- **`/app/invoices/`** — list + filter chips (All / Draft / Issued / Paid / Overdue / Void), "+ New invoice" modal with **dry-run preview** before commit, single-page detail via `?id=`, "Mark paid" / "Void" actions
- **`/app/payouts/`** — list + per-interpreter calendar-YTD running total, "+ New payout" with dry-run, detail via `?id=`, "Mark paid" with optional Stripe transfer-ID field
- **`/app/admin/`** — host-owner-gated dashboard (tenant count, active users, jobs this month)
- **`/app/admin/tenants/`** — tenant list + provision modal (slug-validated tenant_id, legal_name, owner_email, tier, phi_mode, timezone) + "Switch into" button that calls `apiSwitchTenant` and reloads the dashboard inside the new tenant

### Cloudflare Worker — `workers/api/` (Agent C)

Real source, real wrangler config, real tests, ready to `wrangler deploy`. 11 files:

- `src/index.ts` (router), `src/cors.ts`, `src/jwt.ts` (matches Apps Script's compact HS256 JWT), `src/proxy.ts` (CORS proxy to the Apps Script /exec), `src/sse.ts`, `src/durable/JobBoardRoom.ts` (per-tenant DO with WebSocket + SSE fallback, 25s SSE heartbeat)
- `tests/cors.test.ts` — **18/18 passing**: CORS preflight, JWT verify-good/tampered/expired, proxy forwarding, dev-origin handling
- `wrangler.toml` with DO binding `JOB_BOARD_ROOM` → `JobBoardRoom` class, migration `v1` declares `new_classes`
- `README.md` with the deploy sequence

**To deploy the Worker** (your call — needs your Cloudflare account):
```
cd workers/api && npm install && wrangler deploy
wrangler secret put JWT_SECRET   # paste the Apps Script HMAC_SECRET from PropertiesService
```

Then edit `site/assets/js/api.js` line 6 to point `ENDPOINT` at the Worker URL — JSONP can be retired in a follow-up since the proxy returns CORS headers.

### What's real now end-to-end

Add a Deaf-owned design partner. From the admin tenants page, provision their tenant — fresh Google Sheet created + schema bootstrapped + welcome email sent. Switch into their tenant; walk the 5-step onboarding; create a job from a pasted email via AI intake; smart-fill ranks their roster; offer; claim; confirm; complete; **create invoice** from completed jobs (with dry-run preview); mark paid; **create payout** for the interpreter; mark paid with Stripe transfer ID. Every step audit-logged. Future expansion: deploy the Cloudflare Worker to swap JSONP for direct CORS-clean reads + live job-board WebSocket.

---

## 2026-05-17 — AI intake, full job state machine, offer-to-interpreter, settings + job detail

Closing the loop end-to-end on the scheduler: parse an email into a draft → offer to ranked candidates → claim → confirm → start → complete → audit trail visible per job.

**Apps Script v7 (deployed):**
- `apiAiIntake` — accepts pasted email text, runs PHI redaction (SSN/MRN/phone/DOB/email/name-pattern), POSTs to `https://api.anthropic.com/v1/messages` with model `claude-sonnet-4-5` (1024 tokens), parses returned JSON, audits input/output hashes only (no PHI in audit body). Tenant ID prefixes the system prompt to prevent prompt-cache cross-tenant hits per PRD A6.
- `apiTestAnthropic` — admin endpoint that does a 16-token Haiku ping to confirm the key works without spending tokens.
- `apiOfferJob` — writes Job_Assignments row with response=offered, flips Jobs.status → OFFERED, sends a real email to the interpreter via MailApp, logs to Communications tab.
- Full state machine: `apiConfirmJob` (CLAIMED → CONFIRMED), `apiStartJob` (CONFIRMED → EN_ROUTE → IN_PROGRESS with actual_start), `apiCompleteJob` (→ COMPLETED with actual_end + computed billable_minutes including the 2-hr minimum from Settings).
- `apiListAssignments` / `apiListJobEvents` / `apiListCommunications` — read endpoints scoped by tenant + optional job_id filter.
- Communications tab now gets a row for every email sent through the platform.
- Anthropic API key resolution: PropertiesService.ANTHROPIC_API_KEY OR Settings tab `anthropic.api_key` (admin-settable from /app/settings/).
- All new endpoints session-gated, all writes audit-logged.

**New /app/ pages:**
- `/app/settings/` — agency editor, **Anthropic API key configurator** with "Test key" button (the AI intake feature flips on the moment a valid key is dropped in), rate-card editor, subprocessor disclosure list.
- `/app/intake/` — paste-an-email pane on the left, parsed Job draft on the right with per-field confidence percentages, redaction summary chips ("phone: 1", "name_pattern: 2"), and a list of model-flagged ambiguities. "Create job from this draft" submits to apiCreateJob with `created_via=email-intake`. Falls back to JSONP when CORS blocks the direct POST.
- `/app/job/?id=...` — single-job detail page. State-chip strip showing the full lifecycle (DRAFT → OPEN → … → PAID) with current state highlighted. Action buttons that change based on current state (Confirm, Mark en route, Start, Complete, Cancel). Three timeline panels: Assignments, Job_Events, Communications — every row is read live from the tenant Sheet.

**Dashboard upgrades:**
- Smart-fill candidates now have an "Offer to ..." button that fires `apiOfferJob`. The button confirms with "✓ Offered" inline; the job flips to OFFERED state and the interpreter gets a real email.
- Every job card has a new "Open" button that goes to `/app/job/?id=...`.
- App nav extended across all `/app/*` pages: Day-of board · Interpreters · Requestors · **AI intake** · Interpreter view · **Settings**.

**End-to-end flow now possible from a cold start:**
1. Run `/app/onboard/` (5-step wizard) → agency + first interpreter + first requestor + rate cards.
2. Drop your Anthropic key in `/app/settings/` → test it.
3. Paste an inbound email into `/app/intake/` → click Parse → review the AI-extracted Job draft → Create.
4. On the dashboard, click Smart-fill on the new job → see your interpreter ranked → click "Offer to ...".
5. Interpreter receives email; opens `/app/claim/`; claims.
6. Scheduler opens `/app/job/?id=...` → clicks Confirm → Mark en route → Start → Complete.
7. Every transition writes to Job_Events and Audit_Log; the timeline panel reflects them live.

**Recovery note:**
A subset of local files (Code.gs, several site HTML pages, brand SVGs, deploy/smoke scripts) lost their content earlier in the session — `stat` reported normal sizes but `read()` returned 0 bytes. Cause appears to be a macOS xattr / metadata-only filesystem event. Restored by `clasp pull` (for Code.gs) and `git checkout` (for tracked site files); regenerated PDF + sitemap with the existing builder. No data loss on the live site or in the Sheet.

---

## 2026-05-17 — Roster, requestors, and a 5-step onboarding wizard

Closing the loop on the scheduler MVP: smart-fill now has data to rank against, jobs can point at real requestors, and a first-time agency can self-serve through setup.

**Apps Script v5 (deployed):**
- `apiListInterpreters` / `apiCreateInterpreter` / `apiUpdateInterpreter` — full interpreter roster CRUD with tenant scoping, JSON-encoded `languages` / `certifications` / `modalities` fields, and an audit-log entry on every write.
- `apiListRequestors` / `apiCreateRequestor` — booking-party CRUD with type categorization (medical/legal/education/etc.) and PO-required flag.
- `apiUpdateAgency` — owner-role gated; updates the host Agency row's legal_name, timezone, PHI mode, brand color, billing email.
- `apiListSettings` / `apiUpdateSetting` — admin-gated rate-card and policy key/value editing. Auto-creates new keys if missing; bumps `updated_at` and `updated_by_user_id` on existing ones.

**New /app/ pages (live):**
- `/app/interpreters/` — roster page with add-interpreter modal (full intake: name, pronouns, classification, languages, certifications, home location, service radius, modalities, CDI flag, internal notes).
- `/app/requestors/` — requestors page with add-requestor modal (display name, type, PO requirement, notes).
- `/app/onboard/` — 5-step wizard that walks a first-time agency through:
  1. Agency confirmation (legal name, timezone, PHI mode, billing email, brand color)
  2. First interpreter (name, language pair, classification, CDI flag)
  3. First requestor (name, type)
  4. Rate-card defaults (medical / legal / education hourly cents, translation per-word, minimum hours, late-cancel window)
  5. Summary + links into the rest of the app
- Each panel saves to the live API before advancing. Step indicators turn green when complete.

**Dashboard upgrades:**
- New-job modal now fetches real requestors from `apiListRequestors` and populates the dropdown on open.
- App-shell nav extended: Day-of board · Interpreters · Requestors · Interpreter view · Setup. All five `/app/*` pages share the same chrome.

**Smart-fill is now demonstrable.** Add an interpreter through the wizard or roster page, create a job, click Smart-fill — you'll see at least one ranked candidate with the 5-factor score breakdown instead of "no interpreters yet."

---

## 2026-05-17 — Backend goes from vaporware to working scheduler MVP

Turning the marketed product into something a design-partner agency can actually use.

**Tenant data layer (real, deployed):**
- Apps Script `bootstrapHostTenant()` builds every canonical tab from PRD A3 — 21 tabs: Agencies, Users, Roles, Interpreters, Languages, Certifications, Requestors, Requestor_Contacts, Payers, Consumers, Locations, Jobs, Job_Assignments, Job_Events, Communications, Invoices, Invoice_Lines, Payouts, Documents, Settings, Audit_Log.
- Seeds: 8 system Roles (owner/admin/scheduler/interpreter/requestor_contact/payer_contact/consumer_self/auditor) with permission JSON. 20 Languages (ASL, ProTactile, Spanish dialects, Mandarin, Cantonese, Arabic, Haitian Creole, etc.). 17 Certifications (NIC, CDI, BEI tiers, SC:L, EIPA tiers, CCHI, NBCMI, CMI-Spanish, ATA, FCICE, CRC-NCRA, MD-Court-Cert).
- Host tenant ('host' tenant_id) auto-provisioned in Agencies row; Anthony Mowl's owner User row auto-created.
- Default Settings seeded: rate cards (medical $95/hr, legal $125/hr, education $85/hr, translation $0.20/word), cancellation policy (24hr window, 15min no-show), terminology defaults.

**Backend API (real, deployed at the same Apps Script URL):**
- Magic-link auth — `POST action=auth_request&email=...` issues a token, emails the user a one-time link (15-min TTL). `GET action=auth_verify&token=...` exchanges the token for a session JWT (HS256 over PropertiesService-stored secret, 14-day TTL).
- Sessions are passed back via JSONP-wrapped responses; the script can be called from the marketing site cross-origin because `doGet`/`doPost` now support a `callback` query param that wraps responses in callback(JSON).
- Jobs API: `create_job`, `list_jobs`, `get_job`, `claim_job`, `cancel_job` — all session-gated, all tenant-scoped, all writing to the canonical Jobs / Job_Assignments / Job_Events tabs. State machine: DRAFT → OPEN → OFFERED → CLAIMED → CONFIRMED → EN_ROUTE → IN_PROGRESS → COMPLETED → BILLED → PAID with cancellation side-branches.
- Smart-fill v1: deterministic 5-factor scoring (certification fit 30 / location 20 / preference 20 / workload 15 / performance 15 = 100). Transparent score breakdown returned per candidate. AI ranking deferred to a Worker.
- All endpoints write to `Audit_Log` with action / tenant_id / user_id / detail.
- `clasp` used for deploys — no more four-click flow needed. `apps-script/.clasp.json` points at the script project.

**Scheduler MVP (real, behind auth) at `/interpreter/app/`:**
- `app/callback.html` — magic-link verifier; sets localStorage session, redirects to dashboard.
- `app/index.html` — day-of board. Color-coded job cards by status (OPEN bloom, CLAIMED river, CONFIRMED green, etc.). Filter by status. Keyboard nav (`/` for filter, `Esc` to close modals). New-job modal with full intake form (modality, languages, datetime range, team config, notes). Smart-fill modal with ranked candidates and visible score breakdown. Claim / cancel actions on each card.
- `app/claim/index.html` — phone-first interpreter view. Lists OPEN jobs with deterministic pay estimate ($95–125/hr × hours, 2-hour minimum applied per Settings). Two-tap claim with confirmation. Off-canvas decline.
- Shared `assets/css/app.css` (~400 lines) + `assets/js/api.js` (JSONP client).

**Sign-in (real, replaces placeholder):**
- `/interpreter/sign-in.html` now POSTs to the live Apps Script via `IntApi.authRequest()`. User gets a real email with a real link. Clicking the link lands on `/app/callback.html` → session minted → dashboard.

**Verification standard PDF (real, generated):**
- `/interpreter/assets/docs/deaf-owned-verification-standard.pdf` — actual PDF document built via ReportLab. Linked from `/free-for-deaf-owned` next to the HTML mirror. 5.7 KB, ATS-readable, brand-consistent.

**Tooling:**
- `clasp` 3.3.0 installed locally in the project (`node_modules/`), `.clasp.json` configured. `clasp push` + `clasp deploy --deploymentId ...` redeploys without browser involvement. The four-click flow is now optional.

**Still vaporware** (documented in HANDOFF):
- Cloudflare Workers (hot paths — real-time presence, faster reads, BAA-tier processing). Tracked in PRD A4.
- Stripe Connect Express, track1099, QuickBooks/Xero/NetSuite/Bill.com integrations.
- VRI WebRTC client.
- AI intake parser (PRD D2).
- Document translation pipeline.
- Live STT integration (Deepgram).
- SSO/SAML.
- White-label tenant theming.

---

## 2026-05-17 — Apps Script inbound-forms backend live

- Apps Script project **"1891 Interpreter — Inbound forms"** created and deployed as a Web app. Project ID `1m74_xIJtXWBw7ok_73_srlnMkfpO50TPxZEJFXBw4pTYdRQcLaBnJEwg`. Deployment URL baked into `site/assets/js/main.js`.
- Standalone (not container-bound) — opens the "1891 Interpreter" Sheet (`1RKY0n-dStOoyLtayppvQ0prGVFXMiR0aHg0C_u7eigE`) via `SpreadsheetApp.openById`. Chosen because the Sheets "Extensions → Apps Script" menu uses Material listboxes that require real `event.isTrusted` clicks — un-automatable via Chrome MCP.
- Source: `apps-script/Code.gs` + `apps-script/appsscript.json`. To redeploy after edits: open the script, paste new Code.gs, Save, then **Deploy → Manage deployments → ✏️ pencil → New version → Deploy** (the four-click manual flow per root CLAUDE.md).
- Writes inbound submissions to three tabs in the Sheet:
  - **Inbound** — every form_id, full columns covering all forms (timestamp, form_id, name, email, organization, agency_size, modality, current_platform, helps, topic, message, language, when, setting, notes, agency_legal_name, state_of_formation, owner_name, documentation_type, page, raw_params).
  - **Deaf_Owned_Applications** — additionally appended for `form_id=deaf_owned_application` with a `review_status` workflow column (pending → approved/denied).
  - **Audit_Log** — every doPost + every notification attempt + every PHI-filter rejection.
- Notification email routing: `hello@madeby1891.com` by default; `accessibility@madeby1891.com` for accessibility feedback forms; `security@madeby1891.com` for security disclosure forms.
- PHI guardrail: `scanForLikelyPHI_` rejects submissions with SSN-shape strings, and rejects submissions to the requestor sample form that contain clinical red-flag terms (diagnosis, MRN, patient name, DOB, HIV, cancer, etc.). Rejected submissions are logged to Audit_Log with the reason.
- Smoke-tested: `GET /exec` returns expected service JSON; `POST /exec` ran 4.6s and completed in the execution log; Inbound + Audit_Log tabs auto-created on first hit.
- Site `main.js` updated to call the endpoint via `fetch(..., { mode: 'no-cors' })` — fire-and-forget pattern (Apps Script doesn't return CORS headers; can't read the response cross-origin, but the row lands either way).
- CSP in `.htaccess` updated to allow `connect-src https://script.google.com https://script.googleusercontent.com` and matching `form-action`.

**Still to do:**
- Run `bash deployment/deploy.sh` to push the now-final site to `madeby1891.com/interpreter`.

---

## 2026-05-17 — Marketing site v1 built, ready to deploy

- Built the public marketing site under `site/` — 41 HTML pages plus sitemap, robots, and `.htaccess` security baseline. Target URL: `https://madeby1891.com/interpreter/`.
- Pages: home, 5 audience pages (`for-agencies`, `for-schedulers`, `for-interpreters`, `for-requestors`, `for-payers`), pricing, free-for-deaf-owned, get-a-demo, start-free, contact, sign-in, features index + 9 feature children, security, accessibility, about, our-1891, changelog, 4 content stubs (blog/case-studies/customers/resources), 9 legal pages (privacy, terms, BAA, DPA, subprocessors, accessibility-statement, responsible-disclosure, DMCA, deaf-owned standard mirror), and a real 404.
- Design system at `site/assets/css/site.css` — brand tokens per PRD F5 (`--1891int-bloom: #C8553D`, `--1891int-river: #2E5E5C`), serif display, warm paper, dark-mode + reduced-motion handling.
- Builder at `_build/build.py` — single-pass Python script that renders all pages from a content registry. Run `python3 _build/build.py` to regenerate.
- Deploy infra: `deployment/deploy.sh` (rsync over `~/.ssh/ftd_godaddy_deploy`) and `deployment/smoke.sh` (curl-based smoke checks against the live URL).
- Security baseline shipped: `.htaccess` blocks `/deployment/`, `/_build/`, `*.md`, `*-secret.*`; real `/404.html` (not soft-200); HSTS preload, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy locks down camera/mic/geolocation/etc., strict CSP with no external scripts.
- PII safety: deploy script greps for personal emails, SSN-shape, and phone-number-shape patterns and refuses to deploy on any match. Pre-build sweep clean (0 hits).
- Anti-claim sweep clean: zero instances of the F1.3 banned phrases ("AI-powered", "revolutionary", "cutting-edge", "enterprise-grade", "empowering", "best-in-class", "accessibility solution", "underserved community", "leverage", "synergy").
- Internal link audit: 41 pages scanned, 0 broken internal links.
- Forms POST to placeholder `/api/lead` and `/api/auth/magic-link`; backend not yet wired. JS-side fallback shows a polite confirmation so the page works on first day even without backend.

**Not yet:**
- Backend endpoints (`/api/lead`, `/api/auth/magic-link`) — Apps Script or Worker.
- The PDF mirror of the Deaf-owned verification standard. HTML mirror is at `legal/deaf-owned-verification-standard.html`.
- ASL inset videos on every page — placeholder ASL frame on home; remaining pages reference but don't yet host.
- Logo wall on `/customers/` — intentionally empty per PRD F10 #7.

**To ship:**
```
bash deployment/deploy.sh --dry-run   # verify
bash deployment/deploy.sh              # ship
```

---

## 2026-05-16 — Project scaffolded, PRD complete

- Created `~/Desktop/1891/projects/interpreter/` from the 1891 project starter pattern.
- Drafted the v1 master PRD in six sections (A through F) — see `docs/PRD_index.md`. Sections cover:
  - **A.** Architecture, data model, multi-tenant Sheet schema, Worker design, auth, HIPAA + PII compliance posture.
  - **B.** Stakeholders (13 roles), permissions matrix, per-role dashboards, team-interpreter dynamics, W-2 vs 1099 split, multi-agency 1099 (DeShawn's Tuesday), onboarding flows, accessibility commitments.
  - **C.** Full job lifecycle state machine, intake-to-assignment happy path, smart assignment engine (transparent scoring), modality-specific flows, cancellations/no-shows/replacements, KPI dashboard.
  - **D.** AI feature inventory (15 features), NL intake deep dive, communications matrix (40 events), audio/speech contract integration, AI guardrails, i18n.
  - **E.** Rate-construct lexicon, invoicing, payer portal, interpreter payouts (W-2 + 1099 + 1099-NEC + 1042-S + 1099-MISC), money-flow architecture (agency-of-record vs marketplace), tax handling, QBO/Xero integration, audit + SOX-light, reporting.
  - **F.** Brand positioning, sitemap, public pricing for every tier including Network floor, Deaf-owned verification process, brand identity primitives, 6-month content plan, SEO targets, 4-phase launch plan, competitive matrix, open marketing decisions.
- 50+ open decisions collected at the ends of A9, C10, D7, E10, F10, each with a recommendation. To be locked in a future decisions sweep.
- Wrote project root files: README, PROJECT_GUIDE, HANDOFF, CLAUDE, DISASTER_RECOVERY, CHANGELOG (this file).

Next: domain registration, repo creation, tenant Sheet template, Apps Script scaffold, Worker scaffold.
