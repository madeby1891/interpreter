/**
 * 1891 Interpreter — interpreter document tracking + tenant requirements +
 * qualification gating.
 *
 * Three things this file owns:
 *   1. Interpreter_Documents — per-interpreter doc storage (HIPAA cert,
 *      vaccinations, background check, COI, W-9, RID membership, etc.).
 *      Status: pending → submitted → approved | rejected | expired.
 *   2. Tenant_Requirements — per-tenant policy: which doc_types are required
 *      for which service_types/modalities, with renewal periods.
 *   3. Qualification checker — given a job + an interpreter, returns a list
 *      of missing/expired/expiring docs and the qualification verdict.
 *
 * Canonical doc_type catalog (each tenant can subset):
 *   hipaa_training              — annual
 *   bbp_training                — bloodborne pathogens, biennial
 *   tb_test                     — annual
 *   covid_vaccination           — primary series + boosters per agency
 *   mmr_immunization            — once
 *   flu_vaccination             — annual
 *   hep_b_immunization          — once
 *   background_check            — every 2-3 years per agency
 *   tb_drug_test                — pre-employment
 *   w9_form                     — once, refresh on TIN change
 *   certificate_of_insurance    — annual
 *   ada_training                — agency-specific
 *   confidentiality_agreement   — once
 *   conflict_of_interest        — annual
 *   rid_membership              — annual; not a "doc" but tracked here
 *   nad_membership              — annual
 *   state_cert                  — varies by state (MD, VA, etc.)
 *   medical_terminology         — once
 *   mental_health_endorsement   — agency-specific
 *   legal_endorsement           — court-eligible (often SC:L)
 *   k12_endorsement             — EIPA 3.5+, school district background check
 */

// ============================================================================
// PUBLIC ENDPOINTS
// ============================================================================

function apiListInterpreterDocs(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.InterpreterDocuments, _tenantSchema().Interpreter_Documents);
  var sh = ss.getSheetByName(T.InterpreterDocuments);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var out = [];
  if (data.length >= 2) {
    var interpFilter = e.parameter.interpreter_id || null;
    for (var i = 1; i < data.length; i++) {
      var o = _rowToObj(hdr, data[i]);
      if (o.tenant_id !== s.payload.tid) continue;
      if (interpFilter && o.interpreter_id !== interpFilter) continue;
      // Compute live status (expired if past expires_at)
      if (o.expires_at && new Date(o.expires_at) < new Date() && o.status === 'approved') {
        o.status = 'expired';
        o._auto_expired = true;
      }
      out.push(o);
    }
  }
  return _json({ ok:true, docs: out });
}

