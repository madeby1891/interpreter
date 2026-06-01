// ============================================================================
// Code_LiveBoard.gs — server-to-server hook into the Cloudflare Worker so the
// day-of board (and any future surface) gets push updates whenever a job's
// state changes.
//
// The Worker hosts a per-tenant `JobBoardRoom` Durable Object. Every browser
// subscribed to /v1/jobs/ws for that tenant gets the broadcast immediately.
// Tenant isolation is enforced on the Worker side: the DO id is derived from
// `tenant:${tenant_id}`, and a subscriber's tenant is pulled from the verified
// JWT — so tenant A's subscribers never receive tenant B's broadcasts.
//
// Design notes:
//  - This helper NEVER blocks the user. Every UrlFetch is wrapped in try/catch
//    and uses muteHttpExceptions=true. A failure is logged via _logAudit and
//    swallowed.
//  - We do NOT change the signature of any apiXxx function. The existing
//    function returns _json(…) as before, and a small wrapper next to each
//    state-mutating endpoint fires the notify just before the return.
//  - The auth header is `X-1891-Internal: <HMAC_SECRET>` to match the rest of
//    the internal API (Stripe, Track1099). The Worker accepts both this and
//    the legacy `X-1891-Secret` header for back-compat.
// ============================================================================

// Worker base URL. The notify endpoint is at WORKER_BASE + '/v1/notify/job'.
// Same hostname the client uses for the proxy (api.js -> ENDPOINT), minus the
// /v1/proxy/exec suffix.
var WORKER_BASE = 'https://1891-interpreter-api.anthonymowl.workers.dev';

/**
 * Fire a single best-effort notification to the Worker. The Worker fan-outs
 * the payload to every subscriber attached to the matching tenant's DO.
 *
 * @param {string} tenantId   — required. From the verified session payload.
 * @param {string} jobId      — required when the event is about a single job.
 * @param {string} eventName  — 'job.created' | 'job.status_change'
 *                              | 'job.cancelled' | 'assignment.changed'
 *                              | 'closeout.submitted' | 'closeout.disputed'
 *                              | 'offer.created'
 * @param {Object} [extra]    — anything extra to merge into the payload
 *                              (e.g. {status, prev_status, assignment_id}).
 */
function _notifyJobChange_(tenantId, jobId, eventName, extra) {
  if (!tenantId || !eventName) return;
  var secret = '';
  try { secret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET') || ''; }
  catch (_) { /* ignore */ }
  if (!secret) return; // worker can't auth us; quietly skip rather than spam audit log

  var payload = {
    event: eventName,
    tenant_id: tenantId,
    job_id: jobId || '',
    ts: new Date().toISOString()
  };
  if (extra && typeof extra === 'object') {
    Object.keys(extra).forEach(function (k) {
      if (extra[k] !== undefined) payload[k] = extra[k];
    });
  }

  try {
    UrlFetchApp.fetch(WORKER_BASE + '/v1/notify/job', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      headers: { 'X-1891-Internal': secret },
      muteHttpExceptions: true,
      followRedirects: true
    });
  } catch (err) {
    // Never block the user on a notify failure. Best-effort only.
    try { _logAudit('live_board_notify_failed', tenantId, '', eventName + ': ' + String(err)); }
    catch (_) { /* swallow */ }
  }
}

// ----------------------------------------------------------------------------
// Convenience wrappers. Apps Script's _safeCall dispatcher executes the
// real apiXxx function and returns its TextOutput. Rather than instrument
// every state-mutating function in place (which would force us to edit four
// existing .gs files and risk merge conflicts with the seed data), we wrap
// the dispatcher so the notify fires after a successful state mutation.
//
// We parse the JSON body out of the TextOutput, check `ok === true`, and
// then fire the appropriate event with the data the function returned. If
// parsing fails or ok !== true, no notify is sent and we return the
// untouched TextOutput.
// ----------------------------------------------------------------------------

/**
 * Wrap a TextOutput response from an apiXxx call to fire a live-board notify
 * iff the response parses as JSON and `ok === true`.
 *
 * @param {GoogleAppsScript.Content.TextOutput} out — the function's response
 * @param {string} tenantId — from the request session
 * @param {string} eventName — the live-board event name
 * @param {function(Object):Object} extraFromBody — extract extras from the
 *                                                   parsed response body
 * @return the same TextOutput, unmodified
 */
function _withLiveBoardNotify_(out, tenantId, eventName, extraFromBody) {
  try {
    var raw = out && out.getContent ? out.getContent() : '';
    if (!raw) return out;
    // Strip JSONP wrapper if present: callback(  {…}  );
    var json = raw;
    var m = /^[A-Za-z_$][\w$]*\((.*)\);?\s*$/.exec(raw);
    if (m) json = m[1];
    var body = JSON.parse(json);
    if (body && body.ok === true) {
      var jobId = (body.job_id || '') || (extraFromBody ? (extraFromBody(body) || {}).job_id || '' : '');
      var extra = extraFromBody ? extraFromBody(body) : {};
      _notifyJobChange_(tenantId, jobId, eventName, extra);
    }
  } catch (_) { /* swallow — never block the response */ }
  return out;
}

