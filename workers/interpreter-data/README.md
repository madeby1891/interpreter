# interpreter-data

1891 Interpreter's **system of record on Cloudflare D1** (ADR-001). The highest-value
migration in the workspace: PHI + payment + scheduling + invoicing records move off a
Google Sheet onto D1. Strangler migration (the product is live) — see
[`MIGRATION.md`](./MIGRATION.md) for phases, provisioning, and the phase-2 enablement
checklist.

```
schema.sql                 full schema — 40 tables, 1:1 from apps-script Code.gs
migrations/0001_init.sql    same DDL, numbered (see MIGRATION.md caveat on applying)
wrangler.toml               D1 + KV(cache) + Queue bindings (real IDs, provisioned)
provision_rest.py           REST-API provisioner (wrangler-bypass; never prints token)
src/index.ts                HMAC-enveloped router (healthz / dual-write / parity)
src/db.ts                   typed, allowlisted, tenant-scoped writer + PHI redaction
src/mirror.ts               nightly D1->Sheets read-only mirror — INERT until phase 4
```

## Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | `{ ok, product, schema_version, tables }` — CI smoke target |
| `POST /v1/dual-write` | HMAC envelope | upsert/delete one row (strangler phase 2) |
| `POST /v1/dual-write/batch` | HMAC envelope | up to 500 rows (historical backfill) |
| `POST /v1/parity` | HMAC envelope | `{ count }` for a table — Sheet-vs-D1 parity |

All mutating routes use the body-signed HMAC envelope (SHA-256, base64) shared with
`DASHBOARD_CONTRACT.md` #13 and the Blast'D Mac contract — body-signed because the Apps
Script sender can't read request headers (`reference_apps_script_no_headers`).

## PHI

This Worker stores the opaque `v1:iv:ct` ciphertext blobs unchanged and **never decrypts
or logs** them. Encryption stays in the existing `1891-interpreter-api` Worker
(`PHI_MASTER_KEY` never moves). See MIGRATION.md "PHI".

## Status

Phase 1 (stand up, no traffic) complete + provisioned 2026-05-31. Phase 2 (dual-write) is
wired (`apps-script/Code_D1Mirror.gs`) but INERT. Do NOT flip reads/writes until the D1
side has soaked — the Sheet is the rollback safety net.
