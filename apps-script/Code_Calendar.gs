// ============================================================================
// Code_Calendar.gs — Interpreter calendar (ICS) feed
// v18.4 — May 2026
//
// Lets an interpreter subscribe to their schedule in Google Calendar / iOS
// Calendar / Outlook via a per-user, long-lived calendar token URL. Calendar
// apps fetch periodically and don't carry session JWTs, so we mint a separate
// opaque token (stored in Users.calendar_token) that the user can rotate or
// revoke on their notifications page.
//
// PII SAFETY (non-negotiable):
//   The ICS body is sanitized — no consumer initials, no street addresses,
//   no requestor names, no specialist names, no notes_to_interpreter, no
//   consumer language preferences. SUMMARY carries service_type + modality +
//   language pair. LOCATION carries city + state only (or "Remote (VRI/OPI)").
//   DESCRIPTION carries just the job_id + a link to the portal. The token URL
//   itself is opaque and revocable.
//
// Endpoints:
//   GET  ?action=interpreter_ics&token=<cal_token>     → text/calendar
//   POST action=rotate_calendar_token  (session)       → mints/rotates token
//   POST action=clear_calendar_token   (session)       → revokes token
// ============================================================================

// ----------------------------------------------------------------------------
// GET: serve the ICS feed
// ----------------------------------------------------------------------------
function apiInterpreterIcs(e) {
  var params = (e && e.parameter) || {};
  var token = String(params.token || '').trim();
  if (!token) return _icsForbid('Missing token.');

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _calEnsureUserCol(ss);

  var user = _calFindUserByToken(ss, token);
  if (!user) return _icsForbid('Invalid or revoked calendar token.');

  // Resolve linked interpreter profile. Staff users without a linked
  // interpreter profile get an empty (but valid) feed.
  var interp = _findInterpreterByUserId(ss, user.user_id);

  var now = Date.now();
  var ninetyDaysAgo = now - (90 * 24 * 60 * 60 * 1000);
  var oneYearAhead  = now + (365 * 24 * 60 * 60 * 1000);

  var events = [];
  if (interp && interp.interpreter_id) {
    events = _calCollectEvents(ss, user.tenant_id, interp.interpreter_id, ninetyDaysAgo, oneYearAhead);
  }

  var ics = _calBuildIcs(events, user);

  _logAudit('calendar.fetch', user.tenant_id, user.user_id, 'count=' + events.length);

  return ContentService
    .createTextOutput(ics)
    .setMimeType(ContentService.MimeType.ICAL);
}

// ----------------------------------------------------------------------------
// POST: rotate (mint) the calendar token
// ----------------------------------------------------------------------------
function apiRotateCalendarToken(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);

  var p = (e && e.parameter) || {};
  var targetUserId = String(p.user_id || s.payload.uid);

  if (targetUserId !== s.payload.uid && !_calIsStaffRole(s.payload.role)) {
    return _json({ ok:false, error:'Forbidden' }, 403);
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _calEnsureUserCol(ss);

  var newToken = _ulid('cal');
  var ok = _calWriteUserToken(ss, targetUserId, newToken);
  if (!ok) return _json({ ok:false, error:'User not found' }, 404);

  _logAudit('calendar.token_rotated', s.payload.tid, s.payload.uid, 'target=' + targetUserId);

  return _json({
    ok: true,
    calendar_token: newToken,
    calendar_url: _calFeedUrl(newToken)
  });
}

// ----------------------------------------------------------------------------
// POST: clear (revoke) the calendar token
// ----------------------------------------------------------------------------
function apiClearCalendarToken(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);

  var p = (e && e.parameter) || {};
  var targetUserId = String(p.user_id || s.payload.uid);

  if (targetUserId !== s.payload.uid && !_calIsStaffRole(s.payload.role)) {
    return _json({ ok:false, error:'Forbidden' }, 403);
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _calEnsureUserCol(ss);

  var ok = _calWriteUserToken(ss, targetUserId, '');
  if (!ok) return _json({ ok:false, error:'User not found' }, 404);

  _logAudit('calendar.token_cleared', s.payload.tid, s.payload.uid, 'target=' + targetUserId);

  return _json({ ok:true });
}

