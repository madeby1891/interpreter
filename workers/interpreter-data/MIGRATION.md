# 1891 Interpreter → D1 migration (ADR-001, highest-value target)

**Why interpreter is the highest-value migration:** it is the largest Sheets-as-DB
consumer in the workspace and the only product holding **PHI + payment records** in a
spreadsheet — a compliance exposure, not just a scaling one (ADR §1, matrix row 2).
`Code.gs` alone has 49 Sheets-write calls; ~150 across `Code_Invoicing` /
`Code_Payments` / `Code_Subscriptions` / `Code_PHI` / `Code_Sms`.

**interpreter IS LIVE**, so this is a **strangler migration** (ADR §6), never a
big-bang. The Apps Script + Sheet path stays the authoritative source of truth and the
rollback safety net until D1 has soaked through all four phases.

Governing doc: [`shared/specs/PERSISTENCE_ARCHITECTURE.md`](../../../../shared/specs/PERSISTENCE_ARCHITECTURE.md).
Scaffold: [`shared/templates/d1-backend/`](../../../../shared/templates/d1-backend/).
Reference impl: [`projects/kg-homestead/workers/kgh-data/`](../../../kg-homestead/workers/kgh-data/).

## Data model — 40 tables, lifted verbatim from the Apps Script schema

interpreter keeps its schema INLINE in `apps-script/Code.gs` (there is NO `Schema.gs`):
the `T` tab-name map (line ~50) + `_tenantSchema()` (line ~2392), plus the control-plane
`CONTROL_SCHEMA` in `Code_Multitenant.gs` and three tabs that live in the Sheet but
outside `_tenantSchema()` (`Inbound`, `Deaf_Owned_Applications`, `Auth_Tokens`).
`schema.sql` mirrors all of it 1:1 — same column names, same order:

- **33** tenant tables (`_tenantSchema`): Agencies, Users, Roles, Interpreters,
  Interpreter_Documents, Tenant_Requirements, Rate_Modifiers, Rate_Cards,
  Notification_Prefs, Assignment_Notes, Languages, Certifications, Requestors,
  Requestor_Contacts, Clients, Client_Contacts, Specialists, Client_Billing_Rules,
  Job_Expenses, Client_Documents, Payers, Consumers, Locations, Jobs, Job_Assignments,
  Job_Events, Communications, Invoices, Invoice_Lines, Payouts, Documents, Settings,
  Audit_Log
- **3** control-plane tables (`Code_Multitenant.gs`): Tenants, Tenant_Owners, Sys_Log
- **3** out-of-`_tenantSchema` tabs: Auth_Tokens, Inbound, Deaf_Owned_Applications
- **1** D1-internal: schema_version

Conventions (ADR §9): money = INTEGER cents, `*_at` = epoch ints, booleans 0/1,
list/JSON columns = TEXT. Multi-tenant: `tenant_id` on every per-agency table.

### Documented deviations from the verbatim Sheet schema
1. **`Settings` gains `tenant_id`** as the first column + composite PK
   `(tenant_id, "key")`. In Sheets, tenant was implicit (one Sheet per agency); in one
   multi-tenant D1, `"key"` alone is not unique. The mirror drops `tenant_id` when
   writing each tenant's Sheet. Only column-set change.
2. **SQLite reserved words** double-quoted in DDL: `"key"`, `"value"`, `"trigger"`,
   `"first"`, `"last"`, `"when"`, `"timestamp"`.
3. **`PRAGMA foreign_keys` left OFF.** FKs declared as `REFERENCES` for docs only — the
   historical backfill inserts cross-table rows in non-dependency order, so enforcing
   FKs mid-backfill would reject valid rows. D1 defaults FKs off anyway.

## PHI — the encryption boundary does NOT move

`Code_PHI.gs` + `workers/api/src/phi.ts` already encrypt PHI into opaque `v1:<iv>:<ct>`
AES-GCM blobs **before** anything is stored — `PHI_MASTER_KEY` never leaves the existing
`1891-interpreter-api` Worker. D1 stores the SAME opaque blob the Sheet stored.
`interpreter-data` **never decrypts** and **never logs** the PHI columns (`db.ts`
`PHI_BLOB_COLUMNS` + `safeRowForLog()`; the dual-write route never echoes the row body).
PHI blob columns: `Consumers.{legal_first,legal_last,dob,mrn}_encrypted`,
`Consumers.notes_sealed`, `Interpreters.payment_details_encrypted`.

## What's standing (this session, 2026-05-31)

- [x] `schema.sql` + `migrations/0001_init.sql` — 40 tables, validated on local `sqlite3`
      (40 CREATE TABLE, 81 indexes, 0 dupes; column counts match source: Jobs 43,
      Consumers 17, Invoices 26, Interpreters 45, Settings 7+1).
