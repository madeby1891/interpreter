# 1891 Interpreter — Master PRD

> The interpreting agency platform built by the community it serves — free, forever, for Deaf-owned agencies.

**Authors:** Anthony Mowl (admin, builder) and Fallon Brizendine (CDI, MA Interpretation Gallaudet, former dept chair of an ASL interpreting program).
**Status:** v1 draft. Open decisions at the end of every section need a sweep before code starts.
**Date:** 2026-05-16.
**Companion reading (read first):** `~/Desktop/1891/CLAUDE.md`, `~/Desktop/1891/ARCHITECTURE.md`, `~/Desktop/1891/shared/specs/SPEECH_PROCESSING.md`, the project's own `CLAUDE.md`, `PROJECT_GUIDE.md`, `HANDOFF.md`.

---

## The big idea, in one paragraph

Interpreting agencies juggle five parties on every job — the requestor who books, the payer who's invoiced, the consumer who needs the access, the interpreter who shows up, and the scheduler who makes it all happen — across spoken languages, signed languages, document translation, and live captioning, with HIPAA-grade PHI handling baked in. Existing tools either charge per seat and per call (Boostlingo and friends) or are bespoke FileMaker rigs that don't scale. 1891 Interpreter is a flat-fee, accessibility-first, AI-assisted platform that handles every party, every modality, every billing model — and is free forever for verified Deaf-owned agencies. Built on the 1891 stack: static HTML + vanilla JS + Apps Script + per-agency Google Sheets + Cloudflare Workers + Durable Objects + R2.

---

## Read order

The PRD is six sections plus this index. Each section is independently coherent and ends with an "open decisions" list with recommendations.

