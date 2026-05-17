# CLAUDE.md — 1891 Interpreter

**This file extends `/Users/anthony/Desktop/1891/CLAUDE.md` — read that first.**

Project-specific overrides go here. If a rule is already in the root CLAUDE.md, don't repeat it; only document what differs for 1891 Interpreter.

---

## Project conventions

- **Source of truth: per-agency Google Sheet** (`1891-interpreter-<slug>`), not a database. Plus a small `1891-interpreter-control` Sheet that holds the tenant registry. Justified in PRD section A2.
- **Worker code in TypeScript.** Apps Script in plain JS. Static pages: hand-rolled HTML + vanilla JS only. No SPA framework, no React, no Vue, no Svelte.
- **Per-tenant resource naming.** R2 keys: `{tenant_id}/...`. KV keys: `{tenant_id}:...`. DO names: `AgencyHub:{tenant_id}` and `JobRoom:{job_id}`. Sheets row writes carry `tenant_id` for cross-check. Lint-enforced in `workers/api/src/kv.ts`.
- **CSS namespace.** Project tokens prefixed `--1891int-*`. Inherits `--1891-*` from `~/Desktop/1891/shared/design-system/tokens/colors.css`. Project tokens: `--1891int-bloom: #C8553D` (terracotta), `--1891int-river: #2E5E5C` (teal-green).
- **Voice rules (extends root CLAUDE.md).** Anti-claim list in PRD F1.3 is non-negotiable: no "AI-powered," no "revolutionary," no "cutting-edge," no "empowering" / "empowerment," no "underserved community." If a draft has one of these, rewrite before commit.

---

## Known constraints

- **Apps Script `SpreadsheetApp` lock is a real ceiling.** A single Sheet under contention from >1 writer hits `LockService` timeouts at ~10 writes/sec. The Worker `sync` service buffers writes in a 5-second window and flushes in batches; never call Apps Script directly for individual row writes from `workers/api`.
- **Cloudflare Workers + BAA.** Free/Pro Cloudflare does **not** carry a BAA. Workers Enterprise does. Per A9 #2 — free Deaf-owned tier operates in `phi_mode: initials-only` mode to stay off the BAA-required path. Paid tiers (`pro`, `enterprise`) carry the Cloudflare Enterprise cost.
- **Anthropic prompt cache and tenants.** Prompt caching keys on prefix. Every model call begins with `tenant_id: <id>` in the system prompt to prevent cross-tenant cache hits. Documented in PRD D2.5.
- **PHI never reaches Claude or DeepL raw.** `lib/redact.ts` `redactForModel()` returns a model-safe projection only. Free-text fields run through a PHI scrubber (regex + NER). Every model call writes an `AI_Audit` row with input/output hashes. Documented in PRD A6 and D5.
- **Maryland two-party consent applies to any audio capture.** Per root CLAUDE.md and `~/Desktop/1891/shared/specs/SPEECH_PROCESSING.md`. Consent UI mandatory, RECORDING indicator mandatory, executive-session PAUSE mandatory, retention defaults non-negotiable.
- **Sheet retention rules.** `Audit_Log` is 7-year append-only with an integrity-hash chain enforced by Apps Script editor protections. Audio raw 30 days, transcripts 1 year, signed minutes permanent.
- **Stripe Connect Express required for 1099 payouts on default path.** Manual ACH via Plaid is a documented fallback for long-tenured interpreters who refuse to onboard Connect (E10 #2).
- **The Deaf-owned verification board** is Fallon + 2 community advisors. The board reviews all denials. Members not yet finalized; until then, applications can be received but decisions are paused.

---

## Operator preferences (project-specific)

- **Drive Apps Script via Chrome MCP** per root CLAUDE.md. Same constraints apply: CSP blocks cross-origin fetch, screenshots time out, Monaco bulk writes use `executeEdits`, deploy is a 4-click manual flow Anthony does at deploy time.
- **Deploy timing.** Never deploy on a weekday morning between 7–10 ET — that's the schedulers' Tetris hour. Maintenance windows: Saturday 11pm–Sunday 3am ET by default; agency owners get a heads-up email 48h before any non-trivial deploy.
- **Who to notify when this ships.** Anthony + Fallon (always). Each agency's owner gets an email after a non-trivial deploy with the changelog. Schedulers get an in-app toast on next login.

---

## Source of truth

For this project, the canonical record of truth is the **per-agency Google Sheet** (`1891-interpreter-<slug>`). The control plane is the `1891-interpreter-control` Sheet.

Specifically:
- All structured rows (Jobs, Job_Assignments, Interpreters, Consumers, etc.) live in the per-agency Sheet.
- Blobs (PDFs, translated documents, COIs, recordings, transcripts) live in Cloudflare R2 under `r2://1891-interpreter/{tenant_id}/...`.
- Hot operational state (live interpreter presence, open-job board, live VRI sessions) lives in per-agency Durable Objects.
- KV is a read-through cache; Sheet is the writer. Never write to KV without writing to Sheet first.
- When an agent quotes a fact about a tenant, the answer comes from the per-agency Sheet (or its KV cache, with a 60s TTL).

---

## What this project is NOT

- **Not a marketplace.** Interpreters don't compete on price across agencies; each agency configures its own rate cards and roster.
- **Not a VRS provider.** Video Relay Service (the federally-funded Deaf-to-hearing phone relay) is a different regulated business (FCC). We do VRI (Video Remote Interpreting), which is a different thing — paid by the agency, not by FCC subsidies. Don't conflate.
- **Not a payroll system for W-2 staff.** We capture hours and export to ADP / Gusto / Paychex / Rippling. Tax withholding, garnishments, benefits live in payroll, not in us.
- **Not a directory.** We don't list interpreters publicly; the roster is private to the agency. We don't recruit interpreters either — agencies own their hiring funnel.
- **Not a translation memory product.** We use TM (per E1.1 and Section C document-translation flow); we don't compete with MemoQ / Trados / Phrase / XTM as a stand-alone TM tool. Integrate, don't replace.
- **Not Claude in production for live captioning.** Per the speech-processing contract, Claude is post-session only. Live STT is Deepgram (or AssemblyAI as alternate).
- **Not an EHR or PHI system of record.** We hold the minimum PHI needed to interpret well; the requestor's EHR is the system of record for clinical data. We don't store diagnoses, treatment notes, or lab values.
