/**
 * 1891 Interpreter — Invoicing + Payouts (MVP).
 *
 * Implementations for the route stubs declared in Code.gs:
 *   list_invoices, get_invoice, create_invoice (incl. dry_run preview),
 *   update_invoice, mark_invoice_paid, void_invoice,
 *   list_payouts, get_payout, create_payout, mark_payout_paid.
 *
 * Conventions follow Code.gs:
 *   - _requireSession(e) gates every endpoint
 *   - _ensureTab / _rowToObj / _ulid / _logAudit / _json reused
 *   - tenant_id is read from session payload (s.payload.tid)
 *   - audit logs carry IDs only, never invoice line detail
 *   - PII rule: invoice line descriptions use display_initials, never names
 *
 * No new helpers redefined here — all utilities come from Code.gs.
 */

// ============================================================================
// SHARED HELPERS (file-local)
// ============================================================================

function _invDataRows(ss, tabName, headers) {
  _ensureTab(ss, tabName, headers);
  var sh = ss.getSheetByName(tabName);
  var data = sh.getDataRange().getValues();
  return { sh: sh, data: data, hdr: data.length ? data[0] : headers };
}

function _invForTenant(rows, tenantId) {
  var out = [];
  if (rows.data.length < 2) return out;
  for (var i = 1; i < rows.data.length; i++) {
    var o = _rowToObj(rows.hdr, rows.data[i]);
    if (String(o.tenant_id) === String(tenantId)) out.push(o);
  }
  return out;
}

// Pull settings rate (cents/hour) — falls back through the cascade per brief.
function _invRateCents(ss, serviceType, modality, teamConfig) {
  var keys = [
    'rate_card.' + serviceType + '.' + (modality || 'on-site') + '.' + (teamConfig || 'solo') + '.hourly_cents',
    'rate_card.' + serviceType + '.on-site.solo.hourly_cents'
  ];
  for (var i = 0; i < keys.length; i++) {
    var v = _getSetting(ss, keys[i]);
    if (v) return Number(v);
  }
  return 9500;
}

function _invMinHours(ss, serviceType) {
  var v = _getSetting(ss, 'rate_card.minimum.' + serviceType + '.hours');
  if (v) return Number(v);
  return 2.0;
}

// "60% of the invoice-side rate" interpreter-pay fallback.
function _invPayCentsFallback(billCents) {
  return Math.round(billCents * 0.60);
}

// Find the claimed assignment row for a job (used for billable_minutes + pay_rate_snapshot).
function _invClaimedAssignment(ss, jobId) {
  var sh = ss.getSheetByName(T.JobAssignments);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (String(o.job_id) === String(jobId) && String(o.response) === 'claim') return o;
  }
  return null;
}

// Look up a single job row by id within a tenant (existing _findJob is in Code.gs).
function _invListJobsInPeriod(ss, tenantId, payerId, periodStart, periodEnd) {
  var sh = ss.getSheetByName(T.Jobs);
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0];
  var startT = new Date(periodStart + 'T00:00:00Z').getTime();
  var endT = new Date(periodEnd + 'T23:59:59Z').getTime();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (String(o.tenant_id) !== String(tenantId)) continue;
    if (payerId && String(o.payer_id) !== String(payerId)) continue;
    if (String(o.status) !== 'COMPLETED') continue;
    var refIso = o.actual_end || o.scheduled_end || o.scheduled_start;
    if (!refIso) continue;
    var t = new Date(refIso).getTime();
    if (isNaN(t)) continue;
    if (t < startT || t > endT) continue;
    out.push(o);
  }
  return out;
}

// Set of job_ids already on an Invoice_Line (across any tenant invoice — globally unique).
function _invAlreadyBilledJobIds(ss) {
  var sh = ss.getSheetByName(T.InvoiceLines);
  if (!sh) return {};
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return {};
  var hdr = data[0];
  var iJob = hdr.indexOf('job_id');
  var iInv = hdr.indexOf('invoice_id');
  if (iJob < 0) return {};
  // Build a map of job_id → invoice_id (so void can untrack).
  var m = {};
  for (var i = 1; i < data.length; i++) {
    var j = String(data[i][iJob] || '');
    if (j) m[j] = String(data[i][iInv] || '');
  }
  return m;
}

// Set of (assignment_id) already paid via a Payout (cross-payout dedupe).
function _invAlreadyPaidAssignments(ss) {
  // We piggyback on Job_Events of type 'payout_included' which we'll write at payout-create time.
  // Simpler: scan a hidden tracking by looking at Job_Events with event_type='payout_included'.
  var sh = ss.getSheetByName(T.JobEvents);
  if (!sh) return {};
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return {};
  var hdr = data[0];
  var iType = hdr.indexOf('event_type');
  var iPayload = hdr.indexOf('payload');
  if (iType < 0) return {};
  var m = {};
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iType]) !== 'payout_included') continue;
    try {
      var p = JSON.parse(data[i][iPayload] || '{}');
      if (p.assignment_id) m[String(p.assignment_id)] = String(p.payout_id || '');
    } catch (_) {}
  }
  return m;
}

function _invConsumerInitials(ss, tenantId, consumerId) {
  if (!consumerId) return '';
  var sh = ss.getSheetByName(T.Consumers);
  if (!sh) return '';
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return '';
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (String(o.tenant_id) === String(tenantId) && String(o.consumer_id) === String(consumerId)) {
      return String(o.display_initials || '');
    }
  }
  return '';
}

function _invInterpreterDisplayName(ss, tenantId, interpreterId) {
  if (!interpreterId) return '';
  var sh = ss.getSheetByName(T.Interpreters);
  if (!sh) return '';
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return '';
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (String(o.tenant_id) === String(tenantId) && String(o.interpreter_id) === String(interpreterId)) {
      var first = String(o.legal_first || '').trim();
      var last = String(o.legal_last || '').trim();
      var combined = (first + ' ' + last).trim();
      return combined || interpreterId;
    }
  }
  return interpreterId;
}

function _invPayerDisplayName(ss, tenantId, payerId) {
  if (!payerId) return '';
  // Payers tab may be sparse in MVP; the brief says payers piggyback on requestors.
  var shP = ss.getSheetByName(T.Payers);
  if (shP) {
    var data = shP.getDataRange().getValues();
    if (data.length >= 2) {
      var hdr = data[0];
      for (var i = 1; i < data.length; i++) {
        var o = _rowToObj(hdr, data[i]);
        if (String(o.tenant_id) === String(tenantId) && String(o.payer_id) === String(payerId)) {
          return String(o.display_name || payerId);
        }
      }
    }
  }
  // Fall back to Requestors tab (same id namespace in MVP per brief).
  var shR = ss.getSheetByName(T.Requestors);
  if (shR) {
    var data2 = shR.getDataRange().getValues();
    if (data2.length >= 2) {
      var hdr2 = data2[0];
      for (var j = 1; j < data2.length; j++) {
        var o2 = _rowToObj(hdr2, data2[j]);
        if (String(o2.tenant_id) === String(tenantId) && String(o2.requestor_id) === String(payerId)) {
          return String(o2.display_name || payerId);
        }
      }
    }
  }
  return payerId;
}

