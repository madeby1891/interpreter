/**
 * Code_Funnel.gs — launch funnel: inbound-form acknowledgments, the gated
 * demo sandbox (tease-then-gate), the lead console backend, and the daily
 * lead digest.
 *
 * Added 2026-06-10 for launch week. Everything is additive — no existing
 * action changes shape. handleInboundForm (Code.gs) calls _ackInbound_ /
 * _sandboxGateIntake_ at the tail of its existing flow.
 *
 * Tabs owned here (NOT in _tenantSchema(), so the D1 sync never sees them;
 * they are host-tenant operational metadata, not product data):
 *   Sandbox_Tokens — continuation links for the /try/ sandbox email gate.
 *   Lead_Status    — workflow overlay on Inbound (status/owner/notes).
 */

var T_SANDBOX_TOKENS = 'Sandbox_Tokens';
var T_LEAD_STATUS    = 'Lead_Status';

var SANDBOX_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // continuation link lives 7 days
var LEAD_SLA_HOURS       = 24;                        // "a real person replies within 1 business day"

// Lazy lookups (not top-level consts): Code.gs defines NOTIFY_EMAIL/SITE_BASE,
// and Apps Script initializes files in project order — don't depend on it.
function _digestRecipients_() { return [NOTIFY_EMAIL, 'fallonbriz@gmail.com']; }
function _sandboxUrl_() { return SITE_BASE + '/try/'; }

// ============================================================================
// FORM ACKNOWLEDGMENTS — every inbound form gets a same-minute receipt.
// ============================================================================

function _ackInbound_(formId, params) {
  var email = String(params.email || params.work_email || params.contact_email || '').trim().toLowerCase();
  if (!_isValidEmail(email)) return;
  var tpl = _ackTemplate_(formId, params);
  if (!tpl) return;
  try {
    MailApp.sendEmail({
      to: email, subject: tpl.subject, body: tpl.body,
      name: BRAND_NAME, replyTo: BRAND_REPLY_TO
    });
    _logAudit('inbound_ack_sent', formId, '', '');
  } catch (err) {
    _logAudit('inbound_ack_failed', formId, '', String(err));
  }
}

function _ackFirstName_(params) {
  var name = String(params.name || params.full_name || params.owner_name || '').trim();
  if (!name) return 'there';
  return name.split(/\s+/)[0];
}

function _ackTemplate_(formId, params) {
  var first = _ackFirstName_(params);
  var sig = '\n\n— The 1891 Interpreter team\nmadeby1891.com/interpreter';

  if (formId === 'demo_request') {
    return {
      subject: 'Your working session — we got the request',
      body:
        'Hi ' + first + ',\n\n' +
        'Your request is in front of a real person now. You’ll hear from one of us ' +
        'within one business day.\n\n' +
        'Two things that speed it up:\n' +
        '  1. Reply with two or three time windows that work for you.\n' +
        '  2. If your agency runs on another system today, tell us which one — ' +
        'we’ll bring the comparison to the call.\n\n' +
        'Can’t wait? The sandbox is open right now — no signup, nothing to install:\n' +
        _sandboxUrl_() + sig
    };
  }
  if (formId === 'contact') {
    return {
      subject: 'We received your message',
      body:
        'Hi ' + first + ',\n\n' +
        'Thanks for writing. A real person reads every message, and you’ll hear back ' +
        'within one business day.\n\n' +
        'If it’s easier to show than tell, the sandbox is open — no signup:\n' +
        _sandboxUrl_() + sig
    };
  }
  if (formId === 'requestor_sample') {
    return {
      subject: 'Your request is in',
      body:
        'Hi ' + first + ',\n\n' +
        'We received your request. A scheduler will follow up by email to confirm the ' +
        'details — the language, the time, the place — and you’ll get a plain ' +
        'confirmation once an interpreter is set.' + sig
    };
  }
  if (formId === 'deaf_owned_application') {
    return {
      subject: 'Your Deaf-owned verification application — received',
      body:
        'Hi ' + first + ',\n\n' +
        'Your application for the free-forever Deaf-owned tier is in. Here’s exactly ' +
        'what happens next:\n\n' +
        '  1. A person confirms receipt within 2 business days.\n' +
        '  2. Your application is reviewed during the pilot window, in the order it ' +
        'arrived — decisions come with a written reason either way.\n' +
        '  3. If anything in your documentation needs a follow-up, we ask — we don’t ' +
        'silently deny.\n\n' +
        'While you wait, the sandbox is open — it’s the same console your agency ' +
        'would run on, loaded with sample data:\n' + _sandboxUrl_() + sig
    };
  }
  if (formId === 'a11y' || formId === 'accessibility_feedback') {
    return {
      subject: 'We received your accessibility report',
      body:
        'Hi ' + first + ',\n\n' +
        'Thank you — reports like this one are how the product gets better. A person ' +
        '(not an auto-closer) will reply within two business days, and if it’s a real ' +
        'defect you’ll get a fix date, not a ticket number.' + sig
    };
  }
  if (formId === 'security_disclosure') {
    return {
      subject: 'We received your security report',
      body:
        'Hi ' + first + ',\n\n' +
        'Thank you for the report. We read every disclosure, and a person will respond ' +
        'within two business days. If you included reproduction steps, please don’t ' +
        'share them elsewhere while we investigate.' + sig
    };
  }
  // Unknown form ids: no ack (owner notification still fires).
  return null;
}

