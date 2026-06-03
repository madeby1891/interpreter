/**
 * 1891 Interpreter — QuickBooks Online (QBO) integration (Apps Script side).
 *
 * Added 2026-06-02. Mirrors the Stripe Connect (Pattern G) flow in
 * Code_Connect.gs. Lets an agency connect their QuickBooks Online company so
 * interpreter invoices can be pushed into QuickBooks.
 *
 * Flow:
 *   1. Admin clicks "Connect QuickBooks Online" in the in-app settings
 *      → site posts to apiQboConnectStart
 *      → Apps Script proxies to worker /v1/qbo/oauth/start
 *      → returns {authorize_url} → site redirects user to Intuit
 *   2. Intuit redirects back to the QBO callback page with code + state + realmId
 *      → that page posts to apiQboConnectCallback
 *      → Apps Script proxies to worker /v1/qbo/oauth/callback (token exchange)
 *      → worker returns access+refresh tokens + realm_id
 *      → Apps Script stamps Agencies.qbo_realm_id AND stores the refresh token
 *        in Script Properties (server-side), keyed QBO_REFRESH_<tid>. The
 *        refresh token NEVER lands in a Sheet column — same rule Code_Sso.gs
 *        follows for its OIDC client secret.
 *   3. apiQboStatus reports whether the tenant is linked (realm present) and
 *      whether the worker is configured.
 *   4. apiQboPushInvoice gathers an interpreter Invoice + its lines, pulls the
 *      stored refresh token + realm, proxies to worker /v1/qbo/push-invoice,
 *      and persists any rotated refresh token Intuit returns.
 *   5. apiQboDisconnect clears the Agencies row realm field and deletes the
 *      stored refresh token.
 *
 * Worker base + auth: same _payCallWorker + _payInternalSecret used by
 * Code_Payments.gs / Code_Connect.gs. Worker auth header is X-1891-Internal.
 */

// ---------------------------------------------------------------------------
// Worker proxy + Script-Properties token storage
// ---------------------------------------------------------------------------

function _qboCallWorker_(ss, path, body) {
  // Reuse the same plumbing Code_Payments.gs / Code_Connect.gs use.
  return _payCallWorker(ss, path, body);
}

function _qboRefreshKey_(tid) { return 'QBO_REFRESH_' + tid; }

function _qboGetRefreshToken_(tid) {
  return PropertiesService.getScriptProperties().getProperty(_qboRefreshKey_(tid)) || '';
}

function _qboSetRefreshToken_(tid, token) {
  if (token) PropertiesService.getScriptProperties().setProperty(_qboRefreshKey_(tid), String(token));
}

function _qboDeleteRefreshToken_(tid) {
  PropertiesService.getScriptProperties().deleteProperty(_qboRefreshKey_(tid));
}

// ---------------------------------------------------------------------------
// Tenant Agencies-row helpers — reuse the Connect helpers (same Agencies tab).
// _connectFindAgencyByTenantId_ and _connectWriteAgencyFields_ live in
// Code_Connect.gs; we lean on them so the realm read/write is consistent.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST qbo_connect_start
 * Admin (owner/admin role) clicks "Connect QuickBooks Online".
 * Returns { ok, authorize_url, expires_at } or { ok:false, status:'unconfigured' }
 * when the QBO_* secrets aren't set yet on the worker.
 */
function apiQboConnectStart(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok: false, error: 'Owner or admin role required' }, 403);
  }
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var res = _qboCallWorker_(ss, '/v1/qbo/oauth/start', {
    tenant_id: s.payload.tid,
    email: s.payload.email || s.payload.uid || ''
  });
  if (!res.ok) {
    _logAudit('qbo.oauth_start_failed', s.payload.tid, s.payload.uid, (res.error || ''));
    return _json({ ok: false, error: res.error || 'worker_error', status: res.status || '' });
  }
  _logAudit('qbo.oauth_start', s.payload.tid, s.payload.uid, 'authorize_url issued');
  return _json({ ok: true, authorize_url: res.authorize_url, expires_at: res.expires_at });
}

/**
 * POST qbo_connect_callback
 * The QBO callback page posts here with the OAuth `code` + `state` + `realmId`
 * query params. We forward to the worker for the token exchange; on success,
 * stamp Agencies.qbo_realm_id and store the refresh token in Script Properties.
 *
 * Returns { ok, realm_id } or an error.
 */
