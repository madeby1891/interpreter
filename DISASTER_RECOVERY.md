# DISASTER_RECOVERY — 1891 Interpreter

What to do when something breaks. Update with every new failure mode the team learns the hard way.

---

## What lives where (the data map)

| Class | Primary | Backup | Recovery posture |
|---|---|---|---|
| Per-agency rows | Per-agency Google Sheet | Nightly export to R2 (encrypted, 35-day retention) | Restore Sheet from Drive version history (90-day default) or rebuild from R2 export |
| Control plane | `1891-interpreter-control` Sheet | Same nightly export | Same |
| Blobs (PDFs, translated docs, recordings) | R2 bucket `1891-interpreter` | R2 object versioning enabled | Restore from version history |
| Hot operational state (DO) | Durable Objects | None (rebuilt from Sheet+R2) | Acceptable — DO data is derived |
| KV cache | KV | None (rebuilt from Sheet) | Acceptable — pure read cache |
| Apps Script code | Bound to each Sheet | Mirror in `apps-script/` in repo, deployed via `clasp` | `clasp push` to redeploy |
| Worker code | Cloudflare | Mirror in `workers/` in repo | `wrangler deploy` |
| Static site | GoDaddy cPanel | Mirror in `site/` in repo, `deploy.sh` | `bash deploy.sh` |
| Secrets | `*-secret.js` (gitignored) on Anthony's laptop + Cloudflare Secrets Store | Encrypted offline backup quarterly | Re-mint from provider; rotate on incident |

---

## Failure mode runbooks

### A. Apps Script returns 500 / times out / rate-limits

- **Symptom:** `workers/sync` reports `apps_script_failed` in logs; Sheet writes back up; scheduler dashboard stops getting state updates.
- **First check:** Apps Script execution dashboard (Anthony does the click flow). Look for `LockService` timeouts or quota errors.
- **Immediate mitigation:** the Sheet itself remains the SOT; manually edit if business-critical (e.g., add a job row). The Worker will re-sync on next successful Apps Script call.
- **Rollback:** if a recent deploy introduced a regression, revert via `clasp push` of the previous tag.
- **Quota:** Apps Script has daily quotas (URL Fetch calls, execution time). For paid Workspace accounts the cap is high but not infinite. Long-term mitigation: shift more cold reads to KV.

### B. Sheet corrupted / deleted by mistake

- **Drive version history** — restore by right-click → "Manage versions" or "Version history" → pick a version pre-corruption. 90-day default.
- **Nightly R2 export.** Apps Script writes a snapshot to `r2://1891-interpreter/{tenant_id}/backups/{date}.xlsx` nightly. Restore by uploading the XLSX as a new Sheet and re-pointing `control_sheet.Tenants.sheet_id`.
- **Audit log integrity.** If `Audit_Log` is restored, verify the integrity-hash chain via `apps-script/lib/audit_verify.gs`; any break is logged but not auto-repaired.

### C. Cloudflare Workers down

- **Symptom:** all app surfaces 502/503; status page red.
- **Mitigation:** the Apps Script + Sheet remain operational. A static "Cloudflare is having issues" banner lives at `site/_outage.html` and the marketing site's homepage shows it via JS check against `status.1891interpreter.app`.
- **Read-only fallback** — Apps Script can serve `/v1/jobs` and `/v1/me` directly via a backup web-app deployment; the static shell tries `*.1891interpreter.app` first, falls through to `script.google.com/macros/s/.../exec` on 502. Slower but functional.
- **Hot state recovery.** After Cloudflare returns, DO state rebuilds from Sheet on first read; no manual action.

### D. R2 bucket inaccessible

- **Symptom:** PDF downloads fail; document translation pipeline stalls; recordings unreachable.
- **Mitigation:** Sheet-side metadata (`Documents` tab) intact; UI shows "file temporarily unavailable" and retries every 60s.
- **Recovery:** R2 has high availability; transient errors usually clear within minutes. For persistent outage, expose the daily R2 → S3 backup mirror (stretch goal — not yet built).

### E. Stripe webhooks miss events

- **Symptom:** Invoice marked "issued" stays "issued" after the payer pays.
- **Mitigation:** nightly reconciliation job (`workers/sync/reconcile.ts`) pulls Stripe events for the last 48h and replays unprocessed webhooks.
- **Manual fix:** admin can "Mark paid" with the Stripe charge id; audit-logged with reason.

### F. Postmark / Twilio degraded

- **Symptom:** notifications queue grows; users complain.
- **Mitigation:** `workers/notify` queue retains messages with exponential backoff for 72h. Surface a banner in the agency dashboard if backlog > 50.
- **Fallback channel:** for any user, if primary channel (push/SMS) fails 3 times, the next attempt goes to email. Configured in PRD D3.1 channel matrix.

### G. Anthropic API outage / rate-limited

- **Symptom:** NL intake stops working; AI brief generator returns errors.
- **Mitigation:** every AI feature has a documented manual fallback (PRD D1). NL intake falls back to the structured "New Request" form. Brief generator falls back to a template the scheduler fills.
- **Banner:** agency dashboard shows "AI features temporarily unavailable" with the affected feature list.

### H. Secret leak / suspected compromise

- **Immediate:** rotate the affected secret in Cloudflare Secrets Store and any Apps Script script-properties.
- **Audit:** review the last 30 days of `Audit_Log` for the affected actor or resource; export evidence to R2 cold storage.
- **Notify:** if PHI was potentially exposed, follow HIPAA breach notification process — 60 days to notify affected individuals, 60 days to notify HHS (under 500) or immediately (over 500). Document in `docs/INCIDENTS/`.
- **SSH key rotation:** if `~/.ssh/ftd_godaddy_deploy` is compromised, run `~/Desktop/1891/shared/ops/secrets-rotation.md` rotation playbook.

### I. Two-party-consent recording captured without consent

- **Immediate:** delete the recording from R2 and any transcript derivatives.
- **Notify:** all participants in writing. Document in `docs/INCIDENTS/`.
- **Root cause:** review the consent-capture UI path; this should be technically impossible by design (the Worker refuses to start a recording without consent rows). If it happened, file a P0 bug.

### J. Cross-tenant data leak (the nightmare scenario)

- **Immediate:** disable the affected Worker route; halt writes; preserve evidence.
- **Investigate:** which JWT was active? What `tenant_id` claim? Did a `tenant_id` check fail? Pull `Audit_Log` rows across all tenants for the actor's IP in the last 24h.
- **Notify:** all affected tenants immediately; HHS if PHI involved; press release if material.
- **Postmortem:** within 7 days, blameless postmortem in `docs/INCIDENTS/` with timeline, root cause, fix, prevention.

---

## Quarterly drills

- **Q1:** restore a tenant's Sheet from R2 backup end-to-end (test tenant only).
- **Q2:** failover from Worker to Apps Script direct-serve, verify scheduler can still operate.
- **Q3:** secret rotation drill (rotate one non-critical secret, verify every consumer continues to work).
- **Q4:** cross-tenant access attempt (red-team a JWT with the wrong `tenant_id`, verify rejection at every layer).

Drill results go in `docs/INCIDENTS/drills/`. A skipped drill is itself an incident worth reviewing.