// ============================================================================
// Helpers
// ============================================================================

function _calIsStaffRole(role) {
  return role === 'role_owner' || role === 'role_manager' || role === 'role_admin' ||
         role === 'role_platform_staff';
}

// Lazy-add the calendar_token column to Users (same pattern as
// _payEnsureInterpreterCols in Code_Payments.gs). Safe to call every request.
function _calEnsureUserCol(ss) {
  var sh = ss.getSheetByName(T.Users);
  if (!sh) return [];
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn() || 1).getValues()[0];
  if (hdr.indexOf('calendar_token') >= 0) return hdr;
  sh.getRange(1, sh.getLastColumn() + 1).setValue('calendar_token').setFontWeight('bold');
  hdr.push('calendar_token');
  return hdr;
}

function _calFindUserByToken(ss, token) {
  var sh = ss.getSheetByName(T.Users);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iTok = hdr.indexOf('calendar_token');
  if (iTok < 0) return null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iTok]) === token) return _rowToObj(hdr, data[i]);
  }
  return null;
}

function _calWriteUserToken(ss, userId, token) {
  var sh = ss.getSheetByName(T.Users);
  if (!sh) return false;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return false;
  var hdr = data[0];
  var iId = hdr.indexOf('user_id');
  var iTok = hdr.indexOf('calendar_token');
  var iUpdated = hdr.indexOf('_updated_at');
  if (iId < 0 || iTok < 0) return false;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iId]) === String(userId)) {
      sh.getRange(i + 1, iTok + 1).setValue(token);
      if (iUpdated >= 0) sh.getRange(i + 1, iUpdated + 1).setValue(new Date().toISOString());
      return true;
    }
  }
  return false;
}

function _calFeedUrl(token) {
  // The site uses the Cloudflare Worker proxy as its public endpoint. Reuse
  // the same address calendar apps already trust via the site links — that's
  // the URL the user will subscribe to.
  var base = _getScriptProperty('CALENDAR_FEED_BASE') ||
             'https://1891-interpreter-api.anthonymowl.workers.dev/v1/proxy/exec';
  return base + '?action=interpreter_ics&token=' + encodeURIComponent(token);
}

function _getScriptProperty(key) {
  try { return PropertiesService.getScriptProperties().getProperty(key); }
  catch (_) { return null; }
}

// ----------------------------------------------------------------------------
// Event collection — pulls Job_Assignments where response='claim' and the
// parent job is in an active/completed state within the time window.
// ----------------------------------------------------------------------------
var _CAL_ACTIVE_JOB_STATUS = {
  'CLAIMED':    'CONFIRMED',
  'CONFIRMED':  'CONFIRMED',
  'EN_ROUTE':   'CONFIRMED',
  'IN_PROGRESS':'CONFIRMED',
  'COMPLETED':  'CONFIRMED'
};