function _invShortDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toISOString().slice(0, 10); }
  catch (_) { return String(iso).slice(0, 10); }
}

function _invBillableHours(ss, job, jobAssignment) {
  // Prefer the assignment's billable_minutes (populated on complete); fall back to scheduled span.
  var mins = 0;
  if (jobAssignment && jobAssignment.billable_minutes) {
    mins = Number(jobAssignment.billable_minutes) || 0;
  }
  if (!mins && job.scheduled_start && job.scheduled_end) {
    mins = Math.max(0, Math.round((new Date(job.scheduled_end).getTime() - new Date(job.scheduled_start).getTime()) / 60000));
  }
  return mins / 60;
}

function _round2(n) { return Math.round(n * 100) / 100; }

// ============================================================================
// INVOICES
// ============================================================================

function apiListInvoices(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var schema = _tenantSchema();
  var rows = _invDataRows(ss, T.Invoices, schema.Invoices);
  var list = _invForTenant(rows, s.payload.tid);
  // Enrich with payer display name; sort by issued_at desc (treating empty as 0).
  list.forEach(function (o) {
    o.payer_display_name = _invPayerDisplayName(ss, s.payload.tid, o.payer_id);
  });
  list.sort(function (a, b) {
    var ta = a.issued_at ? new Date(a.issued_at).getTime() : 0;
    var tb = b.issued_at ? new Date(b.issued_at).getTime() : 0;
    return tb - ta;
  });
  return _json({ ok:true, invoices: list });
}

