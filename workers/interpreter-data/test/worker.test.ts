/**
 * interpreter-data — dual-write + phase-4 mirror proof (ADR-001 §6).
 *
 * Runs the REAL worker code (router, HMAC envelope, writeRow/deleteRow, mirror)
 * inside workerd against a REAL local D1 with migrations/0001_init.sql applied.
 * Nothing in the data path is mocked; only the outbound Apps Script mirror POST
 * is intercepted (fetchMock) — and net-connect is disabled so no test can ever
 * reach a real endpoint.
 *
 * FIXTURES ARE 100% SYNTHETIC (SECURITY_BASELINE.md #1 — no real PII/PHI ever):
 *   - emails/URLs use RFC 2606 reserved domains (example.com)
 *   - "PHI ciphertext" is a fake `v1:…`-shaped blob, never real ciphertext
 *   - ids/names are obviously synthetic
 */
import { env, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../src/index';
import { signBody, verifyBody } from '../src/hmac';
import { runMirror, enabledMirrorTables, MIRROR_TABLES } from '../src/mirror';
import type { Env } from '../src/db';

const SECRET = 'test-hmac-secret-synthetic';
const BASE = 'https://interpreter-data.example.com';

// PHI discipline: no outbound network from any test, ever.
beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

async function post(path: string, payloadObj: unknown, opts: { badSig?: boolean; noEnvelope?: boolean } = {}) {
  const payload = JSON.stringify(payloadObj);
  const body = opts.noEnvelope
    ? JSON.stringify(payloadObj)
    : JSON.stringify({ payload, sig: opts.badSig ? 'AAAA' + (await signBody(SECRET, payload)).slice(4) : await signBody(SECRET, payload) });
  const res = await worker.fetch(new Request(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  }), env as unknown as Env);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function get(path: string) {
  const res = await worker.fetch(new Request(BASE + path), env as unknown as Env);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

// ---------------------------------------------------------------------------

describe('healthz', () => {
  it('reports schema v1 and the full 39-table registry', async () => {
    const r = await get('/healthz');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.product).toBe('interpreter');
    expect(r.body.schema_version).toBe(1);
    expect(r.body.tables).toBe(39); // matches live /healthz — registry drift breaks this
  });
});

describe('HMAC envelope', () => {
  it('rejects a body with no envelope', async () => {
    const r = await post('/v1/dual-write', { table: 'Settings' }, { noEnvelope: true });
    expect(r.status).toBe(400);
  });
  it('rejects a tampered signature', async () => {
    const r = await post('/v1/parity', { table: 'Settings' }, { badSig: true });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('bad signature');
  });
  it('accepts a correctly signed envelope', async () => {
    const r = await post('/v1/parity', { table: 'Settings' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

describe('dual-write: upsert / delete / batch (the write→store proof)', () => {
  it('inserts then UPDATES by composite PK (Settings tenant_id+key) — no duplicates', async () => {
    const w1 = await post('/v1/dual-write', {
      tenant_id: 'host', table: 'Settings', op: 'upsert',
      row: { key: 'synthetic.test_key', value: 'v1-value', category: '_test', updated_by_user_id: 'usr_synthetic' },
    });
    expect(w1.body.ok).toBe(true);
    const w2 = await post('/v1/dual-write', {
      tenant_id: 'host', table: 'Settings', op: 'upsert',
      row: { key: 'synthetic.test_key', value: 'v2-value' },
    });
    expect(w2.body.ok).toBe(true);

    const p = await post('/v1/parity', { table: 'Settings', tenant_id: 'host' });
    expect(p.body.count).toBe(1); // upsert, not append

    const r = await post('/v1/read', { table: 'Settings', tenant_id: 'host', where_col: 'key', where_val: 'synthetic.test_key', raw: true });
    expect(r.body.count).toBe(1);
    expect(r.body.rows[0].value).toBe('v2-value');
    expect(r.body.rows[0].category).toBe('_test'); // partial upsert preserved the untouched column
  });

  it('pins tenant_id from the verified envelope — a row can never write cross-tenant', async () => {
    await post('/v1/dual-write', {
      tenant_id: 'host', table: 'Settings', op: 'upsert',
      row: { tenant_id: 'attacker-tenant', key: 'synthetic.pin_check', value: 'x' },
    });
    const r = await post('/v1/read', { table: 'Settings', tenant_id: 'host', where_col: 'key', where_val: 'synthetic.pin_check', raw: true });
    expect(r.body.count).toBe(1);
    expect(r.body.rows[0].tenant_id).toBe('host');
  });

  it('upserts a Jobs row (single PK) and deletes a Settings row by PK', async () => {
    const w = await post('/v1/dual-write', {
      tenant_id: 'host', table: 'Jobs', op: 'upsert',
      row: { job_id: 'job_synthetic_1', status: 'OPEN', service_type: 'medical', scheduled_start: 1780000000 },
    });
    expect(w.body.ok).toBe(true);
    const p = await post('/v1/parity', { table: 'Jobs', tenant_id: 'host' });
    expect(p.body.count).toBe(1);

    await post('/v1/dual-write', {
      tenant_id: 'host', table: 'Settings', op: 'upsert', row: { key: 'synthetic.delete_me', value: 'tmp' },
    });
    const d = await post('/v1/dual-write', {
      tenant_id: 'host', table: 'Settings', op: 'delete', pk: { key: 'synthetic.delete_me' },
    });
    expect(d.body.ok).toBe(true);
    const r = await post('/v1/read', { table: 'Settings', tenant_id: 'host', where_col: 'key', where_val: 'synthetic.delete_me' });
    expect(r.body.count).toBe(0);
  });

  it('batch applies good writes and reports per-item errors', async () => {
    const b = await post('/v1/dual-write/batch', {
      writes: [
        { tenant_id: 'host', table: 'Settings', op: 'upsert', row: { key: 'synthetic.batch_a', value: '1' } },
        { tenant_id: 'host', table: 'No_Such_Table', op: 'upsert', row: { key: 'x' } },
        { tenant_id: 'host', table: 'Settings', op: 'upsert', row: { key: 'synthetic.batch_b', value: '2' } },
      ],
    });
    expect(b.body.applied).toBe(2);
    expect(b.body.errors).toHaveLength(1);
    expect(b.body.errors[0].table).toBe('No_Such_Table');
    expect(b.body.ok).toBe(false);
  });

  it('rejects an unknown table on the single route too', async () => {
    const r = await post('/v1/dual-write', { tenant_id: 'host', table: 'Bogus', op: 'upsert', row: { a: 1 } });
    expect(r.status).toBe(400);
  });
});

describe('read surface: PHI + secret redaction, global rows', () => {
  const FAKE_CT = 'v1:c3ludGg=:Zml4dHVyZQ=='; // fake `v1:iv:ct`-SHAPED blob, not real ciphertext

  beforeEach(async () => {
    await post('/v1/dual-write', {
      tenant_id: 'host', table: 'Consumers', op: 'upsert',
      row: {
        consumer_id: 'cons_synthetic_1', display_initials: 'ZZ',
        legal_first_encrypted: FAKE_CT, legal_last_encrypted: FAKE_CT,
        created_by_user_id: 'usr_synthetic',
      },
    });
  });

  it('default read REDACTS PHI columns; raw read returns the stored blob', async () => {
    const masked = await post('/v1/read', { table: 'Consumers', tenant_id: 'host' });
    expect(masked.body.count).toBe(1);
    expect(masked.body.rows[0].legal_first_encrypted).toBe('[redacted-phi]');

    const raw = await post('/v1/read', { table: 'Consumers', tenant_id: 'host', raw: true });
    expect(raw.body.rows[0].legal_first_encrypted).toBe(FAKE_CT);
    expect(raw.body.rows[0].dob_encrypted).toBeNull(); // empty PHI stays empty, not a marker
  });

  it('serves global rows (tenant_id="*") to a tenant-scoped read', async () => {
    await post('/v1/dual-write', {
      tenant_id: '*', table: 'Roles', op: 'upsert',
      row: { role_id: 'role_synthetic_global', display_name: 'Synthetic Global Role' },
    });
    const r = await post('/v1/read', { table: 'Roles', tenant_id: 'host', raw: true });
    expect(r.body.rows.map((x: any) => x.role_id)).toContain('role_synthetic_global');
  });

  it('redacts secret-shaped Settings values on the non-raw read', async () => {
    await post('/v1/dual-write', {
      tenant_id: 'host', table: 'Settings', op: 'upsert',
      row: { key: 'synthetic.api_key', value: 'sk_live_SYNTHETICFIXTUREVALUE' },
    });
    const r = await post('/v1/read', { table: 'Settings', tenant_id: 'host', where_col: 'key', where_val: 'synthetic.api_key' });
    expect(r.body.rows[0].value).toBe('[redacted-secret]');
  });

  it('phi-audit: counts-only, flags non-ciphertext PHI', async () => {
    const clean = await post('/v1/phi-audit', {});
    expect(clean.body.phi_intact).toBe(true);
    expect(clean.body.report['Consumers.legal_first_encrypted'].populated).toBe(1);

    await post('/v1/dual-write', {
      tenant_id: 'host', table: 'Consumers', op: 'upsert',
      row: { consumer_id: 'cons_synthetic_bad', display_initials: 'YY', mrn_encrypted: 'NOT-CIPHERTEXT-SYNTHETIC' },
    });
    const dirty = await post('/v1/phi-audit', {});
    expect(dirty.body.phi_intact).toBe(false);
    expect(dirty.body.report['Consumers.mrn_encrypted'].bad_not_ciphertext).toBe(1);
    // counts only — the response must never carry the offending value
    expect(JSON.stringify(dirty.body)).not.toContain('NOT-CIPHERTEXT-SYNTHETIC');
  });
});

describe('keyset parity', () => {
  it('matches when the Sheet key set equals D1, reports a missing key when it does not', async () => {
    await post('/v1/dual-write', { tenant_id: 'host', table: 'Settings', op: 'upsert', row: { key: 'synthetic.k1', value: 'a' } });
    await post('/v1/dual-write', { tenant_id: 'host', table: 'Settings', op: 'upsert', row: { key: 'synthetic.k2', value: 'b' } });

    const same = await post('/v1/keyset', {
      table: 'Settings', pkCols: ['tenant_id', 'key'], keys: ['host|synthetic.k1', 'host|synthetic.k2'],
    });
    expect(same.body.match).toBe(true);

    const diff = await post('/v1/keyset', {
      table: 'Settings', pkCols: ['tenant_id', 'key'], keys: ['host|synthetic.k1', 'host|synthetic.k3'],
    });
    expect(diff.body.match).toBe(false);
    expect(diff.body.missing_in_d1).toBe(1); // k3 in "Sheet", not in D1
    expect(diff.body.orphan_in_d1).toBe(1);  // k2 in D1, dropped from "Sheet"
  });
});

// ---------------------------------------------------------------------------
// Phase-4 mirror: per-table gating + the signed D1->Sheet snapshot
// ---------------------------------------------------------------------------

describe('phase-4 mirror (per-table, signed, PHI-masked)', () => {
  const EXEC = 'https://script.example.com/macros/s/SYNTHETIC/exec';
  const FAKE_CT = 'v1:c3ludGg=:Zml4dHVyZQ==';

  function envWith(overrides: Partial<Env>): Env {
    return { ...(env as unknown as Env), ...overrides };
  }

  async function seedTenantAndRows() {
    await post('/v1/dual-write', {
      tenant_id: 'host', table: 'Tenants', op: 'upsert',
      row: { tenant_id: 'host', spreadsheet_id: 'SYNTHETIC_SHEET_ID', legal_name: 'Synthetic Agency LLC', tier: 'free', status: 'active' },
    });
    await post('/v1/dual-write', {
      tenant_id: 'host', table: 'Settings', op: 'upsert',
      row: { key: 'synthetic.mirror_me', value: 'mirrored-value', category: '_test' },
    });
    await post('/v1/dual-write', {
      tenant_id: 'host', table: 'Consumers', op: 'upsert',
      row: { consumer_id: 'cons_mirror_1', display_initials: 'XX', legal_first_encrypted: FAKE_CT },
    });
  }

  it('is inert without MIRROR_ENABLED, and with no per-table allowlist', async () => {
    const off = await runMirror(envWith({}));
    expect(off.ran).toBe(false);
    expect(off.reason).toContain('MIRROR_ENABLED');

    const noTables = await runMirror(envWith({ MIRROR_ENABLED: 'true', MIRROR_SHEET_EXEC: EXEC }));
    expect(noTables.ran).toBe(false);
    expect(noTables.reason).toContain('no tables enabled');
  });

  it('resolves the per-table allowlist strictly from MIRROR_TABLES_ENABLED', () => {
    expect(enabledMirrorTables(envWith({}))).toEqual([]);
    expect(enabledMirrorTables(envWith({ MIRROR_TABLES_ENABLED: 'all' }))).toEqual(MIRROR_TABLES);
    expect(enabledMirrorTables(envWith({ MIRROR_TABLES_ENABLED: 'Settings, Bogus_Table' }))).toEqual(['Settings']);
    // auth/log tables can never be mirrored even if listed
    expect(enabledMirrorTables(envWith({ MIRROR_TABLES_ENABLED: 'Auth_Tokens,Sys_Log,Settings' }))).toEqual(['Settings']);
  });

  it('mirrors ONLY the enabled tables, signs the snapshot, and masks PHI', async () => {
    await seedTenantAndRows();
    let captured = '';
    fetchMock.get('https://script.example.com')
      .intercept({ method: 'POST', path: '/macros/s/SYNTHETIC/exec' })
      .reply(200, (opts: any) => {
        captured = typeof opts.body === 'string' ? opts.body : new TextDecoder().decode(opts.body);
        return JSON.stringify({ ok: true });
      });

    const report = await runMirror(envWith({
      MIRROR_ENABLED: 'true', MIRROR_TABLES_ENABLED: 'Settings,Consumers', MIRROR_SHEET_EXEC: EXEC,
    }));
    expect(report.ran).toBe(true);
    expect(report.tenants).toHaveLength(1);
    expect(report.tenants![0]).toMatchObject({ tenant_id: 'host', status: 200 });

    const envelope = JSON.parse(captured) as { payload: string; sig: string };
    expect(await verifyBody(SECRET, envelope.payload, envelope.sig)).toBe(true); // receiver can authenticate it

    const snap = JSON.parse(envelope.payload);
    expect(snap.kind).toBe('d1_mirror');
    expect(snap.tenant_id).toBe('host');
    expect(snap.spreadsheet_id).toBe('SYNTHETIC_SHEET_ID');
    expect(Object.keys(snap.tabs).sort()).toEqual(['Consumers', 'Settings']); // nothing else leaves D1

    // Settings row made it, header-first
    const sTab = snap.tabs.Settings as unknown[][];
    expect(sTab[0]).toContain('key');
    expect(JSON.stringify(sTab)).toContain('synthetic.mirror_me');

    // PHI ciphertext NEVER leaves — masked to "[encrypted]"
    const cTab = snap.tabs.Consumers as unknown[][];
    const phiIdx = (cTab[0] as string[]).indexOf('legal_first_encrypted');
    expect(cTab[1][phiIdx]).toBe('[encrypted]');
    expect(JSON.stringify(snap)).not.toContain(FAKE_CT);
  });

  it('/v1/mirror/run narrows but can never widen the env allowlist', async () => {
    await seedTenantAndRows();
    let posts = 0;
    fetchMock.get('https://script.example.com')
      .intercept({ method: 'POST', path: '/macros/s/SYNTHETIC/exec' })
      .reply(200, () => { posts++; return JSON.stringify({ ok: true }); }).persist();

    const menv = envWith({ MIRROR_ENABLED: 'true', MIRROR_TABLES_ENABLED: 'Settings', MIRROR_SHEET_EXEC: EXEC });

    // narrow to a table OUTSIDE the allowlist -> nothing runs
    const widened = await runMirror(menv, ['Consumers']);
    expect(widened.ran).toBe(false);
    expect(posts).toBe(0);

    // narrow to a table inside it -> runs with exactly that table
    const ok = await runMirror(menv, ['Settings']);
    expect(ok.ran).toBe(true);
    expect(ok.tables).toEqual(['Settings']);
    expect(posts).toBe(1);
  });

  it('the /v1/mirror/run route is HMAC-gated and honestly inert by default', async () => {
    const bad = await post('/v1/mirror/run', { tables: ['Settings'] }, { badSig: true });
    expect(bad.status).toBe(401);

    const r = await post('/v1/mirror/run', { tables: ['Settings'] });
    expect(r.status).toBe(200);
    expect(r.body.mirror.ran).toBe(false); // MIRROR_ENABLED unset in prod-default env
    expect(r.body.mirror.reason).toContain('MIRROR_ENABLED');
  });
});
