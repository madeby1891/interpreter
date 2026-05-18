// ============================================================================
// Code_Invitations.gs — Teammate invitation flow.
// v18.3 — May 2026
//
// Lets an agency owner / manager / platform staff invite teammates (other
// managers, schedulers, interpreters, client contacts, billing contacts)
// without manual Sheet edits.
//
// Flow:
//   1. Inviter POSTs invite_user with email + role + display_name (+ optional
//      interpreter_id / client_id / phone / notes).
//   2. We insert a Users row with status='invited', mint a 7-day invitation
//      token (stored as a hash in Auth_Tokens with purpose='invitation') and
//      email the invitee a setup link.
//   3. Invitee clicks the link → existing /app/callback.html flow runs against
//      apiAuthVerify which auto-flips status='invited' → 'active' on first
//      successful redemption (the change lives in Code.gs).
//
// Auth gates:
//   - role_owner / role_platform_staff can invite ANY role.
//   - role_manager can invite scheduler, interpreter, client_contact,
//     requestor_contact, billing_contact — but NOT owner or another manager.
//
// Idempotency: re-inviting an already-invited email returns the existing
// user_id rather than 4xx, so the UI can be safely retried.
// ============================================================================

var INVITATION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
var INVITATION_PURPOSE      = 'invitation';

// Role allowlists by inviter role.
var _INVITE_ALLOWLIST = {
  role_platform_staff: [
    'role_platform_staff','role_owner','role_manager','role_admin',
    'role_scheduler','role_interpreter','role_client_contact',
    'role_requestor_contact','role_billing_contact','role_payer_contact',
    'role_consumer_self','role_auditor'
  ],
  role_owner: [
    'role_owner','role_manager','role_admin','role_scheduler','role_interpreter',
    'role_client_contact','role_requestor_contact','role_billing_contact',
    'role_payer_contact','role_consumer_self','role_auditor'
  ],
  // Manager can invite operational roles only. NO owner/manager/admin (no
  // privilege escalation) and no auditor (security-sensitive).
  role_manager: [
    'role_scheduler','role_interpreter','role_client_contact',
    'role_requestor_contact','role_billing_contact'
  ]
};

// Display labels for role_id used in invitation email copy.
var _ROLE_LABELS = {
  role_platform_staff:    '1891 platform staff',
  role_owner:             'Owner',
  role_manager:           'Manager',
  role_admin:             'Admin',
  role_scheduler:         'Scheduler',
  role_interpreter:       'Interpreter',
  role_client_contact:    'Client contact',
  role_requestor_contact: 'Requestor contact',
  role_billing_contact:   'Billing contact',
  role_payer_contact:     'Payer contact',
  role_consumer_self:     'Consumer (self-service)',
  role_auditor:           'Auditor'
};

// PII scope default by role: only interpreters / staff / owner / manager /
// scheduler / admin / auditor get any consumer PII access (masked), the
// rest get 'none'.
function _defaultPiiScopeForRole_(roleId) {
  if (roleId === 'role_interpreter' || roleId === 'role_owner' ||
      roleId === 'role_manager' || roleId === 'role_admin' ||
      roleId === 'role_scheduler' || roleId === 'role_platform_staff' ||
      roleId === 'role_auditor') {
    return JSON.stringify({ consumer: 'masked' });
  }
  return JSON.stringify({ consumer: 'none' });
}

function _canInvite_(inviterRole, targetRole) {
  var list = _INVITE_ALLOWLIST[inviterRole];
  if (!list) return false;
  return list.indexOf(targetRole) >= 0;
}

// Make sure Auth_Tokens has a `purpose` column so we can tell invitation
// tokens apart from magic-link tokens. Adds the column header if missing.
function _ensureAuthTokensPurpose_(ss) {
  var sh = _getOrCreateSheet(ss, T.AuthTokens,
    ['issued_at','email','token_hash','user_id','tenant_id','expires_at','consumed_at','ip','user_agent','purpose']);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  if (hdr.indexOf('purpose') < 0) {
    sh.getRange(1, sh.getLastColumn() + 1).setValue('purpose');
  }
  return sh;
}

// ============================================================================
// apiInviteUser  (POST action=invite_user)
// ============================================================================