function apiGetInvoice(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var id = (e.parameter && e.parameter.id) || '';
  if (!id) return _json({ ok:false, error:'id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var schema = _tenantSchema();
  var rows = _invDataRows(ss, T.Invoices, schema.Invoices);
  var invoice = null;
  for (var i = 1; i < rows.data.length; i++) {
    var o = _rowToObj(rows.hdr, rows.data[i]);
    if (String(o.invoice_id) === id && String(o.tenant_id) === String(s.payload.tid)) {
      invoice = o; break;
    }
  }
  if (!invoice) return _json({ ok:false, error:'Invoice not found' }, 404);
  invoice.payer_display_name = _invPayerDisplayName(ss, s.payload.tid, invoice.payer_id);

  var linesRows = _invDataRows(ss, T.InvoiceLines, schema.Invoice_Lines);
  var lines = [];
  for (var j = 1; j < linesRows.data.length; j++) {
    var l = _rowToObj(linesRows.hdr, linesRows.data[j]);
    if (String(l.invoice_id) === id) lines.push(l);
  }
  return _json({ ok:true, invoice: invoice, lines: lines });
}

function apiCreateInvoice(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  if (!p.payer_id && !p.client_id) return _json({ ok:false, error:'payer_id or client_id required' });
  if (!p.period_start || !p.period_end) return _json({ ok:false, error:'period_start and period_end required (YYYY-MM-DD)' });
  var dryRun = String(p.dry_run || '') === 'true' || String(p.dry_run || '') === '1';

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var schema = _tenantSchema();

  // Resolve client + billing rules if client_id supplied
  var rules = null;
  var clientRow = null;
  if (p.client_id) {
    _ensureTab(ss, T.Clients, schema.Clients);
    _ensureTab(ss, T.ClientBillingRules, schema.Client_Billing_Rules);
    clientRow = _findRowById_(ss, T.Clients, 'client_id', p.client_id, s.payload.tid);
    if (!clientRow) return _json({ ok:false, error:'Client not found' }, 404);
    rules = _filterRows_(ss, T.ClientBillingRules, function (r) {
      return r.client_id === p.client_id && r.tenant_id === s.payload.tid && r.status === 'active';
    })[0] || _defaultBillingRules_(p.client_id, s.payload.tid);
  }

  // Decide which jobs are in scope.
  var requestedIds = String(p.job_ids || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  var candidateJobs;
  if (requestedIds.length) {
    candidateJobs = [];
    for (var i = 0; i < requestedIds.length; i++) {
      var j = _findJob(ss, s.payload.tid, requestedIds[i]);
      if (!j || j.status !== 'COMPLETED') continue;
      if (p.payer_id && String(j.payer_id) !== String(p.payer_id)) continue;
      if (p.client_id && String(j.client_id) !== String(p.client_id)) continue;
      candidateJobs.push(j);
    }
  } else if (p.client_id) {
    candidateJobs = _invListClientJobsInPeriod_(ss, s.payload.tid, p.client_id, p.period_start, p.period_end);
  } else {
    candidateJobs = _invListJobsInPeriod(ss, s.payload.tid, p.payer_id, p.period_start, p.period_end);
  }

  // Skip jobs already on any Invoice_Line.
  var billed = _invAlreadyBilledJobIds(ss);
  var includeJobs = candidateJobs.filter(function (j) { return !billed[String(j.job_id)]; });

  // Split into invoice groups per consolidation rules.
  var groups = _invSplitByConsolidation_(includeJobs, rules);

  // Build line previews per group.
  var groupPreviews = groups.map(function (g) {
    var subtotal = 0;
    var lines = g.jobs.map(function (j) {
      var asgn = _invClaimedAssignment(ss, j.job_id);
      var hours = _invBillableHours(ss, j, asgn);
      var minHours = _invMinHours(ss, j.service_type || 'medical');
      if (hours < minHours) hours = minHours;
      hours = _round2(hours);
      var rateCents = _invRateCents(ss, j.service_type || 'medical', j.modality, j.team_config);
      var amountCents = Math.round(hours * rateCents);
      subtotal += amountCents;
      var initials = _invConsumerInitials(ss, s.payload.tid, j.consumer_id);
      var dateStr = _invShortDate(j.actual_start || j.scheduled_start);
      var serviceLabel = (j.service_type || 'service').replace(/-/g, ' ');
      var specName = _invSpecialistName_(ss, j.specialist_id);
      var locName = _invLocationName_(ss, j.location_id);
      var interpName = asgn ? _invInterpreterDisplayName(ss, s.payload.tid, asgn.interpreter_id) : '';
      var showInit = !rules || rules.show_consumer_initials_on_invoice;
      var showSpec = !rules || rules.show_specialist_on_invoice;
      var showInterp = !rules || rules.show_interpreter_name_on_invoice;
      var descParts = [serviceLabel, dateStr];
      if (showSpec && specName) descParts.push(specName);
      if (locName) descParts.push(locName);
      if (showInit && initials) descParts.push(initials);
      if (showInterp && interpName) descParts.push('w/ ' + interpName);
      return {
        job_id: j.job_id,
        line_kind: 'service',
        client_id: j.client_id || '',
        requestor_id: j.requestor_id || '',
        location_id: j.location_id || '',
        location_name: locName,
        specialist_id: j.specialist_id || '',
        specialist_name: specName,
        consumer_initials: showInit ? initials : '',
        interpreter_id: asgn ? asgn.interpreter_id : '',
        interpreter_name: showInterp ? interpName : '',
        service_type: j.service_type || '',
        modality: j.modality || '',
        scheduled_start: j.scheduled_start || '',
        scheduled_end: j.scheduled_end || '',
        description: descParts.join(' · '),
        quantity: hours,
        unit: 'hour',
        rate_cents: rateCents,
        amount_cents: amountCents
      };
    });
    return { group_key: g.key, payer_id: g.payer_id, subtotal_cents: subtotal, lines: lines };
  });

  if (dryRun) {
    return _json({
      ok: true,
      dry_run: true,
      client_id: p.client_id || '',
      payer_id: p.payer_id || '',
      period_start: p.period_start,
      period_end: p.period_end,
      consolidation_mode: rules ? rules.consolidation_mode : 'one_per_payer',
      groups: groupPreviews,
      total_invoices: groupPreviews.length,
      total_jobs: groupPreviews.reduce(function (n, g) { return n + g.lines.length; }, 0),
      total_cents: groupPreviews.reduce(function (n, g) { return n + g.subtotal_cents; }, 0)
    });
  }

  var totalJobs = groupPreviews.reduce(function (n, g) { return n + g.lines.length; }, 0);
  if (!totalJobs) return _json({ ok:false, error:'No billable jobs in scope.' });

  // Persist each group as its own invoice.
  var invoices = [];
  var now = new Date().toISOString();
  var invRows = _invDataRows(ss, T.Invoices, schema.Invoices);
  var linesRows = _invDataRows(ss, T.InvoiceLines, schema.Invoice_Lines);
  var invHdr = schema.Invoices;
  var lineHdr = schema.Invoice_Lines;

  groupPreviews.forEach(function (g) {
    if (!g.lines.length) return;
    var invoiceId = _ulid('inv');
    var invNumber = _invNextNumber_(ss, s.payload.tid);
    var invObj = {
      invoice_id: invoiceId,
      tenant_id: s.payload.tid,
      client_id: p.client_id || (g.lines[0] && g.lines[0].client_id) || '',
      payer_id: g.payer_id || p.payer_id || '',
      invoice_number: invNumber,
      period_start: p.period_start,
      period_end: p.period_end,
      issued_at: now,
      due_at: p.due_at || '',
      net_terms: (clientRow && clientRow.net_terms) || p.net_terms || 'NET30',
      subtotal_cents: g.subtotal_cents,
      tax_cents: 0,
      total_cents: g.subtotal_cents,
      status: 'draft',
      po_number: p.po_number || '',
      consolidation_mode: rules ? rules.consolidation_mode : 'one_per_payer',
      split_group_key: g.key,
      statement_descriptor: clientRow ? (clientRow.display_name || clientRow.legal_name) : '',
      stripe_invoice_id: '',
      pdf_r2_key: '',
      sent_at: '',
      paid_at: '',
      voided_at: '',
      notes: p.notes || '',
      _created_at: now,
      _updated_at: now
    };
    invRows.sh.appendRow(invHdr.map(function (h) { return invObj[h] !== undefined ? invObj[h] : ''; }));

    g.lines.forEach(function (ln, idx) {
      var rowObj = {
        line_id: _ulid('il'),
        invoice_id: invoiceId,
        job_id: ln.job_id,
        line_kind: ln.line_kind || 'service',
        client_id: ln.client_id || '',
        requestor_id: ln.requestor_id || '',
        location_id: ln.location_id || '',
        specialist_id: ln.specialist_id || '',
        consumer_initials: ln.consumer_initials || '',
        interpreter_id: ln.interpreter_id || '',
        interpreter_name: ln.interpreter_name || '',
        service_type: ln.service_type || '',
        modality: ln.modality || '',
        scheduled_start: ln.scheduled_start || '',
        scheduled_end: ln.scheduled_end || '',
        description: ln.description,
        quantity: ln.quantity,
        unit: ln.unit,
        rate_cents: ln.rate_cents,
        amount_cents: ln.amount_cents,
        sort_order: idx + 1,
        _created_at: now,
        _updated_at: now
      };
      linesRows.sh.appendRow(lineHdr.map(function (h) { return rowObj[h] !== undefined ? rowObj[h] : ''; }));
    });
    invoices.push({
      invoice_id: invoiceId,
      invoice_number: invNumber,
      total_cents: g.subtotal_cents,
      line_count: g.lines.length,
      payer_id: invObj.payer_id,
      split_group_key: g.key
    });
  });

  _logAudit('invoice.create', s.payload.tid, s.payload.uid,
    invoices.map(function (i) { return i.invoice_id; }).join(',') + ' jobs=' + totalJobs);
  return _json({
    ok: true,
    invoices: invoices,
    total_invoices: invoices.length,
    total_jobs: totalJobs,
    total_cents: invoices.reduce(function (n, i) { return n + i.total_cents; }, 0)
  });
}

// Split helpers — invoice consolidation by client billing rules.

function _invSplitByConsolidation_(jobs, rules) {
  if (!rules || rules.consolidation_mode === 'one_per_client') {
    var byPayer = {};
    jobs.forEach(function (j) {
      var k = String(j.payer_id || 'unspecified');
      if (!byPayer[k]) byPayer[k] = { key: 'client:' + k, payer_id: j.payer_id, jobs: [] };
      byPayer[k].jobs.push(j);
    });
    return Object.keys(byPayer).map(function (k) { return byPayer[k]; });
  }
  var mode = rules.consolidation_mode;
  var groups = {};
  jobs.forEach(function (j) {
    var k;
    if      (mode === 'one_per_requestor')   k = 'req:'  + (j.requestor_id || 'none');
    else if (mode === 'one_per_location')    k = 'loc:'  + (j.location_id  || 'none');
    else if (mode === 'one_per_specialist')  k = 'spec:' + (j.specialist_id || 'none');
    else if (mode === 'one_per_job')         k = 'job:'  + j.job_id;
    else                                     k = 'payer:'+ (j.payer_id || 'none');
    if (!groups[k]) groups[k] = { key: k, payer_id: j.payer_id, jobs: [] };
    groups[k].jobs.push(j);
  });
  return Object.keys(groups).map(function (k) { return groups[k]; });
}

function _invListClientJobsInPeriod_(ss, tenantId, clientId, periodStart, periodEnd) {
  var sh = ss.getSheetByName(T.Jobs);
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0];
  var startT = new Date(periodStart + 'T00:00:00Z').getTime();
  var endT = new Date(periodEnd + 'T23:59:59Z').getTime();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (String(o.tenant_id) !== String(tenantId)) continue;
    if (String(o.client_id) !== String(clientId)) continue;
    if (String(o.status) !== 'COMPLETED') continue;
    var refIso = o.actual_end || o.scheduled_end || o.scheduled_start;
    if (!refIso) continue;
    var t = new Date(refIso).getTime();
    if (isNaN(t)) continue;
    if (t < startT || t > endT) continue;
    out.push(o);
  }
  return out;
}

function _invSpecialistName_(ss, specialistId) {
  if (!specialistId) return '';
  var sh = ss.getSheetByName(T.Specialists);
  if (!sh) return '';
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return '';
  var hdr = data[0];
  var iId = hdr.indexOf('specialist_id');
  var iName = hdr.indexOf('display_name');
  if (iId < 0 || iName < 0) return '';
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iId]) === String(specialistId)) return String(data[i][iName] || '');
  }
  return '';
}

