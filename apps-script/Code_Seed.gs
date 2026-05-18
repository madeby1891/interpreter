/**
 * 1891 Interpreter — host-tenant demo seeder.
 *
 * One-shot endpoint to populate the host tenant with realistic-but-clearly-
 * synthetic data so the app has something to demo. Gated by knowledge of
 * the Sheet ID. Idempotent — each helper checks before inserting.
 *
 * All seed data is marked with `notes_internal` containing "[SEED]" so we
 * can clean up later via a counterpart wipe function.
 *
 * Names are synthetic: drawn from a list of clearly-not-real placeholder
 * personas. Place names use semi-fictional Maryland-flavored organizations
 * (Catoctin Regional, Liberty Hill CC, etc.) to evoke the Frederick context
 * without referencing real organizations.
 */

// ============================================================================
// PUBLIC ENTRYPOINTS
// ============================================================================

function apiSeedHostData(e) {
  var setup = e.parameter.setup;
  if (setup !== SHEET_ID) return _json({ ok:false, error:'Forbidden' }, 403);
  var report = seedHostTenant();
  return _json({ ok:true, report:report });
}

function apiWipeSeed(e) {
  // Removes only rows tagged [SEED]. Leaves user-created data intact.
  var setup = e.parameter.setup;
  if (setup !== SHEET_ID) return _json({ ok:false, error:'Forbidden' }, 403);
  var report = wipeSeed();
  return _json({ ok:true, report:report });
}

// ============================================================================
// SEEDER
// ============================================================================

function seedHostTenant() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var TID = 'host';
  var report = {};

  // Ensure schema is in place (no-op if bootstrapped already)
  try { bootstrapHostTenant(); } catch (_) {}

  report.interpreters = seedInterpreters_(ss, TID);
  report.requestors = seedRequestors_(ss, TID);
  report.requestor_contacts = seedRequestorContacts_(ss, TID, report.requestors);
  report.payers = seedPayers_(ss, TID);
  report.locations = seedLocations_(ss, TID, report.requestors);
  report.consumers = seedConsumers_(ss, TID);
  report.jobs = seedJobs_(ss, TID, {
    interpreters: report.interpreters,
    requestors: report.requestors,
    payers: report.payers,
    locations: report.locations,
    consumers: report.consumers,
    contacts: report.requestor_contacts
  });
  report.assignments = seedAssignments_(ss, TID, report.jobs, report.interpreters);
  report.invoices = seedInvoices_(ss, TID, report.payers, report.jobs);
  report.payouts = seedPayouts_(ss, TID, report.interpreters, report.assignments);

  _logAudit('seed.host_data', TID, 'system', JSON.stringify({
    interpreters: report.interpreters.length,
    jobs: report.jobs.length,
    invoices: report.invoices.length,
    payouts: report.payouts.length
  }));

  return {
    interpreters: report.interpreters.length,
    requestors: report.requestors.length,
    requestor_contacts: report.requestor_contacts.length,
    payers: report.payers.length,
    locations: report.locations.length,
    consumers: report.consumers.length,
    jobs: report.jobs.length,
    assignments: report.assignments.length,
    invoices: report.invoices.length,
    payouts: report.payouts.length
  };
}

// ----- INTERPRETERS --------------------------------------------------------

