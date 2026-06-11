// ============================================================================
// Code_D1MirrorApply.gs — D1 -> Sheet mirror RECEIVER (ADR-001 phase 4, §5).
//
// Inverse direction of Code_D1Sync.gs: once a table's writes flip to D1
// (phase 4, per-table), the interpreter-data Worker mirrors that table's D1
// rows back into the (now read-only) Sheet tab so admins keep the "open the
// Sheet and eyeball rows" affordance. The Worker POSTs a signed snapshot to
//   <exec-url>?d1op=mirror_apply&setup=<SHEET_ID>
// (that full URL is the Worker secret MIRROR_SHEET_EXEC) and this file applies
// it. The Worker never touches a Sheet directly; this remains the only writer.
//
// TWO GATES, BOTH REQUIRED, PER TABLE (defense in depth — mirrors the Worker's
// MIRROR_ENABLED + MIRROR_TABLES_ENABLED pair):
//   1. The Worker only EXPORTS tables in its MIRROR_TABLES_ENABLED allowlist.
//   2. This receiver only APPLIES tabs listed in the Apps-Script-side
//      D1_WRITE_TABLES flag (gitignored d1-secret.gs, comma-separated, or
//      'all'). A tab absent from D1_WRITE_TABLES is still Sheet-authoritative
//      and is NEVER overwritten, whatever the snapshot says.
// D1_WRITE_TABLES is the SAME flag that excludes a table from the Sheet→D1
// sender (_d1SyncTables_/_d1NudgeSync_ in Code_D1Sync.gs): one flag flips a
// table's direction atomically — sync-off + mirror-on cannot drift apart.
//
// AUTH: body-signed HMAC envelope { payload, sig } — the same UTF-8-bytes
// convention as _d1Sign_ (Utilities.newBlob(payload).getBytes(), secret's
// UTF-8 bytes; see the phase-2 non-ASCII bug note in Code_D1Sync.gs). Plus:
//   - setup=SHEET_ID query gate (handleD1Op_, like every other d1op)
//   - payload.ts freshness window (±10 min) and a sig replay cache
//   - target spreadsheet resolved from the LOCAL tenant registry, never from
//     the snapshot (a forged/stale spreadsheet_id cannot redirect the write)
//
// PHI: snapshots arrive already masked — the Worker replaces PHI ciphertext
// with '[encrypted]' and never decrypts. This file logs COUNTS ONLY, never
// cell contents.
//
// Audit_Log / Auth_Tokens / Sys_Log are not in the Worker's MIRROR_TABLES and
// must never be listed in D1_WRITE_TABLES' mirror set — Audit_Log is a 7-year
// append-only record with a hash chain; its phase-4 treatment is separate.
// ============================================================================

// --- the per-table write-flip flag ------------------------------------------

// Tables whose WRITES have flipped to D1 (phase 4). Source: D1_WRITE_TABLES in
// the gitignored d1-secret.gs — a comma-separated tab list ('Settings,Rate_Cards')
// or 'all' (final state). Absent/empty = phase 4 not started for any table.
function _d1WriteTables_() {
  var raw = (typeof D1_WRITE_TABLES !== 'undefined' && D1_WRITE_TABLES) ? String(D1_WRITE_TABLES) : '';
  raw = raw.replace(/^\s+|\s+$/g, '');
  if (!raw) return { all: false, map: {} };
  if (raw.toLowerCase() === 'all') return { all: true, map: {} };
  var map = {};
  raw.split(',').forEach(function (t) { t = t.replace(/^\s+|\s+$/g, ''); if (t) map[t] = 1; });
  return { all: false, map: map };
}

// Is this table's write path D1-direct (so its Sheet tab is a read-only mirror)?
function _d1IsWriteFlipped_(tab) {
  var wt = _d1WriteTables_();
  return wt.all || !!wt.map[tab];
}

// --- constant-time equality (no early return) --------------------------------
function _d1CtEq_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

// --- the receiver -------------------------------------------------------------

