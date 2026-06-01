// ============================================================================
// Code_D1Sync.gs — Sheet → D1 dual-write sender (ADR-001 strangler phase 2).
//
// interpreter is the highest-value migration: PHI + payment records moving off
// Google Sheets onto Cloudflare D1. This file is the SENDER; the RECEIVER is the
// interpreter-data Worker (projects/interpreter/workers/interpreter-data).
//
// WHY a trigger-based SYNC, not per-write HTTP hooks:
//   There are ~150 Sheet-write sites and NO central write helper. Bolting an
//   HTTP call onto each would add latency + a failure mode to the live customer
//   request path — exactly what the strangler pattern avoids. Instead the Sheet
//   stays the authoritative writer and a time-driven job UPSERTS every row into
//   D1 (keyed by PK, idempotent + self-healing). For a strangler this IS
//   dual-write: reads stay on the Sheet; D1 converges to match it. Zero added
//   risk to the live path. The same mechanism does backfill + ongoing parity.
//
// PHI: the Sheet already stores Consumers.*_encrypted / notes_sealed and
//   Interpreters.payment_details_encrypted as opaque `v1:iv:ct` ciphertext
//   (Code_PHI.gs encrypts via the Worker before write). This sender ships those
//   columns AS-IS — it never decrypts, never logs row contents. D1 receives the
//   same ciphertext the Sheet holds. The encryption boundary does NOT move.
//
// SECRET: _d1Secret_(), D1_WORKER_BASE, D1_DUAL_WRITE_ENABLED live in the
//   gitignored apps-script/d1-secret.gs (*-secret.gs). The secret equals the
//   Worker's HMAC_SECRET. Both sign/verify the SAME literal UTF-8 string
//   (Utilities.computeHmacSha256Signature(payload, secret) ↔ Web Crypto HMAC
//   over UTF-8) — no hex-decode, so feedback_appsscript_hmac_hex does NOT apply.
//
// DRIVE IT (gated by setup=SHEET_ID, same gate as apiRotateHmac):
//   GET/POST ?d1op=ping            -> {enabled, base}
//   GET/POST ?d1op=backfill[&tab=] -> upsert all (or one table) Sheet→D1
//   GET/POST ?d1op=parity          -> per-table Sheet-count vs D1-count
//   GET/POST ?d1op=tick            -> one convergent re-sync (what the trigger runs)
//   GET/POST ?d1op=install_trigger -> install the 30-min d1SyncTick trigger
// ============================================================================

// Tables synced to D1. Source of truth for columns + order is the Sheet header
// row itself (read at runtime) — we send {header: value} objects and the Worker
// filters to its own allowlist, so this stays correct if a column is added.
// EXCLUDED on purpose: Inbound + Deaf_Owned_Applications (append-only marketing
// capture, ADR §4 allowlisted to stay on Sheets) and Sys_Log (the Worker writes
// it). Those have no PK in the Worker registry, so re-syncing would duplicate.
// Tables intentionally NOT synced to D1 (besides Inbound/Deaf_Owned_Applications
// which aren't in _tenantSchema()):
//   Audit_Log — the LIVE Sheet's Audit_Log tab has a CORRUPT/legacy header
//   ['timestamp','action','form_id','detail', …] that does NOT match the schema
//   ['audit_id','tenant_id','ts',…]. `_logAudit` appends 12-value rows under that
//   4-named header, so `audit_id` (the PK) is unreadable. Auto-remapping a 7-year
//   legal audit record by column POSITION would risk misattribution — refuse it.
//   Tracked as a separate Sheet-cleanup item (HANDOFF). Re-enable once the live
//   Audit_Log header is repaired to match _tenantSchema().Audit_Log.
var D1_SYNC_EXCLUDE = { Audit_Log: 'corrupt live header — see HANDOFF' };

function _d1SyncTables_() {
  // _tenantSchema() keys ARE the Worker table names / tab names (33 tables),
  // plus the upsertable magic-link log. Control tables handled separately.
  return Object.keys(_tenantSchema()).concat(['Auth_Tokens']).filter(function (t) {
    return !D1_SYNC_EXCLUDE[t];
  });
}

// Primary-key column(s) per table — MUST match the Worker's db.ts TABLES registry.
// Used to SKIP rows with an empty PK: an empty PK reaches D1 as NULL, and SQLite
// permits multiple NULLs in a TEXT PRIMARY KEY, so the upsert can't dedupe them
// and every re-sync re-inserts → unbounded duplication (Audit_Log doubled 28→56
// before this guard). For all single-PK tables the PK is the first schema column;
// the two composite ones (Settings, Tenant_Owners) need BOTH cols non-empty.
function _d1Pk_(tableName) {
  if (tableName === 'Settings') return ['tenant_id', 'key'];
  if (tableName === 'Tenant_Owners') return ['tenant_id', 'user_id'];
  if (tableName === 'Tenants') return ['tenant_id'];
  if (tableName === 'Auth_Tokens') return ['token_hash'];
  var cols = _tenantSchema()[tableName];
  return cols && cols.length ? [cols[0]] : null; // first column is the PK
}

