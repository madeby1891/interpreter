/**
 * 1891 Interpreter — inbound SMS handler.
 *
 * Twilio → Cloudflare Worker → here. The Worker verifies the Twilio HMAC
 * signature, then mints a 60s worker JWT (`iss='worker'`, `purpose='twilio_inbound'`)
 * and POSTs to `?action=sms_inbound`. We trust the worker token (same shared
 * HMAC secret as user sessions, narrow whitelist of purposes) and dispatch.
 *
 * Payload from the Worker:
 *   from_phone        — E.164 number that sent the SMS
 *   body_raw          — original text (kept for audit; never rendered)
 *   body_normalised   — trimmed + uppercased + whitespace-collapsed
 *   action            — 'accept' | 'decline' | 'optout' | 'unknown'
 *   twilio_msg_sid    — Twilio MessageSid for idempotency
 *
 * Return shape:
 *   { ok: true,  action, reply_text, ... }
 *   { ok: false, error: 'no_user' | 'no_pending_offers' | ... }
 *
 * The Worker picks `reply_text` when present so canned copy lives here.
 *
 * Audit: every inbound writes a Communications row (direction='inbound') with
 * provider_msg_id = MessageSid, so a Twilio retry of the same SID is a no-op.
 */

function apiSmsInbound(e) {
  // Only accept worker-issued JWTs with the twilio_inbound purpose.
  var s = _requireSessionOrWorker(e, 'twilio_inbound');
  if (!s.ok || !s.is_worker) {
    return _json({ ok:false, error: s.error || 'worker token required' }, 401);
  }

  var p = (e && e.parameter) || {};
  var fromPhone = String(p.from_phone || '').trim();
  var bodyRaw = String(p.body_raw || '');
  var bodyNorm = String(p.body_normalised || '').trim();
  var action = String(p.action || 'unknown');
  var msgSid = String(p.twilio_msg_sid || '').trim();

  if (!fromPhone) {
    return _json({ ok:false, error:'missing_from_phone' });
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);

  // ── Idempotency: if we've already logged an inbound row with this MessageSid
  //    we re-render the same reply rather than re-applying the action. Twilio
  //    retries on 5xx so we MUST be deterministic on a given SID.
  if (msgSid) {
    var prior = _findInboundByMsgSid_(ss, msgSid);
    if (prior) {
      var priorReply = _extractPriorReply_(prior);
      return _json({
        ok: true,
        replayed: true,
        action: action,
        reply_text: priorReply || 'Already processed.'
      });
    }
  }

  // ── Resolve the user by E.164 phone. Multiple matches → pick the active one.
  var user = _findUserByPhone_(ss, fromPhone);
  if (!user) {
    _logInboundSms_(ss, '', '', fromPhone, msgSid, bodyRaw, bodyNorm, action, 'no_user', '');
    return _json({ ok:true, action: action, error:'no_user',
                   reply_text: "We don't recognize this number. Sign in via the portal to manage your offers." });
  }

  // ── OPTOUT short-circuits the rest of the flow.
  if (action === 'optout') {
    _setSmsOptOut_(ss, user);
    _logInboundSms_(ss, user.tenant_id, user.user_id, fromPhone, msgSid, bodyRaw, bodyNorm, action, 'optout', '');
    return _json({ ok:true, action:'optout',
                   reply_text: "You're unsubscribed from 1891 SMS. Reply START to opt back in." });
  }

  // ── Resolve the interpreter profile linked to this user. Staff who reply by
  //    SMS without an interpreter row get a polite no-op.
  var interp = _findInterpreterByUserId(ss, user.user_id);
  if (!interp) {
    _logInboundSms_(ss, user.tenant_id, user.user_id, fromPhone, msgSid, bodyRaw, bodyNorm, action, 'no_interp', '');
    return _json({ ok:true, action: action, error:'no_interp',
                   reply_text: 'Replies are for interpreters. Manage this account in the portal.' });
  }

  // ── Find the interpreter's earliest pending offer (status=OFFERED, response=offered).
  var pending = _findPendingOffersForInterpreter_(ss, interp.interpreter_id);
  if (action === 'unknown') {
    _logInboundSms_(ss, user.tenant_id, user.user_id, fromPhone, msgSid, bodyRaw, bodyNorm, action, 'unrecognized', '');
    return _json({ ok:true, action: action, error:'unrecognized',
                   reply_text: 'Reply YES to claim the latest offer, NO to decline, STOP to unsubscribe.' });
  }
  if (!pending.length) {
    _logInboundSms_(ss, user.tenant_id, user.user_id, fromPhone, msgSid, bodyRaw, bodyNorm, action, 'no_pending', '');
    return _json({ ok:true, action: action, error:'no_pending_offers',
                   reply_text: 'No pending offers right now. Open the portal for your upcoming jobs.' });
  }

  // Earliest scheduled_start wins — that is what they meant if there's more
  // than one. Note this in the reply so the interpreter knows which job.
  pending.sort(function (a, b) {
    return String(a.job.scheduled_start || '').localeCompare(String(b.job.scheduled_start || ''));
  });
  var pick = pending[0];

  // Apply the action via the shared core helpers — auth has already happened
  // (worker-token-only path; the phone-to-user resolution is the auth).
  var actorTid = pick.job.tenant_id || user.tenant_id;
  var actorUid = user.user_id;
  var asgWrap = _findAssignmentRow_(ss, pick.assignment.assignment_id);
  if (!asgWrap) {
    return _json({ ok:false, error:'race_assignment_vanished' });
  }
  var result;
  if (action === 'accept') {
    result = _acceptOfferCore_(ss, asgWrap, actorTid, actorUid);
  } else if (action === 'decline') {
    result = _declineOfferCore_(ss, asgWrap, actorTid, actorUid, 'sms_decline');
  } else {
    return _json({ ok:false, error:'unsupported_action:' + action });
  }

  // Build the human-facing reply. Never include consumer initials over SMS.
  var when = _formatLocalTime(pick.job.scheduled_start, 'America/New_York');
  var service = String(pick.job.service_type || 'job').replace(/-/g, ' ');
  var locShort = pick.locationShort || '';
  var moreNote = pending.length > 1 ? ' (1 of ' + pending.length + ' pending offers — earliest)' : '';
  var replyText;
  if (!result.ok) {
    replyText = result.error === 'Already accepted'
      ? "You're already confirmed for that job. Details in the portal."
      : 'Could not ' + action + ' (' + result.error + '). Use the portal.';
  } else if (action === 'accept') {
    replyText = "Confirmed for " + when + " — " + service +
                (locShort ? " at " + locShort : "") + ". Details in the portal." + moreNote;
  } else {
    replyText = "Declined " + when + " — " + service + ". Thanks for the quick reply." + moreNote;
  }

  _logInboundSms_(ss, actorTid, user.user_id, fromPhone, msgSid, bodyRaw, bodyNorm, action,
                  result.ok ? 'applied' : 'failed', replyText);

  return _json({
    ok: true,
    action: action,
    job_id: pick.job.job_id,
    assignment_id: pick.assignment.assignment_id,
    status: result.ok ? result.status : null,
    scheduled_start: pick.job.scheduled_start,
    scheduled_start_human: when,
    pending_count: pending.length,
    reply_text: replyText
  });
}