function seedInterpreters_(ss, tid) {
  var sh = _ensureTab(ss, T.Interpreters, _tenantSchema().Interpreters);
  var existing = _existingByCol_(sh, 'legal_first', 'legal_last');
  var out = [];
  var roster = [
    { first:'Maria',    last:'Rivera',    pronouns:'she/her',  deaf:false, cls:'1099', city:'Frederick',     state:'MD', zip:'21701', radius:60,
      langs:[{lang:'ASL',dir:'bi'},{lang:'en-US',dir:'voice'}],
      certs:[{cert:'NIC',number:'NIC-MR-2018',exp:'2028-04'},{cert:'CCHI-CHI',number:'C-MR-2020',exp:'2027-06'}],
      mods:['on-site','VRI'], skills:['medical','mental-health'] },
    { first:'Marcus',   last:'Thompson',  pronouns:'he/him',   deaf:true,  cls:'1099', city:'Frederick',     state:'MD', zip:'21703', radius:75,
      langs:[{lang:'ASL',dir:'bi'},{lang:'ProTactile',dir:'bi'}],
      certs:[{cert:'CDI',number:'CDI-MT-2017',exp:'2027-09'}],
      mods:['on-site','VRI'], skills:['CDI','medical','legal','community'] },
    { first:'Sarah',    last:'Chen',      pronouns:'she/her',  deaf:false, cls:'W2',   city:'Rockville',     state:'MD', zip:'20850', radius:50,
      langs:[{lang:'ASL',dir:'bi'},{lang:'cmn-CN',dir:'voice'},{lang:'en-US',dir:'voice'}],
      certs:[{cert:'NIC-Advanced',number:'NIC-A-SC-2020',exp:'2028-04'}],
      mods:['on-site','VRI','OPI'], skills:['medical','trilingual'] },
    { first:'David',    last:'Park',      pronouns:'he/him',   deaf:false, cls:'1099', city:'Gaithersburg',  state:'MD', zip:'20878', radius:40,
      langs:[{lang:'ko',dir:'bi'},{lang:'en-US',dir:'voice'}],
      certs:[{cert:'NBCMI',number:'NB-DP-2019',exp:'2027-12'}],
      mods:['on-site','VRI','OPI'], skills:['medical','legal'] },
    { first:'Patrice',  last:'Joseph',    pronouns:'she/her',  deaf:false, cls:'1099', city:'Silver Spring', state:'MD', zip:'20910', radius:45,
      langs:[{lang:'ht',dir:'bi'},{lang:'fr',dir:'voice'},{lang:'en-US',dir:'voice'}],
      certs:[{cert:'NBCMI',number:'NB-PJ-2021',exp:'2028-02'}],
      mods:['on-site','OPI'], skills:['medical','community'] },
    { first:'Ahmad',    last:'Hassan',    pronouns:'he/him',   deaf:false, cls:'1099', city:'Hagerstown',    state:'MD', zip:'21740', radius:60,
      langs:[{lang:'ar-MSA',dir:'bi'},{lang:'en-US',dir:'voice'}],
      certs:[{cert:'CCHI-CHI',number:'C-AH-2019',exp:'2026-10'}],
      mods:['on-site','OPI'], skills:['medical','community','legal'] },
    { first:'Wei',      last:'Liu',       pronouns:'they/them',deaf:false, cls:'1099', city:'Frederick',     state:'MD', zip:'21704', radius:35,
      langs:[{lang:'cmn-CN',dir:'bi'},{lang:'yue-HK',dir:'bi'},{lang:'en-US',dir:'voice'}],
      certs:[{cert:'CCHI-CHI',number:'C-WL-2022',exp:'2028-05'}],
      mods:['on-site','VRI','OPI'], skills:['medical'] },
    { first:'Elena',    last:'Vasquez',   pronouns:'she/her',  deaf:false, cls:'W2',   city:'Frederick',     state:'MD', zip:'21702', radius:30,
      langs:[{lang:'es-419',dir:'bi'},{lang:'en-US',dir:'voice'}],
      certs:[{cert:'CCHI-CHI',number:'C-EV-2018',exp:'2027-04'},{cert:'NBCMI',number:'NB-EV-2019',exp:'2027-08'},{cert:'CMI-Spanish',number:'CM-EV-2019',exp:'2027-08'}],
      mods:['on-site','VRI','OPI'], skills:['medical','mental-health','legal'] },
    { first:'Jordan',   last:'Hayes',     pronouns:'they/them',deaf:false, cls:'1099', city:'Baltimore',     state:'MD', zip:'21218', radius:80,
      langs:[{lang:'ASL',dir:'bi'},{lang:'en-US',dir:'voice'}],
      certs:[{cert:'NIC-Master',number:'NIC-M-JH-2019',exp:'2028-04'},{cert:'SC:L',number:'SCL-JH-2020',exp:'2027-11'}],
      mods:['on-site','VRI'], skills:['legal','medical'] },
    { first:'Riya',     last:'Patel',     pronouns:'she/her',  deaf:false, cls:'1099', city:'Frederick',     state:'MD', zip:'21701', radius:50,
      langs:[{lang:'ASL',dir:'bi'},{lang:'es-419',dir:'voice'},{lang:'en-US',dir:'voice'}],
      certs:[{cert:'EIPA-4.0',number:'EIPA-RP-2021',exp:'2026-08'}],
      mods:['on-site','VRI'], skills:['education','K-12','trilingual'] }
  ];
  var hdr = _tenantSchema().Interpreters;
  var now = new Date().toISOString();
  roster.forEach(function (p) {
    var key = (p.first + '|' + p.last).toLowerCase();
    if (existing[key]) { out.push({ interpreter_id: existing[key], ...p, _existed: true }); return; }
    var id = _ulid('i');
    var row = {
      interpreter_id: id, tenant_id: tid, user_id: '',
      classification: p.cls,
      legal_first: p.first, legal_last: p.last, pronouns: p.pronouns,
      home_city: p.city, home_state: p.state, home_zip: p.zip,
      service_radius_mi: p.radius, has_vehicle: true,
      modalities: JSON.stringify(p.mods),
      languages: JSON.stringify(p.langs),
      certifications: JSON.stringify(p.certs),
      skills: JSON.stringify(p.skills),
      rate_card_id: '', min_call_hours: 2,
      availability_prefs: JSON.stringify({ quiet_hours:['22:00','06:00'] }),
      availability_doc_id: '',
      payment_method: 'ach', payment_details_encrypted: '',
      w9_doc_id: '', coi_doc_id: '', background_check_at: '',
      deaf: p.deaf, notes_internal: '[SEED] Demo roster',
      status: 'active',
      _created_at: now, _updated_at: now, _rev: 1
    };
    sh.appendRow(hdr.map(function (c) { return row[c] !== undefined ? row[c] : ''; }));
    out.push({ interpreter_id: id, first: p.first, last: p.last, deaf: p.deaf, mods: p.mods, langs: p.langs });
  });
  return out;
}

// ----- REQUESTORS ---------------------------------------------------------

function seedRequestors_(ss, tid) {
  var sh = _ensureTab(ss, T.Requestors, _tenantSchema().Requestors);
  var existing = _existingByCol_(sh, 'display_name');
  var hdr = _tenantSchema().Requestors;
  var now = new Date().toISOString();
  var list = [
    { name:'Catoctin Regional Medical Center', type:'medical',       po_required:false, notes:'[SEED] Primary hospital partner. Net-30 standard.' },
    { name:'Lakeside Mental Health Group',     type:'mental-health', po_required:false, notes:'[SEED] Outpatient mental-health practice. Bills monthly consolidated.' },
    { name:'Frederick County Schools (demo)',  type:'education',     po_required:true,  notes:'[SEED] K-12 with strong ASL caseload. PO required on every invoice.' },
    { name:'Catoctin County Circuit Court',    type:'legal',         po_required:true,  notes:'[SEED] Court interpreting; requires SC:L credential for jury matters.' },
    { name:'Liberty Hill Community College',   type:'education',     po_required:false, notes:'[SEED] Higher ed; semester-based consolidated invoicing.' },
    { name:'Midstate Behavioral Health',       type:'mental-health', po_required:false, notes:'[SEED] Inpatient + outpatient psychiatric. Strict PHI scrubbing.' },
    { name:'Riverside Family Practice',        type:'medical',       po_required:false, notes:'[SEED] Small family practice; multilingual community.' }
  ];
  var out = [];
  list.forEach(function (r) {
    var k = r.name.toLowerCase();
    if (existing[k]) { out.push({ requestor_id: existing[k], display_name: r.name, type: r.type, _existed: true }); return; }
    var id = _ulid('r');
    var row = {
      requestor_id: id, tenant_id: tid, display_name: r.name, type: r.type,
      parent_org_id: '', billing_payer_id: '', default_location_id: '', contract_doc_id: '',
      po_required: r.po_required, notes: r.notes, status: 'active',
      _created_at: now, _updated_at: now, _rev: 1
    };
    sh.appendRow(hdr.map(function (c) { return row[c] !== undefined ? row[c] : ''; }));
    out.push({ requestor_id: id, display_name: r.name, type: r.type });
  });
  return out;
}

