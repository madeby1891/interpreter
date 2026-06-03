/**
 * 1891 Interpreter — Document translation (PRD A4 §workers/translate, Section C).
 *
 * Implementations for the route stubs the orchestrator wires into Code.gs:
 *   GET:  list_documents, get_document, download_translation
 *   POST: create_translation_job, start_translation, submit_translation_review,
 *         approve_translation, reject_translation, cancel_translation
 *
 * Architecture (per orchestrator brief):
 *   - The translation Job lives in the existing Jobs tab with service_type='translation'.
 *   - The source-text body lives in Documents (kind='translation-source'), with
 *     a sanitized 500-char preview AND a SHA-256 hash on the row; the full text
 *     is held in a separate Translation_Sources tab so the Documents row stays
 *     small for fast Sheet I/O.
 *   - The translator's submission lives in a second Documents row
 *     (kind='translation-target'), again with the full text in Translation_Targets.
 *   - Status flow on the Jobs row:
 *        REQUESTED → IN_TRANSLATION → IN_REVIEW → APPROVED → DELIVERED
 *     Cannot skip from REQUESTED straight to APPROVED — review is the gate.
 *   - Hard-gate (medical / mental-health / legal / gov): the Worker refuses
 *     MT pre-fill. This file is unaware of the gate; UI surfaces the banner.
 *
 * Conventions follow Code.gs:
 *   - _requireSession(e), _ensureTab, _rowToObj, _ulid, _logAudit, _json reused.
 *   - tenant_id from session (s.payload.tid).
 *   - PII rule: audit logs carry IDs and hashes only — never source_text or
 *     translated_text. Same hash-only contract as ai_intake in Code.gs.
 *   - The MT pre-fill itself does NOT go through Apps Script. The Worker calls
 *     DeepL/Claude directly with Worker secrets and returns the draft to the
 *     UI, which the translator can paste into apiSubmitTranslationReview.
 *
 * Tabs used:
 *   - Jobs (existing)
 *   - Documents (existing, kinds: translation-source, translation-target)
 *   - Job_Events (existing)
 *   - Audit_Log (existing)
 *   - Translation_Sources (NEW — created lazily): job_id, document_id, full_text, _created_at
 *   - Translation_Targets (NEW — created lazily): job_id, document_id, full_text,
 *       translator_user_id, _created_at, _updated_at
 */

// ============================================================================
// TAB NAMES (file-local) + headers
// ============================================================================

var T_TR_SOURCES = 'Translation_Sources';
var T_TR_TARGETS = 'Translation_Targets';

function _trSchemas() {
  return {
    Translation_Sources: ['job_id','document_id','tenant_id','full_text','_created_at'],
    Translation_Targets: ['job_id','document_id','tenant_id','full_text','translator_user_id','_created_at','_updated_at']
  };
}

// Service types that are NEVER machine pre-filled. Mirrors the Worker.
var TR_HARD_GATED = { 'medical':1, 'mental-health':1, 'legal':1, 'gov':1 };

// Statuses on a translation Job, in order.
var TR_STATUSES = ['REQUESTED','IN_TRANSLATION','IN_REVIEW','APPROVED','DELIVERED','CANCELLED_BY_AGENCY','REJECTED_TO_TRANSLATOR'];

// ============================================================================
// LIST / GET DOCUMENTS
// ============================================================================

function apiListDocuments(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Documents, _tenantSchema().Documents);
  var sh = ss.getSheetByName(T.Documents);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, documents: [] });

  var hdr = data[0];
  var kindFilter = String(p.kind || '');
  var jobsByIdx = _trJobsByIdIdx(ss, s.payload.tid); // small index for status enrichment
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (String(o.tenant_id) !== String(s.payload.tid)) continue;
    if (kindFilter && String(o.kind) !== kindFilter) continue;
    // Strip any raw blob fields the Documents row doesn't carry (defense in depth)
    if (o.linked_job_id && jobsByIdx[o.linked_job_id]) {
      var j = jobsByIdx[o.linked_job_id];
      o.job_status = j.status;
      o.job_service_type = j.service_type;
      o.job_source_language_id = j.source_language_id;
      o.job_target_language_id = j.target_language_id;
      o.job_scheduled_end = j.scheduled_end;
    }
    out.push(o);
  }
  return _json({ ok:true, documents: out });
}