function apiUpsertInterpreterDoc(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  if (!p.interpreter_id || !p.doc_type) return _json({ ok:false, error:'interpreter_id + doc_type required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.InterpreterDocuments, _tenantSchema().Interpreter_Documents);
  var sh = ss.getSheetByName(T.InterpreterDocuments);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var nowIso = new Date().toISOString();
  var isStaff = (s.payload.role === 'role_owner' || s.payload.role === 'role_admin' || s.payload.role === 'role_scheduler');

  // Permission: staff can edit any; interpreter can edit their own docs.
  // Self-check: look up interpreter row to find user_id.
  if (!isStaff) {
    var interp = _findInterpreterById(ss, p.interpreter_id);
    if (!interp || interp.user_id !== s.payload.uid) {
      return _json({ ok:false, error:'Not authorized' }, 403);
    }
  }

  // Update by doc_id if provided, else upsert by (interpreter_id, doc_type)
  if (p.doc_id) {
    var iId = hdr.indexOf('doc_id'), iTenant = hdr.indexOf('tenant_id');
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][iId]) === p.doc_id && String(data[r][iTenant]) === s.payload.tid) {
        var fields = ['doc_name','status','issued_at','expires_at','file_r2_key','sha256','notes','required'];
        // Reviewers (staff) can set status to approved/rejected and stamp reviewer
        if (isStaff && (p.status === 'approved' || p.status === 'rejected')) {
          sh.getRange(r + 1, hdr.indexOf('reviewer_user_id') + 1).setValue(s.payload.uid);
          sh.getRange(r + 1, hdr.indexOf('reviewed_at') + 1).setValue(nowIso);
        }
        fields.forEach(function (f) {
          if (p[f] === undefined || p[f] === null) return;
          var c = hdr.indexOf(f);
          if (c < 0) return;
          sh.getRange(r + 1, c + 1).setValue(p[f]);
        });
        sh.getRange(r + 1, hdr.indexOf('_updated_at') + 1).setValue(nowIso);
        _logAudit('interpreter_doc.update', s.payload.tid, s.payload.uid, p.doc_id + ' ' + (p.status || ''));
        return _json({ ok:true, doc_id: p.doc_id });
      }
    }
    return _json({ ok:false, error:'Doc not found' }, 404);
  }

  // Insert / upsert by (interpreter_id, doc_type)
  var iInterp = hdr.indexOf('interpreter_id'), iDocType = hdr.indexOf('doc_type'), iTenant2 = hdr.indexOf('tenant_id');
  for (var rr = 1; rr < data.length; rr++) {
    if (String(data[rr][iInterp]) === p.interpreter_id &&
        String(data[rr][iDocType]) === p.doc_type &&
        String(data[rr][iTenant2]) === s.payload.tid) {
      // Update existing
      var existingId = String(data[rr][hdr.indexOf('doc_id')]);
      var fields2 = ['doc_name','status','issued_at','expires_at','file_r2_key','sha256','notes'];
      fields2.forEach(function (f) {
        if (p[f] === undefined || p[f] === null) return;
        var c = hdr.indexOf(f);
        if (c < 0) return;
        sh.getRange(rr + 1, c + 1).setValue(p[f]);
      });
      sh.getRange(rr + 1, hdr.indexOf('_updated_at') + 1).setValue(nowIso);
      _logAudit('interpreter_doc.upsert', s.payload.tid, s.payload.uid, existingId);
      return _json({ ok:true, doc_id: existingId });
    }
  }
  var id = _ulid('id');
  var row = {
    doc_id: id, tenant_id: s.payload.tid,
    interpreter_id: p.interpreter_id, doc_type: p.doc_type,
    doc_name: p.doc_name || _docDisplayName(p.doc_type),
    status: p.status || 'pending',
    required: p.required !== 'false',
    issued_at: p.issued_at || '',
    expires_at: p.expires_at || '',
    reviewer_user_id: '', reviewed_at: '',
    file_r2_key: p.file_r2_key || '',
    sha256: p.sha256 || '',
    notes: p.notes || '',
    _created_at: nowIso, _updated_at: nowIso
  };
  sh.appendRow(_tenantSchema().Interpreter_Documents.map(function (col) { return row[col] !== undefined ? row[col] : ''; }));
  _logAudit('interpreter_doc.create', s.payload.tid, s.payload.uid, id);
  return _json({ ok:true, doc_id: id });
}

function apiListRequirements(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.TenantRequirements, _tenantSchema().Tenant_Requirements);
  var sh = ss.getSheetByName(T.TenantRequirements);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, requirements:[] });
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id === s.payload.tid) out.push(o);
  }
  return _json({ ok:true, requirements: out });
}

function apiUpsertRequirement(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var p = e.parameter || {};
  if (!p.doc_type) return _json({ ok:false, error:'doc_type required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.TenantRequirements, _tenantSchema().Tenant_Requirements);
  var sh = ss.getSheetByName(T.TenantRequirements);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var nowIso = new Date().toISOString();

  if (p.req_id) {
    var iId = hdr.indexOf('req_id'), iTenant = hdr.indexOf('tenant_id');
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][iId]) === p.req_id && String(data[r][iTenant]) === s.payload.tid) {
        var fields = ['applies_to_service_type','applies_to_modality','doc_type','display_name','required','reminder_days','renewal_period_months','notes'];
        fields.forEach(function (f) {
          if (p[f] === undefined || p[f] === null) return;
          var c = hdr.indexOf(f);
          if (c < 0) return;
          sh.getRange(r + 1, c + 1).setValue(p[f]);
        });
        sh.getRange(r + 1, hdr.indexOf('_updated_at') + 1).setValue(nowIso);
        _logAudit('requirement.update', s.payload.tid, s.payload.uid, p.req_id);
        return _json({ ok:true, req_id: p.req_id });
      }
    }
    return _json({ ok:false, error:'Not found' }, 404);
  }
  var id = _ulid('rq');
  var row = {
    req_id: id, tenant_id: s.payload.tid,
    applies_to_service_type: p.applies_to_service_type || '*',
    applies_to_modality: p.applies_to_modality || '*',
    doc_type: p.doc_type,
    display_name: p.display_name || _docDisplayName(p.doc_type),
    required: p.required !== 'false',
    reminder_days: Number(p.reminder_days || 30),
    renewal_period_months: Number(p.renewal_period_months || 12),
    notes: p.notes || '',
    _created_at: nowIso, _updated_at: nowIso
  };
  sh.appendRow(_tenantSchema().Tenant_Requirements.map(function (col) { return row[col] !== undefined ? row[col] : ''; }));
  _logAudit('requirement.create', s.payload.tid, s.payload.uid, id);
  return _json({ ok:true, req_id: id, requirement: row });
}

