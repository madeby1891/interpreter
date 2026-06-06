/**
 * 1891 Interpreter — rate engine.
 *
 * Two-sided rate computation:
 *   - Bill side  (agency → payer): from Rate_Cards (side=bill) + Rate_Modifiers (side=bill)
 *   - Pay side   (agency → interpreter): from interpreter's pay_rate_floors +
 *                Rate_Modifiers (side=pay), bounded below by the floor
 *
 * Each rate quote walks the same modifier pipeline:
 *   1. Resolve base hourly rate (service_type × modality × team_config)
 *   2. Compute scheduled span in minutes; apply rounding
 *   3. Apply minimum hours floor
 *   4. Apply all matching modifiers in priority order:
 *        - evening (start hour ≥ trigger.after_hour OR end hour ≥ trigger.after_hour)
 *        - overnight (start hour ≥ trigger.start_hour OR before trigger.end_hour)
 *        - weekend (start day ∈ trigger.days)
 *        - holiday (start date matches federal holiday list — or trigger.dates)
 *        - last_minute (created < trigger.hours_before scheduled_start)
 *        - cdi_surcharge (team_config matches trigger.team_configs)
 *        - rural_distance (interpreter home zip → location zip distance > trigger.miles)
 *   5. Sum the modifiers as either pct or cents
 *   6. Quote = (base_hourly × hours × (1 + Σpct)) + Σcents
 *
 * Both sides use the SAME modifier list shape but filter on `side` column.
 *
 * For cancellations, a separate compute path:
 *   - >= 48h notice    → 0%
 *   - 24-48h notice    → 50% bill, 25% pay (configurable)
 *   - 12-24h notice    → 100% bill, 50% pay
 *   - < 12h or no-show → 100% bill, 100% pay
 * Interpreters can set their own `cancellation_floors` to enforce minimums.
 */

// ============================================================================
// PUBLIC ENDPOINTS
// ============================================================================

function apiComputeRateQuote(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  // Either job_id OR ad-hoc params
  var quote;
  if (p.job_id) {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var job = _findJob(ss, s.payload.tid, p.job_id);
    if (!job) return _json({ ok:false, error:'Job not found' }, 404);
    quote = computeRateQuote_(ss, s.payload.tid, job, p.interpreter_id || null);
  } else {
    var ss2 = SpreadsheetApp.openById(SHEET_ID);
    var fakeJob = {
      tenant_id: s.payload.tid,
      service_type: p.service_type || 'medical',
      modality: p.modality || 'on-site',
      team_config: p.team_config || 'solo',
      scheduled_start: p.scheduled_start,
      scheduled_end: p.scheduled_end,
      _created_at: new Date().toISOString()
    };
    quote = computeRateQuote_(ss2, s.payload.tid, fakeJob, p.interpreter_id || null);
  }
  return _json({ ok:true, quote: quote });
}

function apiListRateModifiers(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.RateModifiers, _tenantSchema().Rate_Modifiers);
  var sh = ss.getSheetByName(T.RateModifiers);
  var data = _dbValues_(ss, sh, T.RateModifiers);
  if (data.length < 2) return _json({ ok:true, modifiers:[] });
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id === s.payload.tid) out.push(o);
  }
  return _json({ ok:true, modifiers: out });
}