function apiInviteUser(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);

  var inviterRole = s.payload.role;
  if (inviterRole !== 'role_owner' &&
      inviterRole !== 'role_manager' &&
      inviterRole !== 'role_platform_staff') {
    return _json({ ok:false, error:'Forbidden: invite requires owner, manager, or platform staff role.' }, 403);
  }

  var p = e.parameter || {};
  var email       = String(p.email || '').trim().toLowerCase();
  var roleId      = String(p.role_id || '').trim();
  var displayName = String(p.display_name || '').trim();
  var interpreterId = String(p.interpreter_id || '').trim();
  var clientId      = String(p.client_id || '').trim();
  var phone         = String(p.phone_e164 || '').trim();
  var notesForInvitee = String(p.notes_for_invitee || '').trim();

  if (!_isValidEmail(email))    return _json({ ok:false, error:'Valid email required.' });
  if (!displayName)             return _json({ ok:false, error:'display_name required.' });
  if (!roleId)                  return _json({ ok:false, error:'role_id required.' });
  if (!_canInvite_(inviterRole, roleId)) {
    return _json({ ok:false, error:'You are not allowed to invite the role "' + roleId + '".' }, 403);
  }
  // Client_contact / billing_contact must specify a client_id so the user
  // is scoped to a Client on first sign-in.
  if ((roleId === 'role_client_contact' || roleId === 'role_billing_contact') && !clientId) {
    return _json({ ok:false, error:'client_id required when inviting a client_contact or billing_contact.' });
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Users, _tenantSchema().Users);
  _ensureAuthTokensPurpose_(ss);

  var tenantId = s.payload.tid;

  // Idempotency: existing user in this tenant?
  var existing = _findUserInTenant_(ss, tenantId, email);
  var userId;
  var nowIso = new Date().toISOString();

  if (existing) {
    // If they already exist and aren't 'invited' or 'cancelled', refuse —
    // a real teammate can't be re-invited. Otherwise, reuse the row.
    if (existing.status !== 'invited' && existing.status !== 'cancelled') {
      return _json({ ok:false, error:'A user with that email already exists in your agency (status=' + existing.status + ').' });
    }
    userId = existing.user_id;
    // Bring the row back into 'invited' state (covers re-invite after cancel).
    _patchUserRow_(ss, userId, {
      status: 'invited',
      role_id: roleId,
      display_name: displayName || existing.display_name,
      interpreter_id: interpreterId || existing.interpreter_id,
      phone_e164: phone || existing.phone_e164,
      pii_scope: _defaultPiiScopeForRole_(roleId),
      _updated_at: nowIso
    });
  } else {
    userId = _ulid('u');
    var usersSh = ss.getSheetByName(T.Users);
    var hdr = _tenantSchema().Users;
    var rowObj = {
      user_id: userId,
      tenant_id: tenantId,
      email: email,
      phone_e164: phone,
      display_name: displayName,
      role_id: roleId,
      interpreter_id: interpreterId,
      status: 'invited',
      mfa_enabled: false,
      webauthn_credential_ids: '[]',
      last_login_at: '',
      pii_scope: _defaultPiiScopeForRole_(roleId),
      failed_login_count: 0,
      sso_subject: '',
      _created_at: nowIso,
      _updated_at: nowIso
    };
    var rowArr = hdr.map(function (c) { return rowObj[c] !== undefined ? rowObj[c] : ''; });
    usersSh.appendRow(rowArr);
  }

  // Mint invitation token (7-day TTL).
  var token = _newToken();
  var hash  = _sha256Hex(token);
  var expIso = new Date(Date.now() + INVITATION_TOKEN_TTL_MS).toISOString();
  var tokensSh = _ensureAuthTokensPurpose_(ss);
  var tHdr = tokensSh.getRange(1, 1, 1, tokensSh.getLastColumn()).getValues()[0];
  var rowArr = tHdr.map(function (col) {
    switch (col) {
      case 'issued_at': return nowIso;
      case 'email': return email;
      case 'token_hash': return hash;
      case 'user_id': return userId;
      case 'tenant_id': return tenantId;
      case 'expires_at': return expIso;
      case 'consumed_at': return '';
      case 'ip': return '';
      case 'user_agent': return '';
      case 'purpose': return INVITATION_PURPOSE;
      default: return '';
    }
  });
  tokensSh.appendRow(rowArr);

  var invitationUrl = SITE_BASE + '/app/callback.html?token=' + encodeURIComponent(token);

  // Email it.
  var agency = _findAgencyRow(ss, tenantId);
  var agencyLabel = (agency && agency.legal_name) ? agency.legal_name : '1891 Interpreter';
  var inviterName = '';
  try {
    var inviter = _lookupUserById(ss, s.payload.uid);
    if (inviter) inviterName = inviter.display_name || inviter.email || '';
  } catch (_) { /* ignore */ }
  var roleLabel = _ROLE_LABELS[roleId] || roleId;
  var inviterClause = inviterName ? (inviterName + ' invited you') : ('You\'ve been invited');

  var bodyLines = [
    'Hi ' + displayName + ',',
    '',
    inviterClause + ' to join ' + agencyLabel + ' as a ' + roleLabel + '.',
    '',
    'Click below to set up your account:',
    invitationUrl,
    '',
    'This link expires in 7 days. If you didn\'t expect this email, you can ignore it — the link won\'t work without being clicked.'
  ];
  if (notesForInvitee) {
    bodyLines.push('');
    bodyLines.push('A note from ' + (inviterName || 'your inviter') + ':');
    bodyLines.push(notesForInvitee);
  }
  bodyLines.push('');
  bodyLines.push('Built in Frederick. Carried forward since 1891.');
  bodyLines.push('— 1891 Interpreter');

  try {
    MailApp.sendEmail({
      to: email,
      subject: 'You\'re invited to ' + agencyLabel + ' on 1891 Interpreter',
      body: bodyLines.join('\n')
    });
  } catch (err) {
    _logAudit('invite.email_failed', tenantId, s.payload.uid, email + ' err=' + err);
    // Don't fail the API — the row + token are written and the inviter can
    // hit "Resend" to retry the email.
  }

  _logAudit('invite.create', tenantId, s.payload.uid, email + ' role=' + roleId + ' user_id=' + userId);

  return _json({
    ok: true,
    user_id: userId,
    role_id: roleId,
    invitation_url: invitationUrl,
    expires_at: expIso
  });
}