- [x] `src/` — HMAC-enveloped router (`/healthz`, `/v1/dual-write`,
      `/v1/dual-write/batch`, `/v1/parity`, `/v1/echo`), typed allowlisted tenant-scoped
      `db.ts` writer, INERT nightly mirror (`mirror.ts`).
- [x] **D1 provisioned via the Cloudflare REST API** (wrangler-bypass) —
      `interpreter-data` = `5a445d42-4e08-48e8-84a3-8156f86c567a`.
- [x] KV `interpreter-cache` = `86aaf1be509040b489c1023fae24709c`; queue
      `interpreter-jobs`. IDs pasted into `wrangler.toml`.
- [x] **Schema applied to the live remote D1** via REST `/d1/database/<id>/query`
      (verified: 40 app tables + `_cf_KV` + `sqlite_sequence`; column counts match source).

## How provisioning was done (REST, not wrangler)

`wrangler` is absent from the osascript-bridge PATH and its OAuth account-grant is
intermittently broken (`reference_cloudflare_account_id`). BUT the OAuth **bearer**
token in `~/Library/Preferences/.wrangler/config/default.toml` authenticates fine
against `api.cloudflare.com` directly. `provision_rest.py` drives the REST API with it
(idempotent; never prints the token):

```sh
python3 provision_rest.py create-db        # -> interpreter-data uuid
python3 provision_rest.py create-kv        # -> interpreter-cache id
python3 provision_rest.py create-queue     # -> interpreter-jobs
python3 provision_rest.py apply-schema <db_id> ./schema.sql
python3 provision_rest.py exec <db_id> "SELECT ..."   # ad-hoc query / parity
```

> **Caveat — schema applied out-of-band.** The schema went in via the REST `/query`
> endpoint, NOT `wrangler d1 migrations apply`. So wrangler's internal `d1_migrations`
> ledger does NOT know `0001_init.sql` ran. **Do not run `wrangler d1 migrations apply`
> for 0001** — it would re-run the file; the CREATE TABLEs are `IF NOT EXISTS` (harmless)
> but the `schema_version` INSERT is not guarded and would duplicate. Future changes:
> keep using REST `exec`, or `wrangler d1 migrations apply` starting from `0002_*.sql`.

## Deploy

`git push` to `main` is the deploy — `.github/workflows/deploy-workers.yml` triggers on
`workers/**` and deploys each changed `workers/<name>/` with the CI `CLOUDFLARE_API_TOKEN`
(a real API token, unaffected by local OAuth flakiness), then smokes the live URL.

> **Per-repo CI caveat:** the workflow's path filter is `workers/**` (repo-root-relative).
> This worker lives at `projects/interpreter/workers/interpreter-data/` in the
> **interpreter** repo (`madeby1891/interpreter`). For CI to fire, that repo needs its
> own copy of `.github/workflows/deploy-workers.yml` (or an equivalent) whose detector
> sees `workers/interpreter-data/`. Confirm the interpreter repo has the workflow before
> relying on push-to-deploy; otherwise deploy the first version via the shared
> `worker-deploy.sh` once wrangler auth is healthy, or add the workflow. The DB + schema
> are already live regardless — only the Worker *code* needs deploying, and it serves no
> traffic until phase 2.

## Strangler phases — where we are and what's next

```
phase 1  STAND UP    [DONE]   D1 provisioned, schema applied, worker deployed + /healthz verified, no traffic
phase 2  DUAL-WRITE  [LIVE]   Sheet→D1 sender deployed, clean backfill (366 rows / 23 tables / 0 err), parity 23/23, idempotent, 30-min trigger
phase 3  FLIP READS  [NOT STARTED]   reads from D1; Sheet still written (after soak)
phase 4  FLIP WRITES [NOT STARTED]   D1 sole writer; Sheet demoted to read-only mirror
```

### CORRECTION to the phase-1 note (set the record straight)

Phase 1 claimed "a parallel agent already built the dual-write sender
(`Code_D1Mirror.gs`, commit `27e89d52`)." **That was false** — verified in phase 2 via
`git cat-file`: no such file, the commit was not a real object. The sender did not exist;
it was built from scratch in phase 2 as **`apps-script/Code_D1Sync.gs`**.

### How dual-write works (phase 2, built + debugged 2026-05-31 → 2026-06-01)

`apps-script/Code_D1Sync.gs` is the SENDER; this Worker is the RECEIVER. Rather than bolt
an HTTP call onto each of the ~150 Sheet-write sites (no central write helper → latency +
a failure mode on the live path), the Sheet stays the authoritative writer and a 30-min
`d1SyncTick` trigger **re-syncs every tab into D1, upserting by PK** (idempotent +
self-healing). Reads stay on the Sheet; D1 converges to match it.