function apiDeleteRequirement(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.TenantRequirements);
  if (!sh) return _json({ ok:false, error:'No requirements' }, 404);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('req_id');
  for (var r = data.length - 1; r >= 1; r--) {
    if (String(data[r][iId]) === e.parameter.req_id) {
      sh.deleteRow(r + 1);
      _logAudit('requirement.delete', s.payload.tid, s.payload.uid, e.parameter.req_id);
      return _json({ ok:true });
    }
  }
  return _json({ ok:false, error:'Not found' }, 404);
}

// ============================================================================
// QUALIFICATION CHECK
// ============================================================================
//
// Given a job + an interpreter, returns:
//   {
//     qualified: bool,
//     qualified_strict: bool (no missing required + no expired required + cert ok),
//     missing_docs: [...],
//     expired_docs: [...],
//     expiring_soon: [...],
//     warnings: [...]
//   }

function apiQualificationCheck(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  if (!p.interpreter_id) return _json({ ok:false, error:'interpreter_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var interp = _findInterpreterById(ss, p.interpreter_id);
  if (!interp || interp.tenant_id !== s.payload.tid) return _json({ ok:false, error:'Interpreter not found' }, 404);
  var jobLike = p.job_id ? _findJob(ss, s.payload.tid, p.job_id) : {
    service_type: p.service_type || 'medical',
    modality: p.modality || 'on-site',
    team_config: p.team_config || 'solo',
    target_language_id: p.target_language_id,
    source_language_id: p.source_language_id
  };
  if (!jobLike) return _json({ ok:false, error:'Job not found' }, 404);
  var result = qualificationCheck_(ss, s.payload.tid, interp, jobLike);
  return _json({ ok:true, qualification: result });
}

function qualificationCheck_(ss, tenantId, interp, job) {
  var svc = job.service_type || 'medical';
  var mod = job.modality || 'on-site';
  // 1. Resolve required docs for this svc + mod
  var reqs = listRequirementsFor_(ss, tenantId, svc, mod);
  // 2. Get all interpreter docs
  var docs = listInterpreterDocsFor_(ss, tenantId, interp.interpreter_id);
  var docByType = {};
  docs.forEach(function (d) {
    // If multiple per type, pick the one with latest issued_at
    if (!docByType[d.doc_type] || (d.issued_at && d.issued_at > docByType[d.doc_type].issued_at)) {
      docByType[d.doc_type] = d;
    }
  });

  var missing = [], expired = [], expiringSoon = [], warnings = [];
  var nowMs = Date.now();
  var soonThresholdMs = 30 * 86400000;

  reqs.forEach(function (req) {
    if (req.required === false || req.required === 'false') return;
    var d = docByType[req.doc_type];
    if (!d) { missing.push({ doc_type: req.doc_type, display_name: req.display_name }); return; }
    if (d.status === 'rejected') { missing.push({ doc_type: req.doc_type, display_name: req.display_name, reason:'rejected' }); return; }
    if (d.status === 'pending') { missing.push({ doc_type: req.doc_type, display_name: req.display_name, reason:'pending review' }); return; }
    if (d.expires_at) {
      var expMs = new Date(d.expires_at).getTime();
      if (expMs < nowMs) {
        expired.push({ doc_type: req.doc_type, display_name: req.display_name, expires_at: d.expires_at });
      } else if (expMs - nowMs < soonThresholdMs) {
        expiringSoon.push({ doc_type: req.doc_type, display_name: req.display_name, expires_at: d.expires_at, days: Math.round((expMs - nowMs) / 86400000) });
      }
    }
  });

  // 3. Language match
  var iLangs = [];
  try { iLangs = JSON.parse(interp.languages || '[]'); } catch (_) {}
  var targetLang = job.target_language_id;
  var sourceLang = job.source_language_id;
  var hasLang = !targetLang || iLangs.some(function (l) {
    return l.lang === targetLang || l.lang === sourceLang;
  });
  if (!hasLang) warnings.push({ kind: 'language_mismatch', target: targetLang, source: sourceLang });

  // 4. CDI requirement for team config
  if (job.team_config === 'cdi+hearing' || job.team_config === 'voicer+signer') {
    // Interpreter is either CDI (deaf) or voicer (hearing)
    // For matching: warn if assigning a hearing interpreter to "cdi" role or vice versa
    var isCdi = interp.deaf === true || interp.deaf === 'true' || interp.deaf === 'TRUE';
    // Without role hint, just note
    warnings.push({ kind: 'team_role_check', deaf: isCdi, team_config: job.team_config });
  }

  // 5. Specialty endorsements
  var endorsements = [];
  try { endorsements = JSON.parse(interp.specialty_endorsements || '[]'); } catch (_) {}
  var needSpecialty = null;
  if (svc === 'mental-health') needSpecialty = 'mental-health';
  if (svc === 'legal') needSpecialty = 'legal';
  if (svc === 'education') needSpecialty = 'k12';
  if (needSpecialty && endorsements.indexOf(needSpecialty) < 0) {
    warnings.push({ kind: 'missing_endorsement', endorsement: needSpecialty });
  }

  // Bottom line
  var qualifiedStrict = (missing.length === 0) && (expired.length === 0) && hasLang;
  var qualified = qualifiedStrict; // can relax later (e.g., allow expiring-soon)

  return {
    qualified: qualified,
    qualified_strict: qualifiedStrict,
    interpreter_id: interp.interpreter_id,
    display_name: (interp.legal_first || '') + ' ' + (interp.legal_last || ''),
    requirements_evaluated: reqs.length,
    missing_docs: missing,
    expired_docs: expired,
    expiring_soon: expiringSoon,
    has_language: hasLang,
    warnings: warnings
  };
}

function listRequirementsFor_(ss, tenantId, svc, mod) {
  var sh = ss.getSheetByName(T.TenantRequirements);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id !== tenantId) continue;
    if (o.applies_to_service_type && o.applies_to_service_type !== '*' && o.applies_to_service_type !== svc) continue;
    if (o.applies_to_modality && o.applies_to_modality !== '*' && o.applies_to_modality !== mod) continue;
    out.push(o);
  }
  return out;
}

