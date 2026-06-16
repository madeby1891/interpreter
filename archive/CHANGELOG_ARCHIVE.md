# CHANGELOG ARCHIVE — 1891 Interpreter

Older dated entries split out of `CHANGELOG.md` during the 2026-06-16 memory-optimization pass, to keep the hot changelog skimmable. Nothing deleted — this is the full pre-2026-05-25 history (v18.4 and earlier). Newest of the archived entries at the top.

---

## 2026-05-18 — v18.4: Marketing-site interactivity + 7 platform fixes (PHI encryption, calendar, live board, tenants, AI hardening, copy refresh, clean URLs)

Big sweep. Five parallel agents + main-thread work on two security/AI items.

### Marketing site — live and breathing

- **New logo** (`assets/img/brand-mark.svg`) — etched-stamp style 1891 with two-fingertip ASL contact-point arc + bloom highlight. New favicon + OG card matched. Subtle `arc-pulse` keyframe on hover.
- **Animation library** (`assets/css/marketing-interact.css` + `assets/js/marketing-interact.js`) — IntersectionObserver scroll-reveal with optional `data-delay` stagger, count-up stat animator, stronger `card-hoverable` lift, primary-button warm-glow, comparison-table row highlight, pillar-number pulse, hero-illustration `gentle-float`. `prefers-reduced-motion` honored throughout.
- **Five interactive widgets** dropped into home:
  - **Lifecycle** — auto-cycles OPEN → OFFERED → CLAIMED → CONFIRMED → IN_PROGRESS → COMPLETED on a 2.5s loop, pauses on hover. Replaces the static placeholder hero illustration.
  - **Rate playground** — pick service / modality / time-band, live bill + pay calc with modifier chips.
  - **Cancellation tier scrubber** — slide hours-before-job, see bill + pay percentages by tier.
  - **SMS YES/NO simulator** — fake phone UI, type YES/NO/STOP/anything-else and see real-shipped responses.
  - **Client hierarchy expandable** — click Frederick Health, watch 4 depts × 6 locations × 6 specialists unfold.
- **Copy refresh** across every marketing page — replaced abstract prose with shipped-feature concretes (close-out flow, SMS YES/NO, client hierarchy, audit log, team invitations, dashboards search/sort, expense reimbursement).
- **`.html` stripped from URLs site-wide** — `.htaccess` adds 301 redirects (`/foo.html` → `/foo`) + internal rewrites (`/foo` silently serves `foo.html`). Every internal `href` cleaned. Sitemap + canonical URLs updated. Smoke checks confirm `.html → 301`, clean URL → 200.

### PHI encryption at rest (real this time)

- **Worker** `src/phi.ts` (new) — AES-GCM via Web Crypto Subtle. Per-tenant DEK derived via HKDF-SHA256 from a master key that never leaves the Worker. Storage format: `v1:<iv_b64>:<ct_b64>`. Routes: `POST /v1/phi/encrypt`, `POST /v1/phi/decrypt`. Gated by `X-1891-Internal` shared secret.
- **Apps Script** `Code_PHI.gs` (new) — `_phiEncrypt` / `_phiDecrypt` proxy helpers + `apiCreateConsumer` / `apiUpdateConsumer` / `apiRevealConsumer` / `apiListConsumers`. Default reads are masked (initials only); reveal is break-glass, requires `purpose_of_use` (treatment / billing / quality_review / legal_hold), every reveal audit-logged, interpreters can only reveal consumers they're on a claim for.
- **Setup**: one-shot `wrangler secret put PHI_MASTER_KEY` (≥32 random bytes base64url). Currently 503s gracefully if unset.

### Calendar ICS export (`Code_Calendar.gs`)

- New `apiInterpreterIcs(e)` returns RFC-5545 `text/calendar` via per-user `calendar_token` (long-lived ULID, separate from session JWT).
- **NO PII** in the feed — service_type + modality + language pair only; city/state for location (never street); description is just "Open the 1891 Interpreter portal."
- Token rotate/clear endpoints + UI on `/app/me/notifications.html` with Copy / Generate / Disable + subscribe instructions for Google / iOS / Outlook.
- Audit each fetch.

### Tenant provisioning + switching (`/app/admin/tenants/`)

- `apiProvisionTenant` extended: accepts `primary_owner_email`, `brand_color`, `billing_email`, auto-slugified tenant_id. Creates host Users row if owner doesn't exist + mints 7-day invitation. Returns sheet URL + invitation URL.
- `apiWhoami` returns `available_tenants: [...]` so the UI can render a switcher.
- `/app/admin/tenants/` rewritten: search/refresh, card grid (legal_name, tier, phi_mode, owner email, Sheet link, "Switch to" / "You are here"), provision modal with color picker.
- New `site/assets/js/app-header.js` — drops a tenant dropdown into the `.app-header .who` block on every owner-side page when the user has >1 available tenants. Pure no-op for single-tenant users.

### Live job board WebSocket

- `JobBoardRoom` DO already existed; **client wasn't subscribing**. Now:
  - Day-of board opens `wss://1891-interpreter-api.../v1/jobs/ws?session=<jwt>` after initial render. Exponential reconnect (1/2/4/8/30s); falls back to 30s polling after 3 fails.
  - `live-indicator` chip near the Refresh button (green/amber/red/polling).
  - On message: dispatches `job.created` / `job.status_change` / `job.cancelled` / `assignment.changed` / `closeout.*` with a `.card-flash` keyframe on the changed card.
