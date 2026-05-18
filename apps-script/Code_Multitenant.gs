/**
 * 1891 Interpreter — multi-tenant provisioning (Apps Script).
 *
 * Pre-wired routes in Code.gs that land here via _safeCall:
 *   GET  list_tenants        → apiListTenants
 *   GET  get_tenant          → apiGetTenant
 *   GET  list_tenant_owners  → apiListTenantOwners
 *   POST provision_tenant    → apiProvisionTenant
 *   POST switch_tenant       → apiSwitchTenant
 *   POST add_tenant_owner    → apiAddTenantOwner
 *
 * Architecture: per-agency Google Sheet + a separate control Sheet
 * ("1891-interpreter-control") that maps tenant_id → spreadsheet_id and
 * tracks which user accounts own which tenants. The control Sheet ID lives
 * in PropertiesService (key: CONTROL_SHEET_ID); it's created lazily on
 * first use via _ensureControlSheet().
 *
 * Future endpoints should stop calling SpreadsheetApp.openById(SHEET_ID)
 * directly and instead call _resolveTenantSheetId(session.tid). The host
 * tenant short-circuits to the legacy SHEET_ID so we don't have to back-
 * migrate existing rows.
 */

// ============================================================================
// CONTROL-SHEET BOOTSTRAP
// ============================================================================

var CONTROL_TAB = {
  Tenants:       'Tenants',
  Tenant_Owners: 'Tenant_Owners',
  Sys_Log:       'Sys_Log'
};

var CONTROL_SCHEMA = {
  Tenants:       ['tenant_id','spreadsheet_id','legal_name','tier','status','created_at','created_by','notes'],
  Tenant_Owners: ['tenant_id','user_id','user_email','role','added_at','added_by'],
  Sys_Log:       ['ts','event','actor_user_id','tenant_id','payload']
};

/**
 * Idempotent. Reads PropertiesService for CONTROL_SHEET_ID; if missing,
 * creates the 1891-interpreter-control Sheet, stamps the three tabs with
 * headers, and stores the ID. Safe to call from every endpoint.
 *
 * Returns the open Spreadsheet object.
 */
function _ensureControlSheet() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('CONTROL_SHEET_ID');
  var ss;
  if (id) {
    try {
      ss = SpreadsheetApp.openById(id);
    } catch (_) {
      // ID was set but file is gone/inaccessible — fall through to recreate.
      ss = null;
    }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('1891-interpreter-control');
    props.setProperty('CONTROL_SHEET_ID', ss.getId());
    // The default "Sheet1" tab will be replaced by our schema tabs.
    var defaultSheet = ss.getSheets()[0];
    if (defaultSheet && defaultSheet.getName() === 'Sheet1') {
      // Defer delete until after we've added at least one real tab.
      defaultSheet.setName('_tmp_delete_me');
    }
  }
  Object.keys(CONTROL_SCHEMA).forEach(function (tab) {
    var sh = ss.getSheetByName(tab);
    if (!sh) {
      sh = ss.insertSheet(tab);
      sh.appendRow(CONTROL_SCHEMA[tab]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, CONTROL_SCHEMA[tab].length).setFontWeight('bold');
    }
  });
  var tmp = ss.getSheetByName('_tmp_delete_me');
  if (tmp && ss.getSheets().length > 1) ss.deleteSheet(tmp);
  return ss;
}

/**
 * tenant_id → spreadsheet_id resolver. `host` returns the hard-coded
 * SHEET_ID constant from Code.gs so the legacy code path keeps working
 * without changes. Other tenants are looked up in the control Sheet.
 * Returns null when the tenant doesn't exist.
 */
function _resolveTenantSheetId(tenantId) {
  if (!tenantId) return null;
  if (tenantId === 'host') return SHEET_ID;
  var ctrl = _ensureControlSheet();
  var sh = ctrl.getSheetByName(CONTROL_TAB.Tenants);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iId = hdr.indexOf('tenant_id');
  var iSid = hdr.indexOf('spreadsheet_id');
  var iStatus = hdr.indexOf('status');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iId]) === tenantId) {
      if (String(data[i][iStatus]) === 'suspended') return null;
      return String(data[i][iSid]);
    }
  }
  return null;
}