function apiGetDocument(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var docId = e.parameter.id;
  if (!docId) return _json({ ok:false, error:'id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var doc = _trFindDocument(ss, s.payload.tid, docId);
  if (!doc) return _json({ ok:false, error:'Document not found' }, 404);

  // For translation source/target docs, pull the full text from the sibling tab.
  var fullText = '';
  if (doc.kind === 'translation-source') {
    fullText = _trFindFullText(ss, T_TR_SOURCES, doc.linked_job_id, doc.document_id);
  } else if (doc.kind === 'translation-target') {
    fullText = _trFindFullText(ss, T_TR_TARGETS, doc.linked_job_id, doc.document_id);
  }

  // Sibling docs on the same job
  var siblings = [];
  if (doc.linked_job_id) {
    var sh = ss.getSheetByName(T.Documents);
    var data = sh.getDataRange().getValues();
    var hdr = data[0];
    for (var i = 1; i < data.length; i++) {
      var o = _rowToObj(hdr, data[i]);
      if (String(o.tenant_id) !== String(s.payload.tid)) continue;
      if (o.linked_job_id !== doc.linked_job_id) continue;
      if (o.document_id === doc.document_id) continue;
      siblings.push(o);
    }
  }

  // Linked Job (for status / language / service_type)
  var job = doc.linked_job_id ? _trFindJob(ss, s.payload.tid, doc.linked_job_id) : null;

  return _json({ ok:true, document: doc, full_text: fullText, siblings: siblings, job: job });
}

// ============================================================================
// CREATE TRANSLATION JOB
// ============================================================================

function apiCreateTranslationJob(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};

  var sourceText = String(p.source_text || '');
  var sourceLang = String(p.source_language_id || '');
  var targetLang = String(p.target_language_id || '');
  var serviceType = String(p.service_type || '');
  var requestorId = String(p.requestor_id || '');
  // Source may be pasted text OR an uploaded file (apiUploadTranslationSource
  // returns the drive_id passed here). A binary upload carries no inline text;
  // the human translator opens the file via get_translation_source.
  var sourceDriveId = String(p.source_drive_id || '');
  if (!sourceText.trim() && !sourceDriveId) {
    return _json({ ok:false, error:'source_text or an uploaded file is required' });
  }
  if (!sourceLang)        return _json({ ok:false, error:'source_language_id required' });
  if (!targetLang)        return _json({ ok:false, error:'target_language_id required' });
  if (!serviceType)       return _json({ ok:false, error:'service_type required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Jobs, _tenantSchema().Jobs);
  _ensureTab(ss, T.Documents, _tenantSchema().Documents);
  _ensureTab(ss, T_TR_SOURCES, _trSchemas().Translation_Sources);

  var now = new Date().toISOString();
  var jobId = _ulid('j');
  var docId = _ulid('doc');
  var sourceHash = sourceText.trim() ? _sha256Hex(sourceText) : String(p.source_sha256 || '');
  var preview = sourceText.trim()
    ? sourceText.replace(/\s+/g, ' ').slice(0, 500)
    : ('(uploaded file: ' + (p.source_filename || 'document') + ')');

  // 1. Jobs row — service_type='translation', status='REQUESTED'.
  var jobsHdr = _tenantSchema().Jobs;
  var jobRow = {
    job_id: jobId,
    tenant_id: s.payload.tid,
    requestor_id: requestorId,
    requestor_contact_id: p.requestor_contact_id || '',
    payer_id: p.payer_id || '',
    location_id: '',
    consumer_id: '',
    modality: 'doc_translation',
    service_type: 'translation',
    source_language_id: sourceLang,
    target_language_id: targetLang,
    team_config: 'solo',
    scheduled_start: now,
    scheduled_end: p.due_at || '',
    actual_start: '',
    actual_end: '',
    status: 'REQUESTED',
    on_demand: false,
    reference_no: p.reference_no || '',
    notes_to_interpreter: p.notes || '',
    consent_recording: false,
    recording_r2_key: '',
    transcript_r2_key: '',
    created_via: 'translate_intake',
    ai_intake_id: '',
    rate_applied: JSON.stringify({ service_subtype: serviceType, hard_gated: !!TR_HARD_GATED[serviceType] }),
    cancellation_reason: '',
    cancellation_at: '',
    _created_at: now,
    _updated_at: now,
    _rev: 1
  };
  ss.getSheetByName(T.Jobs).appendRow(jobsHdr.map(function (c) {
    return jobRow[c] !== undefined ? jobRow[c] : '';
  }));

  // 2. Documents row for the source — preview only, hash for integrity.
  var docHdr = _tenantSchema().Documents;
  var docRow = {
    document_id: docId,
    tenant_id: s.payload.tid,
    kind: 'translation-source',
    r2_key: sourceDriveId ? ('drive:' + sourceDriveId) : '',  // uploaded file, served via get_translation_source
    mime: sourceDriveId ? (p.source_mime || 'application/octet-stream') : 'text/plain',
    sha256: sourceHash,
    size_bytes: sourceDriveId ? Number(p.source_size_bytes || 0) : sourceText.length,
    linked_job_id: jobId,
    linked_interpreter_id: '',
    linked_consumer_id: '',
    uploaded_by_user_id: s.payload.uid,
    signed_url_expiry_default: '',
    retention_class: 'R7y',
    _created_at: now,
    _updated_at: now,
    source_text_preview: preview
  };
  // Documents schema may not include source_text_preview; append as a JSON tail in notes
  // if the column isn't present. The orchestrator can add the column in a follow-up.
  var docArr = docHdr.map(function (c) { return docRow[c] !== undefined ? docRow[c] : ''; });
  ss.getSheetByName(T.Documents).appendRow(docArr);

  // 3. Full source text in Translation_Sources (separate tab keeps Documents lean).
  ss.getSheetByName(T_TR_SOURCES).appendRow([jobId, docId, s.payload.tid, sourceText, now]);

  // 4. Job_Events row for the state transition.
  _appendJobEvent(ss, jobId, s.payload.uid, 'status_change', '', 'REQUESTED', JSON.stringify({
    service_subtype: serviceType,
    hard_gated: !!TR_HARD_GATED[serviceType],
    source_hash: sourceHash.slice(0, 16),
    chars: sourceText.length
  }));

  // 5. Audit (hashes + IDs only).
  _logAudit('translation.create', s.payload.tid, s.payload.uid,
    'job=' + jobId + ' doc=' + docId + ' svc=' + serviceType + ' hash=' + sourceHash.slice(0, 16));

  return _json({ ok:true, job_id: jobId, document_id: docId, hard_gated: !!TR_HARD_GATED[serviceType] });
}

// ============================================================================
// START TRANSLATION — assign a translator, move REQUESTED → IN_TRANSLATION
// ============================================================================

function apiStartTranslation(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  var translatorId = e.parameter.interpreter_id || '';
  if (!jobId) return _json({ ok:false, error:'job_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _trFindJob(ss, s.payload.tid, jobId);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);
  if (String(job.status) !== 'REQUESTED') {
    return _json({ ok:false, error:'Cannot start from status ' + job.status });
  }

  // Flip Jobs.status, append assignment row, append Job_Event.
  var ok = _trSetJobStatus(ss, s.payload.tid, jobId, 'IN_TRANSLATION');
  if (!ok) return _json({ ok:false, error:'Could not set status' });

  if (translatorId) {
    var asch = _tenantSchema().Job_Assignments;
    _ensureTab(ss, T.JobAssignments, asch);
    var now = new Date().toISOString();
    var aRow = {
      assignment_id: _ulid('a'),
      job_id: jobId,
      interpreter_id: translatorId,
      role_on_job: 'translator',
      offered_at: now,
      responded_at: now,
      response: 'assigned',
      pay_rate_snapshot: '{}',
      billable_minutes: 0,
      status: 'CLAIMED',
      _created_at: now,
      _updated_at: now,
      _rev: 1
    };
    ss.getSheetByName(T.JobAssignments).appendRow(asch.map(function (c) {
      return aRow[c] !== undefined ? aRow[c] : '';
    }));
  }

  _appendJobEvent(ss, jobId, s.payload.uid, 'status_change', 'REQUESTED', 'IN_TRANSLATION',
    JSON.stringify({ translator: translatorId || null }));
  _logAudit('translation.start', s.payload.tid, s.payload.uid, 'job=' + jobId + ' translator=' + translatorId);
  return _json({ ok:true, job_id: jobId, status: 'IN_TRANSLATION' });
}

// ============================================================================
// SUBMIT FOR REVIEW — translator turns in their work, IN_TRANSLATION → IN_REVIEW
// ============================================================================

function apiSubmitTranslationReview(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  var jobId = p.job_id;
  var translated = String(p.translated_text || '');
  if (!jobId) return _json({ ok:false, error:'job_id required' });
  if (!translated.trim()) return _json({ ok:false, error:'translated_text required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _trFindJob(ss, s.payload.tid, jobId);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);
  if (String(job.status) !== 'IN_TRANSLATION') {
    return _json({ ok:false, error:'Cannot submit from status ' + job.status });
  }

  _ensureTab(ss, T_TR_TARGETS, _trSchemas().Translation_Targets);
  var now = new Date().toISOString();
  var docId = _ulid('doc');
  var docHdr = _tenantSchema().Documents;
  var hash = _sha256Hex(translated);
  var docRow = {
    document_id: docId,
    tenant_id: s.payload.tid,
    kind: 'translation-target',
    r2_key: '',
    mime: 'text/plain',
    sha256: hash,
    size_bytes: translated.length,
    linked_job_id: jobId,
    linked_interpreter_id: s.payload.uid,
    linked_consumer_id: '',
    uploaded_by_user_id: s.payload.uid,
    signed_url_expiry_default: '',
    retention_class: 'R7y',
    _created_at: now,
    _updated_at: now
  };
  ss.getSheetByName(T.Documents).appendRow(docHdr.map(function (c) {
    return docRow[c] !== undefined ? docRow[c] : '';
  }));
  ss.getSheetByName(T_TR_TARGETS).appendRow([jobId, docId, s.payload.tid, translated, s.payload.uid, now, now]);

  _trSetJobStatus(ss, s.payload.tid, jobId, 'IN_REVIEW');
  _appendJobEvent(ss, jobId, s.payload.uid, 'translation_submitted', 'IN_TRANSLATION', 'IN_REVIEW',
    JSON.stringify({ document_id: docId, hash: hash.slice(0, 16), chars: translated.length }));
  _logAudit('translation.submit_review', s.payload.tid, s.payload.uid,
    'job=' + jobId + ' doc=' + docId + ' hash=' + hash.slice(0, 16));
  return _json({ ok:true, job_id: jobId, document_id: docId, status: 'IN_REVIEW' });
}

// ============================================================================
// APPROVE — IN_REVIEW → APPROVED. PDF deliverable generated lazily on download.
// ============================================================================

function apiApproveTranslation(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  if (!jobId) return _json({ ok:false, error:'job_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _trFindJob(ss, s.payload.tid, jobId);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);
  if (String(job.status) !== 'IN_REVIEW') {
    return _json({ ok:false, error:'Cannot approve from status ' + job.status });
  }

  _trSetJobStatus(ss, s.payload.tid, jobId, 'APPROVED');
  _appendJobEvent(ss, jobId, s.payload.uid, 'status_change', 'IN_REVIEW', 'APPROVED', '{}');
  _logAudit('translation.approve', s.payload.tid, s.payload.uid, 'job=' + jobId);
  return _json({ ok:true, job_id: jobId, status: 'APPROVED' });
}

// ============================================================================
// REJECT — IN_REVIEW → IN_TRANSLATION (with reviewer notes)
// ============================================================================

function apiRejectTranslation(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  var notes = String(e.parameter.notes || '');
  if (!jobId) return _json({ ok:false, error:'job_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _trFindJob(ss, s.payload.tid, jobId);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);
  if (String(job.status) !== 'IN_REVIEW') {
    return _json({ ok:false, error:'Cannot reject from status ' + job.status });
  }

  _trSetJobStatus(ss, s.payload.tid, jobId, 'IN_TRANSLATION');
  _appendJobEvent(ss, jobId, s.payload.uid, 'translation_rejected', 'IN_REVIEW', 'IN_TRANSLATION',
    JSON.stringify({ reviewer_notes: notes.slice(0, 400) }));
  // Audit holds a short reviewer-notes preview so the chain stays readable;
  // never logs translated_text or source_text.
  _logAudit('translation.reject', s.payload.tid, s.payload.uid,
    'job=' + jobId + ' notes_len=' + notes.length);
  return _json({ ok:true, job_id: jobId, status: 'IN_TRANSLATION' });
}

// ============================================================================
// CANCEL — any pre-DELIVERED status → CANCELLED_BY_AGENCY
// ============================================================================

function apiCancelTranslation(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  var reason = String(e.parameter.reason || '');
  if (!jobId) return _json({ ok:false, error:'job_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _trFindJob(ss, s.payload.tid, jobId);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);
  if (String(job.status) === 'DELIVERED' || String(job.status) === 'CANCELLED_BY_AGENCY') {
    return _json({ ok:false, error:'Already final: ' + job.status });
  }

  _trSetJobStatus(ss, s.payload.tid, jobId, 'CANCELLED_BY_AGENCY');
  _appendJobEvent(ss, jobId, s.payload.uid, 'status_change', job.status, 'CANCELLED_BY_AGENCY',
    JSON.stringify({ reason: reason }));
  _logAudit('translation.cancel', s.payload.tid, s.payload.uid, 'job=' + jobId + ' reason=' + reason.slice(0, 200));
  return _json({ ok:true, job_id: jobId, status: 'CANCELLED_BY_AGENCY' });
}

// ============================================================================
// DOWNLOAD — render APPROVED translation as a side-by-side PDF
// (status flips APPROVED → DELIVERED on first download)
// ============================================================================

function apiDownloadTranslation(e) {
  var s = _requireSession(e);
  if (!s.ok) return _serveText('Forbidden', 401);
  var jobId = e.parameter.id || e.parameter.job_id;
  if (!jobId) return _serveText('id required', 400);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _trFindJob(ss, s.payload.tid, jobId);
  if (!job) return _serveText('Job not found', 404);
  if (String(job.status) !== 'APPROVED' && String(job.status) !== 'DELIVERED') {
    return _serveText('Translation not yet approved (status=' + job.status + ')', 409);
  }

  var agency = _findAgency(ss, s.payload.tid);
  var sourceDoc = _trLatestDoc(ss, s.payload.tid, jobId, 'translation-source');
  var targetDoc = _trLatestDoc(ss, s.payload.tid, jobId, 'translation-target');
  if (!sourceDoc || !targetDoc) return _serveText('Source or target document missing', 404);
  var sourceText = _trFindFullText(ss, T_TR_SOURCES, jobId, sourceDoc.document_id);
  var targetText = _trFindFullText(ss, T_TR_TARGETS, jobId, targetDoc.document_id);
  var translatorName = _trTranslatorDisplayName(ss, s.payload.tid, targetDoc.linked_interpreter_id || targetDoc.uploaded_by_user_id);

  var rateApplied = {};
  try { rateApplied = JSON.parse(job.rate_applied || '{}'); } catch (_) {}
  var serviceSubtype = String(rateApplied.service_subtype || job.service_type || 'translation');
  var sworn = (serviceSubtype === 'legal' || serviceSubtype === 'gov');

  var html = _renderTranslationHtml(agency, job, sourceText, targetText, translatorName, serviceSubtype, sworn);
  var pdfBlob = Utilities.newBlob(html, 'text/html', 'translation-' + jobId + '.html').getAs('application/pdf');
  pdfBlob.setName(jobId + '.pdf');

  // First download flips APPROVED → DELIVERED.
  if (String(job.status) === 'APPROVED') {
    _trSetJobStatus(ss, s.payload.tid, jobId, 'DELIVERED');
    _appendJobEvent(ss, jobId, s.payload.uid, 'status_change', 'APPROVED', 'DELIVERED', '{}');
  }
  _logAudit('translation.download', s.payload.tid, s.payload.uid, 'job=' + jobId);

  var b64 = Utilities.base64Encode(pdfBlob.getBytes());
  var dataUrl = 'data:application/pdf;base64,' + b64;
  var wrapper =
    '<!doctype html><html><head><meta charset="utf-8"><title>Translation ' + jobId + '.pdf</title>' +
    '<style>html,body{margin:0;padding:0;height:100%;font-family:system-ui}embed{width:100%;height:100%;border:0}</style>' +
    '</head><body><embed src="' + dataUrl + '" type="application/pdf"></body></html>';
  return HtmlService.createHtmlOutput(wrapper)
    .setTitle(jobId + '.pdf')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ============================================================================
// PDF RENDER — side-by-side, sworn-translation footer when applicable.
// ============================================================================

function _renderTranslationHtml(agency, job, sourceText, targetText, translatorName, serviceSubtype, sworn) {
  // Reuse the invoice/payout CSS palette so the brand is consistent.
  var styles = _pdfCss((agency && agency.brand_color) || '#C8553D')
    + '.tr-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:20px 0}'
    + '.tr-grid h3{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#5C6670;margin:0 0 6px}'
    + '.tr-text{white-space:pre-wrap;font-size:12.5px;background:#FAFAF7;padding:14px;border-radius:6px;border:1px solid #E4E0D6;line-height:1.55;font-family:Georgia,serif}'
    + '.sworn{margin-top:32px;padding:16px 20px;border:1px solid #0F1419;border-radius:6px;font-size:12px;line-height:1.6}';
  var srcLabel = String(job.source_language_id || 'source');
  var tgtLabel = String(job.target_language_id || 'target');
  var dateStr = _fmtDate(new Date().toISOString());
  var swornBlock = sworn
    ? ('<div class="sworn"><strong>Sworn translation attestation.</strong><br>'
       + 'Translated by ' + _esc(translatorName || 'translator-of-record') + ', on ' + _esc(dateStr) + '. '
       + 'Translator certifies this is a complete and accurate translation to the best of their ability. '
       + 'Service category: ' + _esc(serviceSubtype) + '. Job reference: ' + _esc(job.job_id) + '.</div>')
    : '';
  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>' + styles + '</style></head><body>',
    '<header>',
    '  <div><div class="lockup">' + _esc((agency && agency.legal_name) || '1891 Interpreter') + '<small>powered by 1891 Interpreter</small></div></div>',
    '  <div class="doc-meta">',
    '    <h1>Translation</h1>',
    '    <div class="id">' + _esc(job.job_id) + '</div>',
    '    <div style="margin-top:8px"><strong>Pair:</strong> ' + _esc(srcLabel) + ' &rarr; ' + _esc(tgtLabel) + '</div>',
    '    <div><strong>Category:</strong> ' + _esc(serviceSubtype) + '</div>',
    '    <div><strong>Status:</strong> ' + _esc(job.status || '') + '</div>',
    '  </div>',
    '</header>',
    '<div class="tr-grid">',
    '  <div><h3>Source &mdash; ' + _esc(srcLabel) + '</h3><div class="tr-text">' + _esc(sourceText) + '</div></div>',
    '  <div><h3>Translation &mdash; ' + _esc(tgtLabel) + '</h3><div class="tr-text">' + _esc(targetText) + '</div></div>',
    '</div>',
    swornBlock,
    '<footer>',
    '  <div>Generated ' + _esc(dateStr) + ' &middot; Translator: ' + _esc(translatorName || '—') + '</div>',
    '  <div class="tag">' + _esc(job.job_id) + ' &middot; tenant: ' + _esc(job.tenant_id) + '</div>',
    '</footer>',
    '</body></html>'
  ].join('\n');
}

// ============================================================================
// FILE-LOCAL HELPERS
// ============================================================================

function _trFindJob(ss, tenantId, jobId) {
  var sh = ss.getSheetByName(T.Jobs);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (String(o.tenant_id) === String(tenantId) && String(o.job_id) === String(jobId)) {
      o.__rowIndex = i;  // for in-place updates
      o.__hdr = hdr;
      return o;
    }
  }
  return null;
}

function _trJobsByIdIdx(ss, tenantId) {
  var idx = {};
  var sh = ss.getSheetByName(T.Jobs);
  if (!sh) return idx;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return idx;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (String(o.tenant_id) === String(tenantId)) idx[o.job_id] = o;
  }
  return idx;
}

function _trSetJobStatus(ss, tenantId, jobId, newStatus) {
  var sh = ss.getSheetByName(T.Jobs);
  if (!sh) return false;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return false;
  var hdr = data[0];
  var iJob = hdr.indexOf('job_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iStatus = hdr.indexOf('status');
  var iUpdated = hdr.indexOf('_updated_at');
  var iRev = hdr.indexOf('_rev');
  if (iJob < 0 || iStatus < 0) return false;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iJob]) === String(jobId) && String(data[r][iTenant]) === String(tenantId)) {
      sh.getRange(r + 1, iStatus + 1).setValue(newStatus);
      if (iUpdated >= 0) sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
      if (iRev >= 0) sh.getRange(r + 1, iRev + 1).setValue(Number(data[r][iRev] || 0) + 1);
      return true;
    }
  }
  return false;
}

function _trFindDocument(ss, tenantId, docId) {
  var sh = ss.getSheetByName(T.Documents);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (String(o.tenant_id) === String(tenantId) && String(o.document_id) === String(docId)) return o;
  }
  return null;
}

function _trLatestDoc(ss, tenantId, jobId, kind) {
  var sh = ss.getSheetByName(T.Documents);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var picked = null;
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (String(o.tenant_id) !== String(tenantId)) continue;
    if (String(o.linked_job_id) !== String(jobId)) continue;
    if (String(o.kind) !== kind) continue;
    if (!picked || String(o._created_at || '') > String(picked._created_at || '')) picked = o;
  }
  return picked;
}

function _trFindFullText(ss, tabName, jobId, docId) {
  var sh = ss.getSheetByName(tabName);
  if (!sh) return '';
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return '';
  var hdr = data[0];
  var iJob = hdr.indexOf('job_id');
  var iDoc = hdr.indexOf('document_id');
  var iText = hdr.indexOf('full_text');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iJob]) === String(jobId) && String(data[i][iDoc]) === String(docId)) {
      return String(data[i][iText] || '');
    }
  }
  return '';
}

function _trTranslatorDisplayName(ss, tenantId, userIdOrInterpreterId) {
  if (!userIdOrInterpreterId) return '';
  // Try Interpreters first (translator-of-record), then Users.
  var sh = ss.getSheetByName(T.Interpreters);
  if (sh) {
    var data = sh.getDataRange().getValues();
    if (data.length >= 2) {
      var hdr = data[0];
      for (var i = 1; i < data.length; i++) {
        var o = _rowToObj(hdr, data[i]);
        if (String(o.tenant_id) !== String(tenantId)) continue;
        if (String(o.interpreter_id) === String(userIdOrInterpreterId)
          || String(o.user_id) === String(userIdOrInterpreterId)) {
          return ((o.legal_first || '') + ' ' + (o.legal_last || '')).trim() || o.interpreter_id;
        }
      }
    }
  }
  var us = ss.getSheetByName(T.Users);
  if (us) {
    var d2 = us.getDataRange().getValues();
    if (d2.length >= 2) {
      var h2 = d2[0];
      for (var j = 1; j < d2.length; j++) {
        var u = _rowToObj(h2, d2[j]);
        if (String(u.tenant_id) === String(tenantId) && String(u.user_id) === String(userIdOrInterpreterId)) {
          return u.display_name || u.email || u.user_id;
        }
      }
    }
  }
  return String(userIdOrInterpreterId);
}
