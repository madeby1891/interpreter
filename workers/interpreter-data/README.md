# interpreter-data

1891 Interpreter's **system of record on Cloudflare D1** (ADR-001). The highest-value
migration in the workspace: PHI + payment + scheduling + invoicing records move off a
Google Sheet onto D1. Strangler migration (the product is live) — see
[`MIGRATION.md`](./MIGRATION.md) for phases, provisioning, verification records, and
the phase-4 per-table runbook.

```
schema.sql                 full schema — 40 tables, 1:1 from apps-script Code.gs
migrations/0001_init.sql    same DDL, numbered (see MIGRATION.md caveat on applying)
wrangler.toml               D1 + KV(cache) + Queue bindings (real IDs, provisioned)
provision_rest.py           REST-API provisioner (wrangler-bypass; never prints token)
src/index.ts                HMAC-enveloped router
src/db.ts                   typed, allowlisted, tenant-scoped writer + PHI redaction
src/hmac.ts                 body-signed HMAC envelope primitives (sign/verify)
src/mirror.ts               D1->Sheets read-only mirror — per-table, INERT until phase 4
test/ + vitest.config.ts    workerd + real local D1 test harness (npm test, 19 tests)
```

## Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | `{ ok, product, schema_version, tables: 39 }` — CI smoke target |
| `POST /v1/dual-write` | HMAC envelope | upsert/delete one row (strangler phase 2+) |
| `POST /v1/dual-write/batch` | HMAC envelope | up to 500 rows (backfill / nudge flush) |
| `POST /v1/parity` | HMAC envelope | `{ count }` for a table — Sheet-vs-D1 parity |
| `POST /v1/read` | HMAC envelope | tenant-scoped read (+ inherited `tenant_id='*'` rows); PHI/secret-redacted unless `raw` |
| `POST /v1/keyset` | HMAC envelope | exact PK-set diff vs the Sheet (`missing_in_d1`/`orphan_in_d1`) |
| `POST /v1/phi-audit` | HMAC envelope | counts-only proof every stored PHI cell is `v1:…` ciphertext |
| `POST /v1/echo` | HMAC envelope | envelope round-trip check |
| `POST /v1/admin/truncate` | HMAC envelope | guarded table reset (backfill repair) |
| `POST /v1/mirror/run` | HMAC envelope | phase-4 manual mirror trigger — narrows, never widens, the env allowlist |

All mutating routes use the body-signed HMAC envelope (SHA-256, base64) shared with
`DASHBOARD_CONTRACT.md` #13 and the Blast'D Mac contract — body-signed because the Apps
Script sender can't read request headers (`reference_apps_script_no_headers`).

## PHI

This Worker stores the opaque `v1:iv:ct` ciphertext blobs unchanged and **never decrypts
or logs** them. Encryption stays in the existing `1891-interpreter-api` Worker
(`PHI_MASTER_KEY` never moves). Default reads redact PHI columns; the D1→Sheet mirror
masks them to `[encrypted]` (neither plaintext nor ciphertext leaves). See MIGRATION.md
"PHI".

## Status

- **Phase 1 (stand up)** done + provisioned 2026-05-31.
- **Phase 2 (dual-write Sheet→D1)** LIVE — `apps-script/Code_D1Sync.gs` sender:
  30-min `d1SyncTick` + fresh-on-write nudge; parity + keyset verified.
- **Phase 3 (flip reads)** DONE, verified live 2026-06-06 — D1 is the read system of
  record (`Code_D1Store.gs` `_dbValues_`, `D1_PRIMARY=true`). The Sheet is now only the
  write-staging surface.
- **Phase 4 (D1 sole writer)** rails staged, conversion NOT started: per-table D1→Sheet
  mirror (`MIRROR_ENABLED` + `MIRROR_TABLES_ENABLED`, both unset = inert), signed
  snapshot → Apps Script receiver (`Code_D1MirrorApply.gs`, `?d1op=mirror_apply`),
  per-table sender cutoff (`D1_WRITE_TABLES`). Runbook: MIGRATION.md "Phase 4 runbook".

## Tests

`npm test` — vitest-pool-workers: the real router/HMAC/write/mirror code runs inside
workerd against a real local D1 with `migrations/0001_init.sql` applied; the only mock
is the outbound Apps Script POST (net-connect disabled). Fixtures are 100% synthetic
(RFC 2606 domains, fake `v1:` blobs — never real PII/PHI).

## Deploy

`git push` to `main` IS the deploy: [`.github/workflows/deploy-workers.yml`](../../.github/workflows/deploy-workers.yml)
redeploys every changed `workers/<name>/` and smokes `/healthz`. **Deploy only** —
CI never runs `wrangler d1 migrations apply` (the schema was applied out-of-band via
REST; re-applying `0001` would duplicate the `schema_version` row — see
[`MIGRATION.md`](./MIGRATION.md)). Hot-fix from a laptop: `npx wrangler deploy` from
this dir. Clean redeploy with no commit: Actions → deploy-workers → Run workflow →
`worker: interpreter-data`.
