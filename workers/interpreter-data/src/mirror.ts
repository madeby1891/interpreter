/**
 * interpreter-data — nightly read-only D1 -> Sheets mirror (ADR §5).
 *
 * Preserves the "operator opens the Sheet and eyeballs rows" affordance after
 * cutover. D1 is the source of truth; the Sheet is a disposable, read-only view.
 *
 * CRITICAL SAFETY: this is INERT until env.MIRROR_ENABLED === "true", which is
 * set ONLY at strangler phase 4 (the Sheet has been demoted from source of
 * truth). During dual-write (phase 2) and read-flip (phase 3) the live Sheet is
 * STILL authoritative, so mirroring into it would clobber operator edits. The
 * caller (index.ts scheduled) already guards on MIRROR_ENABLED; this function
 * re-checks as a belt-and-suspenders.
 *
 * The mirror NEVER exports PHI plaintext. PHI columns are opaque ciphertext in
 * D1; the mirror replaces them with the marker "[encrypted]" so the Sheet view
 * carries no ciphertext either. It never decrypts.
 */
import { type Env, TABLES, PHI_BLOB_COLUMNS, logSys } from './db';

/** Tables exported to the human-readable mirror. Auth/token/log tables are
 *  intentionally excluded — operators don't eyeball those, and they churn. */
const MIRROR_TABLES: string[] = [
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

export async function runMirror(env: Env): Promise<void> {
  if (String(env.MIRROR_ENABLED || '').toLowerCase() !== 'true') {
    await logSys(env, 'mirror.inert', { payload: { reason: 'MIRROR_ENABLED!=true' } });
    return;
  }
  if (!env.MIRROR_SHEET_EXEC) {
    await logSys(env, 'mirror.skipped', { payload: { reason: 'MIRROR_SHEET_EXEC unset' } });
    return;
  }

  // Export one tenant at a time so each per-agency Sheet gets only its own rows.
  const tenants = await env.DB.prepare(`SELECT tenant_id, spreadsheet_id FROM Tenants WHERE status = 'active'`)
    .all<{ tenant_id: string; spreadsheet_id: string | null }>();

  for (const t of tenants.results ?? []) {
    const snapshot: Record<string, unknown[][]> = {};
    for (const table of MIRROR_TABLES) {
      const def = TABLES[table];
      if (!def) continue;
      const cols = def.columns;
      let sql = `SELECT ${cols.map(q).join(', ')} FROM ${q(table)}`;
      const binds: unknown[] = [];
      if (cols.includes('tenant_id')) { sql += ` WHERE ${q('tenant_id')} = ?`; binds.push(t.tenant_id); }
      const { results } = await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();
      // Header row + data rows. PHI ciphertext columns are masked — never decrypted.
      const rows: unknown[][] = [cols.slice()];
      for (const r of results ?? []) {
        rows.push(cols.map((c) => (PHI_BLOB_COLUMNS.has(`${table}.${c}`) ? (r[c] ? '[encrypted]' : '') : r[c] ?? '')));
      }
      snapshot[table] = rows;
    }

    // POST the snapshot to the tenant's Apps Script mirror endpoint, which
    // replaces each tab's contents. The Apps Script side is the only writer to
    // the Sheet; this Worker never touches the Sheet directly.
    try {
      const resp = await fetch(env.MIRROR_SHEET_EXEC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenant_id: t.tenant_id, spreadsheet_id: t.spreadsheet_id, tabs: snapshot }),
      });
      await logSys(env, 'mirror.tenant', { tenantId: t.tenant_id, payload: { status: resp.status, tabs: MIRROR_TABLES.length } });
    } catch (err) {
      await logSys(env, 'mirror.tenant.failed', { tenantId: t.tenant_id, payload: { error: String(err).slice(0, 160) } });
    }
  }
}