function _logSys(event, actorUserId, tenantId, payloadObj) {
  try {
    var ctrl = _ensureControlSheet();
    var sh = ctrl.getSheetByName(CONTROL_TAB.Sys_Log);
    sh.appendRow([
      new Date().toISOString(),
      event,
      actorUserId || '',
      tenantId || '',
      payloadObj ? JSON.stringify(payloadObj) : ''
    ]);
  } catch (_) { /* non-fatal */ }
}

// ============================================================================
// HELPERS — control-Sheet queries
// ============================================================================

function _readTenantsTable() {
  var ctrl = _ensureControlSheet();
  var sh = ctrl.getSheetByName(CONTROL_TAB.Tenants);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) out.push(_rowToObj(hdr, data[i]));
  return out;
}

function _readTenantOwnersTable() {
  var ctrl = _ensureControlSheet();
  var sh = ctrl.getSheetByName(CONTROL_TAB.Tenant_Owners);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) out.push(_rowToObj(hdr, data[i]));
  return out;
}

function _ownersForTenant(tenantId) {
  return _readTenantOwnersTable().filter(function (o) { return o.tenant_id === tenantId; });
}

function _tenantsForUser(userId, userEmail) {
  var rows = _readTenantOwnersTable();
  var idLc = String(userId || '').toLowerCase();
  var emLc = String(userEmail || '').toLowerCase();
  return rows.filter(function (o) {
    return (idLc && String(o.user_id).toLowerCase() === idLc) ||
           (emLc && String(o.user_email).toLowerCase() === emLc);
  });
}

function _isHostOwner(session) {
  // Host-owner role is the only account that can see every tenant + provision
  // new ones. Encoded as: session.tid === 'host' AND role === 'role_owner'.
  return session && session.payload &&
         session.payload.tid === 'host' &&
         session.payload.role === 'role_owner';
}

function _isValidSlug(s) {
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(String(s || ''));
}

// ============================================================================
// READS — list_tenants / get_tenant / list_tenant_owners
// ============================================================================

function apiListTenants(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);

  _ensureControlSheet();
  var all = _readTenantsTable();
  var hostOwner = _isHostOwner(s);

  // Always surface the host tenant — it isn't in the control Sheet's Tenants
  // table (it predates the control Sheet) but every host_owner should see it.
  var visible;
  if (hostOwner) {
    visible = all.slice();
    if (!visible.some(function (t) { return t.tenant_id === 'host'; })) {
      visible.unshift({
        tenant_id: 'host',
        spreadsheet_id: SHEET_ID,
        legal_name: '1891 Interpreter (host)',
        tier: 'deaf-owned-free',
        status: 'active',
        created_at: '',
        created_by: 'system',
        notes: 'Legacy host tenant — not in control Sheet'
      });
    }
  } else {
    // Non-host: only tenants this user owns.
    var ownedIds = _tenantsForUser(s.payload.uid, s.payload.email).map(function (o) { return o.tenant_id; });
    visible = all.filter(function (t) { return ownedIds.indexOf(t.tenant_id) >= 0; });
  }

  // Mask spreadsheet_id for non-host-owners.
  var out = visible.map(function (t) {
    var row = {
      tenant_id: t.tenant_id,
      legal_name: t.legal_name,
      tier: t.tier,
      status: t.status,
      created_at: t.created_at
    };
    if (hostOwner) row.spreadsheet_id = t.spreadsheet_id;
    return row;
  });

  return _json({ ok:true, tenants: out });
}

