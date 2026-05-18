// ============================================================================
// Code_PHI.gs — Column-level PHI encryption + Consumer CRUD
// v18.4 — May 2026
//
// Apps Script V8 doesn't have AES, so we proxy encrypt/decrypt through the
// Worker which uses Web Crypto AES-GCM with per-tenant HKDF-derived keys.
// The Worker's PHI_MASTER_KEY never leaves Cloudflare.
//
// What's encrypted: Consumers.legal_first_encrypted, legal_last_encrypted,
//                   dob_encrypted, mrn_encrypted, notes_sealed
// What's plaintext: display_initials, primary_language_id, dialect,
//                   communication_prefs, do_not_contact, consent_recording_default
//
// Reads:
//   - apiListConsumers / apiGetConsumer return *masked* by default (initials
//     only). If the caller has consumer.read.unmasked + a purpose_of_use,
//     the encrypted columns are decrypted on-the-fly and returned in a
//     `revealed` block. Every reveal is audit-logged.
//
// Writes:
//   - apiCreateConsumer / apiUpdateConsumer accept PHI in cleartext, encrypt
//     before writing. Caller must have consumer.write.
// ============================================================================

var PHI_WORKER_BASE = 'https://1891-interpreter-api.anthonymowl.workers.dev';
var PHI_REVEAL_ROLE_ALLOWLIST = ['role_owner','role_admin','role_manager','role_scheduler','role_interpreter','role_platform_staff'];

