# 1891 Interpreter

> The interpreting agency platform built by the community it serves — free, forever, for Deaf-owned agencies.

Scheduling, interpreter app, billing, document translation, live captions — one tool. Spoken languages and signed languages, same tool, same price. Built in Frederick. Carried forward since 1891.

## Status

**Scaffolded 2026-05-16.** The full v1 PRD is in [`docs/`](docs/). No code yet — this folder is the design dossier coding agents will build from. Six PRD sections (A–F) cover architecture, stakeholders, lifecycle, AI features, billing, and go-to-market. Read [`docs/PRD_index.md`](docs/PRD_index.md) first.

## Read order

1. **[`PROJECT_GUIDE.md`](PROJECT_GUIDE.md)** — what this project is, how it ships, where it lives.
2. **[`docs/PRD_index.md`](docs/PRD_index.md)** — the master spec, sectioned A through F.
3. **[`HANDOFF.md`](HANDOFF.md)** — current state, next 3 actions, known blockers.
4. **[`CLAUDE.md`](CLAUDE.md)** — project-specific notes for agents; extends `~/Desktop/1891/CLAUDE.md`.
5. **[`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)** — what to do when something breaks.
6. **[`CHANGELOG.md`](CHANGELOG.md)** — dated history of changes.

## What's in this folder

| Path | What |
| --- | --- |
| `docs/` | PRD sections A–F, plus the combined index. The source of truth for design. |
| `site/` | Static HTML/CSS/JS — the deployable tree (to be created). |
| `_build/` | Python build scripts (Sheet → static HTML, sitemap) (to be created). |
| `workers/` | Cloudflare Worker projects: `api`, `sync`, `realtime`, `notify`, `translate`, `auth` (to be created). |
| `apps-script/` | Apps Script backend code mirror (to be created). |
| `deployment/` | `deploy.sh`, ops docs. Blocked from public via .htaccess. |
| `data/` | Anonymized seed data + Sheet templates. Real data lives in the agency Sheets. |
| `.private-data/` | Gitignored. Raw exports, PII, anything that can't be tracked. |

## Stack at a glance (per [`~/Desktop/1891/ARCHITECTURE.md`](../../ARCHITECTURE.md))

- **Front:** static HTML + vanilla JS + CSS tokens from the shared design system. No SPA. No Node toolchain in prod.
- **Backend (cold path):** Google Apps Script writing to per-agency Google Sheets. Sheet is source of truth.
- **Backend (hot path):** Cloudflare Workers + Durable Objects + R2 + KV + Queues.
- **Auth:** magic-link default, WebAuthn passkey enrollment, SSO/SAML for enterprise.
- **Deploy:** `bash deployment/deploy.sh` rsyncs `site/` to GoDaddy cPanel; `wrangler deploy` for workers.

## Live

- **Marketing URL:** `https://1891interpreter.app/` (planned — domain not yet registered, see HANDOFF)
- **Per-tenant app URL:** `https://<agency-slug>.1891interpreter.app/`
- **Remote:** GoDaddy cPanel for marketing + static shells; Cloudflare Workers for app traffic
- **Repo:** `git@github.com:madeby1891/interpreter.git` (planned)

## The big idea, in one paragraph

Interpreting agencies juggle five parties on every job — the requestor who books, the payer who's invoiced, the consumer who needs the access, the interpreter who shows up, and the scheduler who makes it all happen — across spoken languages, signed languages, document translation, and live captioning, with HIPAA-grade PHI handling baked in. Existing tools either charge per seat and per call (Boostlingo) or are bespoke FileMaker rigs that don't scale. 1891 Interpreter is a flat-fee, accessibility-first, AI-assisted platform that handles every party, every modality, every billing model — and is free forever for verified Deaf-owned agencies. Built by Anthony Mowl (5th-generation Deaf since 1891) and Fallon Brizendine (CDI, MA Interpretation Gallaudet, former dept chair of an ASL interpreting program).

---

*Scaffold date: 2026-05-16.*