function seedRequestorContacts_(ss, tid, requestors) {
  var sh = _ensureTab(ss, T.RequestorContacts, _tenantSchema().Requestor_Contacts);
  var existing = _existingByCol_(sh, 'first', 'last');
  var hdr = _tenantSchema().Requestor_Contacts;
  var now = new Date().toISOString();
  // One contact per requestor — front-desk staff who book on behalf of the org.
  var contactsByOrg = {
    'Catoctin Regional Medical Center': { first:'Renee',   last:'Park',     title:'Patient Access Coordinator',  pref:'email' },
    'Lakeside Mental Health Group':     { first:'Tomas',   last:'Bell',     title:'Office Manager',              pref:'email' },
    'Frederick County Schools (demo)':  { first:'Yvette',  last:'Coleman',  title:'504 Coordinator',             pref:'email' },
    'Catoctin County Circuit Court':    { first:'Howard',  last:'Drake',    title:'Court Operations',            pref:'email' },
    'Liberty Hill Community College':   { first:'Indira',  last:'Singh',    title:'Disability Services',         pref:'email' },
    'Midstate Behavioral Health':       { first:'Casey',   last:'Fernandez',title:'Front Desk Lead',             pref:'email' },
    'Riverside Family Practice':        { first:'Brigette',last:'Owens',    title:'Practice Manager',            pref:'sms'   }
  };
  var out = [];
  requestors.forEach(function (r) {
    var c = contactsByOrg[r.display_name];
    if (!c) return;
    var k = (c.first + '|' + c.last).toLowerCase();
    if (existing[k]) { out.push({ contact_id: existing[k], requestor_id: r.requestor_id, _existed: true }); return; }
    var id = _ulid('c');
    var row = {
      contact_id: id, requestor_id: r.requestor_id, tenant_id: tid, user_id: '',
      first: c.first, last: c.last,
      email: '', phone_e164: '',
      title: c.title, preferred_channel: c.pref, status: 'active',
      _created_at: now, _updated_at: now
    };
    sh.appendRow(hdr.map(function (col) { return row[col] !== undefined ? row[col] : ''; }));
    out.push({ contact_id: id, requestor_id: r.requestor_id, name: c.first + ' ' + c.last });
  });
  return out;
}

// ----- PAYERS -------------------------------------------------------------

function seedPayers_(ss, tid) {
  var sh = _ensureTab(ss, T.Payers, _tenantSchema().Payers);
  var existing = _existingByCol_(sh, 'display_name');
  var hdr = _tenantSchema().Payers;
  var now = new Date().toISOString();
  var list = [
    { name:'Catoctin Regional Medical — Central Billing', net:30, tax_exempt:false },
    { name:'Frederick County Government — AP',            net:45, tax_exempt:true  },
    { name:'Lakeside Mental Health Group (self-pay)',     net:30, tax_exempt:false },
    { name:'Catoctin County Treasury',                    net:60, tax_exempt:true  },
    { name:'Midstate Behavioral Health',                  net:30, tax_exempt:false },
    { name:'Liberty Hill CC — Bursar',                    net:30, tax_exempt:true  }
  ];
  var out = [];
  list.forEach(function (p) {
    var k = p.name.toLowerCase();
    if (existing[k]) { out.push({ payer_id: existing[k], display_name: p.name, _existed: true }); return; }
    var id = _ulid('p');
    var row = {
      payer_id: id, tenant_id: tid, display_name: p.name,
      billing_email: '', billing_address: '{}',
      net_terms: p.net, tax_exempt: p.tax_exempt,
      stripe_customer_id: '', qb_customer_id: '',
      status: 'active', _created_at: now, _updated_at: now
    };
    sh.appendRow(hdr.map(function (c) { return row[c] !== undefined ? row[c] : ''; }));
    out.push({ payer_id: id, display_name: p.name, net: p.net });
  });
  return out;
}

// ----- LOCATIONS ----------------------------------------------------------

function seedLocations_(ss, tid, requestors) {
  var sh = _ensureTab(ss, T.Locations, _tenantSchema().Locations);
  var existing = _existingByCol_(sh, 'display_name');
  var hdr = _tenantSchema().Locations;
  var now = new Date().toISOString();
  var byReqName = {};
  requestors.forEach(function (r) { byReqName[r.display_name] = r.requestor_id; });
  var list = [
    { req:'Catoctin Regional Medical Center', name:'CRM Main Campus',        street:'400 Hospital Way', city:'Frederick', state:'MD', zip:'21701', mods:['on-site','VRI'], notes:'Park in Garage B; check in at Patient Access desk first.' },
    { req:'Catoctin Regional Medical Center', name:'CRM Pediatrics Annex',   street:'420 Hospital Way', city:'Frederick', state:'MD', zip:'21701', mods:['on-site'],        notes:'Pediatric wing; quiet environment; please silence phones.' },
    { req:'Catoctin County Circuit Court',    name:'Catoctin County Courthouse', street:'100 W Patrick St', city:'Frederick', state:'MD', zip:'21701', mods:['on-site'],   notes:'Security screening at main entrance; allow 10 min.' },
    { req:'Liberty Hill Community College',   name:'Liberty Hill — Student Services', street:'1500 Opossumtown Pike', city:'Frederick', state:'MD', zip:'21702', mods:['on-site','VRI'], notes:'Bldg 4, Room 220. Free parking after 4pm.' },
    { req:'Midstate Behavioral Health',       name:'Midstate Outpatient Wing', street:'901 Toll House Ave', city:'Frederick', state:'MD', zip:'21701', mods:['on-site','VRI'], notes:'Confidentiality essential; do not discuss in waiting area.' },
    { req:'Riverside Family Practice',        name:'Riverside MOB-2',          street:'2200 Riverside Pkwy', city:'Frederick', state:'MD', zip:'21701', mods:['on-site'], notes:'Small practice, family-style waiting room.' }
  ];
  var out = [];
  list.forEach(function (l) {
    if (existing[l.name.toLowerCase()]) { out.push({ location_id: existing[l.name.toLowerCase()], display_name: l.name, _existed: true }); return; }
    var id = _ulid('l');
    var row = {
      location_id: id, tenant_id: tid, requestor_id: byReqName[l.req] || '',
      display_name: l.name, street: l.street, city: l.city, state: l.state, zip: l.zip,
      timezone: 'America/New_York',
      parking_notes: l.notes, accessibility_notes: 'Wheelchair-accessible. ASL preferred.',
      geo: '{}',
      modalities_supported: JSON.stringify(l.mods),
      _created_at: now, _updated_at: now
    };
    sh.appendRow(hdr.map(function (c) { return row[c] !== undefined ? row[c] : ''; }));
    out.push({ location_id: id, requestor_id: row.requestor_id, display_name: l.name });
  });
  return out;
}