// ============================================================================
// SANDBOX GATE — tease-then-gate email verification for /try/.
//
// Flow: /try/ boots instantly with no email. After ~5 meaningful actions the
// page hard-gates and POSTs form_id=sandbox_gate. We record the lead (the
// generic Inbound flow already ran), issue a 7-day continuation token, and
// email the link. The page stays locked — including on return visits — until
// the visitor comes back through the link, which hits action=sandbox_verify.
// ============================================================================

function _sandboxGateIntake_(params) {
  var email = String(params.email || '').trim().toLowerCase();
  if (!_isValidEmail(email)) {
    return _json({ ok:false, error:'A valid work email is required.' });
  }
  var token = _newToken();
  var hash = _sha256Hex(token);
  var now = new Date();
  var expIso = new Date(now.getTime() + SANDBOX_TOKEN_TTL_MS).toISOString();

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = _getOrCreateSheet(ss, T_SANDBOX_TOKENS, [
    'issued_at','email','token_hash','expires_at','verified_at',
    'last_seen_at','visits','marketing_consent','page'
  ]);
  sheet.appendRow([
    now.toISOString(), email, hash, expIso, '', '', 0,
    params.marketing_consent === 'yes' ? 'yes' : 'no',
    String(params.page || '')
  ]);

  var link = _sandboxUrl_() + '?sbt=' + encodeURIComponent(token);
  var body =
    'Here’s your link back into the sandbox:\n\n' +
    link + '\n\n' +
    'It picks up exactly where you left off — same data, same screen — and works ' +
    'for 7 days. The demo data lives in your browser, not on our servers.\n\n' +
    'When you’re ready for the real thing: verified Deaf-owned agencies run free, ' +
    'forever (' + SITE_BASE + '/free-for-deaf-owned), and everyone else can start at ' +
    SITE_BASE + '/pricing.\n\n' +
    '— The 1891 Interpreter team\nmadeby1891.com/interpreter';
  try {
    MailApp.sendEmail({
      to: email, subject: 'Your sandbox — pick up where you left off',
      body: body, name: BRAND_NAME, replyTo: BRAND_REPLY_TO
    });
  } catch (err) {
    _logAudit('sandbox_gate_email_failed', 'sandbox_gate', '', String(err));
    return _json({ ok:false, error:'We couldn’t send the email right now. Please try again in a minute.' });
  }
  _logAudit('sandbox_gate_issued', 'sandbox_gate', '', '');
  return _json({ ok:true, message:'Check your inbox — your continue link is on the way.' });
}

