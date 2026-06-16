# CHANGELOG — 1891 Interpreter

Dated history of changes. Newest entries at the top. Note user-visible changes only; engineering refactors that don't change behavior can stay out.

---

## 2026-06-10 (night) — drip emails LIVE; phase-4 rails confirmed deployed

Fallon's go-live call, executed end-to-end from this machine.

- **The drip stack is on.** Deliverability checked (the domain's mail policy was already hardened), the seven interpreter emails are in the live send worker, all three series are active, and the walk runs hourly. The daily send cap stays low on purpose as a blast-radius breaker. First real send verified against a backdated canary enrollment.
- **Phase-4 data rails: already live and inert.** The mirror receiver + per-table sender cutoff turned out to be deployed with the evening's backend pushes; the mirror callback secret is now set. Nothing changes behavior until a table is deliberately flipped — not during launch week.

## 2026-06-10 (evening) — pilot-window copy, contact@ consolidation, attribution, drip stack

Same-day follow-up on Fallon's GO.

- **Verification copy softened, no named reviewers.** Every review-process surface — free-for-deaf-owned, the pricing FAQ, the about-page section, the published verification standard, and the application receipt email — now says applications are **reviewed during the pilot window, in the order they arrive**, with written reasons either way. The hard 5-business-day decision promise is retired until the review group seats. Founder bios are unchanged.
- **One contact address.** `accessibility@` / `security@` / `privacy@` / `legal@` all consolidate to **contact@madeby1891.com** on every page and in backend notification routing (the dedicated aliases were printed but never existed — accessibility and security reports were bouncing).
- **Purchase attribution.** Subscribing now stamps the consent banner's id into the payment record (advertising-consent visitors only), so future campaigns can see what converted. Validated server-side; can never block a checkout.
- **Drip email stack, built and deliberately dormant.** Three series are authored, seeded, and wired — sandbox nurture (3 emails over 9 days, consent-box subscribers only), working-session follow-up (2 emails), and new-subscriber onboarding (2 emails) — each with one-click unsubscribe. Nothing sends until the deliverability hardening and the master flag flip, which are deliberate go-live decisions, not deploys.

## 2026-06-10 — launch funnel: gated sandbox, form receipts, lead console, watchdog

The pre-launch funnel pass. Everything below is live and verified.

### Sandbox — `/try/` (new surface)

- **Instant-boot demo sandbox** at [`madeby1891.com/interpreter/try/`](https://madeby1891.com/interpreter/try/) — the agency console with sample data, booting in the visitor's browser with **no signup**. Three scenarios (medical-heavy ASL, K-12 & college, spoken+signed mixed), live day board, claim flow from the interpreter's view, pre-baked smart-fill with the public 30/20/20/15/15 score breakdown, invoice drafting on close-out, three themes. Data stays in `localStorage`; payments/texts/emails/AI are faked and labeled as such.
- **Tease-then-gate email wall.** After 5 meaningful actions the sandbox hard-gates on a work email. The backend mails a 7-day signed continuation link; the sandbox stays locked — including on return visits — until the link is opened, then unlocks with state intact and a fresh 14-day window. This is a deliberate gated-sandbox variant of `DEMO_SANDBOX.md` v1 (which is no-gate, no-backend); spec amendment noted there.
- **CTAs added:** homepage hero, pricing lede, and get-a-demo page now point at the sandbox; `/try/` is on the sitemap.

### Inbound forms — receipts + honesty

- **Every form now acknowledges the submitter by email within the minute** (demo request, contact, requestor sample, Deaf-owned application, accessibility, security). The Deaf-owned receipt states the published review timelines. Previously the live site promised an "auto-reply within 5 minutes" with nothing wired.
- **No more fake success.** The form JS used to show "we received that" even when the request never left the browser; it now says plainly that the submit failed and offers `hello@`.
- **No-JS fallback fixed.** Form `action` previously pointed at `/api/lead`, a 404; it now posts to the real endpoint (plain-text receipt), with a `noscript` note.

### Lead console + digest (admin)

- **`/app/admin/leads/`** — the inbound pipeline in one screen: every form submission with status/owner/notes, filters, and an OVER-SLA badge once a lead has sat `new` past the published 1-business-day promise. Platform-staff/host-owner only.
- **Daily 8am ET digest** to hello@ + Fallon: new leads (24h), SLA breaches, pending Deaf-owned applications, sandbox funnel counts.

### Ops

- **Uptime watchdog:** GitHub Actions polls the site, `/try/`, and all three workers every 10 minutes; a red run emails repo watchers.
- **Deploy smoke hardened:** the pricing-CTA check retries once (verified flaky mid-suite 2026-06-10 while content was correct).

## 2026-05-25 — platform-spec backfill (SMS contract v1, dashboard contract v1, HARD RULE sweep)

A catch-up pass against three umbrella specs that landed last week.

### SMS — aligned to `shared/specs/SMS.md` v1

- **HARD RULE sweep.** Eight customer-facing pages named "Twilio" in body copy. All rewritten through the build's content registry (`_build/build.py`) to generic phrasing per SMS.md §7 — "edge-verified inbound text," "HIPAA-eligible carrier," "transactional SMS through a HIPAA-eligible provider." Sanctioned mentions stay only in `legal/subprocessors.html`. `sms-consent-lint` is now 0 FAIL, 0 WARN.
- **Worker outbound aligned to Pattern B + the shared 1891 SMS Gateway.** [`workers/api/src/sms.ts`](workers/api/src/sms.ts) now prefers `TWILIO_MESSAGING_SERVICE_SID` (default `MGc34cd9467b4a9e6b0cce3d043d093eb4`) and the `TWILIO_API_KEY_SID/SECRET` pair, with the legacy `TWILIO_FROM_NUMBER` + `TWILIO_AUTH_TOKEN` retained as fallback for a clean rotation. Env interface in [`workers/api/src/index.ts`](workers/api/src/index.ts) extended with the new fields. Once secrets land, the project inherits the shared brand reg, A2P 10DLC campaign, and auto STOP/HELP routing at the Twilio MS layer.
- **Status table row added.** `interpreter` now appears in [`shared/specs/SMS.md`](../../shared/specs/SMS.md) §10 — Pattern B, shared MS, consent UI live, STOP/HELP live, lint wired.
- **Lint wired into deploy.** `deployment/deploy.sh` now runs `sms-consent-lint.py` in the same slot as `godview-lint-gate.sh`; deploy aborts on FAIL (bypass: `FORCE=1`).

### Admin dashboard — aligned to `shared/specs/DASHBOARD_CONTRACT.md` v1

- **Lint wired into deploy.** `deployment/deploy.sh` now runs `dashboard-contract-lint.py --surface=admin`. The lint discovers `site/app/admin/` after a one-line addition to the shared lint's candidate-path list.
- **§3 auth recognized.** Extended `AUTH_SESSION_PATTERN` in [`shared/ops/dashboard-contract-lint.py`](../../shared/ops/dashboard-contract-lint.py) to recognize `IntApi.whoami()` / `{action:'whoami'}` — same shape as `action:'auth-me'`, just the interpreter's naming.
- **A11y WARNs fixed.** `site/app/admin/audit.html` filter inputs (`f-from`, `f-to`, `f-user`, `f-action`) now carry `aria-label`s. Dashboard lint reports 0 FAILs, 2 WARNs (both v2 promotion items — list-view bulk-select hint + activity-timeline markup).

### Payments — Pattern F status unchanged, references confirmed

- `docs/PAYMENTS_IMPL.md` §1 still tracks Pattern F (LIVE) + Pattern G (CODE READY, DEFERRED). The new Pattern F §2.5.1 tiered-subscription conventions (FDT Alerts shape) are not relevant here yet — Solo / Practice / Studio are tier-by-product, not tier-by-cap.

### Operational hygiene

- Tests still green (90/90). Typecheck clean. `--dry-run` deploy walks the full pipeline including both new lints.

### Late-day amendment — inbound routing via shared hub

After provisioning the 5 send-side Twilio secrets, found that the live 1891 SMS Gateway MS already pointed inbound at `sms.anthonymowl.workers.dev/v1/inbound` (the shared `workers/sms` hub) — SMS.md v1 had called that Worker "rejected prototype" but reality differed.

Decision: embrace the hub. Changes:

- New consumer `handleSmsInboundFromHub` in [`workers/api/src/sms.ts`](workers/api/src/sms.ts) at route `/v1/sms/inbound-from-hub`. Verifies HMAC-SHA256 over the JSON body using `HMAC_SECRET_INTERPRETER`. Dispatches `sms.optout` → Apps Script (clear `Users.phone_e164`, force `sms_mode='off'`); `sms.inbound` → YES/NO parse + Apps Script claim flow. The hub owns the user-visible reply, so this handler returns plain `200 ok` / `403 Forbidden` (no TwiML).
- Direct `/v1/sms/inbound` (Twilio-direct) endpoint preserved for rollback.
- Interpreter tenant row added to `workers/sms/src/tenants.ts`; `HMAC_SECRET_INTERPRETER` provisioned on both Workers.
- SMS.md amended to v1.1 acknowledging the shared hub IS the live shape (§1 reversed, §10 row updated).
- Live smoke 2026-05-25: forged sig → 403, real sig → 200.

Interpreter Worker version: `717072f5`. Shared hub version: `aad55668`.

---

## Earlier history

Entries from **2026-05-18 (v18.4) and earlier** — the v10–v18 build dumps — are in [`archive/CHANGELOG_ARCHIVE.md`](archive/CHANGELOG_ARCHIVE.md).
