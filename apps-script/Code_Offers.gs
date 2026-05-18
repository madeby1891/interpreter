/**
 * 1891 Interpreter — offer / accept / decline flow with PII reveal.
 *
 * The contract:
 *   When a scheduler offers a job to an interpreter, the interpreter sees a
 *   PII-redacted preview — no consumer name (just initials in `initials-only`
 *   mode, or "[PHI]" placeholder in `full` mode until accept), no MRN, no
 *   phone, no DOB, no specific clinical detail.
 *
 *   Once the interpreter ACCEPTS (or two team members both accept for a
 *   team-of-2 config), the assignment flips to `claim` response and the
 *   full PII becomes available to THAT interpreter only — fetched via a
 *   second API call that confirms the assignment is theirs.
 *
 *   Every PII reveal writes an Audit_Log entry with
 *   action='consumer.read.on_assigned_job' and the assignment_id +
 *   purpose_of_use ('treatment' default).
 *
 * Endpoints (defined here, routed in Code.gs):
 *   GET  ?action=list_my_offers              — interpreter's pending/accepted
 *                                              offers, redacted preview only
 *   GET  ?action=offer_details&assignment_id — preview if response=offered,
 *                                              full PII if response=claim and
 *                                              this user is the assignee
 *   POST action=accept_offer                  — interpreter accepts
 *   POST action=decline_offer                 — interpreter declines (with
 *                                              optional reason)
 *
 * The existing `apiOfferJob` in Code.gs already creates the OFFERED
 * Job_Assignments row; this file extends the lifecycle on the interpreter side.
 */

// ============================================================================
// PUBLIC ENDPOINTS
// ============================================================================

function apiListMyOffers(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  // Resolve interpreter_id for this user
  var interp = _findInterpreterByUserId(ss, s.payload.uid);
  if (!interp && e.parameter.interpreter_id) {
    // Staff can scope to a particular interpreter
    interp = _findInterpreterById(ss, e.parameter.interpreter_id);
  }
  if (!interp) {
    // For staff users without a linked interpreter profile, return empty rather than fail
    return _json({ ok:true, offers:[], note:'No linked interpreter profile.' });
  }

  // All assignments for this interpreter
  var asgSh = ss.getSheetByName(T.JobAssignments);
  if (!asgSh) return _json({ ok:true, offers:[] });
  var asgData = asgSh.getDataRange().getValues();
  if (asgData.length < 2) return _json({ ok:true, offers:[] });
  var aHdr = asgData[0];
  var myAssignments = [];
  for (var i = 1; i < asgData.length; i++) {
    var a = _rowToObj(aHdr, asgData[i]);
    if (a.interpreter_id !== interp.interpreter_id) continue;
    myAssignments.push(a);
  }

  // Fetch the jobs for those assignments
  var jobIds = myAssignments.map(function (a) { return a.job_id; });
  var jobsById = _fetchJobsByIds_(ss, s.payload.tid, jobIds);

  // Build redacted previews
  var agency = _findAgencyRow(ss, s.payload.tid) || {};
  var phiMode = agency.phi_mode || 'initials-only';

  var previews = myAssignments.map(function (a) {
    var job = jobsById[a.job_id];
    if (!job) return null;
    var preview = redactJobForPreview_(job, ss, phiMode);
    preview.assignment_id = a.assignment_id;
    preview.assignment_status = a.status;
    preview.assignment_response = a.response;
    preview.offered_at = a.offered_at;
    preview.responded_at = a.responded_at;
    preview.role_on_job = a.role_on_job;
    preview.pay_rate_snapshot = a.pay_rate_snapshot;
    return preview;
  }).filter(Boolean);

  previews.sort(function (a, b) {
    return String(a.scheduled_start || '').localeCompare(String(b.scheduled_start || ''));
  });

  return _json({ ok:true, offers: previews, interpreter_id: interp.interpreter_id });
}