function apiQboConnectCallback(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok: false, error: 'Owner or admin role required' }, 403);
  }
  var p = (e && e.parameter) || {};
  var code = String(p.code || '').trim();
  var state = String(p.state || '').trim();
  // Intuit returns the company id as `realmId`.
  var realmId = String(p.realmId || p.realm_id || '').trim();
  if (!code || !state) return _json({ ok: false, error: 'code + state required' });
  if (!realmId) return _json({ ok: false, error: 'realmId required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  // Make sure the Agencies tab has the qbo_realm_id column. Idempotent.
  extendAgenciesSchema_(ss);

  var res = _qboCallWorker_(ss, '/v1/qbo/oauth/callback', {
    code: code,
    state: state,
    realm_id: realmId
  });
  if (!res.ok) {
    _logAudit('qbo.oauth_callback_failed', s.payload.tid, s.payload.uid, (res.error || ''));
    return _json({ ok: false, error: res.error || 'oauth_callback_failed', status: res.status || '' });
  }

  // State carried tenant_id at signing time; verify it matches the caller's tenant.
  if (res.tenant_id && String(res.tenant_id) !== String(s.payload.tid)) {
    _logAudit('qbo.oauth_tenant_mismatch', s.payload.tid, s.payload.uid,
      'state.tenant_id=' + res.tenant_id + ' != session.tid=' + s.payload.tid);
    return _json({ ok: false, error: 'tenant mismatch — possible session theft, please contact support' }, 403);
  }

  // Store the refresh token server-side (Script Properties), keyed by tenant.
  _qboSetRefreshToken_(s.payload.tid, res.refresh_token);

  // Find the agency row + stamp the realm id.
  var found = _connectFindAgencyByTenantId_(ss, s.payload.tid);
  if (!found) {
    _logAudit('qbo.no_agency_row', s.payload.tid, s.payload.uid, 'tenant_id=' + s.payload.tid);
    return _json({ ok: false, error: 'agency row not found for current session' }, 404);
  }
  _connectWriteAgencyFields_(found, { qbo_realm_id: res.realm_id });
  // Audit logs carry IDs only — never the tokens.
  _logAudit('qbo.oauth_linked', s.payload.tid, s.payload.uid, 'realm=' + res.realm_id);

  return _json({ ok: true, realm_id: res.realm_id });
}

/**
 * GET / POST qbo_status
 * Returns the tenant's QBO link state: connected (realm present) + whether the
 * worker is configured. The realm comes from the Agencies row; the configured
 * flag from the worker probe.
 */
function apiQboStatus(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var found = _connectFindAgencyByTenantId_(ss, s.payload.tid);
  var realm = '';
  if (found) {
    var iRealm = found.hdr.indexOf('qbo_realm_id');
    if (iRealm >= 0) realm = String(found.data[iRealm] || '');
  }
  var connected = !!realm && !!_qboGetRefreshToken_(s.payload.tid);

  // Probe the worker for the unconfigured vs configured distinction + environment.
  var probe = _qboCallWorker_(ss, '/v1/qbo/status', {});
  var configured = !!(probe && probe.ok && probe.configured);
  var environment = (probe && probe.environment) || '';

  return _json({
    ok: true,
    connected: connected,
    realm_id: realm,
    configured: configured,
    environment: environment
  });
}

/**
 * POST qbo_push_invoice
 * Given invoice_id, gather the interpreter Invoice + lines, pull the tenant's
 * stored refresh token + realm, proxy to worker /v1/qbo/push-invoice, and
 * persist any rotated refresh token. Stamps the local invoice with the QBO id.
 *
 * Returns { ok, qbo_invoice_id, qbo_doc_number } or an error.
 */
function apiQboPushInvoice(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok: false, error: 'Owner or admin role required' }, 403);
  }
  var p = (e && e.parameter) || {};
  var invoiceId = String(p.invoice_id || '').trim();
  if (!invoiceId) return _json({ ok: false, error: 'invoice_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);

  // Confirm the tenant has linked QuickBooks.
  var found = _connectFindAgencyByTenantId_(ss, s.payload.tid);
  var realm = '';
  if (found) {
    var iRealm = found.hdr.indexOf('qbo_realm_id');
    if (iRealm >= 0) realm = String(found.data[iRealm] || '');
  }
  var refreshToken = _qboGetRefreshToken_(s.payload.tid);
  if (!realm || !refreshToken) {
    return _json({ ok: false, error: 'QuickBooks is not connected yet', status: 'not_linked' });
  }

  // Gather the invoice + lines (tenant-scoped).
  var invoice = _findInvoice(ss, s.payload.tid, invoiceId);
  if (!invoice) return _json({ ok: false, error: 'Invoice not found' }, 404);
  var lines = _findInvoiceLines(ss, invoiceId);
  if (!lines.length) return _json({ ok: false, error: 'Invoice has no lines to push' });

  // Optional QBO customer mapping: the payer/requestor row may carry a
  // qbo_customer_ref the agency set in QuickBooks. Pass it through if present.
  var payer = _findPayerOrRequestor(ss, s.payload.tid, invoice.payer_id);
  var customerRef = String((payer && (payer.qbo_customer_ref || payer.qbo_customer_id)) || '');
  var customerName = String((payer && payer.display_name) || invoice.payer_id || '');

  var pushLines = lines.map(function (l) {
    return {
      description: String(l.description || 'Interpreting services'),
      amount_cents: Number(l.amount_cents || 0),
      quantity: l.quantity != null ? Number(l.quantity) : undefined,
      rate_cents: l.rate_cents != null ? Number(l.rate_cents) : undefined
    };
  });

  var res = _qboCallWorker_(ss, '/v1/qbo/push-invoice', {
    refresh_token: refreshToken,
    realm_id: realm,
    invoice: {
      invoice_id: invoiceId,
      invoice_number: invoice.invoice_number || '',
      customer_ref: customerRef,
      customer_name: customerName,
      due_date: invoice.due_at ? _invShortDate(invoice.due_at) : '',
      memo: 'Period ' + (invoice.period_start || '') + ' – ' + (invoice.period_end || ''),
      lines: pushLines
    }
  });

  if (!res.ok) {
    _logAudit('qbo.push_invoice_failed', s.payload.tid, s.payload.uid, invoiceId + ' ' + (res.error || ''));
    return _json({ ok: false, error: res.error || 'push_failed', status: res.status || '' });
  }

  // Intuit rotates the refresh token on each token call — persist the new one.
  if (res.refresh_token) _qboSetRefreshToken_(s.payload.tid, res.refresh_token);

  // Stamp the local invoice with the QBO id so the UI can show it / avoid dupes.
  _qboStampInvoiceQboId_(ss, s.payload.tid, invoiceId, res.qbo_invoice_id);

  _logAudit('qbo.push_invoice', s.payload.tid, s.payload.uid,
    invoiceId + ' → qbo_invoice_id=' + res.qbo_invoice_id);

  return _json({
    ok: true,
    qbo_invoice_id: res.qbo_invoice_id,
    qbo_doc_number: res.qbo_doc_number || ''
  });
}

/**
 * POST qbo_disconnect
 * Local "forget the link" — clear the Agencies row realm field and delete the
 * stored refresh token. The agency can also disconnect from QuickBooks'
 * side (Apps & connections) if they want the OAuth grant rescinded there.
 */
function apiQboDisconnect(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok: false, error: 'Owner or admin role required' }, 403);
  }
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var found = _connectFindAgencyByTenantId_(ss, s.payload.tid);
  if (found) _connectWriteAgencyFields_(found, { qbo_realm_id: '' });
  _qboDeleteRefreshToken_(s.payload.tid);
  _logAudit('qbo.local_disconnect', s.payload.tid, s.payload.uid, '');
  return _json({ ok: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stamp the QBO invoice id onto the local Invoice row if a qbo_invoice_id
 * column exists. The column is optional — we only write when present so we
 * never reorder or force-add a schema column from this hot path.
 */
function _qboStampInvoiceQboId_(ss, tenantId, invoiceId, qboInvoiceId) {
  var sh = ss.getSheetByName(T.Invoices);
  if (!sh) return;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return;
  var hdr = data[0];
  var iId = hdr.indexOf('invoice_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iQbo = hdr.indexOf('qbo_invoice_id');
  var iUpdated = hdr.indexOf('_updated_at');
  if (iId < 0 || iQbo < 0) return;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) !== String(invoiceId)) continue;
    if (iTenant >= 0 && String(data[r][iTenant]) !== String(tenantId)) continue;
    sh.getRange(r + 1, iQbo + 1).setValue(qboInvoiceId);
    if (iUpdated >= 0) sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
    return;
  }
}