// ============================================================================
// apiListInvitations  (GET action=list_invitations)
// ============================================================================

function apiListInvitations(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' &&
      s.payload.role !== 'role_manager' &&
      s.payload.role !== 'role_platform_staff') {
    return _json({ ok:false, error:'Forbidden.' }, 403);
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Users, _tenantSchema().Users);
  _ensureAuthTokensPurpose_(ss);

  // Users with status='invited' in this tenant.
  var usersSh = ss.getSheetByName(T.Users);
  var data = usersSh.getDataRange().getValues();
  var invitations = [];
  if (data.length >= 2) {
    var hdr = data[0];
    for (var i = 1; i < data.length; i++) {
      var u = _rowToObj(hdr, data[i]);
      if (u.tenant_id !== s.payload.tid) continue;
      if (u.status !== 'invited') continue;
      invitations.push({
        user_id: u.user_id,
        email: u.email,
        display_name: u.display_name,
        role_id: u.role_id,
        role_label: _ROLE_LABELS[u.role_id] || u.role_id,
        interpreter_id: u.interpreter_id,
        phone_e164: u.phone_e164,
        _created_at: u._created_at,
        _updated_at: u._updated_at,
        last_sent_at: '',
        expires_at: '',
        token_status: 'no-token'
      });
    }
  }

  // Cross-reference with Auth_Tokens to find each invitation's freshest token.
  var tokensSh = ss.getSheetByName(T.AuthTokens);
  if (tokensSh && tokensSh.getLastRow() >= 2 && invitations.length) {
    var tData = tokensSh.getDataRange().getValues();
    var tHdr  = tData[0];
    var iUser = tHdr.indexOf('user_id');
    var iIssued = tHdr.indexOf('issued_at');
    var iExp    = tHdr.indexOf('expires_at');
    var iConsumed = tHdr.indexOf('consumed_at');
    var iPurpose  = tHdr.indexOf('purpose');
    var byUser = {};
    for (var j = 1; j < tData.length; j++) {
      if (iPurpose >= 0 && String(tData[j][iPurpose]) !== INVITATION_PURPOSE) continue;
      var uid = String(tData[j][iUser]);
      if (!uid) continue;
      var issued = String(tData[j][iIssued] || '');
      if (!byUser[uid] || issued > byUser[uid].issued) {
        byUser[uid] = {
          issued: issued,
          expires: String(tData[j][iExp] || ''),
          consumed: String(tData[j][iConsumed] || '')
        };
      }
    }
    invitations.forEach(function (inv) {
      var t = byUser[inv.user_id];
      if (!t) return;
      inv.last_sent_at = t.issued;
      inv.expires_at   = t.expires;
      if (t.consumed) inv.token_status = 'consumed';
      else if (t.expires && new Date(t.expires).getTime() < Date.now()) inv.token_status = 'expired';
      else inv.token_status = 'active';
    });
  }

  invitations.sort(function (a, b) { return String(b._created_at).localeCompare(String(a._created_at)); });
  return _json({ ok:true, invitations: invitations });
}