function apiOfferDetails(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var assignmentId = e.parameter.assignment_id;
  if (!assignmentId) return _json({ ok:false, error:'assignment_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);

  // Look up the assignment
  var asgSh = ss.getSheetByName(T.JobAssignments);
  if (!asgSh) return _json({ ok:false, error:'No assignments' }, 404);
  var data = asgSh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('assignment_id');
  var asgRow = null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iId]) === assignmentId) { asgRow = _rowToObj(hdr, data[i]); break; }
  }
  if (!asgRow) return _json({ ok:false, error:'Assignment not found' }, 404);

  // Check who can see what
  // - The assigned interpreter (resolve via user_id) sees redacted if response='offered',
  //   full if response='claim'
  // - Staff (owner/admin/scheduler) always see full
  // - Anyone else: forbidden
  var isStaff = (s.payload.role === 'role_owner' || s.payload.role === 'role_admin' || s.payload.role === 'role_scheduler');
  var interp = _findInterpreterById(ss, asgRow.interpreter_id);
  var isSelfInterpreter = interp && interp.user_id === s.payload.uid;
  if (!isStaff && !isSelfInterpreter) return _json({ ok:false, error:'Forbidden' }, 403);

  var job = _findJob(ss, s.payload.tid, asgRow.job_id);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);

  var agency = _findAgencyRow(ss, s.payload.tid) || {};
  var phiMode = agency.phi_mode || 'initials-only';

  var revealFull = isStaff ||
    (isSelfInterpreter && (asgRow.response === 'claim' || asgRow.status === 'CLAIMED' ||
                            asgRow.status === 'CONFIRMED' || asgRow.status === 'IN_PROGRESS' ||
                            asgRow.status === 'COMPLETED'));

  var detail;
  if (revealFull) {
    detail = revealJobForAssignee_(job, ss, phiMode);
    detail._pii_revealed = true;
    // Audit the PII read
    _logAudit('consumer.read.on_assigned_job', s.payload.tid, s.payload.uid,
              'assignment=' + assignmentId + ' purpose=treatment');
  } else {
    detail = redactJobForPreview_(job, ss, phiMode);
    detail._pii_revealed = false;
  }

  // Attach assignment-level metadata
  detail.assignment_id = asgRow.assignment_id;
  detail.assignment_status = asgRow.status;
  detail.assignment_response = asgRow.response;
  detail.role_on_job = asgRow.role_on_job;
  detail.pay_rate_snapshot = asgRow.pay_rate_snapshot;

  // For team-of-2 / cdi+hearing — include co-interpreter info if revealed
  if (revealFull && (job.team_config === 'team-of-2' || job.team_config === 'cdi+hearing' || job.team_config === 'voicer+signer')) {
    detail.co_interpreters = _findCoInterpreters_(ss, job.job_id, asgRow.assignment_id);
  }

  // Include notes on the assignment (shared by team members and staff)
  detail.assignment_notes = _listAssignmentNotes_(ss, s.payload.tid, asgRow.assignment_id);

  return _json({ ok:true, detail: detail });
}

function apiAcceptOffer(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var assignmentId = e.parameter.assignment_id;
  if (!assignmentId) return _json({ ok:false, error:'assignment_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);

  // Look up assignment
  var asgSh = ss.getSheetByName(T.JobAssignments);
  var data = asgSh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('assignment_id');
  var iResp = hdr.indexOf('response');
  var iStatus = hdr.indexOf('status');
  var iResponded = hdr.indexOf('responded_at');
  var iInterp = hdr.indexOf('interpreter_id');
  var iJob = hdr.indexOf('job_id');
  var iUpdated = hdr.indexOf('_updated_at');
  var iRev = hdr.indexOf('_rev');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) !== assignmentId) continue;
    var asgInterpId = String(data[r][iInterp]);
    // Authorize: the assignee (via user_id link) or staff
    var isStaff = (s.payload.role === 'role_owner' || s.payload.role === 'role_admin' || s.payload.role === 'role_scheduler');
    var interp = _findInterpreterById(ss, asgInterpId);
    var isSelf = interp && interp.user_id === s.payload.uid;
    if (!isStaff && !isSelf) return _json({ ok:false, error:'Forbidden' }, 403);

    var currentResp = String(data[r][iResp]);
    if (currentResp === 'claim') return _json({ ok:false, error:'Already accepted' });
    if (currentResp === 'decline') return _json({ ok:false, error:'Already declined; request a fresh offer' });

    var nowIso = new Date().toISOString();
    asgSh.getRange(r + 1, iResp + 1).setValue('claim');
    asgSh.getRange(r + 1, iStatus + 1).setValue('CLAIMED');
    asgSh.getRange(r + 1, iResponded + 1).setValue(nowIso);
    asgSh.getRange(r + 1, iUpdated + 1).setValue(nowIso);
    asgSh.getRange(r + 1, iRev + 1).setValue(Number(data[r][iRev] || 0) + 1);

    // Flip the job to CLAIMED — but only if its current status is OPEN or OFFERED
    var jobId = String(data[r][iJob]);
    var job = _findJob(ss, s.payload.tid, jobId);
    if (job && (job.status === 'OPEN' || job.status === 'OFFERED')) {
      _setJobField(ss, s.payload.tid, jobId, 'status', 'CLAIMED');
      _appendJobEvent(ss, jobId, s.payload.uid, 'status_change', job.status, 'CLAIMED',
                      JSON.stringify({ assignment_id: assignmentId }));
    }
    _appendJobEvent(ss, jobId, s.payload.uid, 'offer_accepted', 'offered', 'claim',
                    JSON.stringify({ assignment_id: assignmentId, interpreter_id: asgInterpId }));
    _logAudit('offer.accept', s.payload.tid, s.payload.uid, assignmentId);

    // For team-of-2 — if both legs are now claimed, fire a team-formed event +
    // schedule contact-exchange emails (deferred to v17 cron; for now, just event)
    if (job && (job.team_config === 'team-of-2' || job.team_config === 'cdi+hearing' || job.team_config === 'voicer+signer')) {
      var cos = _findCoInterpreters_(ss, jobId, assignmentId);
      var anyOutstanding = cos.some(function (c) { return c.response !== 'claim'; });
      if (!anyOutstanding && cos.length > 0) {
        _appendJobEvent(ss, jobId, 'system', 'team_formed', '', '',
                        JSON.stringify({ members: cos.map(function (c) { return c.interpreter_id; }) }));
        _sendTeamContactExchange_(ss, s.payload.tid, jobId, cos.concat([{ assignment_id: assignmentId, interpreter_id: asgInterpId }]));
      }
    }

    return _json({ ok:true, assignment_id: assignmentId, status:'CLAIMED' });
  }
  return _json({ ok:false, error:'Assignment not found' }, 404);
}

