/**
 * 1891 Interpreter — admin endpoints.
 *
 * Auditor-side read-back of the Audit_Log sheet. Surfaced by
 * /interpreter/app/admin/audit.html.
 *
 *   GET ?action=list_audit_log&tenant_id=...&from=...&to=...&user_id=...&action=...&limit=...
 *
 * Role gate: role_owner, role_platform_staff, role_manager, role_auditor.
 * (Auditors get a read-only window; owners/managers get the same view scoped
 * to their tenant.) Platform staff may pass tenant_id=* to query across all
 * tenants — anyone else is silently forced to their session tenant.
 *
 * Returns at most `limit` rows (default 200, max 1000) newest-first, plus a
 * `total_match` count so the client can show "showing 200 of 1430 — narrow
 * filters to see more". Pagination beyond `limit` is intentionally NOT
 * supported here; the Sheet is the source of truth, and once a tenant grows
 * past O(20k) rows the right move is to back this with BigQuery or a
 * partitioned export, not to paginate over a Sheet read.
 *
 * Audit rows themselves are NOT logged for this endpoint — that would be
 * recursive noise. (Anthony reviewing the log is just operations.)
 */

var _AUDIT_ALLOWED_ROLES = {
  'role_owner': true,
  'role_platform_staff': true,
  'role_manager': true,
  'role_auditor': true
};

