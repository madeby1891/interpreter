/**
 * Code_Godview.gs — godview metrics endpoint for 1891 Interpreter.
 *
 * Wire-up:
 *   - doGet in Code.gs short-circuits to handleGodviewStats(e) when
 *     e.parameter.godview is truthy (added next to the function signature).
 *   - HMAC verifier lives in shared/lib/godview/hmac.gs and MUST be vendored
 *     into the Apps Script project alongside this file (paste as hmac.gs).
 *   - Script Properties required:
 *       GODVIEW_SHARED_SECRET   shared HMAC secret with agent.madeby1891.com
 *       GODVIEW_PROJECT_ID      "interpreter"
 *
 * Envelope shape (registry schema_version 1.0): see
 *   shared/specs/godview-metrics.json and the canonical FDT implementation at
 *   projects/fairytale-dreamers/FDT Web Assets/deployment/apps-script-godview.gs.
 *
 * Metrics surfaced (multi_tenant=true per metric):
 *   interpreters_active   Interpreters with status=active per tenant.
 *   jobs_filled_mtd       Jobs in current month that reached CLAIMED+ status.
 *
 * Tenants: `host` is always present (special-cased in _resolveTenantSheetId).
 * Other tenants come from the control Sheet (Tenants tab); see Code_Multitenant.gs.
 */

/* global Godview_verifyHmac_, SHEET_ID, T, _allRowsFor_, _readTenantsTable, _resolveTenantSheetId */

function handleGodviewStats(e) {
  if (!Godview_verifyHmac_(e)) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var t0 = Date.now();

  // Server-side cache (60s TTL). Cold call ~12s — too slow for the agent
  // worker's per-project budget. Warm calls return in ~100ms via cache.
  var cache = CacheService.getScriptCache();
  var cached = cache.get('gv_envelope_v1');
  if (cached) {
    return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);
  }

  var tenantList = _gvCollectTenants_();

  var tenants = {};
  var rollupInterpretersActive = 0;
  var rollupJobsFilledMtd = 0;

  tenantList.forEach(function (t) {
    var block = _gvBuildTenantBlock_(t.tenant_id, t.display_name);
    tenants[t.tenant_id] = block;
    if (block.status === 'ok') {
      var ia = block.metrics.interpreters_active.value;
      var jf = block.metrics.jobs_filled_mtd.value;
      if (typeof ia === 'number') rollupInterpretersActive += ia;
      if (typeof jf === 'number') rollupJobsFilledMtd += jf;
    }
  });

  // __rollup tenant block — sum across all tenants. Spec keeps the same
  // metric ids so the agent UI can render a "Total across agencies" tile.
  tenants.__rollup = {
    tenant_id: '__rollup',
    display_name: 'All agencies (rollup)',
    status: 'ok',
    metrics: {
      interpreters_active: { value: rollupInterpretersActive, unit: 'count' },
      jobs_filled_mtd:     { value: rollupJobsFilledMtd,     unit: 'count', window: 'mtd' }
    },
    links: {},
    errors: []
  };

  var envelope = {
    schema_version: '1.0',
    project: 'interpreter',
    generated_at: new Date().toISOString(),
    generation_ms: Date.now() - t0,
    tenant_mode: 'multi',
    tenants: tenants
  };

  var envelopeJson = JSON.stringify(envelope);
  try { cache.put('gv_envelope_v1', envelopeJson, 60); } catch (_e) { /* best effort */ }
  return ContentService.createTextOutput(envelopeJson).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Returns [{ tenant_id, display_name }, ...] for every tenant the godview
 * should surface. The `host` tenant is always first; remaining tenants come
 * from the control Sheet's Tenants tab.
 */
function _gvCollectTenants_() {
  var out = [{ tenant_id: 'host', display_name: 'Host Agency' }];
  try {
    var rows = _readTenantsTable();
    rows.forEach(function (r) {
      if (!r || !r.tenant_id || r.tenant_id === 'host') return;
      if (String(r.status) === 'suspended') return;
      out.push({
        tenant_id: r.tenant_id,
        display_name: r.legal_name || _gvPrettifySlug_(r.tenant_id)
      });
    });
  } catch (_) { /* control Sheet missing — host-only is fine */ }
  return out;
}

/**
 * Compute interpreters_active + jobs_filled_mtd for a single tenant by
 * opening its Sheet via _resolveTenantSheetId. Returns the per-tenant
 * envelope block — sets status='error' (and zeroed metrics) on failure.
 */
function _gvBuildTenantBlock_(tenantId, displayName) {
  var block = {
    tenant_id: tenantId,
    display_name: displayName,
    status: 'ok',
    metrics: {
      interpreters_active: { value: 0, unit: 'count' },
      jobs_filled_mtd:     { value: 0, unit: 'count', window: 'mtd' }
    },
    links: {
      impersonate: 'https://1891interpreter.app/agent/?godview=1&tenant=' + encodeURIComponent(tenantId)
    },
    errors: []
  };

  try {
    var sid = _resolveTenantSheetId(tenantId);
    if (!sid) {
      block.status = 'error';
      block.errors.push('tenant Sheet not resolvable');
      return block;
    }
    var ss = SpreadsheetApp.openById(sid);

    // interpreters_active — Interpreters where status === 'active', scoped to tenant.
    var interpreters = _allRowsFor_(ss, T.Interpreters, tenantId);
    var active = interpreters.filter(function (i) { return String(i.status) === 'active'; }).length;
    block.metrics.interpreters_active.value = active;

    // jobs_filled_mtd — Jobs whose scheduled_start is in the current month AND
    // whose status indicates a fill (claimed onwards). Mirrors the
    // "fillable" status set used by apiAgencyHealth in Code_Metrics.gs.
    var jobs = _allRowsFor_(ss, T.Jobs, tenantId);
    var now = new Date();
    var monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    var nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    var filledStatuses = ['CLAIMED','CONFIRMED','EN_ROUTE','IN_PROGRESS','COMPLETED','BILLED','PAID'];
    var filled = 0;
    for (var j = 0; j < jobs.length; j++) {
      var job = jobs[j];
      var t = Date.parse(job.scheduled_start);
      if (!isFinite(t)) continue;
      if (t < monthStart || t >= nextMonthStart) continue;
      if (filledStatuses.indexOf(String(job.status)) < 0) continue;
      filled++;
    }
    block.metrics.jobs_filled_mtd.value = filled;
    block.metrics.jobs_filled_mtd.as_of = new Date().toISOString();
    block.metrics.interpreters_active.as_of = new Date().toISOString();
  } catch (err) {
    block.status = 'error';
    block.errors.push(String(err && err.message || err));
    // Null out values so the rollup doesn't sum stale zeros into a real number.
    block.metrics.interpreters_active.value = null;
    block.metrics.jobs_filled_mtd.value = null;
  }

  return block;
}

function _gvPrettifySlug_(slug) {
  return String(slug || '').split('-').map(function (s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }).join(' ');
}