function apiDeclineOffer(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var assignmentId = e.parameter.assignment_id;
  var reason = e.parameter.reason || '';
  if (!assignmentId) return _json({ ok:false, error:'assignment_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);

  var asgSh = ss.getSheetByName(T.JobAssignments);
  var data = asgSh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('assignment_id');
  var iResp = hdr.indexOf('response');
  var iStatus = hdr.indexOf('status');
  var iResponded = hdr.indexOf('responded_at');
  var iInterp = hdr.indexOf('interpreter_id');
  var iJob = hdr.indexOf('job_id');
  var iUpdated = hdr.indexOf('_updated_at');
  var iRev = hdr.indexOf('_rev');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) !== assignmentId) continue;
    var asgInterpId = String(data[r][iInterp]);
    var isStaff = (s.payload.role === 'role_owner' || s.payload.role === 'role_admin' || s.payload.role === 'role_scheduler');
    var interp = _findInterpreterById(ss, asgInterpId);
    var isSelf = interp && interp.user_id === s.payload.uid;
    if (!isStaff && !isSelf) return _json({ ok:false, error:'Forbidden' }, 403);

    if (String(data[r][iResp]) === 'claim') return _json({ ok:false, error:'Already accepted; cannot decline' });

    var nowIso = new Date().toISOString();
    asgSh.getRange(r + 1, iResp + 1).setValue('decline');
    asgSh.getRange(r + 1, iStatus + 1).setValue('DECLINED');
    asgSh.getRange(r + 1, iResponded + 1).setValue(nowIso);
    asgSh.getRange(r + 1, iUpdated + 1).setValue(nowIso);
    asgSh.getRange(r + 1, iRev + 1).setValue(Number(data[r][iRev] || 0) + 1);

    var jobId = String(data[r][iJob]);
    _appendJobEvent(ss, jobId, s.payload.uid, 'offer_declined', 'offered', 'decline',
                    JSON.stringify({ assignment_id: assignmentId, reason: reason }));
    _logAudit('offer.decline', s.payload.tid, s.payload.uid, assignmentId + ' reason=' + reason);

    // If this was the only outstanding offer on the job AND no claim exists,
    // flip job back to OPEN so the scheduler can re-fill
    var job = _findJob(ss, s.payload.tid, jobId);
    if (job && job.status === 'OFFERED') {
      var allAsg = _allAssignmentsForJob_(ss, jobId);
      var anyClaimed = allAsg.some(function (a) { return a.response === 'claim'; });
      var anyOutstanding = allAsg.some(function (a) { return a.response === 'offered'; });
      if (!anyClaimed && !anyOutstanding) {
        _setJobField(ss, s.payload.tid, jobId, 'status', 'OPEN');
        _appendJobEvent(ss, jobId, 'system', 'status_change', 'OFFERED', 'OPEN',
                        JSON.stringify({ reason: 'all offers declined' }));
      }
    }
    return _json({ ok:true, assignment_id: assignmentId, status:'DECLINED' });
  }
  return _json({ ok:false, error:'Assignment not found' }, 404);
}