function apiUpsertRateModifier(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var p = e.parameter || {};
  if (!p.side || !p.kind || !p.name) return _json({ ok:false, error:'side, kind, name required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.RateModifiers, _tenantSchema().Rate_Modifiers);
  var sh = ss.getSheetByName(T.RateModifiers);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('modifier_id');
  var iTenant = hdr.indexOf('tenant_id');
  var nowIso = new Date().toISOString();

  if (p.modifier_id) {
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][iId]) === p.modifier_id && String(data[r][iTenant]) === s.payload.tid) {
        var fields = ['side','kind','name','trigger','modifier_pct','modifier_cents','applies_to_service_type','applies_to_modality','priority','status','notes'];
        fields.forEach(function (f) {
          if (p[f] === undefined || p[f] === null) return;
          var c = hdr.indexOf(f);
          if (c < 0) return;
          sh.getRange(r + 1, c + 1).setValue(p[f]);
        });
        sh.getRange(r + 1, hdr.indexOf('_updated_at') + 1).setValue(nowIso);
        _logAudit('rate_modifier.update', s.payload.tid, s.payload.uid, p.modifier_id);
        return _json({ ok:true, modifier_id: p.modifier_id });
      }
    }
    return _json({ ok:false, error:'Modifier not found' }, 404);
  }
  var id = _ulid('rm');
  var row = {
    modifier_id: id, tenant_id: s.payload.tid,
    side: p.side, kind: p.kind, name: p.name,
    trigger: p.trigger || '{}',
    modifier_pct: Number(p.modifier_pct || 0),
    modifier_cents: Number(p.modifier_cents || 0),
    applies_to_service_type: p.applies_to_service_type || '*',
    applies_to_modality: p.applies_to_modality || '*',
    priority: Number(p.priority || 100),
    status: p.status || 'active',
    notes: p.notes || '',
    _created_at: nowIso, _updated_at: nowIso
  };
  sh.appendRow(_tenantSchema().Rate_Modifiers.map(function (col) { return row[col] !== undefined ? row[col] : ''; }));
  _logAudit('rate_modifier.create', s.payload.tid, s.payload.uid, id);
  return _json({ ok:true, modifier_id: id, modifier: row });
}

function apiDeleteRateModifier(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var mid = e.parameter.modifier_id;
  if (!mid) return _json({ ok:false, error:'modifier_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.RateModifiers);
  if (!sh) return _json({ ok:false, error:'No modifiers' }, 404);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('modifier_id');
  var iTenant = hdr.indexOf('tenant_id');
  for (var r = data.length - 1; r >= 1; r--) {
    if (String(data[r][iId]) === mid && String(data[r][iTenant]) === s.payload.tid) {
      sh.deleteRow(r + 1);
      _logAudit('rate_modifier.delete', s.payload.tid, s.payload.uid, mid);
      return _json({ ok:true });
    }
  }
  return _json({ ok:false, error:'Not found' }, 404);
}

function apiListRateCards(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.RateCards, _tenantSchema().Rate_Cards);
  var sh = ss.getSheetByName(T.RateCards);
  var data = _dbValues_(ss, sh, T.RateCards);
  if (data.length < 2) return _json({ ok:true, rate_cards:[] });
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id === s.payload.tid) out.push(o);
  }
  return _json({ ok:true, rate_cards: out });
}

function apiUpsertRateCard(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var p = e.parameter || {};
  if (!p.side || !p.service_type) return _json({ ok:false, error:'side, service_type required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.RateCards, _tenantSchema().Rate_Cards);
  var sh = ss.getSheetByName(T.RateCards);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('rate_card_id');
  var iTenant = hdr.indexOf('tenant_id');
  var nowIso = new Date().toISOString();

  if (p.rate_card_id) {
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][iId]) === p.rate_card_id && String(data[r][iTenant]) === s.payload.tid) {
        var fields = ['side','service_type','modality','team_config','base_hourly_cents','minimum_hours','rounding_minutes','notes'];
        fields.forEach(function (f) {
          if (p[f] === undefined || p[f] === null) return;
          var c = hdr.indexOf(f);
          if (c < 0) return;
          sh.getRange(r + 1, c + 1).setValue(p[f]);
        });
        sh.getRange(r + 1, hdr.indexOf('_updated_at') + 1).setValue(nowIso);
        _logAudit('rate_card.update', s.payload.tid, s.payload.uid, p.rate_card_id);
        return _json({ ok:true, rate_card_id: p.rate_card_id });
      }
    }
    return _json({ ok:false, error:'Not found' }, 404);
  }
  var id = _ulid('rc');
  var row = {
    rate_card_id: id, tenant_id: s.payload.tid,
    side: p.side, service_type: p.service_type,
    modality: p.modality || '*', team_config: p.team_config || '*',
    base_hourly_cents: Number(p.base_hourly_cents || 0),
    minimum_hours: Number(p.minimum_hours || 2),
    rounding_minutes: Number(p.rounding_minutes || 15),
    notes: p.notes || '',
    _created_at: nowIso, _updated_at: nowIso
  };
  sh.appendRow(_tenantSchema().Rate_Cards.map(function (col) { return row[col] !== undefined ? row[col] : ''; }));
  _logAudit('rate_card.create', s.payload.tid, s.payload.uid, id);
  return _json({ ok:true, rate_card_id: id, rate_card: row });
}

