/**
 * 1891 Interpreter — Stripe Connect OAuth (Pattern G, Mode A canonical).
 *
 * Added 2026-05-19 from the Mode-A pivot. See:
 *   - shared/specs/PAYMENTS.md §2.6 Pattern G
 *   - projects/interpreter/docs/PAYMENTS_IMPL.md §1.5
 *
 * Flow:
 *   1. Admin clicks "Connect your Stripe" in the in-app Payments tab
 *      → site posts to apiAgencyConnectStart
 *      → Apps Script proxies to worker /v1/connect/oauth/start
 *      → returns {authorize_url} → site redirects user to Stripe
 *   2. Stripe redirects back to https://madeby1891.com/interpreter/connect/callback?code=…&state=…
 *      → that page reads its query string and posts to apiAgencyConnectCallback
 *      → Apps Script proxies to worker /v1/connect/oauth/callback
 *      → worker exchanges code, returns stripe_user_id (acct_…)
 *      → Apps Script writes to Agencies row + audit-log
 *   3. apiAgencyConnectReport runs the read-only data pull (balance/invoices/payouts/charges)
 *      on demand, via worker /v1/connect/report with `Stripe-Account: acct_…` header.
 *   4. apiAgencyConnectDisconnect zeros the Agencies row fields. To revoke from
 *      Stripe's side, the agency goes to their own Stripe dashboard → Settings →
 *      Apps → 1891 Interpreter → Disconnect; we'll catch the
 *      account.application.deauthorized webhook and the Sheet flips automatically.
 *
 * Worker base + auth: same _payCallWorker + _payInternalSecret used by
 * Code_Payments.gs. The worker auth header is X-1891-Internal = HMAC_SECRET.
 */

// ---------------------------------------------------------------------------
// Worker proxy (mirrors Code_Payments.gs convention)
// ---------------------------------------------------------------------------

function _connectCallWorker_(ss, path, body) {
  // Reuse the same plumbing Code_Payments.gs uses.
  return _payCallWorker(ss, path, body);
}

// ---------------------------------------------------------------------------
// Tenant Agencies-row helpers — find by tenant_id, read/write Connect fields
// ---------------------------------------------------------------------------

function _connectFindAgencyByTenantId_(ss, tenantId) {
  if (!tenantId) return null;
  var sh = ss.getSheetByName(T.Agencies);
  if (!sh) return null;
  var lastCol = sh.getLastColumn();
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var iTid = hdr.indexOf('tenant_id');
  if (iTid < 0) iTid = hdr.indexOf('id'); // legacy fallback
  if (iTid < 0) return null;
  var data = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  for (var r = 0; r < data.length; r++) {
    if (String(data[r][iTid]) === String(tenantId)) {
      return { sheet: sh, hdr: hdr, row: r + 2, data: data[r] };
    }
  }
  return null;
}

function _connectWriteAgencyFields_(found, fields) {
  if (!found) return;
  var hdr = found.hdr;
  var row = found.row;
  var sh = found.sheet;
  Object.keys(fields).forEach(function (k) {
    var i = hdr.indexOf(k);
    if (i >= 0) sh.getRange(row, i + 1).setValue(fields[k]);
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST agency_connect_start
 * Admin (owner/admin role) clicks "Connect your Stripe" in the Payments tab.
 * Returns { ok, authorize_url, state, expires_at } or { ok:false, status:'unconfigured' }
 * when STRIPE_CONNECT_CLIENT_ID isn't set yet on the worker.
 */
function apiAgencyConnectStart(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok: false, error: 'Owner or admin role required' }, 403);
  }
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var res = _connectCallWorker_(ss, '/v1/connect/oauth/start', {
    tenant_id: s.payload.tid,
    email: s.payload.email || s.payload.uid || ''
  });
  if (!res.ok) {
    _logAudit('connect.oauth_start_failed', s.payload.tid, s.payload.uid, (res.error || ''));
    return _json({ ok: false, error: res.error || 'worker_error', status: res.status || '' });
  }
  _logAudit('connect.oauth_start', s.payload.tid, s.payload.uid, 'authorize_url issued');
  return _json({ ok: true, authorize_url: res.authorize_url, expires_at: res.expires_at });
}

/**
 * POST agency_connect_callback
 * The site's /interpreter/connect/callback page posts here with the OAuth
 * `code` + `state` query params. We forward to the worker for the token
 * exchange; on success, stamp the Agencies row with the agency's acct_….
 *
 * Returns { ok, stripe_user_id, scope, livemode } or an error.
 */
