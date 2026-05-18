/**
 * 1891 Interpreter — Payment-gateway integration (Apps Script side).
 *
 * Adds payment integration ON TOP of Code_Invoicing.gs. Invoices and Payouts
 * stay the system of record; this file mediates the Stripe Connect Express,
 * Stripe invoice, track1099, and Plaid flows by calling the Cloudflare Worker
 * at WORKER_BASE.
 *
 * Implementations for the route stubs declared in Code.gs:
 *   GET  list_stripe_accounts, list_1099_forms, payment_setup_status
 *   POST connect_account_link, connect_account_refresh,
 *        payout_send, invoice_send, issue_1099_nec,
 *        setup_stripe_credentials, setup_track1099_credentials, setup_plaid_credentials
 *
 * Per-call audit rules (PRD E8.1):
 *  - Every Stripe/track1099/Plaid call writes an Audit_Log row with action +
 *    idempotency anchor (our local ID) + response status. We NEVER log API keys,
 *    card data, SSN, or bank PAN.
 *
 * Test-mode rule (per brief):
 *  - Anything that asks the Worker to talk to Stripe before STRIPE_API_KEY is
 *    set comes back with { status:'unconfigured' }. The UI shows a banner.
 *
 * Sheet additions (idempotent, applied on first call):
 *  - Interpreters: optional payment columns appended if missing
 *      stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled,
 *      stripe_details_submitted, last_1099_form_id, last_1099_tax_year
 *  - Payers: optional payment columns appended if missing
 *      (stripe_customer_id already in schema)
 *  - Settings keys (under category 'payments'):
 *      payments.stripe.platform_account_id, payments.stripe.publishable_key,
 *      payments.stripe.webhook_endpoint, payments.track1099.payer_id,
 *      payments.plaid.environment, payments.return_url_base
 */

// Worker base for internal calls. Defaults to the dev URL the rest of the
// project uses; override per-tenant via a Settings row 'payments.worker_base'.
var PAYMENTS_DEFAULT_WORKER_BASE = 'https://1891-interpreter-api.anthonymowl.workers.dev';

// Optional interpreters columns we add lazily.
var PAYMENT_INTERPRETER_COLS = [
  'stripe_account_id',
  'stripe_charges_enabled',
  'stripe_payouts_enabled',
  'stripe_details_submitted',
  'last_1099_form_id',
  'last_1099_tax_year'
];

// =============================================================================
// SHARED HELPERS
// =============================================================================

function _payWorkerBase(ss) {
  var v = _getSetting(ss, 'payments.worker_base');
  if (v) return String(v).replace(/\/$/, '');
  return PAYMENTS_DEFAULT_WORKER_BASE;
}

function _payInternalSecret() {
  var s = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
  if (!s) throw new Error('HMAC_SECRET not set. Run _rotate_hmac first.');
  return s;
}

/**
 * POST JSON to the Worker with the internal-auth header. Returns the parsed
 * response body, or { ok:false, error } on transport failure. Never throws.
 */
function _payCallWorker(ss, path, body) {
  var url = _payWorkerBase(ss) + path;
  var payload = JSON.stringify(body || {});
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: payload,
      muteHttpExceptions: true,
      headers: {
        'X-1891-Internal': _payInternalSecret()
      }
    });
    var code = res.getResponseCode();
    var text = res.getContentText();
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (_) { return { ok:false, error:'worker_non_json', http_status:code, body_excerpt:String(text).slice(0,200) }; }
    if (parsed && parsed.status === 'unconfigured') {
      // Surface as ok:false so the UI banner triggers, but keep the original message.
      return { ok:false, error: parsed.error || 'unconfigured', status: 'unconfigured' };
    }
    if (code < 200 || code >= 300) return { ok:false, error: parsed.error || ('http_' + code), http_status: code, detail: parsed };
    return parsed;
  } catch (err) {
    return { ok:false, error: 'worker_unreachable', detail: String(err) };
  }
}