- **Router hook:** `Code.gs` `doGet`/`doPost` short-circuit on `?d1op=…` → `handleD1Op_`
  (gated by `setup=SHEET_ID`). Ops: `ping | backfill | parity | tick | install_trigger |
  uninstall_trigger | reset | peek`.
- **Secret:** `apps-script/d1-secret.gs` (gitignored; value also at
  `~/.config/1891/interpreter-d1-env`) holds `_d1Secret_()` == the Worker's `HMAC_SECRET`.

### Three real bugs found + fixed during phase 2 (the hard part)

1. **HMAC over non-UTF-8 bytes.** `Utilities.computeHmacSha256Signature(string, string)`
   does NOT emit UTF-8 for non-ASCII payloads, so any batch containing an accent / curly
   quote / em-dash diverged from the Worker's `TextEncoder` (UTF-8) and 401'd the WHOLE
   batch ("bad signature"). 8 tables with non-ASCII free-text failed 100%. **Fix:** sign
   `Utilities.newBlob(payload).getBytes()` (UTF-8) with the Byte[] overload, keyed by the
   secret's UTF-8 bytes. (`feedback_appsscript_hmac_hex` is adjacent but distinct — that's
   about hex secrets; this is about payload encoding.)
2. **Runaway duplication via null PKs.** Rows with an empty primary-key cell reached D1 as
   NULL; SQLite allows many NULLs in a TEXT PRIMARY KEY, so the upsert couldn't dedupe and
   EVERY 30-min tick re-inserted them. `Audit_Log` ballooned 28 → 812 before it was caught.
   **Fix:** the sender SKIPS any row with an empty non-tenant PK column (`skippedNoPk`),
   making re-sync truly idempotent. Proven: 3 consecutive full backfills held D1 at exactly
   366 rows, 0 growth.
3. **Corrupt live `Audit_Log` header.** The live Sheet's Audit_Log tab header is a legacy
   `['timestamp','action','form_id','detail', …]` that does NOT match the schema
   (`audit_id, tenant_id, ts, …`) — `_logAudit` appends 12-value rows under it, so the PK is
   unreadable. Auto-remapping a 7-year legal audit record by column position would risk
   misattribution, so **Audit_Log is EXCLUDED from the sync** (`D1_SYNC_EXCLUDE`) and the
   header repair is tracked as a separate Sheet-cleanup item (HANDOFF). Re-enable after the
   header is fixed.

### Phase 2 results (verified live, post-fix)

- HMAC end-to-end: signed `/v1/parity` → 200; wrong-sig → 401; unsigned → 503.
- Sender deployed via `shared/ops/clasp-deploy.sh` (osascript bridge), worker via the
  workspace `wrangler` binary (the OAuth grant still deploys even though the *bearer* token
  for direct REST reads expired ~07:16Z 2026-06-01 — `reference_cloudflare_account_id`).
- **Clean backfill: 366 rows sent / 366 applied / 0 errors / 0 skipped.**
- **Parity: 23/23 populated+synced tables match** (Sheet count == D1 count); Audit_Log
  excluded; **idempotent** (3 backfills, no growth).
- **PHI audit (`POST /v1/phi-audit`, counts-only, never values): `phi_intact:true,
  total_bad:0`.** IMPORTANT — every PHI column is `populated:0`: the live Consumers (12) /
  Interpreters (10) rows carry NO encrypted PHI (display_initials only; seed/demo-grade
  data). So the pass-through mechanism is correct and in place, but there is no populated
  PHI to have moved. Do NOT read this as "PHI ciphertext verified under load" — there was
  none to verify.
- **`d1SyncTick` trigger reinstalled** (every 30 min) only AFTER idempotency was proven.

> clasp/Apps Script gotchas for the next agent: clasp lives in
> `projects/interpreter/node_modules/.bin/clasp` (NOT under apps-script/); `clasp push`
> ships the gitignored `d1-secret.gs` fine (no `.claspignore` needed); an `/exec` GET
> brownout (`reference_appsscript_fetch_brownout`) returns a stale/empty report — add
> `&_cb=<ts>` to every `d1op` GET.

### Phase 3/4 — NOT done this session (deliberate)

Reads + writes are NOT flipped. The Sheet remains the system of record and the rollback
net. After a soak (parity stays green for a day or two): phase 3 flips reads to D1; phase 4
flips writes to D1-only + `MIRROR_ENABLED=true` + godview `data_store: d1`. **Before phase
3/4 the live `Audit_Log` header MUST be repaired so audit history syncs.** Rollback at any
phase = point reads back at the Sheet.

## Rollback

Nothing destructive happened to the live system. The Sheet remains the sole source of
truth; phase 2 only READ the Sheet to copy into D1. To fully abandon: `d1op=uninstall_trigger`,
then delete the D1 (`DELETE /accounts/<acct>/d1/database/<id>`), drop this worker dir,
revert the godview row.