function _invLocationName_(ss, locationId) {
  if (!locationId) return '';
  var sh = ss.getSheetByName(T.Locations);
  if (!sh) return '';
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return '';
  var hdr = data[0];
  var iId = hdr.indexOf('location_id');
  var iName = hdr.indexOf('display_name');
  if (iId < 0 || iName < 0) return '';
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iId]) === String(locationId)) return String(data[i][iName] || '');
  }
  return '';
}

function _invNextNumber_(ss, tenantId) {
  // Per-tenant per-year monotonic counter: INV-2026-0001
  var year = new Date().getFullYear();
  var sh = ss.getSheetByName(T.Invoices);
  if (!sh) return 'INV-' + year + '-0001';
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return 'INV-' + year + '-0001';
  var hdr = data[0];
  var iNum = hdr.indexOf('invoice_number');
  var iTen = hdr.indexOf('tenant_id');
  if (iNum < 0) return 'INV-' + year + '-0001';
  var max = 0;
  var prefix = 'INV-' + year + '-';
  for (var i = 1; i < data.length; i++) {
    if (iTen >= 0 && String(data[i][iTen]) !== String(tenantId)) continue;
    var sV = String(data[i][iNum] || '');
    if (sV.indexOf(prefix) !== 0) continue;
    var n = parseInt(sV.substr(prefix.length), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  var next = String(max + 1);
  while (next.length < 4) next = '0' + next;
  return prefix + next;
}

function apiUpdateInvoice(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var p = e.parameter || {};
  if (!p.invoice_id) return _json({ ok:false, error:'invoice_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Invoices);
  if (!sh) return _json({ ok:false, error:'No invoices tab yet' }, 404);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('invoice_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iStatus = hdr.indexOf('status');
  var iDue = hdr.indexOf('due_at');
  var iUpdated = hdr.indexOf('_updated_at');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) === p.invoice_id && String(data[r][iTenant]) === String(s.payload.tid)) {
      if (p.status && iStatus >= 0) sh.getRange(r + 1, iStatus + 1).setValue(p.status);
      if (p.due_at && iDue >= 0) sh.getRange(r + 1, iDue + 1).setValue(p.due_at);
      if (iUpdated >= 0) sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
      _logAudit('invoice.update', s.payload.tid, s.payload.uid, p.invoice_id);
      return _json({ ok:true, invoice_id: p.invoice_id });
    }
  }
  return _json({ ok:false, error:'Invoice not found' }, 404);
}

function apiMarkInvoicePaid(e) {
  // Accept either a user session or a worker JWT (Stripe webhook). Worker
  // calls have tid='*' — we match by invoice_id only and use the row's own
  // tenant_id for the audit log.
  var s = _requireSessionOrWorker(e, 'stripe_webhook');
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  if (!p.invoice_id) return _json({ ok:false, error:'invoice_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Invoices);
  if (!sh) return _json({ ok:false, error:'No invoices tab yet' }, 404);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('invoice_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iStatus = hdr.indexOf('status');
  var iUpdated = hdr.indexOf('_updated_at');
  var paidAt = p.paid_at || new Date().toISOString();
  for (var r = 1; r < data.length; r++) {
    var sameId = String(data[r][iId]) === p.invoice_id;
    var sameTenant = String(data[r][iTenant]) === String(s.payload.tid);
    var match = sameId && (s.is_worker ? true : sameTenant);
    if (match) {
      if (iStatus >= 0) sh.getRange(r + 1, iStatus + 1).setValue('paid');
      if (iUpdated >= 0) sh.getRange(r + 1, iUpdated + 1).setValue(paidAt);
      var rowTenant = String(data[r][iTenant] || '');
      // Emit Job_Events 'invoice_paid' for every linked job.
      var linesSh = ss.getSheetByName(T.InvoiceLines);
      if (linesSh) {
        var ld = linesSh.getDataRange().getValues();
        var lh = ld[0];
        var iInv = lh.indexOf('invoice_id');
        var iJob = lh.indexOf('job_id');
        for (var k = 1; k < ld.length; k++) {
          if (String(ld[k][iInv]) === p.invoice_id) {
            var jobId = String(ld[k][iJob] || '');
            if (jobId) _appendJobEvent(ss, jobId, s.payload.uid, 'invoice_paid', '', '', JSON.stringify({ invoice_id: p.invoice_id, paid_at: paidAt }));
          }
        }
      }
      var auditTid = s.is_worker ? rowTenant : s.payload.tid;
      _logAudit('invoice.mark_paid', auditTid, s.payload.uid, p.invoice_id);
      return _json({ ok:true, invoice_id: p.invoice_id, status: 'paid', paid_at: paidAt });
    }
  }
  return _json({ ok:false, error:'Invoice not found' }, 404);
}

function apiVoidInvoice(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var p = e.parameter || {};
  if (!p.invoice_id) return _json({ ok:false, error:'invoice_id required' });
  if (!p.reason) return _json({ ok:false, error:'reason required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Invoices);
  if (!sh) return _json({ ok:false, error:'No invoices tab yet' }, 404);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('invoice_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iStatus = hdr.indexOf('status');
  var iUpdated = hdr.indexOf('_updated_at');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) === p.invoice_id && String(data[r][iTenant]) === String(s.payload.tid)) {
      if (String(data[r][iStatus]) === 'paid') return _json({ ok:false, error:'Cannot void a paid invoice' });
      if (iStatus >= 0) sh.getRange(r + 1, iStatus + 1).setValue('void');
      if (iUpdated >= 0) sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
      // Remove this invoice's lines so the underlying jobs become re-billable.
      var linesSh = ss.getSheetByName(T.InvoiceLines);
      if (linesSh) {
        var ld = linesSh.getDataRange().getValues();
        var lh = ld[0];
        var iInv = lh.indexOf('invoice_id');
        // Walk bottom-up so row deletions don't shift indexes we still need.
        for (var k = ld.length - 1; k >= 1; k--) {
          if (String(ld[k][iInv]) === p.invoice_id) linesSh.deleteRow(k + 1);
        }
      }
      _logAudit('invoice.void', s.payload.tid, s.payload.uid, p.invoice_id + ' reason=' + p.reason);
      return _json({ ok:true, invoice_id: p.invoice_id, status: 'void' });
    }
  }
  return _json({ ok:false, error:'Invoice not found' }, 404);
}

// ============================================================================
// PAYOUTS
// ============================================================================

function apiListPayouts(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var schema = _tenantSchema();
  var rows = _invDataRows(ss, T.Payouts, schema.Payouts);
  var list = _invForTenant(rows, s.payload.tid);
  // Enrich + YTD per interpreter (calendar-year YTD over status='paid' payouts).
  var ytdByInterp = {};
  var thisYear = new Date().getUTCFullYear();
  list.forEach(function (o) {
    if (String(o.status) === 'paid' && o.issued_at) {
      var y = new Date(o.issued_at).getUTCFullYear();
      if (y === thisYear) {
        ytdByInterp[o.interpreter_id] = (ytdByInterp[o.interpreter_id] || 0) + Number(o.total_cents || 0);
      }
    }
  });
  list.forEach(function (o) {
    o.interpreter_display_name = _invInterpreterDisplayName(ss, s.payload.tid, o.interpreter_id);
    o.ytd_total_cents = ytdByInterp[o.interpreter_id] || 0;
  });
  list.sort(function (a, b) {
    var ta = a.issued_at ? new Date(a.issued_at).getTime() : 0;
    var tb = b.issued_at ? new Date(b.issued_at).getTime() : 0;
    return tb - ta;
  });
  return _json({ ok:true, payouts: list });
}

function apiGetPayout(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var id = (e.parameter && e.parameter.id) || '';
  if (!id) return _json({ ok:false, error:'id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var schema = _tenantSchema();
  var rows = _invDataRows(ss, T.Payouts, schema.Payouts);
  var payout = null;
  for (var i = 1; i < rows.data.length; i++) {
    var o = _rowToObj(rows.hdr, rows.data[i]);
    if (String(o.payout_id) === id && String(o.tenant_id) === String(s.payload.tid)) {
      payout = o; break;
    }
  }
  if (!payout) return _json({ ok:false, error:'Payout not found' }, 404);
  payout.interpreter_display_name = _invInterpreterDisplayName(ss, s.payload.tid, payout.interpreter_id);

  // Lines = the Job_Assignments tracked via Job_Events 'payout_included' for this payout_id.
  var lines = [];
  var sh = ss.getSheetByName(T.JobEvents);
  if (sh) {
    var data = sh.getDataRange().getValues();
    if (data.length >= 2) {
      var hdr = data[0];
      var iType = hdr.indexOf('event_type');
      var iPayload = hdr.indexOf('payload');
      var iJob = hdr.indexOf('job_id');
      for (var j = 1; j < data.length; j++) {
        if (String(data[j][iType]) !== 'payout_included') continue;
        try {
          var pl = JSON.parse(data[j][iPayload] || '{}');
          if (String(pl.payout_id) === id) {
            lines.push({
              job_id: String(data[j][iJob] || ''),
              assignment_id: pl.assignment_id || '',
              hours: pl.hours || 0,
              pay_rate_cents: pl.pay_rate_cents || 0,
              amount_cents: pl.amount_cents || 0,
              service_date: pl.service_date || ''
            });
          }
        } catch (_) {}
      }
    }
  }
  return _json({ ok:true, payout: payout, lines: lines });
}

function apiCreatePayout(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  if (!p.interpreter_id) return _json({ ok:false, error:'interpreter_id required' });
  if (!p.period_start || !p.period_end) return _json({ ok:false, error:'period_start and period_end required' });
  var dryRun = String(p.dry_run || '') === 'true' || String(p.dry_run || '') === '1';

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var schema = _tenantSchema();

  // Collect candidate assignments for this interpreter where the job is COMPLETED and service date in range.
  var asgnSh = ss.getSheetByName(T.JobAssignments);
  if (!asgnSh) return _json({ ok:false, error:'No assignments yet' });
  var ad = asgnSh.getDataRange().getValues();
  if (ad.length < 2) return _json({ ok:false, error:'No assignments yet' });
  var ah = ad[0];

  var startT = new Date(p.period_start + 'T00:00:00Z').getTime();
  var endT = new Date(p.period_end + 'T23:59:59Z').getTime();
  var alreadyPaid = _invAlreadyPaidAssignments(ss);

  var previewLines = [];
  var totalCents = 0;

  for (var i = 1; i < ad.length; i++) {
    var asgn = _rowToObj(ah, ad[i]);
    if (String(asgn.interpreter_id) !== String(p.interpreter_id)) continue;
    if (String(asgn.response) !== 'claim') continue;
    if (alreadyPaid[String(asgn.assignment_id)]) continue;
    var job = _findJob(ss, s.payload.tid, asgn.job_id);
    if (!job || job.status !== 'COMPLETED') continue;
    var refIso = job.actual_end || job.scheduled_end;
    if (!refIso) continue;
    var t = new Date(refIso).getTime();
    if (isNaN(t) || t < startT || t > endT) continue;

    var hours = _round2((Number(asgn.billable_minutes) || 0) / 60);
    if (!hours && job.scheduled_start && job.scheduled_end) {
      hours = _round2(Math.max(0, (new Date(job.scheduled_end).getTime() - new Date(job.scheduled_start).getTime()) / 3600000));
    }
    // pay_rate_snapshot may be JSON; if missing, fall back to 60% of bill-side rate.
    var payRate = 0;
    if (asgn.pay_rate_snapshot) {
      try {
        var snap = JSON.parse(asgn.pay_rate_snapshot);
        if (snap && snap.hourly_cents) payRate = Number(snap.hourly_cents);
      } catch (_) {}
    }
    if (!payRate) {
      var billCents = _invRateCents(ss, job.service_type || 'medical', job.modality, job.team_config);
      payRate = _invPayCentsFallback(billCents);
    }
    var amount = Math.round(hours * payRate);
    totalCents += amount;
    previewLines.push({
      assignment_id: asgn.assignment_id,
      job_id: asgn.job_id,
      hours: hours,
      pay_rate_cents: payRate,
      amount_cents: amount,
      service_date: _invShortDate(job.actual_start || job.scheduled_start)
    });
  }

  if (dryRun) {
    return _json({
      ok: true,
      dry_run: true,
      interpreter_id: p.interpreter_id,
      period_start: p.period_start,
      period_end: p.period_end,
      lines: previewLines,
      total_cents: totalCents,
      line_count: previewLines.length
    });
  }

  if (!previewLines.length) return _json({ ok:false, error:'No unpaid completed assignments for that interpreter + period.' });

  // Persist payout header.
  var poRows = _invDataRows(ss, T.Payouts, schema.Payouts);
  var poHdr = schema.Payouts;
  var payoutId = _ulid('po');
  var now = new Date().toISOString();
  var poObj = {
    payout_id: payoutId,
    tenant_id: s.payload.tid,
    interpreter_id: p.interpreter_id,
    period_start: p.period_start,
    period_end: p.period_end,
    issued_at: now,
    total_cents: totalCents,
    status: 'pending',
    stripe_transfer_id: '',
    _created_at: now,
    _updated_at: now
  };
  var poRow = poHdr.map(function (h) { return poObj[h] !== undefined ? poObj[h] : ''; });
  poRows.sh.appendRow(poRow);

  // Mark each assignment via Job_Events 'payout_included' (this is the dedupe ledger).
  previewLines.forEach(function (ln) {
    _appendJobEvent(ss, ln.job_id, s.payload.uid, 'payout_included', '', '', JSON.stringify({
      payout_id: payoutId,
      assignment_id: ln.assignment_id,
      hours: ln.hours,
      pay_rate_cents: ln.pay_rate_cents,
      amount_cents: ln.amount_cents,
      service_date: ln.service_date
    }));
  });

  _logAudit('payout.create', s.payload.tid, s.payload.uid, payoutId + ' assignments=' + previewLines.length);
  return _json({ ok:true, payout_id: payoutId, total_cents: totalCents, line_count: previewLines.length });
}

function apiMarkPayoutPaid(e) {
  // Accept either a user session or a worker JWT (Stripe webhook). Worker
  // calls have tid='*' — we match by payout_id only and use the row's own
  // tenant_id for the audit log.
  var s = _requireSessionOrWorker(e, 'stripe_webhook');
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  if (!p.payout_id) return _json({ ok:false, error:'payout_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Payouts);
  if (!sh) return _json({ ok:false, error:'No payouts tab yet' }, 404);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('payout_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iStatus = hdr.indexOf('status');
  var iStripe = hdr.indexOf('stripe_transfer_id');
  var iIssued = hdr.indexOf('issued_at');
  var iUpdated = hdr.indexOf('_updated_at');
  var paidAt = p.paid_at || new Date().toISOString();
  for (var r = 1; r < data.length; r++) {
    var sameId = String(data[r][iId]) === p.payout_id;
    var sameTenant = String(data[r][iTenant]) === String(s.payload.tid);
    var match = sameId && (s.is_worker ? true : sameTenant);
    if (match) {
      if (iStatus >= 0) sh.getRange(r + 1, iStatus + 1).setValue('paid');
      if (p.stripe_transfer_id && iStripe >= 0) sh.getRange(r + 1, iStripe + 1).setValue(p.stripe_transfer_id);
      if (iIssued >= 0 && !data[r][iIssued]) sh.getRange(r + 1, iIssued + 1).setValue(paidAt);
      if (iUpdated >= 0) sh.getRange(r + 1, iUpdated + 1).setValue(paidAt);
      var auditTid = s.is_worker ? String(data[r][iTenant] || '*') : s.payload.tid;
      _logAudit('payout.mark_paid', auditTid, s.payload.uid, p.payout_id);
      return _json({ ok:true, payout_id: p.payout_id, status: 'paid', paid_at: paidAt });
    }
  }
  return _json({ ok:false, error:'Payout not found' }, 404);
}


// ============================================================================
// PDF GENERATION — invoice + payout (HTML → PDF via Drive API)
// ============================================================================
//
// Apps Script can convert HTML → PDF by creating a Google Doc from HTML bytes,
// then exporting as PDF. We do it via the Drive Advanced Service which we
// don't have enabled — so we use Blob.getAs('application/pdf') which calls
// Drive's HTML → PDF converter under the hood.

function apiInvoicePdf(e) {
  var s = _requireSession(e);
  if (!s.ok) return _serveText('Forbidden', 401);
  var invoiceId = e.parameter.id;
  if (!invoiceId) return _serveText('id required', 400);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var invoice = _findInvoice(ss, s.payload.tid, invoiceId);
  if (!invoice) return _serveText('Invoice not found', 404);
  var lines = _findInvoiceLines(ss, invoiceId);
  // Sort lines: by location, then specialist, then scheduled_start
  lines.sort(function (a, b) {
    var loc = String(a.location_id || '').localeCompare(String(b.location_id || ''));
    if (loc !== 0) return loc;
    var spec = String(a.specialist_id || '').localeCompare(String(b.specialist_id || ''));
    if (spec !== 0) return spec;
    return String(a.scheduled_start || '').localeCompare(String(b.scheduled_start || ''));
  });
  var agency = _findAgency(ss, s.payload.tid);
  var payer = _findPayerOrRequestor(ss, s.payload.tid, invoice.payer_id);
  var client = invoice.client_id ? _findRowById_(ss, T.Clients, 'client_id', invoice.client_id, s.payload.tid) : null;

  var html = _renderInvoiceHtml(agency, invoice, lines, payer, client);
  var pdfBlob = Utilities.newBlob(html, 'text/html', 'invoice-' + invoiceId + '.html').getAs('application/pdf');
  pdfBlob.setName(invoiceId + '.pdf');
  _logAudit('invoice.pdf_generated', s.payload.tid, s.payload.uid, invoiceId);

  // Stream PDF inline
  var b64 = Utilities.base64Encode(pdfBlob.getBytes());
  // Apps Script can't return raw binary with custom Content-Type. Workaround:
  // return HTML that does a meta-refresh data:application/pdf URL. Works in
  // every modern browser; user can save-as PDF.
  var dataUrl = 'data:application/pdf;base64,' + b64;
  var wrapper =
    '<!doctype html><html><head><meta charset="utf-8"><title>Invoice ' + invoiceId + '.pdf</title>' +
    '<style>html,body{margin:0;padding:0;height:100%;font-family:system-ui}embed{width:100%;height:100%;border:0}</style>' +
    '</head><body><embed src="' + dataUrl + '" type="application/pdf"></body></html>';
  return HtmlService.createHtmlOutput(wrapper).setTitle(invoiceId + '.pdf').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function apiPayoutPdf(e) {
  var s = _requireSession(e);
  if (!s.ok) return _serveText('Forbidden', 401);
  var payoutId = e.parameter.id;
  if (!payoutId) return _serveText('id required', 400);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var payout = _findPayout(ss, s.payload.tid, payoutId);
  if (!payout) return _serveText('Payout not found', 404);
  var interpreter = _findInterpreterById(ss, payout.interpreter_id);
  var agency = _findAgency(ss, s.payload.tid);
  // Pull the assignments included in this payout from Job_Events
  var lines = _findPayoutLines(ss, payoutId);

  var html = _renderPayoutHtml(agency, payout, lines, interpreter);
  var pdfBlob = Utilities.newBlob(html, 'text/html', 'payout-' + payoutId + '.html').getAs('application/pdf');
  pdfBlob.setName(payoutId + '.pdf');
  _logAudit('payout.pdf_generated', s.payload.tid, s.payload.uid, payoutId);

  var b64 = Utilities.base64Encode(pdfBlob.getBytes());
  var dataUrl = 'data:application/pdf;base64,' + b64;
  var wrapper =
    '<!doctype html><html><head><meta charset="utf-8"><title>Payout ' + payoutId + '.pdf</title>' +
    '<style>html,body{margin:0;padding:0;height:100%;font-family:system-ui}embed{width:100%;height:100%;border:0}</style>' +
    '</head><body><embed src="' + dataUrl + '" type="application/pdf"></body></html>';
  return HtmlService.createHtmlOutput(wrapper).setTitle(payoutId + '.pdf').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function _serveText(msg, status) {
  return ContentService.createTextOutput(msg + (status ? ' (' + status + ')' : ''))
    .setMimeType(ContentService.MimeType.TEXT);
}

// ---- PDF helpers ----------------------------------------------------------

function _findInvoice(ss, tenantId, invoiceId) {
  var sh = ss.getSheetByName(T.Invoices);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id === tenantId && o.invoice_id === invoiceId) return o;
  }
  return null;
}

function _findInvoiceLines(ss, invoiceId) {
  var sh = ss.getSheetByName(T.InvoiceLines);
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.invoice_id === invoiceId) out.push(o);
  }
  return out;
}

function _findAgency(ss, tenantId) {
  var sh = ss.getSheetByName(T.Agencies);
  if (!sh) return {};
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return {};
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id === tenantId) return o;
  }
  return {};
}

function _findPayerOrRequestor(ss, tenantId, id) {
  if (!id) return { display_name: '(no payer)' };
  // Payers first
  var sh = ss.getSheetByName(T.Payers);
  if (sh) {
    var data = sh.getDataRange().getValues();
    if (data.length >= 2) {
      var hdr = data[0];
      for (var i = 1; i < data.length; i++) {
        var o = _rowToObj(hdr, data[i]);
        if (o.tenant_id === tenantId && o.payer_id === id) return o;
      }
    }
  }
  // Fall back to Requestors
  sh = ss.getSheetByName(T.Requestors);
  if (sh) {
    var data2 = sh.getDataRange().getValues();
    if (data2.length >= 2) {
      var hdr2 = data2[0];
      for (var j = 1; j < data2.length; j++) {
        var o2 = _rowToObj(hdr2, data2[j]);
        if (o2.tenant_id === tenantId && o2.requestor_id === id) return o2;
      }
    }
  }
  return { display_name: '(unknown)' };
}

function _findPayout(ss, tenantId, payoutId) {
  var sh = ss.getSheetByName(T.Payouts);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id === tenantId && o.payout_id === payoutId) return o;
  }
  return null;
}

function _findInterpreterById(ss, interpreterId) {
  var sh = ss.getSheetByName(T.Interpreters);
  if (!sh) return {};
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return {};
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.interpreter_id === interpreterId) return o;
  }
  return {};
}

function _findPayoutLines(ss, payoutId) {
  var sh = ss.getSheetByName(T.JobEvents);
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.event_type !== 'payout_included') continue;
    try {
      var p = JSON.parse(o.payload || '{}');
      if (p.payout_id === payoutId) out.push(Object.assign({}, o, p));
    } catch (_) {}
  }
  return out;
}

