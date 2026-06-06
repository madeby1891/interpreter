// ============================================================================
// Code_Clients.gs — Client hierarchy + per-client billing rules
// v18 — May 2026
//
// A Client is the parent entity (e.g. "Frederick Health" or "Montgomery County
// Public Schools"). Under it live Requestors (departments / individual schedulers),
// Locations (physical sites), Specialists (the doctor / specialist a job is "for"),
// and Client_Contacts (people on the client side — owner, billing, scheduler).
//
// One Client = one billing office. Multiple Requestors at one Client roll up to
// a single Invoice cycle by default; per-Client billing rules let an agency
// override consolidation, PO format, GL templates, etc.
// ============================================================================

function apiListClients(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Clients, _tenantSchema().Clients);
  var sheet = ss.getSheetByName(T.Clients);
  var data = _dbValues_(ss, sheet, T.Clients);
  if (data.length < 2) return _json({ ok:true, clients: [] });
  var hdr = data[0];
  var clients = [];
  for (var i = 1; i < data.length; i++) {
    var obj = _rowToObj(hdr, data[i]);
    if (obj.tenant_id !== s.payload.tid) continue;
    if (e.parameter && e.parameter.status && obj.status !== e.parameter.status) continue;
    clients.push(obj);
  }
  clients.sort(function (a, b) { return String(a.display_name || a.legal_name).localeCompare(String(b.display_name || b.legal_name)); });
  return _json({ ok:true, clients: clients });
}

