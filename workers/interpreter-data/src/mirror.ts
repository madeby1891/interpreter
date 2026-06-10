/**
 * interpreter-data — read-only D1 -> Sheets mirror (ADR §5), PER-TABLE.
 *
 * Preserves the "admin opens the Sheet and eyeballs rows" affordance after
 * cutover. D1 is the source of truth; the Sheet is a disposable, read-only view.
 *
 * CRITICAL SAFETY — two gates, both required, because phase 4 is PER-TABLE
 * (ADR §6: writes flip one domain at a time, all-or-nothing per table):
 *
 *   1. env.MIRROR_ENABLED === "true"   — master switch, off until phase 4 begins.
 *   2. env.MIRROR_TABLES_ENABLED       — comma-separated allowlist of tables whose
 *      writes have ALREADY flipped to D1 (e.g. "Settings,Rate_Cards"), or "all"
 *      once every table has. ONLY those tables are mirrored.
 *
 * Why per-table: during the incremental write-cutover, tables NOT yet converted
 * are still Sheet-authoritative — mirroring D1 over them would clobber live
 * admin edits with the (converged-but-lagging) D1 copy. A table may appear in
 * MIRROR_TABLES_ENABLED only AFTER its writes go D1-direct and its Sheet->D1
 * sync is frozen on the Apps Script side (D1_WRITE_TABLES — see
 * apps-script/Code_D1Store.gs). The Apps Script receiver (?d1op=mirror_apply)
 * enforces the same rule from its own flag as defense in depth: BOTH sides must
 * agree a table is D1-write-primary before its tab is overwritten.
 *
 * The mirror POST is HMAC-SIGNED with the shared secret (same body-signed
 * envelope as every inbound route) so the Apps Script receiver can verify the
 * snapshot really came from this Worker before overwriting any tab.
 *
 * The mirror NEVER exports PHI plaintext OR ciphertext. PHI columns are opaque
 * ciphertext in D1; the mirror replaces them with the marker "[encrypted]" so
 * the Sheet view carries neither. It never decrypts.
 */
import { type Env, TABLES, PHI_BLOB_COLUMNS, logSys } from './db';
import { signBody } from './hmac';

/** Tables eligible for the human-readable mirror. Auth/token/log tables are
 *  intentionally excluded — admins don't eyeball those, and they churn. */
export const MIRROR_TABLES: string[] = [
  'Agencies', 'Users', 'Roles', 'Interpreters', 'Interpreter_Documents',
  'Tenant_Requirements', 'Rate_Modifiers', 'Rate_Cards', 'Notification_Prefs',
  'Assignment_Notes', 'Languages', 'Certifications', 'Requestors',
  'Requestor_Contacts', 'Clients', 'Client_Contacts', 'Specialists',
  'Client_Billing_Rules', 'Job_Expenses', 'Client_Documents', 'Payers',
  'Consumers', 'Locations', 'Jobs', 'Job_Assignments', 'Job_Events',
  'Communications', 'Invoices', 'Invoice_Lines', 'Payouts', 'Documents',
  'Settings', 'Audit_Log',
];

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

/** The per-table allowlist resolved from env. Empty array = mirror nothing. */
export function enabledMirrorTables(env: Env): string[] {
  const raw = String(env.MIRROR_TABLES_ENABLED || '').trim();
  if (!raw) return [];
  if (raw.toLowerCase() === 'all') return MIRROR_TABLES.slice();
  const wanted = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return MIRROR_TABLES.filter((t) => wanted.has(t));
}

export interface MirrorReport {
  ran: boolean;
  reason?: string;
  tables?: string[];
  tenants?: Array<{ tenant_id: string; status: number | string; tabs: number; rows: number }>;
}

/**
 * Run the mirror. `onlyTables` (from /v1/mirror/run) further NARROWS the
 * env-enabled set — it can never widen it. `onlyTenant` narrows the tenant
 * loop (used by the post-conversion write-smoke so one table/tenant can be
 * mirrored immediately instead of waiting for the nightly cron).
 */