function _calCollectEvents(ss, tenantId, interpreterId, fromMs, toMs) {
  var asgSh = ss.getSheetByName(T.JobAssignments);
  if (!asgSh) return [];
  var asgData = asgSh.getDataRange().getValues();
  if (asgData.length < 2) return [];
  var aHdr = asgData[0];

  var myAssignments = [];
  for (var i = 1; i < asgData.length; i++) {
    var a = _rowToObj(aHdr, asgData[i]);
    if (a.interpreter_id !== interpreterId) continue;
    if (a.response !== 'claim') continue;
    myAssignments.push(a);
  }
  if (!myAssignments.length) return [];

  // Index jobs by id for one-pass enrichment.
  var jobIds = {};
  myAssignments.forEach(function (a) { jobIds[a.job_id] = true; });
  var jobsById = _calFetchJobs(ss, tenantId, jobIds);

  // Cache for location/language lookups.
  var locById = {};
  var langById = {};

  var out = [];
  for (var j = 0; j < myAssignments.length; j++) {
    var asg = myAssignments[j];
    var job = jobsById[asg.job_id];
    if (!job) continue;

    var status = String(job.status || '').toUpperCase();
    var isCancelled = status.indexOf('CANCELLED') === 0;
    if (!isCancelled && !_CAL_ACTIVE_JOB_STATUS[status]) continue;

    var startIso = String(job.scheduled_start || '');
    var endIso = String(job.scheduled_end || '');
    if (!startIso) continue;
    var startMs = Date.parse(startIso);
    if (isNaN(startMs)) continue;
    if (startMs < fromMs || startMs > toMs) continue;
    if (!endIso || isNaN(Date.parse(endIso))) {
      // Default to 1-hour block if scheduled_end is missing.
      endIso = new Date(startMs + 60 * 60 * 1000).toISOString();
    }

    var loc = null;
    if (job.location_id) {
      if (locById[job.location_id] === undefined) {
        locById[job.location_id] = _calFindLocation(ss, tenantId, job.location_id);
      }
      loc = locById[job.location_id];
    }

    var srcLang = job.source_language_id ? _calLangName(ss, langById, job.source_language_id) : '';
    var tgtLang = job.target_language_id ? _calLangName(ss, langById, job.target_language_id) : '';

    out.push({
      job_id: job.job_id,
      status: status,
      summary: _calBuildSummary(job, srcLang, tgtLang),
      location: _calBuildLocation(job, loc),
      description: _calBuildDescription(job),
      dtstart: startIso,
      dtend: endIso,
      last_modified: asg._updated_at || job._updated_at || new Date().toISOString(),
      created_at: asg._created_at || job._created_at || ''
    });
  }
  return out;
}

function _calFetchJobs(ss, tenantId, jobIdSet) {
  var sh = ss.getSheetByName(T.Jobs);
  if (!sh) return {};
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return {};
  var hdr = data[0];
  var out = {};
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id !== tenantId) continue;
    if (!jobIdSet[o.job_id]) continue;
    out[o.job_id] = o;
  }
  return out;
}

function _calFindLocation(ss, tenantId, locationId) {
  var sh = ss.getSheetByName(T.Locations);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id !== tenantId) continue;
    if (o.location_id === locationId) return o;
  }
  return null;
}

function _calLangName(ss, cache, langId) {
  if (!langId) return '';
  if (cache[langId] !== undefined) return cache[langId];
  var sh = ss.getSheetByName(T.Languages);
  if (!sh) { cache[langId] = String(langId); return cache[langId]; }
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.language_id === langId) {
      cache[langId] = o.display_name || String(langId);
      return cache[langId];
    }
  }
  cache[langId] = String(langId);
  return cache[langId];
}