function _fmtMoney(cents) {
  var n = Number(cents || 0) / 100;
  return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function _fmtDate(iso) {
  if (!iso) return '—';
  try {
    return Utilities.formatDate(new Date(iso), 'America/New_York', 'MMM d, yyyy');
  } catch (_) { return iso; }
}
function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
  });
}

function _pdfCss(brandColor) {
  brandColor = brandColor || '#C8553D';
  return [
    'body{font-family:system-ui,-apple-system,sans-serif;color:#0F1419;padding:40px 48px;max-width:780px;margin:0 auto;font-size:13px;line-height:1.5}',
    'header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid ' + brandColor + ';padding-bottom:16px;margin-bottom:24px}',
    '.lockup{font-family:"Iowan Old Style",Georgia,serif;font-weight:700;font-size:22px;letter-spacing:-.01em}',
    '.lockup small{display:block;font-family:system-ui;font-weight:500;font-size:12px;color:#5C6670;margin-top:2px}',
    '.doc-meta{text-align:right;font-size:12px}',
    '.doc-meta h1{margin:0;font-family:"Iowan Old Style",Georgia,serif;font-size:24px;color:' + brandColor + '}',
    '.doc-meta .id{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#5C6670;margin-top:4px}',
    '.party{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:24px 0}',
    '.party h2{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#5C6670;margin:0 0 6px;font-weight:700}',
    '.party .name{font-weight:600;font-size:14px}',
    'table{width:100%;border-collapse:collapse;margin:16px 0}',
    'th{text-align:left;border-bottom:2px solid #0F1419;padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.08em}',
    'td{padding:10px;border-bottom:1px solid #E4E0D6;font-size:12.5px;vertical-align:top}',
    'td.right{text-align:right;font-variant-numeric:tabular-nums}',
    '.totals{margin-left:auto;width:280px;margin-top:8px}',
    '.totals td{border-bottom:0;padding:4px 10px}',
    '.totals .total td{border-top:2px solid #0F1419;font-weight:700;font-size:14px;padding-top:8px}',
    '.terms{margin-top:32px;padding:14px 18px;background:#FAFAF7;border-left:4px solid ' + brandColor + ';font-size:12px;border-radius:4px}',
    'footer{margin-top:40px;padding-top:14px;border-top:1px solid #E4E0D6;font-size:11px;color:#5C6670;display:flex;justify-content:space-between}',
    '.tag{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:#9B958A}'
  ].join('');
}