// --- low-level: sign + POST the HMAC envelope ------------------------------
function _d1Sign_(payload) {
  // MUST sign UTF-8 bytes. The STRING overload computeHmacSha256Signature(str, str)
  // does NOT emit UTF-8 for non-ASCII payloads, so it diverges from the Worker's
  // Web Crypto HMAC over TextEncoder().encode() (UTF-8) the moment a row carries an
  // accent / curly quote / em-dash — the whole batch then 401s "bad signature".
  // newBlob(str).getBytes() IS UTF-8; the Byte[] overload signs exactly those bytes,
  // and we key with the secret's UTF-8 bytes too (matches the Worker's UTF-8 key).
  var payloadBytes = Utilities.newBlob(payload).getBytes();
  var secretBytes = Utilities.newBlob(_d1Secret_()).getBytes();
  var raw = Utilities.computeHmacSha256Signature(payloadBytes, secretBytes);
  return Utilities.base64Encode(raw);
}

function _d1Post_(path, obj) {
  var payload = JSON.stringify(obj);
  var sig = _d1Sign_(payload);
  var res = UrlFetchApp.fetch(D1_WORKER_BASE + path, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({ payload: payload, sig: sig })
  });
  return { code: res.getResponseCode(), body: res.getContentText() };
}

// --- normalize a Sheet cell to a D1-friendly scalar ------------------------
// Date/ISO-string → epoch SECONDS (schema stores *_at as INTEGER); bool → 0/1;
// '' / null → '' (the Worker treats '' as NULL). Everything else passes through
// (numbers as-is; JSON columns are already JSON strings in the Sheet).
function _d1Norm_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Math.floor(v.getTime() / 1000);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
      var t = Date.parse(v);
      if (!isNaN(t)) return Math.floor(t / 1000);
    }
    return v;
  }
  return v; // number
}

function _d1FlushBatch_(writes) {
  var r = _d1Post_('/v1/dual-write/batch', { writes: writes });
  var applied = 0, errors = writes.length, firstErr = null;
  if (r.code === 200) {
    try {
      var b = JSON.parse(r.body);
      applied = b.applied || 0;
      errors = (b.errors && b.errors.length) || 0;
      if (b.errors && b.errors.length) firstErr = b.errors[0].error;
    } catch (_) { errors = writes.length; firstErr = 'parse:' + String(r.body).slice(0, 120); }
  } else {
    firstErr = 'http' + r.code + ':' + String(r.body).slice(0, 120);
  }
  return { sent: writes.length, applied: applied, errors: errors, firstErr: firstErr };
}

// --- sync one tab of one Sheet into D1 (idempotent upserts, 200/batch) ------
function _d1SyncTab_(spreadsheetId, tableName, tenantFallback) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sh = ss.getSheetByName(tableName);
  if (!sh) return { table: tableName, skipped: 'no tab' };
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { table: tableName, rows: 0 };
  var hdr = data[0];
  var pkCols = _d1Pk_(tableName);
  var writes = [], sent = 0, applied = 0, errors = 0, skippedNoPk = 0, firstErr = null;
  for (var i = 1; i < data.length; i++) {
    var row = {}, empty = true;
    for (var c = 0; c < hdr.length; c++) {
      var key = String(hdr[c] || '').trim();
      if (!key) continue;
      var v = _d1Norm_(data[i][c]);
      row[key] = v;
      if (v !== '' && v !== null) empty = false;
    }
    if (empty) continue;
    // SKIP rows with an empty PK — they'd land as NULL in D1 and re-insert on
    // every sync (SQLite allows many NULLs in a TEXT PRIMARY KEY). This is the
    // anti-duplication guarantee that makes the trigger safe to run forever.
    // NOTE: never gate on tenant_id — for tenant-scoped tables it's always
    // supplied by the envelope (tid below), and some tabs (Settings) don't even
    // carry a tenant_id column in the Sheet (the D1 schema adds it). So only the
    // NON-tenant PK columns must be present in the Sheet row.
    if (pkCols) {
      var pkMissing = false;
      for (var k = 0; k < pkCols.length; k++) {
        if (pkCols[k] === 'tenant_id') continue;
        var pv = row[pkCols[k]];
        if (pv === '' || pv === null || pv === undefined) { pkMissing = true; break; }
      }
      if (pkMissing) { skippedNoPk++; continue; }
    }
    // The Worker pins tenant_id from the envelope for tenant-scoped tables, so
    // send the row's OWN tenant_id (fallback to this Sheet's tenant) to avoid
    // relabelling. Global tables ignore it.
    var tid = row.tenant_id || tenantFallback || 'host';
    writes.push({ tenant_id: tid, table: tableName, op: 'upsert', row: row });
    if (writes.length >= 200) {
      var r = _d1FlushBatch_(writes); sent += r.sent; applied += r.applied; errors += r.errors;
      if (!firstErr && r.firstErr) firstErr = r.firstErr; writes = [];
    }
  }
  if (writes.length) {
    var r2 = _d1FlushBatch_(writes); sent += r2.sent; applied += r2.applied; errors += r2.errors;
    if (!firstErr && r2.firstErr) firstErr = r2.firstErr;
  }
  var out = { table: tableName, sent: sent, applied: applied, errors: errors };
  if (skippedNoPk) out.skippedNoPk = skippedNoPk;
  if (firstErr) out.firstErr = firstErr;
  return out;
}

