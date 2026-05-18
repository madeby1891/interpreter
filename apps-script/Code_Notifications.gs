/**
 * 1891 Interpreter — notification preferences, digest scheduling, SMS.
 *
 * Per-user, per-event-type notification config. Modes per channel:
 *   email: immediate | daily_digest | weekly_digest | off
 *   sms:   immediate | off          (no digests for SMS — wrong channel)
 *   push:  immediate | off          (push reserved for future web/mobile)
 *
 * Event types we route through here:
 *   job_offer          — interpreter receives an offer
 *   job_claimed        — scheduler sees a claim
 *   job_confirmed      — both sides see confirmation
 *   job_cancelled      — affected parties
 *   job_complete       — billing trigger
 *   invoice_issued     — payer
 *   payout_paid        — interpreter
 *   doc_expiring_30d   — interpreter (30 days before doc expiry)
 *   doc_expiring_7d    — interpreter (1 week before)
 *   doc_expired        — interpreter + admin
 *
 * The Apps Script web app sends immediate notifications inline (via MailApp +
 * Twilio Worker proxy). Digests are queued; an installable time-driven trigger
 * (set up via `installDigestTriggers`) fires every day at 6am ET (daily) and
 * Monday 7am ET (weekly) to flush queues.
 *
 * SMS sends route through the Cloudflare Worker at /v1/sms/send so the Twilio
 * API key stays Worker-side and we get proper webhook signature validation
 * for delivery/failure callbacks.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

var DEFAULT_PREFS = [
  // event_type        email_mode        sms_mode      push_mode
  ['job_offer',        'immediate',      'immediate',  'immediate'],
  ['job_claimed',      'immediate',      'off',        'immediate'],
  ['job_confirmed',    'immediate',      'off',        'immediate'],
  ['job_cancelled',    'immediate',      'immediate',  'immediate'],
  ['job_complete',     'daily_digest',   'off',        'off'],
  ['invoice_issued',   'immediate',      'off',        'off'],
  ['payout_paid',      'immediate',      'off',        'immediate'],
  ['doc_expiring_30d', 'weekly_digest',  'off',        'off'],
  ['doc_expiring_7d',  'immediate',      'off',        'immediate'],
  ['doc_expired',      'immediate',      'immediate',  'immediate']
];

// ============================================================================
// PUBLIC ENDPOINTS
// ============================================================================

function apiListNotificationPrefs(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var userId = e.parameter.user_id || s.payload.uid;
  // Staff can list other users' prefs; otherwise self only
  var isStaff = (s.payload.role === 'role_owner' || s.payload.role === 'role_admin');
  if (userId !== s.payload.uid && !isStaff) return _json({ ok:false, error:'Forbidden' }, 403);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.NotificationPrefs, _tenantSchema().Notification_Prefs);
  var sh = ss.getSheetByName(T.NotificationPrefs);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var prefsByEvent = {};
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id !== s.payload.tid) continue;
    if (o.user_id !== userId) continue;
    if (!prefsByEvent[o.event_type]) prefsByEvent[o.event_type] = { event_type: o.event_type };
    prefsByEvent[o.event_type][o.channel + '_mode'] = o.mode;
    prefsByEvent[o.event_type][o.channel + '_pref_id'] = o.pref_id;
    if (o.channel === 'sms' && o.phone_e164) prefsByEvent[o.event_type].phone_e164 = o.phone_e164;
  }
  // Fill in defaults for any missing event types
  DEFAULT_PREFS.forEach(function (d) {
    if (!prefsByEvent[d[0]]) {
      prefsByEvent[d[0]] = {
        event_type: d[0],
        email_mode: d[1],
        sms_mode: d[2],
        push_mode: d[3],
        _is_default: true
      };
    } else {
      // Fill missing channels with default
      if (!prefsByEvent[d[0]].email_mode) prefsByEvent[d[0]].email_mode = d[1];
      if (!prefsByEvent[d[0]].sms_mode) prefsByEvent[d[0]].sms_mode = d[2];
      if (!prefsByEvent[d[0]].push_mode) prefsByEvent[d[0]].push_mode = d[3];
    }
  });
  // Pull global settings (digest hour, weekly day, phone, quiet hours)
  var globalSettings = {};
  for (var j = 1; j < data.length; j++) {
    var g = _rowToObj(hdr, data[j]);
    if (g.tenant_id !== s.payload.tid) continue;
    if (g.user_id !== userId) continue;
    if (g.event_type === '*' && g.channel === '*') {
      globalSettings = {
        phone_e164: g.phone_e164 || '',
        daily_digest_hour: Number(g.daily_digest_hour || 6),
        weekly_digest_day: Number(g.weekly_digest_day || 1),
        quiet_hours: g.quiet_hours || ''
      };
    }
  }
  return _json({ ok:true, prefs: Object.keys(prefsByEvent).map(function (k) { return prefsByEvent[k]; }), settings: globalSettings, user_id: userId });
}

function apiUpdateNotificationPref(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  var userId = p.user_id || s.payload.uid;
  var isStaff = (s.payload.role === 'role_owner' || s.payload.role === 'role_admin');
  if (userId !== s.payload.uid && !isStaff) return _json({ ok:false, error:'Forbidden' }, 403);

  var eventType = p.event_type;
  var channel = p.channel;
  var mode = p.mode;
  if (!eventType || !channel || !mode) return _json({ ok:false, error:'event_type + channel + mode required' });
  if (['email','sms','push'].indexOf(channel) < 0) return _json({ ok:false, error:'channel must be email|sms|push' });
  if (['immediate','daily_digest','weekly_digest','off'].indexOf(mode) < 0) return _json({ ok:false, error:'mode invalid' });
  if (channel === 'sms' && (mode === 'daily_digest' || mode === 'weekly_digest')) {
    return _json({ ok:false, error:'SMS does not support digests; use immediate or off' });
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.NotificationPrefs, _tenantSchema().Notification_Prefs);
  var sh = ss.getSheetByName(T.NotificationPrefs);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iUser = hdr.indexOf('user_id'), iEvent = hdr.indexOf('event_type'), iCh = hdr.indexOf('channel');
  var nowIso = new Date().toISOString();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iUser]) === userId && String(data[i][iEvent]) === eventType && String(data[i][iCh]) === channel) {
      sh.getRange(i + 1, hdr.indexOf('mode') + 1).setValue(mode);
      sh.getRange(i + 1, hdr.indexOf('_updated_at') + 1).setValue(nowIso);
      _logAudit('notification_pref.update', s.payload.tid, s.payload.uid, eventType + '/' + channel + '=' + mode);
      return _json({ ok:true });
    }
  }
  // Insert new
  var id = _ulid('np');
  var row = {
    pref_id: id, tenant_id: s.payload.tid, user_id: userId,
    event_type: eventType, channel: channel, mode: mode,
    phone_e164: '', daily_digest_hour: 6, weekly_digest_day: 1, quiet_hours: '',
    _created_at: nowIso, _updated_at: nowIso
  };
  sh.appendRow(_tenantSchema().Notification_Prefs.map(function (c) { return row[c] !== undefined ? row[c] : ''; }));
  _logAudit('notification_pref.create', s.payload.tid, s.payload.uid, eventType + '/' + channel + '=' + mode);
  return _json({ ok:true, pref_id: id });
}

function apiUpdateNotificationSettings(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  var userId = p.user_id || s.payload.uid;
  if (userId !== s.payload.uid && !(s.payload.role === 'role_owner' || s.payload.role === 'role_admin')) {
    return _json({ ok:false, error:'Forbidden' }, 403);
  }
  // Stored as a special row with event_type='*' and channel='*'
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.NotificationPrefs, _tenantSchema().Notification_Prefs);
  var sh = ss.getSheetByName(T.NotificationPrefs);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iUser = hdr.indexOf('user_id'), iEvent = hdr.indexOf('event_type'), iCh = hdr.indexOf('channel');
  var nowIso = new Date().toISOString();
  var fieldsToSet = ['phone_e164','daily_digest_hour','weekly_digest_day','quiet_hours'];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iUser]) === userId && String(data[i][iEvent]) === '*' && String(data[i][iCh]) === '*') {
      fieldsToSet.forEach(function (f) {
        if (p[f] === undefined || p[f] === null) return;
        var c = hdr.indexOf(f);
        if (c < 0) return;
        sh.getRange(i + 1, c + 1).setValue(p[f]);
      });
      sh.getRange(i + 1, hdr.indexOf('_updated_at') + 1).setValue(nowIso);
      return _json({ ok:true });
    }
  }
  // Insert
  var id = _ulid('ng');
  var row = {
    pref_id: id, tenant_id: s.payload.tid, user_id: userId,
    event_type: '*', channel: '*', mode: '*',
    phone_e164: p.phone_e164 || '',
    daily_digest_hour: Number(p.daily_digest_hour || 6),
    weekly_digest_day: Number(p.weekly_digest_day || 1),
    quiet_hours: p.quiet_hours || '',
    _created_at: nowIso, _updated_at: nowIso
  };
  sh.appendRow(_tenantSchema().Notification_Prefs.map(function (c) { return row[c] !== undefined ? row[c] : ''; }));
  return _json({ ok:true, pref_id: id });
}

// ============================================================================
// DELIVERY — used internally by other endpoints (apiOfferJob, etc.)
// ============================================================================

function notifyEvent_(ss, tenantId, eventType, recipientUserId, subject, body, smsBody, metadata) {
  // Look up the user's prefs for this event_type
  var prefs = getUserPrefs_(ss, tenantId, recipientUserId, eventType);
  var user = _lookupUserById(ss, recipientUserId);
  if (!user) return { sent:0, reason:'no user' };

  var result = { email:'none', sms:'none', push:'none' };

  // Email
  if (prefs.email_mode === 'immediate') {
    if (user.email) {
      try {
        MailApp.sendEmail({ to: user.email, subject: subject, body: body });
        _logCommunication(ss, tenantId, 'email', 'out', eventType, recipientUserId, user.email, 'sent', 'mailapp', metadata && metadata.job_id || '');
        result.email = 'sent';
      } catch (err) {
        _logCommunication(ss, tenantId, 'email', 'out', eventType, recipientUserId, user.email, 'failed', 'mailapp', metadata && metadata.job_id || '');
        result.email = 'failed';
      }
    }
  } else if (prefs.email_mode === 'daily_digest' || prefs.email_mode === 'weekly_digest') {
    // Queue for digest — write a "queued" Communications row; the digest cron picks them up
    _logCommunication(ss, tenantId, 'email', 'out', eventType, recipientUserId, user.email || '', 'queued_' + prefs.email_mode.replace('_digest', ''), 'mailapp', metadata && metadata.job_id || '');
    result.email = 'queued_' + prefs.email_mode;
  }

  // SMS (immediate only)
  if (prefs.sms_mode === 'immediate' && prefs.phone_e164 && smsBody) {
    try {
      var smsResult = _sendSmsViaWorker_(tenantId, prefs.phone_e164, smsBody);
      _logCommunication(ss, tenantId, 'sms', 'out', eventType, recipientUserId, prefs.phone_e164,
                        smsResult.ok ? 'sent' : 'failed', 'twilio_worker', metadata && metadata.job_id || '');
      result.sms = smsResult.ok ? 'sent' : 'failed';
    } catch (err) {
      _logCommunication(ss, tenantId, 'sms', 'out', eventType, recipientUserId, prefs.phone_e164, 'failed', 'twilio_worker', metadata && metadata.job_id || '');
      result.sms = 'failed';
    }
  }

  return result;
}

function getUserPrefs_(ss, tenantId, userId, eventType) {
  var sh = ss.getSheetByName(T.NotificationPrefs);
  var prefs = { email_mode:'immediate', sms_mode:'off', push_mode:'immediate', phone_e164:'' };
  // Pull defaults
  for (var i = 0; i < DEFAULT_PREFS.length; i++) {
    if (DEFAULT_PREFS[i][0] === eventType) {
      prefs.email_mode = DEFAULT_PREFS[i][1];
      prefs.sms_mode = DEFAULT_PREFS[i][2];
      prefs.push_mode = DEFAULT_PREFS[i][3];
      break;
    }
  }
  if (!sh || sh.getLastRow() < 2) return prefs;
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  for (var r = 1; r < data.length; r++) {
    var o = _rowToObj(hdr, data[r]);
    if (o.tenant_id !== tenantId || o.user_id !== userId) continue;
    // Per-event overrides
    if (o.event_type === eventType) {
      if (o.channel === 'email') prefs.email_mode = o.mode;
      else if (o.channel === 'sms') prefs.sms_mode = o.mode;
      else if (o.channel === 'push') prefs.push_mode = o.mode;
    }
    // Global settings (phone, quiet hours)
    if (o.event_type === '*' && o.channel === '*') {
      if (o.phone_e164) prefs.phone_e164 = o.phone_e164;
      prefs.daily_digest_hour = o.daily_digest_hour;
      prefs.weekly_digest_day = o.weekly_digest_day;
      prefs.quiet_hours = o.quiet_hours;
    }
  }
  return prefs;
}

function _sendSmsViaWorker_(tenantId, toE164, body) {
  var workerUrl = 'https://1891-interpreter-api.anthonymowl.workers.dev/v1/sms/send';
  var props = PropertiesService.getScriptProperties();
  var sharedSecret = props.getProperty('HMAC_SECRET');
  try {
    var res = UrlFetchApp.fetch(workerUrl, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: { 'X-1891-Internal': sharedSecret },
      payload: JSON.stringify({ tenant_id: tenantId, to: toE164, body: body })
    });
    var code = res.getResponseCode();
    var json = null;
    try { json = JSON.parse(res.getContentText()); } catch (_) {}
    return { ok: code === 200 && json && json.ok, status_code: code, response: json };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ============================================================================
// DIGEST FLUSH (called by time-driven trigger)
// ============================================================================

function runDailyDigest() {
  flushDigests_('daily');
}

function runWeeklyDigest() {
  flushDigests_('weekly');
}

function flushDigests_(kind) {
  // For every user with queued events, group queued Communications rows and
  // send one consolidated email. Mark them sent.
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var commsSh = ss.getSheetByName(T.Communications);
  if (!commsSh || commsSh.getLastRow() < 2) return;
  var data = commsSh.getDataRange().getValues();
  var hdr = data[0];
  var iStatus = hdr.indexOf('status');
  var iTo = hdr.indexOf('to_user_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iTemplate = hdr.indexOf('template_id');
  var iJob = hdr.indexOf('job_id');
  var iCreated = hdr.indexOf('_created_at');

  var marker = 'queued_' + kind;
  var byUser = {};
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iStatus]) !== marker) continue;
    var uid = String(data[i][iTo]);
    if (!byUser[uid]) byUser[uid] = { tenant_id: String(data[i][iTenant]), items: [], rowIndices: [] };
    byUser[uid].items.push({
      event: String(data[i][iTemplate]),
      job_id: String(data[i][iJob] || ''),
      ts: String(data[i][iCreated] || '')
    });
    byUser[uid].rowIndices.push(i + 1);
  }

  Object.keys(byUser).forEach(function (uid) {
    var bucket = byUser[uid];
    var user = _lookupUserById(ss, uid);
    if (!user || !user.email) return;
    var subject = '1891 Interpreter — your ' + kind + ' digest';
    var body = renderDigestBody_(bucket.items, kind);
    try {
      MailApp.sendEmail({ to: user.email, subject: subject, body: body });
      // Mark all the underlying rows as sent
      bucket.rowIndices.forEach(function (rowIdx) {
        commsSh.getRange(rowIdx, iStatus + 1).setValue('sent_in_digest');
      });
      _logAudit('digest.send', bucket.tenant_id, uid, kind + ' items=' + bucket.items.length);
    } catch (err) {
      _logAudit('digest.send_failed', bucket.tenant_id, uid, String(err));
    }
  });
}

function renderDigestBody_(items, kind) {
  var counts = {};
  items.forEach(function (it) { counts[it.event] = (counts[it.event] || 0) + 1; });
  var lines = [
    'Hi,',
    '',
    'Here is your ' + kind + ' summary from 1891 Interpreter:',
    ''
  ];
  Object.keys(counts).sort().forEach(function (k) {
    lines.push('  · ' + k.replace(/_/g, ' ') + ': ' + counts[k]);
  });
  lines.push('');
  lines.push('Open the app for full detail: https://madeby1891.com/interpreter/app/');
  lines.push('');
  lines.push('Change your delivery cadence: https://madeby1891.com/interpreter/app/me/notifications.html');
  lines.push('');
  lines.push('— 1891 Interpreter');
  return lines.join('\n');
}

// ============================================================================
// TIME-DRIVEN TRIGGER INSTALLATION (run once from script editor)
// ============================================================================

function installDigestTriggers() {
  // Remove existing triggers for our digest functions
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    var name = t.getHandlerFunction();
    if (name === 'runDailyDigest' || name === 'runWeeklyDigest') {
      ScriptApp.deleteTrigger(t);
    }
  });
  // Daily at 6am ET
  ScriptApp.newTrigger('runDailyDigest').timeBased().everyDays(1).atHour(6).inTimezone('America/New_York').create();
  // Weekly Monday at 7am ET
  ScriptApp.newTrigger('runWeeklyDigest').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).inTimezone('America/New_York').create();
  return { ok: true, installed: ['runDailyDigest@daily 6am ET', 'runWeeklyDigest@Mon 7am ET'] };
}

function apiInstallDigestTriggers(e) {
  var setup = e.parameter.setup;
  if (setup !== SHEET_ID) return _json({ ok:false, error:'Forbidden' }, 403);
  var result = installDigestTriggers();
  return _json({ ok:true, result: result });
}