function _renderInvoiceHtml(agency, invoice, lines, payer, client) {
  var styles = _pdfCss(agency.brand_color);
  // Decide which columns to display based on whether any line carries that field.
  var hasLoc = lines.some(function (l) { return l.location_id; });
  var hasSpec = lines.some(function (l) { return l.specialist_id; });
  var hasInit = lines.some(function (l) { return l.consumer_initials; });
  var hasInterp = lines.some(function (l) { return l.interpreter_name; });

  // Cache lookups so we don't refetch per row.
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var locCache = {}, specCache = {};
  function locName(id) {
    if (!id) return '';
    if (locCache[id] !== undefined) return locCache[id];
    locCache[id] = _invLocationName_(ss, id);
    return locCache[id];
  }
  function specName(id) {
    if (!id) return '';
    if (specCache[id] !== undefined) return specCache[id];
    specCache[id] = _invSpecialistName_(ss, id);
    return specCache[id];
  }

  var thead = '<tr>' +
    '<th>Date</th>' +
    '<th>Service</th>' +
    (hasLoc  ? '<th>Location</th>'  : '') +
    (hasSpec ? '<th>Specialist</th>': '') +
    (hasInit ? '<th>Consumer</th>'  : '') +
    (hasInterp ? '<th>Interpreter</th>' : '') +
    '<th class="right">Qty</th>' +
    '<th>Unit</th>' +
    '<th class="right">Rate</th>' +
    '<th class="right">Amount</th>' +
  '</tr>';

  var rows = lines.map(function (l) {
    var date = _fmtDate(l.scheduled_start) || '—';
    var serviceLabel = (l.service_type || '').replace(/-/g, ' ');
    if (l.modality) serviceLabel = serviceLabel + ' (' + (l.modality || '') + ')';
    return '<tr>' +
      '<td>' + _esc(date) + '</td>' +
      '<td>' + _esc(serviceLabel || l.description || '—') + '</td>' +
      (hasLoc  ? '<td>' + _esc(locName(l.location_id))   + '</td>' : '') +
      (hasSpec ? '<td>' + _esc(specName(l.specialist_id)) + '</td>' : '') +
      (hasInit ? '<td>' + _esc(l.consumer_initials || '') + '</td>' : '') +
      (hasInterp ? '<td>' + _esc(l.interpreter_name || '') + '</td>' : '') +
      '<td class="right">' + _esc(l.quantity || '') + '</td>' +
      '<td>' + _esc(l.unit || '') + '</td>' +
      '<td class="right">' + _fmtMoney(l.rate_cents) + '</td>' +
      '<td class="right">' + _fmtMoney(l.amount_cents) + '</td>' +
    '</tr>';
  }).join('');

  // "Bill to" block prefers client over payer; falls back to payer/requestor if no client.
  var billToName = (client && (client.display_name || client.legal_name)) || payer.display_name || '(no payer)';
  var billToEmail = (client && client.billing_email) || payer.billing_email || '';
  var billToAddr = (client && client.billing_address) || payer.billing_address || '';
  var billToPhone = (client && client.billing_phone) || '';

  var consolidationLabel = invoice.consolidation_mode
    ? invoice.consolidation_mode.replace(/_/g, ' ').replace(/\bone per\b/, '1 per')
    : '';

  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>' + styles + '</style></head><body>',
    '<header>',
    '  <div>',
    '    <div class="lockup">' + _esc(agency.legal_name || '1891 Interpreter') + '<small>powered by 1891 Interpreter</small></div>',
    (agency.billing_email ? '    <div style="font-size:12px;color:#5C6670;margin-top:6px">' + _esc(agency.billing_email) + '</div>' : ''),
    '  </div>',
    '  <div class="doc-meta">',
    '    <h1>Invoice</h1>',
    '    <div class="id">' + _esc(invoice.invoice_number || invoice.invoice_id) + '</div>',
    '    <div style="margin-top:8px"><strong>Issued:</strong> ' + _fmtDate(invoice.issued_at) + '</div>',
    '    <div><strong>Due:</strong> ' + _fmtDate(invoice.due_at) + '</div>',
    '    <div><strong>Status:</strong> ' + _esc(invoice.status || 'draft') + '</div>',
    (invoice.po_number ? '    <div><strong>PO:</strong> ' + _esc(invoice.po_number) + '</div>' : ''),
    '  </div>',
    '</header>',
    '<section class="party">',
    '  <div><h2>From</h2><div class="name">' + _esc(agency.legal_name || '1891 Interpreter') + '</div></div>',
    '  <div><h2>Bill to</h2><div class="name">' + _esc(billToName) + '</div>' +
    (client && payer.display_name && payer.display_name !== billToName ? '<div style="font-size:12px;color:#5C6670;margin-top:2px">via ' + _esc(payer.display_name) + '</div>' : '') +
    (billToEmail ? '<div style="font-size:12px;color:#5C6670;margin-top:2px">' + _esc(billToEmail) + '</div>' : '') +
    (billToPhone ? '<div style="font-size:12px;color:#5C6670">' + _esc(billToPhone) + '</div>' : '') +
    (billToAddr ? '<div style="font-size:12px;color:#5C6670;margin-top:2px;white-space:pre-line">' + _esc(billToAddr) + '</div>' : '') +
    '</div>',
    '</section>',
    '<div><strong>Service period:</strong> ' + _fmtDate(invoice.period_start) + ' &mdash; ' + _fmtDate(invoice.period_end) +
    (consolidationLabel ? ' &middot; <span style="color:#5C6670">consolidation: ' + _esc(consolidationLabel) + '</span>' : '') + '</div>',
    '<table>',
    '  <thead>' + thead + '</thead>',
    '  <tbody>' + rows + '</tbody>',
    '</table>',
    '<table class="totals">',
    '  <tr><td>Subtotal</td><td class="right">' + _fmtMoney(invoice.subtotal_cents) + '</td></tr>',
    (Number(invoice.tax_cents || 0) ? '  <tr><td>Tax</td><td class="right">' + _fmtMoney(invoice.tax_cents) + '</td></tr>' : ''),
    '  <tr class="total"><td>Total due</td><td class="right">' + _fmtMoney(invoice.total_cents) + '</td></tr>',
    '</table>',
    '<div class="terms">',
    '  ' + _esc(invoice.net_terms || 'Net 30') + ' from issue date unless otherwise agreed. Late payments after the due date may incur fees per the master services agreement. Consumer identifiers on this invoice are redacted per HIPAA minimum-necessary rules.',
    '</div>',
    '<footer>',
    '  <div>Generated ' + _fmtDate(new Date().toISOString()) + '</div>',
    '  <div class="tag">' + _esc(invoice.invoice_id) + ' &middot; tenant: ' + _esc(invoice.tenant_id) + '</div>',
    '</footer>',
    '</body></html>'
  ].join('\n');
}