// ----- CONSUMERS (initials-only mode) -------------------------------------

function seedConsumers_(ss, tid) {
  var sh = _ensureTab(ss, T.Consumers, _tenantSchema().Consumers);
  var existing = _existingByCol_(sh, 'display_initials');
  var hdr = _tenantSchema().Consumers;
  var now = new Date().toISOString();
  // initials-only mode: only display_initials and primary_language_id are set;
  // encrypted fields stay blank. communication_prefs is non-PHI.
  var list = [
    { ini:'J.M.', lang:'ASL',     cdi:true,  notes:'Prefers Marcus when available' },
    { ini:'S.R.', lang:'es-419',  cdi:false, notes:'Spanish only, prefers female interpreter when feasible' },
    { ini:'T.K.', lang:'ko',      cdi:false, notes:'' },
    { ini:'A.B.', lang:'ASL',     cdi:false, notes:'Uses PSE / Contact, not Black ASL' },
    { ini:'M.C.', lang:'cmn-CN',  cdi:false, notes:'Mandarin (Beijing-region)' },
    { ini:'L.D.', lang:'ASL',     cdi:true,  notes:'DeafBlind — ProTactile required' },
    { ini:'R.G.', lang:'ar-MSA',  cdi:false, notes:'Egyptian Arabic dialect' },
    { ini:'P.S.', lang:'ht',      cdi:false, notes:'' },
    { ini:'E.W.', lang:'ASL',     cdi:false, notes:'K-12 student; same interpreter preferred across IEP cycle' },
    { ini:'N.H.', lang:'es-419',  cdi:false, notes:'Dominican Spanish' },
    { ini:'V.O.', lang:'ASL',     cdi:false, notes:'Tactile + protactile sometimes' },
    { ini:'F.A.', lang:'ar-MSA',  cdi:false, notes:'' }
  ];
  var out = [];
  list.forEach(function (c) {
    if (existing[c.ini.toLowerCase()]) { out.push({ consumer_id: existing[c.ini.toLowerCase()], initials: c.ini, _existed: true }); return; }
    var id = _ulid('cn');
    var row = {
      consumer_id: id, tenant_id: tid,
      display_initials: c.ini,
      legal_first_encrypted: '', legal_last_encrypted: '', dob_encrypted: '', mrn_encrypted: '',
      primary_language_id: c.lang, dialect: '',
      communication_prefs: JSON.stringify({ deaf: c.lang === 'ASL', uses_cdi: c.cdi, tactile: c.notes.indexOf('Tactile') >= 0 || c.notes.indexOf('protactile') >= 0 }),
      notes_sealed: '',
      do_not_contact: false, consent_recording_default: false,
      created_by_user_id: 'system', deletion_requested_at: '',
      _created_at: now, _updated_at: now
    };
    sh.appendRow(hdr.map(function (h) { return row[h] !== undefined ? row[h] : ''; }));
    out.push({ consumer_id: id, initials: c.ini, lang: c.lang, cdi: c.cdi });
  });
  return out;
}

// ----- JOBS ---------------------------------------------------------------

