// 1891 Interpreter — payments client wrappers.
// Reads via IntApi.jsonp; writes via the same opaque no-cors POST pattern as
// api-invoices.js. Exposed as window.IntApiPayments — does NOT modify IntApi.
(function (root) {
  'use strict';
  if (!root.IntApi || typeof root.IntApi.jsonp !== 'function') {
    console.warn('[api-payments] IntApi not loaded yet — payment wrappers unavailable.');
    return;
  }

  var jsonp = root.IntApi.jsonp;
  var ENDPOINT = root.IntApi.ENDPOINT;
  function getSession() { return root.IntApi.getSession(); }

  function _params(action, fields) {
    var p = new URLSearchParams();
    if (action) p.append('action', action);
    Object.keys(fields || {}).forEach(function (k) {
      var v = fields[k];
      if (v === null || v === undefined || v === '') return;
      p.append(k, String(v));
    });
    var s = getSession();
    if (s) p.append('session', s);
    return p;
  }

  function _post(action, fields) {
    return fetch(ENDPOINT, {
      method: 'POST',
      body: _params(action, fields),
      redirect: 'follow',
      mode: 'no-cors'
    });
  }

  // ---- Reads ----
  function listStripeAccounts()    { return jsonp({ action: 'list_stripe_accounts' }); }
  function list1099Forms()         { return jsonp({ action: 'list_1099_forms' }); }
  function paymentSetupStatus()    { return jsonp({ action: 'payment_setup_status' }); }

  // ---- Writes that need a JSON response — we use jsonp on the matching GET
  //      handler at the orchestrator's wiring time. For now, these are POST-only
  //      from the page's standpoint; the page refreshes after the write.
  function connectAccountLink(interpreterId) {
    return _post('connect_account_link', { interpreter_id: interpreterId });
  }
  function connectAccountRefresh(interpreterId) {
    return _post('connect_account_refresh', { interpreter_id: interpreterId });
  }
  function payoutSend(payoutId) {
    return _post('payout_send', { payout_id: payoutId });
  }
  function invoiceSend(invoiceId) {
    return _post('invoice_send', { invoice_id: invoiceId });
  }
  function issue1099Nec(fields) {
    return _post('issue_1099_nec', fields || {});
  }
  function setupStripeCredentials(fields) {
    return _post('setup_stripe_credentials', fields || {});
  }
  function setupTrack1099Credentials(fields) {
    return _post('setup_track1099_credentials', fields || {});
  }
  function setupPlaidCredentials(fields) {
    return _post('setup_plaid_credentials', fields || {});
  }

  // ---- Helpers ----
  function formatCents(c) {
    var n = Number(c || 0) / 100;
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }
  function connectStateLabel(state) {
    return ({
      not_started: 'Not started',
      started: 'Started',
      pending: 'Pending verification',
      active: 'Active',
      restricted: 'Restricted'
    })[state] || state;
  }

  root.IntApiPayments = {
    listStripeAccounts: listStripeAccounts,
    list1099Forms: list1099Forms,
    paymentSetupStatus: paymentSetupStatus,
    connectAccountLink: connectAccountLink,
    connectAccountRefresh: connectAccountRefresh,
    payoutSend: payoutSend,
    invoiceSend: invoiceSend,
    issue1099Nec: issue1099Nec,
    setupStripeCredentials: setupStripeCredentials,
    setupTrack1099Credentials: setupTrack1099Credentials,
    setupPlaidCredentials: setupPlaidCredentials,
    formatCents: formatCents,
    connectStateLabel: connectStateLabel
  };
})(window);
