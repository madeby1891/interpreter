# HANDOFF — 1891 Interpreter

Running handoff for in-flight work. Update when you make a non-obvious
change. Keep it skimmable — the goal is that the next agent (or
future-you) can pick up cold in under five minutes.

---

## Current state

**As of 2026-05-17:** Marketing site v1 built and ready to deploy to `https://madeby1891.com/interpreter/`. 41 HTML pages + sitemap + robots + `.htaccess` under `site/`. Builder under `_build/build.py`. Deploy + smoke scripts under `deployment/`. Anti-claim sweep, PII grep, broken-link audit all clean. Forms POST to placeholder `/api/lead` and `/api/auth/magic-link` (backend not yet built). See CHANGELOG.md for full inventory.

**Before this:** Project scaffolded fresh. PRD complete in `docs/` — six sections (A architecture, B stakeholders, C lifecycle, D AI features, E billing, F marketing). No domain registered yet. No repo on GitHub yet. No Sheet template built yet.

The PRD was written in parallel by six research agents working from a brief that included the 1891 stack contract (`~/Desktop/1891/CLAUDE.md` + `~/Desktop/1891/ARCHITECTURE.md`), the speech-processing contract (`~/Desktop/1891/shared/specs/SPEECH_PROCESSING.md`), and Anthony's specific asks: free for Deaf-owned agencies, support all modalities (signed + spoken + CART + document translation), W-2 and 1099 interpreters, AI-assisted NL intake, HIPAA-defensible. Fallon Brizendine (CDI, MA Interpretation Gallaudet, former dept chair of an ASL interpreting program) is the SME for the domain; her voice shows up especially in Sections B (personas), C (modalities and team dynamics), and F (Deaf-owned verification process).

---

## Next 3 actions

In priority order. Each is one session of work or less.

1. **Deploy the marketing site.** `bash deployment/deploy.sh --dry-run` first, then `bash deployment/deploy.sh`. Smoke script confirms security headers, real 404, blocked paths. Site lands at `https://madeby1891.com/interpreter/`.
2. **Anthony + Fallon decisions sweep.** Walk every "Open decisions" subsection (A9, B permissions edge-cases, C10, D7, E10, F10). Each item has a recommendation; lock them in. Output: a `docs/DECISIONS.md` with the actual choices and dates.
3. **Magic-link sign-in.** The `/sign-in` form still posts to `/api/auth/magic-link` (placeholder). Per PRD architecture, real magic-link issuance belongs in a Cloudflare Worker, not Apps Script. Not blocking for marketing-site launch.

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