function seedJobs_(ss, tid, refs) {
  var sh = _ensureTab(ss, T.Jobs, _tenantSchema().Jobs);
  var hdr = _tenantSchema().Jobs;
  // Build by-name maps for cleanly picking related refs
  var byInterp = {};   refs.interpreters.forEach(function (i) { byInterp[i.first + ' ' + i.last] = i; });
  var byReq = {};      refs.requestors.forEach(function (r) { byReq[r.display_name] = r; });
  var byPayer = {};    refs.payers.forEach(function (p) { byPayer[p.display_name] = p; });
  var byLoc = {};      refs.locations.forEach(function (l) { byLoc[l.display_name] = l; });
  var byCons = {};     refs.consumers.forEach(function (c) { byCons[c.initials] = c; });
  var byContact = {};  refs.contacts.forEach(function (c) { byContact[c.requestor_id] = c; });

  // Only seed if Jobs is empty enough — count rows tagged [SEED] to avoid double-seeding
  var data = sh.getDataRange().getValues();
  var notesCol = hdr.indexOf('notes_to_interpreter');
  var seedExisting = 0;
  for (var i = 1; i < data.length; i++) {
    if (notesCol >= 0 && String(data[i][notesCol] || '').indexOf('[SEED]') >= 0) seedExisting++;
  }
  if (seedExisting > 0) {
    // Idempotent — skip seeding jobs if any [SEED] jobs already exist
    var out0 = [];
    var jcol = hdr.indexOf('job_id'), scol = hdr.indexOf('status'), tcol = hdr.indexOf('tenant_id');
    for (var j = 1; j < data.length; j++) {
      if (String(data[j][tcol]) === tid && String(data[j][notesCol] || '').indexOf('[SEED]') >= 0) {
        out0.push({ job_id: data[j][jcol], status: data[j][scol], _existed: true });
      }
    }
    return out0;
  }

  var now = new Date();
  function shiftHours(h) { return new Date(now.getTime() + h * 60 * 60 * 1000).toISOString(); }
  function shiftDays(d, h) { return new Date(now.getTime() + d * 86400000 + (h || 0) * 3600000).toISOString(); }

  var jobs = [
    // ---- OPEN: 4 jobs needing interpreters ----
    { svc:'medical',       mod:'on-site', src:'en-US', tgt:'ASL',   team:'solo', start: shiftHours(28), end: shiftHours(29.5),
      req:'Catoctin Regional Medical Center', loc:'CRM Main Campus', payer:'Catoctin Regional Medical — Central Billing', consumer:'J.M.',
      status:'OPEN', notes:'[SEED] 90-min outpatient follow-up. Routine.' },
    { svc:'mental-health', mod:'on-site', src:'en-US', tgt:'es-419',team:'solo', start: shiftHours(48), end: shiftHours(49),
      req:'Lakeside Mental Health Group', loc:'Midstate Outpatient Wing', payer:'Lakeside Mental Health Group (self-pay)', consumer:'S.R.',
      status:'OPEN', notes:'[SEED] Therapy session. Strict confidentiality. No notes shared with interpreter.' },
    { svc:'education',     mod:'on-site', src:'en-US', tgt:'ASL',   team:'solo', start: shiftHours(72), end: shiftHours(74),
      req:'Frederick County Schools (demo)', loc:'', payer:'Frederick County Government — AP', consumer:'E.W.',
      status:'OPEN', notes:'[SEED] IEP annual review meeting. Same interpreter preference noted.' },
    { svc:'legal',         mod:'on-site', src:'en-US', tgt:'ASL',   team:'team-of-2', start: shiftHours(96), end: shiftHours(100),
      req:'Catoctin County Circuit Court', loc:'Catoctin County Courthouse', payer:'Catoctin County Treasury', consumer:'V.O.',
      status:'OPEN', notes:'[SEED] Civil hearing. Team-of-2 required (4-hr session). SC:L preferred.' },

    // ---- OFFERED: 3 jobs out for claim ----
    { svc:'medical',       mod:'on-site', src:'en-US', tgt:'cmn-CN',team:'solo', start: shiftHours(24), end: shiftHours(25.5),
      req:'Riverside Family Practice', loc:'Riverside MOB-2', payer:'Riverside Family Practice', consumer:'M.C.',
      status:'OFFERED', notes:'[SEED] New-patient intake. 90 min budgeted.' },
    { svc:'medical',       mod:'VRI',     src:'en-US', tgt:'ar-MSA',team:'solo', start: shiftHours(12), end: shiftHours(13),
      req:'Catoctin Regional Medical Center', loc:'CRM Main Campus', payer:'Catoctin Regional Medical — Central Billing', consumer:'R.G.',
      status:'OFFERED', notes:'[SEED] VRI from ED. Egyptian Arabic dialect preferred.' },
    { svc:'medical',       mod:'on-site', src:'en-US', tgt:'ht',    team:'solo', start: shiftHours(36), end: shiftHours(37.5),
      req:'Riverside Family Practice', loc:'Riverside MOB-2', payer:'Riverside Family Practice', consumer:'P.S.',
      status:'OFFERED', notes:'[SEED] Annual physical.' },

    // ---- CLAIMED: 3 jobs assigned, awaiting confirmation ----
    { svc:'medical',       mod:'on-site', src:'en-US', tgt:'ASL',   team:'cdi+hearing', start: shiftHours(20), end: shiftHours(21.5),
      req:'Catoctin Regional Medical Center', loc:'CRM Pediatrics Annex', payer:'Catoctin Regional Medical — Central Billing', consumer:'L.D.',
      status:'CLAIMED', notes:'[SEED] DeafBlind consumer — CDI + voicer required. Tactile interpretation.', _assign:[{ name:'Marcus Thompson', role:'cdi' }, { name:'Maria Rivera', role:'hearing-voicer' }] },
    { svc:'education',     mod:'on-site', src:'en-US', tgt:'ASL',   team:'solo', start: shiftHours(45), end: shiftHours(47),
      req:'Liberty Hill Community College', loc:'Liberty Hill — Student Services', payer:'Liberty Hill CC — Bursar', consumer:'A.B.',
      status:'CLAIMED', notes:'[SEED] Higher-ed lecture interpretation.', _assign:[{ name:'Jordan Hayes', role:'primary' }] },
    { svc:'medical',       mod:'on-site', src:'en-US', tgt:'ko',    team:'solo', start: shiftHours(60), end: shiftHours(61),
      req:'Riverside Family Practice', loc:'Riverside MOB-2', payer:'Riverside Family Practice', consumer:'T.K.',
      status:'CLAIMED', notes:'[SEED] Standard appointment.', _assign:[{ name:'David Park', role:'primary' }] },

    // ---- CONFIRMED: 2 jobs locked in, ready to go ----
    { svc:'medical',       mod:'on-site', src:'en-US', tgt:'es-419',team:'solo', start: shiftHours(8),  end: shiftHours(9.5),
      req:'Catoctin Regional Medical Center', loc:'CRM Main Campus', payer:'Catoctin Regional Medical — Central Billing', consumer:'N.H.',
      status:'CONFIRMED', notes:'[SEED] Outpatient. Confirmed yesterday.', _assign:[{ name:'Elena Vasquez', role:'primary' }] },
    { svc:'legal',         mod:'on-site', src:'en-US', tgt:'es-419',team:'solo', start: shiftHours(52), end: shiftHours(55),
      req:'Catoctin County Circuit Court', loc:'Catoctin County Courthouse', payer:'Catoctin County Treasury', consumer:'S.R.',
      status:'CONFIRMED', notes:'[SEED] Custody hearing. Confirmed.', _assign:[{ name:'Elena Vasquez', role:'primary' }] },

    // ---- IN_PROGRESS: 1 active right now ----
    { svc:'medical',       mod:'on-site', src:'en-US', tgt:'ASL',   team:'solo', start: shiftHours(-0.5), end: shiftHours(1.0),
      req:'Catoctin Regional Medical Center', loc:'CRM Main Campus', payer:'Catoctin Regional Medical — Central Billing', consumer:'J.M.',
      status:'IN_PROGRESS', notes:'[SEED] Currently in progress. Cardiology consult.', _assign:[{ name:'Maria Rivera', role:'primary' }],
      actual_start: shiftHours(-0.5) },

    // ---- COMPLETED: 7 jobs in the last 2 weeks (ready to invoice + pay) ----
    { svc:'medical',       mod:'on-site', src:'en-US', tgt:'ASL',   team:'solo', start: shiftDays(-2, 9), end: shiftDays(-2, 11),
      req:'Catoctin Regional Medical Center', loc:'CRM Main Campus', payer:'Catoctin Regional Medical — Central Billing', consumer:'A.B.',
      status:'COMPLETED', notes:'[SEED] Pre-op consult.', _assign:[{ name:'Sarah Chen', role:'primary' }] },
    { svc:'medical',       mod:'on-site', src:'en-US', tgt:'es-419',team:'solo', start: shiftDays(-3, 14), end: shiftDays(-3, 15.5),
      req:'Catoctin Regional Medical Center', loc:'CRM Main Campus', payer:'Catoctin Regional Medical — Central Billing', consumer:'N.H.',
      status:'COMPLETED', notes:'[SEED] Diabetes management visit.', _assign:[{ name:'Elena Vasquez', role:'primary' }] },
    { svc:'medical',       mod:'on-site', src:'en-US', tgt:'ar-MSA',team:'solo', start: shiftDays(-4, 10), end: shiftDays(-4, 11.5),
      req:'Riverside Family Practice', loc:'Riverside MOB-2', payer:'Riverside Family Practice', consumer:'F.A.',
      status:'COMPLETED', notes:'[SEED] Routine.', _assign:[{ name:'Ahmad Hassan', role:'primary' }] },
    { svc:'mental-health', mod:'on-site', src:'en-US', tgt:'ASL',   team:'solo', start: shiftDays(-5, 13), end: shiftDays(-5, 14),
      req:'Midstate Behavioral Health', loc:'Midstate Outpatient Wing', payer:'Midstate Behavioral Health', consumer:'V.O.',
      status:'COMPLETED', notes:'[SEED] Group session.', _assign:[{ name:'Marcus Thompson', role:'primary' }] },
    { svc:'education',     mod:'on-site', src:'en-US', tgt:'ASL',   team:'solo', start: shiftDays(-7, 9), end: shiftDays(-7, 11),
      req:'Liberty Hill Community College', loc:'Liberty Hill — Student Services', payer:'Liberty Hill CC — Bursar', consumer:'A.B.',
      status:'COMPLETED', notes:'[SEED] Biology lecture.', _assign:[{ name:'Riya Patel', role:'primary' }] },
    { svc:'medical',       mod:'VRI',     src:'en-US', tgt:'cmn-CN',team:'solo', start: shiftDays(-9, 16), end: shiftDays(-9, 17),
      req:'Catoctin Regional Medical Center', loc:'CRM Main Campus', payer:'Catoctin Regional Medical — Central Billing', consumer:'M.C.',
      status:'COMPLETED', notes:'[SEED] VRI from ED.', _assign:[{ name:'Wei Liu', role:'primary' }] },
    { svc:'legal',         mod:'on-site', src:'en-US', tgt:'ASL',   team:'team-of-2', start: shiftDays(-11, 9), end: shiftDays(-11, 13),
      req:'Catoctin County Circuit Court', loc:'Catoctin County Courthouse', payer:'Catoctin County Treasury', consumer:'V.O.',
      status:'COMPLETED', notes:'[SEED] Court hearing. Team-of-2.', _assign:[{ name:'Jordan Hayes', role:'primary' }, { name:'Marcus Thompson', role:'team' }] },

    // ---- CANCELLED: 1 illustrative ----
    { svc:'medical',       mod:'on-site', src:'en-US', tgt:'ko',    team:'solo', start: shiftDays(-1, 10), end: shiftDays(-1, 11),
      req:'Riverside Family Practice', loc:'Riverside MOB-2', payer:'Riverside Family Practice', consumer:'T.K.',
      status:'CANCELLED_BY_REQUESTOR', notes:'[SEED] Patient cancelled morning-of.', cancellation_reason:'Patient cancelled <2h before appointment.', cancellation_at: shiftDays(-1, 8) },

    // ---- NO_SHOW: 1 illustrative ----
    { svc:'medical',       mod:'on-site', src:'en-US', tgt:'es-419',team:'solo', start: shiftDays(-6, 14), end: shiftDays(-6, 15),
      req:'Catoctin Regional Medical Center', loc:'CRM Main Campus', payer:'Catoctin Regional Medical — Central Billing', consumer:'N.H.',
      status:'NO_SHOW_CONSUMER', notes:'[SEED] Consumer did not show. Interpreter arrived, waited 20 min, billable per policy.', _assign:[{ name:'Elena Vasquez', role:'primary' }] }
  ];
  var nowIso = now.toISOString();
  var out = [];
  jobs.forEach(function (j) {
    var jobId = _ulid('j');
    var req = byReq[j.req] || {};
    var loc = j.loc ? (byLoc[j.loc] || {}) : {};
    var payer = byPayer[j.payer] || {};
    var contact = byContact[req.requestor_id] || {};
    var consumer = j.consumer ? byCons[j.consumer] : null;
    var row = {
      job_id: jobId, tenant_id: tid,
      requestor_id: req.requestor_id || '', requestor_contact_id: contact.contact_id || '',
      payer_id: payer.payer_id || '',
      location_id: loc.location_id || '',
      consumer_id: consumer ? consumer.consumer_id : '',
      modality: j.mod, service_type: j.svc,
      source_language_id: j.src, target_language_id: j.tgt,
      team_config: j.team,
      scheduled_start: j.start, scheduled_end: j.end,
      actual_start: j.actual_start || '', actual_end: '',
      status: j.status, on_demand: false, reference_no: '',
      notes_to_interpreter: j.notes,
      consent_recording: false, recording_r2_key: '', transcript_r2_key: '',
      created_via: 'portal', ai_intake_id: '',
      rate_applied: '{}',
      cancellation_reason: j.cancellation_reason || '',
      cancellation_at: j.cancellation_at || '',
      _created_at: nowIso, _updated_at: nowIso, _rev: 1
    };
    sh.appendRow(hdr.map(function (h) { return row[h] !== undefined ? row[h] : ''; }));
    out.push({ job_id: jobId, status: j.status, _assign: j._assign || [], svc: j.svc, mod: j.mod, tgt: j.tgt, payer_id: payer.payer_id, period: j.start, scheduled_start: j.start, scheduled_end: j.end });
    // Job_Events: status_change DRAFT->status
    _appendJobEvent(ss, jobId, 'system', 'status_change', 'DRAFT', j.status, '{}');
  });
  return out;
}

