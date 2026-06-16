# CLAUDE.md — 1891 Interpreter

**Extends `/Users/anthony/Desktop/1891/CLAUDE.md` — read that first.** Only project-specific deltas live here.
**Deploy/ops knowledge lives in [`DEPLOY.md`](DEPLOY.md).** Read it before shipping anything.

---

## Project conventions

- **Source of truth: Cloudflare D1** (`interpreter-data`) for **reads**; writes still land in the per-agency Google Sheet and sync to D1 (see "Source of truth" below). Tenant registry is the `1891-interpreter-control` Sheet. (PRD A2.)
- **Worker code in TypeScript.** Apps Script in plain JS. Static pages: hand-rolled HTML + vanilla JS only — no SPA framework (React/Vue/Svelte).
- **Per-tenant resource naming.** R2: `{tenant_id}/...`. KV: `{tenant_id}:...`. DO: `AgencyHub:{tenant_id}`, `JobRoom:{job_id}`. Sheet/D1 rows carry `tenant_id`. Lint-enforced in `workers/api/src/kv.ts`.
- **CSS namespace.** Project tokens prefixed `--1891int-*`, inheriting `--1891-*` from `~/Desktop/1891/shared/design-system/tokens/colors.css`. `--1891int-bloom: #C8553D` (terracotta), `--1891int-river: #2E5E5C` (teal-green).
- **Voice rules.** PRD F1.3 anti-claims are non-negotiable: no "AI-powered," "revolutionary," "cutting-edge," "empowering"/"empowerment," "underserved community." Rewrite before commit. (Enforced by `voice-lint` in `deploy.sh`.)

---

## Known constraints

- **Apps Script `SpreadsheetApp` lock is a real ceiling** — a single Sheet hits `LockService` timeouts at ~10 writes/sec under contention. The Worker `sync` service buffers writes in a 5s window and batch-flushes; never call Apps Script for individual row writes from `workers/api`.
- **Cloudflare Workers + BAA.** Free/Pro carry **no** BAA; Workers Enterprise does. Free Deaf-owned tier runs `phi_mode: initials-only` to stay off the BAA path; paid tiers (`pro`, `enterprise`) carry the Enterprise cost. (A9 #2.)
- **Anthropic prompt cache + tenants.** Caching keys on prefix, so every model call begins with `tenant_id: <id>` in the system prompt to prevent cross-tenant cache hits. (D2.5.)
- **PHI never reaches Claude or DeepL raw.** `lib/redact.ts` `redactForModel()` returns a model-safe projection; free-text runs through a PHI scrubber (regex + NER); every model call writes an `AI_Audit` row with input/output hashes. (A6, D5.)
- **Maryland two-party consent for any audio capture** (`~/Desktop/1891/shared/specs/SPEECH_PROCESSING.md`): consent UI, RECORDING indicator, executive-session PAUSE, and retention defaults all mandatory.
- **Retention.** `Audit_Log` is 7-year append-only with an integrity hash-chain (Apps Script editor protections). Audio raw 30 days, transcripts 1 year, signed minutes permanent.
- **Stripe Connect Express required for 1099 payouts** on the default path; manual ACH via Plaid is the documented fallback for interpreters who refuse Connect. (E10 #2.)
- **Deaf-owned verification board** = Fallon + 2 community advisors (reviews all denials). Advisors not yet named — applications are received but decisions paused.

---

## Source of truth

> **Migrating per ADR-001 ([`PERSISTENCE_ARCHITECTURE.md`](../../shared/specs/PERSISTENCE_ARCHITECTURE.md)).** D1 is interpreter's highest-value migration (PHI + payments). **Phase 3 (flip READS) is DONE + verified live 2026-06-06:** all 16 app read accessors read D1 via `_dbValues_` (`Code_D1Store.gs`, `D1_PRIMARY=true`; proven by `?d1op=readcheck`/`readsmoke`). **Phase 4 (D1 sole writer)** — ~200 inlined writes → D1, nudge-off, D1→Sheet mirror-on, all-or-nothing per table — is the remaining step, staged in [`workers/interpreter-data/MIGRATION.md`](workers/interpreter-data/MIGRATION.md).

- **Reads:** Cloudflare D1 (`interpreter-data`), the system of record.
- **Writes:** still land in the per-agency Sheet (`1891-interpreter-<slug>`) → fresh-on-write nudge → D1 (D1 stays current within ~1–2s). The Sheet is now a write-staging surface, no longer read by the app, until the phase-4 flip.
- Structured rows (Jobs, Job_Assignments, Interpreters, Consumers, …) → Sheet/D1. Blobs (PDFs, translations, COIs, recordings, transcripts) → R2 at `r2://1891-interpreter/{tenant_id}/...`. Hot state (presence, open-job board, live VRI) → per-agency Durable Objects.
- KV is a read-through cache (60s TTL); never write KV without writing the system of record first.

---

## What this project is NOT

- **Not a marketplace.** Interpreters don't compete on price across agencies; each agency configures its own rate cards + roster.
- **Not a VRS provider.** VRS (FCC-funded Deaf-hearing phone relay) is a different regulated business. We do VRI (agency-paid), not VRS. Don't conflate.
- **Not a payroll system for W-2 staff.** We capture hours and export to ADP/Gusto/Paychex/Rippling; withholding, garnishments, benefits live in payroll.
- **Not a directory.** The roster is private to the agency; we don't list or recruit interpreters — agencies own hiring.
- **Not a translation-memory product.** We use TM (E1.1, Section C); we integrate with MemoQ/Trados/Phrase/XTM, not replace them.
- **Not Claude in production for live captioning.** Claude is post-session only; live STT is Deepgram (AssemblyAI alternate).
- **Not an EHR / PHI system of record.** We hold the minimum PHI to interpret well; the requestor's EHR is the clinical system of record. No diagnoses, treatment notes, or lab values.