function _payGetWorker(ss, path) {
  var url = _payWorkerBase(ss) + path;
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      headers: { 'X-1891-Internal': _payInternalSecret() }
    });
    var code = res.getResponseCode();
    var text = res.getContentText();
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (_) { return { ok:false, error:'worker_non_json', http_status:code }; }
    if (parsed && parsed.status === 'unconfigured') return { ok:false, error: parsed.error, status:'unconfigured' };
    if (code < 200 || code >= 300) return { ok:false, error: parsed.error || ('http_' + code) };
    return parsed;
  } catch (err) {
    return { ok:false, error: 'worker_unreachable', detail: String(err) };
  }
}

/**
 * Append payment-only columns to the Interpreters sheet if they aren't already
 * present. Returns the updated header. Safe to call every request.
 */
function _payEnsureInterpreterCols(ss) {
  var sh = ss.getSheetByName(T.Interpreters);
  if (!sh) return [];
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn() || 1).getValues()[0];
  var missing = PAYMENT_INTERPRETER_COLS.filter(function (c) { return hdr.indexOf(c) < 0; });
  if (!missing.length) return hdr;
  // Append to the right.
  for (var i = 0; i < missing.length; i++) {
    sh.getRange(1, sh.getLastColumn() + 1).setValue(missing[i]).setFontWeight('bold');
    hdr.push(missing[i]);
  }
  return hdr;
}

function _payFindInterpreterRow(ss, tenantId, interpreterId) {
  var sh = ss.getSheetByName(T.Interpreters);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iId = hdr.indexOf('interpreter_id');
  var iTenant = hdr.indexOf('tenant_id');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) === String(interpreterId) && String(data[r][iTenant]) === String(tenantId)) {
      return { row: r + 1, hdr: hdr, data: data[r], sh: sh };
    }
  }
  return null;
}

function _payWriteInterpreterField(found, field, value) {
  var idx = found.hdr.indexOf(field);
  if (idx < 0) {
    // The lazy-add path; rare since _payEnsureInterpreterCols should run first.
    found.sh.getRange(1, found.sh.getLastColumn() + 1).setValue(field).setFontWeight('bold');
    found.hdr.push(field);
    idx = found.hdr.length - 1;
  }
  found.sh.getRange(found.row, idx + 1).setValue(value);
}

function _paySettingsKeys() {
  return {
    stripe: [
      'payments.stripe.platform_account_id',
      'payments.stripe.publishable_key',
      'payments.stripe.webhook_endpoint'
    ],
    track1099: ['payments.track1099.payer_id'],
    plaid: ['payments.plaid.environment'],
    common: ['payments.worker_base', 'payments.return_url_base']
  };
}

function _payReturnUrlBase(ss) {
  var v = _getSetting(ss, 'payments.return_url_base');
  if (v) return String(v).replace(/\/$/, '');
  return SITE_BASE; // e.g. https://madeby1891.com/interpreter
}

function _payOnboardingUrls(ss, interpreterId) {
  var base = _payReturnUrlBase(ss);
  return {
    return_url: base + '/app/payments/connect.html?interpreter_id=' + encodeURIComponent(interpreterId) + '&return=true',
    refresh_url: base + '/app/payments/connect.html?interpreter_id=' + encodeURIComponent(interpreterId) + '&refresh=true'
  };
}

// =============================================================================
// GET endpoints
// =============================================================================

