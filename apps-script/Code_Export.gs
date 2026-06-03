/**
 * 1891 Interpreter — one-click tenant data export.
 *
 *   GET ?action=export_tenant
 *
 * Returns every tenant-scoped table (plus the global reference tables and the
 * tenant's audit log) as a single structured JSON payload. The app turns this
 * into CSV-per-table + a JSON dump and zips it client-side, so "export your data
 * any day, one click" is real and leaves nothing on a server.
 *
 * Role gate: owner or platform-staff only (a full export carries everything the
 * tenant holds, including PHI ciphertext). Platform staff may pass tenant_id.
 *
 * PHI columns (Consumers.*_encrypted, notes_sealed, payment_details_encrypted)
 * are exported AS CIPHERTEXT — opaque AES-GCM blobs that can't be read without
 * the server-held key. display_initials and non-PHI fields come through in the
 * clear. This is the tenant's own data, walled off from every other tenant.
 *
 * Layout stability: rows are emitted in the canonical _tenantSchema() column
 * order regardless of how the underlying tab is ordered, so the export shape
 * stays steady release to release (the for-agencies "layout stays steady" promise).
 */

var _EXPORT_ALLOWED_ROLES = {
  'role_owner': true,
  'role_platform_staff': true
};

function apiExportTenant(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);
  if (!_EXPORT_ALLOWED_ROLES[s.payload.role]) {
    return _json({ ok: false, error: 'Owner or platform-staff role required' }, 403);
  }

  var p = e.parameter || {};
  var tid = s.payload.tid;
  if (s.payload.role === 'role_platform_staff' && p.tenant_id) tid = p.tenant_id;

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var schema = _tenantSchema();
  var names = Object.keys(schema);
  var tables = {};
  var totalRows = 0;

  for (var n = 0; n < names.length; n++) {
    var name = names[n];
    var cols = schema[name];
    var sh = ss.getSheetByName(name);
    var out = { headers: cols, rows: [] };

    if (sh && sh.getLastRow() >= 2) {
      var data = sh.getDataRange().getValues();
      var hdr = data[0];
      var iTid = hdr.indexOf('tenant_id');  // -1 for global reference tables

      for (var i = 1; i < data.length; i++) {
        // Tenant-scope every table that carries a tenant_id; include global
        // reference tables (Languages, etc.) whole.
        if (iTid >= 0 && tid && String(data[i][iTid]) !== String(tid)) continue;

        var rowObj = _rowToObj(hdr, data[i]);
        var rowArr = cols.map(function (c) {
          var v = rowObj[c];
          if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
          return v == null ? '' : v;
        });
        out.rows.push(rowArr);
      }
    }

    tables[name] = out;
    totalRows += out.rows.length;
  }

  _logAudit('tenant.export', tid, s.payload.uid, 'tables=' + names.length + ' rows=' + totalRows);

  return _json({
    ok: true,
    tenant_id: tid,
    generated_at: new Date().toISOString(),
    table_count: names.length,
    row_count: totalRows,
    note: 'PHI columns are exported as encrypted ciphertext.',
    tables: tables
  });
}