// ============================================================================
// apiCancelInvitation  (POST action=cancel_invitation)
// ============================================================================

function apiCancelInvitation(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' &&
      s.payload.role !== 'role_manager' &&
      s.payload.role !== 'role_platform_staff') {
    return _json({ ok:false, error:'Forbidden.' }, 403);
  }

  var userId = String((e.parameter && e.parameter.user_id) || '').trim();
  if (!userId) return _json({ ok:false, error:'user_id required.' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var user = _lookupUserById(ss, userId);
  if (!user || user.tenant_id !== s.payload.tid) {
    return _json({ ok:false, error:'Invitation not found.' }, 404);
  }
  if (user.status !== 'invited') {
    return _json({ ok:false, error:'User is not in an invited state (status=' + user.status + ').' });
  }

  _patchUserRow_(ss, userId, {
    status: 'cancelled',
    _updated_at: new Date().toISOString()
  });
  _expireInvitationTokens_(ss, userId);

  _logAudit('invite.cancel', s.payload.tid, s.payload.uid, user.email + ' user_id=' + userId);
  return _json({ ok:true, user_id: userId, status: 'cancelled' });
}

// ============================================================================
// apiResendInvitation  (POST action=resend_invitation)
// ============================================================================

function apiResendInvitation(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' &&
      s.payload.role !== 'role_manager' &&
      s.payload.role !== 'role_platform_staff') {
    return _json({ ok:false, error:'Forbidden.' }, 403);
  }

  var userId = String((e.parameter && e.parameter.user_id) || '').trim();
  if (!userId) return _json({ ok:false, error:'user_id required.' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var user = _lookupUserById(ss, userId);
  if (!user || user.tenant_id !== s.payload.tid) {
    return _json({ ok:false, error:'Invitation not found.' }, 404);
  }
  if (user.status !== 'invited') {
    return _json({ ok:false, error:'User is not in an invited state (status=' + user.status + ').' });
  }

  // Expire any outstanding invitation tokens for this user, then mint a fresh one.
  _expireInvitationTokens_(ss, userId);

  var nowIso = new Date().toISOString();
  var token = _newToken();
  var hash  = _sha256Hex(token);
  var expIso = new Date(Date.now() + INVITATION_TOKEN_TTL_MS).toISOString();
  var tokensSh = _ensureAuthTokensPurpose_(ss);
  var tHdr = tokensSh.getRange(1, 1, 1, tokensSh.getLastColumn()).getValues()[0];
  var rowArr = tHdr.map(function (col) {
    switch (col) {
      case 'issued_at': return nowIso;
      case 'email': return user.email;
      case 'token_hash': return hash;
      case 'user_id': return userId;
      case 'tenant_id': return s.payload.tid;
      case 'expires_at': return expIso;
      case 'consumed_at': return '';
      case 'ip': return '';
      case 'user_agent': return '';
      case 'purpose': return INVITATION_PURPOSE;
      default: return '';
    }
  });
  tokensSh.appendRow(rowArr);

  var invitationUrl = SITE_BASE + '/app/callback.html?token=' + encodeURIComponent(token);
  var agency = _findAgencyRow(ss, s.payload.tid);
  var agencyLabel = (agency && agency.legal_name) ? agency.legal_name : '1891 Interpreter';
  var roleLabel = _ROLE_LABELS[user.role_id] || user.role_id;

  var body =
    'Hi ' + (user.display_name || '') + ',\n\n' +
    'Reminder: you\'ve been invited to join ' + agencyLabel + ' as a ' + roleLabel + '.\n\n' +
    'Click below to set up your account:\n' +
    invitationUrl + '\n\n' +
    'This link expires in 7 days.\n\n' +
    'Built in Frederick. Carried forward since 1891.\n' +
    '— 1891 Interpreter';

  try {
    MailApp.sendEmail({
      to: user.email,
      subject: 'Reminder: your 1891 Interpreter invitation',
      body: body
    });
  } catch (err) {
    _logAudit('invite.email_failed', s.payload.tid, s.payload.uid, user.email + ' err=' + err);
    return _json({ ok:false, error:'We couldn\'t send the email right now. Please try again in a minute.' });
  }

  _logAudit('invite.resend', s.payload.tid, s.payload.uid, user.email + ' user_id=' + userId);
  return _json({ ok:true, user_id: userId, invitation_url: invitationUrl, expires_at: expIso });
}

// ============================================================================
// apiListUsers  (GET action=list_users)
// Returns active + invited Users rows in the caller's tenant. Owner / manager
// / platform_staff only — non-managers don't have a "team" view to see.
// ============================================================================

function apiListUsers(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' &&
      s.payload.role !== 'role_manager' &&
      s.payload.role !== 'role_platform_staff') {
    return _json({ ok:false, error:'Forbidden.' }, 403);
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Users, _tenantSchema().Users);
  var sh = ss.getSheetByName(T.Users);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, users: [] });
  var hdr = data[0];
  var users = [];
  for (var i = 1; i < data.length; i++) {
    var u = _rowToObj(hdr, data[i]);
    if (u.tenant_id !== s.payload.tid) continue;
    users.push({
      user_id: u.user_id,
      email: u.email,
      display_name: u.display_name,
      phone_e164: u.phone_e164,
      role_id: u.role_id,
      role_label: _ROLE_LABELS[u.role_id] || u.role_id,
      interpreter_id: u.interpreter_id,
      status: u.status,
      last_login_at: u.last_login_at,
      _created_at: u._created_at
    });
  }
  users.sort(function (a, b) {
    // Active first, then invited, then cancelled; alpha within each group.
    var order = { active: 0, invited: 1, suspended: 2, cancelled: 3 };
    var oa = order[a.status] !== undefined ? order[a.status] : 9;
    var ob = order[b.status] !== undefined ? order[b.status] : 9;
    if (oa !== ob) return oa - ob;
    return String(a.display_name || a.email).localeCompare(String(b.display_name || b.email));
  });
  return _json({ ok:true, users: users });
}

