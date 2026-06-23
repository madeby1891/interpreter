# HANDOFF — 1891 Interpreter

Current state for in-flight work. Keep it skimmable — the next agent should pick up cold in under five minutes. **Dated narrative history is in [`archive/HANDOFF_ARCHIVE.md`](archive/HANDOFF_ARCHIVE.md)** (full running log). Deploy/ops knowledge is in [`DEPLOY.md`](DEPLOY.md). User-visible change history is in [`CHANGELOG.md`](CHANGELOG.md).

---

## Current state (as of 2026-06-12)

Marketing site + scheduler MVP + SaaS payments **live** at `https://madeby1891.com/interpreter/`. What works end-to-end:

- **Marketing + intake:** every page live; inbound forms (demo, contact, requestor sample, Deaf-owned application) write Sheet rows, email `contact@madeby1891.com`, and send a same-minute acknowledgment.
- **Scheduler:** magic-link auth → `/app/` → create jobs (Jobs + Job_Events + Audit_Log rows), smart-fill (ranked candidates with transparent score breakdown), claim/cancel. Interpreter mobile view at `/app/claim/`. All endpoints JWT-gated (HS256), writes tenant-scoped, PHI redacted on inbound.
- **Payments (Pattern F, live):** `/pricing` → `/pay/subscribe` → Stripe Checkout → webhook flips `Agencies.subscription_status='active'` + branded welcome email. Mode A canonical: agency keeps merchant-of-record; Pattern G (Connect read-only reporting) code shipped, gated on `STRIPE_CONNECT_CLIENT_ID`.
- **Also live:** QuickBooks Online integration, live captions (Deepgram, `/app/captions/`), inbound SMS reply parsing (YES/NO/STOP via shared SMS hub), tamper-evident `Audit_Log` hash-chain, one-click tenant export, SSO (OIDC), email→draft intake (poller NOT installed — needs Gmail scope), launch funnel (gated `/try/` sandbox + form receipts + lead console + daily digest), drip emails (3 sequences active, verified delivering on cadence 2026-06-12).
- **D1 migration (ADR-001):** reads flipped to D1 (phase 3 done + verified 2026-06-06). Phase-4 (D1 sole writer) rails staged on branch `frederick/ws9-interpreter` (inert until flags set). Detail: [`workers/interpreter-data/MIGRATION.md`](workers/interpreter-data/MIGRATION.md).
- **Worker CI:** `git push` auto-deploys api + interpreter-data + captions (+ `/healthz` smoke).

---

## In flight / needs Anthony

- **Phase-4 rails to ship** (safe, stays inert after): merge `frederick/ws9-interpreter` → main, `clasp-deploy.sh apps-script "phase-4 mirror (inert)"` (NOT 7–10am ET), set `MIRROR_SHEET_EXEC`. First table = Settings. Runbook: MIGRATION.md "Phase 4".
- **PASTE-BACK (dashboard logins, ~2 min each):** (1) QuickBooks creds (`QBO_*` secrets, redirect `…/app/settings/quickbooks-callback.html`); (2) Stripe Connect `client_id` (`ca_…` → `STRIPE_CONNECT_CLIENT_ID`) to light Pattern G; (3) email-intake poller install (`_install_inbound_email`) once Gmail scope is added.
- ✅ **Burned Anthropic key REVOKED 2026-06-23** (was prefix `sk-ant-api03-mX_3O`, console label "interpreter"; orphaned since 2026-06-01). Deleted at console.anthropic.com. Live runtime key is unaffected — it's the workspace-shared `k2_…VgAA` key (console label "blastd chat") in `anthropic-secret.gs` + Worker `ANTHROPIC_API_KEY`; that one stays.
- **Drip follow-ups (non-blocking):** set `RESEND_API_KEY` on comms-send so interpreter mail sends from `contact@send.madeby1891.com` (currently the Blast'D ops mailbox); drip rows stay `status=drip_attempt` post-delivery (cosmetic over-count).

---

## Next 3 actions

1. **Email aliases.** `accessibility@`/`security@`/`privacy@`/`legal@` currently route to `contact@madeby1891.com` (the standalone aliases were never created and bounced). Re-split when real aliases exist.
2. **Verification board.** Confirm 2 community advisors so Deaf-owned applications can be approved (decisions paused until seated).
3. **Onboard first design partner.** Provision a second tenant Sheet, add users + interpreters, walk job creation on a Phase 0 white-glove call. Onboarding script + first-day checklist need writing.

---

## Known blockers

- **No domain yet** — `1891interpreter.app` unregistered; served under `madeby1891.com/interpreter/`.
- **Cloudflare BAA** — Workers BAA needs Enterprise; free Deaf-owned tier stays `phi_mode: initials-only` (A9 #2).
- **Anthropic BAA scope** — confirm Anthropic-direct BAA at our scale vs Bedrock (recommend Anthropic direct, D7.1).
- **Twilio HIPAA per product** — Verify + Programmable SMS eligible; Voice has caveats (confirm before OPI, A9 #12).
- **Host tenant Sheet location** — `anthonymowl@gmail.com` Workspace for now; migrate once tenant count > 5 (A9 #9).
- **Verification board membership** — 2 community advisors unnamed (F-verification).

---

## Open decisions (consolidated from PRD sections; decide before building the affected area)

| Section | # | Decision | Recommendation |
|---|---|---|---|
| A9 | 1 | Sheet-per-agency vs master Sheet | Per-agency |
| A9 | 2 | Cloudflare BAA / enterprise requirement | Two-mode: free `phi_mode: initials-only`; paid `full` |
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

## How to keep working

1. Read [`CLAUDE.md`](CLAUDE.md) (rules) + [`DEPLOY.md`](DEPLOY.md) (shipping) + the relevant `docs/` section.
2. Make the change; commit + push (CI deploys workers); deploy site/Apps Script per DEPLOY.md; smoke (`--dry-run` first when unsure).
3. Update this file's "Current state" + "In flight" + "Next 3 actions" + "Known blockers" when you finish.
4. Add a [`CHANGELOG.md`](CHANGELOG.md) entry for anything user-visible. Log non-trivial incidents in [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md).