// ============================================================================
// RATE QUOTE COMPUTATION
// ============================================================================

function computeRateQuote_(ss, tenantId, job, interpreterId) {
  // Returns {
  //   bill: { base_hourly_cents, hours, minimum_hours_applied, modifiers[], subtotal_cents, premium_cents, total_cents },
  //   pay:  { base_hourly_cents, hours, minimum_hours_applied, modifiers[], subtotal_cents, premium_cents, total_cents, floor_cents, floor_enforced },
  //   meta: { service_type, modality, team_config, span_minutes, rounded_minutes, is_evening, is_weekend, is_holiday, is_last_minute }
  // }
  var meta = computeQuoteMeta_(ss, tenantId, job);
  var bill = computeOneSide_(ss, tenantId, job, meta, 'bill', null);
  var pay  = computeOneSide_(ss, tenantId, job, meta, 'pay', interpreterId);
  return { bill: bill, pay: pay, meta: meta };
}

function computeQuoteMeta_(ss, tenantId, job) {
  var start = job.scheduled_start ? new Date(job.scheduled_start) : new Date();
  var end = job.scheduled_end ? new Date(job.scheduled_end) : new Date(start.getTime() + 60 * 60 * 1000);
  var spanMs = end.getTime() - start.getTime();
  var spanMin = Math.max(0, Math.round(spanMs / 60000));

  var tz = 'America/New_York';
  var hourStr = Utilities.formatDate(start, tz, 'H');
  var dowStr  = Utilities.formatDate(start, tz, 'u'); // 1-7 Mon-Sun
  var dateStr = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
  var startHour = parseInt(hourStr, 10);
  var endHour = parseInt(Utilities.formatDate(end, tz, 'H'), 10);
  var dow = parseInt(dowStr, 10);

  var isEvening = (startHour >= 18) || (endHour > 18) || (startHour < 6);
  var isOvernight = (startHour >= 22) || (startHour < 6);
  var isWeekend = (dow >= 6);
  var isHoliday = isUsFederalHoliday_(dateStr);

  // Last-minute = scheduled_start was less than 24h after job _created_at
  var createdAt = job._created_at ? new Date(job._created_at) : new Date();
  var leadTimeMs = start.getTime() - createdAt.getTime();
  var leadHours = leadTimeMs / 3600000;
  var isLastMinute = leadHours >= 0 && leadHours < 24;
  var isRush = leadHours >= 0 && leadHours < 4;

  return {
    service_type: job.service_type || 'medical',
    modality: job.modality || 'on-site',
    team_config: job.team_config || 'solo',
    span_minutes: spanMin,
    start_iso: start.toISOString(),
    end_iso: end.toISOString(),
    start_hour: startHour,
    end_hour: endHour,
    dow: dow,
    is_evening: isEvening,
    is_overnight: isOvernight,
    is_weekend: isWeekend,
    is_holiday: isHoliday,
    is_last_minute: isLastMinute,
    is_rush: isRush,
    lead_hours: Math.round(leadHours * 10) / 10
  };
}

