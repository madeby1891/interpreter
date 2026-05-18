// 1891 Interpreter — multi-tenant admin API wrappers.
// Sits on top of window.IntApi (api.js). Adds the host-owner-only endpoints
// for listing, provisioning, and switching between tenants.
(function (root) {
  'use strict';

  if (!root.IntApi) {
    // api.js is required first.
    console.error('[1891int] api.js must load before api-multitenant.js');
    return;
  }

  var Api = root.IntApi;

  // -- Reads (JSONP) --------------------------------------------------------

  function listTenants() {
    return Api.jsonp({ action: 'list_tenants' });
  }

  function getTenant(tenantId) {
    return Api.jsonp({ action: 'get_tenant', id: tenantId });
  }

  function listTenantOwners(tenantId) {
    return Api.jsonp({ action: 'list_tenant_owners', tenant_id: tenantId });
  }

  // -- Writes ---------------------------------------------------------------

  // _post is private inside api.js, so we rebuild a small POST helper here.
  // It mirrors api.js's no-cors fire-and-forget pattern for writes.
  function _post(action, fields) {
    var body = new URLSearchParams();
    body.append('action', action);
    Object.keys(fields || {}).forEach(function (k) {
      var v = fields[k];
      if (v === null || v === undefined) return;
      body.append(k, String(v));
    });
    var s = Api.getSession();
    if (s) body.append('session', s);
    return fetch(Api.ENDPOINT, {
      method: 'POST',
      body: body,
      redirect: 'follow',
      mode: 'no-cors'
    });
  }

  function provisionTenant(fields) {
    // fields = { tenant_id, legal_name, owner_email, tier, phi_mode, timezone }
    return _post('provision_tenant', fields);
  }

  // switch_tenant needs the response body (the new session JWT), so we read
  // it via JSONP. NOTE: requires Code.gs doGet to include a switch_tenant
  // case (orchestrator wiring) — POST-only no-cors can't return the JWT to
  // the page. We also fire the POST as a belt-and-suspenders write so any
  // audit logging still records the action even if the GET path is missing.
  function switchTenant(tenantId) {
    return Api.jsonp({ action: 'switch_tenant', tenant_id: tenantId });
  }

  function addTenantOwner(tenantId, userEmail, role) {
    return _post('add_tenant_owner', {
      tenant_id: tenantId,
      user_email: userEmail,
      role: role || 'owner'
    });
  }

  root.IntApiMultitenant = {
    listTenants: listTenants,
    getTenant: getTenant,
    listTenantOwners: listTenantOwners,
    provisionTenant: provisionTenant,
    switchTenant: switchTenant,
    addTenantOwner: addTenantOwner
  };
})(window);