// ============================================================================
// REDACTION + REVEAL
// ============================================================================

function redactJobForPreview_(job, ss, phiMode) {
  // Returns a job object with consumer details redacted.
  // Common fields: job_id, service_type, modality, target_language_id,
  // source_language_id, team_config, scheduled_start, scheduled_end,
  // location (general — city/state, NOT street), payer/requestor (display
  // name only), pay rate snapshot, notes (already scrubbed by intake), team_config.
  //
  // Never in preview: consumer_id, display_initials, DOB, MRN, name, encrypted
  // legal fields, specific room/suite numbers.

  var loc = job.location_id ? _findLocationGeneral_(ss, job.location_id) : null;
  var req = job.requestor_id ? _findRequestorPublic_(ss, job.requestor_id) : null;
  return {
    job_id: job.job_id,
    service_type: job.service_type,
    modality: job.modality,
    target_language_id: job.target_language_id,
    source_language_id: job.source_language_id,
    team_config: job.team_config,
    scheduled_start: job.scheduled_start,
    scheduled_end: job.scheduled_end,
    requestor: req ? { display_name: req.display_name, type: req.type } : null,
    location_general: loc ? { city: loc.city, state: loc.state } : null,
    on_demand: job.on_demand,
    reference_no: job.reference_no || '',
    notes_preview: _redactInlinePhi_(job.notes_to_interpreter || ''),
    consent_recording: job.consent_recording,
    consumer_initials_redacted: '[reveal on accept]',
    consumer_lang_pref_hint: null,  // not shown in preview
    consumer_communication_prefs: null,
    is_preview: true
  };
}

function revealJobForAssignee_(job, ss, phiMode) {
  // Returns full job + consumer detail for the assigned interpreter.
  // In phi_mode='initials-only', only display_initials + communication_prefs;
  // in phi_mode='full', also legal_first, dob, MRN (when staff configures the
  // consumer record with them). We never auto-decrypt; if encrypted fields are
  // present, we return them as ciphertext — the agency configures decryption
  // separately (a future "consumer reveal" UI fetches via a key-wrap path).

  var loc = job.location_id ? _findLocationFull_(ss, job.location_id) : null;
  var req = job.requestor_id ? _findRequestorFull_(ss, job.requestor_id) : null;
  var consumer = job.consumer_id ? _findConsumerForReveal_(ss, job.consumer_id, phiMode) : null;
  return {
    job_id: job.job_id,
    service_type: job.service_type,
    modality: job.modality,
    target_language_id: job.target_language_id,
    source_language_id: job.source_language_id,
    team_config: job.team_config,
    scheduled_start: job.scheduled_start,
    scheduled_end: job.scheduled_end,
    requestor: req,
    location: loc,
    on_demand: job.on_demand,
    reference_no: job.reference_no || '',
    notes_to_interpreter: job.notes_to_interpreter || '',
    consent_recording: job.consent_recording,
    consumer: consumer,
    is_preview: false
  };
}

function _redactInlinePhi_(text) {
  if (!text) return '';
  // Mirror the AI-intake redactor's behavior — strip anything that looks like
  // PHI from notes_to_interpreter for the preview.
  var t = String(text);
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]');
  t = t.replace(/\b\d{8,12}\b/g, '[ID]');
  t = t.replace(/(\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, '[PHONE]');
  t = t.replace(/\b(0?[1-9]|1[0-2])[\/\-](0?[1-9]|[12]\d|3[01])[\/\-](19|20)\d{2}\b/g, '[DATE]');
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');
  t = t.replace(/\b(patient|Mr\.?|Mrs\.?|Ms\.?|Dr\.?)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g,
    function (m) { return m.split(/\s+/)[0] + ' [NAME]'; });
  return t;
}

function _findLocationGeneral_(ss, locationId) {
  var loc = _findLocationFull_(ss, locationId);
  if (!loc) return null;
  return { city: loc.city, state: loc.state, modalities_supported: loc.modalities_supported };
}