function apiGetTenant(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);

  var tenantId = String(e.parameter.id || '');
  if (!tenantId) return _json({ ok:false, error:'id required' });

  var hostOwner = _isHostOwner(s);
  if (!hostOwner) {
    // Caller must be in Tenant_Owners for this tenant.
    var mine = _tenantsForUser(s.payload.uid, s.payload.email);
    if (!mine.some(function (o) { return o.tenant_id === tenantId; })) {
      return _json({ ok:false, error:'Not authorized for this tenant.' }, 403);
    }
  }

  var tenant;
  if (tenantId === 'host') {
    tenant = {
      tenant_id: 'host',
      spreadsheet_id: SHEET_ID,
      legal_name: '1891 Interpreter (host)',
      tier: 'deaf-owned-free',
      status: 'active',
      created_at: '',
      created_by: 'system',
      notes: ''
    };
  } else {
    var match = _readTenantsTable().filter(function (t) { return t.tenant_id === tenantId; })[0];
    if (!match) return _json({ ok:false, error:'Tenant not found' }, 404);
    tenant = match;
  }

  // Counts. Open the tenant's Sheet and tally row counts on the heavy tabs.
  var counts = { users: 0, jobs: 0, interpreters: 0 };
  try {
    var sid = _resolveTenantSheetId(tenantId);
    if (sid) {
      var ts = SpreadsheetApp.openById(sid);
      counts.users         = _countRows(ts, T.Users);
      counts.jobs          = _countRows(ts, T.Jobs);
      counts.interpreters  = _countRows(ts, T.Interpreters);
    }
  } catch (_) { /* tenant sheet unreachable — leave zeros */ }

  // Hide spreadsheet_id from non-host owners.
  var safe = {
    tenant_id: tenant.tenant_id,
    legal_name: tenant.legal_name,
    tier: tenant.tier,
    status: tenant.status,
    created_at: tenant.created_at,
    created_by: tenant.created_by,
    notes: tenant.notes
  };
  if (hostOwner) safe.spreadsheet_id = tenant.spreadsheet_id;

  return _json({ ok:true, tenant: safe, counts: counts });
}

function _countRows(ss, tabName) {
  var sh = ss.getSheetByName(tabName);
  if (!sh) return 0;
  var n = sh.getLastRow();
  return n > 0 ? n - 1 : 0;  // minus header row
}

function apiListTenantOwners(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);

  var tenantId = String(e.parameter.tenant_id || '');
  if (!tenantId) return _json({ ok:false, error:'tenant_id required' });

  var hostOwner = _isHostOwner(s);
  if (!hostOwner) {
    var mine = _tenantsForUser(s.payload.uid, s.payload.email);
    if (!mine.some(function (o) { return o.tenant_id === tenantId && o.role === 'owner'; })) {
      return _json({ ok:false, error:'Owner role required.' }, 403);
    }
  }

  var owners = _ownersForTenant(tenantId).map(function (o) {
    return {
      tenant_id: o.tenant_id,
      user_email: o.user_email,
      role: o.role,
      added_at: o.added_at
    };
  });
  return _json({ ok:true, owners: owners });
}

// ============================================================================
// WRITES — provision_tenant / switch_tenant / add_tenant_owner
// ============================================================================

