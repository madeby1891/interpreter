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
 * Scheduled (cron): nightly read-only mirror to a Sheet — INERT until MIRROR_ENABLED
 *   (only after cutover, ADR §5). Never clobbers the live source Sheet during dual-write.
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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---- HMAC envelope (SHA-256, base64), body-signed --------------------------
async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}
export async function signBody(secret: string, body: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}
async function verifyBody(secret: string, body: string, sig: string): Promise<boolean> {
  try {
    const expected = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), expected, new TextEncoder().encode(body));
  } catch { return false; }
}

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

  // Debug echo of how a row WOULD be stored, with PHI redacted. HMAC-gated.
  if (path === '/v1/echo' && request.method === 'POST') {
    const env2 = await openEnvelope<WriteMsg>(request, env);
    if (!env2.ok) return env2.resp;
    const table = String(env2.data.table || '');
    return json({ ok: true, table, row: safeRowForLog(table, env2.data.row || {}) });
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
    // MIRROR_ENABLED so the cron can be wired now without risking the live Sheet.
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
