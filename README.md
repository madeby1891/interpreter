# 1891 Interpreter

> The interpreting agency platform built by the community it serves — free, forever, for Deaf-owned agencies.

Scheduling, interpreter app, billing, document translation, live captions — one tool. Spoken and signed languages, same tool, same price. Built in Frederick. Carried forward since 1891.

## Status

**Live.** Marketing site + scheduler MVP + SaaS payments are in production at `https://madeby1891.com/interpreter/`. The full v1 PRD is in [`docs/`](docs/) (sections A–F). Current state, blockers, and open decisions are in [`HANDOFF.md`](HANDOFF.md).

## Read order

1. **[`CLAUDE.md`](CLAUDE.md)** — project rules for agents (extends `~/Desktop/1891/CLAUDE.md`).
2. **[`DEPLOY.md`](DEPLOY.md)** — how every tier ships, infra identifiers, gotchas, rollback.
3. **[`PROJECT_GUIDE.md`](PROJECT_GUIDE.md)** — what this is, what's live, where it lives.
4. **[`docs/PRD_index.md`](docs/PRD_index.md)** — the master spec, sectioned A–F.
5. **[`HANDOFF.md`](HANDOFF.md)** — current state, next actions, blockers, open decisions.
6. **[`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)** — what to do when something breaks.
7. **[`CHANGELOG.md`](CHANGELOG.md)** — dated history.

## What's in this folder

| Path | What |
| --- | --- |
| `docs/` | PRD sections A–F + index. Design source of truth. |
| `site/` | Static HTML/CSS/JS — the deployable tree. |
| `_build/` | Python build scripts (Sheet → static HTML, sitemap). |
| `workers/` | Cloudflare Workers: `api`, `interpreter-data`, `captions`, … |
| `apps-script/` | Apps Script backend (`.gs`). Secrets are gitignored `*-secret.gs`. |
| `deployment/` | `deploy.sh`, `smoke.sh`, payments runbook. Blocked from public via `.htaccess`. |
| `ops/` | Comms/drip templates. |
| `archive/` | Dated history split out of HANDOFF/CHANGELOG + scaffold-era planning. |

## Stack at a glance (per `~/Desktop/1891/ARCHITECTURE.md`)

- **Front:** static HTML + vanilla JS + shared design-system CSS tokens. No SPA, no Node toolchain in prod.
- **Backend (write path):** Apps Script → per-agency Google Sheets, syncing to D1.
- **Reads / hot path:** Cloudflare D1 (read system of record) + Workers + Durable Objects + R2 + KV + Queues.
- **Auth:** magic-link default, WebAuthn passkey enrollment, SSO/SAML for enterprise.
- **Deploy:** see [`DEPLOY.md`](DEPLOY.md).

## The big idea, in one paragraph

Interpreting agencies juggle five parties on every job — requestor, payer, consumer, interpreter, scheduler — across spoken languages, signed languages, document translation, and live captioning, with HIPAA-grade PHI handling. Existing tools either charge per seat and per call (Boostlingo) or are bespoke FileMaker rigs that don't scale. 1891 Interpreter is a flat-fee, accessibility-first, AI-assisted platform that handles every party, every modality, every billing model — and is free forever for verified Deaf-owned agencies. Built by Anthony Mowl (5th-generation Deaf since 1891) and Fallon Brizendine (CDI, MA Interpretation Gallaudet, former dept chair of an ASL interpreting program).
