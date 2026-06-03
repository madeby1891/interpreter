/**
 * 1891 Interpreter — SSO (OpenID Connect), alongside magic-link sign-in.
 *
 * Backs the Studio-tier "single sign-on" claim. Works with any OIDC IdP
 * (Google Workspace, Microsoft Entra ID, Okta, Auth0, …) via the authorization-
 * code flow. Per-tenant config + the client secret live in SCRIPT PROPERTIES
 * (server-side), NEVER in the Settings sheet — a plaintext secret in the Sheet
 * was a prior credential leak.
 *
 *   POST ?action=sso_config_set  (owner)  issuer | endpoints, client_id, client_secret,
 *                                          allowed_domain, auto_provision, default_role
 *   GET  ?action=sso_config_get  (owner)  → non-secret config + has_secret
 *   GET  ?action=sso_start&domain=acme.org  → { authorize_url }
 *   POST ?action=sso_callback    { code, state }  → { session, user }
 *
 * A user must already exist in the tenant (invited/active) unless the owner turns
 * on auto_provision for a verified email domain. SSO links the IdP `sub` to that
 * user and mints our normal app session — identical downstream to magic-link.
 *
 * The code exchange is a confidential-client call over TLS (client_secret), and
 * identity comes from the IdP's userinfo endpoint with the returned access token.
 */

var SSO_STATE_TTL_MS = 10 * 60 * 1000;

function _ssoCfgKey_(tid) { return 'SSO_CFG_' + tid; }
function _ssoSecretKey_(tid) { return 'SSO_SECRET_' + tid; }

function _ssoGetConfig_(tid) {
  var raw = PropertiesService.getScriptProperties().getProperty(_ssoCfgKey_(tid));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}
function _ssoGetSecret_(tid) {
  return PropertiesService.getScriptProperties().getProperty(_ssoSecretKey_(tid)) || '';
}

function apiSsoConfigSet(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_platform_staff') {
    return _json({ ok:false, error:'Owner role required' }, 403);
  }
  var p = e.parameter || {};
  var tid = (s.payload.role === 'role_platform_staff' && p.tenant_id) ? p.tenant_id : s.payload.tid;

  var cfg = {
    enabled: String(p.enabled) === 'true',
    issuer: String(p.issuer || ''),
    client_id: String(p.client_id || ''),
    authorize_url: String(p.authorize_url || ''),
    token_url: String(p.token_url || ''),
    userinfo_url: String(p.userinfo_url || ''),
    allowed_domain: String(p.allowed_domain || '').toLowerCase(),
    auto_provision: String(p.auto_provision) === 'true',
    default_role: String(p.default_role || 'role_interpreter')
  };

  // Discovery: if only an issuer is given, pull the well-known config.
  if (cfg.issuer && (!cfg.authorize_url || !cfg.token_url || !cfg.userinfo_url)) {
    try {
      var disc = JSON.parse(UrlFetchApp.fetch(
        cfg.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration',
        { muteHttpExceptions: true }
      ).getContentText());
      cfg.authorize_url = cfg.authorize_url || disc.authorization_endpoint || '';
      cfg.token_url = cfg.token_url || disc.token_endpoint || '';
      cfg.userinfo_url = cfg.userinfo_url || disc.userinfo_endpoint || '';
    } catch (_) { /* leave endpoints as provided */ }
  }

  var props = PropertiesService.getScriptProperties();
  props.setProperty(_ssoCfgKey_(tid), JSON.stringify(cfg));
  if (p.client_secret) props.setProperty(_ssoSecretKey_(tid), String(p.client_secret));
  _logAudit('sso.config_set', tid, s.payload.uid, 'enabled=' + cfg.enabled + ' domain=' + cfg.allowed_domain);
  return _json({ ok:true, config: cfg, has_secret: !!_ssoGetSecret_(tid) });
}

function apiSsoConfigGet(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_platform_staff') {
    return _json({ ok:false, error:'Owner role required' }, 403);
  }
  var p = e.parameter || {};
  var tid = (s.payload.role === 'role_platform_staff' && p.tenant_id) ? p.tenant_id : s.payload.tid;
  return _json({ ok:true, config: _ssoGetConfig_(tid) || {}, has_secret: !!_ssoGetSecret_(tid) });
}

function _ssoResolveTenant_(p) {
  if (p.tenant_id) return p.tenant_id;
  var domain = '';
  if (p.domain) domain = String(p.domain).toLowerCase();
  else if (p.email && p.email.indexOf('@') >= 0) domain = p.email.split('@')[1].toLowerCase();
  if (!domain) return '';
  var props = PropertiesService.getScriptProperties();
  var keys = props.getKeys();
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf('SSO_CFG_') !== 0) continue;
    var cfg = null;
    try { cfg = JSON.parse(props.getProperty(keys[i])); } catch (_) {}
    if (cfg && cfg.enabled && cfg.allowed_domain && cfg.allowed_domain === domain) {
      return keys[i].slice('SSO_CFG_'.length);
    }
  }
  return '';
}

function apiSsoStart(e) {
  var p = e.parameter || {};
  var tid = _ssoResolveTenant_(p);
  if (!tid) return _json({ ok:false, error:'No SSO is set up for that organization.' }, 404);
  var cfg = _ssoGetConfig_(tid);
  if (!cfg || !cfg.enabled || !cfg.authorize_url || !cfg.client_id) {
    return _json({ ok:false, error:'SSO is not enabled for this organization.' }, 400);
  }
  var state = _ssoSignState_({ tid: tid, nonce: _newToken().slice(0, 16), exp: Date.now() + SSO_STATE_TTL_MS });
  var redirectUri = SITE_BASE + '/app/sso/callback.html';
  var url = cfg.authorize_url +
    (cfg.authorize_url.indexOf('?') >= 0 ? '&' : '?') +
    'response_type=code' +
    '&client_id=' + encodeURIComponent(cfg.client_id) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&scope=' + encodeURIComponent('openid email profile') +
    '&state=' + encodeURIComponent(state);
  return _json({ ok:true, authorize_url: url });
}

