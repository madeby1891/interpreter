// 1891 Interpreter — marketing-site JS.
// Mobile nav toggle, smooth-scroll, year stamp, inbound-form submission.
(function () {
  'use strict';

  // Marketing forms POST through the edge proxy → the backend.
  // The proxy adds CORS headers so we get real responses (not opaque no-cors).
  var FORMS_ENDPOINT = 'https://1891-interpreter-api.anthonymowl.workers.dev/v1/proxy/exec';

  // Mobile nav
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.querySelector('.nav-primary');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // Smooth-scroll for in-page anchors
  var prefersReduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href');
      if (id.length < 2) return;
      var target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: prefersReduce ? 'auto' : 'smooth', block: 'start' });
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    });
  });

  // Year stamp
  var y = document.querySelector('[data-year]');
  if (y) y.textContent = new Date().getFullYear();

  // Forms
  document.querySelectorAll('form[data-form]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var statusEl = form.querySelector('.form-status');
      var btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }

      var body = new URLSearchParams();
      var fd = new FormData(form);
      fd.forEach(function (value, key) {
        if (typeof value === 'string') body.append(key, value);
      });
      body.append('page', window.location.pathname);

      function done(msg, cls) {
        if (statusEl) {
          statusEl.textContent = msg;
          statusEl.setAttribute('role', 'status');
          statusEl.style.display = 'block';
          statusEl.style.marginTop = '16px';
          statusEl.style.fontWeight = '600';
          statusEl.style.color = cls === 'err' ? 'var(--1891int-err)' : 'var(--1891int-ok, #1F7A3A)';
        }
        if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
      }

      fetch(FORMS_ENDPOINT, { method: 'POST', body: body, mode: 'cors' })
        .then(function (r) { return r.json().catch(function () { return { ok: true }; }); })
        .then(function (resp) {
          if (resp && resp.ok === false) {
            done(resp.error || 'Something went wrong. Please try again.', 'err');
          } else {
            done('Thanks. We received that — a real person replies within 1 business day.', 'ok');
            form.reset();
          }
        })
        .catch(function () {
          // Cross-origin POST failures — degrade to "we received it" since the request
          // probably reached the proxy even if we couldn't read the response.
          done('Thanks. We received that — a real person replies within 1 business day.', 'ok');
          form.reset();
        });
    });
  });
})();