export async function runMirror(env: Env, onlyTables?: string[], onlyTenant?: string): Promise<MirrorReport> {
  if (String(env.MIRROR_ENABLED || '').toLowerCase() !== 'true') {
    await logSys(env, 'mirror.inert', { payload: { reason: 'MIRROR_ENABLED!=true' } });
    return { ran: false, reason: 'MIRROR_ENABLED!=true' };
  }
  if (!env.MIRROR_SHEET_EXEC) {
    await logSys(env, 'mirror.skipped', { payload: { reason: 'MIRROR_SHEET_EXEC unset' } });
    return { ran: false, reason: 'MIRROR_SHEET_EXEC unset' };
  }
  let tables = enabledMirrorTables(env);
  if (onlyTables && onlyTables.length) {
    const narrow = new Set(onlyTables.map(String));
    tables = tables.filter((t) => narrow.has(t));
  }
  if (tables.length === 0) {
    await logSys(env, 'mirror.skipped', { payload: { reason: 'no tables enabled (MIRROR_TABLES_ENABLED)' } });
    return { ran: false, reason: 'no tables enabled (MIRROR_TABLES_ENABLED)' };
  }
  if (!env.HMAC_SECRET) {
    await logSys(env, 'mirror.skipped', { payload: { reason: 'HMAC_SECRET unset (cannot sign)' } });
    return { ran: false, reason: 'HMAC_SECRET unset (cannot sign)' };
  }

  // Export one tenant at a time so each per-agency Sheet gets only its own rows.
  const tenants = await env.DB.prepare(`SELECT tenant_id, spreadsheet_id FROM Tenants WHERE status = 'active'`)
    .all<{ tenant_id: string; spreadsheet_id: string | null }>();
  const report: MirrorReport = { ran: true, tables, tenants: [] };

  for (const t of tenants.results ?? []) {
    if (onlyTenant && t.tenant_id !== onlyTenant) continue;
    const snapshot: Record<string, unknown[][]> = {};
    let rowCount = 0;
    for (const table of tables) {
      const def = TABLES[table];
      if (!def) continue;
      const cols = def.columns;
      let sql = `SELECT ${cols.map(q).join(', ')} FROM ${q(table)}`;
      const binds: unknown[] = [];
      if (cols.includes('tenant_id')) {
        // Tenant's own rows PLUS the globals it inherits ('*', e.g. seeded Roles) —
        // matching what the per-tenant Sheet tab contains (same rule as /v1/read).
        sql += ` WHERE (${q('tenant_id')} = ? OR ${q('tenant_id')} = '*')`;
        binds.push(t.tenant_id);
      }
      const { results } = await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();
      // Header row + data rows. PHI ciphertext columns are masked — never decrypted,
      // never exported (the Sheet view carries neither plaintext nor ciphertext).
      const rows: unknown[][] = [cols.slice()];
      for (const r of results ?? []) {
        rows.push(cols.map((c) => (PHI_BLOB_COLUMNS.has(`${table}.${c}`) ? (r[c] ? '[encrypted]' : '') : r[c] ?? '')));
      }
      snapshot[table] = rows;
      rowCount += rows.length - 1;
    }

    // POST the SIGNED snapshot to the Apps Script mirror receiver
    // (?d1op=mirror_apply), which verifies the HMAC and replaces each tab's
    // contents — but only for tabs ITS OWN flag also marks D1-write-primary.
    // The Apps Script side is the only writer to the Sheet; this Worker never
    // touches the Sheet directly.
    try {
      const payload = JSON.stringify({
        kind: 'd1_mirror', ts: Math.floor(Date.now() / 1000),
        tenant_id: t.tenant_id, spreadsheet_id: t.spreadsheet_id, tabs: snapshot,
      });
      const sig = await signBody(env.HMAC_SECRET, payload);
      const resp = await fetch(env.MIRROR_SHEET_EXEC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload, sig }),
      });
      report.tenants!.push({ tenant_id: t.tenant_id, status: resp.status, tabs: tables.length, rows: rowCount });
      await logSys(env, 'mirror.tenant', { tenantId: t.tenant_id, payload: { status: resp.status, tabs: tables.length, rows: rowCount } });
    } catch (err) {
      report.tenants!.push({ tenant_id: t.tenant_id, status: 'fetch-failed', tabs: tables.length, rows: rowCount });
      await logSys(env, 'mirror.tenant.failed', { tenantId: t.tenant_id, payload: { error: String(err).slice(0, 160) } });
    }
  }
  return report;
}
