// 1891 Interpreter — client-side API helper.
// Talks to the Apps Script web app. Session is stored in localStorage.
(function (root) {
  'use strict';

  // Cloudflare Worker proxy (adds CORS headers, lets us read POST responses).
  // Falls through to the Apps Script /exec under the hood; same query-string
  // and form-body contract. JSONP still works against this URL too.
  var ENDPOINT = 'https://1891-interpreter-api.anthonymowl.workers.dev/v1/proxy/exec';
  var STORAGE = '1891int.session';

  function getSession() { try { return localStorage.getItem(STORAGE) || ''; } catch (_) { return ''; } }
  function setSession(s) { try { localStorage.setItem(STORAGE, s); } catch (_) {} }
  function clearSession() { try { localStorage.removeItem(STORAGE); } catch (_) {} }

  function _params(action, fields) {
    var p = new URLSearchParams();
    if (action) p.append('action', action);
    Object.keys(fields || {}).forEach(function (k) {
      var v = fields[k];
      if (v === null || v === undefined) return;
      if (Array.isArray(v)) v.forEach(function (x) { p.append(k, String(x)); });
      else p.append(k, String(v));
    });
    var s = getSession();
    if (s) p.append('session', s);
    return p;
  }

  // GET (Apps Script web apps accept query strings on GET).
  // We use POST for everything (no-cors limitation prevents reading GET responses anyway),
  // but mark intent via the `action` param.
  function _post(action, fields) {
    // No-cors POST: fire-and-forget for write actions, then a follow-up GET for reads via JSONP-style.
    // Apps Script returns text/plain JSON on its content service; we use fetch with cors mode
    // through script.googleusercontent.com — that DOES allow reading the response body.
    var body = _params(action, fields);
    return fetch(ENDPOINT, {
      method: 'POST',
      body: body,
      redirect: 'follow',
      // Apps Script POST returns 302 → googleusercontent.com → 200 JSON. Browsers follow this
      // for same-origin and for "no-cors", but cross-origin CORS mode is rejected by AS.
      // So: we use `text/plain` content type via URLSearchParams (no preflight), no-cors,
      // and rely on a sibling GET via JSONP for reads.
      mode: 'no-cors'
    });
  }

  // For reads we use JSONP. Apps Script web apps don't return CORS headers, so we can't
  // read cross-origin fetch responses. JSONP via a <script> tag does work because
  // <script src=...> is allowed cross-origin and the server can wrap JSON in a callback.
  // Apps Script lets us return arbitrary text via ContentService — we'll have the server
  // accept a `callback` query param and wrap accordingly. (See _jsonpResponse on server.)
  //
  // For v1 simplicity, we tag every API call with a sequence number and use a hidden iframe
  // POST then read the iframe's contents — which would require same-origin. That doesn't work
  // either. So: actual approach is `script.googleusercontent.com` returns text/plain JSON.
  // We use fetch with mode:'cors' explicitly; browsers will reject it BUT — Apps Script web
  // apps return `Access-Control-Allow-Origin: *` in the final response from googleusercontent.
  // Actually they don't; we need JSONP.
  //
  // SIMPLEST working pattern: opaque POST for writes; for reads, the page calls a Worker
  // (deferred). For now reads via the API helper return optimistic results and re-poll the
  // server-side state by checking the Sheet directly via a refresh button.

  function authRequest(email) {
    return _post('auth_request', { email: email });
  }
  function authVerify(token) {
    // For auth_verify we NEED the response. Use JSONP since fetch can't read.
    return jsonp({ action: 'auth_verify', token: token });
  }
  function whoami() {
    return jsonp({ action: 'whoami' });
  }
  function listJobs(status) {
    return jsonp({ action: 'list_jobs', status: status || '' });
  }
  function getJob(id) {
    return jsonp({ action: 'get_job', id: id });
  }
  function createJob(fields) {
    return _post('create_job', fields);
  }
  function claimJob(jobId) {
    return _post('claim_job', { job_id: jobId });
  }
  function cancelJob(jobId, reason) {
    return _post('cancel_job', { job_id: jobId, reason: reason || '' });
  }
  function cancelJobQuote(jobId) {
    return jsonp({ action: 'cancel_job_quote', job_id: jobId });
  }
  function smartFill(jobId) {
    return jsonp({ action: 'smart_fill', job_id: jobId, method: 'post_via_jsonp' });
  }

  // JSONP helper: appends a callback query param, server wraps response in callback(json).
  // The server needs to support this; if not, we'll fallback to a GET-with-redirect-readable path.
  function jsonp(params) {
    return new Promise(function (resolve, reject) {
      var name = '__cb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      var script = document.createElement('script');
      var timeout = setTimeout(function () {
        cleanup();
        reject(new Error('JSONP timeout'));
      }, 30000);
      function cleanup() {
        clearTimeout(timeout);
        if (script.parentNode) script.parentNode.removeChild(script);
        try { delete window[name]; } catch (_) { window[name] = undefined; }
      }
      window[name] = function (data) {
        cleanup();
        resolve(data);
      };
      var q = new URLSearchParams();
      Object.keys(params).forEach(function (k) {
        if (params[k] !== null && params[k] !== undefined && params[k] !== '') q.append(k, params[k]);
      });
      q.append('callback', name);
      var s = getSession();
      if (s) q.append('session', s);
      script.src = ENDPOINT + '?' + q.toString();
      script.onerror = function () {
        cleanup();
        reject(new Error('JSONP load error'));
      };
      document.head.appendChild(script);
    });
  }

  function listInterpreters() { return jsonp({ action: 'list_interpreters' }); }
  function listRequestors()   { return jsonp({ action: 'list_requestors' }); }
  function listSettings()     { return jsonp({ action: 'list_settings' }); }
  function listAssignments(jobId)   { return jsonp({ action: 'list_assignments', job_id: jobId || '' }); }
  function listJobEvents(jobId)     { return jsonp({ action: 'list_job_events', job_id: jobId }); }
  function listCommunications(jobId){ return jsonp({ action: 'list_communications', job_id: jobId || '' }); }
  function createInterpreter(fields) { return _post('create_interpreter', fields); }
  function updateInterpreter(fields) { return _post('update_interpreter', fields); }
  function createRequestor(fields)   { return _post('create_requestor', fields); }
  function updateAgency(fields)      { return _post('update_agency', fields); }
  function updateSetting(key, value, category) {
    return _post('update_setting', { key: key, value: value, category: category || '' });
  }
  function offerJob(jobId, interpreterId, role) {
    return _post('offer_job', { job_id: jobId, interpreter_id: interpreterId, role_on_job: role || 'primary' });
  }
  function confirmJob(jobId)  { return _post('confirm_job',  { job_id: jobId }); }
  function startJob(jobId)    { return _post('start_job',    { job_id: jobId }); }
  function completeJob(jobId, actualEnd) {
    return _post('complete_job', { job_id: jobId, actual_end: actualEnd || '' });
  }
  function aiIntake(text)     { return jsonp({ action: 'ai_intake', text: text }); }
  function testAnthropic()    { return jsonp({ action: 'test_anthropic' }); }

  // CORS-mode POST that READS the response — needed when the caller wants the
  // server's reply body. The Worker proxy adds Access-Control-Allow-Origin so
  // cross-origin reads work from madeby1891.com. The `_post` above is fire-
  // and-forget (no-cors) and stays around for write actions that don't need
  // the response.
  function _postCors(action, fields) {
    var body = _params(action, fields);
    return fetch(ENDPOINT, {
      method: 'POST',
      body: body,
      mode: 'cors',
      headers: { 'Accept': 'application/json' }
    }).then(function (r) { return r.json(); });
  }

  // Close-out (v18.2)
  function closeOutJob(fields)      { return _postCors('closeout_job', fields); }
  function uploadReceipt(fields)    { return _postCors('upload_receipt', fields); }
  function disputeCloseout(fields)  { return _postCors('dispute_closeout', fields); }
  function updateExpenseStatus(fields) { return _postCors('update_expense_status', fields); }
  function listJobExpenses(jobId)   { return jsonp({ action: 'list_job_expenses', job_id: jobId }); }
  function receiptUrl(driveId) {
    return ENDPOINT + '?action=get_receipt&id=' + encodeURIComponent(driveId) + '&session=' + encodeURIComponent(getSession());
  }

  // Clients (v18)
  function listClients(status)      { return jsonp({ action: 'list_clients', status: status || '' }); }
  function getClient(clientId)      { return jsonp({ action: 'get_client', id: clientId }); }
  function createClient(fields)     { return _post('create_client', fields); }
  function updateClient(fields)     { return _post('update_client', fields); }
  function upsertClientContact(fields)  { return _post('upsert_client_contact', fields); }
  function upsertSpecialist(fields)     { return _post('upsert_specialist', fields); }
  function updateClientBillingRules(fields) { return _post('update_client_billing_rules', fields); }

  // Admin — audit log read-back. `params` may include tenant_id, from, to,
  // user_id, action_filter (note: NOT `action` — that's the dispatch key),
  // and limit. All optional; backend has sane defaults.
  function listAuditLog(params) {
    var q = { action: 'list_audit_log' };
    if (params) {
      if (params.tenant_id)     q.tenant_id     = params.tenant_id;
      if (params.from)          q.from          = params.from;
      if (params.to)            q.to            = params.to;
      if (params.user_id)       q.user_id       = params.user_id;
      if (params.action_filter) q.action_filter = params.action_filter;
      if (params.limit)         q.limit         = params.limit;
    }
    return jsonp(q);
  }

  root.IntApi = {
    ENDPOINT: ENDPOINT,
    getSession: getSession,
    setSession: setSession,
    clearSession: clearSession,
    authRequest: authRequest,
    authVerify: authVerify,
    whoami: whoami,
    listJobs: listJobs,
    getJob: getJob,
    createJob: createJob,
    claimJob: claimJob,
    cancelJob: cancelJob,
    cancelJobQuote: cancelJobQuote,
    smartFill: smartFill,
    listInterpreters: listInterpreters,
    listRequestors: listRequestors,
    listSettings: listSettings,
    listAssignments: listAssignments,
    listJobEvents: listJobEvents,
    listCommunications: listCommunications,
    createInterpreter: createInterpreter,
    updateInterpreter: updateInterpreter,
    createRequestor: createRequestor,
    updateAgency: updateAgency,
    updateSetting: updateSetting,
    offerJob: offerJob,
    confirmJob: confirmJob,
    startJob: startJob,
    completeJob: completeJob,
    aiIntake: aiIntake,
    testAnthropic: testAnthropic,
    listClients: listClients,
    getClient: getClient,
    createClient: createClient,
    updateClient: updateClient,
    upsertClientContact: upsertClientContact,
    upsertSpecialist: upsertSpecialist,
    updateClientBillingRules: updateClientBillingRules,
    listAuditLog: listAuditLog,
    closeOutJob: closeOutJob,
    uploadReceipt: uploadReceipt,
    disputeCloseout: disputeCloseout,
    updateExpenseStatus: updateExpenseStatus,
    listJobExpenses: listJobExpenses,
    receiptUrl: receiptUrl,
    jsonp: jsonp
  };
})(window);