// --- enumerate tenant Sheets (host + any in the control Sheet) -------------
function _d1Tenants_() {
  var list = [{ tenant_id: 'host', spreadsheet_id: SHEET_ID }];
  try {
    var rows = _readTenantsTable(); // Code_Multitenant.gs
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      if (t.spreadsheet_id && t.spreadsheet_id !== SHEET_ID) {
        list.push({ tenant_id: t.tenant_id, spreadsheet_id: t.spreadsheet_id });
      }
    }
  } catch (_) { /* control Sheet may not exist yet — host-only is fine */ }
  return list;
}

function _d1SyncControl_(report) {
  try {
    var cid = PropertiesService.getScriptProperties().getProperty('CONTROL_SHEET_ID');
    if (!cid) return;
    ['Tenants', 'Tenant_Owners'].forEach(function (t) {
      report.push(Object.assign({ tenant: '_control' }, _d1SyncTab_(cid, t, null)));
    });
  } catch (e) { report.push({ table: '_control', error: String(e).slice(0, 160) }); }
}

// --- backfill / convergent re-sync -----------------------------------------
function _d1Backfill_(onlyTab) {
  var report = [];
  _d1SyncControl_(report);
  var tables = _d1SyncTables_();
  var tenants = _d1Tenants_();
  tenants.forEach(function (tn) {
    tables.forEach(function (tbl) {
      if (onlyTab && tbl !== onlyTab) return;
      try { report.push(Object.assign({ tenant: tn.tenant_id }, _d1SyncTab_(tn.spreadsheet_id, tbl, tn.tenant_id))); }
      catch (e) { report.push({ tenant: tn.tenant_id, table: tbl, error: String(e).slice(0, 120) }); }
    });
  });
  return report;
}

// --- parity: per-table Sheet rowcount vs D1 rowcount -----------------------
function _d1ParityAll_() {
  var out = [];
  var tables = _d1SyncTables_().concat(['Tenants', 'Tenant_Owners']);
  var tenants = _d1Tenants_();
  var cid = PropertiesService.getScriptProperties().getProperty('CONTROL_SHEET_ID');
  tables.forEach(function (tbl) {
    var sheetTotal = 0;
    if (tbl === 'Tenants' || tbl === 'Tenant_Owners') {
      try { if (cid) { var csh = SpreadsheetApp.openById(cid).getSheetByName(tbl); sheetTotal = csh ? Math.max(0, csh.getLastRow() - 1) : 0; } } catch (_) {}
    } else {
      tenants.forEach(function (tn) {
        try { var sh = SpreadsheetApp.openById(tn.spreadsheet_id).getSheetByName(tbl); if (sh) sheetTotal += Math.max(0, sh.getLastRow() - 1); } catch (_) {}
      });
    }
    if (D1_SYNC_EXCLUDE[tbl]) { out.push({ table: tbl, sheet: sheetTotal, d1: null, excluded: D1_SYNC_EXCLUDE[tbl] }); return; }
    var r = _d1Post_('/v1/parity', { table: tbl });
    var d1 = null; if (r.code === 200) { try { d1 = JSON.parse(r.body).count; } catch (_) {} }
    out.push({ table: tbl, sheet: sheetTotal, d1: d1, match: (sheetTotal === d1) });
  });
  return out;
}