function apiProvisionTenant(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (!_isHostOwner(s)) return _json({ ok:false, error:'Host owner only.' }, 403);

  var p = e.parameter || {};
  var tenantId   = String(p.tenant_id || '').trim().toLowerCase();
  var legalName  = String(p.legal_name || '').trim();
  var ownerEmail = String(p.owner_email || '').trim().toLowerCase();
  var tier       = String(p.tier || 'pro').trim();
  var phiMode    = String(p.phi_mode || 'initials-only').trim();
  var timezone   = String(p.timezone || 'America/New_York').trim();

  if (!_isValidSlug(tenantId)) {
    return _json({ ok:false, error:'tenant_id must be a lowercase slug (3–40 chars, a–z 0–9 -)' });
  }
  if (tenantId === 'host') {
    return _json({ ok:false, error:'tenant_id "host" is reserved.' });
  }
  if (!legalName) return _json({ ok:false, error:'legal_name required' });
  if (!_isValidEmail(ownerEmail)) return _json({ ok:false, error:'owner_email is not a valid address' });
  if (['deaf-owned-free','pro','enterprise'].indexOf(tier) < 0) {
    return _json({ ok:false, error:'tier must be deaf-owned-free | pro | enterprise' });
  }
  if (['full','initials-only','disabled'].indexOf(phiMode) < 0) {
    return _json({ ok:false, error:'phi_mode must be full | initials-only | disabled' });
  }

  _ensureControlSheet();

  // Uniqueness check.
  var existing = _readTenantsTable().filter(function (t) { return t.tenant_id === tenantId; });
  if (existing.length) return _json({ ok:false, error:'tenant_id is already taken.' });

  // 1. Create the per-agency Sheet.
  var sheetTitle = '1891-interpreter-' + tenantId;
  var tenantSs = SpreadsheetApp.create(sheetTitle);
  var sid = tenantSs.getId();

  // 2. Stamp the canonical 21-tab schema and seed roles + reference data.
  _bootstrapTenantOn(tenantSs, tenantId, {
    legal_name: legalName,
    tier: tier,
    phi_mode: phiMode,
    timezone: timezone,
    primary_owner_email: ownerEmail,
    brand_color: '#C8553D',
    billing_email: ownerEmail
  });

  // 3. Record in control Sheet's Tenants table.
  var nowIso = new Date().toISOString();
  var ctrl = _ensureControlSheet();
  ctrl.getSheetByName(CONTROL_TAB.Tenants).appendRow([
    tenantId, sid, legalName, tier, 'active', nowIso, s.payload.uid, ''
  ]);

  // 4. Add the owner row to Tenant_Owners (resolve user_id by re-reading
  // the new tenant Sheet's Users tab where _bootstrapTenantOn just wrote
  // the owner row).
  var newOwner = _lookupUserByEmail(tenantSs, ownerEmail);
  var ownerUid = newOwner ? newOwner.user_id : '';
  ctrl.getSheetByName(CONTROL_TAB.Tenant_Owners).appendRow([
    tenantId, ownerUid, ownerEmail, 'owner', nowIso, s.payload.uid
  ]);

  // 5. Sys_Log + Audit_Log.
  _logSys('tenant.provision', s.payload.uid, tenantId, {
    legal_name: legalName, tier: tier, phi_mode: phiMode, spreadsheet_id: sid
  });
  _logAudit('tenant.provision', tenantId, s.payload.uid, 'sid=' + sid);

  // 6. Welcome email (best-effort).
  var signInUrl = SITE_BASE + '/sign-in.html?email=' + encodeURIComponent(ownerEmail);
  var body =
    'Welcome to 1891 Interpreter.\n\n' +
    'Your agency tenant is provisioned:\n\n' +
    '  Agency:    ' + legalName + '\n' +
    '  Tenant:    ' + tenantId + '\n' +
    '  Tier:      ' + tier + '\n' +
    '  Time zone: ' + timezone + '\n\n' +
    'Sign in to get started — we will email you a one-time link:\n' +
    signInUrl + '\n\n' +
    'Built in Frederick. Carried forward since 1891.\n' +
    '— 1891 Interpreter';
  try {
    MailApp.sendEmail({
      to: ownerEmail,
      subject: 'Your 1891 Interpreter agency is ready',
      body: body
    });
  } catch (err) {
    _logAudit('tenant.welcome_email_failed', tenantId, s.payload.uid, String(err));
  }

  return _json({
    ok: true,
    tenant: {
      tenant_id: tenantId,
      spreadsheet_id: sid,
      legal_name: legalName,
      tier: tier,
      status: 'active',
      created_at: nowIso
    },
    spreadsheet_url: tenantSs.getUrl()
  });
}

function apiSwitchTenant(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var tenantId = String(e.parameter.tenant_id || '').trim().toLowerCase();
  if (!tenantId) return _json({ ok:false, error:'tenant_id required' });

  var hostOwner = _isHostOwner(s);
  var allowed = hostOwner;
  if (!allowed) {
    var mine = _tenantsForUser(s.payload.uid, s.payload.email);
    allowed = mine.some(function (o) { return o.tenant_id === tenantId; });
  }
  if (!allowed) return _json({ ok:false, error:'Not authorized for this tenant.' }, 403);

  // Mint a new session JWT scoped to the requested tenant.
  // Role stays the caller's role; for host-owner switching into a foreign
  // tenant we keep role_owner so they can act as the owner of that tenant.
  var newSession = _mintSession({
    uid: s.payload.uid,
    tid: tenantId,
    role: s.payload.role,
    email: s.payload.email
  });
  _logSys('tenant.switch', s.payload.uid, tenantId, { from: s.payload.tid });
  _logAudit('tenant.switch', tenantId, s.payload.uid, 'from=' + s.payload.tid);

  return _json({ ok:true, session: newSession, tenant_id: tenantId });
}