function computeOneSide_(ss, tenantId, job, meta, side, interpreterId) {
  // 1. Base rate
  var base = resolveBaseRate_(ss, tenantId, job, side, interpreterId);
  // 2. Apply rounding
  var roundedMin = Math.ceil(meta.span_minutes / base.rounding_minutes) * base.rounding_minutes;
  // 3. Floor at minimum hours
  var minMin = base.minimum_hours * 60;
  var minApplied = roundedMin < minMin;
  var billableMin = Math.max(roundedMin, minMin);
  var hours = billableMin / 60;

  // 4. Match + apply modifiers
  var modifiers = listMatchingModifiers_(ss, tenantId, side, job, meta);
  var pctSum = 0;
  var centsSum = 0;
  var modifierLog = [];
  modifiers.forEach(function (m) {
    var pct = Number(m.modifier_pct || 0);
    var cents = Number(m.modifier_cents || 0);
    pctSum += pct;
    centsSum += cents;
    modifierLog.push({
      modifier_id: m.modifier_id, name: m.name, kind: m.kind,
      pct: pct, cents: cents, priority: m.priority
    });
  });

  var subtotal = Math.round(base.base_hourly_cents * hours);
  var premiumPct = Math.round(subtotal * (pctSum / 100));
  var total = subtotal + premiumPct + centsSum;

  var out = {
    base_hourly_cents: base.base_hourly_cents,
    hours: Math.round(hours * 100) / 100,
    minimum_hours: base.minimum_hours,
    minimum_hours_applied: minApplied,
    rounding_minutes: base.rounding_minutes,
    billable_minutes: billableMin,
    modifiers: modifierLog,
    modifier_pct_total: pctSum,
    modifier_cents_total: centsSum,
    subtotal_cents: subtotal,
    premium_cents: premiumPct + centsSum,
    total_cents: total,
    source: base.source
  };

  // 5. Pay-side: enforce interpreter floor
  if (side === 'pay' && interpreterId) {
    var interp = _findInterpreterById ? _findInterpreterById(ss, interpreterId) : null;
    if (interp) {
      var floors = {};
      try { floors = JSON.parse(interp.pay_rate_floors || '{}'); } catch (_) {}
      var floorHourly = (floors[meta.service_type] && floors[meta.service_type][meta.modality]) ||
                        (floors[meta.service_type] && floors[meta.service_type]['*']) ||
                        (floors['*'] && floors['*'][meta.modality]) ||
                        (floors['*'] && floors['*']['*']) || 0;
      if (floorHourly > 0) {
        var floorTotal = Math.round(floorHourly * hours);
        if (floorTotal > out.total_cents) {
          out.floor_enforced = true;
          out.floor_cents = floorTotal;
          out.floor_hourly_cents = floorHourly;
          out.total_cents = floorTotal;
        } else {
          out.floor_cents = floorTotal;
        }
      }
    }
  }

  return out;
}

function resolveBaseRate_(ss, tenantId, job, side, interpreterId) {
  // Pay-side: prefer interpreter floor, then Rate_Cards (side=pay) cascade
  // Bill-side: Rate_Cards (side=bill) cascade
  var svc = job.service_type || 'medical';
  var mod = job.modality || 'on-site';
  var team = job.team_config || 'solo';

  // 1. Rate_Cards cascade
  var sh = ss.getSheetByName(T.RateCards);
  if (sh && sh.getLastRow() >= 2) {
    var data = sh.getDataRange().getValues();
    var hdr = data[0];
    var iTenant = hdr.indexOf('tenant_id');
    var iSide = hdr.indexOf('side');
    var iSvc = hdr.indexOf('service_type');
    var iMod = hdr.indexOf('modality');
    var iTeam = hdr.indexOf('team_config');
    var candidates = [];
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][iTenant]) !== tenantId) continue;
      if (String(data[i][iSide]) !== side) continue;
      if (String(data[i][iSvc]) !== svc && String(data[i][iSvc]) !== '*') continue;
      var rc = _rowToObj(hdr, data[i]);
      // Specificity score: exact match > wildcard
      var spec = 0;
      if (rc.service_type === svc) spec += 4;
      if (rc.modality === mod) spec += 2; else if (rc.modality === '*') spec += 0; else continue;
      if (rc.team_config === team) spec += 1; else if (rc.team_config === '*') spec += 0; else continue;
      candidates.push({ rc: rc, spec: spec });
    }
    candidates.sort(function (a, b) { return b.spec - a.spec; });
    if (candidates.length) {
      var pick = candidates[0].rc;
      return {
        base_hourly_cents: Number(pick.base_hourly_cents || 0),
        minimum_hours: Number(pick.minimum_hours || 2),
        rounding_minutes: Number(pick.rounding_minutes || 15),
        source: 'rate_card:' + pick.rate_card_id
      };
    }
  }

  // 2. Settings-tab fallback (legacy)
  var settingKey = 'rate_card.' + svc + '.' + mod + '.' + team + '.hourly_cents';
  var v = _getSetting(ss, settingKey);
  if (!v) v = _getSetting(ss, 'rate_card.' + svc + '.on-site.solo.hourly_cents');
  var fallbackCents = v ? Number(v) : (svc === 'legal' ? 12500 : (svc === 'education' ? 8500 : 9500));
  var minH = _getSetting(ss, 'rate_card.minimum.' + svc + '.hours');
  return {
    base_hourly_cents: fallbackCents,
    minimum_hours: minH ? Number(minH) : 2,
    rounding_minutes: 15,
    source: 'settings_fallback'
  };
}