function apiListAuditLog(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (!_AUDIT_ALLOWED_ROLES[s.payload.role]) {
    return _json({ ok:false, error:'Owner, manager, auditor, or platform-staff role required' }, 403);
  }

  var p = e.parameter || {};

  // Tenant scope. Platform staff may pass tenant_id='*' to query across all
  // tenants. Everyone else is pinned to their session tenant regardless of
  // what the request asked for.
  var requestedTid = p.tenant_id || '';
  var crossTenant = false;
  var tid;
  if (s.payload.role === 'role_platform_staff' && requestedTid === '*') {
    crossTenant = true;
    tid = null;
  } else if (s.payload.role === 'role_platform_staff' && requestedTid) {
    tid = requestedTid;
  } else {
    // Owner / manager / auditor — locked to session tenant.
    tid = s.payload.tid;
  }

  // Date window. ISO strings; missing values mean unbounded on that side.
  var fromMs = p.from ? Date.parse(p.from) : null;
  var toMs = p.to ? Date.parse(p.to) : null;
  if (fromMs !== null && isNaN(fromMs)) fromMs = null;
  if (toMs !== null && isNaN(toMs)) toMs = null;

  var userFilter = (p.user_id || '').trim();
  // The dispatch-action param is the same key as the action filter, so we
  // accept `action_filter` from the client (URLSearchParams keeps only the
  // last `action`, which would always be 'list_audit_log').
  var actionFilter = (p.action_filter || '').trim();
  // Prefix-match support: `client.*` means "starts with client.".
  var actionPrefix = null;
  var actionExact = null;
  if (actionFilter) {
    if (actionFilter.charAt(actionFilter.length - 1) === '*') {
      actionPrefix = actionFilter.slice(0, -1);
      if (actionPrefix.charAt(actionPrefix.length - 1) === '.') {
        // user typed "client.*" — keep the dot
      }
    } else if (actionFilter.indexOf('*') >= 0) {
      // single embedded star like `auth.*ed` — split and use ends-with too.
      var bits = actionFilter.split('*');
      actionPrefix = bits[0];
    } else {
      actionExact = actionFilter;
    }
  }

  var limit = parseInt(p.limit, 10);
  if (!limit || limit < 1) limit = 200;
  if (limit > 1000) limit = 1000;

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Audit_Log);
  if (!sh || sh.getLastRow() < 2) {
    return _json({
      ok: true,
      rows: [],
      total_match: 0,
      limit: limit,
      tenant_scope: crossTenant ? '*' : tid,
      filters: { from: p.from || null, to: p.to || null, user_id: userFilter || null, action: actionFilter || null }
    });
  }

  // One bulk read; the Audit_Log sheet has 12 cols so this stays cheap even
  // for tens of thousands of rows.
  var data = sh.getDataRange().getValues();
  var hdr = data[0];

  // Pre-load Users (for display_name) and Agencies (for legal_name) so we
  // don't N+1 the resolution. Single pass each.
  var users = _loadUserMap_(ss);          // user_id -> { display_name, email, role_id }
  var tenants = _loadTenantMap_(ss);      // tenant_id -> legal_name

  // We want newest-first. The sheet is appended chronologically, so reverse
  // iterate. We also need a `total_match` count BEFORE we slice to `limit`.
  var matched = [];
  for (var i = data.length - 1; i >= 1; i--) {
    var row = _rowToObj(hdr, data[i]);
    if (!crossTenant && tid && row.tenant_id !== tid) continue;
    if (userFilter && row.user_id !== userFilter) continue;
    if (actionExact && row.action !== actionExact) continue;
    if (actionPrefix && String(row.action || '').indexOf(actionPrefix) !== 0) continue;
    if (fromMs !== null || toMs !== null) {
      var ts = Date.parse(row.ts);
      if (isNaN(ts)) continue;
      if (fromMs !== null && ts < fromMs) continue;
      if (toMs !== null && ts > toMs) continue;
    }
    matched.push(row);
  }

  var total = matched.length;
  var sliced = matched.slice(0, limit);

  // Enrich with display names. Keep payload tight — just the fields the UI
  // actually shows.
  var out = sliced.map(function (r) {
    var u = users[r.user_id] || {};
    return {
      audit_id: r.audit_id,
      tenant_id: r.tenant_id,
      tenant_name: tenants[r.tenant_id] || (r.tenant_id === 'host' ? '1891 (host)' : r.tenant_id),
      ts: r.ts,
      user_id: r.user_id,
      user_display: u.display_name || (r.user_id === 'system' ? 'system' : (r.user_id || '—')),
      user_email: u.email || '',
      user_role: u.role_id || '',
      ip: r.ip || '',
      user_agent: r.user_agent || '',
      action: r.action,
      record_type: r.record_type || '',
      record_id: r.record_id || '',
      purpose_of_use: r.purpose_of_use || '',
      result: r.result || 'allow',
      jti: r.jti || ''
    };
  });

  return _json({
    ok: true,
    rows: out,
    total_match: total,
    limit: limit,
    tenant_scope: crossTenant ? '*' : tid,
    filters: {
      from: p.from || null,
      to: p.to || null,
      user_id: userFilter || null,
      action: actionFilter || null
    }
  });
}

// ----------------------------------------------------------------------------
// Helpers — bulk lookup maps.
// ----------------------------------------------------------------------------

function _loadUserMap_(ss) {
  var sh = ss.getSheetByName(T.Users);
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('user_id');
  var iName = hdr.indexOf('display_name');
  var iEmail = hdr.indexOf('email');
  var iRole = hdr.indexOf('role_id');
  if (iId < 0) return out;
  for (var i = 1; i < data.length; i++) {
    var id = data[i][iId];
    if (!id) continue;
    out[id] = {
      display_name: iName >= 0 ? data[i][iName] : '',
      email: iEmail >= 0 ? data[i][iEmail] : '',
      role_id: iRole >= 0 ? data[i][iRole] : ''
    };
  }
  return out;
}

function _loadTenantMap_(ss) {
  var sh = ss.getSheetByName(T.Agencies);
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('tenant_id');
  var iName = hdr.indexOf('legal_name');
  if (iId < 0 || iName < 0) return out;
  for (var i = 1; i < data.length; i++) {
    var id = data[i][iId];
    if (!id) continue;
    out[id] = data[i][iName] || id;
  }
  return out;
}
