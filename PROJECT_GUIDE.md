# PROJECT_GUIDE — 1891 Interpreter


<!-- AGENT-OPERATING-RULES-POINTER -->
> 🚨 **Agents — read [`CLAUDE.md`](../../CLAUDE.md) at the workspace root FIRST.** Workspace-wide operating rules live there:
> - `clasp` / `wrangler` / SSH-via-`deploy.sh` are the default deploy paths — never paste code into a dashboard, never ask Anthony to run `clasp push`.
> - **You own `git add` + `git commit` + `git push`** in the same turn as the change, plus a post-deploy smoke test.
> - The 4-click Apps Script deploy is the ONE thing Anthony does — when you need it, drop the exact `https://script.google.com/d/<SCRIPT_ID>/edit` URL inside a 🚨 callout. No hand-waving.
>
> This file extends those rules; it does not replace them.

> Scaffolding + ops checklist. Assumes you've read `~/Desktop/1891/CLAUDE.md`
> and `~/Desktop/1891/ARCHITECTURE.md` and the [PRD index](docs/PRD_index.md).

---

## TL;DR

| | |
|---|---|
| **Folder**   | `~/Desktop/1891/projects/interpreter/` |
| **Status**   | Marketing site + scheduler MVP live. **SaaS payments live 2026-05-18** (Pattern F Checkout + webhook + branded welcome). **Mode A pivot 2026-05-19:** platform runs as SaaS + read-only reporting (Pattern G) — agency keeps merchant-of-record for their own customer billing + interpreter payouts. Pattern G code shipped; awaits Anthony enabling Connect-as-platform in Stripe dashboard. See [`docs/PAYMENTS_IMPL.md`](docs/PAYMENTS_IMPL.md) §1 mode-map. |
| **Purpose**  | Multi-tenant interpreting agency platform: scheduling, interpreter app, billing, document translation, captioning. Free for Deaf-owned agencies. |
| **Live URLs** | Site: `https://madeby1891.com/interpreter/` · Pricing: `/interpreter/pricing` · Subscribe: `/interpreter/pay/subscribe` · edge worker: `https://1891-interpreter-api.anthonymowl.workers.dev` |
| **Domain**   | `1891interpreter.app` (planned; not yet registered — currently served under `madeby1891.com/interpreter/`) |
| **Repo**     | `https://github.com/madeby1891/interpreter` (public) |
| **Host**     | static hosting provider for marketing + static shells; edge workers for app |
| **SSH key**  | `~/.ssh/ftd_godaddy_deploy` (shared 1891 deploy key) |
| **Backend**  | lightweight backend script + per-agency data store + edge workers + state primitives + R2 + KV |

---

## What's done

- Six-section PRD scaffolded in [`docs/`](docs/). Covers architecture, stakeholders, lifecycle, AI features, billing, and go-to-market.
- Project root files in place: README, PROJECT_GUIDE, HANDOFF, CLAUDE, DISASTER_RECOVERY, CHANGELOG.
- Open-decisions list collected at end of every section (A9, B-permissions-edge-cases, C10, D7, E10, F10).
- **Marketing site + scheduler MVP live.** 41 static HTML pages + Apps Script backend + Cloudflare Worker.
- **Payments live (2026-05-18).** All four flows are wired end-to-end:
  - **SaaS subscription:** `/pricing` → `/pay/subscribe` → Stripe Checkout (Solo $108/yr or $11/mo, Practice $2,988/yr or $299/mo, Studio $8,988/yr or $899/mo) → webhook flips Agencies row to `subscription_status='active'`.
  - **Connect onboarding** for individual interpreters (1099 payouts).
  - **Payer invoicing** via Stripe Invoicing (agency bills payer for closed jobs).
  - **Payout transfers** to interpreter Connect accounts.
- Webhook endpoint `we_1TYdCARyhX2OZu5spASL0jxI` is live and subscribed to the 19 events from `shared/specs/PAYMENTS.md` §7.1. Full details: [`docs/PAYMENTS_IMPL.md`](docs/PAYMENTS_IMPL.md). Live-mode runbook: [`deployment/PAYMENTS_LIVE_DEPLOY.md`](deployment/PAYMENTS_LIVE_DEPLOY.md).

## What's next

In order:

