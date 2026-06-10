/**
 * interpreter-data — 1891 Interpreter system of record on D1 (ADR-001).
 *
 * Highest-value / highest-liability migration: PHI + payment records move off a
 * Google Sheet onto D1. Strangler pattern (ADR §6) — this Worker stands up with
 * NO read traffic; Apps Script dual-writes every row here after its Sheet write,
 * and a parity check compares the two before any read/write flip.
 *
 *   GET  /healthz                 -> { ok, product, schema_version, tables }
 *   POST /v1/dual-write           -> HMAC envelope { tenant_id, table, op, row|pk }
 *   POST /v1/dual-write/batch     -> HMAC envelope { writes: [ {tenant_id,table,op,row} ] }
 *   POST /v1/parity               -> HMAC envelope { table, tenant_id? } -> { count }
 *   POST /v1/mirror/run           -> HMAC envelope { tables?, tenant_id? } — manual
 *        per-table mirror trigger for the phase-4 write-smoke (subset of the
 *        env-enabled set only; inert unless MIRROR_ENABLED + MIRROR_TABLES_ENABLED).
 * Scheduled (cron): nightly read-only mirror to a Sheet — INERT until MIRROR_ENABLED,
 *   and PER-TABLE via MIRROR_TABLES_ENABLED (phase 4 flips one table at a time, so
 *   only D1-write-primary tables may be mirrored; the rest stay Sheet-authoritative).
 *
 * Every mutating route requires the HMAC envelope (body-signed, base64 sig) —
 * the same shape as DASHBOARD_CONTRACT #13, the Blast'D Mac contract, and kgh-data.
 * Body-signing (not a header) keeps it compatible with the Apps Script rail, which
 * can't read request headers (reference_apps_script_no_headers).
 *
 * PHI: this Worker stores the opaque `v1:iv:ct` blobs unchanged. It never
 * decrypts and never logs PHI_BLOB_COLUMNS (see db.safeRowForLog).
 */
import {
  type Env, writeRow, deleteRow, countRows, logSys, getSchemaVersion,
  tableNames, safeRowForLog, TABLES,
} from './db';
import { runMirror } from './mirror';
import { signBody, verifyBody } from './hmac';

// Re-export so existing importers (tests, tooling) keep working after the
// HMAC helpers moved to hmac.ts (mirror.ts needs them without an import cycle).
export { signBody };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Envelope { payload?: string; sig?: string }
type Parsed<T> = { ok: true; data: T } | { ok: false; resp: Response };

/** Verify the HMAC envelope and JSON-parse the signed payload. */
async function openEnvelope<T>(req: Request, env: Env): Promise<Parsed<T>> {
  if (!env.HMAC_SECRET) return { ok: false, resp: json({ ok: false, error: 'server missing HMAC_SECRET' }, 503) };
  const body = (await req.json().catch(() => null)) as Envelope | null;
  if (!body?.payload || !body?.sig) return { ok: false, resp: json({ ok: false, error: 'bad envelope' }, 400) };
  if (!(await verifyBody(env.HMAC_SECRET, body.payload, body.sig))) {
    return { ok: false, resp: json({ ok: false, error: 'bad signature' }, 401) };
  }
  try { return { ok: true, data: JSON.parse(body.payload) as T }; }
  catch { return { ok: false, resp: json({ ok: false, error: 'bad payload json' }, 400) }; }
}

interface WriteMsg {
  tenant_id?: string;
  table?: string;
  op?: 'upsert' | 'delete';
  row?: Record<string, unknown>;
  pk?: Record<string, unknown>;
}