// ============================================================================
// HELPERS
// ============================================================================

function _findUserByPhone_(ss, phoneE164) {
  var sh = ss.getSheetByName(T.Users);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iPhone = hdr.indexOf('phone_e164');
  if (iPhone < 0) return null;
  var matches = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iPhone]) === phoneE164) {
      matches.push(_rowToObj(hdr, data[i]));
    }
  }
  if (!matches.length) return null;
  // Prefer an active row when several users share the number (defensive — the
  // schema doesn't enforce uniqueness across tenants).
  var active = matches.filter(function (u) { return String(u.status || '').toLowerCase() === 'active'; });
  return active.length ? active[0] : matches[0];
}

function _findPendingOffersForInterpreter_(ss, interpreterId) {
  var asgSh = ss.getSheetByName(T.JobAssignments);
  if (!asgSh) return [];
  var data = asgSh.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var a = _rowToObj(hdr, data[i]);
    if (a.interpreter_id !== interpreterId) continue;
    if (String(a.response || '') !== 'offered') continue;
    if (String(a.status || '') !== 'OFFERED') continue;
    var job = _findJobAnyTenant_(ss, a.job_id);
    if (!job) continue;
    if (job.status !== 'OPEN' && job.status !== 'OFFERED') continue;
    var locShort = '';
    if (job.location_id) {
      var loc = _findLocationGeneral_(ss, job.location_id);
      if (loc) locShort = (loc.city || '') + (loc.state ? ', ' + loc.state : '');
    }
    out.push({ assignment: a, job: job, locationShort: locShort });
  }
  return out;
}

