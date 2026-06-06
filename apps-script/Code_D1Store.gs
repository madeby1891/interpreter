/**
 * Code_D1Store.gs — D1 as the system of record (ADR-001 phases 3-4).
 *
 * The read + write data-access layer that targets the interpreter-data Worker
 * (Cloudflare D1) instead of the per-agency Sheet. Flag-gated by D1_PRIMARY
 * (defined in the gitignored d1-secret.gs). Reuses _d1Post_/_d1Sign_/_d1Pk_/
 * _d1SyncTables_/_d1Norm_ from Code_D1Sync.gs.
 *
 *   phase 3  reads:  _dbValues_(ss, sh, tab) is a drop-in for
 *                    `sh.getDataRange().getValues()` — returns [header, ...rows]
 *                    from D1 when D1_PRIMARY, denormalized back to the Sheet's
 *                    representation so every downstream _rowToObj() is identical.
 *   phase 4  writes: _dbUpsert_/_dbDelete_ push the mutation to D1 as the
 *                    authoritative store (the Sheet becomes the §5 read-only mirror).
 *
 * Fidelity: the dual-write SENDER normalizes Sheet cells for D1 (`_d1Norm_`:
 * ISO timestamp -> epoch int; JS number in a TEXT column -> "N.0" string). So a
 * raw D1 read is NOT byte-identical to getValues(). `_dbDenorm_` inverts that so
 * the app sees what it always saw. `?d1op=readcheck` proves it cell-by-cell.
 */

function _dbPrimary_() {
  return (typeof D1_PRIMARY !== 'undefined' && D1_PRIMARY);
}

// --- READ ------------------------------------------------------------------

// All rows of one table from D1 (raw/faithful), as an array of column-keyed objects.
function _dbReadObjects_(tab, tenantId) {
  var r = _d1Post_('/v1/read', { table: tab, tenant_id: tenantId || 'host', raw: true, limit: 10000 });
  if (r.code !== 200) throw new Error('d1 read ' + tab + ' http' + r.code + ':' + String(r.body).slice(0, 120));
  var b = JSON.parse(r.body);
  return b.rows || [];
}

// Columns the sender stored as epoch seconds (schema *_at = INTEGER). Inverted on read.
var _DB_DATE_RE = /_at$|_start$|_end$|^ts$|^effective_date$/;

// Invert _d1Norm_ + D1's TEXT/number coercions back toward what getValues() returned.
function _dbDenorm_(col, v) {
  if (v === null || v === undefined) return '';
  // Date columns: D1 holds epoch seconds (number or numeric string) -> ISO string.
  if (_DB_DATE_RE.test(col)) {
    var n = (typeof v === 'number') ? v : (/^-?\d+$/.test(String(v)) ? Number(v) : null);
    if (n !== null && n > 1000000000) return new Date(n * 1000).toISOString();
    return v;
  }
  // "1099.0" / "21701.0" — a JS number stored in a TEXT column round-trips with a
  // trailing .0; coerce back to a Number so strict compares + display match the Sheet.
  if (typeof v === 'string' && /^-?\d+\.0+$/.test(v)) return Number(v);
  return v;
}

// Drop-in for `sh.getDataRange().getValues()`. Header (column order) comes from the
// live Sheet so downstream _rowToObj(hdr,row) is unchanged; data rows come from D1
// (denormalized) when D1_PRIMARY, else straight from the Sheet.
function _dbValues_(ss, sh, tab, tenantId) {
  if (!_dbPrimary_()) return sh.getDataRange().getValues();
  return _dbValuesForce_(sh, tab, tenantId);
}

// Same, but always reads D1 regardless of the flag (used by readcheck + verification).
function _dbValuesForce_(sh, tab, tenantId) {
  var lastCol = sh.getLastColumn();
  var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var objs = _dbReadObjects_(tab, tenantId);
  var out = [hdr];
  for (var i = 0; i < objs.length; i++) {
    var o = objs[i], rowArr = [];
    for (var c = 0; c < hdr.length; c++) {
      var key = String(hdr[c] || '').trim();
      rowArr.push(key && Object.prototype.hasOwnProperty.call(o, key) ? _dbDenorm_(key, o[key]) : '');
    }
    out.push(rowArr);
  }
  return out;
}

// --- WRITE (phase 4: D1 is the authoritative writer) -----------------------

// Upsert one row (the Worker decides append-vs-upsert from the table's PK def).
// rowObj keys are column names; values raw (the Worker + _d1Norm path normalize).
function _dbUpsert_(tab, rowObj, tenantId) {
  var norm = {};
  for (var k in rowObj) if (Object.prototype.hasOwnProperty.call(rowObj, k)) {
    var pk = _d1Pk_(tab) || [];
    norm[k] = (pk.indexOf(k) >= 0) ? (rowObj[k] === null || rowObj[k] === undefined ? '' : String(rowObj[k])) : _d1Norm_(rowObj[k]);
  }
  var r = _d1Post_('/v1/dual-write', { tenant_id: tenantId || 'host', table: tab, op: 'upsert', row: norm });
  if (r.code !== 200) throw new Error('d1 upsert ' + tab + ' http' + r.code + ':' + String(r.body).slice(0, 120));
  return JSON.parse(r.body);
}

// Delete by primary key (pkObj = {pk_col: value, ...}).
function _dbDelete_(tab, pkObj, tenantId) {
  var r = _d1Post_('/v1/dual-write', { tenant_id: tenantId || 'host', table: tab, op: 'delete', pk: pkObj });
  if (r.code !== 200) throw new Error('d1 delete ' + tab + ' http' + r.code + ':' + String(r.body).slice(0, 120));
  return JSON.parse(r.body);
}