function _findLocationFull_(ss, locationId) {
  var sh = ss.getSheetByName(T.Locations);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.location_id === locationId) return o;
  }
  return null;
}

function _findRequestorPublic_(ss, requestorId) {
  var r = _findRequestorFull_(ss, requestorId);
  if (!r) return null;
  return { requestor_id: r.requestor_id, display_name: r.display_name, type: r.type };
}

function _findRequestorFull_(ss, requestorId) {
  var sh = ss.getSheetByName(T.Requestors);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.requestor_id === requestorId) return o;
  }
  return null;
}

function _findConsumerForReveal_(ss, consumerId, phiMode) {
  var sh = ss.getSheetByName(T.Consumers);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.consumer_id !== consumerId) continue;
    // In initials-only mode, return ONLY display_initials + communication_prefs
    if (phiMode === 'initials-only') {
      return {
        consumer_id: o.consumer_id,
        display_initials: o.display_initials,
        primary_language_id: o.primary_language_id,
        communication_prefs: o.communication_prefs,
        // Encrypted fields not surfaced; agency on `full` mode + key reveal
        _phi_mode: 'initials-only'
      };
    }
    if (phiMode === 'full') {
      // We don't auto-decrypt envelope-encrypted fields. Return what's plaintext.
      return {
        consumer_id: o.consumer_id,
        display_initials: o.display_initials,
        primary_language_id: o.primary_language_id,
        communication_prefs: o.communication_prefs,
        // Encrypted-at-rest fields require a separate decrypt flow (deferred).
        // For now, indicate they exist but aren't surfaced.
        has_encrypted_legal_name: !!(o.legal_first_encrypted || o.legal_last_encrypted),
        has_encrypted_dob: !!o.dob_encrypted,
        has_encrypted_mrn: !!o.mrn_encrypted,
        _phi_mode: 'full',
        _note: 'Encrypted fields require break-glass decrypt flow (not implemented v1)'
      };
    }
    // disabled mode: nothing
    return null;
  }
  return null;
}

function _findInterpreterByUserId(ss, userId) {
  var sh = ss.getSheetByName(T.Interpreters);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.user_id === userId) return o;
  }
  return null;
}

function _findCoInterpreters_(ss, jobId, excludingAssignmentId) {
  var sh = ss.getSheetByName(T.JobAssignments);
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var a = _rowToObj(hdr, data[i]);
    if (a.job_id !== jobId) continue;
    if (a.assignment_id === excludingAssignmentId) continue;
    // Enrich with interpreter display name
    var interp = _findInterpreterById(ss, a.interpreter_id);
    out.push({
      assignment_id: a.assignment_id,
      interpreter_id: a.interpreter_id,
      role_on_job: a.role_on_job,
      response: a.response,
      status: a.status,
      display_name: interp ? ((interp.legal_first || '') + ' ' + (interp.legal_last || '')) : '',
      deaf: interp ? (interp.deaf === true || interp.deaf === 'true') : false
    });
  }
  return out;
}

function _allAssignmentsForJob_(ss, jobId) {
  var sh = ss.getSheetByName(T.JobAssignments);
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var a = _rowToObj(hdr, data[i]);
    if (a.job_id === jobId) out.push(a);
  }
  return out;
}

function _fetchJobsByIds_(ss, tenantId, jobIds) {
  var ids = {};
  jobIds.forEach(function (id) { ids[id] = true; });
  var sh = ss.getSheetByName(T.Jobs);
  if (!sh) return {};
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return {};
  var hdr = data[0];
  var out = {};
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id !== tenantId) continue;
    if (!ids[o.job_id]) continue;
    out[o.job_id] = o;
  }
  return out;
}

// ============================================================================
// ASSIGNMENT NOTES — team coordination
// ============================================================================