async function applyWrite(env: Env, m: WriteMsg): Promise<{ ok: boolean; table?: string; error?: string }> {
  const tenantId = String(m.tenant_id || env.DEFAULT_TENANT);
  const table = String(m.table || '');
  if (!TABLES[table]) return { ok: false, error: `unknown table: ${table}` };
  if (m.op === 'delete') {
    if (!m.pk) return { ok: false, error: 'pk required for delete' };
    await deleteRow(env, tenantId, table, m.pk);
    return { ok: true, table };
  }
  if (!m.row || typeof m.row !== 'object') return { ok: false, error: 'row required' };
  await writeRow(env, tenantId, table, m.row);
  return { ok: true, table };
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/healthz') {
    const v = await getSchemaVersion(env);
    return json({ ok: true, product: env.PRODUCT, schema_version: v, tables: tableNames().length });
  }

  if (path === '/v1/dual-write' && request.method === 'POST') {
    const env2 = await openEnvelope<WriteMsg>(request, env);
    if (!env2.ok) return env2.resp;
    try {
      const r = await applyWrite(env, env2.data);
      if (!r.ok) return json({ ok: false, error: r.error }, 400);
      return json({ ok: true, table: r.table });
    } catch (err) {
      // Never echo the row back — it may carry PHI ciphertext.
      console.error('[interpreter-data] dual-write failed', env2.data.table, String(err));
      return json({ ok: false, error: 'write failed' }, 500);
    }
  }

  if (path === '/v1/dual-write/batch' && request.method === 'POST') {
    const env2 = await openEnvelope<{ writes?: WriteMsg[] }>(request, env);
    if (!env2.ok) return env2.resp;
    const writes = Array.isArray(env2.data.writes) ? env2.data.writes : [];
    if (writes.length === 0) return json({ ok: false, error: 'writes[] required' }, 400);
    if (writes.length > 500) return json({ ok: false, error: 'max 500 writes per batch' }, 400);
    let applied = 0;
    const errors: Array<{ i: number; table?: string; error: string }> = [];
    for (let i = 0; i < writes.length; i++) {
      try {
        const r = await applyWrite(env, writes[i]);
        if (r.ok) applied++; else errors.push({ i, table: writes[i].table, error: r.error || 'failed' });
      } catch (err) {
        errors.push({ i, table: writes[i].table, error: String(err).slice(0, 120) });
      }
    }
    return json({ ok: errors.length === 0, applied, total: writes.length, errors });
  }

  if (path === '/v1/parity' && request.method === 'POST') {
    const env2 = await openEnvelope<{ table?: string; tenant_id?: string }>(request, env);
    if (!env2.ok) return env2.resp;
    const table = String(env2.data.table || '');
    if (!TABLES[table]) return json({ ok: false, error: `unknown table: ${table}` }, 400);
    const count = await countRows(env, table, env2.data.tenant_id);
    return json({ ok: true, table, tenant_id: env2.data.tenant_id ?? null, count });
  }

  // Read rows back (HMAC-gated). The phase-3 read surface + the freshness probe.
  // Tenant-scoped; optional single-column equality filter; PHI columns ALWAYS
  // redacted to '[redacted-phi]' (never returns ciphertext or plaintext); capped.
  if (path === '/v1/read' && request.method === 'POST') {
    const env2 = await openEnvelope<{ table?: string; tenant_id?: string; where_col?: string; where_val?: string; limit?: number; raw?: boolean }>(request, env);
    if (!env2.ok) return env2.resp;
    const table = String(env2.data.table || '');
    const def = TABLES[table];
    if (!def) return json({ ok: false, error: `unknown table: ${table}` }, 400);
    const cols = def.columns;
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const where: string[] = [];
    const binds: unknown[] = [];
    if (def.columns.includes('tenant_id') && env2.data.tenant_id) {
      // Include global/shared rows (tenant_id = '*', e.g. seeded Roles) so a tenant's
      // read returns its own rows PLUS the globals it inherits — matching what the
      // per-tenant Sheet tab contains.
      where.push(`(${q('tenant_id')} = ? OR ${q('tenant_id')} = '*')`); binds.push(String(env2.data.tenant_id));
    }
    if (env2.data.where_col) {
      if (!cols.includes(env2.data.where_col)) return json({ ok: false, error: `unknown column: ${env2.data.where_col}` }, 400);
      where.push(`${q(env2.data.where_col)} = ?`); binds.push(String(env2.data.where_val ?? ''));
    }
    // raw=true → faithful rows for the full-trust HMAC server caller (the read-flip:
    // Apps Script reads its own system of record back, so it needs real ciphertext in
    // PHI columns to decrypt, and empty PHI columns as '' not '[redacted-phi]', and real
    // config values). HMAC is the trust boundary — the same secret that WRITES every row.
    // Default (raw falsy) keeps the PHI- + secret-redacted projection for any debug use.
    // raw allows a higher row cap so a read can pull a whole (small, multi-tenant) table.
    const raw = env2.data.raw === true;
    const lim = Math.min(Math.max(Number(env2.data.limit ?? 50), 1), raw ? 10000 : 500);
    const sql = `SELECT ${cols.map(q).join(', ')} FROM ${q(table)}`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ` LIMIT ${lim}`;
    const { results } = await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();
    const rows = (results ?? []).map((r) => (raw ? r : safeRowForLog(table, r)));
    return json({ ok: true, table, count: rows.length, rows });
  }

  // Debug echo of how a row WOULD be stored, with PHI redacted. HMAC-gated.
  if (path === '/v1/echo' && request.method === 'POST') {
    const env2 = await openEnvelope<WriteMsg>(request, env);
    if (!env2.ok) return env2.resp;
    const table = String(env2.data.table || '');
    return json({ ok: true, table, row: safeRowForLog(table, env2.data.row || {}) });
  }

  // Admin: truncate a synced table (HMAC-gated). Used to reset for a clean
  // re-backfill during the strangler phase 2. ONLY clears D1 tables — the Sheet
  // (the system of record) is never touched. Safe because D1 has no traffic yet.
  if (path === '/v1/admin/truncate' && request.method === 'POST') {
    const env2 = await openEnvelope<{ table?: string; all?: boolean }>(request, env);
    if (!env2.ok) return env2.resp;
    const wanted = env2.data.all ? Object.keys(TABLES) : [String(env2.data.table || '')];
    const cleared: Record<string, number> = {};
    for (const t of wanted) {
      if (!TABLES[t]) return json({ ok: false, error: `unknown table: ${t}` }, 400);
      const before = await countRows(env, t);
      await env.DB.prepare(`DELETE FROM "${t.replace(/"/g, '""')}"`).run();
      cleared[t] = before;
    }
    return json({ ok: true, cleared });
  }

  // Manual mirror trigger (HMAC-gated) — the phase-4 write-smoke companion.
  // After converting a table's writes to D1, run this to materialize the D1
  // rows into the (now read-only) Sheet tab immediately instead of waiting for
  // the nightly cron. `tables`/`tenant_id` only NARROW the env-enabled set —
  // a table absent from MIRROR_TABLES_ENABLED can never be mirrored from here.
  // Also the documented FIRST STEP of a per-table rollback: mirror once so the
  // Sheet tab is current, then flip the table's write flag back to Sheet.
  if (path === '/v1/mirror/run' && request.method === 'POST') {
    const env2 = await openEnvelope<{ tables?: string[]; tenant_id?: string }>(request, env);
    if (!env2.ok) return env2.resp;
    const tables = Array.isArray(env2.data.tables) ? env2.data.tables.map(String) : undefined;
    const report = await runMirror(env, tables, env2.data.tenant_id ? String(env2.data.tenant_id) : undefined);
    return json({ ok: true, mirror: report });
  }

  // PHI invariant audit (HMAC-gated). Returns COUNTS ONLY — never any cell value.
  // Verifies every stored PHI column is the opaque `v1:…` ciphertext format and
  // never plaintext. `bad_*` must be 0. This is how we prove the encryption
  // boundary didn't move without ever reading a PHI value out of D1.
  if (path === '/v1/phi-audit' && request.method === 'POST') {
    const env2 = await openEnvelope<Record<string, never>>(request, env);
    if (!env2.ok) return env2.resp;
    const phiCols: Array<[string, string]> = [
      ['Consumers', 'legal_first_encrypted'], ['Consumers', 'legal_last_encrypted'],
      ['Consumers', 'dob_encrypted'], ['Consumers', 'mrn_encrypted'], ['Consumers', 'notes_sealed'],
      ['Interpreters', 'payment_details_encrypted'],
    ];
    const report: Record<string, { populated: number; bad_not_ciphertext: number }> = {};
    let totalBad = 0;
    for (const [tbl, col] of phiCols) {
      const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
      const populated = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ${q(tbl)} WHERE ${q(col)} IS NOT NULL AND ${q(col)} != ''`,
      ).first<{ n: number }>();
      const bad = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ${q(tbl)} WHERE ${q(col)} IS NOT NULL AND ${q(col)} != '' AND ${q(col)} NOT LIKE 'v1:%'`,
      ).first<{ n: number }>();
      report[`${tbl}.${col}`] = { populated: populated?.n ?? 0, bad_not_ciphertext: bad?.n ?? 0 };
      totalBad += bad?.n ?? 0;
    }
    return json({ ok: true, phi_intact: totalBad === 0, total_bad: totalBad, report });
  }

  // Key-set parity (HMAC-gated). The sender posts the exact set of primary keys it
  // found in the Sheet for one table; we compare against D1's PK set. This upgrades
  // "row counts match" to "the SAME record set" — the real precondition for flipping
  // reads. PKs are opaque IDs (no normalization ambiguity) so any diff is real.
  // Composite-PK tables join cols with US (). Sample lists are capped + the
  // sensitive tables (PHI + Auth_Tokens) report counts only, never key values.
  if (path === '/v1/keyset' && request.method === 'POST') {
    const env2 = await openEnvelope<{ table?: string; pkCols?: string[]; keys?: string[] }>(request, env);
    if (!env2.ok) return env2.resp;
    const table = String(env2.data.table || '');
    if (!TABLES[table]) return json({ ok: false, error: `unknown table: ${table}` }, 400);
    const pkCols = Array.isArray(env2.data.pkCols) && env2.data.pkCols.length
      ? env2.data.pkCols : TABLES[table].pk;
    if (!pkCols) return json({ ok: false, error: `${table} has no PK (append-only)` }, 400);
    const sent = new Set((env2.data.keys || []).map(String));
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const { results } = await env.DB.prepare(
      `SELECT ${pkCols.map(q).join(', ')} FROM ${q(table)}`,
    ).all<Record<string, unknown>>();
    const d1 = new Set<string>();
    for (const r of results ?? []) d1.add(pkCols.map((c) => String(r[c] ?? '')).join('|'));
    const missingInD1: string[] = [];   // in Sheet, absent from D1
    const orphanInD1: string[] = [];    // in D1, absent from Sheet
    for (const k of sent) if (!d1.has(k)) missingInD1.push(k);
    for (const k of d1) if (!sent.has(k)) orphanInD1.push(k);
    const sensitive = table === 'Consumers' || table === 'Interpreters' || table === 'Auth_Tokens';
    return json({
      ok: true, table, pkCols,
      sheet_keys: sent.size, d1_keys: d1.size,
      missing_in_d1: missingInD1.length, orphan_in_d1: orphanInD1.length,
      match: missingInD1.length === 0 && orphanInD1.length === 0,
      ...(sensitive ? {} : {
        missing_sample: missingInD1.slice(0, 20),
        orphan_sample: orphanInD1.slice(0, 20),
      }),
    });
  }

  return json({ ok: false, error: 'not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await route(request, env); }
    catch (err) { console.error('[interpreter-data] unhandled', String(err)); return json({ ok: false, error: 'internal' }, 500); }
  },
  async scheduled(_e: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Mirror is INERT during dual-write (ADR §5/§6) — runMirror self-guards on
    // MIRROR_ENABLED + the per-table MIRROR_TABLES_ENABLED allowlist, so the
    // cron can stay wired without risking any Sheet-authoritative tab.
    ctx.waitUntil((async () => {
      if (String(env.MIRROR_ENABLED || '').toLowerCase() !== 'true') {
        await logSys(env, 'mirror.skipped', { payload: { reason: 'MIRROR_ENABLED!=true (dual-write phase)' } });
        return;
      }
      await runMirror(env);
    })());
  },
  async queue(batch: MessageBatch, _env: Env): Promise<void> {
    for (const msg of batch.messages) { try { msg.ack(); } catch { msg.retry(); } }
  },
};