function _ssoSignState_(obj) {
  var payload = Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  return payload + '.' + _hmacB64Url(payload);
}
function _ssoVerifyState_(state) {
  if (!state || state.indexOf('.') < 0) return null;
  var parts = state.split('.');
  if (_hmacB64Url(parts[0]) !== parts[1]) return null;
  var obj = null;
  try { obj = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()); }
  catch (_) { return null; }
  if (!obj || !obj.exp || Date.now() > obj.exp) return null;
  return obj;
}

function apiSsoCallback(e) {
  var p = e.parameter || {};
  if ((!p.code || !p.state) && e.postData && e.postData.type === 'application/json') {
    try { var b = JSON.parse(e.postData.contents); for (var k in b) if (p[k] === undefined) p[k] = b[k]; } catch (_) {}
  }
  var st = _ssoVerifyState_(p.state);
  if (!st) return _json({ ok:false, error:'Invalid or expired sign-in. Please start again.' }, 400);
  var tid = st.tid;
  var cfg = _ssoGetConfig_(tid);
  if (!cfg || !cfg.token_url) return _json({ ok:false, error:'SSO is not configured.' }, 400);

  // Exchange the authorization code (confidential client).
  var redirectUri = SITE_BASE + '/app/sso/callback.html';
  var tokenRes = UrlFetchApp.fetch(cfg.token_url, {
    method: 'post',
    muteHttpExceptions: true,
    payload: {
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: redirectUri,
      client_id: cfg.client_id,
      client_secret: _ssoGetSecret_(tid)
    }
  });
  if (tokenRes.getResponseCode() !== 200) {
    _logAudit('sso.token_error', tid, 'system', 'status=' + tokenRes.getResponseCode());
    return _json({ ok:false, error:'Sign-in failed at the identity provider.' }, 401);
  }
  var tok = JSON.parse(tokenRes.getContentText());
  var accessToken = tok.access_token;

  var email = '', sub = '', name = '';
  if (cfg.userinfo_url && accessToken) {
    var ui = UrlFetchApp.fetch(cfg.userinfo_url, {
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (ui.getResponseCode() === 200) {
      var info = JSON.parse(ui.getContentText());
      email = String(info.email || '').toLowerCase();
      sub = String(info.sub || '');
      name = String(info.name || '');
    }
  }
  if (!email) return _json({ ok:false, error:'The identity provider did not share an email.' }, 401);
  if (cfg.allowed_domain && email.split('@')[1] !== cfg.allowed_domain) {
    return _json({ ok:false, error:'That email domain is not allowed for this organization.' }, 403);
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var user = _lookupUserByEmail(ss, email);
  if (user && user.tenant_id && user.tenant_id !== tid) user = null; // belongs to another tenant
  if (!user) {
    if (!cfg.auto_provision) {
      return _json({ ok:false, error:'No account for ' + email + ' at this agency. Ask an admin to invite you first.' }, 403);
    }
    user = _ssoProvisionUser_(ss, tid, email, name, cfg.default_role);
  }
  _ssoStampUser_(ss, user.user_id, sub);

  var session = _mintSession({ uid: user.user_id, tid: tid, role: user.role_id, email: email });
  _logAudit('sso.login', tid, user.user_id, sub ? ('sub=' + _sha256Hex(sub).slice(0, 12)) : 'no-sub');
  return _json({
    ok: true,
    session: session,
    user: {
      user_id: user.user_id, tenant_id: tid, email: email,
      display_name: user.display_name || name, role_id: user.role_id
    }
  });
}

// Set sso_subject (first link only) + last_login_at on the Users row.
function _ssoStampUser_(ss, userId, sub) {
  var sh = ss.getSheetByName(T.Users);
  if (!sh) return;
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('user_id');
  var iSub = hdr.indexOf('sso_subject');
  var iLogin = hdr.indexOf('last_login_at');
  var iUpd = hdr.indexOf('_updated_at');
  var now = new Date().toISOString();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iId]) !== userId) continue;
    if (iSub >= 0 && sub && !data[i][iSub]) sh.getRange(i + 1, iSub + 1).setValue(sub);
    if (iLogin >= 0) sh.getRange(i + 1, iLogin + 1).setValue(now);
    if (iUpd >= 0) sh.getRange(i + 1, iUpd + 1).setValue(now);
    return;
  }
}

function _ssoProvisionUser_(ss, tid, email, name, defaultRole) {
  _ensureTab(ss, T.Users, _tenantSchema().Users);
  var sh = ss.getSheetByName(T.Users);
  var hdr = _tenantSchema().Users;
  var now = new Date().toISOString();
  var row = {
    user_id: _ulid('u'),
    tenant_id: tid,
    email: email,
    phone_e164: '',
    display_name: name || email.split('@')[0],
    role_id: defaultRole || 'role_interpreter',
    interpreter_id: '',
    status: 'active',
    mfa_enabled: false,
    webauthn_credential_ids: '',
    last_login_at: now,
    pii_scope: 'masked',
    failed_login_count: 0,
    sso_subject: '',
    calendar_token: '',
    _created_at: now,
    _updated_at: now
  };
  sh.appendRow(hdr.map(function (c) { return row[c] !== undefined ? row[c] : ''; }));
  _logAudit('sso.user_provisioned', tid, 'system', row.user_id + ' ' + email);
  return row;
}