function apiAddAssignmentNote(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var assignmentId = e.parameter.assignment_id;
  var body = e.parameter.body || '';
  if (!assignmentId || !body) return _json({ ok:false, error:'assignment_id + body required' });
  var visibility = e.parameter.visibility || 'team'; // 'team' (interpreters + staff) or 'staff_only'

  var ss = SpreadsheetApp.openById(SHEET_ID);
  // Verify the user is either the assignee or staff
  var asgSh = ss.getSheetByName(T.JobAssignments);
  var data = asgSh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('assignment_id'), iInterp = hdr.indexOf('interpreter_id'), iJob = hdr.indexOf('job_id');
  var asg = null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iId]) === assignmentId) { asg = _rowToObj(hdr, data[i]); break; }
  }
  if (!asg) return _json({ ok:false, error:'Assignment not found' }, 404);

  var isStaff = (s.payload.role === 'role_owner' || s.payload.role === 'role_admin' || s.payload.role === 'role_scheduler');
  var interp = _findInterpreterById(ss, asg.interpreter_id);
  var isSelf = interp && interp.user_id === s.payload.uid;
  if (!isStaff && !isSelf) return _json({ ok:false, error:'Forbidden' }, 403);

  _ensureTab(ss, T.AssignmentNotes, _tenantSchema().Assignment_Notes);
  var noteSh = ss.getSheetByName(T.AssignmentNotes);
  var id = _ulid('an');
  var nowIso = new Date().toISOString();
  var row = {
    note_id: id, tenant_id: s.payload.tid,
    assignment_id: assignmentId, job_id: asg.job_id,
    author_user_id: s.payload.uid,
    author_role: isStaff ? s.payload.role : 'interpreter',
    body: _redactInlinePhi_(body),
    visibility: visibility,
    _created_at: nowIso
  };
  noteSh.appendRow(_tenantSchema().Assignment_Notes.map(function (c) { return row[c] !== undefined ? row[c] : ''; }));
  _logAudit('assignment_note.add', s.payload.tid, s.payload.uid, id);
  return _json({ ok:true, note_id: id });
}

function _listAssignmentNotes_(ss, tenantId, assignmentId) {
  var sh = ss.getSheetByName(T.AssignmentNotes);
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var n = _rowToObj(hdr, data[i]);
    if (n.tenant_id !== tenantId) continue;
    if (n.assignment_id !== assignmentId) continue;
    out.push(n);
  }
  out.sort(function (a, b) { return String(a._created_at).localeCompare(String(b._created_at)); });
  return out;
}

// ============================================================================
// TEAM CONTACT EXCHANGE — fired once when all team legs are claimed
// ============================================================================

function _sendTeamContactExchange_(ss, tenantId, jobId, allCos) {
  // For each pair of team members, send the other one's name + email so they
  // can coordinate. This is the ONLY context where co-interpreter contact info
  // crosses interpreter boundaries automatically.
  var unique = {};
  allCos.forEach(function (c) { unique[c.assignment_id] = c; });
  var members = Object.keys(unique).map(function (k) { return unique[k]; });
  if (members.length < 2) return;

  // Resolve email per member
  members.forEach(function (m) {
    var interp = _findInterpreterById(ss, m.interpreter_id);
    if (!interp) return;
    var user = interp.user_id ? _lookupUserById(ss, interp.user_id) : null;
    m.email = user ? user.email : null;
    m.first = interp.legal_first || '';
    m.last = interp.legal_last || '';
  });

  var job = _findJob(ss, tenantId, jobId);
  var startStr = job ? _formatLocalTime(job.scheduled_start, 'America/New_York') : '';

  members.forEach(function (me) {
    if (!me.email) return;
    var others = members.filter(function (x) { return x.interpreter_id !== me.interpreter_id; });
    var lines = others.map(function (o) {
      return '· ' + (o.first + ' ' + o.last).trim() + ' (' + (o.role_on_job || 'team') + ')' +
             (o.email ? ' — ' + o.email : '');
    });
    var subject = '1891 Interpreter — your team is set for ' + (job ? job.service_type : 'this job');
    var body =
      'Hi ' + me.first + ',\n\n' +
      'You are on a team-of-' + members.length + ' interpretation for ' + startStr + '.\n\n' +
      'Your teammate(s):\n' + lines.join('\n') + '\n\n' +
      'Reach out to coordinate role split, breaks, and feed strategy. You can also use the in-app assignment notes:\n' +
      SITE_BASE + '/app/me/offers/?assignment=' + me.assignment_id + '\n\n' +
      '— 1891 Interpreter';
    try {
      MailApp.sendEmail({ to: me.email, subject: subject, body: body });
      _logCommunication(ss, tenantId, 'email', 'out', 'team_contact_exchange_v1',
                        '', me.email, 'sent', 'mailapp', jobId);
    } catch (err) {
      _logCommunication(ss, tenantId, 'email', 'out', 'team_contact_exchange_v1',
                        '', me.email, 'failed', 'mailapp', jobId);
    }
  });
}