function apiListStripeAccounts(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _payEnsureInterpreterCols(ss);
  var sh = ss.getSheetByName(T.Interpreters);
  if (!sh) return _json({ ok:true, accounts: [] });
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, accounts: [] });
  var hdr = data[0];

  var iId = hdr.indexOf('interpreter_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iFirst = hdr.indexOf('legal_first');
  var iLast = hdr.indexOf('legal_last');
  var iStatus = hdr.indexOf('status');
  var iPayMethod = hdr.indexOf('payment_method');
  var iAcct = hdr.indexOf('stripe_account_id');
  var iCharges = hdr.indexOf('stripe_charges_enabled');
  var iPayouts = hdr.indexOf('stripe_payouts_enabled');
  var iDetails = hdr.indexOf('stripe_details_submitted');

  var accounts = [];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iTenant]) !== String(s.payload.tid)) continue;
    var acct = String(iAcct >= 0 ? data[r][iAcct] : '');
    var charges = iCharges >= 0 ? Boolean(data[r][iCharges]) : false;
    var payouts = iPayouts >= 0 ? Boolean(data[r][iPayouts]) : false;
    var details = iDetails >= 0 ? Boolean(data[r][iDetails]) : false;
    var state = 'not_started';
    if (acct) {
      if (charges && payouts) state = 'active';
      else if (details) state = 'pending';
      else state = 'started';
    }
    accounts.push({
      interpreter_id: String(data[r][iId]),
      display_name: ((data[r][iFirst] || '') + ' ' + (data[r][iLast] || '')).trim() || String(data[r][iId]),
      status: String(iStatus >= 0 ? data[r][iStatus] : ''),
      payment_method: String(iPayMethod >= 0 ? data[r][iPayMethod] : ''),
      stripe_account_id: acct,
      charges_enabled: charges,
      payouts_enabled: payouts,
      details_submitted: details,
      connect_state: state
    });
  }
  return _json({ ok:true, accounts: accounts });
}

function apiList1099Forms(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _payEnsureInterpreterCols(ss);
  var sh = ss.getSheetByName(T.Interpreters);
  if (!sh) return _json({ ok:true, forms: [] });
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, forms: [] });
  var hdr = data[0];

  var iId = hdr.indexOf('interpreter_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iFirst = hdr.indexOf('legal_first');
  var iLast = hdr.indexOf('legal_last');
  var iForm = hdr.indexOf('last_1099_form_id');
  var iYear = hdr.indexOf('last_1099_tax_year');

  // Sum paid payouts per interpreter for the prior calendar year (the year we'd 1099 for).
  var poSh = ss.getSheetByName(T.Payouts);
  var ytdByInterp = {};
  var thisYear = new Date().getUTCFullYear();
  var priorYear = thisYear - 1;
  if (poSh) {
    var pd = poSh.getDataRange().getValues();
    if (pd.length >= 2) {
      var ph = pd[0];
      var pInterp = ph.indexOf('interpreter_id');
      var pStatus = ph.indexOf('status');
      var pIssued = ph.indexOf('issued_at');
      var pTotal = ph.indexOf('total_cents');
      var pTenant = ph.indexOf('tenant_id');
      for (var i = 1; i < pd.length; i++) {
        if (String(pd[i][pTenant]) !== String(s.payload.tid)) continue;
        if (String(pd[i][pStatus]) !== 'paid') continue;
        var iso = pd[i][pIssued];
        if (!iso) continue;
        var y = new Date(iso).getUTCFullYear();
        if (y !== priorYear) continue;
        var key = String(pd[i][pInterp]);
        ytdByInterp[key] = (ytdByInterp[key] || 0) + Number(pd[i][pTotal] || 0);
      }
    }
  }

  var forms = [];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iTenant]) !== String(s.payload.tid)) continue;
    var id = String(data[r][iId]);
    var total = ytdByInterp[id] || 0;
    var formId = iForm >= 0 ? String(data[r][iForm] || '') : '';
    var year = iYear >= 0 ? Number(data[r][iYear] || 0) : 0;
    forms.push({
      interpreter_id: id,
      display_name: ((data[r][iFirst] || '') + ' ' + (data[r][iLast] || '')).trim() || id,
      tax_year: priorYear,
      total_paid_cents: total,
      meets_threshold: total >= 60000,         // $600
      form_id: formId,
      form_tax_year: year,
      status: formId ? 'issued' : (total >= 60000 ? 'pending' : 'below_threshold')
    });
  }
  return _json({ ok:true, forms: forms, tax_year: priorYear });
}