function _renderPayoutHtml(agency, payout, lines, interpreter) {
  var styles = _pdfCss(agency.brand_color);
  var rows = lines.map(function (l) {
    return '<tr>' +
      '<td>' + _esc(l.description || ('Assignment ' + (l.assignment_id || '—'))) + '</td>' +
      '<td>' + _esc(l.service_type || '') + '</td>' +
      '<td class="right">' + _esc(l.billable_minutes || '') + '</td>' +
      '<td class="right">' + _fmtMoney(l.pay_rate_cents || l.rate_cents) + '</td>' +
      '<td class="right">' + _fmtMoney(l.amount_cents) + '</td>' +
    '</tr>';
  }).join('');
  var name = (interpreter.legal_first || '') + ' ' + (interpreter.legal_last || '');
  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>' + styles + '</style></head><body>',
    '<header>',
    '  <div><div class="lockup">' + _esc(agency.legal_name || '1891 Interpreter') + '<small>powered by 1891 Interpreter</small></div></div>',
    '  <div class="doc-meta">',
    '    <h1>Payout statement</h1>',
    '    <div class="id">' + _esc(payout.payout_id) + '</div>',
    '    <div style="margin-top:8px"><strong>Issued:</strong> ' + _fmtDate(payout.issued_at) + '</div>',
    '    <div><strong>Status:</strong> ' + _esc(payout.status || 'draft') + '</div>',
    '  </div>',
    '</header>',
    '<section class="party">',
    '  <div><h2>From</h2><div class="name">' + _esc(agency.legal_name || '1891 Interpreter') + '</div></div>',
    '  <div><h2>Paid to</h2><div class="name">' + _esc(name.trim() || interpreter.interpreter_id || '—') + '</div>' +
    (interpreter.classification ? '<div style="font-size:12px;color:#5C6670;margin-top:2px">' + _esc(interpreter.classification) + '</div>' : '') + '</div>',
    '</section>',
    '<div><strong>Service period:</strong> ' + _fmtDate(payout.period_start) + ' &mdash; ' + _fmtDate(payout.period_end) + '</div>',
    '<table>',
    '  <thead><tr><th>Description</th><th>Type</th><th class="right">Minutes</th><th class="right">Rate</th><th class="right">Amount</th></tr></thead>',
    '  <tbody>' + (rows || '<tr><td colspan="5" style="color:#5C6670;text-align:center">No lines.</td></tr>') + '</tbody>',
    '</table>',
    '<table class="totals">',
    '  <tr class="total"><td>Total paid</td><td class="right">' + _fmtMoney(payout.total_cents) + '</td></tr>',
    '</table>',
    (payout.stripe_transfer_id ? '<div class="terms"><strong>Stripe transfer:</strong> ' + _esc(payout.stripe_transfer_id) + '</div>' : ''),
    '<footer>',
    '  <div>Generated ' + _fmtDate(new Date().toISOString()) + '</div>',
    '  <div class="tag">' + _esc(payout.payout_id) + ' &middot; tenant: ' + _esc(payout.tenant_id) + '</div>',
    '</footer>',
    '</body></html>'
  ].join('\n');
}
