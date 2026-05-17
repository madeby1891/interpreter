// 1891 Interpreter — vanilla JS for the marketing site.
//
// Forms POST to the Apps Script web app declared below. We use fetch with
// mode: 'no-cors' because Apps Script web apps don't return CORS headers —
// the browser sends the request but we can't read the response. That's fine
// for a marketing inbound form: row lands in the bound Sheet either way.
(function () {
  'use strict';

  // Apps Script web app — "1891 Interpreter — Inbound forms" project.
  // Deployed 2026-05-17. Writes to the "1891 Interpreter" Google Sheet
  // (Inbound, Deaf_Owned_Applications, Audit_Log tabs).
  var FORMS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwjHVtZ3un9qcA0XOaXsU0EDpk_Dbinsk_UKwKf8DicxkbKWaCdEys7MlcR0pdGDhu0HA/exec';

  // ---- Mobile nav toggle ------------------------------------------------
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.querySelector('.nav-primary');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // ---- Smooth-scroll for in-page anchors (respects reduced motion) -----
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

  // ---- Footer year stamp ----------------------------------------------
  var y = document.querySelector('[data-year]');
  if (y) y.textContent = new Date().getFullYear();

  // ---- Forms -----------------------------------------------------------
  // We hijack the submit, do a no-cors fetch to the Apps Script web app,
  // then show a polite success message. Native form submission would
  // navigate the user to script.google.com, which is bad UX.
  document.querySelectorAll('form[data-form]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var statusEl = form.querySelector('.form-status');
      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.setAttribute('aria-busy', 'true');
      }

      var payload = new URLSearchParams();
      var fd = new FormData(form);
      fd.forEach(function (value, key) {
        // FormData includes File objects for file inputs; skip those —
        // the marketing form doesn't actually upload, it just collects the
        // intent to upload. We email-prompt for the doc post-acknowledge.
        if (typeof value === 'string') {
          payload.append(key, value);
        }
      });
      // Stamp the page URL so the backend can route notifications
      payload.append('page', window.location.pathname);

      function showSuccess() {
        if (statusEl) {
          statusEl.textContent = 'Thanks. We received that — a real person replies within 1 business day.';
          statusEl.setAttribute('role', 'status');
          statusEl.style.display = 'block';
          statusEl.style.marginTop = '16px';
          statusEl.style.color = 'var(--1891int-ok, #1F7A3A)';
          statusEl.style.fontWeight = '600';
        }
        form.reset();
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.removeAttribute('aria-busy');
        }
      }

      if (!FORMS_ENDPOINT) {
        // Pre-deploy or backend unreachable — show success anyway, but
        // also log to the console so a developer can see the missing URL.
        if (window.console && console.warn) {
          console.warn('[1891] FORMS_ENDPOINT not configured; form was not actually sent.');
        }
        showSuccess();
        return;
      }

      // Fire-and-forget no-cors POST. We can't read the response in JS,
      // but Apps Script will accept the body and write the row.
      fetch(FORMS_ENDPOINT, {
        method: 'POST',
        mode: 'no-cors',
        body: payload
      }).then(showSuccess).catch(function (err) {
        // Network-level failure — tell the user honestly.
        if (statusEl) {
          statusEl.textContent = 'We couldn’t reach our server. Please try again, or email hello@madeby1891.com.';
          statusEl.setAttribute('role', 'alert');
          statusEl.style.color = 'var(--1891int-err, #B3261E)';
        }
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.removeAttribute('aria-busy');
        }
        if (window.console && console.error) console.error('[1891] form submit failed', err);
      });
    });
  });
})();