function apiPaymentSetupStatus(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);

  // Ask the Worker which keys are set (it knows; we don't store them).
  // We model this as a single internal probe per service. If the Worker
  // doesn't have the key, it returns { status:'unconfigured' } from the
  // shallowest endpoint of each service.
  var stripeProbe = _payCallWorker(ss, '/v1/stripe/account/refresh', { account_id: 'probe_no_op' });
  var track1099Probe = _payGetWorker(ss, '/v1/track1099/forms/probe_no_op');

  var stripeConfigured = !(stripeProbe && stripeProbe.status === 'unconfigured');
  var track1099Configured = !(track1099Probe && track1099Probe.status === 'unconfigured');
  // Plaid we don't probe (no internal route yet) — we just look at what the
  // admin configured locally as a hint flag.
  var plaidEnv = _getSetting(ss, 'payments.plaid.environment');
  var stripePub = _getSetting(ss, 'payments.stripe.publishable_key');
  var trackPayer = _getSetting(ss, 'payments.track1099.payer_id');

  return _json({
    ok: true,
    setup: {
      stripe: { configured: stripeConfigured, publishable_key_present: !!stripePub },
      track1099: { configured: track1099Configured, payer_id_present: !!trackPayer },
      plaid: { configured: !!plaidEnv, environment: plaidEnv || '' }
    },
    worker_base: _payWorkerBase(ss)
  });
}

// =============================================================================
// POST endpoints — Stripe Connect Express
// =============================================================================