function apiSandboxVerify(e) {
  var token = String(e.parameter.token || '');
  if (!token) return _json({ ok:false, error:'Token required.' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(T_SANDBOX_TOKENS);
  if (!sheet) return _json({ ok:false, error:'Invalid link.' });

  var hash = _sha256Hex(token);
  var data = sheet.getDataRange().getValues();
  var hdr = data[0];
  var iHash = hdr.indexOf('token_hash'), iExp = hdr.indexOf('expires_at');
  var iVer = hdr.indexOf('verified_at'), iSeen = hdr.indexOf('last_seen_at');
  var iVisits = hdr.indexOf('visits'), iEmail = hdr.indexOf('email');
  var found = -1;
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][iHash]) === hash) { found = i; break; }
  }
  if (found < 0) return _json({ ok:false, error:'Invalid link.' });
  if (new Date(data[found][iExp]).getTime() < Date.now()) {
    return _json({ ok:false, error:'This link has expired. Ask for a fresh one from the sandbox.', code:'expired' });
  }
  var nowIso = new Date().toISOString();
  if (!data[found][iVer]) {
    sheet.getRange(found + 1, iVer + 1).setValue(nowIso);
    _logAudit('sandbox_gate_verified', 'sandbox_gate', '', '');
    // First verification = the engaged-visitor moment. Enroll in the nurture
    // series only if they ticked the box at the gate (consent at capture;
    // the drip walk re-checks marketing consent again at send time).
    var iMc = hdr.indexOf('marketing_consent');
    if (iMc >= 0 && String(data[found][iMc]) === 'yes') {
      _commsEnroll_('sandbox-nurture', String(data[found][iEmail]), 'sandbox_gate', true);
    }
  }
  sheet.getRange(found + 1, iSeen + 1).setValue(nowIso);
  sheet.getRange(found + 1, iVisits + 1).setValue(Number(data[found][iVisits] || 0) + 1);
  return _json({ ok:true, email: String(data[found][iEmail]), verified_at: nowIso });
}

// ============================================================================
// DRIP ENROLLMENT — comms worker /v1/enroll (X-Comms-Internal HMAC).
//
// Enrolling is NOT sending: rows sit in the shared drip tables until the
// sequence is 'active' AND COMMS_DRIP='on' (both Anthony-gated, after DMARC).
// Soft-fail by design — a funnel write must never break the user-facing flow.
// Key lives in gitignored comms-secret.gs (_commsInternalKeyValue_).
// ============================================================================

var COMMS_ENROLL_URL = 'https://comms-send.anthonymowl.workers.dev/v1/enroll';

function _commsEnroll_(sequenceName, recipient, consentSource, marketingConsent) {
  var key = '';
  try { key = _commsInternalKeyValue_(); } catch (_) { return; }  // secret file absent → no-op
  if (!key || !_isValidEmail(recipient)) return;
  try {
    var payload = JSON.stringify({
      project_slug: 'interpreter',
      sequence_name: sequenceName,
      recipient: recipient,
      consent_source: consentSource,
      marketing_consent: marketingConsent ? 1 : 0
    });
    var t = String(Math.floor(Date.now() / 1000));
    var sig = Utilities.base64EncodeWebSafe(
      Utilities.computeHmacSha256Signature(t + '.' + payload, key)
    ).replace(/=+$/, '');
    var resp = UrlFetchApp.fetch(COMMS_ENROLL_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: payload,
      headers: { 'X-Comms-Internal': 't=' + t + ',s=' + sig, 'X-Comms-Caller': 'interpreter-apps-script' },
      muteHttpExceptions: true
    });
    _logAudit('comms_enroll', sequenceName, '', 'http ' + resp.getResponseCode());
  } catch (err) {
    _logAudit('comms_enroll_failed', sequenceName, '', String(err));
  }
}

// ============================================================================
// LEAD CONSOLE — /app/admin/leads. Read Inbound + the Lead_Status overlay.
//
// Reads the Sheet directly (not _dbValues_): this console is host-tenant,
// admin-only, low-volume, and cares most about leads that arrived seconds
// ago — the write-staging surface is by definition the freshest copy.
// ============================================================================

function _canSeeLeads_(s) {
  return _canProvisionTenant(s);  // platform staff or host owner
}

function apiListLeads(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (!_canSeeLeads_(s)) return _json({ ok:false, error:'Platform staff only.' }, 403);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Inbound);
  var leads = [];
  if (sh && sh.getLastRow() > 1) {
    var data = sh.getDataRange().getValues();
    var hdr = data[0];
    for (var i = 1; i < data.length; i++) {
      var o = _rowToObj(hdr, data[i]);
      o.lead_key = String(o.timestamp) + '|' + String(o.email || '');
      leads.push(o);
    }
  }
  // Newest first, cap 500.
  leads.reverse();
  if (leads.length > 500) leads = leads.slice(0, 500);

  // Overlay workflow state.
  var overlay = _leadStatusMap_(ss);
  var nowMs = Date.now();
  for (var j = 0; j < leads.length; j++) {
    var L = leads[j];
    var st = overlay[L.lead_key] || null;
    L.status = st ? st.status : 'new';
    L.owner = st ? st.owner : '';
    L.lead_notes = st ? st.notes : '';
    L.next_action = st ? st.next_action : '';
    L.last_touched_at = st ? st.last_touched_at : '';
    var ageH = (nowMs - new Date(L.timestamp).getTime()) / 3600000;
    L.age_hours = Math.round(ageH * 10) / 10;
    L.sla_breach = (L.status === 'new' && L.form_id !== 'sandbox_gate' && ageH > LEAD_SLA_HOURS);
  }
  return _json({ ok:true, leads: leads });
}