function listMatchingModifiers_(ss, tenantId, side, job, meta) {
  var sh = ss.getSheetByName(T.RateModifiers);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var m = _rowToObj(hdr, data[i]);
    if (m.tenant_id !== tenantId) continue;
    if (m.side !== side) continue;
    if (m.status === 'archived') continue;
    if (m.applies_to_service_type && m.applies_to_service_type !== '*' && m.applies_to_service_type !== meta.service_type) continue;
    if (m.applies_to_modality && m.applies_to_modality !== '*' && m.applies_to_modality !== meta.modality) continue;
    var trigger = {};
    try { trigger = JSON.parse(m.trigger || '{}'); } catch (_) { trigger = {}; }
    if (modifierMatches_(m.kind, trigger, meta)) out.push(m);
  }
  out.sort(function (a, b) { return Number(a.priority || 100) - Number(b.priority || 100); });
  return out;
}

function modifierMatches_(kind, trigger, meta) {
  switch (kind) {
    case 'evening':
      return meta.is_evening &&
        (trigger.after_hour === undefined || meta.start_hour >= Number(trigger.after_hour) || meta.start_hour < (Number(trigger.before_hour) || 6));
    case 'overnight':
      return meta.is_overnight;
    case 'weekend':
      return meta.is_weekend;
    case 'holiday':
      return meta.is_holiday;
    case 'last_minute':
      var threshold = Number(trigger.hours_before || 24);
      return meta.is_last_minute && meta.lead_hours < threshold;
    case 'rush':
      return meta.is_rush;
    case 'cdi_surcharge':
      var teams = trigger.team_configs || ['cdi+hearing', 'voicer+signer'];
      return teams.indexOf(meta.team_config) >= 0;
    case 'mileage':
      // Mileage isn't an automatic match — it's a per-job add-on. Skip auto-apply.
      return false;
    case 'rural':
      // Distance modifier; auto-apply skipped for v1.
      return false;
    default:
      return false;
  }
}

function isUsFederalHoliday_(dateStr) {
  // dateStr = 'YYYY-MM-DD'
  // Fixed-date holidays for the next several years.
  var fixed = [
    '01-01', '06-19', '07-04', '11-11', '12-25'
  ];
  var mm_dd = dateStr.slice(5);
  if (fixed.indexOf(mm_dd) >= 0) return true;
  // Approximate: MLK Day (3rd Mon Jan), Presidents (3rd Mon Feb),
  // Memorial (last Mon May), Labor (1st Mon Sep), Columbus (2nd Mon Oct),
  // Thanksgiving (4th Thu Nov)
  var d = new Date(dateStr + 'T12:00:00');
  var dow = d.getDay(); // 0=Sun
  var dom = d.getDate();
  var mon = d.getMonth() + 1;
  function nthOf(target_dow, n) { return Math.ceil(dom / 7) === n && dow === target_dow; }
  if (mon === 1 && nthOf(1, 3)) return true;   // MLK Day
  if (mon === 2 && nthOf(1, 3)) return true;   // Presidents Day
  if (mon === 5) {                              // Memorial Day = last Mon
    var lastMon = new Date(d.getFullYear(), 4, 31);
    while (lastMon.getDay() !== 1) lastMon.setDate(lastMon.getDate() - 1);
    if (dom === lastMon.getDate()) return true;
  }
  if (mon === 9 && nthOf(1, 1)) return true;   // Labor Day
  if (mon === 10 && nthOf(1, 2)) return true;  // Columbus / Indigenous Peoples'
  if (mon === 11 && dow === 4 && Math.ceil(dom / 7) === 4) return true; // Thanksgiving
  return false;
}

// ============================================================================
// CANCELLATION QUOTE
// ============================================================================