// ----------------------------------------------------------------------------
// Sanitized field builders — these enforce the no-PII rules.
// ----------------------------------------------------------------------------
function _calTitleCase(s) {
  s = String(s || '').replace(/[_-]/g, ' ').trim();
  if (!s) return '';
  return s.replace(/\w\S*/g, function (w) {
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
}

function _calBuildSummary(job, srcLang, tgtLang) {
  // "<service_type> · <modality> <on-site|VRI|OPI>" + optional language pair.
  // No consumer initials, no requestor name, no specialist name.
  var service = _calTitleCase(job.service_type || 'Interpreting');
  var modality = String(job.modality || '').toLowerCase();
  var modalityLabel;
  if (modality === 'vri' || modality === 'video') modalityLabel = 'VRI';
  else if (modality === 'opi' || modality === 'phone') modalityLabel = 'OPI';
  else if (modality === 'on_site' || modality === 'on-site' || modality === 'onsite' || modality === 'in_person') modalityLabel = 'On-site';
  else modalityLabel = _calTitleCase(job.modality || '');
  var parts = [service];
  if (modalityLabel) parts.push(modalityLabel);
  var pair = '';
  if (srcLang && tgtLang) pair = srcLang + ' ↔ ' + tgtLang;
  else if (tgtLang) pair = tgtLang;
  else if (srcLang) pair = srcLang;
  if (pair) parts.push('(' + pair + ')');
  return parts.join(' · ');
}

function _calBuildLocation(job, loc) {
  var modality = String(job.modality || '').toLowerCase();
  if (modality === 'vri' || modality === 'video') return 'Remote (VRI)';
  if (modality === 'opi' || modality === 'phone') return 'Remote (OPI)';
  // On-site → city, state only. NEVER the street, suite, parking notes, etc.
  if (loc) {
    var city = String(loc.city || '').trim();
    var state = String(loc.state || '').trim();
    if (city && state) return city + ', ' + state;
    if (city) return city;
    if (state) return state;
  }
  return ''; // unknown — empty is safer than guessing
}

function _calBuildDescription(job) {
  // Stays generic on purpose. No notes_to_interpreter, no consumer info.
  return 'Job ID: ' + String(job.job_id || '') +
    '. Open the 1891 Interpreter portal for full details.';
}

// ----------------------------------------------------------------------------
// ICS rendering (RFC 5545)
// ----------------------------------------------------------------------------
function _calBuildIcs(events, user) {
  var lines = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//1891 Interpreter//Schedule v1//EN');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push('X-WR-CALNAME:1891 Interpreter — My schedule');
  lines.push('X-WR-CALDESC:Sanitized — service type + city/state only. Open portal for details.');
  lines.push('X-WR-TIMEZONE:UTC');
  lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT15M');
  lines.push('X-PUBLISHED-TTL:PT15M');

  var nowStamp = _calIcsTime(new Date().toISOString());
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + _icsEscape(ev.job_id) + '@1891interpreter');
    lines.push('DTSTAMP:' + nowStamp);
    lines.push('DTSTART:' + _calIcsTime(ev.dtstart));
    lines.push('DTEND:'   + _calIcsTime(ev.dtend));
    if (ev.created_at)    lines.push('CREATED:' + _calIcsTime(ev.created_at));
    if (ev.last_modified) lines.push('LAST-MODIFIED:' + _calIcsTime(ev.last_modified));
    lines.push('SUMMARY:' + _icsEscape(ev.summary));
    if (ev.location)      lines.push('LOCATION:' + _icsEscape(ev.location));
    lines.push('DESCRIPTION:' + _icsEscape(ev.description));
    var status = (String(ev.status || '').indexOf('CANCELLED') === 0) ? 'CANCELLED' : 'CONFIRMED';
    lines.push('STATUS:' + status);
    lines.push('TRANSP:OPAQUE');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');

  // RFC 5545 mandates CRLF line endings.
  // Fold lines >75 octets per spec (cheap implementation — only the obvious ones).
  return lines.map(_icsFold).join('\r\n') + '\r\n';
}

function _icsEscape(s) {
  // RFC 5545 §3.3.11: backslash, semicolon, comma, newline are escaped.
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function _icsFold(line) {
  // Fold long lines at 73 octets to leave room for CRLF + leading space on
  // continuation, per RFC 5545 §3.1.
  if (line.length <= 75) return line;
  var out = '';
  var rest = line;
  var first = true;
  while (rest.length > 0) {
    var chunkLen = first ? 75 : 74;
    out += (first ? '' : '\r\n ') + rest.substr(0, chunkLen);
    rest = rest.substr(chunkLen);
    first = false;
  }
  return out;
}

function _calIcsTime(iso) {
  // ISO → UTC basic format YYYYMMDDTHHMMSSZ
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  return d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) + 'Z';
}

function _icsForbid(msg) {
  // Calendar clients render the body in their error UI for some failures.
  // Keep it plain and short. NOT JSON.
  return ContentService
    .createTextOutput('Forbidden: ' + msg + '\n')
    .setMimeType(ContentService.MimeType.TEXT);
}