function _setSmsOptOut_(ss, user) {
  // 1) Clear the global phone on the Notification_Prefs '*' row.
  // 2) Set sms_mode='off' on every per-event row for this user.
  // 3) Clear user.phone_e164 so future job offers don't pick the number.
  _ensureTab(ss, T.NotificationPrefs, _tenantSchema().Notification_Prefs);
  var sh = ss.getSheetByName(T.NotificationPrefs);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iUser = hdr.indexOf('user_id');
  var iEvent = hdr.indexOf('event_type');
  var iCh = hdr.indexOf('channel');
  var iMode = hdr.indexOf('mode');
  var iPhone = hdr.indexOf('phone_e164');
  var iUpdated = hdr.indexOf('_updated_at');
  var nowIso = new Date().toISOString();
  var touched = 0;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iUser]) !== user.user_id) continue;
    var ev = String(data[i][iEvent] || '');
    var ch = String(data[i][iCh] || '');
    if (ch === 'sms') {
      sh.getRange(i + 1, iMode + 1).setValue('off');
      sh.getRange(i + 1, iUpdated + 1).setValue(nowIso);
      touched++;
    }
    if (ev === '*' && ch === '*') {
      sh.getRange(i + 1, iPhone + 1).setValue('');
      sh.getRange(i + 1, iUpdated + 1).setValue(nowIso);
      touched++;
    }
  }
  // Cover the case where they had no rows at all — append an explicit '*'/'*' opt-out so
  // the resolver in getUserPrefs_ short-circuits.
  if (!touched) {
    var id = _ulid('np');
    var row = {
      pref_id: id, tenant_id: user.tenant_id, user_id: user.user_id,
      event_type: '*', channel: '*', mode: 'off',
      phone_e164: '', daily_digest_hour: 6, weekly_digest_day: 1, quiet_hours: '',
      _created_at: nowIso, _updated_at: nowIso
    };
    sh.appendRow(_tenantSchema().Notification_Prefs.map(function (c) { return row[c] !== undefined ? row[c] : ''; }));
  }
  // Clear user.phone_e164
  var userSh = ss.getSheetByName(T.Users);
  if (userSh) {
    var udata = userSh.getDataRange().getValues();
    var uhdr = udata[0];
    var iUid = uhdr.indexOf('user_id');
    var iUphone = uhdr.indexOf('phone_e164');
    var iUupd = uhdr.indexOf('_updated_at');
    if (iUid >= 0 && iUphone >= 0) {
      for (var u = 1; u < udata.length; u++) {
        if (String(udata[u][iUid]) === user.user_id) {
          userSh.getRange(u + 1, iUphone + 1).setValue('');
          if (iUupd >= 0) userSh.getRange(u + 1, iUupd + 1).setValue(nowIso);
          break;
        }
      }
    }
  }
  _logAudit('sms.optout', user.tenant_id, user.user_id, 'phone cleared');
}

function _findInboundByMsgSid_(ss, msgSid) {
  if (!msgSid) return null;
  var sh = ss.getSheetByName(T.Communications);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iDir = hdr.indexOf('direction');
  var iProv = hdr.indexOf('provider_msg_id');
  if (iDir < 0 || iProv < 0) return null;
  // Scan from the bottom — inbound rows are appended in order so the latest
  // matching SID is the one we want.
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][iDir]) !== 'inbound') continue;
    if (String(data[i][iProv]) === msgSid) return _rowToObj(hdr, data[i]);
  }
  return null;
}

function _extractPriorReply_(commRow) {
  // We stash the rendered reply in the body_redacted_r2_key column (it's the
  // only free-form column on the row, and the column name is a misnomer for
  // SMS — R2 storage isn't wired in v1). Length-capped to 320 chars.
  return String(commRow.body_redacted_r2_key || '').slice(0, 320);
}

function _logInboundSms_(ss, tenantId, userId, fromPhone, msgSid, bodyRaw, bodyNorm, action, outcome, replyText) {
  _ensureTab(ss, T.Communications, _tenantSchema().Communications);
  var sh = ss.getSheetByName(T.Communications);
  var now = new Date().toISOString();
  var status = 'inbound:' + outcome;
  // body_redacted_r2_key field carries the rendered reply (see _extractPriorReply_).
  // We deliberately do NOT store the raw inbound body — interpreters can speak
  // freely in SMS and we want neither PHI nor unredacted free text in the row.
  sh.appendRow([
    _ulid('c'),
    tenantId || '',
    'sms',
    'inbound',
    'sms_reply_' + action,
    userId || '',
    fromPhone,
    String(replyText || '').slice(0, 320),
    status,
    'twilio',
    msgSid || '',
    '', // job_id — not always known on inbound; the job_event row carries it
    now,
    now
  ]);
  _logAudit('sms.inbound', tenantId || '', userId || '',
            (action || 'unknown') + '/' + outcome + ' from=' + fromPhone +
            (msgSid ? ' sid=' + msgSid : '') +
            (bodyNorm ? ' norm="' + bodyNorm.slice(0, 32) + '"' : ''));
}