// --- VERIFY (the precondition for flipping D1_PRIMARY) ---------------------

// Semantic cell equality: numeric (1099 == "1099.0"), date (epoch == ISO within 1s),
// else trimmed-string. Tolerates the representation differences that don't change meaning.
function _cellEq_(a, b) {
  if (a === b) return true;
  var ae = (a === '' || a === null || a === undefined), be = (b === '' || b === null || b === undefined);
  if (ae && be) return true;
  if (ae !== be) return false;
  var na = Number(a), nb = Number(b);
  if (!isNaN(na) && !isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '' && na === nb) return true;
  var da = Date.parse(a), db = Date.parse(b);
  if (!isNaN(da) && !isNaN(db) && Math.abs(da - db) < 1000) return true;
  return String(a).trim() === String(b).trim();
}

// Compare the D1-derived read (denormalized) against the live Sheet, cell-by-cell,
// aligned by primary key. Reports per-table + per-column mismatch counts + samples,
// so D1_PRIMARY only flips once this is clean. NO PHI values are returned (PHI tables
// report counts only).
function _d1ReadCheck_(onlyTab) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var tables = onlyTab ? [onlyTab] : _d1SyncTables_();
  var SENSITIVE = { Consumers: 1, Interpreters: 1, Auth_Tokens: 1 };
  var report = [];
  tables.forEach(function (tab) {
    try {
      var sh = ss.getSheetByName(tab);
      if (!sh) { report.push({ table: tab, skip: 'no tab' }); return; }
      var sv = sh.getDataRange().getValues();
      if (sv.length < 2) { report.push({ table: tab, rows: 0, mismatches: 0, match: true }); return; }
      var hdr = sv[0];
      var pk = _d1Pk_(tab) || [];
      var pkIdx = pk.map(function (c) { return hdr.indexOf(c); }).filter(function (i) { return i >= 0; });
      // index Sheet rows by PK
      function keyOf(rowArr) { return pkIdx.map(function (i) { return String(rowArr[i]); }).join(''); }
      var d1Rows = _dbValuesForce_(sh, tab, 'host'); // [hdr, ...]
      var d1ByKey = {};
      for (var i = 1; i < d1Rows.length; i++) d1ByKey[keyOf(d1Rows[i])] = d1Rows[i];
      var sensitive = !!SENSITIVE[tab];
      var colMis = {}; var total = 0; var missing = 0; var samples = [];
      for (var r = 1; r < sv.length; r++) {
        var k = keyOf(sv[r]);
        var d1r = d1ByKey[k];
        if (!d1r) { missing++; continue; }
        for (var c = 0; c < hdr.length; c++) {
          var col = String(hdr[c] || '').trim();
          if (!col) continue;  // blank-header column = trailing Sheet junk the sync + app both ignore
          // The Worker pins an empty tenant_id to 'host' for tenant-scoped tables — a
          // documented, benign correction (the Sheet's legacy empty -> the host tenant).
          if (col === 'tenant_id' && String(sv[r][c]).trim() === '' && String(d1r[c]) === 'host') continue;
          if (!_cellEq_(sv[r][c], d1r[c])) {
            colMis[col] = (colMis[col] || 0) + 1; total++;
            if (!sensitive && samples.length < 6) samples.push({ col: col, pk: k, sheet: String(sv[r][c]).slice(0, 40), d1: String(d1r[c]).slice(0, 40) });
          }
        }
      }
      var out = { table: tab, sheet_rows: sv.length - 1, d1_rows: d1Rows.length - 1, missing_in_d1: missing, cell_mismatches: total, cols: colMis, match: (total === 0 && missing === 0) };
      if (!sensitive && samples.length) out.samples = samples;
      report.push(out);
    } catch (e) { report.push({ table: tab, error: String(e).slice(0, 160) }); }
  });
  return report;
}

// --- END-TO-END SMOKE: prove the live accessors serve D1, via a D1-only sentinel.
// Server-side + setup-gated (admin). Mints a host-owner session, calls the REAL
// read endpoints, then writes a sentinel to D1 ONLY (never the Sheet), confirms it
// surfaces through apiListSettings (=> the accessor reads D1), and removes it.
function _d1ReadSmoke_() {
  var out = { d1_primary: _dbPrimary_() };
  var e = { parameter: { session: _mintSession({ uid: 'd1smoke', tid: 'host', role: 'role_owner', email: 'd1smoke@local' }) } };
  function count(fn, key, isObj) {
    try { var r = JSON.parse(fn(e).getContent()); return isObj ? Object.keys(r[key] || {}).length : (r[key] || []).length; }
    catch (err) { return 'ERR:' + String(err).slice(0, 80); }
  }
  out.settings_count = count(apiListSettings, 'settings', true);
  out.jobs_count = count(apiListJobs, 'jobs', false);
  out.interpreters_count = count(apiListInterpreters, 'interpreters', false);
  out.assignments_count = count(apiListAssignments, 'assignments', false);
  var sk = 'd1.readflip.sentinel';
  try {
    _dbUpsert_('Settings', { tenant_id: 'host', key: sk, value: 'SENTINEL', category: '_smoke' }, 'host');
    var s2 = JSON.parse(apiListSettings(e).getContent());
    out.sentinel_visible_via_accessor = !!(s2.settings && s2.settings[sk]);   // true => accessor reads D1
    _dbDelete_('Settings', { tenant_id: 'host', key: sk }, 'host');
    var s3 = JSON.parse(apiListSettings(e).getContent());
    out.sentinel_gone_after_cleanup = !(s3.settings && s3.settings[sk]);
  } catch (err) { out.sentinel_err = String(err).slice(0, 160); }
  return out;
}