function apiGetClient(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var clientId = e.parameter.id;
  if (!clientId) return _json({ ok:false, error:'id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Clients, _tenantSchema().Clients);
  _ensureTab(ss, T.ClientContacts, _tenantSchema().Client_Contacts);
  _ensureTab(ss, T.Specialists, _tenantSchema().Specialists);
  _ensureTab(ss, T.ClientBillingRules, _tenantSchema().Client_Billing_Rules);
  _ensureTab(ss, T.Requestors, _tenantSchema().Requestors);
  _ensureTab(ss, T.Locations, _tenantSchema().Locations);

  var client = _findRowById_(ss, T.Clients, 'client_id', clientId, s.payload.tid);
  if (!client) return _json({ ok:false, error:'Client not found' }, 404);

  var contacts = _filterRows_(ss, T.ClientContacts, function (r) {
    return r.client_id === clientId && r.tenant_id === s.payload.tid;
  });
  var specialists = _filterRows_(ss, T.Specialists, function (r) {
    return r.client_id === clientId && r.tenant_id === s.payload.tid;
  });
  var requestors = _filterRows_(ss, T.Requestors, function (r) {
    return r.client_id === clientId && r.tenant_id === s.payload.tid;
  });
  // Locations belong to a Requestor, which belongs to a Client. Walk through
  // requestors to get all the client's locations.
  var requestorIds = {};
  requestors.forEach(function (r) { requestorIds[r.requestor_id] = true; });
  var locations = _filterRows_(ss, T.Locations, function (r) {
    return requestorIds[r.requestor_id] && r.tenant_id === s.payload.tid;
  });
  var billingRules = _filterRows_(ss, T.ClientBillingRules, function (r) {
    return r.client_id === clientId && r.tenant_id === s.payload.tid && r.status === 'active';
  });

  return _json({
    ok: true,
    client: client,
    contacts: contacts,
    specialists: specialists,
    requestors: requestors,
    locations: locations,
    billing_rules: billingRules[0] || _defaultBillingRules_(clientId, s.payload.tid)
  });
}

function apiCreateClient(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = _params(e);
  if (!p.legal_name) return _json({ ok:false, error:'legal_name required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Clients, _tenantSchema().Clients);
  var sheet = ss.getSheetByName(T.Clients);
  var clientId = _ulid('cl');
  var now = new Date().toISOString();

  var row = _objToRow_(_tenantSchema().Clients, {
    client_id: clientId,
    tenant_id: s.payload.tid,
    legal_name: p.legal_name,
    display_name: p.display_name || p.legal_name,
    client_type: p.client_type || 'business',
    industry: p.industry || '',
    primary_owner_contact_id: p.primary_owner_contact_id || '',
    primary_payer_id: p.primary_payer_id || '',
    billing_address: p.billing_address || '',
    billing_email: p.billing_email || '',
    billing_phone: p.billing_phone || '',
    tax_exempt: p.tax_exempt === 'true' || p.tax_exempt === true,
    tax_id_last4: p.tax_id_last4 || '',
    net_terms: p.net_terms || 'NET30',
    contract_doc_id: p.contract_doc_id || '',
    notes: p.notes || '',
    status: 'active',
    _created_at: now,
    _updated_at: now,
    _rev: 1
  });
  sheet.appendRow(row);

  // Seed default billing rules
  _writeBillingRules_(ss, _defaultBillingRules_(clientId, s.payload.tid));

  _logAudit('client.create', s.payload.tid, s.payload.uid, clientId);
  return _json({ ok:true, client_id: clientId });
}

function apiUpdateClient(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = _params(e);
  if (!p.client_id) return _json({ ok:false, error:'client_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Clients, _tenantSchema().Clients);
  var ok = _updateRowById_(ss, T.Clients, 'client_id', p.client_id, s.payload.tid, function (existing) {
    var keep = ['legal_name','display_name','client_type','industry','primary_owner_contact_id','primary_payer_id','billing_address','billing_email','billing_phone','tax_exempt','tax_id_last4','net_terms','contract_doc_id','notes','status'];
    keep.forEach(function (k) {
      if (p[k] !== undefined && p[k] !== null && p[k] !== '') {
        existing[k] = (k === 'tax_exempt') ? (p[k] === 'true' || p[k] === true) : p[k];
      }
    });
    existing._updated_at = new Date().toISOString();
    existing._rev = (Number(existing._rev) || 0) + 1;
    return existing;
  });
  if (!ok) return _json({ ok:false, error:'Client not found' }, 404);
  _logAudit('client.update', s.payload.tid, s.payload.uid, p.client_id);
  return _json({ ok:true });
}

function apiUpsertClientContact(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = _params(e);
  if (!p.client_id) return _json({ ok:false, error:'client_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.ClientContacts, _tenantSchema().Client_Contacts);
  var sheet = ss.getSheetByName(T.ClientContacts);
  var now = new Date().toISOString();

  if (p.contact_id) {
    var ok = _updateRowById_(ss, T.ClientContacts, 'contact_id', p.contact_id, s.payload.tid, function (existing) {
      ['role_on_client','first','last','email','phone_e164','title','department','preferred_channel','status','user_id'].forEach(function (k) {
        if (p[k] !== undefined && p[k] !== null && p[k] !== '') existing[k] = p[k];
      });
      existing._updated_at = now;
      return existing;
    });
    if (!ok) return _json({ ok:false, error:'Contact not found' }, 404);
    return _json({ ok:true, contact_id: p.contact_id });
  }

  var contactId = _ulid('cc');
  var row = _objToRow_(_tenantSchema().Client_Contacts, {
    contact_id: contactId,
    client_id: p.client_id,
    tenant_id: s.payload.tid,
    user_id: p.user_id || '',
    role_on_client: p.role_on_client || 'scheduler',  // scheduler, billing, owner, signatory
    first: p.first || '',
    last: p.last || '',
    email: p.email || '',
    phone_e164: p.phone_e164 || '',
    title: p.title || '',
    department: p.department || '',
    preferred_channel: p.preferred_channel || 'email',
    status: 'active',
    _created_at: now,
    _updated_at: now
  });
  sheet.appendRow(row);
  return _json({ ok:true, contact_id: contactId });
}

function apiUpsertSpecialist(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = _params(e);
  if (!p.client_id || !p.display_name) return _json({ ok:false, error:'client_id + display_name required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Specialists, _tenantSchema().Specialists);
  var sheet = ss.getSheetByName(T.Specialists);
  var now = new Date().toISOString();

  if (p.specialist_id) {
    var ok = _updateRowById_(ss, T.Specialists, 'specialist_id', p.specialist_id, s.payload.tid, function (existing) {
      ['display_name','department','specialty_code','npi','default_location_id','default_modality_pref','notes','status'].forEach(function (k) {
        if (p[k] !== undefined && p[k] !== null && p[k] !== '') existing[k] = p[k];
      });
      existing._updated_at = now;
      return existing;
    });
    if (!ok) return _json({ ok:false, error:'Specialist not found' }, 404);
    return _json({ ok:true, specialist_id: p.specialist_id });
  }

  var specialistId = _ulid('sp');
  var row = _objToRow_(_tenantSchema().Specialists, {
    specialist_id: specialistId,
    client_id: p.client_id,
    tenant_id: s.payload.tid,
    display_name: p.display_name,
    department: p.department || '',
    specialty_code: p.specialty_code || '',
    npi: p.npi || '',
    default_location_id: p.default_location_id || '',
    default_modality_pref: p.default_modality_pref || '',
    notes: p.notes || '',
    status: 'active',
    _created_at: now,
    _updated_at: now
  });
  sheet.appendRow(row);
  return _json({ ok:true, specialist_id: specialistId });
}

function apiUpdateClientBillingRules(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = _params(e);
  if (!p.client_id) return _json({ ok:false, error:'client_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.ClientBillingRules, _tenantSchema().Client_Billing_Rules);
  var existing = _filterRows_(ss, T.ClientBillingRules, function (r) {
    return r.client_id === p.client_id && r.tenant_id === s.payload.tid && r.status === 'active';
  })[0];
  var now = new Date().toISOString();

  if (existing) {
    _updateRowById_(ss, T.ClientBillingRules, 'rule_id', existing.rule_id, s.payload.tid, function (row) {
      var fields = ['consolidation_mode','billing_cycle','statement_day_of_month','requires_po','po_format_regex','gl_template','invoice_format','split_by_location','split_by_specialist','show_consumer_initials_on_invoice','show_specialist_on_invoice','show_interpreter_name_on_invoice','rounding_minutes','minimum_invoice_cents','late_fee_pct','notes'];
      fields.forEach(function (k) {
        if (p[k] !== undefined && p[k] !== null && p[k] !== '') {
          // booleans
          if (['requires_po','split_by_location','split_by_specialist','show_consumer_initials_on_invoice','show_specialist_on_invoice','show_interpreter_name_on_invoice'].indexOf(k) >= 0) {
            row[k] = (p[k] === 'true' || p[k] === true);
          } else {
            row[k] = p[k];
          }
        }
      });
      row._updated_at = now;
      return row;
    });
    return _json({ ok:true, rule_id: existing.rule_id });
  }

  // Create fresh
  var defaults = _defaultBillingRules_(p.client_id, s.payload.tid);
  Object.keys(defaults).forEach(function (k) {
    if (p[k] !== undefined && p[k] !== null && p[k] !== '') {
      if (typeof defaults[k] === 'boolean') {
        defaults[k] = (p[k] === 'true' || p[k] === true);
      } else {
        defaults[k] = p[k];
      }
    }
  });
  _writeBillingRules_(ss, defaults);
  return _json({ ok:true, rule_id: defaults.rule_id });
}

function _defaultBillingRules_(clientId, tenantId) {
  var now = new Date().toISOString();
  return {
    rule_id: _ulid('br'),
    client_id: clientId,
    tenant_id: tenantId,
    // consolidation_mode: how jobs roll up to invoices
    //   one_per_client    — all jobs across all requestors → 1 invoice per period (the Frederick Health default)
    //   one_per_requestor — each requestor (department) gets its own invoice
    //   one_per_location  — each location gets its own invoice
    //   one_per_job       — itemized per-job invoices (small clients, on-demand)
    //   one_per_specialist— each specialist gets its own invoice (private practice rollups)
    consolidation_mode: 'one_per_client',
    billing_cycle: 'monthly', // weekly, biweekly, monthly, on_demand
    statement_day_of_month: 1,
    requires_po: false,
    po_format_regex: '',
    gl_template: '',           // GL code prepended to every line ("4200-INTERP")
    invoice_format: 'standard', // standard, hipaa_safe (initials only), detailed (full PII — must be opted in)
    split_by_location: true,    // group lines by location on the same invoice
    split_by_specialist: false,
    show_consumer_initials_on_invoice: true,
    show_specialist_on_invoice: true,
    show_interpreter_name_on_invoice: true,
    rounding_minutes: 15,
    minimum_invoice_cents: 0,
    late_fee_pct: 0,
    notes: '',
    status: 'active',
    _created_at: now,
    _updated_at: now
  };
}

function _writeBillingRules_(ss, rules) {
  _ensureTab(ss, T.ClientBillingRules, _tenantSchema().Client_Billing_Rules);
  var sheet = ss.getSheetByName(T.ClientBillingRules);
  sheet.appendRow(_objToRow_(_tenantSchema().Client_Billing_Rules, rules));
}

// ============================================================================
// Generic row helpers used by Code_Clients.gs (declared local-safe)
// ============================================================================
function _findRowById_(ss, tabName, idCol, idVal, tenantId) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var obj = _rowToObj(hdr, data[i]);
    if (obj[idCol] === idVal && (!tenantId || obj.tenant_id === tenantId)) return obj;
  }
  return null;
}

function _filterRows_(ss, tabName, predicate) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var obj = _rowToObj(hdr, data[i]);
    if (predicate(obj)) out.push(obj);
  }
  return out;
}

function _updateRowById_(ss, tabName, idCol, idVal, tenantId, mutator) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return false;
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return false;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var obj = _rowToObj(hdr, data[i]);
    if (obj[idCol] === idVal && (!tenantId || obj.tenant_id === tenantId)) {
      var updated = mutator(obj);
      var row = _objToRow_(hdr, updated);
      sheet.getRange(i + 1, 1, 1, hdr.length).setValues([row]);
      return true;
    }
  }
  return false;
}

function _objToRow_(hdr, obj) {
  var arr = [];
  for (var i = 0; i < hdr.length; i++) {
    var v = obj[hdr[i]];
    arr.push(v === undefined || v === null ? '' : v);
  }
  return arr;
}

// Param picker that works for both GET and POST callers
function _params(e) {
  if (e && e.parameter) {
    // For POST, postData.contents may carry JSON — merge in
    if (e.postData && e.postData.type === 'application/json') {
      try {
        var body = JSON.parse(e.postData.contents);
        var merged = {};
        Object.keys(e.parameter).forEach(function (k) { merged[k] = e.parameter[k]; });
        Object.keys(body).forEach(function (k) { merged[k] = body[k]; });
        return merged;
      } catch (err) { /* fall through */ }
    }
    return e.parameter;
  }
  return {};
}