// Also expose the invite-allowlist so the UI can scope the role dropdown
// without hard-coding the matrix on the client.
function apiInviteAllowlist(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var list = _INVITE_ALLOWLIST[s.payload.role] || [];
  var out = list.map(function (rid) {
    return { role_id: rid, label: _ROLE_LABELS[rid] || rid };
  });
  return _json({ ok:true, inviter_role: s.payload.role, allowed_roles: out });
}

// ============================================================================
// Helpers
// ============================================================================

function _findUserInTenant_(ss, tenantId, email) {
  var sh = ss.getSheetByName(T.Users);
  if (!sh || sh.getLastRow() < 2) return null;
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iEmail  = hdr.indexOf('email');
  var iTenant = hdr.indexOf('tenant_id');
  if (iEmail < 0 || iTenant < 0) return null;
  var target = String(email).toLowerCase();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iEmail]).toLowerCase() === target &&
        String(data[i][iTenant]) === tenantId) {
      return _rowToObj(hdr, data[i]);
    }
  }
  return null;
}

function _patchUserRow_(ss, userId, patch) {
  var sh = ss.getSheetByName(T.Users);
  if (!sh || sh.getLastRow() < 2) return false;
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iUser = hdr.indexOf('user_id');
  if (iUser < 0) return false;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iUser]) !== userId) continue;
    Object.keys(patch).forEach(function (key) {
      var c = hdr.indexOf(key);
      if (c >= 0) sh.getRange(r + 1, c + 1).setValue(patch[key]);
    });
    return true;
  }
  return false;
}

function _expireInvitationTokens_(ss, userId) {
  var sh = ss.getSheetByName(T.AuthTokens);
  if (!sh || sh.getLastRow() < 2) return;
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iUser = hdr.indexOf('user_id');
  var iExp  = hdr.indexOf('expires_at');
  var iConsumed = hdr.indexOf('consumed_at');
  var iPurpose = hdr.indexOf('purpose');
  if (iUser < 0 || iExp < 0 || iConsumed < 0) return;
  var nowIso = new Date().toISOString();
  var pastIso = '1970-01-01T00:00:00.000Z';
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iUser]) !== userId) continue;
    if (iPurpose >= 0 && String(data[r][iPurpose]) !== INVITATION_PURPOSE) continue;
    if (data[r][iConsumed]) continue; // already used; leave audit trail intact
    // Backdate expires_at so any in-flight redemption sees an expired token,
    // and stamp consumed_at='cancelled-' marker so resends can ignore it.
    sh.getRange(r + 1, iExp + 1).setValue(pastIso);
    sh.getRange(r + 1, iConsumed + 1).setValue(nowIso + ' (cancelled)');
  }
}