// ----- ASSIGNMENTS --------------------------------------------------------

function seedAssignments_(ss, tid, jobs, interpreters) {
  var sh = _ensureTab(ss, T.JobAssignments, _tenantSchema().Job_Assignments);
  var hdr = _tenantSchema().Job_Assignments;
  var byInterp = {};
  interpreters.forEach(function (i) { byInterp[i.first + ' ' + i.last] = i; });
  var out = [];
  var now = new Date().toISOString();
  jobs.forEach(function (j) {
    if (!j._assign || !j._assign.length) return;
    j._assign.forEach(function (a, idx) {
      var interp = byInterp[a.name];
      if (!interp) return;
      var id = _ulid('a');
      // Default pay rate snapshot: 60% of bill-side hourly per assignment
      var billCents = (j.svc === 'legal') ? 12500 : (j.svc === 'education' ? 8500 : 9500);
      var payCents = Math.round(billCents * 0.6);
      // billable_minutes: scheduled span for COMPLETED, else 0
      var billable = 0;
      if (j.status === 'COMPLETED' || j.status === 'NO_SHOW_CONSUMER') {
        var span = (new Date(j.scheduled_end || j.period).getTime() - new Date(j.scheduled_start || j.period).getTime()) / 60000;
        billable = Math.max(120, Math.round(span)); // honor 2-hr minimum
      }
      var aStatus = ({
        'CLAIMED':'CLAIMED', 'CONFIRMED':'CONFIRMED', 'IN_PROGRESS':'IN_PROGRESS',
        'COMPLETED':'COMPLETED', 'NO_SHOW_CONSUMER':'COMPLETED'
      })[j.status] || 'OFFERED';
      var row = {
        assignment_id: id, job_id: j.job_id, interpreter_id: interp.interpreter_id,
        role_on_job: a.role || 'primary',
        offered_at: now, responded_at: now, response: 'claim',
        pay_rate_snapshot: JSON.stringify({ hourly_cents: payCents }),
        billable_minutes: billable, status: aStatus,
        _created_at: now, _updated_at: now, _rev: 1
      };
      sh.appendRow(hdr.map(function (h) { return row[h] !== undefined ? row[h] : ''; }));
      out.push({ assignment_id: id, job_id: j.job_id, interpreter_id: interp.interpreter_id, billable_minutes: billable, status: aStatus, pay_cents: payCents, svc: j.svc });
    });
  });
  return out;
}