function apiAddTenantOwner(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  var tenantId  = String(p.tenant_id || '').trim().toLowerCase();
  var userEmail = String(p.user_email || '').trim().toLowerCase();
  var role      = String(p.role || 'owner').trim();
  if (!tenantId) return _json({ ok:false, error:'tenant_id required' });
  if (!_isValidEmail(userEmail)) return _json({ ok:false, error:'user_email is not a valid address' });
  if (['owner','admin'].indexOf(role) < 0) return _json({ ok:false, error:'role must be owner | admin' });

  var hostOwner = _isHostOwner(s);
  if (!hostOwner) {
    var mine = _tenantsForUser(s.payload.uid, s.payload.email);
    if (!mine.some(function (o) { return o.tenant_id === tenantId && o.role === 'owner'; })) {
      return _json({ ok:false, error:'Owner role required.' }, 403);
    }
  }

  // Resolve the user_id in the tenant's own Sheet (Users tab). If they don't
  // have a Users row yet, we still write the Tenant_Owners row with email
  // only — they'll get their user_id stamped on first sign-in.
  var sid = _resolveTenantSheetId(tenantId);
  var userId = '';
  if (sid) {
    try {
      var ts = SpreadsheetApp.openById(sid);
      var u = _lookupUserByEmail(ts, userEmail);
      if (u) userId = u.user_id;
    } catch (_) { /* leave userId blank */ }
  }

  // Block duplicates.
  var existing = _ownersForTenant(tenantId).filter(function (o) {
    return String(o.user_email).toLowerCase() === userEmail;
  });
  if (existing.length) return _json({ ok:false, error:'That email is already an owner/admin for this tenant.' });

  var ctrl = _ensureControlSheet();
  ctrl.getSheetByName(CONTROL_TAB.Tenant_Owners).appendRow([
    tenantId, userId, userEmail, role, new Date().toISOString(), s.payload.uid
  ]);
  _logSys('tenant.add_owner', s.payload.uid, tenantId, { user_email: userEmail, role: role });
  _logAudit('tenant.add_owner', tenantId, s.payload.uid, userEmail + ' role=' + role);

  return _json({ ok:true, tenant_id: tenantId, user_email: userEmail, role: role });
}

// ============================================================================
// BOOTSTRAP — schema + seed for a freshly created tenant Sheet
// ============================================================================

/**
 * Parameterized version of bootstrapHostTenant(). Stamps the canonical
 * 21-tab schema onto the supplied Spreadsheet, seeds Roles + Languages +
 * Certifications, writes the Agencies row, and creates the owner User row.
 *
 * agencyConfig = {
 *   legal_name, tier, phi_mode, timezone, primary_owner_email,
 *   brand_color, billing_email
 * }
 */
function _bootstrapTenantOn(ss, tenantId, agencyConfig) {
  var schema = _tenantSchema();
  var report = { created: [], existed: [] };

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

  // Drop the default Sheet1 if it's still hanging around.
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) {
    try { ss.deleteSheet(def); } catch (_) {}
  }

  // Roles + Languages + Certifications — same seeds the host got.
  _seedRoles(ss);
  _seedLanguagesFor(ss);
  _seedCertificationsFor(ss);
  _seedSettingsFor(ss);

  // Write the single Agencies row for this tenant.
  var agencies = ss.getSheetByName(T.Agencies);
  if (agencies.getLastRow() < 2) {
    var nowIso = new Date().toISOString();
    agencies.appendRow([
      tenantId,
      agencyConfig.legal_name,
      '',                              // tax_id_last4
      agencyConfig.tier,
      agencyConfig.phi_mode,
      agencyConfig.timezone,
      '',                              // primary_owner_user_id — filled below
      '',                              // logo_r2_key
      agencyConfig.brand_color,
      agencyConfig.billing_email,
      nowIso,
      nowIso
    ]);
  }

  // Create owner User row.
  var ownerEmail = String(agencyConfig.primary_owner_email || '').toLowerCase();
  var existing = _lookupUserByEmail(ss, ownerEmail);
  var ownerUid;
  if (existing) {
    ownerUid = existing.user_id;
  } else {
    ownerUid = _ulid('u');
    var nowIso2 = new Date().toISOString();
    ss.getSheetByName(T.Users).appendRow([
      ownerUid,
      tenantId,
      ownerEmail,
      '',                                       // phone
      ownerEmail.split('@')[0],                 // display_name (placeholder; owner edits)
      'role_owner',
      '',                                       // interpreter_id
      'active',
      false,                                    // mfa_enabled
      '[]',                                     // webauthn
      '',                                       // last_login_at
      JSON.stringify({ consumer: 'masked' }),   // pii_scope
      0,
      '',                                       // sso_subject
      nowIso2,
      nowIso2
    ]);
  }

  // Stamp the Agencies row with primary_owner_user_id.
  var aData = agencies.getDataRange().getValues();
  var aHdr = aData[0];
  var iTid = aHdr.indexOf('tenant_id');
  var iOwner = aHdr.indexOf('primary_owner_user_id');
  for (var r = 1; r < aData.length; r++) {
    if (String(aData[r][iTid]) === tenantId) {
      agencies.getRange(r + 1, iOwner + 1).setValue(ownerUid);
      break;
    }
  }

  return report;
}