// ---------------------------------------------------------------------------
// Low-level: encrypt / decrypt a single string via the Worker
// ---------------------------------------------------------------------------
function _phiEncrypt(tenantId, plaintext) {
  if (plaintext == null || plaintext === '') return '';
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('HMAC_SECRET') || props.getProperty('JWT_SECRET');
  if (!secret) throw new Error('PHI encryption requires HMAC_SECRET to be set on the Apps Script project.');
  var res = UrlFetchApp.fetch(PHI_WORKER_BASE + '/v1/phi/encrypt', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'X-1891-Internal': secret },
    payload: JSON.stringify({ tenant_id: tenantId, plaintext: String(plaintext) })
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('PHI encrypt failed: HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  }
  var body = JSON.parse(res.getContentText());
  if (!body.ok) throw new Error('PHI encrypt failed: ' + (body.error || 'unknown'));
  return body.blob;
}

function _phiDecrypt(tenantId, blob) {
  if (blob == null || blob === '') return '';
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('HMAC_SECRET') || props.getProperty('JWT_SECRET');
  if (!secret) throw new Error('PHI decryption requires HMAC_SECRET to be set.');
  var res = UrlFetchApp.fetch(PHI_WORKER_BASE + '/v1/phi/decrypt', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'X-1891-Internal': secret },
    payload: JSON.stringify({ tenant_id: tenantId, blob: String(blob) })
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('PHI decrypt failed: HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  }
  var body = JSON.parse(res.getContentText());
  if (!body.ok) throw new Error('PHI decrypt failed: ' + (body.error || 'unknown'));
  return body.plaintext;
}

// ---------------------------------------------------------------------------
// apiCreateConsumer — accepts PHI in cleartext; encrypts before write
// ---------------------------------------------------------------------------
// Required: display_initials, primary_language_id
// Optional PHI (encrypted on write): legal_first, legal_last, dob (YYYY-MM-DD), mrn, notes_sealed
// Optional plaintext: dialect, communication_prefs, do_not_contact, consent_recording_default
function apiCreateConsumer(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (['role_owner','role_admin','role_manager','role_scheduler','role_platform_staff'].indexOf(s.payload.role) < 0) {
    return _json({ ok:false, error:'Scheduler / manager / owner role required' }, 403);
  }
  var p = _phiParams_(e);
  if (!p.display_initials) return _json({ ok:false, error:'display_initials required (e.g. J.M.)' });
  if (!p.primary_language_id) return _json({ ok:false, error:'primary_language_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Consumers, _tenantSchema().Consumers);
  var sheet = ss.getSheetByName(T.Consumers);
  var hdr = _tenantSchema().Consumers;
  var consumerId = _ulid('c');
  var now = new Date().toISOString();

  // Encrypt PHI fields
  var legalFirstEnc = p.legal_first ? _phiEncrypt(s.payload.tid, p.legal_first) : '';
  var legalLastEnc  = p.legal_last  ? _phiEncrypt(s.payload.tid, p.legal_last)  : '';
  var dobEnc        = p.dob         ? _phiEncrypt(s.payload.tid, p.dob)         : '';
  var mrnEnc        = p.mrn         ? _phiEncrypt(s.payload.tid, p.mrn)         : '';
  var notesEnc      = p.notes_sealed ? _phiEncrypt(s.payload.tid, p.notes_sealed) : '';

  var row = {
    consumer_id: consumerId,
    tenant_id: s.payload.tid,
    display_initials: String(p.display_initials).slice(0, 12),
    legal_first_encrypted: legalFirstEnc,
    legal_last_encrypted: legalLastEnc,
    dob_encrypted: dobEnc,
    mrn_encrypted: mrnEnc,
    primary_language_id: p.primary_language_id,
    dialect: p.dialect || '',
    communication_prefs: p.communication_prefs || '',
    notes_sealed: notesEnc,
    do_not_contact: p.do_not_contact === 'true' || p.do_not_contact === true,
    consent_recording_default: p.consent_recording_default === 'true' || p.consent_recording_default === true,
    created_by_user_id: s.payload.uid || '',
    deletion_requested_at: '',
    _created_at: now,
    _updated_at: now
  };
  sheet.appendRow(hdr.map(function (h) { return row[h] !== undefined ? row[h] : ''; }));

  var encCount = [legalFirstEnc, legalLastEnc, dobEnc, mrnEnc, notesEnc].filter(Boolean).length;
  _logAudit('consumer.create', s.payload.tid, s.payload.uid, consumerId + ' enc_fields=' + encCount);
  return _json({ ok:true, consumer_id: consumerId, encrypted_fields: encCount });
}

// ---------------------------------------------------------------------------
// apiUpdateConsumer — supply only the fields to change; cleartext PHI is
// encrypted before write. To clear an encrypted field, send the empty string.
// ---------------------------------------------------------------------------
function apiUpdateConsumer(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (['role_owner','role_admin','role_manager','role_scheduler','role_platform_staff'].indexOf(s.payload.role) < 0) {
    return _json({ ok:false, error:'Scheduler / manager / owner role required' }, 403);
  }
  var p = _phiParams_(e);
  if (!p.consumer_id) return _json({ ok:false, error:'consumer_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Consumers, _tenantSchema().Consumers);
  var sheet = ss.getSheetByName(T.Consumers);
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:false, error:'Consumer not found' }, 404);
  var hdr = data[0];

  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.consumer_id !== p.consumer_id) continue;
    if (o.tenant_id !== s.payload.tid) return _json({ ok:false, error:'Forbidden' }, 403);

    // Plaintext fields
    ['display_initials','primary_language_id','dialect','communication_prefs'].forEach(function (k) {
      if (p[k] !== undefined) o[k] = p[k];
    });
    // Boolean fields
    ['do_not_contact','consent_recording_default'].forEach(function (k) {
      if (p[k] !== undefined) o[k] = (p[k] === 'true' || p[k] === true);
    });
    // PHI fields — encrypt the cleartext input
    var encMap = { legal_first:'legal_first_encrypted', legal_last:'legal_last_encrypted', dob:'dob_encrypted', mrn:'mrn_encrypted' };
    Object.keys(encMap).forEach(function (k) {
      if (p[k] !== undefined) o[encMap[k]] = p[k] === '' ? '' : _phiEncrypt(s.payload.tid, p[k]);
    });
    if (p.notes_sealed !== undefined) {
      o.notes_sealed = p.notes_sealed === '' ? '' : _phiEncrypt(s.payload.tid, p.notes_sealed);
    }
    o._updated_at = new Date().toISOString();

    var newRow = hdr.map(function (h) { return o[h] !== undefined ? o[h] : ''; });
    sheet.getRange(i + 1, 1, 1, hdr.length).setValues([newRow]);
    _logAudit('consumer.update', s.payload.tid, s.payload.uid, o.consumer_id);
    return _json({ ok:true, consumer_id: o.consumer_id });
  }
  return _json({ ok:false, error:'Consumer not found' }, 404);
}

// ---------------------------------------------------------------------------
// apiRevealConsumer — break-glass full-PHI read. Heavy audit, role-gated,
// requires purpose_of_use (treatment / billing / quality_review / legal_hold).
// ---------------------------------------------------------------------------
function apiRevealConsumer(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (PHI_REVEAL_ROLE_ALLOWLIST.indexOf(s.payload.role) < 0) {
    return _json({ ok:false, error:'Role not authorized to reveal PHI' }, 403);
  }
  var p = _phiParams_(e);
  if (!p.consumer_id) return _json({ ok:false, error:'consumer_id required' });
  var purpose = String(p.purpose_of_use || '').trim();
  if (!purpose) return _json({ ok:false, error:'purpose_of_use required (treatment/billing/quality_review/legal_hold)' });
  if (['treatment','billing','quality_review','legal_hold'].indexOf(purpose) < 0) {
    return _json({ ok:false, error:'purpose_of_use must be one of treatment/billing/quality_review/legal_hold' });
  }

  // Interpreter-role callers must only see consumers tied to a job they're assigned to.
  // This narrows the break-glass surface — a curious interpreter can't enumerate the consumer table.
  if (s.payload.role === 'role_interpreter') {
    var permitted = _phiInterpreterMayReadConsumer_(p.consumer_id, s);
    if (!permitted) return _json({ ok:false, error:'Interpreter must be assigned to a job involving this consumer' }, 403);
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(T.Consumers);
  if (!sheet) return _json({ ok:false, error:'Consumer tab missing' }, 404);
  var data = sheet.getDataRange().getValues();
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.consumer_id !== p.consumer_id) continue;
    if (o.tenant_id !== s.payload.tid) return _json({ ok:false, error:'Forbidden' }, 403);

    var revealed = {
      legal_first:  o.legal_first_encrypted  ? _phiDecrypt(s.payload.tid, o.legal_first_encrypted)  : '',
      legal_last:   o.legal_last_encrypted   ? _phiDecrypt(s.payload.tid, o.legal_last_encrypted)   : '',
      dob:          o.dob_encrypted          ? _phiDecrypt(s.payload.tid, o.dob_encrypted)          : '',
      mrn:          o.mrn_encrypted          ? _phiDecrypt(s.payload.tid, o.mrn_encrypted)          : '',
      notes_sealed: o.notes_sealed           ? _phiDecrypt(s.payload.tid, o.notes_sealed)           : ''
    };

    _logAudit('consumer.read.unmasked', s.payload.tid, s.payload.uid,
      o.consumer_id + ' purpose=' + purpose + ' role=' + s.payload.role);

    return _json({
      ok: true,
      consumer_id: o.consumer_id,
      display_initials: o.display_initials,
      primary_language_id: o.primary_language_id,
      dialect: o.dialect,
      communication_prefs: o.communication_prefs,
      do_not_contact: o.do_not_contact,
      consent_recording_default: o.consent_recording_default,
      revealed: revealed,
      purpose_of_use: purpose,
      revealed_at: new Date().toISOString()
    });
  }
  return _json({ ok:false, error:'Consumer not found' }, 404);
}

// ---------------------------------------------------------------------------
// apiListConsumers — masked view only. Never decrypts.
// ---------------------------------------------------------------------------
function apiListConsumers(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Consumers, _tenantSchema().Consumers);
  var sheet = ss.getSheetByName(T.Consumers);
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, consumers: [] });
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id !== s.payload.tid) continue;
    out.push({
      consumer_id: o.consumer_id,
      display_initials: o.display_initials,
      primary_language_id: o.primary_language_id,
      dialect: o.dialect,
      communication_prefs: o.communication_prefs,
      do_not_contact: o.do_not_contact === true || o.do_not_contact === 'true',
      consent_recording_default: o.consent_recording_default === true || o.consent_recording_default === 'true',
      has_encrypted_legal_name: !!(o.legal_first_encrypted || o.legal_last_encrypted),
      has_encrypted_dob: !!o.dob_encrypted,
      has_encrypted_mrn: !!o.mrn_encrypted,
      _created_at: o._created_at,
      _updated_at: o._updated_at
    });
  }
  return _json({ ok:true, consumers: out });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _phiInterpreterMayReadConsumer_(consumerId, s) {
  // Returns true if this interpreter has an active assignment on a job that
  // references this consumer.
  var ss = SpreadsheetApp.openById(SHEET_ID);
  // Find interpreter_id for this user
  var usersSh = ss.getSheetByName(T.Users);
  if (!usersSh) return false;
  var uData = usersSh.getDataRange().getValues();
  var uHdr = uData[0];
  var iUid = uHdr.indexOf('user_id'), iInt = uHdr.indexOf('interpreter_id');
  var interpId = null;
  for (var i = 1; i < uData.length; i++) {
    if (String(uData[i][iUid]) === String(s.payload.uid)) { interpId = String(uData[i][iInt] || ''); break; }
  }
  if (!interpId) return false;
  // Find jobs that reference this consumer
  var jobsSh = ss.getSheetByName(T.Jobs);
  if (!jobsSh) return false;
  var jData = jobsSh.getDataRange().getValues();
  var jHdr = jData[0];
  var jobIds = {};
  for (var j = 1; j < jData.length; j++) {
    var jr = _rowToObj(jHdr, jData[j]);
    if (jr.consumer_id === consumerId && jr.tenant_id === s.payload.tid) jobIds[jr.job_id] = true;
  }
  if (!Object.keys(jobIds).length) return false;
  // Check assignments
  var asnSh = ss.getSheetByName(T.JobAssignments);
  if (!asnSh) return false;
  var aData = asnSh.getDataRange().getValues();
  var aHdr = aData[0];
  for (var k = 1; k < aData.length; k++) {
    var ar = _rowToObj(aHdr, aData[k]);
    if (ar.interpreter_id === interpId && jobIds[ar.job_id] && ar.response === 'claim') return true;
  }
  return false;
}

function _phiParams_(e) {
  if (e && e.postData && e.postData.type === 'application/json') {
    try { return JSON.parse(e.postData.contents); } catch (_) {}
  }
  return (e && e.parameter) || {};
}