function apiConnectAccountLink(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var p = e.parameter || {};
  if (!p.interpreter_id) return _json({ ok:false, error:'interpreter_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _payEnsureInterpreterCols(ss);
  var found = _payFindInterpreterRow(ss, s.payload.tid, p.interpreter_id);
  if (!found) return _json({ ok:false, error:'Interpreter not found' }, 404);
  var interp = _rowToObj(found.hdr, found.data);
  var email = _resolveInterpreterEmail(ss, interp);

  // Create or reuse Connect account.
  var accountId = String(interp.stripe_account_id || '');
  if (!accountId) {
    var created = _payCallWorker(ss, '/v1/stripe/account/create', {
      interpreter_id: p.interpreter_id,
      email: email
    });
    if (!created.ok) {
      _logAudit('stripe.account_create_failed', s.payload.tid, s.payload.uid, p.interpreter_id + ' ' + (created.error || ''));
      return _json({ ok:false, error: created.error || 'stripe_error', status: created.status || '' });
    }
    accountId = (created.account && created.account.id) || '';
    if (!accountId) return _json({ ok:false, error:'No account id returned' });
    _payWriteInterpreterField(found, 'stripe_account_id', accountId);
    _logAudit('stripe.account_created', s.payload.tid, s.payload.uid, p.interpreter_id + ' ' + accountId);
  }

  // Build onboarding link.
  var urls = _payOnboardingUrls(ss, p.interpreter_id);
  var linkRes = _payCallWorker(ss, '/v1/stripe/account/onboard', {
    account_id: accountId,
    return_url: urls.return_url,
    refresh_url: urls.refresh_url
  });
  if (!linkRes.ok) {
    _logAudit('stripe.account_link_failed', s.payload.tid, s.payload.uid, p.interpreter_id + ' ' + (linkRes.error || ''));
    return _json({ ok:false, error: linkRes.error || 'stripe_error' });
  }
  var url = linkRes.link && linkRes.link.url;
  _logAudit('stripe.account_link_created', s.payload.tid, s.payload.uid, p.interpreter_id);

  // Best-effort email the interpreter.
  if (email && url) {
    try {
      MailApp.sendEmail({
        to: email,
        subject: '1891 Interpreter — finish setting up your Stripe payout account',
        body:
          'Hi,\n\n' +
          'To receive payouts, please finish your Stripe Connect setup. The link below is one-time and expires shortly.\n\n' +
          url + '\n\n' +
          "If you've already completed onboarding, you can ignore this. — 1891 Interpreter"
      });
      _logCommunication(ss, s.payload.tid, 'email', 'out', 'stripe_onboard_v1', interp.user_id || '', email, 'sent', 'mailapp', '');
    } catch (err) {
      _logAudit('stripe.account_link_email_failed', s.payload.tid, s.payload.uid, String(err));
    }
  }

  return _json({ ok:true, account_id: accountId, onboarding_url: url, sent_to: email || '' });
}

function apiConnectAccountRefresh(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  if (!p.interpreter_id) return _json({ ok:false, error:'interpreter_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _payEnsureInterpreterCols(ss);
  var found = _payFindInterpreterRow(ss, s.payload.tid, p.interpreter_id);
  if (!found) return _json({ ok:false, error:'Interpreter not found' }, 404);
  var interp = _rowToObj(found.hdr, found.data);
  var accountId = String(interp.stripe_account_id || '');
  if (!accountId) return _json({ ok:false, error:'No Stripe account on file for this interpreter.' });

  var res = _payCallWorker(ss, '/v1/stripe/account/refresh', { account_id: accountId });
  if (!res.ok) return _json({ ok:false, error: res.error || 'stripe_error' });
  var a = res.account || {};
  _payWriteInterpreterField(found, 'stripe_charges_enabled', !!a.charges_enabled);
  _payWriteInterpreterField(found, 'stripe_payouts_enabled', !!a.payouts_enabled);
  _payWriteInterpreterField(found, 'stripe_details_submitted', !!a.details_submitted);
  if (a.payouts_enabled) {
    _payWriteInterpreterField(found, 'payment_method', 'stripe_connect_express');
  }
  _logAudit('stripe.account_refreshed', s.payload.tid, s.payload.uid, p.interpreter_id);
  return _json({
    ok:true,
    interpreter_id: p.interpreter_id,
    account_id: accountId,
    charges_enabled: !!a.charges_enabled,
    payouts_enabled: !!a.payouts_enabled,
    details_submitted: !!a.details_submitted,
    requirements: a.requirements || null
  });
}

// =============================================================================
// POST endpoints — invoice + payout send
// =============================================================================

function apiInvoiceSend(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var p = e.parameter || {};
  if (!p.invoice_id) return _json({ ok:false, error:'invoice_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var invSh = ss.getSheetByName(T.Invoices);
  if (!invSh) return _json({ ok:false, error:'No invoices yet' }, 404);
  var data = invSh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('invoice_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iStatus = hdr.indexOf('status');
  var iPayer = hdr.indexOf('payer_id');
  var iSubtotal = hdr.indexOf('subtotal_cents');
  var iStripe = hdr.indexOf('stripe_invoice_id');
  var iUpdated = hdr.indexOf('_updated_at');

  var rowIdx = -1;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) === p.invoice_id && String(data[r][iTenant]) === String(s.payload.tid)) {
      rowIdx = r; break;
    }
  }
  if (rowIdx < 0) return _json({ ok:false, error:'Invoice not found' }, 404);
  if (String(data[rowIdx][iStatus]) !== 'draft') {
    return _json({ ok:false, error:'Only draft invoices can be sent (status=' + data[rowIdx][iStatus] + ')' });
  }

  // Pull lines and payer info.
  var lines = _findInvoiceLines(ss, p.invoice_id).map(function (l) {
    return {
      description: l.description || '—',
      amount_cents: Number(l.amount_cents || 0),
      quantity: Number(l.quantity || 1)
    };
  });
  if (!lines.length) return _json({ ok:false, error:'Invoice has no lines' });

  var payerId = String(data[rowIdx][iPayer] || '');
  var payer = _findPayerOrRequestor(ss, s.payload.tid, payerId);

  var res = _payCallWorker(ss, '/v1/stripe/invoice/send', {
    invoice_id: p.invoice_id,
    payer_id: payerId,
    payer_email: payer.billing_email || '',
    payer_name: payer.display_name || '',
    stripe_customer_id: payer.stripe_customer_id || '',
    line_items: lines
  });
  if (!res.ok) {
    _logAudit('stripe.invoice_send_failed', s.payload.tid, s.payload.uid, p.invoice_id + ' ' + (res.error || ''));
    return _json({ ok:false, error: res.error || 'stripe_error', status: res.status || '' });
  }
  var stripeInvoiceId = (res.invoice && res.invoice.id) || '';
  if (stripeInvoiceId && iStripe >= 0) invSh.getRange(rowIdx + 1, iStripe + 1).setValue(stripeInvoiceId);
  invSh.getRange(rowIdx + 1, iStatus + 1).setValue('sent');
  if (iUpdated >= 0) invSh.getRange(rowIdx + 1, iUpdated + 1).setValue(new Date().toISOString());
  _logAudit('stripe.invoice_sent', s.payload.tid, s.payload.uid, p.invoice_id + ' ' + stripeInvoiceId);
  return _json({
    ok: true,
    invoice_id: p.invoice_id,
    stripe_invoice_id: stripeInvoiceId,
    stripe_customer_id: res.customer_id || '',
    hosted_invoice_url: res.invoice && res.invoice.hosted_invoice_url || ''
  });
}

function apiPayoutSend(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var p = e.parameter || {};
  if (!p.payout_id) return _json({ ok:false, error:'payout_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var poSh = ss.getSheetByName(T.Payouts);
  if (!poSh) return _json({ ok:false, error:'No payouts yet' }, 404);
  var data = poSh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('payout_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iStatus = hdr.indexOf('status');
  var iInterp = hdr.indexOf('interpreter_id');
  var iTotal = hdr.indexOf('total_cents');

  var rowIdx = -1;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) === p.payout_id && String(data[r][iTenant]) === String(s.payload.tid)) {
      rowIdx = r; break;
    }
  }
  if (rowIdx < 0) return _json({ ok:false, error:'Payout not found' }, 404);
  if (String(data[rowIdx][iStatus]) !== 'pending') {
    return _json({ ok:false, error:'Only pending payouts can be sent (status=' + data[rowIdx][iStatus] + ')' });
  }

  // Look up the interpreter's Connect destination.
  _payEnsureInterpreterCols(ss);
  var found = _payFindInterpreterRow(ss, s.payload.tid, String(data[rowIdx][iInterp]));
  if (!found) return _json({ ok:false, error:'Interpreter not found' }, 404);
  var interp = _rowToObj(found.hdr, found.data);
  var dest = String(interp.stripe_account_id || '');
  if (!dest) return _json({ ok:false, error:'Interpreter has no Stripe Connect account on file. Send onboarding link first.' });
  if (!interp.stripe_payouts_enabled) {
    return _json({ ok:false, error:'Stripe payouts not yet enabled for this interpreter (waiting on Stripe verification).' });
  }

  var res = _payCallWorker(ss, '/v1/stripe/transfer/send', {
    amount_cents: Number(data[rowIdx][iTotal] || 0),
    destination_account: dest,
    payout_id: p.payout_id
  });
  if (!res.ok) {
    _logAudit('stripe.payout_send_failed', s.payload.tid, s.payload.uid, p.payout_id + ' ' + (res.error || ''));
    return _json({ ok:false, error: res.error || 'stripe_error', status: res.status || '' });
  }
  var transferId = (res.transfer && res.transfer.id) || '';
  // Webhook transfer.paid will flip status to 'paid'. Until then, mark 'sent'.
  poSh.getRange(rowIdx + 1, iStatus + 1).setValue('sent');
  var iStripeTransfer = hdr.indexOf('stripe_transfer_id');
  if (iStripeTransfer >= 0 && transferId) poSh.getRange(rowIdx + 1, iStripeTransfer + 1).setValue(transferId);
  _logAudit('stripe.transfer_sent', s.payload.tid, s.payload.uid, p.payout_id + ' ' + transferId);
  return _json({ ok:true, payout_id: p.payout_id, stripe_transfer_id: transferId });
}

// =============================================================================
// POST endpoints — track1099
// =============================================================================

function apiIssue1099Nec(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var p = e.parameter || {};
  if (!p.interpreter_id) return _json({ ok:false, error:'interpreter_id required' });
  if (!p.tax_year) return _json({ ok:false, error:'tax_year required (e.g. 2026)' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _payEnsureInterpreterCols(ss);
  var found = _payFindInterpreterRow(ss, s.payload.tid, p.interpreter_id);
  if (!found) return _json({ ok:false, error:'Interpreter not found' }, 404);
  var interp = _rowToObj(found.hdr, found.data);

  // Sum paid payouts in that tax year (cents).
  var poSh = ss.getSheetByName(T.Payouts);
  var totalCents = 0;
  if (poSh) {
    var pd = poSh.getDataRange().getValues();
    if (pd.length >= 2) {
      var ph = pd[0];
      var pInterp = ph.indexOf('interpreter_id');
      var pStatus = ph.indexOf('status');
      var pIssued = ph.indexOf('issued_at');
      var pTotal = ph.indexOf('total_cents');
      var pTenant = ph.indexOf('tenant_id');
      for (var i = 1; i < pd.length; i++) {
        if (String(pd[i][pTenant]) !== String(s.payload.tid)) continue;
        if (String(pd[i][pInterp]) !== String(p.interpreter_id)) continue;
        if (String(pd[i][pStatus]) !== 'paid') continue;
        if (!pd[i][pIssued]) continue;
        var y = new Date(pd[i][pIssued]).getUTCFullYear();
        if (y !== Number(p.tax_year)) continue;
        totalCents += Number(pd[i][pTotal] || 0);
      }
    }
  }
  if (totalCents < 60000) {
    return _json({ ok:false, error: 'Below IRS $600 threshold (' + (totalCents/100).toFixed(2) + ').' });
  }

  // We DO NOT have the interpreter's TIN/address in the schema yet; for v1 we
  // accept them off the form, and remind the admin that the data is collected
  // by Stripe Connect (the recommended source per E4.3). The Apps Script form
  // can pre-fill from Stripe via Stripe's `/account/<id>/persons` endpoint
  // when needed — left as TODO for the orchestrator.
  var recipient = {
    name: ((interp.legal_first || '') + ' ' + (interp.legal_last || '')).trim(),
    tin: String(p.tin || ''),
    tin_type: String(p.tin_type || 'SSN'),
    email: _resolveInterpreterEmail(ss, interp),
    address1: String(p.address1 || ''),
    address2: String(p.address2 || ''),
    city: String(p.city || ''),
    state: String(p.state || ''),
    zip: String(p.zip || ''),
    country: String(p.country || 'US')
  };
  if (!recipient.name || !recipient.tin || !recipient.address1 || !recipient.city || !recipient.state || !recipient.zip) {
    return _json({ ok:false, error:'Recipient name, tin, address1, city, state, zip required.' });
  }

  var payerId = _getSetting(ss, 'payments.track1099.payer_id');
  var res = _payCallWorker(ss, '/v1/track1099/forms/create', {
    tax_year: Number(p.tax_year),
    payer_id_in_track1099: payerId || '',
    recipient: recipient,
    nonemployee_comp_cents: totalCents,
    federal_income_tax_withheld_cents: Number(p.federal_income_tax_withheld_cents || 0),
    interpreter_id: p.interpreter_id,
    tenant_id: s.payload.tid
  });
  if (!res.ok) {
    _logAudit('track1099.form_create_failed', s.payload.tid, s.payload.uid, p.interpreter_id + ' ' + (res.error || ''));
    return _json({ ok:false, error: res.error || 'track1099_error', status: res.status || '' });
  }
  var formId = (res.form && res.form.id) || '';
  if (formId) {
    _payWriteInterpreterField(found, 'last_1099_form_id', formId);
    _payWriteInterpreterField(found, 'last_1099_tax_year', Number(p.tax_year));
  }
  _logAudit('track1099.form_created', s.payload.tid, s.payload.uid, p.interpreter_id + ' year=' + p.tax_year + ' form=' + formId);
  return _json({ ok:true, interpreter_id: p.interpreter_id, form_id: formId, tax_year: Number(p.tax_year), total_paid_cents: totalCents });
}

// =============================================================================
// POST endpoints — credentials setup
// =============================================================================
//
// These wrap update_setting with a category and a guard on the role. The
// actual key→value writes go through the Settings tab the way every other
// admin setting does. We do NOT take the live API key here — that goes via
// `wrangler secret put` (see README). What we accept here is publishable /
// public configuration: Stripe publishable key, track1099 payer_id, Plaid
// environment + client_id.

function _payRequireAdmin(s) {
  return s.payload.role === 'role_owner' || s.payload.role === 'role_admin';
}

function apiSetupStripeCredentials(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (!_payRequireAdmin(s)) return _json({ ok:false, error:'Owner or admin role required' }, 403);
  var p = e.parameter || {};
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var keys = _paySettingsKeys().stripe.concat(['payments.worker_base', 'payments.return_url_base']);
  keys.forEach(function (k) {
    var short = k.replace('payments.', '').replace(/\./g, '_');
    if (p[short] !== undefined) _updateSettingDirect(ss, s, k, p[short], 'payments');
  });
  _logAudit('payments.stripe_setup', s.payload.tid, s.payload.uid, '');
  return _json({ ok:true });
}

function apiSetupTrack1099Credentials(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (!_payRequireAdmin(s)) return _json({ ok:false, error:'Owner or admin role required' }, 403);
  var p = e.parameter || {};
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _paySettingsKeys().track1099.forEach(function (k) {
    var short = k.replace('payments.', '').replace(/\./g, '_');
    if (p[short] !== undefined) _updateSettingDirect(ss, s, k, p[short], 'payments');
  });
  _logAudit('payments.track1099_setup', s.payload.tid, s.payload.uid, '');
  return _json({ ok:true });
}

function apiSetupPlaidCredentials(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (!_payRequireAdmin(s)) return _json({ ok:false, error:'Owner or admin role required' }, 403);
  var p = e.parameter || {};
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _paySettingsKeys().plaid.forEach(function (k) {
    var short = k.replace('payments.', '').replace(/\./g, '_');
    if (p[short] !== undefined) _updateSettingDirect(ss, s, k, p[short], 'payments');
  });
  _logAudit('payments.plaid_setup', s.payload.tid, s.payload.uid, '');
  return _json({ ok:true });
}

/**
 * Same as apiUpdateSetting but we're already inside a session-checked context,
 * so we don't re-verify and we always write the category we picked.
 */
function _updateSettingDirect(ss, s, key, value, category) {
  _ensureTab(ss, T.Settings, _tenantSchema().Settings);
  var sh = ss.getSheetByName(T.Settings);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iKey = hdr.indexOf('key');
  var iValue = hdr.indexOf('value');
  var iCategory = hdr.indexOf('category');
  var iUpdated = hdr.indexOf('updated_at');
  var iUpdatedBy = hdr.indexOf('updated_by_user_id');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iKey]) === String(key)) {
      sh.getRange(r + 1, iValue + 1).setValue(value || '');
      if (iCategory >= 0) sh.getRange(r + 1, iCategory + 1).setValue(category || 'misc');
      if (iUpdated >= 0) sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
      if (iUpdatedBy >= 0) sh.getRange(r + 1, iUpdatedBy + 1).setValue(s.payload.uid);
      return;
    }
  }
  var now = new Date().toISOString();
  sh.appendRow([key, value || '', category || 'misc', s.payload.uid, now, now, now]);
}

// =============================================================================
// Webhook callback — the Worker reaches this via the proxy with X-1891-Internal.
// We expose it on the existing /v1/proxy/exec path so it lives inside the
// session-less doPost dispatch. The action is `mark_payout_paid` (already
// declared in Code.gs). Same for `mark_invoice_paid`. Apps Script's existing
// handlers already exist and don't need session if called with the internal
// header — but those handlers DO require a session today. So we accept the
// internal header here and synthesize a session.
//
// NOTE FOR ORCHESTRATOR: The router wiring in Code.gs will need a small tweak:
// at the top of doPost, if e.parameter._internal === '1' AND a header check
// passes, treat the call as authorized. Implementing that header check from
// inside Apps Script requires reading e.postData.headers (not exposed) — so
// for v1, the Worker sends both the header AND a `session=<synthesized
// internal token>` query param. We provide the helper below.

function _payMintInternalSession(tenantId) {
  // Reuse the same minter as user sessions. The 'role' is a synthetic
  // 'role_internal' that's permitted to call mark_*_paid only via the
  // dedicated `_internal=1` flag at the top of those handlers. The actual
  // role-gate lives in the apiMark*Paid functions — they already accept any
  // session today, so no additional gate is needed beyond signature.
  return _mintSession({ uid: 'system_stripe_webhook', tid: tenantId, role: 'role_internal', email: '' });
}
