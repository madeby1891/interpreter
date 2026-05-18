// 1891 Interpreter — white-label theme injector.
//
// Pulls the current tenant's brand_color + legal_name from whoami (which now
// includes agency info) and applies them across the /app/* shell.
// Drop this into every /app/ page's <head> before main.js so the theme paints
// before first contentful frame.
(function (root) {
  'use strict';
  var STORAGE_KEY = '1891int.theme';

  function applyTheme(theme) {
    if (!theme) return;
    var root = document.documentElement;
    if (theme.brand_color) {
      root.style.setProperty('--1891int-bloom', theme.brand_color);
      // Compute soft / deep variants if we have a primary color
      var rgb = hexToRgb(theme.brand_color);
      if (rgb) {
        root.style.setProperty('--1891int-bloom-deep', rgbToHex(darken(rgb, 0.22)));
        root.style.setProperty('--1891int-bloom-soft', rgbToHex(lighten(rgb, 0.45)));
        root.style.setProperty('--1891int-bloom-tint', rgbToHex(lighten(rgb, 0.72)));
      }
    }
    if (theme.legal_name) {
      // Replace the "1891 Interpreter" lockup with "<Agency name>"
      // and a quiet "powered by 1891 Interpreter" subtext in the header.
      document.querySelectorAll('.app-header .brand').forEach(function (el) {
        var img = el.querySelector('img');
        el.innerHTML = '';
        if (img) el.appendChild(img);
        var span = document.createElement('span');
        span.innerHTML = escapeHtml(theme.legal_name) +
          ' <span class="brand-sub">' + 'powered by 1891' + '</span>';
        el.appendChild(span);
      });
      // Document title prefix
      if (theme.legal_name && document.title.indexOf(theme.legal_name) < 0) {
        document.title = theme.legal_name + ' — ' + document.title;
      }
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
  }

  function hexToRgb(hex) {
    hex = String(hex).replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }
  function rgbToHex(c) {
    function h(n) { return ('0' + Math.max(0, Math.min(255, Math.round(n))).toString(16)).slice(-2); }
    return '#' + h(c.r) + h(c.g) + h(c.b);
  }
  function darken(c, amount) {
    return { r: c.r * (1 - amount), g: c.g * (1 - amount), b: c.b * (1 - amount) };
  }
  function lighten(c, amount) {
    return {
      r: c.r + (255 - c.r) * amount,
      g: c.g + (255 - c.g) * amount,
      b: c.b + (255 - c.b) * amount
    };
  }

  // Apply cached theme synchronously on first paint
  try {
    var cached = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (cached) applyTheme(cached);
  } catch (_) {}

  // Expose for main.js to call after whoami returns fresh data
  root.IntTheme = {
    apply: function (theme) {
      applyTheme(theme);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(theme)); } catch (_) {}
    },
    clear: function () {
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    }
  };
})(window);
