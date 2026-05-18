// 1891 Interpreter — invoicing + payouts client wrappers.
// Reuses IntApi.jsonp (reads) and the same POST endpoint pattern via fetch.
// Exposed as window.IntApiInvoices — does NOT modify window.IntApi.
(function (root) {
  'use strict';
  if (!root.IntApi || typeof root.IntApi.jsonp !== 'function') {
    console.warn('[api-invoices] IntApi not loaded yet — invoicing wrappers unavailable.');
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

  // Writes: opaque POST (we can't read the response cross-origin).
  function _post(action, fields) {
    return fetch(ENDPOINT, {
      method: 'POST',
      body: _params(action, fields),
      redirect: 'follow',
      mode: 'no-cors'
    });
  }

  // Writes that need a response (preview / dry-run): use jsonp via GET.
  // Apps Script routes most write actions only via POST, but jsonp's create_*
  // dry_run path is read-only on the server side. We POST for true writes and
  // use jsonp for dry-runs by reusing the GET endpoints where they exist.
  // For dry_run we tunnel through the POST → since no-cors won't return JSON,
  // we expose a dedicated jsonp path: callers ask via dryRunInvoice() / dryRunPayout()
  // and we hit the corresponding GET route (list_invoices won't help us here).
  // Workaround: server's apiCreateInvoice supports dry_run=true; we POST it
  // and rely on the page refreshing the list. For inline preview UX, we
  // additionally support reading via jsonp by reusing the same handler — the
  // server file dispatches the same fn from doGet via _safeCall route if added
  // by the orchestrator. For MVP, dry-run uses _post and the UI shows a
  // synthesized client-side preview (job count guard) — full preview lands
  // when the orchestrator adds GET routes for create_invoice/create_payout dry-runs.

  // ---- Invoices ----
  function listInvoices()       { return jsonp({ action: 'list_invoices' }); }
  function getInvoice(id)       { return jsonp({ action: 'get_invoice', id: id }); }
  function createInvoice(fields){ return _post('create_invoice', fields); }
  function previewInvoice(fields){ // dry_run via jsonp (server returns lines)
    var p = Object.assign({ action: 'create_invoice', dry_run: 'true' }, fields || {});
    return jsonp(p);
  }
  function updateInvoice(fields){ return _post('update_invoice', fields); }
  function markInvoicePaid(invoiceId, paidAt) {
    return _post('mark_invoice_paid', { invoice_id: invoiceId, paid_at: paidAt || '' });
  }
  function voidInvoice(invoiceId, reason) {
    return _post('void_invoice', { invoice_id: invoiceId, reason: reason || '' });
  }

  // ---- Payouts ----
  function listPayouts()        { return jsonp({ action: 'list_payouts' }); }
  function getPayout(id)        { return jsonp({ action: 'get_payout', id: id }); }
  function createPayout(fields) { return _post('create_payout', fields); }
  function previewPayout(fields){
    var p = Object.assign({ action: 'create_payout', dry_run: 'true' }, fields || {});
    return jsonp(p);
  }
  function markPayoutPaid(payoutId, paidAt, stripeTransferId) {
    return _post('mark_payout_paid', {
      payout_id: payoutId,
      paid_at: paidAt || '',
      stripe_transfer_id: stripeTransferId || ''
    });
  }

  // ---- Helpers shared by the invoice/payout pages ----
  function formatCents(c) {
    var n = Number(c || 0) / 100;
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }
  function formatShortDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  root.IntApiInvoices = {
    listInvoices: listInvoices,
    getInvoice: getInvoice,
    createInvoice: createInvoice,
    previewInvoice: previewInvoice,
    updateInvoice: updateInvoice,
    markInvoicePaid: markInvoicePaid,
    voidInvoice: voidInvoice,
    listPayouts: listPayouts,
    getPayout: getPayout,
    createPayout: createPayout,
    previewPayout: previewPayout,
    markPayoutPaid: markPayoutPaid,
    formatCents: formatCents,
    formatShortDate: formatShortDate
  };
})(window);