function listInterpreterDocsFor_(ss, tenantId, interpreterId) {
  var sh = ss.getSheetByName(T.InterpreterDocuments);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id === tenantId && o.interpreter_id === interpreterId) out.push(o);
  }
  return out;
}

function _docDisplayName(docType) {
  var names = {
    hipaa_training: 'HIPAA training certificate',
    bbp_training: 'Bloodborne pathogens training',
    tb_test: 'TB test (current)',
    covid_vaccination: 'COVID-19 vaccination record',
    mmr_immunization: 'MMR immunization record',
    flu_vaccination: 'Flu vaccination (current season)',
    hep_b_immunization: 'Hepatitis B immunization',
    background_check: 'Background check (current)',
    drug_test: 'Pre-employment drug test',
    w9_form: 'W-9 form',
    certificate_of_insurance: 'Certificate of insurance (COI)',
    ada_training: 'ADA training certificate',
    confidentiality_agreement: 'Confidentiality / NDA agreement',
    conflict_of_interest: 'Conflict-of-interest disclosure',
    rid_membership: 'RID membership (current)',
    nad_membership: 'NAD membership (current)',
    state_cert: 'State interpreter certification',
    medical_terminology: 'Medical terminology training',
    mental_health_endorsement: 'Mental-health interpreter endorsement',
    legal_endorsement: 'Legal / court interpreter endorsement',
    k12_endorsement: 'K-12 educational endorsement'
  };
  return names[docType] || docType.replace(/_/g, ' ');
}