| # | Section | What's in it |
|---|---|---|
| **A** | [Architecture, Data Model, and Compliance](A_architecture.md) | Tech-stack map, multi-tenant model, full Google Sheet schema (one tab per entity), Cloudflare Worker design, auth and session model, HIPAA + PII compliance posture, data-flow examples, migration/onboarding, open decisions. |
| **B** | [Stakeholders, Roles, Permissions, and Dashboards](B_stakeholders.md) | The 13 stakeholder roles with personas, full permissions matrix, per-role dashboard specs with ASCII wireframes, team-interpreter dynamics (CDI + voicer + relief), W-2 vs 1099 split, the multi-agency 1099 (DeShawn's Tuesday) pattern, onboarding flows per role, accessibility commitments. |
| **C** | [Job Lifecycle, Assignment Engine, and Service Coverage](C_lifecycle.md) | Every modality (signed, spoken, CART, document translation, async video), full state machine, intake-to-assignment happy path, the assignment engine (transparent weighted scoring, cascade pattern, team configurations, COI engine, edge cases), cancellations/no-shows/replacements, modality-specific flows, KPIs, open decisions. |
| **D** | [AI Features and Communications](D_ai_features.md) | 15 AI features with contracts (input → model → output → fallback), NL intake deep dive with few-shot examples, communications matrix (40 events × channel × time-of-day), audio/speech contract integration, AI guardrails (PHI redaction, prompt injection, hallucination, fairness), i18n for the platform itself. |
| **E** | [Billing, Payments, and Accounting](E_billing.md) | Rate-construct lexicon, the `Rate_Cards` Sheet structure, invoicing modes and formats, PHI on invoices, optional insurance billing (CMS-1500), payer portal, interpreter payouts (W-2 export + 1099 + 1099-NEC + 1042-S), Stripe Connect Express object model, edge cases (chargeback / refund / failed ACH / multi-currency), tax handling, accounting integration (QuickBooks / Xero / Bill.com / Plaid), audit + SOX-light controls, reports. |
| **F** | [Marketing Site, Pricing, and Go-to-Market](F_marketing.md) | Positioning + messaging hierarchy with audience-specific cuts, full sitemap with one-paragraph specs per page, pricing model (4 tiers public including Network floor), Deaf-owned verification process (the standard, the workflow, edge cases), brand identity primitives, 6-month content plan, SEO strategy, 4-phase launch plan, competitive matrix (Boostlingo, InterpretManager, FileMaker), open marketing decisions. |

---

## The 1891 stack contract, recapped

This project is built on the same stack as every other project under `~/Desktop/1891/`:

1. **Static-site-first.** Hand-rolled HTML/CSS/vanilla-JS served from GoDaddy cPanel over Apache. No SPA frameworks. Build steps are Python scripts; no Node toolchain required for prod builds.
2. **Apps Script backend.** Low-traffic CRM writes (rows in Sheets) and magic-link auth go through Apps Script. The Sheet is the source of truth.
3. **Cloudflare Workers for hot paths.** Anything that can't tolerate Apps Script's ~3s cold start and 90s execution limit: live job board, smart-fill recommendations, push fan-out, WebSocket presence, document translation pipeline, magic-link issuance, JWT mint, WebAuthn, SSO callbacks.
4. **One-command deploy.** Each tier has its own deploy command (`bash deployment/deploy.sh` for static; `wrangler deploy` for Workers; manual 4-click for Apps Script). Same SSH key (`~/.ssh/ftd_godaddy_deploy`) for GoDaddy across all projects.
5. **`*-secret.js` files gitignored.** Real secrets never in tracked files.
6. **HANDOFF.md + DISASTER_RECOVERY.md in every project root.** Update when something non-obvious changes.

What's special about THIS project: it's the most data-sensitive 1891 project. PHI is a primary concern. Audit logging is non-negotiable. The free-for-Deaf-owned tier is the headline policy, verified by a board that includes Fallon. Multi-tenant from day one.

---

## Open decisions, collected

Each section ends with its own "open decisions" subsection (A9, C10, D7, E10, F10) and Section B has its own permissions edge-cases. Anthony's first move on this project is a decisions sweep against the consolidated list in [`HANDOFF.md`](../HANDOFF.md).

---

## Glossary (top-of-mind terms used throughout)

- **CDI** — Certified Deaf Interpreter (works in tandem with a hearing ASL voicer).
- **CART** — Communication Access Realtime Translation (verbatim captioning, NCRA-CRC certified).
- **VRI** — Video Remote Interpreting (live video over the platform's WebRTC client or an external tool like Zoom).
- **OPI** — Over-the-Phone Interpreting (spoken-language only, voice-only).
- **VRS** — Video Relay Service (FCC-regulated Deaf-hearing phone relay; **distinct from VRI; we don't do VRS**).
- **BAA** — Business Associate Agreement (HIPAA term for a contract that lets a third party process PHI on behalf of a covered entity).
- **PHI** — Protected Health Information (HIPAA-protected data about an individual's health, treatment, or payment).
- **TIN** — Taxpayer Identification Number.
- **IRS 1099-NEC** — the form for non-employee compensation (the form 1099 contractors get from agencies).
- **EIPA** — Educational Interpreter Performance Assessment (K-12 cert).
- **RID / NIC / BEI / SC:L / FCCI / CCHI / NBCMI / NCRA / ATA** — certifying bodies and credentials referenced throughout.
- **Tenant** — one agency in the multi-tenant platform.
- **Host tenant** — Anthony's dogfood tenant; superuser support flow originates here.
- **Durable Object (DO)** — Cloudflare's stateful Worker primitive; we use `AgencyHub:{tenant_id}` and `JobRoom:{job_id}`.
- **Smart Fill** — the scheduler's button that runs the assignment engine and returns ranked candidates with transparent score breakdowns.
- **Marketplace** — the open-claim pool of qualified interpreters when cascade exhausts.
- **Cascade** — sequential/parallel offer pattern when an assignment is made; "parallel-3 first-claim-wins" is the recommended default.

---

*End of index.*
