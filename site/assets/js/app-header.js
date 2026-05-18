// 1891 Interpreter — tenant-switcher header augment.
//
// Every app page renders a <div class="who"> in its <header>. For users in
// multiple tenants (whoami → available_tenants.length > 1), we inject a
// small dropdown next to "Signed in as …" so they can switch without
// landing on /admin/tenants/. Single-tenant users see no change at all
// (pure no-op).
//
// Drop-in: just <script src="/interpreter/assets/js/app-header.js"> after
// api.js + api-multitenant.js. No per-page HTML changes required.

(function (root) {
  'use strict';
  if (!root.IntApi) return;  // api.js missing — nothing to do

  document.addEventListener('DOMContentLoaded', function () {
    var who = document.querySelector('.app-header .who');
    if (!who) return;        // no header — page doesn't follow the pattern
    if (!root.IntApi.getSession()) return;
    // The page's own bootstrap will call whoami(); we make a parallel call
    // so we don't depend on the page's order of operations. whoami() is
    // cheap and idempotent.
    root.IntApi.whoami().then(function (r) {
      if (!r || !r.ok) return;
      var avail = (r.available_tenants || []);
      // Pure no-op for single-tenant users.
      if (avail.length < 2) return;
      injectSwitcher(who, avail, r.user || {});
    }).catch(function () { /* swallow — switcher is a nice-to-have */ });
  });

  function injectSwitcher(whoEl, tenants, user) {
    // Bail if a previous instance already injected.
    if (whoEl.querySelector('.tenant-switcher')) return;

    var current = tenants.filter(function (t) { return t.current; })[0] || tenants[0];

    var wrap = document.createElement('div');
    wrap.className = 'tenant-switcher';
    wrap.style.cssText = 'position:relative;display:inline-block;margin-left:10px;padding-left:10px;border-left:1px solid rgba(0,0,0,.12);font-size:13.5px';
    wrap.innerHTML =
      '<button type="button" class="ts-button" aria-haspopup="listbox" aria-expanded="false" ' +
        'style="background:none;border:0;cursor:pointer;color:inherit;font:inherit;display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:6px">' +
        '<span class="ts-label" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>' +
        '<span aria-hidden="true" style="font-size:10px;opacity:.6">&#9662;</span>' +
      '</button>' +
      '<div class="ts-menu" role="listbox" hidden ' +
        'style="position:absolute;top:calc(100% + 4px);right:0;min-width:240px;max-width:320px;background:#fff;border:1px solid var(--1891int-line,#e3ddd2);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.12);padding:4px 0;z-index:50;font-size:13.5px"></div>';
    var btn  = wrap.querySelector('.ts-button');
    var lbl  = wrap.querySelector('.ts-label');
    var menu = wrap.querySelector('.ts-menu');
    lbl.textContent = current.legal_name || current.tenant_id || 'Tenant';
    btn.title = 'Tenant: ' + (current.legal_name || current.tenant_id);

    tenants.forEach(function (t) {
      var item = document.createElement('button');
      item.type = 'button';
      item.role = 'option';
      item.className = 'ts-item';
      item.dataset.id = t.tenant_id;
      item.setAttribute('aria-selected', t.current ? 'true' : 'false');
      item.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;background:none;border:0;cursor:pointer;text-align:left;padding:8px 14px;color:inherit;font:inherit' +
        (t.current ? ';font-weight:600;background:var(--1891int-paper,#faf7f3)' : '');
      item.innerHTML =
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
          escapeHtml(t.legal_name || t.tenant_id) +
        '</span>' +
        (t.current
          ? '<span aria-hidden="true" style="font-size:11px;color:var(--1891int-bloom,#C8553D)">&#10003;</span>'
          : '');
      item.addEventListener('click', function () {
        if (t.current) { close(); return; }
        switchTo(t.tenant_id, item);
      });
      menu.appendChild(item);
    });

    function open() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
    function close() { menu.hidden = true;  btn.setAttribute('aria-expanded', 'false'); }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.hidden ? open() : close();
    });
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });

    whoEl.appendChild(wrap);
  }

  function switchTo(tenantId, itemEl) {
    if (!root.IntApiMultitenant || !root.IntApiMultitenant.switchTenant) {
      // api-multitenant.js not loaded on this page — fall back to a hard
      // redirect that ferries the user to the tenants admin page.
      location.href = '/interpreter/app/admin/tenants/';
      return;
    }
    itemEl.disabled = true;
    var orig = itemEl.innerHTML;
    itemEl.textContent = 'Switching…';
    root.IntApiMultitenant.switchTenant(tenantId).then(function (r) {
      if (!r || !r.ok || !r.session) {
        itemEl.disabled = false; itemEl.innerHTML = orig;
        alert((r && r.error) || 'Could not switch tenants.');
        return;
      }
      root.IntApi.setSession(r.session);
      // Reload the current page in the new tenant context. The day-of board
      // is the safest landing on a tenant switch, but staying on the same
      // page works for most admin pages too.
      location.reload();
    }).catch(function () {
      itemEl.disabled = false; itemEl.innerHTML = orig;
      alert('Could not switch tenants.');
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }
})(window);
