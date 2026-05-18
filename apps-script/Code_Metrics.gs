/**
 * 1891 Interpreter — agency health metrics.
 *
 * Aggregator endpoint for the agency dashboard. One call returns:
 *
 *   roster        — total interpreters, active, available now (no claimed job
 *                   overlapping with `now`), and CDI-eligible count
 *   jobs          — counts by status, with time-windowed slices (today, next 7d,
 *                   last 30d)
 *   fill_rate     — % of OPEN jobs that got filled before scheduled_start, over
 *                   the trailing 30 days
 *   time_to_fill  — median minutes from job creation to first claim, last 30d
 *   utilization   — per-interpreter billable_minutes / available_capacity in
 *                   the last 30 days. We approximate available_capacity as
 *                   40h/week × 4 weeks = 9600 min, capped per-interpreter.
 *   doc_health    — count of interpreters with all required docs current vs.
 *                   missing/expired
 *   languages     — top 5 languages by job count last 30d
 *   service_types — share by service type last 30d
 *   trends        — last 12 weeks of job count for sparkline rendering
 *
 * Owner/admin/scheduler-gated.
 */

function apiAgencyHealth(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (['role_owner','role_admin','role_manager','role_scheduler','role_platform_staff'].indexOf(s.payload.role) < 0) {
    return _json({ ok:false, error:'Owner / manager / scheduler role required' }, 403);
  }
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var tid = s.payload.tid;
  var now = new Date();
  var nowMs = now.getTime();
  var day = 86400000;

  // Pre-load tabs once
  var interpreters = _allRowsFor_(ss, T.Interpreters, tid);
  var jobs = _allRowsFor_(ss, T.Jobs, tid);
  var assignments = _allRowsForNoTenant_(ss, T.JobAssignments);
  var jobIdToTenant = {};
  jobs.forEach(function (j) { jobIdToTenant[j.job_id] = j.tenant_id; });
  var tenantAssignments = assignments.filter(function (a) {
    return jobIdToTenant[a.job_id] === tid;
  });
  var reqs = _allRowsFor_(ss, T.TenantRequirements, tid);
  var docs = _allRowsFor_(ss, T.InterpreterDocuments, tid);
  var docsByInterp = {};
  docs.forEach(function (d) {
    (docsByInterp[d.interpreter_id] = docsByInterp[d.interpreter_id] || []).push(d);
  });
  // v18 — pull clients + invoices for the new metrics blocks
  var clients = _allRowsFor_(ss, T.Clients, tid);
  var clientById = {};
  clients.forEach(function (c) { clientById[c.client_id] = c; });
  var invoices = _allRowsFor_(ss, T.Invoices, tid);

  // ---------- Roster ----------
  var rosterActive = interpreters.filter(function (i) { return i.status === 'active'; });
  var cdiCount = rosterActive.filter(function (i) { return i.deaf === true || i.deaf === 'true' || i.deaf === 'TRUE'; }).length;

  // Available now: interpreter has NO assignment whose job's scheduled_start <= now <= scheduled_end
  var availableNow = rosterActive.filter(function (i) {
    var busy = tenantAssignments.some(function (a) {
      if (a.interpreter_id !== i.interpreter_id) return false;
      if (a.status !== 'CLAIMED' && a.status !== 'CONFIRMED' && a.status !== 'IN_PROGRESS' && a.status !== 'EN_ROUTE') return false;
      var job = jobs.find(function (j) { return j.job_id === a.job_id; });
      if (!job) return false;
      var start = new Date(job.scheduled_start).getTime();
      var end = new Date(job.scheduled_end || start + 3600000).getTime();
      return start <= nowMs && nowMs <= end;
    });
    return !busy;
  }).length;

  // ---------- Jobs by status ----------
  var statusCounts = {};
  jobs.forEach(function (j) { statusCounts[j.status] = (statusCounts[j.status] || 0) + 1; });

  // Today / Next 7d / Last 30d
  function inWindow(j, startMs, endMs) {
    var t = new Date(j.scheduled_start).getTime();
    return t >= startMs && t < endMs;
  }
  var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  var todayEnd = todayStart + day;
  var next7Start = nowMs;
  var next7End = nowMs + 7 * day;
  var last30Start = nowMs - 30 * day;
  var last30End = nowMs;

  var today = jobs.filter(function (j) { return inWindow(j, todayStart, todayEnd); });
  var next7 = jobs.filter(function (j) { return inWindow(j, next7Start, next7End); });
  var last30 = jobs.filter(function (j) { return inWindow(j, last30Start, last30End); });

  // ---------- Fill rate ----------
  // % of jobs scheduled in last 30d (and at status >= CLAIMED) that have at
  // least one claimed Assignment whose responded_at < scheduled_start.
  var fillableLast30 = last30.filter(function (j) {
    return ['CLAIMED','CONFIRMED','EN_ROUTE','IN_PROGRESS','COMPLETED','BILLED','PAID'].indexOf(j.status) >= 0;
  });
  var filledOnTime = 0;
  fillableLast30.forEach(function (j) {
    var hit = tenantAssignments.some(function (a) {
      if (a.job_id !== j.job_id) return false;
      if (a.response !== 'claim') return false;
      if (!a.responded_at) return false;
      return new Date(a.responded_at).getTime() <= new Date(j.scheduled_start).getTime();
    });
    if (hit) filledOnTime++;
  });
  var fillRatePct = fillableLast30.length ? Math.round(100 * filledOnTime / fillableLast30.length) : null;

  // Total fill rate (any status that was filled — including OPEN that never got a claim)
  var allLast30 = last30;
  var anyClaimed = 0;
  allLast30.forEach(function (j) {
    var hit = tenantAssignments.some(function (a) { return a.job_id === j.job_id && a.response === 'claim'; });
    if (hit) anyClaimed++;
  });
  var fillRateAllPct = allLast30.length ? Math.round(100 * anyClaimed / allLast30.length) : null;

  // ---------- Time-to-fill (median minutes from job _created_at to first claim) ----------
  var fillTimes = [];
  allLast30.forEach(function (j) {
    var earliestClaim = null;
    tenantAssignments.forEach(function (a) {
      if (a.job_id !== j.job_id || a.response !== 'claim' || !a.responded_at) return;
      var t = new Date(a.responded_at).getTime();
      if (earliestClaim === null || t < earliestClaim) earliestClaim = t;
    });
    if (earliestClaim !== null && j._created_at) {
      var ms = earliestClaim - new Date(j._created_at).getTime();
      if (ms > 0) fillTimes.push(ms);
    }
  });
  var medianTimeToFillMin = fillTimes.length ? Math.round(_median_(fillTimes) / 60000) : null;
  var avgTimeToFillMin = fillTimes.length ? Math.round((fillTimes.reduce(function (a, b) { return a + b; }, 0) / fillTimes.length) / 60000) : null;

  // ---------- Utilization (per interpreter) ----------
  var capacityMin = 40 * 4 * 60; // 9600 min / month placeholder
  var utilByInterp = {};
  rosterActive.forEach(function (i) {
    utilByInterp[i.interpreter_id] = {
      interpreter_id: i.interpreter_id,
      display_name: (i.legal_first || '') + ' ' + (i.legal_last || ''),
      billed_minutes: 0,
      jobs_claimed: 0,
      utilization_pct: 0
    };
  });
  tenantAssignments.forEach(function (a) {
    if (a.response !== 'claim') return;
    var job = jobs.find(function (j) { return j.job_id === a.job_id; });
    if (!job) return;
    var ts = new Date(job.scheduled_start).getTime();
    if (ts < last30Start || ts > last30End) return;
    if (!utilByInterp[a.interpreter_id]) return;
    utilByInterp[a.interpreter_id].billed_minutes += Number(a.billable_minutes || 0);
    utilByInterp[a.interpreter_id].jobs_claimed += 1;
  });
  Object.keys(utilByInterp).forEach(function (k) {
    utilByInterp[k].utilization_pct = Math.round(100 * utilByInterp[k].billed_minutes / capacityMin);
  });

  var utilArr = Object.keys(utilByInterp).map(function (k) { return utilByInterp[k]; });
  utilArr.sort(function (a, b) { return b.billed_minutes - a.billed_minutes; });

  // ---------- Doc health ----------
  var compliant = 0, missing = 0, expired = 0, expiringSoon = 0;
  rosterActive.forEach(function (i) {
    var myDocs = docsByInterp[i.interpreter_id] || [];
    // Apply universal reqs only (svc='*') for the agency-wide compliance check
    var universalReqs = reqs.filter(function (r) { return r.applies_to_service_type === '*' && (r.required === true || r.required === 'true' || r.required === 'TRUE'); });
    var miss = 0, exp = 0, soon = 0;
    universalReqs.forEach(function (req) {
      var d = myDocs.find(function (x) { return x.doc_type === req.doc_type; });
      if (!d || d.status === 'rejected' || d.status === 'pending') { miss++; return; }
      if (d.expires_at && new Date(d.expires_at).getTime() < nowMs) { exp++; return; }
      if (d.expires_at && new Date(d.expires_at).getTime() - nowMs < 30 * day) soon++;
    });
    if (miss === 0 && exp === 0) compliant++;
    if (miss > 0) missing++;
    if (exp > 0) expired++;
    if (soon > 0 && miss === 0 && exp === 0) expiringSoon++;
  });

  // ---------- Languages + service types (last 30d) ----------
  var langCounts = {}, svcCounts = {};
  last30.forEach(function (j) {
    var key = j.target_language_id || 'unknown';
    langCounts[key] = (langCounts[key] || 0) + 1;
    var s = j.service_type || 'unknown';
    svcCounts[s] = (svcCounts[s] || 0) + 1;
  });
  var langTop = Object.keys(langCounts).map(function (k) { return { language: k, count: langCounts[k] }; }).sort(function (a, b) { return b.count - a.count; }).slice(0, 5);
  var svcTop = Object.keys(svcCounts).map(function (k) { return { service_type: k, count: svcCounts[k] }; }).sort(function (a, b) { return b.count - a.count; });

  // ---------- Weekly trend (last 12 weeks) ----------
  var weekly = [];
  for (var w = 11; w >= 0; w--) {
    var weekEnd = nowMs - w * 7 * day;
    var weekStart = weekEnd - 7 * day;
    var count = jobs.filter(function (j) {
      var t = new Date(j.scheduled_start).getTime();
      return t >= weekStart && t < weekEnd;
    }).length;
    var label = new Date(weekStart);
    weekly.push({
      week_start: Utilities.formatDate(label, 'America/New_York', 'MMM d'),
      count: count
    });
  }

  // ---------- Clients (v18) ----------
  var activeClients = clients.filter(function (c) { return c.status === 'active'; });
  // Aggregate jobs by client_id, last 30d
  var jobsByClient = {};
  last30.forEach(function (j) {
    var cid = j.client_id || '';
    if (!cid) return;
    (jobsByClient[cid] = jobsByClient[cid] || []).push(j);
  });
  // Top 5 clients by job volume (last 30d)
  var topClientsVolume = Object.keys(jobsByClient).map(function (cid) {
    var c = clientById[cid] || {};
    var byStatus = {};
    jobsByClient[cid].forEach(function (j) { byStatus[j.status] = (byStatus[j.status] || 0) + 1; });
    return {
      client_id: cid,
      display_name: c.display_name || c.legal_name || '(unknown)',
      industry: c.industry || '',
      job_count: jobsByClient[cid].length,
      completed: byStatus.COMPLETED || 0,
      open: byStatus.OPEN || 0,
      cancelled: (byStatus.CANCELLED || 0) + (byStatus.CANCELLED_BY_AGENCY || 0) + (byStatus.CANCELLED_BY_REQUESTOR || 0)
    };
  }).sort(function (a, b) { return b.job_count - a.job_count; }).slice(0, 5);

  // Outstanding A/R by client — sum of unpaid invoice totals
  var arByClient = {};
  invoices.forEach(function (inv) {
    if (inv.status === 'paid' || inv.status === 'voided') return;
    var cid = inv.client_id || '';
    if (!cid) return;
    arByClient[cid] = (arByClient[cid] || 0) + Number(inv.total_cents || 0);
  });
  var topClientsAR = Object.keys(arByClient).map(function (cid) {
    var c = clientById[cid] || {};
    return {
      client_id: cid,
      display_name: c.display_name || c.legal_name || '(unknown)',
      outstanding_cents: arByClient[cid]
    };
  }).sort(function (a, b) { return b.outstanding_cents - a.outstanding_cents; }).slice(0, 5);

  return _json({
    ok: true,
    snapshot_at: new Date().toISOString(),
    tenant_id: tid,
    roster: {
      total: interpreters.length,
      active: rosterActive.length,
      available_now: availableNow,
      cdi_eligible: cdiCount,
      languages_covered: _countUniqueLanguages_(rosterActive)
    },
    jobs: {
      by_status: statusCounts,
      today: today.length,
      today_open: today.filter(function (j) { return j.status === 'OPEN'; }).length,
      next_7d: next7.length,
      last_30d: last30.length,
      open_now: jobs.filter(function (j) { return j.status === 'OPEN'; }).length,
      offered_now: jobs.filter(function (j) { return j.status === 'OFFERED'; }).length,
      in_progress_now: jobs.filter(function (j) { return j.status === 'IN_PROGRESS'; }).length
    },
    fill_rate: {
      on_time_pct_30d: fillRatePct,
      total_pct_30d: fillRateAllPct,
      total_fillable_30d: fillableLast30.length,
      filled_on_time_30d: filledOnTime
    },
    time_to_fill: {
      median_minutes_30d: medianTimeToFillMin,
      avg_minutes_30d: avgTimeToFillMin,
      sample_size: fillTimes.length
    },
    utilization: {
      capacity_minutes_per_interpreter: capacityMin,
      interpreters: utilArr
    },
    doc_health: {
      compliant: compliant,
      missing: missing,
      expired: expired,
      expiring_soon: expiringSoon
    },
    languages_top: langTop,
    service_types: svcTop,
    weekly_trend: weekly,
    clients: {
      total: clients.length,
      active: activeClients.length,
      top_by_volume_30d: topClientsVolume,
      top_outstanding_ar: topClientsAR,
      outstanding_total_cents: Object.keys(arByClient).reduce(function (n, k) { return n + arByClient[k]; }, 0)
    }
  });
}

function _allRowsForNoTenant_(ss, tabName) {
  var sh = ss.getSheetByName(tabName);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    out.push(_rowToObj(hdr, data[i]));
  }
  return out;
}

function _median_(arr) {
  var sorted = arr.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function _countUniqueLanguages_(interpreters) {
  var s = {};
  interpreters.forEach(function (i) {
    try {
      JSON.parse(i.languages || '[]').forEach(function (l) { s[l.lang] = true; });
    } catch (_) {}
  });
  return Object.keys(s).length;
}