// ----- INVOICES (paid + issued + draft) -----------------------------------

function seedInvoices_(ss, tid, payers, jobs) {
  var invSh = _ensureTab(ss, T.Invoices, _tenantSchema().Invoices);
  var lineSh = _ensureTab(ss, T.InvoiceLines, _tenantSchema().Invoice_Lines);
  var invHdr = _tenantSchema().Invoices;
  var lineHdr = _tenantSchema().Invoice_Lines;
  var byPayer = {};   payers.forEach(function (p) { byPayer[p.display_name] = p; });
  var byPayerId = {}; payers.forEach(function (p) { byPayerId[p.payer_id] = p; });
  var completed = jobs.filter(function (j) { return j.status === 'COMPLETED' || j.status === 'NO_SHOW_CONSUMER'; });
  var nowIso = new Date().toISOString();
  // Group by payer
  var byPayerJobs = {};
  completed.forEach(function (j) { (byPayerJobs[j.payer_id] = byPayerJobs[j.payer_id] || []).push(j); });

  var invoices = [];
  // Invoice 1: paid — Catoctin Regional jobs from > 5 days ago
  var crmPayer = byPayer['Catoctin Regional Medical — Central Billing'];
  if (crmPayer) {
    var crmJobs = (byPayerJobs[crmPayer.payer_id] || []).filter(function (j) {
      return new Date(j.scheduled_start) < new Date(Date.now() - 5 * 86400000);
    });
    if (crmJobs.length) invoices.push({ payer: crmPayer, jobs: crmJobs, status: 'paid', issuedDaysAgo: 18, dueDaysAgo: -12, label:'Older — paid' });
  }
  // Invoice 2: issued, Net-30 — Liberty Hill CC + Catoctin Court (older legal job)
  var lhPayer = byPayer['Liberty Hill CC — Bursar'];
  if (lhPayer) {
    var lhJobs = byPayerJobs[lhPayer.payer_id] || [];
    if (lhJobs.length) invoices.push({ payer: lhPayer, jobs: lhJobs, status: 'issued', issuedDaysAgo: 4, dueDaysAgo: -26, label:'Recent — issued' });
  }
  // Invoice 3: draft — rest of CRM completed jobs (within last 5 days)
  if (crmPayer) {
    var crmRecent = (byPayerJobs[crmPayer.payer_id] || []).filter(function (j) {
      return new Date(j.scheduled_start) >= new Date(Date.now() - 5 * 86400000);
    });
    if (crmRecent.length) invoices.push({ payer: crmPayer, jobs: crmRecent, status: 'draft', issuedDaysAgo: 0, dueDaysAgo: -30, label:'Current cycle — draft' });
  }

  var out = [];
  invoices.forEach(function (inv) {
    var invoiceId = _padInvoiceId();
    var issuedAt = new Date(Date.now() - inv.issuedDaysAgo * 86400000).toISOString();
    var dueAt = new Date(Date.now() - inv.dueDaysAgo * 86400000).toISOString();
    var periodStart = '', periodEnd = '';
    var subtotal = 0;
    var lineRows = [];
    inv.jobs.forEach(function (j) {
      var billCents = (j.svc === 'legal') ? 12500 : (j.svc === 'education' ? 8500 : 9500);
      var span = (new Date(j.scheduled_end || j.scheduled_start).getTime() - new Date(j.scheduled_start).getTime()) / 60000;
      var hours = Math.max(2.0, Math.round(span / 60 * 10) / 10);
      var amount = Math.round(hours * billCents);
      subtotal += amount;
      var date = new Date(j.scheduled_start).toISOString().slice(0, 10);
      lineRows.push({
        line_id: _ulid('il'),
        invoice_id: invoiceId,
        job_id: j.job_id,
        description: j.svc + ' · ' + date + ' · ' + j.mod + ' · ' + j.tgt,
        quantity: hours, unit: 'hour',
        rate_cents: billCents, amount_cents: amount,
        _created_at: issuedAt, _updated_at: issuedAt
      });
      if (!periodStart || j.scheduled_start < periodStart) periodStart = j.scheduled_start;
      if (!periodEnd   || j.scheduled_start > periodEnd)   periodEnd = j.scheduled_start;
    });
    var invRow = {
      invoice_id: invoiceId, tenant_id: tid, payer_id: inv.payer.payer_id,
      period_start: periodStart.slice(0, 10), period_end: periodEnd.slice(0, 10),
      issued_at: issuedAt, due_at: dueAt,
      subtotal_cents: subtotal, tax_cents: 0, total_cents: subtotal,
      status: inv.status,
      stripe_invoice_id: '', pdf_r2_key: '',
      _created_at: issuedAt, _updated_at: issuedAt
    };
    invSh.appendRow(invHdr.map(function (h) { return invRow[h] !== undefined ? invRow[h] : ''; }));
    lineRows.forEach(function (lr) { lineSh.appendRow(lineHdr.map(function (h) { return lr[h] !== undefined ? lr[h] : ''; })); });
    out.push({ invoice_id: invoiceId, status: inv.status, total: subtotal, payer: inv.payer.display_name, lines: lineRows.length });
  });
  return out;
}