function _seedLanguagesFor(ss) {
  var sh = ss.getSheetByName(T.Languages);
  if (!sh || sh.getLastRow() >= 2) return;
  var langs = [
    ['ASL','American Sign Language','signed','["bi","voice-only","sign-only"]','["Black ASL","PSE","Contact"]','Sgnw',false],
    ['PSE','Pidgin Signed English','signed','["bi"]','[]','Sgnw',false],
    ['en-US','English (US)','spoken','["bi","voice-only"]','[]','Latn',false],
    ['es-419','Spanish (Latin American)','spoken','["bi","voice-only"]','["es-MX","es-PR","es-DR","es-CL"]','Latn',false],
    ['cmn-CN','Mandarin (Simplified)','spoken','["bi","voice-only"]','[]','Hans',false],
    ['ar-MSA','Arabic (Modern Standard)','spoken','["bi","voice-only"]','["ar-EG","ar-LV","ar-MR"]','Arab',true],
    ['ht','Haitian Creole','spoken','["bi"]','[]','Latn',false],
    ['vi','Vietnamese','spoken','["bi"]','[]','Latn',false],
    ['ko','Korean','spoken','["bi"]','[]','Kore',false],
    ['ru','Russian','spoken','["bi"]','[]','Cyrl',false],
    ['fr','French','spoken','["bi"]','["fr-CA","fr-HT"]','Latn',false],
    ['so','Somali','spoken','["bi"]','[]','Latn',false],
    ['am','Amharic','spoken','["bi"]','[]','Ethi',false],
    ['fa','Farsi (Persian)','spoken','["bi"]','["fa-AF (Dari)"]','Arab',true],
    ['pt-BR','Portuguese (Brazil)','spoken','["bi"]','[]','Latn',false],
    ['ProTactile','ProTactile ASL','signed','["bi"]','[]','Sgnw',false],
    ['CDI','Certified Deaf Interpreter (relay role)','signed','["bi"]','[]','Sgnw',false]
  ];
  var ts = new Date().toISOString();
  langs.forEach(function (l) { sh.appendRow(l.concat([ts, ts])); });
}

function _seedCertificationsFor(ss) {
  var sh = ss.getSheetByName(T.Certifications);
  if (!sh || sh.getLastRow() >= 2) return;
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
    ['ATA','ATA','American Translators Association certified','["*"]',true,true],
    ['FCICE','FCICE','Federal Court Interpreter Certification','["*"]',true,true],
    ['CRC-NCRA','NCRA','Certified Realtime Captioner','["en-US"]',true,true]
  ];
  var ts = new Date().toISOString();
  certs.forEach(function (c) { sh.appendRow(c.concat([ts, ts])); });
}

function _seedSettingsFor(ss) {
  var sh = ss.getSheetByName(T.Settings);
  if (!sh || sh.getLastRow() >= 2) return;
  var ts = new Date().toISOString();
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
    sh.appendRow([d[0], d[1], d[2], '', ts, ts, ts]);
  });
}