// ----------------------------------------------------------------------------
// Touchpoint wrappers. The router in Code.gs delegates to these via the same
// dispatch table; we keep the original `apiXxx` names intact and intercept
// here. Each wrapper:
//   1) reads the session for tenant_id
//   2) calls the underlying api function
//   3) on success, fires the appropriate event
//
// To avoid editing every dispatch site, we expose these as `liveBoardWrap_…`
// helpers and call them from a single integration point in Code.gs (see
// `_dispatchWithLiveBoard_` below).
// ----------------------------------------------------------------------------

/**
 * Lightweight tenant extraction from the request event. Mirrors the same logic
 * the api functions use (`_requireSession`). We don't *require* a valid
 * session here — if it's invalid, the underlying api function will reject
 * the request anyway and `ok !== true` will short-circuit the notify.
 */
function _liveBoardTenantOf_(e) {
  try {
    var sess = (e && e.parameter && e.parameter.session) || '';
    if (!sess) return '';
    // _verifySession is defined in Code.gs; returns { ok, payload, error }.
    var v = (typeof _verifySession === 'function') ? _verifySession(sess) : null;
    if (!v || !v.ok) return '';
    return (v.payload && v.payload.tid) || '';
  } catch (_) { return ''; }
}

/**
 * Single dispatcher used by Code.gs's router for every job-state-changing
 * action. Replaces the bare `apiXxx(e)` call. Drop-in: takes the function
 * name + the request event, returns the same TextOutput the api function
 * would have returned.
 */
function _dispatchWithLiveBoard_(action, fnName, e) {
  var fn = (typeof globalThis !== 'undefined' && globalThis[fnName]) ||
           (this && this[fnName]);
  if (typeof fn !== 'function') {
    return (typeof _json === 'function')
      ? _json({ ok:false, error:'Not implemented yet: ' + fnName }, 501)
      : ContentService.createTextOutput(JSON.stringify({ ok:false, error:'Not implemented' }));
  }
  var out = fn(e);
  // Freshness nudge: keep D1 read-fresh after a job write (phase-3 prereq).
  // Guarded + flag-gated; no-op when dual-write is off; never throws. Runs here
  // (before the live-board switch) so it covers every job action uniformly.
  try { if (typeof _d1NudgeAfterWrite_ === 'function') _d1NudgeAfterWrite_(action, e, out); } catch (_) {}
  var tenantId = _liveBoardTenantOf_(e);
  if (!tenantId) return out;

  // Map the dispatched action to a live-board event and the extra fields we
  // want the client to see.
  switch (action) {
    case 'create_job':
      return _withLiveBoardNotify_(out, tenantId, 'job.created', function (b) {
        return {
          job_id: (b.job && b.job.job_id) || b.job_id || '',
          job: b.job || null
        };
      });
    case 'claim_job':
      return _withLiveBoardNotify_(out, tenantId, 'job.status_change', function (b) {
        return { status: 'CLAIMED', assignment_id: b.assignment_id || '' };
      });
    case 'cancel_job':
      return _withLiveBoardNotify_(out, tenantId, 'job.cancelled', function (b) {
        return {
          status: b.status || 'CANCELLED_BY_AGENCY',
          cancellation: b.cancellation || null
        };
      });
    case 'offer_job':
      return _withLiveBoardNotify_(out, tenantId, 'job.status_change', function (b) {
        return { status: 'OFFERED', assignment_id: b.assignment_id || '' };
      });
    case 'accept_offer':
      return _withLiveBoardNotify_(out, tenantId, 'assignment.changed', function (b) {
        return { status: b.status || 'CLAIMED', assignment_id: b.assignment_id || '' };
      });
    case 'decline_offer':
      return _withLiveBoardNotify_(out, tenantId, 'assignment.changed', function (b) {
        return { status: b.status || 'DECLINED', assignment_id: b.assignment_id || '' };
      });
    case 'confirm_job':
      return _withLiveBoardNotify_(out, tenantId, 'job.status_change', function (b) {
        return { status: b.status || 'CONFIRMED' };
      });
    case 'start_job':
      return _withLiveBoardNotify_(out, tenantId, 'job.status_change', function (b) {
        return { status: b.status || 'EN_ROUTE' };
      });
    case 'complete_job':
      return _withLiveBoardNotify_(out, tenantId, 'job.status_change', function (b) {
        return { status: b.status || 'COMPLETED' };
      });
    case 'closeout_job':
      return _withLiveBoardNotify_(out, tenantId, 'closeout.submitted', function (b) {
        return {
          status: b.status || 'COMPLETED',
          divergence_pct: b.divergence_pct,
          flagged_for_dispute: !!b.flagged_for_dispute
        };
      });
    case 'dispute_closeout':
      return _withLiveBoardNotify_(out, tenantId, 'closeout.disputed', function (b) {
        return { status: b.status || 'CONFIRMED' };
      });
    default:
      // Unknown action — just return the api function's output, no notify.
      return out;
  }
}