function _padInvoiceId() {
  // INV-YYYY-NNNNNN; counter pulled from existing rows + 1
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Invoices);
  var maxN = 0;
  if (sh && sh.getLastRow() >= 2) {
    var data = sh.getDataRange().getValues();
    var hdr = data[0], iId = hdr.indexOf('invoice_id');
    for (var i = 1; i < data.length; i++) {
      var m = String(data[i][iId] || '').match(/INV-\d{4}-(\d+)/);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
  }
  var n = maxN + 1;
  var year = new Date().getFullYear();
  return 'INV-' + year + '-' + ('000000' + n).slice(-6);
}

// ----- PAYOUTS (paid + draft) ---------------------------------------------

function seedPayouts_(ss, tid, interpreters, assignments) {
  var sh = _ensureTab(ss, T.Payouts, _tenantSchema().Payouts);
  var hdr = _tenantSchema().Payouts;
  var byInterp = {};
  interpreters.forEach(function (i) { byInterp[i.interpreter_id] = i; });
  // Group billable assignments by interpreter
  var byInterpAssign = {};
  assignments.forEach(function (a) {
    if (a.status !== 'COMPLETED' || !a.billable_minutes) return;
    (byInterpAssign[a.interpreter_id] = byInterpAssign[a.interpreter_id] || []).push(a);
  });
  var nowIso = new Date().toISOString();
  var out = [];

  // Payout 1: paid — Maria Rivera's older period
  var maria = interpreters.find(function (i) { return i.first === 'Maria' && i.last === 'Rivera'; });
  if (maria && byInterpAssign[maria.interpreter_id]) {
    var assigns = byInterpAssign[maria.interpreter_id];
    var total = assigns.reduce(function (sum, a) {
      return sum + Math.round((a.billable_minutes / 60) * a.pay_cents);
    }, 0);
    var payoutId = _ulid('po');
    var row = {
      payout_id: payoutId, tenant_id: tid, interpreter_id: maria.interpreter_id,
      period_start: new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10),
      period_end: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
      issued_at: new Date(Date.now() - 6 * 86400000).toISOString(),
      total_cents: total,
      status: 'paid',
      stripe_transfer_id: 'tr_SEED_demo_paid',
      _created_at: nowIso, _updated_at: nowIso
    };
    sh.appendRow(hdr.map(function (h) { return row[h] !== undefined ? row[h] : ''; }));
    // Write payout_included Job_Events for dedupe ledger
    assigns.forEach(function (a) {
      _appendJobEvent(ss, a.job_id, 'system', 'payout_included', '', '', JSON.stringify({
        payout_id: payoutId, assignment_id: a.assignment_id,
        billable_minutes: a.billable_minutes, pay_rate_cents: a.pay_cents,
        amount_cents: Math.round((a.billable_minutes / 60) * a.pay_cents)
      }));
    });
    out.push({ payout_id: payoutId, status:'paid', total: total, interpreter: maria.first + ' ' + maria.last });
  }

  // Payout 2: draft — Elena Vasquez's current cycle
  var elena = interpreters.find(function (i) { return i.first === 'Elena' && i.last === 'Vasquez'; });
  if (elena && byInterpAssign[elena.interpreter_id]) {
    var eAssigns = byInterpAssign[elena.interpreter_id];
    var eTotal = eAssigns.reduce(function (sum, a) {
      return sum + Math.round((a.billable_minutes / 60) * a.pay_cents);
    }, 0);
    var ePayoutId = _ulid('po');
    var eRow = {
      payout_id: ePayoutId, tenant_id: tid, interpreter_id: elena.interpreter_id,
      period_start: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
      period_end: new Date().toISOString().slice(0, 10),
      issued_at: '', total_cents: eTotal, status: 'draft',
      stripe_transfer_id: '',
      _created_at: nowIso, _updated_at: nowIso
    };
    sh.appendRow(hdr.map(function (h) { return eRow[h] !== undefined ? eRow[h] : ''; }));
    out.push({ payout_id: ePayoutId, status:'draft', total: eTotal, interpreter: elena.first + ' ' + elena.last });
  }
  return out;
}

// ============================================================================
// WIPE — removes only rows tagged [SEED]
// ============================================================================

function wipeSeed() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var report = {};
  var tabs = [
    { tab: T.Interpreters,  marker: 'notes_internal' },
    { tab: T.Requestors,    marker: 'notes' },
    { tab: T.Locations,     marker: '' },     // wipe all (locations don't have a notes column we control)
    { tab: T.Consumers,     marker: '' },     // wipe all (Consumers seeds don't tag)
    { tab: T.Jobs,          marker: 'notes_to_interpreter' },
    { tab: T.JobAssignments,marker: '' },     // wipe assignments tied to seeded jobs (cascade — skip for simplicity)
    { tab: T.Invoices,      marker: '' },     // wipe all invoices (only seeded ones exist)
    { tab: T.InvoiceLines,  marker: '' },
    { tab: T.Payouts,       marker: '' },
    { tab: T.RequestorContacts, marker: '' },
    { tab: T.Payers,        marker: '' }
  ];
  tabs.forEach(function (t) {
    var sh = ss.getSheetByName(t.tab);
    if (!sh) { report[t.tab] = 0; return; }
    var data = sh.getDataRange().getValues();
    if (data.length < 2) { report[t.tab] = 0; return; }
    var hdr = data[0];
    var col = t.marker ? hdr.indexOf(t.marker) : -1;
    var removed = 0;
    for (var i = data.length - 1; i >= 1; i--) {
      var keep = false;
      if (t.marker && col >= 0) {
        if (String(data[i][col] || '').indexOf('[SEED]') < 0) keep = true;
      }
      if (!keep) { sh.deleteRow(i + 1); removed++; }
    }
    report[t.tab] = removed;
  });
  _logAudit('seed.wipe', 'host', 'system', JSON.stringify(report));
  return report;
}

// ============================================================================
// HELPERS
// ============================================================================

function _existingByCol_(sh, col1, col2) {
  // Returns a {keyLower: id} map. Key is either col1 value or col1|col2 if col2 provided.
  var out = {};
  if (sh.getLastRow() < 2) return out;
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var idCol = 0; // first column is always the id
  var c1 = hdr.indexOf(col1);
  var c2 = col2 ? hdr.indexOf(col2) : -1;
  if (c1 < 0) return out;
  for (var i = 1; i < data.length; i++) {
    var key = String(data[i][c1] || '');
    if (c2 >= 0) key += '|' + String(data[i][c2] || '');
    out[key.toLowerCase()] = data[i][idCol];
  }
  return out;
}
