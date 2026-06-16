# PROJECT_GUIDE — 1891 Interpreter

> 🚨 **Agents — read [`CLAUDE.md`](CLAUDE.md) (project rules) and [`DEPLOY.md`](DEPLOY.md) (how it ships) first**, plus `~/Desktop/1891/CLAUDE.md` at the workspace root. You own `git add` + `commit` + `push` + deploy + smoke in the same turn. Never paste code into a dashboard. The one thing Anthony does by hand is the 4-click Apps Script publish — give him the exact `https://script.google.com/d/<SCRIPT_ID>/edit` URL in a 🚨 callout.

Scaffolding + ops orientation. Scaffold-era planning (the original "what's next" / initial checklist) is in [`archive/PROJECT_GUIDE_SCAFFOLD.md`](archive/PROJECT_GUIDE_SCAFFOLD.md).

---

## TL;DR

| | |
|---|---|
| **Folder**   | `~/Desktop/1891/projects/interpreter/` |
| **Status**   | Marketing site + scheduler MVP live. **SaaS payments live 2026-05-18** (Pattern F Checkout + webhook + branded welcome). **Mode A canonical (2026-05-19):** platform = SaaS + read-only reporting (Pattern G); agency keeps merchant-of-record for its own customer billing + interpreter payouts. Pattern G code shipped, awaits Anthony enabling Connect-as-platform in Stripe. See [`docs/PAYMENTS_IMPL.md`](docs/PAYMENTS_IMPL.md) §1 mode-map. |
| **Purpose**  | Multi-tenant interpreting-agency platform: scheduling, interpreter app, billing, document translation, captioning. Free for Deaf-owned agencies. |
| **Live URLs** | Site: `https://madeby1891.com/interpreter/` · Pricing: `/interpreter/pricing` · Subscribe: `/interpreter/pay/subscribe` · API worker: `https://1891-interpreter-api.anthonymowl.workers.dev` |
| **Domain**   | `1891interpreter.app` (planned; not yet registered — served under `madeby1891.com/interpreter/`) |
| **Repo**     | `https://github.com/madeby1891/interpreter` (public) |
| **SSH key**  | `~/.ssh/ftd_godaddy_deploy` (shared 1891 deploy key) |
| **Stack**    | static HTML + vanilla JS · Python build · Apps Script (per-agency Sheets, write path) · Cloudflare Workers + DO + R2 + KV + D1 (read system of record) |

---

## What's live

- **Six-section PRD** in [`docs/`](docs/) (A architecture, B stakeholders, C lifecycle, D AI features, E billing, F go-to-market) — the design source of truth. Each section ends with an open-decisions list (A9, B-permissions, C10, D7, E10, F10).
- **Marketing site + scheduler MVP** — static HTML + Apps Script backend + Cloudflare Workers. Magic-link auth, jobs CRUD, smart-fill, claim/cancel, interpreter mobile view. All endpoints JWT-gated, writes tenant-scoped, PHI redacted on inbound.
- **Payments live (2026-05-18):** SaaS subscription (Solo $108/yr·$11/mo, Practice $2,988/yr·$299/mo, Studio $8,988/yr·$899/mo) → Stripe Checkout → webhook flips `subscription_status='active'`. Connect onboarding, payer invoicing, payout transfers wired (deferred per Mode A). Webhook `we_1TYdCARyhX2OZu5spASL0jxI` live on 19 events. Detail: [`docs/PAYMENTS_IMPL.md`](docs/PAYMENTS_IMPL.md); go-live runbook: [`deployment/PAYMENTS_LIVE_DEPLOY.md`](deployment/PAYMENTS_LIVE_DEPLOY.md).
- **Since then:** QuickBooks Online integration, live captions (Deepgram), inbound SMS reply parsing, tamper-evident audit hash-chain, one-click tenant export, SSO (OIDC), email→draft intake, launch funnel (gated sandbox + form receipts + lead console), drip emails. See [`CHANGELOG.md`](CHANGELOG.md) and [`HANDOFF.md`](HANDOFF.md).
- **D1 migration (ADR-001):** reads flipped to D1 (phase 3 done); phase-4 sole-writer rails staged. See [`workers/interpreter-data/MIGRATION.md`](workers/interpreter-data/MIGRATION.md).

---

## How it ships

See **[`DEPLOY.md`](DEPLOY.md)** for everything: the three tiers (site / workers / Apps Script), the `deploy.sh` lint pipeline, deploy timing, infrastructure identifiers, secrets, the non-obvious gotchas (CDN cache-busting, clasp-from-clone foot-gun, D1 `migrations apply` caveat), smoke checks, runbooks, and rollback.

---

## Workspace defaults (deltas from root)

- **Stack:** static HTML + vanilla JS + Python build + Apps Script + Workers (TS). No SPA, no Node toolchain in prod.
- **Voice:** plain-spoken, 1891 lineage as undercurrent. Anti-claims per PRD F1.3 (see CLAUDE.md / DEPLOY.md §6).
- **CSS:** `--1891int-*` project tokens; bloom `#C8553D`, river `#2E5E5C`.
- **HIPAA:** every PHI read writes `Audit_Log`; Anthropic + DeepL never see raw PHI (A6 redaction contract).
- **Multi-tenant:** per-agency Sheet/D1, per-tenant R2 prefix, per-tenant DO (A2).

---

## Current work + open decisions

See [`HANDOFF.md`](HANDOFF.md) — current state, next 3 actions, known blockers, and the consolidated open-decisions table.