function _leadStatusMap_(ss) {
  var sh = ss.getSheetByName(T_LEAD_STATUS);
  var map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    map[String(o.lead_key)] = o;
  }
  return map;
}

function apiUpdateLead(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (!_canSeeLeads_(s)) return _json({ ok:false, error:'Platform staff only.' }, 403);

  var p = e.parameter || {};
  var leadKey = String(p.lead_key || '').trim();
  if (!leadKey) return _json({ ok:false, error:'lead_key required' });
  var ALLOWED_STATUS = ['new','contacted','session_booked','quoted','won','lost','spam'];
  var status = String(p.status || '').trim();
  if (status && ALLOWED_STATUS.indexOf(status) < 0) {
    return _json({ ok:false, error:'status must be one of: ' + ALLOWED_STATUS.join(', ') });
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = _getOrCreateSheet(ss, T_LEAD_STATUS, [
    'lead_key','status','owner','notes','next_action','last_touched_at','created_at'
  ]);
  var nowIso = new Date().toISOString();
  var data = sheet.getDataRange().getValues();
  var hdr = data[0];
  var iKey = hdr.indexOf('lead_key');
  var found = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iKey]) === leadKey) { found = i; break; }
  }
  var row = {
    lead_key: leadKey,
    status: status || (found >= 0 ? String(data[found][hdr.indexOf('status')]) : 'new'),
    owner: p.owner !== undefined ? String(p.owner) : (found >= 0 ? String(data[found][hdr.indexOf('owner')]) : ''),
    notes: p.notes !== undefined ? String(p.notes) : (found >= 0 ? String(data[found][hdr.indexOf('notes')]) : ''),
    next_action: p.next_action !== undefined ? String(p.next_action) : (found >= 0 ? String(data[found][hdr.indexOf('next_action')]) : ''),
    last_touched_at: nowIso,
    created_at: found >= 0 ? String(data[found][hdr.indexOf('created_at')]) : nowIso
  };
  var arr = hdr.map(function (col) { return row[col] !== undefined ? row[col] : ''; });
  if (found >= 0) {
    sheet.getRange(found + 1, 1, 1, arr.length).setValues([arr]);
  } else {
    sheet.appendRow(arr);
  }
  _logAudit('lead_update', s.payload.tid, s.payload.uid, leadKey + ' → ' + row.status);
  return _json({ ok:true, lead: row });
}

// ============================================================================
// DAILY DIGEST — 8am ET summary of new leads, SLA breaches, pending
// Deaf-owned applications, and sandbox funnel counts.
// ============================================================================