function apiAgencyConnectCallback(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok: false, error: 'Owner or admin role required' }, 403);
  }
  var p = (e && e.parameter) || {};
  var code = String(p.code || '').trim();
  var state = String(p.state || '').trim();
  if (!code || !state) return _json({ ok: false, error: 'code + state required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  // Make sure the Agencies tab has the Connect columns. Idempotent.
  extendAgenciesSchema_(ss);

  var res = _connectCallWorker_(ss, '/v1/connect/oauth/callback', {
    code: code,
    state: state
  });
  if (!res.ok) {
    _logAudit('connect.oauth_callback_failed', s.payload.tid, s.payload.uid, (res.error || ''));
    return _json({ ok: false, error: res.error || 'oauth_callback_failed', status: res.status || '' });
  }

  // State carried tenant_id at signing time; verify it matches the caller's tenant.
  if (res.tenant_id && String(res.tenant_id) !== String(s.payload.tid)) {
    _logAudit('connect.oauth_tenant_mismatch', s.payload.tid, s.payload.uid,
      'state.tenant_id=' + res.tenant_id + ' != session.tid=' + s.payload.tid);
    return _json({ ok: false, error: 'tenant mismatch — possible session theft, please contact support' }, 403);
  }

  // Find the agency row + stamp it.
  var found = _connectFindAgencyByTenantId_(ss, s.payload.tid);
  if (!found) {
    _logAudit('connect.no_agency_row', s.payload.tid, s.payload.uid, 'tenant_id=' + s.payload.tid);
    return _json({ ok: false, error: 'agency row not found for current session' }, 404);
  }
  var nowIso = new Date().toISOString();
  _connectWriteAgencyFields_(found, {
    stripe_connect_account_id: res.stripe_user_id,
    stripe_connect_status: 'linked',
    stripe_connect_scopes: res.scope || 'read_only',
    stripe_connect_linked_at: nowIso,
    stripe_connect_linked_by: s.payload.email || s.payload.uid || ''
  });
  _logAudit('connect.oauth_linked', s.payload.tid, s.payload.uid,
    res.stripe_user_id + ' scope=' + (res.scope || 'read_only') + ' livemode=' + res.livemode);

  return _json({
    ok: true,
    stripe_user_id: res.stripe_user_id,
    scope: res.scope,
    livemode: res.livemode
  });
}

/**
 * GET / POST agency_connect_report
 * Returns the agency's read-only Stripe summary: balance, recent invoices,
 * recent payouts, recent charges. All on demand — no cache. The Worker uses
 * the platform's restricted key with `Stripe-Account: acct_…` so we never
 * see or store the agency's own Stripe credentials.
 */
function apiAgencyConnectReport(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var found = _connectFindAgencyByTenantId_(ss, s.payload.tid);
  if (!found) return _json({ ok: false, error: 'agency row not found' }, 404);
  var hdr = found.hdr;
  var iAcct = hdr.indexOf('stripe_connect_account_id');
  var iStatus = hdr.indexOf('stripe_connect_status');
  var acct = iAcct >= 0 ? String(found.data[iAcct] || '') : '';
  var status = iStatus >= 0 ? String(found.data[iStatus] || '') : '';
  if (!acct || status !== 'linked') {
    return _json({ ok: false, error: 'agency has not connected Stripe yet', status: 'not_linked' });
  }

  var p = (e && e.parameter) || {};
  var limit = Math.max(1, Math.min(50, parseInt(p.limit, 10) || 20));
  var res = _connectCallWorker_(ss, '/v1/connect/report', {
    stripe_user_id: acct,
    limit: limit
  });
  if (!res.ok) {
    return _json({ ok: false, error: res.error || 'worker_error', status: res.status || '' });
  }
  return _json(res);
}

/**
 * POST agency_connect_disconnect
 * Local "forget the link" — zero out the Agencies row Connect fields. The
 * agency must also revoke from their Stripe dashboard's Apps section if they
 * want the OAuth grant rescinded on Stripe's side. (The deauth webhook will
 * also flip the row when they do.)
 */
function apiAgencyConnectDisconnect(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok: false, error: 'Owner or admin role required' }, 403);
  }
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var found = _connectFindAgencyByTenantId_(ss, s.payload.tid);
  if (!found) return _json({ ok: false, error: 'agency row not found' }, 404);
  _connectWriteAgencyFields_(found, {
    stripe_connect_account_id: '',
    stripe_connect_status: 'deauthorized',
    stripe_connect_scopes: '',
    stripe_connect_linked_at: '',
    stripe_connect_linked_by: ''
  });
  _logAudit('connect.local_disconnect', s.payload.tid, s.payload.uid, '');
  return _json({ ok: true });
}