1. **Decisions sweep.** Walk the open-decisions tables (A9, C10, D7, E10, F10) with Anthony and Fallon and lock them in. Each section ends with a recommendation per decision; override or accept.
2. **Domain registration.** `1891interpreter.app` at the registrar. `.app` is preferred — registry-enforced HTTPS. Register `.com` and `.coop` as defensive holds.
3. **Repo creation.** `gh repo create madeby1891/interpreter --private`.
4. **Tenant Sheet template.** Build the canonical `1891-interpreter-tenant-template` Google Sheet with every tab from section A3. Add data validation, dropdowns, protected ranges. Store as a Drive template.
5. **Control Sheet.** Build `1891-interpreter-control` Sheet (Tenants, Tenant_Owners, Sys_Log).
6. **Apps Script project.** Two scripts: tenant-side (one per agency, container-bound to that agency's Sheet) and control-plane (bound to the control Sheet). Container-bound means provisioning copies the template Sheet + bound script together.
7. **Worker scaffold.** `wrangler init` for each of `workers/api`, `workers/sync`, `workers/realtime`, `workers/notify`, `workers/translate`, `workers/auth`. Establish shared `lib/` for JWT, tenant, redact, audit, sheet-rpc.
8. **First static page.** `site/index.html` as the marketing hero per Section F (hero one-liner, three pillars, ASL+captioned explainer placeholder).
9. **`deploy.sh`.** Standard 1891 rsync pattern over `~/.ssh/ftd_godaddy_deploy`.
10. **Design partner #1 onboarded.** Per the Phase 0 launch plan in F8 — white-glove for the first Deaf-owned agency.

## Deploy story

Same shape as every other 1891 project:

- `bash deployment/deploy.sh` rsyncs `site/` to the host over `~/.ssh/ftd_godaddy_deploy`.
- `wrangler deploy --env production` for each Worker.
- Apps Script deployments: scripted via `shared/ops/clasp-deploy.sh` per root CLAUDE.md.
- `.htaccess` blocks `/deployment/`. Real `/404.html`. Sitemap built. HSTS preload. X-Content-Type-Options nosniff.

### Deploy-time lint gates

Each runs before rsync; any FAIL aborts the deploy (bypass: `FORCE=1`).

| Lint | Spec | Slot |
|---|---|---|
| `shared/ops/godview-lint-gate.sh` | [GODVIEW_AUTO_REGISTRATION.md](../../shared/specs/GODVIEW_AUTO_REGISTRATION.md) | first |
| `shared/ops/sms-consent-lint.py` | [SMS.md](../../shared/specs/SMS.md) v1 | second |
| `shared/ops/dashboard-contract-lint.py --surface=admin` | [DASHBOARD_CONTRACT.md](../../shared/specs/DASHBOARD_CONTRACT.md) v1 | third |
| `npx vitest run` | n/a — worker test suite | fourth |

## Workspace defaults

- **Stack:** static HTML + vanilla JS + Python build + Apps Script + Workers (TS).
- **Voice:** plain-spoken. The 1891 lineage is the undercurrent. No "revolutionary," no "AI-powered" as a marketing claim, no "cutting-edge." See F1.3 anti-claims list.
- **CSS namespace:** `--1891int-*` for any project-specific tokens. Inherit `--c-*` / `--1891-*` from `shared/design-system/tokens.css`. Bloom token is `#C8553D` (1891-interpreter terracotta), river is `#2E5E5C` (teal-green).
- **HIPAA posture:** every PHI read writes to `Audit_Log`. Anthropic and DeepL never see raw PHI — see Section A6 redaction contract.
- **Multi-tenant:** per-agency Sheet, per-tenant R2 prefix, per-tenant DO. See A2.

## Initial checklist

- [ ] Decisions sweep with Anthony + Fallon (sections A9, C10, D7, E10, F10)
- [ ] Register `1891interpreter.app` (+ `.com`, `.coop` defensive)
- [ ] `gh repo create madeby1891/interpreter --private`
- [ ] `git init`, first commit (this scaffold + PRD)
- [ ] Build tenant Sheet template + control Sheet
- [ ] Apps Script scaffold (tenant + control)
- [ ] Wrangler scaffold for 6 Workers
- [ ] Cloudflare account: R2 bucket, KV namespace, Queue, DO migrations, Secrets Store
- [ ] Stripe Connect platform application
- [ ] Postmark account + BAA
- [ ] Twilio account + HIPAA-eligible products + BAA
- [ ] Anthropic API key with BAA tier
- [ ] DeepL Pro key (or defer to spoken-language launch)
- [ ] Point `1891interpreter.app` DNS at GoDaddy
- [ ] First-page deploy: `bash deployment/deploy.sh --dry-run` then real
- [ ] Smoke checks all green (homepage 200, `/nope` 404, `/deployment/` 403)
- [ ] Update root `~/Desktop/1891/README.md` "Projects" table
- [ ] Design partner #1 onboarding kickoff

## Open work

See [`HANDOFF.md`](HANDOFF.md).