function leadDigestTick() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var nowMs = Date.now();
  var dayAgoMs = nowMs - 24 * 3600000;

  // --- Inbound: new in 24h + SLA breaches -----------------------------------
  var newLines = [], overdueLines = [], countsByForm = {};
  var sh = ss.getSheetByName(T.Inbound);
  if (sh && sh.getLastRow() > 1) {
    var data = sh.getDataRange().getValues();
    var hdr = data[0];
    var overlay = _leadStatusMap_(ss);
    for (var i = 1; i < data.length; i++) {
      var o = _rowToObj(hdr, data[i]);
      var ts = new Date(o.timestamp).getTime();
      var key = String(o.timestamp) + '|' + String(o.email || '');
      var st = overlay[key];
      var status = st ? String(st.status) : 'new';
      if (ts >= dayAgoMs) {
        countsByForm[o.form_id] = (countsByForm[o.form_id] || 0) + 1;
        newLines.push('  • [' + o.form_id + '] ' + (o.name || '(no name)') + ' <' + (o.email || 'no email') + '> — ' + (o.page || ''));
      }
      if (status === 'new' && o.form_id !== 'sandbox_gate' && (nowMs - ts) > LEAD_SLA_HOURS * 3600000) {
        var ageH = Math.round((nowMs - ts) / 3600000);
        overdueLines.push('  • [' + o.form_id + '] ' + (o.name || '(no name)') + ' <' + (o.email || 'no email') + '> — waiting ' + ageH + 'h');
      }
    }
  }
  if (overdueLines.length > 15) {
    var more = overdueLines.length - 15;
    overdueLines = overdueLines.slice(0, 15);
    overdueLines.push('  … and ' + more + ' more');
  }

  // --- Deaf-owned applications pending --------------------------------------
  var pendingApps = 0, oldestAppDays = 0;
  var shA = ss.getSheetByName(T.DeafOwnedApplications);
  if (shA && shA.getLastRow() > 1) {
    var dataA = shA.getDataRange().getValues();
    var hdrA = dataA[0];
    var iStatus = hdrA.indexOf('review_status'), iSub = hdrA.indexOf('submitted_at');
    for (var a = 1; a < dataA.length; a++) {
      if (String(dataA[a][iStatus]) === 'pending') {
        pendingApps++;
        var ageD = (nowMs - new Date(dataA[a][iSub]).getTime()) / 86400000;
        if (ageD > oldestAppDays) oldestAppDays = Math.round(ageD * 10) / 10;
      }
    }
  }

  // --- Sandbox funnel --------------------------------------------------------
  var gatesIssued24 = 0, gatesVerified24 = 0, gatesVerifiedTotal = 0;
  var shS = ss.getSheetByName(T_SANDBOX_TOKENS);
  if (shS && shS.getLastRow() > 1) {
    var dataS = shS.getDataRange().getValues();
    var hdrS = dataS[0];
    var iIss = hdrS.indexOf('issued_at'), iVer = hdrS.indexOf('verified_at');
    for (var sI = 1; sI < dataS.length; sI++) {
      if (new Date(dataS[sI][iIss]).getTime() >= dayAgoMs) gatesIssued24++;
      if (dataS[sI][iVer]) {
        gatesVerifiedTotal++;
        if (new Date(dataS[sI][iVer]).getTime() >= dayAgoMs) gatesVerified24++;
      }
    }
  }

  // --- Compose ----------------------------------------------------------------
  var formSummary = Object.keys(countsByForm).map(function (k) {
    return k + ': ' + countsByForm[k];
  }).join(', ') || 'none';

  var lines = [
    '1891 Interpreter — lead digest for ' + new Date().toDateString(),
    '',
    'New inbound (24h): ' + (newLines.length ? newLines.length + '  (' + formSummary + ')' : 'none'),
  ];
  if (newLines.length) lines = lines.concat(newLines);
  lines.push('');
  lines.push(overdueLines.length
    ? '⚠️ OVER SLA (status "new" > ' + LEAD_SLA_HOURS + 'h): ' + overdueLines.length
    : 'SLA: clear — nothing waiting past ' + LEAD_SLA_HOURS + 'h.');
  if (overdueLines.length) lines = lines.concat(overdueLines);
  lines.push('');
  lines.push('Deaf-owned applications pending: ' + pendingApps +
    (pendingApps ? ' (oldest ' + oldestAppDays + 'd)' : ''));
  lines.push('Sandbox gate: ' + gatesIssued24 + ' issued / ' + gatesVerified24 +
    ' verified (24h); ' + gatesVerifiedTotal + ' verified all-time.');
  lines.push('');
  lines.push('Console: ' + SITE_BASE + '/app/admin/leads/');

  try {
    MailApp.sendEmail({
      to: _digestRecipients_().join(','),
      subject: '[1891 Interpreter] Daily lead digest — ' +
        (newLines.length || 'no') + ' new, ' +
        (overdueLines.length ? overdueLines.length + ' over SLA' : 'SLA clear'),
      body: lines.join('\n'),
      name: BRAND_NAME, replyTo: BRAND_REPLY_TO
    });
  } catch (err) {
    _logAudit('lead_digest_failed', '', '', String(err));
  }
}

function apiInstallLeadDigest(e) {
  var setup = e.parameter.setup;
  if (setup !== SHEET_ID) return _json({ ok:false, error:'Forbidden' }, 403);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'leadDigestTick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('leadDigestTick').timeBased().everyDays(1).atHour(8).create();
  _logAudit('lead_digest.trigger_install', '', '', 'daily 8am ' + Session.getScriptTimeZone());
  return _json({ ok:true, installed:true, hour:8, tz:Session.getScriptTimeZone() });
}