function apiComputeCancellationQuote(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _findJob(ss, s.payload.tid, p.job_id);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);

  var hoursBefore = Number(p.hours_before_start || 0);
  if (!p.hours_before_start && job.scheduled_start) {
    var ms = new Date(job.scheduled_start).getTime() - Date.now();
    hoursBefore = Math.max(0, ms / 3600000);
  }
  var reason = String(p.reason || 'requestor_cancel').toLowerCase();
  var isNoShow = reason.indexOf('no_show') >= 0 || reason.indexOf('no-show') >= 0;

  // Tiered cancellation: bill side
  var billPct = 0, payPct = 0, tier = '';
  if (isNoShow || hoursBefore < 0) {
    billPct = 100; payPct = 100; tier = 'no_show';
  } else if (hoursBefore < 12) {
    billPct = 100; payPct = 100; tier = '<12h';
  } else if (hoursBefore < 24) {
    billPct = 100; payPct = 50;  tier = '12-24h';
  } else if (hoursBefore < 48) {
    billPct = 50;  payPct = 25;  tier = '24-48h';
  } else {
    billPct = 0;   payPct = 0;   tier = '≥48h';
  }
  // Allow tenant override via Settings
  var override = _getSetting(ss, 'cancellation_policy.tiers');
  if (override) {
    try {
      var t = JSON.parse(override);
      if (t[tier]) { billPct = t[tier].bill_pct; payPct = t[tier].pay_pct; }
    } catch (_) {}
  }

  var quote = computeRateQuote_(ss, s.payload.tid, job, p.interpreter_id || null);
  var billCharge = Math.round(quote.bill.total_cents * billPct / 100);
  var payCharge = Math.round(quote.pay.total_cents * payPct / 100);

  // Enforce interpreter cancellation floor (per-interpreter override)
  var floor = 0;
  if (p.interpreter_id) {
    var interp = _findInterpreterById(ss, p.interpreter_id);
    if (interp) {
      try {
        var floors = JSON.parse(interp.cancellation_floors || '{}');
        floor = Number(floors[tier] || floors['default'] || 0);
        if (floor > payCharge) payCharge = floor;
      } catch (_) {}
    }
  }

  return _json({
    ok: true,
    quote: {
      tier: tier,
      hours_before_start: Math.round(hoursBefore * 10) / 10,
      bill_pct: billPct, pay_pct: payPct,
      bill_charge_cents: billCharge,
      pay_charge_cents: payCharge,
      floor_cents: floor,
      reason: reason,
      original_quote: quote
    }
  });
}

// ============================================================================
// INTERPRETER PROFILE EXTENSIONS — pay-rate-floors etc.
// ============================================================================

function apiUpdateInterpreterRates(e) {
  // Owner/admin OR the interpreter themselves can update their pay-rate floors.
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var interpId = e.parameter.interpreter_id;
  if (!interpId) return _json({ ok:false, error:'interpreter_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Interpreters);
  if (!sh) return _json({ ok:false, error:'No interpreters tab' }, 404);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('interpreter_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iUserId = hdr.indexOf('user_id');
  var iUpdated = hdr.indexOf('_updated_at');
  var iRev = hdr.indexOf('_rev');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) !== interpId || String(data[r][iTenant]) !== s.payload.tid) continue;
    // Permission check
    var isStaff = (s.payload.role === 'role_owner' || s.payload.role === 'role_admin' || s.payload.role === 'role_scheduler');
    var isSelf = String(data[r][iUserId]) === s.payload.uid;
    if (!isStaff && !isSelf) return _json({ ok:false, error:'Not authorized to edit these rates' }, 403);

    var p = e.parameter;
    var fields = [
      'pay_rate_floors', 'cancellation_floors',
      'evening_premium_pct', 'weekend_premium_pct', 'last_minute_premium_pct', 'holiday_premium_pct',
      'mileage_rate_cents', 'travel_time_rate_cents',
      'specialty_endorsements', 'availability_windows',
      'rid_member_number', 'bei_member_number', 'other_member_numbers'
    ];
    fields.forEach(function (f) {
      if (p[f] === undefined || p[f] === null) return;
      var c = hdr.indexOf(f);
      if (c < 0) return;
      sh.getRange(r + 1, c + 1).setValue(p[f]);
    });
    sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
    sh.getRange(r + 1, iRev + 1).setValue(Number(data[r][iRev] || 0) + 1);
    _logAudit('interpreter_rates.update', s.payload.tid, s.payload.uid, interpId);
    return _json({ ok:true, interpreter_id: interpId });
  }
  return _json({ ok:false, error:'Interpreter not found' }, 404);
}
