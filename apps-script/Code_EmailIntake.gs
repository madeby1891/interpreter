/**
 * 1891 Interpreter — inbound email → draft request.
 *
 * The for-requestors promise: "reply to one of your agency's confirmations with
 * a new request — the details are pulled into a draft, a scheduler confirms it,
 * usually within the hour."
 *
 * A time-driven trigger (apiInstallInboundEmailTrigger → runs every 5 min) scans
 * Gmail for unread messages whose subject carries the routing tag
 *
 *     [1891 REQ:<tenant_id>]
 *
 * Confirmation/offer emails embed it via _inboundIntakeSubjectTag_, so a reply
 * keeps it in "Re: … [1891 REQ:<tenant_id>]". Each message body runs through the
 * SHARED ai-intake parser (_aiIntakeParse_ — PHI redacted before the model) and
 * becomes a Jobs row at status REQUESTED, created_via 'email_intake'.
 *
 * NOTHING is booked automatically — a human scheduler reviews and confirms every
 * draft (the for-requestors clinical/legal safeguard). Processed messages are
 * marked read + labelled so they're never double-counted. Voicemail rides the
 * same rail: a transcribed voicemail forwarded into a tagged thread is just
 * another body (telephony capture is a fast-follow).
 */

var INBOUND_INTAKE_LABEL = '1891-intake-processed';
var INBOUND_INTAKE_MAX_PER_RUN = 15;
var INBOUND_INTAKE_TAG_RE = /\[1891 ?REQ:([A-Za-z0-9_\-:]+)\]/i;

// Confirmation/offer senders append this to the subject so replies route back.
function _inboundIntakeSubjectTag_(tenantId) {
  return '[1891 REQ:' + (tenantId || '') + ']';
}

// POST ?action=_install_inbound_email — installs the 5-minute poller.
function apiInstallInboundEmailTrigger(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_platform_staff' && s.payload.role !== 'role_owner') {
    return _json({ ok:false, error:'platform-staff or owner required' }, 403);
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInboundRequestEmails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInboundRequestEmails').timeBased().everyMinutes(5).create();
  _logAudit('email_intake.trigger_install', s.payload.tid, s.payload.uid, 'every 5 min');
  return _json({ ok:true, installed:true });
}

// The trigger body (also safe to run by hand for a one-off sweep).
function processInboundRequestEmails() {
  var label = GmailApp.getUserLabelByName(INBOUND_INTAKE_LABEL) || GmailApp.createLabel(INBOUND_INTAKE_LABEL);
  var threads = GmailApp.search('is:unread -label:"' + INBOUND_INTAKE_LABEL + '" subject:"1891 REQ:"', 0, INBOUND_INTAKE_MAX_PER_RUN);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var made = 0;

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    var msgs = thread.getMessages();
    for (var m = 0; m < msgs.length; m++) {
      var msg = msgs[m];
      if (!msg.isUnread()) continue;
      var subj = msg.getSubject() || '';
      var match = subj.match(INBOUND_INTAKE_TAG_RE);
      if (!match) { msg.markRead(); continue; }

      var tenantId = match[1];
      var from = msg.getFrom() || '';
      var body = (msg.getPlainBody() || '').slice(0, 8000);
      try {
        var r = _aiIntakeParse_(tenantId, body);
        if (r.ok) {
          var jobId = _emailIntakeCreateDraft_(ss, tenantId, r.parsed, { from: from, subject: subj });
          _logAudit('email_intake', tenantId, 'system',
            'job=' + jobId + ' in=' + r.inHash + ' redacted=' + r.redaction.replacements + ' from=' + _sha256Hex(from).slice(0, 12));
          made++;
        } else {
          _logAudit('email_intake_error', tenantId, 'system', String(r.error).slice(0, 120));
        }
      } catch (err) {
        _logAudit('email_intake_exception', tenantId, 'system', String(err).slice(0, 160));
      }
      msg.markRead();
    }
    thread.addLabel(label);
  }
  return made;
}

function _emailIntakeCreateDraft_(ss, tenantId, parsed, meta) {
  _ensureTab(ss, T.Jobs, _tenantSchema().Jobs);
  var now = new Date().toISOString();
  var jobId = _ulid('j');
  var jobsHdr = _tenantSchema().Jobs;
  var requestorId = _emailIntakeResolveRequestor_(ss, tenantId, meta.from);

  var jobRow = {
    job_id: jobId,
    tenant_id: tenantId,
    requestor_id: requestorId,
    modality: parsed.modality || 'on-site',
    service_type: parsed.service_type || 'community',
    source_language_id: parsed.source_language_id || '',
    target_language_id: parsed.target_language_id || '',
    team_config: parsed.team_config || 'solo',
    scheduled_start: parsed.scheduled_start_iso || '',
    scheduled_end: parsed.scheduled_end_iso || '',
    status: 'REQUESTED',
    on_demand: false,
    reference_no: String(meta.subject || '').replace(INBOUND_INTAKE_TAG_RE, '').replace(/^re:\s*/i, '').trim().slice(0, 120),
    notes_to_interpreter: parsed.notes_to_interpreter || '',
    consent_recording: false,
    created_via: 'email_intake',
    ai_intake_id: '',
    rate_applied: JSON.stringify({ ambiguities: parsed.ambiguities || [], via: 'email' }),
    _created_at: now,
    _updated_at: now,
    _rev: 1
  };
  ss.getSheetByName(T.Jobs).appendRow(jobsHdr.map(function (c) {
    return jobRow[c] !== undefined ? jobRow[c] : '';
  }));
  return jobId;
}

// Best-effort: match the sender's email to a known requestor in this tenant.
function _emailIntakeResolveRequestor_(ss, tenantId, from) {
  var mm = String(from).match(/([^<>\s]+@[^<>\s]+)/);
  var email = mm ? mm[1].toLowerCase() : '';
  if (!email) return '';
  var sh = ss.getSheetByName(T.Requestors || 'Requestors');
  if (!sh || sh.getLastRow() < 2) return '';
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iEmail = hdr.indexOf('email');
  var iId = hdr.indexOf('requestor_id');
  var iTid = hdr.indexOf('tenant_id');
  if (iEmail < 0 || iId < 0) return '';
  for (var r = 1; r < data.length; r++) {
    if (iTid >= 0 && String(data[r][iTid]) !== String(tenantId)) continue;
    if (String(data[r][iEmail]).toLowerCase() === email) return data[r][iId];
  }
  return '';
}
