/**
 * 1891 Interpreter — backend (Apps Script).
 *
 * One script, three responsibilities:
 *   1. Inbound forms from the marketing site (existing).
 *   2. Magic-link auth: issue + verify, session JWT.
 *   3. Tenant operations: bootstrap schema, jobs CRUD, smart-fill.
 *
 * Deployed as a Web app to:
 *   https://script.google.com/macros/s/AKfycbw.../exec
 *
 * URL routing:
 *   GET  ?action=service        → service info JSON (default)
 *   GET  ?action=list_jobs      → list jobs for the authed tenant
 *   GET  ?action=get_job&id=... → single job
 *   POST form_id=...            → inbound marketing form
 *   POST action=auth_request    → email a magic link
 *   POST action=auth_verify     → exchange token for session JWT
 *   POST action=create_job      → create a draft Job
 *   POST action=claim_job       → interpreter claims an offered job
 *   POST action=smart_fill      → return ranked interpreter candidates
 *   POST action=bootstrap       → one-shot tenant Sheet schema bootstrap
 *
 * Re-deploy after edits: Deploy → Manage deployments → ✏️ → New version → Deploy
 * (the four manual clicks per workspace CLAUDE.md).
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

var SHEET_ID = '1RKY0n-dStOoyLtayppvQ0prGVFXMiR0aHg0C_u7eigE'; // "1891 Interpreter" (host tenant)
var SITE_BASE = 'https://madeby1891.com/interpreter';

var NOTIFY_EMAIL         = 'hello@madeby1891.com';
var ACCESSIBILITY_NOTIFY = 'accessibility@madeby1891.com';
var SECURITY_NOTIFY      = 'security@madeby1891.com';

// Sheet tabs (canonical names per PRD A3)
var T = {
  Agencies: 'Agencies',
  Users: 'Users',
  Roles: 'Roles',
  Interpreters: 'Interpreters',
  Languages: 'Languages',
  Certifications: 'Certifications',
  Requestors: 'Requestors',
  RequestorContacts: 'Requestor_Contacts',
  Payers: 'Payers',
  Consumers: 'Consumers',
  Locations: 'Locations',
  Jobs: 'Jobs',
  JobAssignments: 'Job_Assignments',
  JobEvents: 'Job_Events',
  Communications: 'Communications',
  Invoices: 'Invoices',
  InvoiceLines: 'Invoice_Lines',
  Payouts: 'Payouts',
  Documents: 'Documents',
  Settings: 'Settings',
  Audit_Log: 'Audit_Log',
  // 1891-specific tabs (not in A3 but needed)
  Inbound: 'Inbound',
  DeafOwnedApplications: 'Deaf_Owned_Applications',
  AuthTokens: 'Auth_Tokens'  // magic-link issuance log
};

var AUTH_TOKEN_TTL_MS = 15 * 60 * 1000;        // magic link valid for 15 min
var SESSION_TTL_MS    = 14 * 24 * 60 * 60 * 1000; // session JWT valid 14 days

// ============================================================================
// ROUTING — doGet / doPost
// ============================================================================

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    _setCallback(_safeCb(params.callback));
    var action = params.action || 'service';
    // Read-only ops served via GET so JSONP works.
    switch (action) {
      case 'service':            return _serviceInfo();
      case 'list_jobs':          return apiListJobs(e);
      case 'get_job':            return apiGetJob(e);
      case 'whoami':             return apiWhoami(e);
      case 'auth_verify':        return apiAuthVerify(e);   // JSONP-friendly
      case 'smart_fill':         return apiSmartFill(e);
      case 'list_interpreters':  return apiListInterpreters(e);
      case 'list_requestors':    return apiListRequestors(e);
      case 'list_settings':      return apiListSettings(e);
      default:                   return _json({ ok:false, error:'Unknown action: ' + action }, 404);
    }
  } catch (err) {
    return _json({ ok:false, error:String(err) }, 500);
  } finally {
    _setCallback(null);
  }
}

function doPost(e) {
  try {
    var params = (e && e.parameter) || {};
    _setCallback(_safeCb(params.callback));
    if (params.form_id) return handleInboundForm(e);

    var action = params.action || '';
    switch (action) {
      case 'auth_request':       return apiAuthRequest(e);
      case 'auth_verify':        return apiAuthVerify(e);
      case 'create_job':         return apiCreateJob(e);
      case 'claim_job':          return apiClaimJob(e);
      case 'cancel_job':         return apiCancelJob(e);
      case 'smart_fill':         return apiSmartFill(e);
      case 'bootstrap':          return apiBootstrap(e);
      case 'create_interpreter': return apiCreateInterpreter(e);
      case 'update_interpreter': return apiUpdateInterpreter(e);
      case 'create_requestor':   return apiCreateRequestor(e);
      case 'update_agency':      return apiUpdateAgency(e);
      case 'update_setting':     return apiUpdateSetting(e);
      default:                   return _json({ ok:false, error:'Unknown action: ' + action }, 404);
    }
  } catch (err) {
    _logAudit('system_error', '', '', String(err));
    return _json({ ok:false, error:String(err) }, 500);
  } finally {
    _setCallback(null);
  }
}

function _safeCb(name) {
  // Only allow safe JS identifiers; prevents XSS via callback param.
  if (!name) return null;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(String(name))) return null;
  return String(name);
}

function _serviceInfo() {
  return _json({
    ok: true,
    service: '1891 Interpreter — Backend',
    version: '2026-05-17-v2',
    routes: {
      get: ['service','list_jobs','get_job','whoami'],
      post: ['<form_id>','auth_request','auth_verify','create_job','claim_job','cancel_job','smart_fill','bootstrap']
    }
  });
}

// ============================================================================
// INBOUND MARKETING FORMS (existing behavior, preserved)
// ============================================================================

function handleInboundForm(e) {
  var params = e.parameter || {};
  var formId = String(params.form_id || 'unknown');
  var timestamp = new Date();
  var iso = timestamp.toISOString();

  var phiCheck = _scanForLikelyPHI(params);
  if (phiCheck.blocked) {
    _logAudit('inbound_form_rejected_phi', formId, '', phiCheck.reason);
    return _json({ ok:false, error:'Submission rejected by PII filter. Please remove medical or personal-identifier detail and retry.' });
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);

  if (formId === 'deaf_owned_application') {
    _appendDeafOwnedApplication(ss, iso, params);
  }

  _appendInbound(ss, iso, formId, params);
  _notifyOwner(formId, params);
  _logAudit('inbound_form_submit', formId, '', '');
  return _json({ ok:true, received:iso });
}

function _appendInbound(ss, iso, formId, params) {
  var headers = [
    'timestamp','form_id','name','email','organization','agency_size',
    'modality','current_platform','helps','topic','message',
    'language','when','setting','notes',
    'agency_legal_name','state_of_formation','owner_name','documentation_type',
    'page','raw_params'
  ];
  var sheet = _getOrCreateSheet(ss, T.Inbound, headers);
  var name = params.name || params.full_name || params.requestor_name || params.owner_name || '';
  var email = params.email || params.work_email || params.contact_email || '';
  var modality = '';
  if (params.modality) {
    modality = Array.isArray(params.modality) ? params.modality.join(',') : String(params.modality);
  }
  sheet.appendRow([
    iso, formId, name, email,
    params.organization || params.agency_name || '',
    params.agency_size || '',
    modality,
    params.current_platform || '',
    params.helps || '',
    params.topic || '',
    params.message || '',
    params.language || '',
    params.when || '',
    params.setting || '',
    params.notes || '',
    params.agency_legal_name || '',
    params.state_of_formation || '',
    params.owner_name || '',
    params.documentation_type || '',
    params.page || '',
    JSON.stringify(params)
  ]);
}

function _appendDeafOwnedApplication(ss, iso, params) {
  var headers = [
    'submitted_at','agency_legal_name','state_of_formation','owner_name',
    'contact_email','documentation_type','notes','review_status',
    'reviewed_at','reviewer','decision_notes'
  ];
  var sheet = _getOrCreateSheet(ss, T.DeafOwnedApplications, headers);
  sheet.appendRow([
    iso,
    params.agency_legal_name || '',
    params.state_of_formation || '',
    params.owner_name || '',
    params.contact_email || '',
    params.documentation_type || '',
    params.notes || '',
    'pending','','',''
  ]);
}

function _scanForLikelyPHI(params) {
  var blob = '';
  for (var k in params) {
    if (Object.prototype.hasOwnProperty.call(params, k)) blob += ' ' + String(params[k]);
  }
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(blob)) return { blocked:true, reason:'SSN-shape detected' };
  var formId = String(params.form_id || '');
  if (formId === 'requestor_sample') {
    var red = /\b(diagnosis|MRN|medical record number|chart number|patient name|DOB|SSN|HIV|cancer|psychiatric|chemotherapy)\b/i;
    if (red.test(blob)) return { blocked:true, reason:'Clinical detail in requestor form notes' };
  }
  return { blocked:false };
}

function _notifyOwner(formId, params) {
  var to = NOTIFY_EMAIL;
  if (formId === 'a11y' || formId === 'accessibility_feedback') to = ACCESSIBILITY_NOTIFY;
  if (formId === 'security_disclosure') to = SECURITY_NOTIFY;

  var subject = '[1891 Interpreter] ' + formId + ' — new inbound';
  var lines = [];
  var keys = Object.keys(params).sort();
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (k === 'raw_params') continue;
    lines.push(k + ': ' + params[k]);
  }
  var body = 'New inbound form submission on madeby1891.com/interpreter\n\n' +
             lines.join('\n') +
             '\n\n— 1891 Interpreter inbound forms backend';
  try { MailApp.sendEmail({ to: to, subject: subject, body: body }); }
  catch (err) { _logAudit('inbound_form_notify_failed', formId, '', String(err)); }
}

// ============================================================================
// AUTH — magic link
// ============================================================================
//
// Flow:
//   1. Site posts { action: 'auth_request', email: '<email>' }
//   2. We generate a token, store hash in Auth_Tokens, email the link.
//   3. User clicks link → site loads /app/callback.html?token=...
//   4. Page posts { action: 'auth_verify', token: '<token>' }
//   5. We verify, mint a session JWT (HS256), return it.
//   6. Site stores session in localStorage; passes as `session` on every call.
//
// Session JWT format (compact, not RFC):
//   payload = base64url(JSON({uid,tid,role,exp}))
//   signature = base64url(HMAC-SHA256(secret, payload))
//   token = payload + '.' + signature

function apiAuthRequest(e) {
  var email = String((e.parameter.email || '')).trim().toLowerCase();
  if (!_isValidEmail(email)) return _json({ ok:false, error:'Valid email required.' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  // Resolve user → tenant. For v1 we accept any email that already has a Users row,
  // and fall back to provisioning the host tenant for anthony's master Gmail.
  var user = _lookupUserByEmail(ss, email);
  if (!user) {
    // Soft bootstrap: anthony's master Gmail auto-becomes the host owner.
    if (email === 'anthonymowl@gmail.com') {
      user = _ensureHostOwner(ss);
    } else {
      // For unknown emails we still issue a link — the auth_verify step will fail
      // gracefully. Avoids leaking "is this address registered" to anonymous probes.
      user = { user_id:'unknown', tenant_id:'unknown', email:email, role_id:'unknown' };
    }
  }

  var token = _newToken();
  var hash = _sha256Hex(token);
  var now = new Date();
  var expIso = new Date(now.getTime() + AUTH_TOKEN_TTL_MS).toISOString();
  var sheet = _getOrCreateSheet(ss, T.AuthTokens,
    ['issued_at','email','token_hash','user_id','tenant_id','expires_at','consumed_at','ip','user_agent']);
  sheet.appendRow([now.toISOString(), email, hash, user.user_id, user.tenant_id, expIso, '', '', '']);

  var link = SITE_BASE + '/app/callback.html?token=' + encodeURIComponent(token);
  var body =
    'Welcome back to 1891 Interpreter.\n\n' +
    'Click this one-time link within the next 15 minutes to sign in:\n\n' +
    link + '\n\n' +
    "If you didn't request this, you can ignore this email — the link won't work without being clicked.\n\n" +
    '— 1891 Interpreter';
  try {
    MailApp.sendEmail({ to: email, subject: 'Your 1891 Interpreter sign-in link', body: body });
  } catch (err) {
    _logAudit('auth_email_failed', '', user.user_id, String(err));
    return _json({ ok:false, error:'We couldn’t send the email right now. Please try again in a minute.' });
  }
  _logAudit('auth_link_issued', '', user.user_id, '');
  return _json({ ok:true, message:'Check your inbox for a sign-in link.' });
}

function apiAuthVerify(e) {
  var token = String(e.parameter.token || '');
  if (!token) return _json({ ok:false, error:'Token required.' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(T.AuthTokens);
  if (!sheet) return _json({ ok:false, error:'No tokens issued yet.' });

  var hash = _sha256Hex(token);
  var data = sheet.getDataRange().getValues();
  // headers in row 0
  var hdr = data[0]; var idxHash = hdr.indexOf('token_hash');
  var idxExpires = hdr.indexOf('expires_at');
  var idxConsumed = hdr.indexOf('consumed_at');
  var idxUser = hdr.indexOf('user_id');
  var idxTenant = hdr.indexOf('tenant_id');
  var idxEmail = hdr.indexOf('email');
  var found = -1;
  for (var i = data.length - 1; i >= 1; i--) {  // search latest first
    if (String(data[i][idxHash]) === hash) { found = i; break; }
  }
  if (found < 0) return _json({ ok:false, error:'Invalid token.' });
  var row = data[found];
  if (row[idxConsumed]) return _json({ ok:false, error:'This sign-in link has already been used.' });
  if (new Date(row[idxExpires]).getTime() < Date.now()) return _json({ ok:false, error:'This sign-in link has expired. Request a new one.' });

  var userId = String(row[idxUser]);
  var tenantId = String(row[idxTenant]);
  if (userId === 'unknown' || tenantId === 'unknown') {
    // Token was issued for an email we don't recognize. Treat as failure.
    sheet.getRange(found + 1, idxConsumed + 1).setValue(new Date().toISOString());
    return _json({ ok:false, error:'Sign-in link invalid for this account.' });
  }

  // Re-verify user still exists & is active
  var user = _lookupUserById(ss, userId);
  if (!user || user.status !== 'active') return _json({ ok:false, error:'Account not active.' });

  sheet.getRange(found + 1, idxConsumed + 1).setValue(new Date().toISOString());

  var session = _mintSession({ uid:userId, tid:tenantId, role:user.role_id, email:user.email });
  _logAudit('auth_login', tenantId, userId, '');
  return _json({ ok:true, session:session, user:{ user_id:userId, tenant_id:tenantId, email:user.email, display_name:user.display_name, role_id:user.role_id } });
}

function apiWhoami(e) {
  var session = _requireSession(e);
  if (!session.ok) return _json({ ok:false, error:session.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var user = _lookupUserById(ss, session.payload.uid);
  if (!user) return _json({ ok:false, error:'User no longer exists.' }, 401);
  return _json({ ok:true, user:user, session_exp:new Date(session.payload.exp).toISOString() });
}

function _mintSession(payloadObj) {
  var now = Date.now();
  payloadObj.iat = now;
  payloadObj.exp = now + SESSION_TTL_MS;
  var payload = _b64urlEncode(Utilities.newBlob(JSON.stringify(payloadObj)).getBytes());
  var sig = _hmacB64Url(payload);
  return payload + '.' + sig;
}

function _verifySession(token) {
  if (!token || token.indexOf('.') < 0) return { ok:false, error:'Malformed token.' };
  var parts = token.split('.');
  if (parts.length !== 2) return { ok:false, error:'Malformed token.' };
  var expected = _hmacB64Url(parts[0]);
  if (expected !== parts[1]) return { ok:false, error:'Bad signature.' };
  try {
    var payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
    if (!payload.exp || payload.exp < Date.now()) return { ok:false, error:'Session expired.' };
    return { ok:true, payload:payload };
  } catch (err) {
    return { ok:false, error:'Bad payload.' };
  }
}

function _requireSession(e) {
  var token = (e.parameter && e.parameter.session) || '';
  return _verifySession(token);
}

function _hmacB64Url(text) {
  var key = _hmacSecret();
  var raw = Utilities.computeHmacSha256Signature(text, key);
  return _b64urlEncode(raw);
}

function _hmacSecret() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('HMAC_SECRET');
  if (!s) {
    s = Utilities.getUuid() + '.' + Utilities.getUuid();
    props.setProperty('HMAC_SECRET', s);
  }
  return s;
}

function _b64urlEncode(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function _newToken() {
  // 256-bit token, hex-encoded
  var u1 = Utilities.getUuid().replace(/-/g, '');
  var u2 = Utilities.getUuid().replace(/-/g, '');
  return u1 + u2;
}

function _sha256Hex(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text);
  return bytes.map(function (b) {
    return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
  }).join('');
}

function _isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ============================================================================
// USERS
// ============================================================================

function _lookupUserByEmail(ss, email) {
  var sh = ss.getSheetByName(T.Users);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iEmail = hdr.indexOf('email');
  if (iEmail < 0) return null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iEmail]).toLowerCase() === email) {
      return _rowToObj(hdr, data[i]);
    }
  }
  return null;
}

function _lookupUserById(ss, userId) {
  var sh = ss.getSheetByName(T.Users);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iId = hdr.indexOf('user_id');
  if (iId < 0) return null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iId]) === userId) return _rowToObj(hdr, data[i]);
  }
  return null;
}

function _ensureHostOwner(ss) {
  // Make sure the host agency exists and anthonymowl@gmail.com is its owner.
  var schema = _tenantSchema();
  _ensureTab(ss, T.Agencies, schema.Agencies);
  _ensureTab(ss, T.Users, schema.Users);
  _ensureTab(ss, T.Roles, schema.Roles);

  var agencies = ss.getSheetByName(T.Agencies);
  if (agencies.getLastRow() < 2) {
    agencies.appendRow([
      'host',                          // tenant_id
      '1891 Interpreter (host)',       // legal_name
      '',                              // tax_id_last4
      'deaf-owned-free',               // tier
      'initials-only',                 // phi_mode
      'America/New_York',              // timezone
      '',                              // primary_owner_user_id (set after user row)
      '',                              // logo_r2_key
      '#C8553D',                       // brand_color
      'hello@madeby1891.com',          // billing_email
      new Date().toISOString(),        // _created_at
      new Date().toISOString()         // _updated_at
    ]);
  }

  // Seed system roles if missing
  _seedRoles(ss);

  var owner = _lookupUserByEmail(ss, 'anthonymowl@gmail.com');
  if (owner) return owner;

  var userId = _ulid('u');
  ss.getSheetByName(T.Users).appendRow([
    userId,
    'host',                                // tenant_id
    'anthonymowl@gmail.com',
    '',                                    // phone
    'Anthony Mowl',
    'role_owner',
    '',                                    // interpreter_id
    'active',
    false,                                 // mfa_enabled
    '[]',                                  // webauthn
    '',                                    // last_login_at
    JSON.stringify({ consumer:'masked' }), // pii_scope
    0, '',                                 // failed_login, sso
    new Date().toISOString(),
    new Date().toISOString()
  ]);

  // Update agency owner pointer
  var aData = agencies.getDataRange().getValues();
  var aHdr = aData[0]; var iOwner = aHdr.indexOf('primary_owner_user_id');
  for (var r = 1; r < aData.length; r++) {
    if (String(aData[r][aHdr.indexOf('tenant_id')]) === 'host') {
      agencies.getRange(r + 1, iOwner + 1).setValue(userId);
      break;
    }
  }

  return _lookupUserByEmail(ss, 'anthonymowl@gmail.com');
}

function _seedRoles(ss) {
  var sheet = ss.getSheetByName(T.Roles);
  if (!sheet) return;
  if (sheet.getLastRow() >= 2) return;
  var roles = [
    ['role_owner',            '*', 'Owner',            JSON.stringify(['*']), true,  'full'],
    ['role_admin',            '*', 'Admin',            JSON.stringify(['agency.*','job.*','interpreter.*','requestor.*','consumer.read.masked','payer.*','invoice.*','payout.*','document.*','user.*','setting.*']), false, 'masked'],
    ['role_scheduler',        '*', 'Scheduler',        JSON.stringify(['job.read','job.write','job.assign','interpreter.read','requestor.read','requestor.write','consumer.read.masked','communication.send']), false, 'masked'],
    ['role_interpreter',      '*', 'Interpreter',      JSON.stringify(['job.read.assigned','job.claim','job.decline','availability.write','self.profile','consumer.read.masked.on_assigned_job']), false, 'masked'],
    ['role_requestor_contact','*', 'Requestor contact',JSON.stringify(['job.read.own','job.create','requestor.read.own']), false, 'none'],
    ['role_payer_contact',    '*', 'Payer contact',    JSON.stringify(['invoice.read.own','invoice.pay']), false, 'none'],
    ['role_consumer_self',    '*', 'Consumer (self-service)', JSON.stringify(['self.profile','self.history']), false, 'none'],
    ['role_auditor',          '*', 'Auditor',          JSON.stringify(['audit.read','consumer.read.masked','job.read']), false, 'masked']
  ];
  var ts = new Date().toISOString();
  roles.forEach(function (r) {
    sheet.appendRow([r[0], r[1], r[2], r[3], r[4], r[5], ts, ts]);
  });
}

// ============================================================================
// JOBS — CRUD + state machine
// ============================================================================

function apiListJobs(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Jobs, _tenantSchema().Jobs);

  var sheet = ss.getSheetByName(T.Jobs);
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, jobs:[] });
  var hdr = data[0];
  var jobs = [];
  for (var i = 1; i < data.length; i++) {
    var obj = _rowToObj(hdr, data[i]);
    if (obj.tenant_id !== s.payload.tid) continue;
    jobs.push(obj);
  }
  // optional filter by status
  var status = e.parameter.status;
  if (status) jobs = jobs.filter(function (j) { return j.status === status; });
  // sort by scheduled_start asc
  jobs.sort(function (a, b) { return String(a.scheduled_start).localeCompare(String(b.scheduled_start)); });
  return _json({ ok:true, jobs:jobs });
}

function apiGetJob(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.id;
  if (!jobId) return _json({ ok:false, error:'id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _findJob(ss, s.payload.tid, jobId);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);
  return _json({ ok:true, job:job });
}

function apiCreateJob(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);

  var p = e.parameter || {};
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Jobs, _tenantSchema().Jobs);
  _ensureTab(ss, T.JobEvents, _tenantSchema().Job_Events);

  var jobId = _ulid('j');
  var now = new Date().toISOString();
  var row = {
    job_id: jobId,
    tenant_id: s.payload.tid,
    requestor_id: p.requestor_id || '',
    requestor_contact_id: p.requestor_contact_id || '',
    payer_id: p.payer_id || '',
    location_id: p.location_id || '',
    consumer_id: '',  // initials-only mode never sets consumer_id
    modality: p.modality || 'on-site',
    service_type: p.service_type || 'medical',
    source_language_id: p.source_language_id || 'en-US',
    target_language_id: p.target_language_id || 'ASL',
    team_config: p.team_config || 'solo',
    scheduled_start: p.scheduled_start || '',
    scheduled_end: p.scheduled_end || '',
    actual_start: '',
    actual_end: '',
    status: 'OPEN',
    on_demand: p.on_demand === 'true',
    reference_no: p.reference_no || '',
    notes_to_interpreter: p.notes_to_interpreter || '',
    consent_recording: p.consent_recording === 'true',
    recording_r2_key: '',
    transcript_r2_key: '',
    created_via: p.created_via || 'portal',
    ai_intake_id: '',
    rate_applied: '{}',
    cancellation_reason: '',
    cancellation_at: '',
    _created_at: now,
    _updated_at: now,
    _rev: 1
  };

  var hdr = _tenantSchema().Jobs;
  var rowArr = hdr.map(function (col) { return row[col] !== undefined ? row[col] : ''; });
  ss.getSheetByName(T.Jobs).appendRow(rowArr);

  _appendJobEvent(ss, jobId, s.payload.uid, 'status_change', 'DRAFT', 'OPEN', '{}');
  _logAudit('job.create', s.payload.tid, s.payload.uid, jobId);

  return _json({ ok:true, job:row });
}

function apiClaimJob(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  if (!jobId) return _json({ ok:false, error:'job_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Jobs);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iJob = hdr.indexOf('job_id'); var iStatus = hdr.indexOf('status');
  var iTenant = hdr.indexOf('tenant_id'); var iUpdated = hdr.indexOf('_updated_at');
  var iRev = hdr.indexOf('_rev');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iJob]) === jobId && String(data[r][iTenant]) === s.payload.tid) {
      var cur = String(data[r][iStatus]);
      if (cur !== 'OPEN' && cur !== 'OFFERED') {
        return _json({ ok:false, error:'Job is not claimable (status=' + cur + ')' });
      }
      sh.getRange(r + 1, iStatus + 1).setValue('CLAIMED');
      sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
      sh.getRange(r + 1, iRev + 1).setValue(Number(data[r][iRev] || 0) + 1);

      // Add Job_Assignments row
      var asch = _tenantSchema().Job_Assignments;
      _ensureTab(ss, T.JobAssignments, asch);
      var assignmentId = _ulid('a');
      var now = new Date().toISOString();
      var aRow = {
        assignment_id: assignmentId,
        job_id: jobId,
        interpreter_id: e.parameter.interpreter_id || s.payload.uid,
        role_on_job: 'primary',
        offered_at: now,
        responded_at: now,
        response: 'claim',
        pay_rate_snapshot: '{}',
        billable_minutes: 0,
        status: 'CLAIMED',
        _created_at: now,
        _updated_at: now,
        _rev: 1
      };
      var aArr = asch.map(function (c) { return aRow[c] !== undefined ? aRow[c] : ''; });
      ss.getSheetByName(T.JobAssignments).appendRow(aArr);

      _appendJobEvent(ss, jobId, s.payload.uid, 'assignment_claimed', cur, 'CLAIMED', JSON.stringify({ assignment_id:assignmentId }));
      _logAudit('job.claim', s.payload.tid, s.payload.uid, jobId);
      return _json({ ok:true, job_id:jobId, assignment_id:assignmentId });
    }
  }
  return _json({ ok:false, error:'Job not found' }, 404);
}

function apiCancelJob(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  var reason = e.parameter.reason || '';
  if (!jobId) return _json({ ok:false, error:'job_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Jobs);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iJob = hdr.indexOf('job_id'); var iStatus = hdr.indexOf('status');
  var iTenant = hdr.indexOf('tenant_id'); var iCanc = hdr.indexOf('cancellation_reason');
  var iCancTs = hdr.indexOf('cancellation_at'); var iUpdated = hdr.indexOf('_updated_at');
  var iRev = hdr.indexOf('_rev');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iJob]) === jobId && String(data[r][iTenant]) === s.payload.tid) {
      var prev = String(data[r][iStatus]);
      sh.getRange(r + 1, iStatus + 1).setValue('CANCELLED_BY_AGENCY');
      sh.getRange(r + 1, iCanc + 1).setValue(reason);
      sh.getRange(r + 1, iCancTs + 1).setValue(new Date().toISOString());
      sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
      sh.getRange(r + 1, iRev + 1).setValue(Number(data[r][iRev] || 0) + 1);
      _appendJobEvent(ss, jobId, s.payload.uid, 'status_change', prev, 'CANCELLED_BY_AGENCY', JSON.stringify({ reason:reason }));
      _logAudit('job.cancel', s.payload.tid, s.payload.uid, jobId + ' reason=' + reason);
      return _json({ ok:true });
    }
  }
  return _json({ ok:false, error:'Job not found' }, 404);
}

function _findJob(ss, tenantId, jobId) {
  var sh = ss.getSheetByName(T.Jobs);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id === tenantId && o.job_id === jobId) return o;
  }
  return null;
}

function _appendJobEvent(ss, jobId, actorUserId, eventType, fromState, toState, payloadJson) {
  _ensureTab(ss, T.JobEvents, _tenantSchema().Job_Events);
  ss.getSheetByName(T.JobEvents).appendRow([
    _ulid('e'), jobId, actorUserId, eventType, fromState, toState, payloadJson, new Date().toISOString()
  ]);
}

// ============================================================================
// SMART-FILL — transparent deterministic ranking
// ============================================================================
//
// Returns ranked interpreter candidates with per-factor scores. AI ranking
// belongs in a Worker later; this is the deterministic v1 baseline.

function apiSmartFill(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  if (!jobId) return _json({ ok:false, error:'job_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _findJob(ss, s.payload.tid, jobId);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);

  var interpreters = _listInterpreters(ss, s.payload.tid);
  var ranked = interpreters.map(function (i) {
    return _scoreInterpreter(i, job);
  });
  ranked.sort(function (a, b) { return b.score.total - a.score.total; });
  return _json({ ok:true, job_id:jobId, candidates: ranked.slice(0, 10) });
}

function _listInterpreters(ss, tenantId) {
  var sh = ss.getSheetByName(T.Interpreters);
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id === tenantId && o.status === 'active') out.push(o);
  }
  return out;
}

function _scoreInterpreter(interp, job) {
  // Weights are public per PRD: certification fit 30, location 20, requestor pref 20,
  // workload balance 15, prior performance 15. Total 100.
  var s = { certification:0, location:0, preference:0, workload:0, performance:0 };

  // Certification + language fit (30 pts)
  var iLangs = []; try { iLangs = JSON.parse(interp.languages || '[]'); } catch (_) { iLangs = []; }
  var hasLang = iLangs.some(function (l) {
    return l.lang === job.target_language_id || l.lang === job.source_language_id;
  });
  s.certification = hasLang ? 30 : 0;

  // Location proximity (20 pts). On-site only; remote modalities get full.
  if (job.modality !== 'on-site') {
    s.location = 20;
  } else {
    s.location = 12;  // placeholder until we have geo math
  }

  // Requestor preference (20 pts). Placeholder until history is wired.
  s.preference = 10;

  // Workload balance (15 pts). Placeholder.
  s.workload = 12;

  // Prior performance (15 pts). Placeholder.
  s.performance = 11;

  var total = s.certification + s.location + s.preference + s.workload + s.performance;
  return {
    interpreter_id: interp.interpreter_id,
    display_name: interp.legal_first + ' ' + interp.legal_last,
    deaf: interp.deaf === true || interp.deaf === 'true',
    languages: interp.languages,
    modalities: interp.modalities,
    score: { total: total, breakdown: s, max: 100 }
  };
}

// ============================================================================
// INTERPRETERS — roster CRUD
// ============================================================================

function apiListInterpreters(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Interpreters, _tenantSchema().Interpreters);
  var sh = ss.getSheetByName(T.Interpreters);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, interpreters:[] });
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id !== s.payload.tid) continue;
    out.push(o);
  }
  out.sort(function (a, b) {
    return String(a.legal_last || '').localeCompare(String(b.legal_last || ''));
  });
  return _json({ ok:true, interpreters: out });
}

function apiCreateInterpreter(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  if (!p.legal_first || !p.legal_last) return _json({ ok:false, error:'legal_first and legal_last required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Interpreters, _tenantSchema().Interpreters);

  var interpreterId = _ulid('i');
  var now = new Date().toISOString();
  var row = {
    interpreter_id: interpreterId,
    tenant_id: s.payload.tid,
    user_id: '',
    classification: p.classification || '1099',
    legal_first: p.legal_first,
    legal_last: p.legal_last,
    pronouns: p.pronouns || '',
    home_city: p.home_city || '',
    home_state: p.home_state || '',
    home_zip: p.home_zip || '',
    service_radius_mi: Number(p.service_radius_mi || 60),
    has_vehicle: p.has_vehicle === 'true',
    modalities: p.modalities || '["on-site","VRI","OPI"]',
    languages: p.languages || '[]',  // expected JSON
    certifications: p.certifications || '[]',
    skills: p.skills || '[]',
    rate_card_id: '',
    min_call_hours: Number(p.min_call_hours || 2),
    availability_prefs: '{}',
    availability_doc_id: '',
    payment_method: p.payment_method || 'ach',
    payment_details_encrypted: '',
    w9_doc_id: '',
    coi_doc_id: '',
    background_check_at: '',
    deaf: p.deaf === 'true',
    notes_internal: p.notes_internal || '',
    status: 'active',
    _created_at: now,
    _updated_at: now,
    _rev: 1
  };
  var hdr = _tenantSchema().Interpreters;
  var rowArr = hdr.map(function (col) { return row[col] !== undefined ? row[col] : ''; });
  ss.getSheetByName(T.Interpreters).appendRow(rowArr);
  _logAudit('interpreter.create', s.payload.tid, s.payload.uid, interpreterId);
  return _json({ ok:true, interpreter: row });
}

function apiUpdateInterpreter(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  var id = p.interpreter_id;
  if (!id) return _json({ ok:false, error:'interpreter_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Interpreters);
  if (!sh) return _json({ ok:false, error:'No interpreters tab yet' }, 404);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('interpreter_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iUpdated = hdr.indexOf('_updated_at');
  var iRev = hdr.indexOf('_rev');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) === id && String(data[r][iTenant]) === s.payload.tid) {
      // Apply allowed updates
      var allowed = ['classification','legal_first','legal_last','pronouns','home_city','home_state','home_zip','service_radius_mi','has_vehicle','modalities','languages','certifications','skills','min_call_hours','payment_method','deaf','notes_internal','status'];
      allowed.forEach(function (field) {
        if (p[field] === undefined || p[field] === null) return;
        var col = hdr.indexOf(field);
        if (col < 0) return;
        var v = p[field];
        if (field === 'has_vehicle' || field === 'deaf') v = (v === 'true');
        if (field === 'service_radius_mi' || field === 'min_call_hours') v = Number(v);
        sh.getRange(r + 1, col + 1).setValue(v);
      });
      sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
      sh.getRange(r + 1, iRev + 1).setValue(Number(data[r][iRev] || 0) + 1);
      _logAudit('interpreter.update', s.payload.tid, s.payload.uid, id);
      return _json({ ok:true, interpreter_id:id });
    }
  }
  return _json({ ok:false, error:'Interpreter not found' }, 404);
}

// ============================================================================
// REQUESTORS — booking parties CRUD
// ============================================================================

function apiListRequestors(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Requestors, _tenantSchema().Requestors);
  var sh = ss.getSheetByName(T.Requestors);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, requestors:[] });
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id !== s.payload.tid) continue;
    out.push(o);
  }
  out.sort(function (a, b) { return String(a.display_name || '').localeCompare(String(b.display_name || '')); });
  return _json({ ok:true, requestors: out });
}

function apiCreateRequestor(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  if (!p.display_name) return _json({ ok:false, error:'display_name required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Requestors, _tenantSchema().Requestors);

  var requestorId = _ulid('r');
  var now = new Date().toISOString();
  var row = {
    requestor_id: requestorId,
    tenant_id: s.payload.tid,
    display_name: p.display_name,
    type: p.type || 'medical',
    parent_org_id: '',
    billing_payer_id: '',
    default_location_id: '',
    contract_doc_id: '',
    po_required: p.po_required === 'true',
    notes: p.notes || '',
    status: 'active',
    _created_at: now,
    _updated_at: now,
    _rev: 1
  };
  var hdr = _tenantSchema().Requestors;
  var rowArr = hdr.map(function (col) { return row[col] !== undefined ? row[col] : ''; });
  ss.getSheetByName(T.Requestors).appendRow(rowArr);
  _logAudit('requestor.create', s.payload.tid, s.payload.uid, requestorId);
  return _json({ ok:true, requestor: row });
}

// ============================================================================
// AGENCY + SETTINGS — owner can update agency + rate cards
// ============================================================================

function apiUpdateAgency(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var p = e.parameter || {};
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Agencies);
  if (!sh) return _json({ ok:false, error:'No agencies tab' }, 404);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('tenant_id');
  var iUpdated = hdr.indexOf('_updated_at');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) === s.payload.tid) {
      var allowed = ['legal_name','tax_id_last4','phi_mode','timezone','brand_color','billing_email'];
      allowed.forEach(function (field) {
        if (p[field] === undefined || p[field] === null) return;
        var col = hdr.indexOf(field);
        if (col < 0) return;
        sh.getRange(r + 1, col + 1).setValue(p[field]);
      });
      sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
      _logAudit('agency.update', s.payload.tid, s.payload.uid, '');
      return _json({ ok:true });
    }
  }
  return _json({ ok:false, error:'Agency not found' }, 404);
}

function apiListSettings(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Settings, _tenantSchema().Settings);
  var sh = ss.getSheetByName(T.Settings);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, settings:{} });
  var hdr = data[0];
  var settings = {};
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    settings[o.key] = { value: o.value, category: o.category };
  }
  return _json({ ok:true, settings:settings });
}

function apiUpdateSetting(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var p = e.parameter || {};
  if (!p.key) return _json({ ok:false, error:'key required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Settings, _tenantSchema().Settings);
  var sh = ss.getSheetByName(T.Settings);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iKey = hdr.indexOf('key');
  var iValue = hdr.indexOf('value');
  var iCategory = hdr.indexOf('category');
  var iUpdated = hdr.indexOf('updated_at');
  var iUpdatedBy = hdr.indexOf('updated_by_user_id');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iKey]) === p.key) {
      sh.getRange(r + 1, iValue + 1).setValue(p.value || '');
      if (iUpdated >= 0) sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
      if (iUpdatedBy >= 0) sh.getRange(r + 1, iUpdatedBy + 1).setValue(s.payload.uid);
      _logAudit('setting.update', s.payload.tid, s.payload.uid, p.key);
      return _json({ ok:true });
    }
  }
  // Not found — append new
  var now = new Date().toISOString();
  sh.appendRow([p.key, p.value || '', p.category || 'misc', s.payload.uid, now, now, now]);
  _logAudit('setting.create', s.payload.tid, s.payload.uid, p.key);
  return _json({ ok:true });
}

// ============================================================================
// BOOTSTRAP — one-shot tenant schema build
// ============================================================================

function apiBootstrap(e) {
  // Admin-gated. For v1: token must equal HMAC secret prefix or session role=role_owner.
  var s = _requireSession(e);
  var canBootstrap = false;
  if (s.ok && s.payload.role === 'role_owner') canBootstrap = true;
  // Allow bootstrap when there are no users yet (initial setup)
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var userSheet = ss.getSheetByName(T.Users);
  if (!userSheet || userSheet.getLastRow() < 2) canBootstrap = true;
  if (!canBootstrap) return _json({ ok:false, error:'Not authorized.' }, 403);

  var report = bootstrapHostTenant();
  return _json({ ok:true, report:report });
}

function bootstrapHostTenant() {
  // Idempotent: builds the canonical 21-tab schema, seeds Roles, Languages,
  // Certifications, and ensures the host Agency + Anthony's owner User row.
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var schema = _tenantSchema();
  var report = { created: [], existed: [], seeded: {} };

  Object.keys(schema).forEach(function (tabName) {
    var sh = ss.getSheetByName(tabName);
    if (!sh) {
      sh = ss.insertSheet(tabName);
      sh.appendRow(schema[tabName]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, schema[tabName].length).setFontWeight('bold');
      report.created.push(tabName);
    } else {
      report.existed.push(tabName);
    }
  });

  // Seed Roles
  _seedRoles(ss);
  report.seeded.Roles = ss.getSheetByName(T.Roles).getLastRow() - 1;

  // Seed Languages
  var langSheet = ss.getSheetByName(T.Languages);
  if (langSheet.getLastRow() < 2) {
    var langs = [
      ['ASL','American Sign Language','signed','["bi","voice-only","sign-only"]','["Black ASL","PSE","Contact"]','Sgnw',false],
      ['PSE','Pidgin Signed English','signed','["bi"]','[]','Sgnw',false],
      ['en-US','English (US)','spoken','["bi","voice-only"]','[]','Latn',false],
      ['es-419','Spanish (Latin American)','spoken','["bi","voice-only"]','["es-MX","es-PR","es-DR","es-CL"]','Latn',false],
      ['es-ES','Spanish (Spain)','spoken','["bi"]','[]','Latn',false],
      ['cmn-CN','Mandarin (Simplified)','spoken','["bi","voice-only"]','[]','Hans',false],
      ['yue-HK','Cantonese','spoken','["bi","voice-only"]','[]','Hant',false],
      ['ar-MSA','Arabic (Modern Standard)','spoken','["bi","voice-only"]','["ar-EG","ar-LV","ar-MR"]','Arab',true],
      ['ht','Haitian Creole','spoken','["bi"]','[]','Latn',false],
      ['vi','Vietnamese','spoken','["bi"]','[]','Latn',false],
      ['ko','Korean','spoken','["bi"]','[]','Kore',false],
      ['ru','Russian','spoken','["bi"]','[]','Cyrl',false],
      ['fr','French','spoken','["bi"]','["fr-CA","fr-HT"]','Latn',false],
      ['so','Somali','spoken','["bi"]','[]','Latn',false],
      ['am','Amharic','spoken','["bi"]','[]','Ethi',false],
      ['fa','Farsi (Persian)','spoken','["bi"]','["fa-AF (Dari)"]','Arab',true],
      ['ps','Pashto','spoken','["bi"]','[]','Arab',true],
      ['pt-BR','Portuguese (Brazil)','spoken','["bi"]','[]','Latn',false],
      ['ProTactile','ProTactile ASL','signed','["bi"]','[]','Sgnw',false],
      ['CDI','Certified Deaf Interpreter (relay role)','signed','["bi"]','[]','Sgnw',false]
    ];
    var ts = new Date().toISOString();
    langs.forEach(function (l) { langSheet.appendRow(l.concat([ts, ts])); });
  }
  report.seeded.Languages = langSheet.getLastRow() - 1;

  // Seed Certifications
  var certSheet = ss.getSheetByName(T.Certifications);
  if (certSheet.getLastRow() < 2) {
    var certs = [
      ['NIC','RID','National Interpreter Certification','["ASL"]',true,true],
      ['CDI','RID','Certified Deaf Interpreter','["ASL","ProTactile"]',true,true],
      ['NIC-Advanced','RID','NIC Advanced','["ASL"]',true,true],
      ['NIC-Master','RID','NIC Master','["ASL"]',true,true],
      ['BEI-Basic','BEI','BEI Basic','["ASL"]',true,true],
      ['BEI-Advanced','BEI','BEI Advanced','["ASL"]',true,true],
      ['BEI-Master','BEI','BEI Master','["ASL"]',true,true],
      ['SC:L','RID','Specialist Certificate: Legal','["ASL"]',true,true],
      ['EIPA-3.5','EIPA','EIPA Level 3.5','["ASL"]',true,true],
      ['EIPA-4.0','EIPA','EIPA Level 4.0','["ASL"]',true,true],
      ['CCHI-CHI','CCHI','Certified Healthcare Interpreter','["*"]',true,true],
      ['NBCMI','NBCMI','National Board Certified Medical Interpreter','["*"]',true,true],
      ['CMI-Spanish','NBCMI','Certified Medical Interpreter — Spanish','["es-419","es-ES"]',true,true],
      ['ATA','ATA','American Translators Association certified','["*"]',true,true],
      ['FCICE','FCICE','Federal Court Interpreter Certification','["*"]',true,true],
      ['CRC-NCRA','NCRA','Certified Realtime Captioner','["en-US"]',true,true],
      ['MD-Court-Cert','State of MD','Maryland Court Interpreter','["*"]',true,true]
    ];
    var ts2 = new Date().toISOString();
    certs.forEach(function (c) { certSheet.appendRow(c.concat([ts2, ts2])); });
  }
  report.seeded.Certifications = certSheet.getLastRow() - 1;

  // Ensure host Agencies row + owner User
  _ensureHostOwner(ss);
  report.host_owner = 'anthonymowl@gmail.com';

  // Seed Settings defaults
  var settingsSheet = ss.getSheetByName(T.Settings);
  if (settingsSheet.getLastRow() < 2) {
    var ts3 = new Date().toISOString();
    var defaults = [
      ['cancellation_policy.late_window_hours', '24', 'cancellation-policy'],
      ['cancellation_policy.no_show_minutes', '15', 'cancellation-policy'],
      ['rate_card.medical.on-site.solo.hourly_cents', '9500', 'rate-card'],
      ['rate_card.legal.on-site.solo.hourly_cents', '12500', 'rate-card'],
      ['rate_card.education.on-site.solo.hourly_cents', '8500', 'rate-card'],
      ['rate_card.translation.per_word_cents', '20', 'rate-card'],
      ['rate_card.minimum.medical.hours', '2.0', 'rate-card'],
      ['terminology.consumer', 'consumer', 'terminology'],
      ['terminology.requestor', 'requestor', 'terminology']
    ];
    defaults.forEach(function (d) {
      settingsSheet.appendRow([d[0], d[1], d[2], '', ts3, ts3, ts3]);
    });
  }
  report.seeded.Settings = settingsSheet.getLastRow() - 1;

  _logAudit('tenant.bootstrap', 'host', 'system', JSON.stringify(report));
  return report;
}

// ============================================================================
// SCHEMA DEFINITIONS — column lists for every tab
// ============================================================================

function _tenantSchema() {
  return {
    Agencies: ['tenant_id','legal_name','tax_id_last4','tier','phi_mode','timezone','primary_owner_user_id','logo_r2_key','brand_color','billing_email','_created_at','_updated_at'],
    Users: ['user_id','tenant_id','email','phone_e164','display_name','role_id','interpreter_id','status','mfa_enabled','webauthn_credential_ids','last_login_at','pii_scope','failed_login_count','sso_subject','_created_at','_updated_at'],
    Roles: ['role_id','tenant_id','display_name','permissions','can_break_glass','max_pii_scope','_created_at','_updated_at'],
    Interpreters: ['interpreter_id','tenant_id','user_id','classification','legal_first','legal_last','pronouns','home_city','home_state','home_zip','service_radius_mi','has_vehicle','modalities','languages','certifications','skills','rate_card_id','min_call_hours','availability_prefs','availability_doc_id','payment_method','payment_details_encrypted','w9_doc_id','coi_doc_id','background_check_at','deaf','notes_internal','status','_created_at','_updated_at','_rev'],
    Languages: ['language_id','display_name','family','directionalities','dialects','script','rtl','_created_at','_updated_at'],
    Certifications: ['certification_id','body','display_name','applies_to_languages','renewable','ceu_required','_created_at','_updated_at'],
    Requestors: ['requestor_id','tenant_id','display_name','type','parent_org_id','billing_payer_id','default_location_id','contract_doc_id','po_required','notes','status','_created_at','_updated_at','_rev'],
    Requestor_Contacts: ['contact_id','requestor_id','tenant_id','user_id','first','last','email','phone_e164','title','preferred_channel','status','_created_at','_updated_at'],
    Payers: ['payer_id','tenant_id','display_name','billing_email','billing_address','net_terms','tax_exempt','stripe_customer_id','qb_customer_id','status','_created_at','_updated_at'],
    Consumers: ['consumer_id','tenant_id','display_initials','legal_first_encrypted','legal_last_encrypted','dob_encrypted','mrn_encrypted','primary_language_id','dialect','communication_prefs','notes_sealed','do_not_contact','consent_recording_default','created_by_user_id','deletion_requested_at','_created_at','_updated_at'],
    Locations: ['location_id','tenant_id','requestor_id','display_name','street','city','state','zip','timezone','parking_notes','accessibility_notes','geo','modalities_supported','_created_at','_updated_at'],
    Jobs: ['job_id','tenant_id','requestor_id','requestor_contact_id','payer_id','location_id','consumer_id','modality','service_type','source_language_id','target_language_id','team_config','scheduled_start','scheduled_end','actual_start','actual_end','status','on_demand','reference_no','notes_to_interpreter','consent_recording','recording_r2_key','transcript_r2_key','created_via','ai_intake_id','rate_applied','cancellation_reason','cancellation_at','_created_at','_updated_at','_rev'],
    Job_Assignments: ['assignment_id','job_id','interpreter_id','role_on_job','offered_at','responded_at','response','pay_rate_snapshot','billable_minutes','status','_created_at','_updated_at','_rev'],
    Job_Events: ['event_id','job_id','actor_user_id','event_type','from_state','to_state','payload','ts'],
    Communications: ['comm_id','tenant_id','channel','direction','template_id','to_user_id','to_address','body_redacted_r2_key','status','provider','provider_msg_id','job_id','_created_at','_updated_at'],
    Invoices: ['invoice_id','tenant_id','payer_id','period_start','period_end','issued_at','due_at','subtotal_cents','tax_cents','total_cents','status','stripe_invoice_id','pdf_r2_key','_created_at','_updated_at'],
    Invoice_Lines: ['line_id','invoice_id','job_id','description','quantity','unit','rate_cents','amount_cents','_created_at','_updated_at'],
    Payouts: ['payout_id','tenant_id','interpreter_id','period_start','period_end','issued_at','total_cents','status','stripe_transfer_id','_created_at','_updated_at'],
    Documents: ['document_id','tenant_id','kind','r2_key','mime','sha256','size_bytes','linked_job_id','linked_interpreter_id','linked_consumer_id','uploaded_by_user_id','signed_url_expiry_default','retention_class','_created_at','_updated_at'],
    Settings: ['key','value','category','updated_by_user_id','updated_at','_created_at','_updated_at'],
    Audit_Log: ['audit_id','tenant_id','ts','user_id','ip','user_agent','action','record_type','record_id','purpose_of_use','result','jti']
  };
}

// ============================================================================
// UTILITIES
// ============================================================================

function _ensureTab(ss, name, headers) {
  return _getOrCreateSheet(ss, name, headers);
}

function _getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

function _rowToObj(hdr, row) {
  var o = {};
  for (var i = 0; i < hdr.length; i++) o[hdr[i]] = row[i];
  return o;
}

function _ulid(prefix) {
  // Not RFC-strict ULID but functionally similar: ms timestamp (base32) + 8 random base32.
  var ts = Date.now().toString(32);
  var rand = '';
  var alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  for (var i = 0; i < 10; i++) rand += alphabet.charAt(Math.floor(Math.random() * 32));
  return (prefix || '') + '_' + ts.toUpperCase() + rand;
}

function _logAudit(action, tenantId, userId, detail) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var headers = _tenantSchema().Audit_Log;
    var sheet = _getOrCreateSheet(ss, T.Audit_Log, headers);
    sheet.appendRow([
      _ulid('au'),
      tenantId || '',
      new Date().toISOString(),
      userId || '',
      '',  // ip
      '',  // user_agent
      action,
      '',  // record_type
      detail || '',
      '',  // purpose_of_use
      'allow',
      ''   // jti
    ]);
  } catch (_) { /* non-fatal */ }
}

function _json(obj, status) {
  // Apps Script web apps can't set HTTP status codes; we encode it in the body.
  if (status && status !== 200) obj._status = status;
  // JSONP support — if a `callback` query param is set on the current request,
  // wrap the JSON in callback(...). Browsers reading our response via <script> tag
  // (the only cross-origin readable way out of Apps Script without CORS headers)
  // need this. We stash the callback in a script-property at the start of doGet.
  var cb = _currentCallback();
  if (cb) {
    return ContentService
      .createTextOutput(cb + '(' + JSON.stringify(obj) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Per-request callback name, threaded through globals because Apps Script's
// ContentService doesn't expose request context to helpers. Cleared at end.
var _CB_HOLDER = { name: null };
function _setCallback(name) { _CB_HOLDER.name = name || null; }
function _currentCallback() { return _CB_HOLDER.name; }

// ============================================================================
// MANUAL TEST HELPERS (run from the Apps Script editor)
// ============================================================================

function _smokeTest() {
  Logger.log(_serviceInfo().getContent());
}

function runBootstrap() {
  // Editor-runnable wrapper for the bootstrap.
  var report = bootstrapHostTenant();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}
