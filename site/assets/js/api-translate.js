// 1891 Interpreter — document translation client wrappers.
// Exposed as window.IntApiTranslate — does NOT modify window.IntApi.
//
// Reads go through IntApi.jsonp (Apps Script script.google.com is CORS-blocked
// for fetch). Writes go through opaque POST. Worker translation endpoints
// (/v1/translate/*) are reached via fetch through the Worker proxy host —
// CORS is set there in workers/api/src/cors.ts.
(function (root) {
  'use strict';
  if (!root.IntApi || typeof root.IntApi.jsonp !== 'function') {
    console.warn('[api-translate] IntApi not loaded yet — translation wrappers unavailable.');
    return;
  }

  var jsonp = root.IntApi.jsonp;
  var ENDPOINT = root.IntApi.ENDPOINT;

  // The worker base is the Apps Script proxy host minus the /v1/proxy/exec
  // suffix — the same Worker handles /v1/translate/* on the same origin.
  var WORKER_BASE = (function () {
    try {
      var u = new URL(ENDPOINT);
      return u.protocol + '//' + u.host;
    } catch (_) {
      return '';
    }
  })();

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

  // Writes: opaque POST through the Apps Script proxy (no-cors).
  function _post(action, fields) {
    return fetch(ENDPOINT, {
      method: 'POST',
      body: _params(action, fields),
      redirect: 'follow',
      mode: 'no-cors'
    });
  }

  // ---- Documents + translation jobs (Apps Script) ----
  function listDocuments(kind) {
    return jsonp({ action: 'list_documents', kind: kind || '' });
  }
  function getDocument(id) {
    return jsonp({ action: 'get_document', id: id });
  }
  function createTranslationJob(fields) {
    // Returns no body (no-cors). UI re-polls listDocuments() to surface the new row.
    return _post('create_translation_job', fields);
  }
  function startTranslation(jobId, interpreterId) {
    return _post('start_translation', { job_id: jobId, interpreter_id: interpreterId || '' });
  }
  function submitTranslationReview(jobId, translatedText) {
    return _post('submit_translation_review', { job_id: jobId, translated_text: translatedText });
  }
  function approveTranslation(jobId) {
    return _post('approve_translation', { job_id: jobId });
  }
  function rejectTranslation(jobId, notes) {
    return _post('reject_translation', { job_id: jobId, notes: notes || '' });
  }
  function cancelTranslation(jobId, reason) {
    return _post('cancel_translation', { job_id: jobId, reason: reason || '' });
  }
  // Download is a GET-with-session that returns an HTML PDF wrapper. The page
  // uses this as an href on the "Download PDF" anchor; no fetch needed.
  function downloadUrl(jobId) {
    var s = encodeURIComponent(getSession() || '');
    return ENDPOINT + '?action=download_translation&id=' + encodeURIComponent(jobId) + '&session=' + s;
  }

  // ---- Worker endpoints (CORS-enabled) ----
  function prefill(documentId, sourceLang, targetLang, sourceText, serviceType) {
    if (!WORKER_BASE) return Promise.reject(new Error('Worker base not configured'));
    return fetch(WORKER_BASE + '/v1/translate/prefill?session=' + encodeURIComponent(getSession() || ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        document_id: documentId || '',
        source_lang: sourceLang,
        target_lang: targetLang,
        source_text: sourceText,
        service_type: serviceType
      })
    }).then(function (r) { return r.json(); });
  }

  function glossary(sourceLang, targetLang) {
    if (!WORKER_BASE) return Promise.reject(new Error('Worker base not configured'));
    var q = new URLSearchParams({
      source: sourceLang || '',
      target: targetLang || '',
      session: getSession() || ''
    });
    return fetch(WORKER_BASE + '/v1/translate/glossary?' + q.toString(), {
      method: 'GET'
    }).then(function (r) { return r.json(); });
  }

  // ---- Shared helpers ----
  function statusLabel(status) {
    return ({
      REQUESTED: 'Requested',
      IN_TRANSLATION: 'In translation',
      IN_REVIEW: 'In review',
      APPROVED: 'Approved',
      DELIVERED: 'Delivered',
      CANCELLED_BY_AGENCY: 'Cancelled',
      REJECTED_TO_TRANSLATOR: 'Sent back'
    })[String(status || '').toUpperCase()] || String(status || '');
  }

  function isHardGated(serviceType) {
    return ({ 'medical':1, 'mental-health':1, 'legal':1, 'gov':1 })[String(serviceType || '')] === 1;
  }

  function shortIso(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  root.IntApiTranslate = {
    listDocuments: listDocuments,
    getDocument: getDocument,
    createTranslationJob: createTranslationJob,
    startTranslation: startTranslation,
    submitTranslationReview: submitTranslationReview,
    approveTranslation: approveTranslation,
    rejectTranslation: rejectTranslation,
    cancelTranslation: cancelTranslation,
    downloadUrl: downloadUrl,
    prefill: prefill,
    glossary: glossary,
    statusLabel: statusLabel,
    isHardGated: isHardGated,
    shortIso: shortIso,
    WORKER_BASE: WORKER_BASE
  };
})(window);