// --- the dual-write-live mechanism: a convergent re-sync on a timer ---------
// At interpreter's volume (small multi-tenant, low total rows) a full idempotent
// re-upsert every 30 min is correct + self-healing (also repairs any row a
// transient failure missed). Upgrade path if data grows: filter by _updated_at
// cursor instead of full re-sync.
function d1SyncTick() {
  if (typeof D1_DUAL_WRITE_ENABLED === 'undefined' || !D1_DUAL_WRITE_ENABLED) return;
  try { _d1Backfill_(null); }
  catch (e) { _logAudit('d1_sync_tick_failed', 'host', 'system', String(e).slice(0, 200)); }
}

function installD1SyncTrigger() {
  var ts = ScriptApp.getProjectTriggers();
  for (var i = 0; i < ts.length; i++) {
    if (ts[i].getHandlerFunction() === 'd1SyncTick') ScriptApp.deleteTrigger(ts[i]);
  }
  ScriptApp.newTrigger('d1SyncTick').timeBased().everyMinutes(30).create();
  return 'installed: d1SyncTick every 30 min';
}

function uninstallD1SyncTrigger() {
  var n = 0, ts = ScriptApp.getProjectTriggers();
  for (var i = 0; i < ts.length; i++) {
    if (ts[i].getHandlerFunction() === 'd1SyncTick') { ScriptApp.deleteTrigger(ts[i]); n++; }
  }
  return 'removed ' + n + ' d1SyncTick trigger(s)';
}

// Truncate D1 synced tables (the worker's HMAC-gated /v1/admin/truncate). Only
// clears D1 — the Sheet (system of record) is never touched. Used to reset for a
// clean re-backfill after the earlier non-idempotent/null-PK rows duplicated.
function _d1Truncate_(onlyTab) {
  var body = onlyTab ? { table: onlyTab } : { all: true };
  var r = _d1Post_('/v1/admin/truncate', body);
  try { return JSON.parse(r.body); } catch (_) { return { code: r.code, body: String(r.body).slice(0, 200) }; }
}

// --- HTTP entrypoint (short-circuited from doGet/doPost on ?d1op) -----------
function handleD1Op_(e) {
  var p = (e && e.parameter) || {};
  if (p.setup !== SHEET_ID) return _json({ ok: false, error: 'Forbidden' }, 403);
  var op = p.d1op;
  var enabled = (typeof D1_DUAL_WRITE_ENABLED !== 'undefined' && D1_DUAL_WRITE_ENABLED);
  var base = (typeof D1_WORKER_BASE !== 'undefined' ? D1_WORKER_BASE : null);
  if (op === 'ping') return _json({ ok: true, enabled: enabled, base: base });
  if (op === 'backfill') return _json({ ok: true, report: _d1Backfill_(p.tab || null) });
  if (op === 'parity') return _json({ ok: true, parity: _d1ParityAll_() });
  if (op === 'tick') {
    if (!enabled) return _json({ ok: true, skipped: 'D1_DUAL_WRITE_ENABLED false' });
    return _json({ ok: true, report: _d1Backfill_(null) });
  }
  if (op === 'install_trigger') return _json({ ok: true, result: installD1SyncTrigger() });
  if (op === 'uninstall_trigger') return _json({ ok: true, result: uninstallD1SyncTrigger() });
  if (op === 'reset') return _json({ ok: true, reset: _d1Truncate_(p.tab || null) });
  if (op === 'peek') return _json({ ok: true, peek: _d1Peek_(p.tab) });
  return _json({ ok: false, error: 'unknown d1op (ping|backfill|parity|tick|install_trigger|uninstall_trigger|reset|peek)' });
}

// Inspect a tab's header + first rows of its PK column(s). REFUSES any table with
// PHI/encrypted columns so it can never leak ciphertext or sensitive cells.
function _d1Peek_(tableName) {
  if (!tableName) return { error: 'tab required' };
  if (tableName === 'Consumers' || tableName === 'Interpreters') return { error: 'refused: PHI table' };
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(tableName);
  if (!sh) return { error: 'no tab' };
  var data = sh.getDataRange().getValues();
  if (data.length < 1) return { rows: 0 };
  var hdr = data[0].map(function (h) { return String(h || ''); });
  var pkCols = _d1Pk_(tableName);
  var pkIdx = (pkCols || []).map(function (c) { return hdr.indexOf(c); });
  var sample = [];
  for (var i = 1; i < Math.min(data.length, 4); i++) {
    var rec = { _row: i + 1 };
    for (var k = 0; k < (pkCols || []).length; k++) {
      rec[pkCols[k]] = pkIdx[k] >= 0 ? String(data[i][pkIdx[k]]) : '(col-not-found)';
    }
    sample.push(rec);
  }
  return { header: hdr, pkCols: pkCols, pkIndexes: pkIdx, dataRows: data.length - 1, sample: sample };
}