// Handles ?d1op=mirror_apply (wired in handleD1Op_, which already enforced
// setup=SHEET_ID). Returns a counts-only report; never row contents.
function handleD1MirrorApply_(e) {
  // 1. Envelope + signature (fail closed on anything malformed).
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || ''); }
  catch (_) { return { ok: false, error: 'bad envelope json' }; }
  if (!body || typeof body.payload !== 'string' || typeof body.sig !== 'string') {
    return { ok: false, error: 'missing payload/sig' };
  }
  if (!_d1CtEq_(_d1Sign_(body.payload), body.sig)) return { ok: false, error: 'bad signature' };

  var snap;
  try { snap = JSON.parse(body.payload); } catch (_) { return { ok: false, error: 'bad payload json' }; }
  if (!snap || snap.kind !== 'd1_mirror') return { ok: false, error: 'wrong kind' };

  // 2. Freshness + replay (a signed snapshot must not be re-appliable later,
  //    when the tab could hold newer D1 writes).
  var nowS = Math.floor(Date.now() / 1000);
  var ts = parseInt(snap.ts, 10);
  if (!isFinite(ts) || Math.abs(nowS - ts) > 600) return { ok: false, error: 'stale snapshot (ts outside +-600s)' };
  try {
    var cache = CacheService.getScriptCache();
    var seenKey = 'd1mirror:' + body.sig.slice(0, 60);
    if (cache.get(seenKey)) return { ok: false, error: 'replay' };
    cache.put(seenKey, '1', 600);
  } catch (_) { return { ok: false, error: 'replay cache unavailable' }; }

  // 3. Resolve the target spreadsheet from the LOCAL registry only.
  var tid = String(snap.tenant_id || 'host');
  var ssId = SHEET_ID;
  if (tid !== 'host') {
    var tn = _d1Tenants_().filter(function (t) { return t.tenant_id === tid; })[0];
    if (!tn || !tn.spreadsheet_id) return { ok: false, error: 'unknown tenant', tenant_id: tid };
    ssId = tn.spreadsheet_id;
  }
  var ssIdCrossCheck = (snap.spreadsheet_id && String(snap.spreadsheet_id) !== String(ssId)) ? 'MISMATCH-ignored-snapshot-value' : 'ok';

  // 4. Apply each tab — only those THIS side also marks D1-write-primary.
  var tabs = (snap.tabs && typeof snap.tabs === 'object') ? snap.tabs : {};
  var ss = SpreadsheetApp.openById(ssId);
  var report = [];
  for (var tab in tabs) {
    if (!Object.prototype.hasOwnProperty.call(tabs, tab)) continue;
    if (!_d1IsWriteFlipped_(tab)) { report.push({ tab: tab, skipped: 'not in D1_WRITE_TABLES (Sheet-authoritative)' }); continue; }
    try {
      var grid = tabs[tab];
      if (!grid || !grid.length || !grid[0] || !grid[0].length) { report.push({ tab: tab, skipped: 'empty snapshot' }); continue; }
      report.push(_d1MirrorWriteTab_(ss, tab, grid));
    } catch (err) {
      report.push({ tab: tab, error: String(err).slice(0, 160) });
    }
  }
  try { _logAudit('d1_mirror_apply', tid, 'system', 'tabs:' + report.length); } catch (_) {}
  return { ok: true, tenant_id: tid, spreadsheet_check: ssIdCrossCheck, applied: report };
}

// Replace one tab's contents with the snapshot grid (header row + data rows),
// REMAPPED to the tab's existing header order so the admin's column layout (and
// _dbValues_'s header-driven read mapping) is preserved. Snapshot columns the
// tab doesn't know yet are appended on the right; existing columns missing from
// the snapshot stay as empty columns (header kept, cells blank).
function _d1MirrorWriteTab_(ss, tab, grid) {
  var sh = ss.getSheetByName(tab);
  var snapHdr = grid[0].map(function (h) { return String(h || '').trim(); });
  var outHdr;
  if (!sh) {
    sh = ss.insertSheet(tab);
    outHdr = snapHdr.slice();
  } else {
    var lastCol = sh.getLastColumn();
    var liveHdr = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    outHdr = [];
    for (var c = 0; c < liveHdr.length; c++) {
      var name = String(liveHdr[c] || '').trim();
      outHdr.push(name); // keep blanks too — preserves trailing junk-column positions
    }
    for (var s = 0; s < snapHdr.length; s++) {
      if (snapHdr[s] && outHdr.indexOf(snapHdr[s]) < 0) outHdr.push(snapHdr[s]);
    }
    if (!outHdr.length) outHdr = snapHdr.slice();
  }
  var idx = {}; // snapshot column name -> snapshot index
  for (var i = 0; i < snapHdr.length; i++) if (snapHdr[i]) idx[snapHdr[i]] = i;
  var out = [outHdr];
  for (var r = 1; r < grid.length; r++) {
    var row = [];
    for (var o = 0; o < outHdr.length; o++) {
      var col = outHdr[o];
      row.push(col && Object.prototype.hasOwnProperty.call(idx, col) ? grid[r][idx[col]] : '');
    }
    out.push(row);
  }
  sh.clearContents();
  sh.getRange(1, 1, out.length, outHdr.length).setValues(out);
  return { tab: tab, rows: out.length - 1, cols: outHdr.length };
}