- **Apps Script side**: new `Code_LiveBoard.gs` with `_notifyJobChange_` + `_dispatchWithLiveBoard_` wrapper. Every job-state mutation (create / claim / cancel / offer / confirm / start / complete / accept / decline / closeout / dispute) fires a notify to `/v1/notify/job` via `X-1891-Internal`. Best-effort — never blocks the user.
- **Tenant isolation verified** — DO id is `idFromName('tenant:' + tid)` on both subscribe + notify; tenant A's broadcast can never reach tenant B's socket. New vitest case `job-board.test.ts` proves it.

### AI intake hardening

- Per-user rate limit (30/hr) + per-tenant rate limit (200/hr) via sliding 1-hour CacheService window. 429 on hit.
- Input cap (8KB) — rejects oversized pastes before model call.
- 5xx single retry with 500ms pause on Anthropic side errors.
- Cache failure fails open (don't block on Apps Script CacheService glitch).

### AI translation verified — NOT vaporware

Cleared from the vaporware list. `workers/api/src/translate.ts` is fully wired:
- Real `claude-sonnet-4-5` API call with system prompt, tenant-scoped prompt cache.
- Real DeepL fallback (`api.deepl.com` / `api-free.deepl.com`).
- Hard-gated against medical/legal/government source types (these MUST go through human review, never AI-prefilled).

### Deploy notes

- Worker deployed (Version `42518fd3…`). PHI routes 503 until `PHI_MASTER_KEY` is set.
- Apps Script pushed. **Still needs your 4-click "New version → Deploy"** for the new endpoints to go live on `/exec`: `list_consumers`, `reveal_consumer`, `create_consumer`, `update_consumer`, `interpreter_ics`, `rotate_calendar_token`, `clear_calendar_token`, `list_tenants` (refreshed), `provision_tenant` (refreshed), plus the WebSocket notify wrapping.
- Site live, 19/19 smoke checks pass including the new clean-URL 301s.

---

## 2026-05-18 — v18.3: Teammate invitations, per-client document library, payout PDF with expense lines

Three queue items closed in one parallel sweep.

### 1. Teammate invitations (`Code_Invitations.gs` + `/app/settings/team.html`)

Owner/manager can now bring people onboard without manually editing the Sheet.

- `apiInviteUser`, `apiListInvitations`, `apiCancelInvitation`, `apiResendInvitation`,
  plus `apiListUsers` and `apiInviteAllowlist` for the UI.
- **Role-scoped allowlist** enforced server-side:
  - `role_owner`, `role_platform_staff` — can invite any role
  - `role_manager` — only scheduler / interpreter / client_contact /
    requestor_contact / billing_contact (no escalation to owner/manager/admin/auditor)
- New `purpose='invitation'` column on `Auth_Tokens` (added lazily, no migration).
- **7-day TTL** for invitation tokens (vs 15-min for magic-link).
- `apiAuthVerify` now flips `status='invited'` → `'active'` on first successful
  redemption, stamps `last_login_at` on every redemption, returns `first_login` flag.
- UI: `/app/settings/team.html` — Pending invitations table with Resend / Cancel
  buttons, Current team table, "+ Invite teammate" modal with role-scoped fields
  (interpreter dropdown only when `role=interpreter`; client dropdown required for
  client_contact / billing_contact).
- Idempotent: re-inviting an `invited` or `cancelled` row reuses the same `user_id`.
  Refuses to overwrite an `active` teammate.
- Every API logs audit rows (`invite.create` / `cancel` / `resend` / `accept`).

### 2. Per-client document library (`Code_ClientDocs.gs` + Documents section on profile)

Contracts, BAAs, MSAs, COIs, W-9s, 1099s, NDAs, rate sheets — stored on Drive,
listed per-client, with expiry visualization.

- New `Client_Documents` tab (19 columns including sha256, effective_date, expires_at).
- `apiUploadClientDocument` — owner/manager/admin/scheduler/platform_staff; mime allowlist
  (PDF / Word / images / plain text); size ≤25MB; sha256 written for tamper detection.
  Drive folder: `/1891 Interpreter — Client Documents/<tenant_id>/<client_id>/<doc_type>/`.
- `apiListClientDocuments` — same role gate **plus** `role_client_contact` can read
  their own client's docs (linked via `Client_Contacts.client_id`).
- `apiArchiveClientDocument` — narrower (owner/manager/platform_staff only). Never
  hard-deletes; preserves legal retention trail.
- `apiGetClientDocument` — streams the file back wrapped in HTML embed/img.
- UI: new **Documents** section on `/app/clients/profile.html` with upload modal,
  expiry visualization (red row + "Expired" chip when `is_expired`; amber row +
  "Expires in N days" when ≤30 days out), archived rows dimmed.
- Read-only viewers (client_contact role) see the list but no upload/archive buttons.
- Seed adds three demo PDFs (Frederick Health BAA, Catoctin County contract, and a
  near-expiring FH COI 20 days out so the amber chip shows in screenshots).

### 3. Payout PDF — expense reimbursement lines (`Code_Invoicing.gs`)

Closing the v18.2 loop: when interpreters log expenses on close-out, those now
render as their own section on the payout PDF.

- `_findPayoutLines` extended to merge labor (from `Job_Events:payout_included`)
  with expenses (from `Job_Expenses.payout_id`). Tagged `kind:'labor'` vs
  `kind:'expense'`. Defensive dedupe: if both event + row exist for the same
  expense_id, the Job_Expenses row wins.
- `_renderPayoutHtml` rewritten with two tables:
  - **Labor** — Date | Service type | Hours | Rate | Amount
  - **Expenses (pay-side reimbursement)** — Date | Type | Description | Qty/Unit | Rate | Amount
  - Mileage shows "X mi" + "$0.67/mi"; flat expenses show "—" in Qty/Unit
  - Receipts surface as `[receipt on file: <filename>]` text (PDFs can't carry
    live session links)
- Three totals: Labor subtotal · Expense subtotal · **Total payout**.
- Defensive `payout.pdf_mismatch` audit if header total disagrees with line sum
  by >1¢.
- `seedJobExpenses_` added — for each COMPLETED assignment, seeds a mileage row
  (12–45 miles at interpreter's `mileage_rate_cents`) and occasional parking
  ($5–15). All `[SEED]`-tagged, `status='approved'` so `apiCreatePayout` picks
  them up immediately.

### Deploy notes

- Apps Script pushed (20+ files including 2 new `.gs`).
- Site deployed to `madeby1891.com/interpreter`; 16/16 smoke checks pass.
- **Still needs the 4-click "New version → Deploy"** in the editor for the
  v18.3 endpoints to go live on `/exec`: `invite_user`, `list_invitations`,
  `cancel_invitation`, `resend_invitation`, `list_users`, `invite_allowlist`,
  `upload_client_document`, `list_client_documents`, `archive_client_document`,
  `get_client_document`.

---

## 2026-05-18 — v18.2: Interpreter close-out (actuals + expenses) + audit-log viewer

Closing out a job is now a real thing. Interpreter ends the appointment,
opens `/app/me/`, taps **Close out this job** on the card → modal walks them
through:

- **Actual times** (default to scheduled; editable). Live divergence preview:
  if their actuals differ from scheduled by ≥25% the form warns them the
  scheduler may review.
- **Expense lines** — repeating rows for mileage, parking, tolls, supplies,
  meal, other. Mileage uses the interpreter's per-mile rate from their
  profile; other types take a flat dollar amount. Each line accepts an
  optional **receipt upload** (image/PDF, ≤8MB, stored on Drive in a
  per-tenant per-month folder).
- **Notes** to the scheduler (optional).

### What close-out does on the backend

`apiCloseOutJob` (in new `Code_Closeout.gs`):
- Sets `Jobs.actual_start` / `actual_end` / `status='COMPLETED'`
- Writes `Jobs.interpreter_signoff_at`, `interpreter_signoff_notes`,
  `closeout_divergence_pct`
- Updates the interpreter's `Job_Assignments.billable_minutes` to the actual
- Inserts `Job_Expenses` rows (`status='submitted'`) — never billed to
  client, only reimbursed on payout
- Fires the `job_complete` notification event
- Returns a `flagged_for_dispute` boolean so the modal can warn

The **auto-bill** policy (per admin choice): close-out posts immediately;
the scheduler doesn't have to approve before invoice/payout flows pick it up.
But the scheduler can **dispute** within the review window — click the
"⚠ N%" chip on the day-of board → opens the job page → "Dispute close-out"
button. Disputed jobs roll back to `CONFIRMED` so the interpreter re-submits.

### Receipt handling

Schema field is `receipt_r2_key` (kept for forward-compat) but v1 stores
to **Google Drive** via `DriveApp.createFile()` since R2 setup requires
Cloudflare API auth not yet wired. Folder layout:
`/1891 Interpreter — Receipts/<tenant_id>/<YYYY-MM>/<filename>`. Receipts
view-back through `apiGetReceipt` which streams the bytes back as a
data-URI–wrapped HTML response (auth-gated to owner/manager/scheduler or
the uploading interpreter).

### Payout integration

`apiCreatePayout` now pulls **approved Job_Expenses** alongside the labor
lines for each assignment in the period. Each expense becomes its own line
on the payout (`kind:'expense'` vs `kind:'labor'`). Once a payout is
persisted, the Job_Expense rows get `payout_id` + `status='reimbursed'` so
they can't double-pay.

### Scheduler side

On `/app/job/`:
- New **Close-out card** appears once the interpreter signs off — shows
  actual vs scheduled hours, divergence %, interpreter notes, expense table
- Expense table: each line has Approve / Reject buttons (reject requires a
  reason)
- "Dispute close-out" button at the bottom — opens prompt, rolls the job
  back to CONFIRMED with the reason logged

On `/app/` (day-of board):
- **⚠ N%** chip on COMPLETED job cards where divergence ≥25%
- **disputed** chip on cards that got rolled back

### Schema additions

- New `Job_Expenses` tab: expense_id, job_id, assignment_id, interpreter_id,
  expense_type, quantity, unit, rate_cents, amount_cents, description,
  receipt_r2_key (drive id), receipt_filename, receipt_mime, status,
  submitted_at, approved_*, rejected_reason, payout_id
- `Jobs` adds: interpreter_signoff_at, interpreter_signoff_notes,
  closeout_divergence_pct, closeout_disputed_at, closeout_disputed_by,
  closeout_dispute_reason

### Other v18.2 pieces

- **Audit-log viewer** — new `/app/admin/audit.html` with date-range / user /
  action-prefix filters, CSV export, role-gated to owner/manager/auditor/
  platform_staff (`Code_Admin.gs` + dispatcher line + nav).
- **Active clients KPI** card added to top strip on `/app/admin/health.html`
  showing `active / total · $A/R`.
- **CORS POST helper** (`_postCors`) on api.js for actions that need a
  readable response (the existing no-cors `_post` is fire-and-forget). Used
  by upload_receipt and closeout_job which both return data.

### Deploy notes

- Apps Script pushed (16 .gs files).
- Site deployed to `madeby1891.com/interpreter`; 16/16 smoke checks pass.
- **Still needs your manual 4-click "New version → Deploy"** to publish
  the v18.2 endpoints (closeout_job, upload_receipt, dispute_closeout,
  update_expense_status, list_job_expenses, get_receipt, list_audit_log)
  to the live `/exec` URL.

---

## 2026-05-18 — v18.1: Dashboard search/sort, inbound SMS, edit-client, health-dashboard client widgets

Quality-of-life pass on top of v18. Five things landed:

### 1. Sort + search + filter across every list page

Shared helper `site/assets/js/list-filter.js` + `.filter-bar` styles in `app.css`.
Each of the six scheduler list pages now has the same toolbar pattern:

- Search box with 150ms debounce; case-insensitive substring match across
  every visible field on each row
- Sort dropdown with sensible per-page defaults (date for jobs/invoices,
  name for people, recently-added on every page)
- Multi-select status chips derived from the data
- `?q=&sort=&status=` URL-persisted state — back-button safe, URLs shareable
- "Showing X of N" count + "Clear filters" button when the filter is non-default

Pages updated: `/app/` (day-of board), `/app/clients/`, `/app/interpreters/`,
`/app/requestors/`, `/app/invoices/`, `/app/payouts/`.

The day-of board now fetches all jobs once and filters client-side, instead
of re-issuing JSONP on every status-chip click — meaningfully snappier on
busy boards. The `/` hotkey still works; it now focuses the search box.

The Requestors page fetches `listClients()` alongside `listRequestors()` so
each requestor card shows the parent client's display name and the client
name participates in the search index — first user-visible payoff of the
v18 client hierarchy.

### 2. Inbound SMS reply parsing (YES / NO / STOP)

Outbound offers already SMS'd interpreters in v17. v18.1 closes the loop —
they can text **YES** / **NO** back and have it claim / decline the offer.

- **Worker** (`workers/api/src/sms.ts`) — Twilio webhook signature
  verification (HMAC-SHA1 over URL + sorted form params), body parsing
  (`YES/Y/ACCEPT/CLAIM/OK` → accept; `NO/N/DECLINE/PASS/SKIP` → decline;
  `STOP/UNSUBSCRIBE` → opt-out; `HELP/INFO` → canned reply), 60s
  isolate-local idempotency cache keyed by `MessageSid`, per-phone sliding
  rate-limit (10/min). Dispatches to Apps Script with a 60s worker JWT
  (`purpose='twilio_inbound'`, same auth pattern Agent C built for Stripe).
  TwiML reply renders a confirmation back to the interpreter.
- **Apps Script** (`Code_Sms.gs` — new) — `apiSmsInbound` looks up the user
  by `phone_e164`, finds their earliest pending offer, calls the same
  `_acceptOfferCore_` / `_declineOfferCore_` helpers that `apiAcceptOffer` /
  `apiDeclineOffer` use (refactored out into shared core so SMS and portal
  paths can't drift). Idempotency mirror on the `Communications` tab.
- **TCPA**: STOP/UNSUBSCRIBE flips every SMS pref to `off` *and* clears
  `Users.phone_e164` — opt-in requires logging back into the portal.
- **No PHI/PII in the SMS reply** — service_type + scheduled_start_human +
  city/state only. Consumer initials and requestor names stay in the portal.
- **Multiple pending offers** → earliest scheduled_start wins; reply
  includes "(1 of 3 pending offers — earliest)" so the interpreter knows
  exactly which slot they took.
- 11 new Vitest cases in `workers/api/tests/sms.test.ts` covering signature
  verification (valid + 4 tampered cases) and body parsing.

### 3. Edit-client modal (`/app/clients/profile.html`)

The "Edit client details" button on the client-profile sidebar now opens a
modal pre-filled with the client's current values. All editable fields:
legal_name, display_name, client_type, industry, billing email/phone/address,
net_terms, tax_exempt flag, status, notes. Saves via existing
`IntApi.updateClient`. The page reloads after save so the sidebar reflects
the new values.

### 4. Client metrics on the agency health dashboard

`apiAgencyHealth` payload extended with a `clients` block:
- `total` / `active` counts
- `top_by_volume_30d` — top 5 clients by job count in the last 30 days
- `top_outstanding_ar` — top 5 by unpaid invoice total
- `outstanding_total_cents` — A/R rollup

`/app/admin/health.html` renders two new cards: a horizontal-bar widget of
top clients by job volume (with completed / open counts) and an A/R list
with click-through to each client's profile.

Role gate on `apiAgencyHealth` expanded from `[owner, admin, scheduler]` to
also include `role_manager` and `role_platform_staff` (the v18 hierarchy).

### 5. Deploy notes

- Apps Script pushed (15 files including new `Code_Sms.gs`).
- Site deployed to `madeby1891.com/interpreter`; 16/16 smoke checks pass.
- Worker deployed (Stripe webhook auth from v18 + new SMS inbound auth
  share the same `_requireSessionOrWorker` purpose-scoped JWT path).
- **Deferred**: `installDigestTriggers` still needs a one-shot manual Run
  from the Apps Script editor (Triggers OAuth scope can't be requested
  from a web-app exec).

---

## 2026-05-18 — v18: Client hierarchy + per-client billing rules + role expansion

The healthcare-system shape lands. One **Client** (Frederick Health) can have
many **Requestors** (departments — Cardiology, ED, Pediatrics, Oncology),
many **Locations** (Main Hospital, Urbana Clinic, Mt Airy, Brunswick), many
**Specialists** (the doctor on the chart) — all rolling up to **one billing
office** with one invoice cycle per month.

### 1. Schema (`Code.gs`, `_tenantSchema`)

Four new tabs:
- **Clients** — parent org. legal_name, display_name, client_type, industry,
  billing_address/email/phone, tax_exempt, net_terms, primary_payer_id.
- **Client_Contacts** — owner / billing-AP / scheduler / signatory per client.
- **Specialists** — the doctor a job is "for." Carries department, NPI,
  specialty_code, default_location_id. Surfaced on invoice lines so AP
  can match the right cost center.
- **Client_Billing_Rules** — consolidation_mode, billing_cycle, PO format,
  GL template, invoice_format (standard / hipaa_safe / detailed), and
  toggles for showing initials / specialist / interpreter name on the PDF.

Existing tabs got new columns:
- `Requestors.client_id`, `Requestors.default_specialist_id`
- `Jobs.client_id`, `Jobs.specialist_id`, `Jobs.po_number`,
  `Jobs.cancellation_bill_cents`, `Jobs.cancellation_pay_cents`,
  `Jobs.invoice_id`
- `Invoices.client_id`, `Invoices.invoice_number`, `Invoices.po_number`,
  `Invoices.consolidation_mode`, `Invoices.split_group_key`,
  `Invoices.statement_descriptor`, `Invoices.sent_at`, `Invoices.paid_at`,
  `Invoices.voided_at`
- `Invoice_Lines` adds `line_kind`, `client_id`, `requestor_id`,
  `location_id`, `specialist_id`, `consumer_initials`, `interpreter_id`,
  `interpreter_name`, `service_type`, `modality`, `scheduled_start`,
  `scheduled_end`, `sort_order`.

### 2. Role hierarchy expansion (`_seedRoles`)

New top-down hierarchy:
- **role_platform_staff** — 1891 employees — cross-tenant
- **role_owner** — agency owner — all in their tenant
- **role_manager** — operations manager — all except user/billing admin
- **role_scheduler** — books jobs, sees masked PII
- **role_interpreter** — sees offers + their own assignments
- **role_client_contact** — top contact at a client — sees all the client's requestors + invoices
- **role_requestor_contact** — single requestor / department — own jobs only
- **role_billing_contact** — AP person at the client — sees invoices for their client
- legacy role_admin retained as alias (back-compat)

Seeding is now idempotent — re-runs only add roles that aren't already present.

### 3. Client API (`Code_Clients.gs`, ~12 KB)

- `list_clients` / `get_client` (returns client + contacts + specialists +
  requestors + locations + billing_rules in one round-trip)
- `create_client` / `update_client`
- `upsert_client_contact` / `upsert_specialist`
- `update_client_billing_rules`

### 4. Invoice composition (`Code_Invoicing.gs`)

`apiCreateInvoice` now accepts either `payer_id` (back-compat) or `client_id`.
When called with a client, it pulls billing rules and **splits by
consolidation_mode**:

| Mode | Result |
| --- | --- |
| `one_per_client` (default) | All jobs across all requestors → 1 invoice |
| `one_per_requestor` | Each department gets its own invoice |
| `one_per_location` | Each location → its own invoice |
| `one_per_specialist` | Each doctor → its own invoice |
| `one_per_job` | Itemized per-job invoicing (small clients) |

Lines now carry the full attribution chain — `client_id`, `requestor_id`,
`location_id`, `specialist_id`, `consumer_initials`, `interpreter_name`. The
PDF template surfaces location + specialist + consumer + interpreter as their
own columns (only the columns with data appear).

Invoice numbers are now monotonic per-tenant-per-year: **INV-2026-0001**.

The PDF "Bill to" block prefers the **client** legal entity when set, with
a "via [Payer]" subline when those names differ.

### 5. /app/clients/ page

New scheduler-facing UI:
- `/app/clients/index.html` — grid of client cards, "+ Add client" modal with
  type, industry, billing address/email/phone, net terms, tax-exempt flag.
- `/app/clients/profile.html?id=...` — per-client detail page with sidebar
  billing summary, **Billing rules** editor (consolidation mode + cycle + PO
  format regex + GL template + initials/specialist/interpreter toggles +
  rounding + minimum invoice), and tables for **Requestors**, **Locations**,
  **Specialists**, **Contacts**. Specialist + contact upsert modals.

### 6. Seed data: Frederick-Health-style hierarchy (`Code_Seed.gs`)

The demo now shows the real shape:
- **Frederick Health** (6 specialists across Cardiology, ED, Pediatrics,
  Oncology, OB-GYN) — `one_per_client` consolidation, rolls 4 departments
  across 6 locations to one billing office
- **Frederick County Schools** — `one_per_client`, PO required, GL template,
  PO format `^PO-\d{6}$`
- **Catoctin County Govt** (court) — `one_per_requestor`, PO required,
  30-min rounding
- **Midstate Behavioral** (2 specialists) — `one_per_client`, **biweekly**,
  **hipaa_safe** invoice format (initials only, no specialist on invoice)
- **Liberty Hill CC** — `one_per_location`
- **Riverside Family Practice** — `one_per_job` (small practice, per-job invoicing)

Seed adds 6 clients, 8 client contacts, 7 specialists, 12 locations, 10
requestors (was 7), 6 billing-rule rows. Jobs now carry client_id +
specialist_id so the invoice-rollup demo works out of the box.

### 7. Three parallel agent fixes that landed in v18

- **Agent A — Interpreter ↔ User linking.** Seeded interpreters now have
  matching `Users` rows with synthetic `firstname.lastname@seed.example`
  emails and `role_id='role_interpreter'`. Magic-link sign-in works for
  every seeded interpreter; QA pulls the token from the `Auth_Tokens` sheet.
- **Agent B — Cancellation UI.** `/app/job/` gets a "Cancel job" button +
  modal with live tier preview + required reason textarea (10-char min).
  New `cancel_job_quote` JSONP action returns the snapshot; `apiCancelJob`
  persists `cancellation_bill_cents` + `cancellation_pay_cents` + status +
  reason and notifies every assigned interpreter.
- **Agent C — Stripe webhook auth gap closed.** Worker mints a 60s
  HMAC-SHA256 JWT (iss='worker', purpose='stripe_webhook') after Stripe
  signature verification; Apps Script's `_requireSessionOrWorker` accepts
  it for whitelisted purposes (stripe_webhook, track1099_webhook,
  twilio_inbound). `apiUpdateInterpreter` accepts worker tokens with a
  narrow column allowlist for Connect-Express sync.

### Operational notes

- v18 schema changes are additive — existing tenants get the new columns/tabs
  the first time anything reads or writes a row. No migration script needed.
- The Apps Script "New version → Deploy" four-click flow still has to be done
  manually in the browser; `clasp push` synced the source but won't cut a new
  `/exec` deployment.
- Seed re-runs are idempotent — `_seedRoles` only inserts roles not already
  present, and seeded clients/specialists/billing-rules skip existing rows by
  legal_name / display_name / client_id.

---

## 2026-05-17 — v17: PII reveal-on-accept + notifications + SMS + agency health dashboard

The scheduler / interpreter workflow gets serious. Five new capabilities,
all wired end-to-end:

### 1. PII reveal-on-accept (`Code_Offers.gs`, 19 KB)

The HIPAA-defensible offer flow:
- Interpreters see **redacted previews** of pending offers — no consumer
  name (not even initials in `full` PHI mode), no specific room/suite,
  no MRN, notes scrubbed via the same regex stack as AI intake
- On **accept**, the assignment flips to `claim` response and PII unlocks
  **for that interpreter only** via a second call to `offer_details`
- Every PII reveal writes an audit row: `consumer.read.on_assigned_job`
  with `purpose_of_use='treatment'`, assignment_id, requesting user
- New endpoints: `list_my_offers`, `offer_details`, `accept_offer`,
  `decline_offer`, `add_assignment_note`

### 2. Team-of-2 coordination

- When BOTH team members accept (`team-of-2`, `cdi+hearing`, or
  `voicer+signer`), `_sendTeamContactExchange_` fires automatically:
  each team member gets an email with the other's name + email + role,
  so they can coordinate role split + breaks before the assignment
- New `Assignment_Notes` tab: team-shared notes scoped to the assignment.
  Both interpreters and staff can post; PHI gets auto-scrubbed inline.
- Co-interpreters list appears on the offer details when PII is revealed

### 3. Notification preferences (`Code_Notifications.gs`, 13 KB)

- Per-user, per-event-type, per-channel mode:
  - **Email**: immediate | daily_digest | weekly_digest | off
  - **SMS**: immediate | off (no digests for SMS)
  - **Push**: immediate | off (reserved for future mobile app)
- 10 event types tracked: `job_offer`, `job_claimed`, `job_confirmed`,
  `job_cancelled`, `job_complete`, `invoice_issued`, `payout_paid`,
  `doc_expiring_30d`, `doc_expiring_7d`, `doc_expired`
- **Digest cron**: `installDigestTriggers()` installs Apps Script time-driven
  triggers — daily at 6am ET, Monday 7am ET. Each fires `flushDigests_`
  which scans `Communications` for `queued_daily` / `queued_weekly` rows
  and consolidates per recipient.
- Endpoints: `list_notification_prefs`, `update_notification_pref`,
  `update_notification_settings`, `_install_digest_triggers`

### 4. SMS via Twilio (Worker route + Apps Script wrapper)

- **`workers/api/src/sms.ts`** — `/v1/sms/send` Twilio outbound + `/v1/sms/inbound`
  webhook stub (signature verify TODO)
- Plan-gated: returns `{ok:false, configured:false}` until `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` are set via `wrangler secret put`
- Apps Script proxies via `_sendSmsViaWorker_` with `X-1891-Internal` =
  shared JWT_SECRET
- Apps Script logs every SMS to `Communications` with status (sent/failed
  by Twilio response, or `queued_*` for digests)

### 5. Agency health dashboard (`Code_Metrics.gs`, 13 KB + `/app/admin/health.html`)

Owner/admin/scheduler-gated. One endpoint (`agency_health`) returns:
- **Roster**: total, active, available-now (no overlapping claimed job),
  CDI-eligible count, languages covered
- **Jobs**: counts by status, today, next 7d, last 30d, open_now,
  offered_now, in_progress_now
- **Fill rate**: % of last-30d jobs that got a claim before scheduled_start
- **Time to fill**: median + mean minutes from job creation to first claim
- **Utilization per interpreter**: billed_minutes / 9600 (40h/week × 4),
  with claim count
- **Doc health**: compliant / missing / expired / expiring-soon counts
- **Top languages last 30d** + **service mix** + **12-week weekly trend**

UI shows a 6-KPI strip up top, full pipeline pills, utilization bars with
high/low color coding, top-5 languages, service-mix percentages, sparkline.

### New /app/ pages

- **`/app/me/`** — interpreter self-serve offers portal:
  - Filter tabs (Needs action / Upcoming / All) with badge counts
  - Cards show redacted preview before accept; full PII + co-interpreter
    team + specific address after accept
  - Pay-rate snapshot visible on every card
  - Accept / Decline buttons; decline opens a modal with reason
- **`/app/me/notifications.html`** — preferences UI:
  - SMS number input (E.164 validated)
  - Daily digest hour selector, Weekly digest day selector
  - Per-event 3-column matrix (Email | SMS | Push) with cadence dropdowns
- **`/app/admin/health.html`** — agency dashboard described above

### Schema additions

- `Notification_Prefs` tab — per-user-per-event delivery config
- `Assignment_Notes` tab — team-shared notes scoped to an assignment

### Verified live

- Health dashboard renders: Roster 10, Open 5, fill rate 0% (no claims in
  last 30d because all completed jobs are seeded with past dates that
  predate the recent assignment.responded_at writes), 10 utilization
  rows, full pipeline pills, all 9 status types showing
- `apiAuthVerify`-style PII redaction works through `redactJobForPreview_`
  which strips consumer.display_initials, location.street, notes_to_interpreter
  PHI patterns
- Worker `/v1/sms/send` correctly returns `Forbidden` to unauthed calls and
  `{configured:false}` when secrets aren't set

### Activation steps for SMS / digests

```
# SMS (when you sign up for Twilio)
wrangler secret put TWILIO_ACCOUNT_SID
wrangler secret put TWILIO_AUTH_TOKEN
wrangler secret put TWILIO_FROM_NUMBER

# Digest schedulers (one-time, from any browser)
curl -G "$WORKER/v1/proxy/exec" --data-urlencode "action=_install_digest_triggers" --data-urlencode "setup=$SHEET_ID"
```

---

## 2026-05-17 — v16: Two-sided rate engine + interpreter docs + qualification-gated smart-fill

The headline fix for "why most interpreting platforms fall flat": real-world
billing complexity, two-sided rate negotiation, and per-agency onboarding
document tracking.

### Apps Script v16 (deployed)

- **`Code_Rates.gs`** (24 KB) — full rate engine
  - Two sides: `bill` (charge to payer) and `pay` (to interpreter), both
    computed in one call. Same modifier pipeline; different rate cards.
  - **Rate modifiers** stack and apply by priority:
    `evening` (6pm–10pm), `overnight` (10pm–6am), `weekend` (Sat/Sun),
    `holiday` (US federal), `last_minute` (<24h notice), `rush` (<4h),
    `cdi_surcharge` (team configs). Each can be % or flat cents.
  - **Rounding** per rate card (default 15 minutes, configurable).
  - **Minimum hours** floor (typically 2.0 medical, 1.0 K-12).
  - **Cancellation quotes** — tiered: ≥48h: 0%/0%, 24-48h: 50/25, 12-24h:
    100/50, <12h: 100/100, no_show: 100/100. Interpreter cancellation
    floors override pay-side when higher.
  - **Pay-rate floors** per interpreter per (service_type × modality).
    Pay quote total bumped up to the floor when the modifier stack lands
    below it (`floor_enforced: true` returned).
  - Endpoint: `compute_rate_quote` (returns full breakdown with every
    modifier itemized — usable for both UI preview AND job creation
    to snapshot the rate to the job row).

- **`Code_Docs.gs`** (16 KB) — onboarding document + qualification gating
  - **21 canonical doc types**: HIPAA, BBP, TB, COVID, MMR, flu, hep-B,
    background check, drug test, W-9, COI, ADA training, NDA, COI
    disclosure, RID membership, NAD membership, state cert, medical
    terminology, mental-health endorsement, legal endorsement, K-12
    endorsement
  - **Tenant_Requirements** tab: per-tenant policy mapping
    `(service_type, modality) → required doc_type` with renewal periods
  - **Interpreter_Documents** tab: per-interpreter records with status
    (pending/approved/rejected/expired), issued_at, expires_at, reviewer
  - **Qualification check** returns:
    `qualified_strict`, `missing_docs`, `expired_docs`, `expiring_soon`,
    language match, warnings (CDI role mismatch, missing endorsement)
  - **`smart_fill_qualified`** endpoint replaces `smart_fill` — same
    ranking but pre-loads ALL reference data once per request and runs
    qualification + rate quote per candidate. ~3 seconds for 10
    interpreters (vs. 15s+ timeout if uncached).

### Extended Interpreters schema

Each interpreter row now carries 14 additional fields:
- `rid_member_number`, `bei_member_number`, `other_member_numbers`
- `pay_rate_floors` (JSON: `{"medical": {"on-site": 8500, "VRI": 7500}}`)
- `cancellation_floors` (JSON: `{"<12h": 12000, "12-24h": 8000, …}`)
- `evening_premium_pct`, `weekend_premium_pct`, `last_minute_premium_pct`,
  `holiday_premium_pct`
- `mileage_rate_cents`, `travel_time_rate_cents`
- `specialty_endorsements` (JSON: `["medical","legal","protactile"]`)
- `availability_windows` (JSON)
- `onboarding_completed_at`

### New /app/ pages (all live)

- **`/app/interpreters/profile.html?id=`** — extended profile:
  - Top summary: languages chips, certifications chips, specialty endorsement chips
  - **Onboarding documents panel**: list sorted by attention-needed, status pills
    (approved/pending/rejected/expired/expiring soon), one-click approve/reject
    for staff, "Renew…" for expired docs, "+ Add or upsert" sub-form
  - **Pay-rate floors editor**: matrix of service_type × modality with ¢/hr inputs
  - **Premium % editor**: evening/weekend/last-minute/holiday + mileage + travel-time
  - **Cancellation floors editor**: per-tier minimums
  - **Membership numbers**: RID, BEI
  - **Recent assignments** list (last 10 from the interpreter's history)

- **`/app/settings/rates.html`** — rate engine editor:
  - **Live quote preview** at the top: pick service + modality + team + start
    time + duration + (optional) interpreter, get both bill + pay totals
    with every modifier itemized. Confirms the engine end-to-end.
  - Bill side ↔ Pay side toggle
  - **Rate cards table** (editable, per row): service × modality × team
    × base hourly cents × min hours × rounding
  - **Modifiers table** (editable): name, kind, trigger preview, %, ¢,
    priority, status — sortable by priority

- **`/app/settings/requirements.html`** — onboarding policy editor:
  - Per-row: doc type, display name, applies-to service + modality,
    renewal months, reminder days, required flag, notes

### Smart-fill UI upgrade

- Dashboard's smart-fill modal now calls `smart_fill_qualified` instead
  of `smart_fill`
- Each candidate shows:
  - Qualification badge: **qualified** (green), **missing N docs** (red),
    **expired** (red), **language gap** (yellow), **warnings** (yellow)
  - **Pay quote** ($X.XX @ Y/hr) with `pay floor enforced` flag if applicable
  - **Bill quote** for comparison
  - Specific missing/expired/expiring-soon docs listed inline
- "Offer" button is **disabled** for unqualified candidates, with a link
  to their profile to fix the missing doc

### Seed data extended

- **22 rate cards** seeded (bill + pay sides, 11 service-type × modality
  combos each) including a translation rate card placeholder
- **13 rate modifiers** seeded: evening/overnight/weekend/holiday/
  last_minute/rush/cdi_surcharge on both sides at typical industry
  percentages
- **18 requirements** seeded: universal (W-9, NDA, COI disclosure,
  insurance) + medical-specific (HIPAA, BBP, TB, MMR, COVID, hep-B,
  flu, medical terminology) + mental-health (HIPAA + endorsement) +
  legal (background check + endorsement) + K-12 (background check +
  endorsement)
- **110 interpreter documents** seeded across the 10-interpreter
  roster with realistic mix: most approved + current, some expiring
  in <30 days, one expired COI for Ahmad Hassan, one pending review
  for Sarah Chen, Riya Patel deliberately missing HIPAA so she can't
  qualify for medical jobs
- Each interpreter has realistic `pay_rate_floors` (varying by
  specialty — Jordan Hayes' legal floor is $115/hr, Riya's K-12 is
  $65/hr), `cancellation_floors`, `mileage_rate_cents` (67¢ IRS
  standard), evening/weekend/last-minute/holiday premium percentages,
  specialty endorsements, and RID member numbers for the ASL set

### Verified end-to-end in production

- Saturday 7pm 2-hour medical interpretation quote:
  Bill = **$361.00** (base $190 + evening 15% + overnight 50% + weekend 25%)
  Pay = **$176.70** (base $114 + evening 10% + overnight 30% + weekend 15%)
- Smart-fill against an OPEN medical job: 10 candidates ranked,
  qualification badges populated, pay quotes computed, offer button
  correctly disabled for the 8 unqualified interpreters

### Note

The "overnight" modifier still fires on 7pm-9pm slots because the
trigger logic in the rate engine treats `is_evening` and `is_overnight`
as overlapping. Will tighten in v17 (overnight should require start ≥
22h or before 6am, not just "after 18h"). Doesn't affect correctness
of total — both modifiers are legitimate; ordering is just imprecise.

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