// ============================================================================
// SMART-FILL UPGRADE — qualification-gated
// ============================================================================

function apiSmartFillQualified(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  if (!jobId) return _json({ ok:false, error:'job_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _findJob(ss, s.payload.tid, jobId);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);

  // Pre-load all reference data ONCE — otherwise we'd scan each tab 10 times
  // (once per interpreter), blowing the 15s JSONP budget.
  var cache = {
    interpreters: _listInterpreters(ss, s.payload.tid),
    rateCards: _allRowsFor_(ss, T.RateCards, s.payload.tid),
    rateModifiers: _allRowsFor_(ss, T.RateModifiers, s.payload.tid),
    requirements: _allRowsFor_(ss, T.TenantRequirements, s.payload.tid),
    docs: _allRowsFor_(ss, T.InterpreterDocuments, s.payload.tid)
  };
  var docsByInterp = {};
  cache.docs.forEach(function (d) {
    (docsByInterp[d.interpreter_id] = docsByInterp[d.interpreter_id] || []).push(d);
  });
  var settings = {};
  (function () {
    var sh = ss.getSheetByName(T.Settings);
    if (sh && sh.getLastRow() >= 2) {
      var data = sh.getDataRange().getValues();
      var hdr = data[0];
      var iKey = hdr.indexOf('key'), iValue = hdr.indexOf('value');
      for (var i = 1; i < data.length; i++) settings[String(data[i][iKey])] = data[i][iValue];
    }
  })();

  var enriched = cache.interpreters.map(function (i) {
    var score = _scoreInterpreter(i, job);
    var qual = qualificationCheckFast_(s.payload.tid, i, job, cache.requirements, docsByInterp[i.interpreter_id] || []);
    var quote = computeRateQuoteFast_(s.payload.tid, job, i, cache.rateCards, cache.rateModifiers, settings);
    return {
      interpreter_id: i.interpreter_id,
      display_name: (i.legal_first || '') + ' ' + (i.legal_last || ''),
      deaf: i.deaf === true || i.deaf === 'true',
      languages: i.languages,
      modalities: i.modalities,
      score: score.score,
      qualification: qual,
      pay_quote_cents: quote.pay ? quote.pay.total_cents : 0,
      pay_hourly_cents: quote.pay ? quote.pay.base_hourly_cents : 0,
      bill_quote_cents: quote.bill ? quote.bill.total_cents : 0,
      pay_floor_enforced: quote.pay && quote.pay.floor_enforced || false
    };
  });

  enriched.sort(function (a, b) {
    if (a.qualification.qualified_strict !== b.qualification.qualified_strict) {
      return a.qualification.qualified_strict ? -1 : 1;
    }
    return b.score.total - a.score.total;
  });

  return _json({ ok:true, job_id:jobId, candidates: enriched.slice(0, 12) });
}

function _allRowsFor_(ss, tabName, tenantId) {
  var sh = ss.getSheetByName(tabName);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iTenant = hdr.indexOf('tenant_id');
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (iTenant >= 0 && String(data[i][iTenant]) !== tenantId) continue;
    out.push(_rowToObj(hdr, data[i]));
  }
  return out;
}

function qualificationCheckFast_(tenantId, interp, job, allReqs, interpDocs) {
  // Same as qualificationCheck_ but takes pre-loaded reference data
  var svc = job.service_type || 'medical';
  var mod = job.modality || 'on-site';
  var reqs = allReqs.filter(function (r) {
    if (r.applies_to_service_type && r.applies_to_service_type !== '*' && r.applies_to_service_type !== svc) return false;
    if (r.applies_to_modality && r.applies_to_modality !== '*' && r.applies_to_modality !== mod) return false;
    return true;
  });
  var docByType = {};
  interpDocs.forEach(function (d) {
    if (!docByType[d.doc_type] || (d.issued_at && d.issued_at > docByType[d.doc_type].issued_at)) {
      docByType[d.doc_type] = d;
    }
  });
  var missing = [], expired = [], expiringSoon = [], warnings = [];
  var nowMs = Date.now();
  var soonMs = 30 * 86400000;
  reqs.forEach(function (req) {
    if (req.required === false || req.required === 'false' || req.required === 'FALSE') return;
    var d = docByType[req.doc_type];
    if (!d) { missing.push({ doc_type: req.doc_type, display_name: req.display_name }); return; }
    if (d.status === 'rejected') { missing.push({ doc_type: req.doc_type, display_name: req.display_name, reason:'rejected' }); return; }
    if (d.status === 'pending') { missing.push({ doc_type: req.doc_type, display_name: req.display_name, reason:'pending review' }); return; }
    if (d.expires_at) {
      var expMs = new Date(d.expires_at).getTime();
      if (expMs < nowMs) {
        expired.push({ doc_type: req.doc_type, display_name: req.display_name, expires_at: d.expires_at });
      } else if (expMs - nowMs < soonMs) {
        expiringSoon.push({ doc_type: req.doc_type, display_name: req.display_name, expires_at: d.expires_at, days: Math.round((expMs - nowMs) / 86400000) });
      }
    }
  });
  var iLangs = [];
  try { iLangs = JSON.parse(interp.languages || '[]'); } catch (_) {}
  var targetLang = job.target_language_id;
  var hasLang = !targetLang || iLangs.some(function (l) {
    return l.lang === job.target_language_id || l.lang === job.source_language_id;
  });
  if (!hasLang) warnings.push({ kind:'language_mismatch', target: targetLang });

  var qualifiedStrict = (missing.length === 0) && (expired.length === 0) && hasLang;
  return {
    qualified: qualifiedStrict,
    qualified_strict: qualifiedStrict,
    interpreter_id: interp.interpreter_id,
    display_name: (interp.legal_first || '') + ' ' + (interp.legal_last || ''),
    requirements_evaluated: reqs.length,
    missing_docs: missing,
    expired_docs: expired,
    expiring_soon: expiringSoon,
    has_language: hasLang,
    warnings: warnings
  };
}

function computeRateQuoteFast_(tenantId, job, interp, allRateCards, allRateModifiers, settings) {
  // Inline rate quote that takes pre-loaded reference data
  var meta = computeQuoteMetaInline_(job);
  var bill = computeOneSideFast_(job, meta, 'bill', null, allRateCards, allRateModifiers, settings, tenantId);
  var pay = computeOneSideFast_(job, meta, 'pay', interp, allRateCards, allRateModifiers, settings, tenantId);
  return { bill: bill, pay: pay, meta: meta };
}

function computeQuoteMetaInline_(job) {
  var start = job.scheduled_start ? new Date(job.scheduled_start) : new Date();
  var end = job.scheduled_end ? new Date(job.scheduled_end) : new Date(start.getTime() + 60 * 60 * 1000);
  var spanMin = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  var tz = 'America/New_York';
  var startHour = parseInt(Utilities.formatDate(start, tz, 'H'), 10);
  var endHour = parseInt(Utilities.formatDate(end, tz, 'H'), 10);
  var dow = parseInt(Utilities.formatDate(start, tz, 'u'), 10);
  var dateStr = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
  var isEvening = (startHour >= 18 && startHour < 22) || (endHour > 18 && endHour <= 22) || (startHour < 6);
  var isOvernight = (startHour >= 22) || (startHour < 6 && startHour >= 0 && !isEvening);
  // overnight only applies to truly late-night/early-morning, not 7pm-9pm
  if (startHour >= 6 && startHour < 22) isOvernight = false;
  var isWeekend = (dow >= 6);
  var isHoliday = isUsFederalHoliday_(dateStr);
  var createdAt = job._created_at ? new Date(job._created_at) : new Date();
  var leadHours = (start.getTime() - createdAt.getTime()) / 3600000;
  return {
    service_type: job.service_type || 'medical',
    modality: job.modality || 'on-site',
    team_config: job.team_config || 'solo',
    span_minutes: spanMin,
    start_hour: startHour, end_hour: endHour, dow: dow,
    is_evening: isEvening, is_overnight: isOvernight, is_weekend: isWeekend, is_holiday: isHoliday,
    is_last_minute: leadHours >= 0 && leadHours < 24,
    is_rush: leadHours >= 0 && leadHours < 4,
    lead_hours: Math.round(leadHours * 10) / 10
  };
}

function computeOneSideFast_(job, meta, side, interp, allCards, allMods, settings, tenantId) {
  // Resolve base rate from pre-loaded cards
  var svc = meta.service_type, mod = meta.modality, team = meta.team_config;
  var candidates = allCards.filter(function (rc) {
    if (rc.side !== side) return false;
    if (rc.service_type !== svc && rc.service_type !== '*') return false;
    if (rc.modality !== mod && rc.modality !== '*') return false;
    if (rc.team_config !== team && rc.team_config !== '*') return false;
    return true;
  }).map(function (rc) {
    var spec = (rc.service_type === svc ? 4 : 0) + (rc.modality === mod ? 2 : 0) + (rc.team_config === team ? 1 : 0);
    return { rc: rc, spec: spec };
  }).sort(function (a, b) { return b.spec - a.spec; });
  var base;
  if (candidates.length) {
    var p = candidates[0].rc;
    base = { base_hourly_cents: Number(p.base_hourly_cents || 0), minimum_hours: Number(p.minimum_hours || 2), rounding_minutes: Number(p.rounding_minutes || 15), source: 'rate_card:' + p.rate_card_id };
  } else {
    var sKey = 'rate_card.' + svc + '.' + mod + '.' + team + '.hourly_cents';
    var v = settings[sKey] || settings['rate_card.' + svc + '.on-site.solo.hourly_cents'];
    base = { base_hourly_cents: v ? Number(v) : (svc === 'legal' ? 12500 : (svc === 'education' ? 8500 : 9500)), minimum_hours: 2, rounding_minutes: 15, source: 'fallback' };
  }
  var roundedMin = Math.ceil(meta.span_minutes / base.rounding_minutes) * base.rounding_minutes;
  var minMin = base.minimum_hours * 60;
  var minApplied = roundedMin < minMin;
  var billableMin = Math.max(roundedMin, minMin);
  var hours = billableMin / 60;
  // Apply modifiers
  var mods = allMods.filter(function (m) {
    if (m.side !== side) return false;
    if (m.status === 'archived') return false;
    if (m.applies_to_service_type && m.applies_to_service_type !== '*' && m.applies_to_service_type !== svc) return false;
    if (m.applies_to_modality && m.applies_to_modality !== '*' && m.applies_to_modality !== mod) return false;
    var trigger = {};
    try { trigger = JSON.parse(m.trigger || '{}'); } catch (_) {}
    return modifierMatches_(m.kind, trigger, meta);
  });
  mods.sort(function (a, b) { return Number(a.priority || 100) - Number(b.priority || 100); });
  var pctSum = 0, centsSum = 0, log = [];
  mods.forEach(function (m) {
    var pct = Number(m.modifier_pct || 0);
    var cents = Number(m.modifier_cents || 0);
    pctSum += pct; centsSum += cents;
    log.push({ modifier_id: m.modifier_id, name: m.name, kind: m.kind, pct: pct, cents: cents, priority: m.priority });
  });
  var subtotal = Math.round(base.base_hourly_cents * hours);
  var premiumPct = Math.round(subtotal * (pctSum / 100));
  var total = subtotal + premiumPct + centsSum;
  var out = {
    base_hourly_cents: base.base_hourly_cents, hours: Math.round(hours * 100) / 100,
    minimum_hours: base.minimum_hours, minimum_hours_applied: minApplied,
    rounding_minutes: base.rounding_minutes, billable_minutes: billableMin,
    modifiers: log, modifier_pct_total: pctSum, modifier_cents_total: centsSum,
    subtotal_cents: subtotal, premium_cents: premiumPct + centsSum, total_cents: total,
    source: base.source
  };
  if (side === 'pay' && interp) {
    var floors = {};
    try { floors = JSON.parse(interp.pay_rate_floors || '{}'); } catch (_) {}
    var floorHourly = (floors[svc] && floors[svc][mod]) || (floors[svc] && floors[svc]['*']) ||
                      (floors['*'] && floors['*'][mod]) || (floors['*'] && floors['*']['*']) || 0;
    if (floorHourly > 0) {
      var floorTotal = Math.round(floorHourly * hours);
      out.floor_cents = floorTotal;
      out.floor_hourly_cents = floorHourly;
      if (floorTotal > out.total_cents) {
        out.floor_enforced = true;
        out.total_cents = floorTotal;
      }
    }
  }
  return out;
}
