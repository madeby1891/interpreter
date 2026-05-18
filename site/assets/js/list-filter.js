/* =============================================================================
   ListFilter — shared client-side search/sort/filter helper for /app/ list pages.
   Vanilla JS, no deps. Wires up the standard .filter-bar markup, persists
   { q, sort, status } in the URL via history.replaceState, and re-renders
   the visible subset on every change.

   USAGE:
     ListFilter.mount({
       items: array,                 // full list (already loaded)
       container: '#list',           // node or selector that holds rendered rows
       bar: '#filter-bar',           // node or selector for the filter bar
       countEl: '#count',            // optional count display
       resetEl: '#reset',            // optional reset button
       searchFields: function(it) { return [it.name, it.email]; },
       statuses: ['active', 'inactive'],         // chip values (optional)
       statusOf: function(it) { return it.status; }, // how to read status from a row
       sortOptions: [               // { value, label, cmp(a,b) }
         { value: 'next', label: 'Next up', cmp: (a,b) => ... },
         { value: 'recent', label: 'Most recent', cmp: (a,b) => ... },
       ],
       defaultSort: 'next',
       multiStatus: true,            // allow multiple status chips (default true)
       render: function(rows) { ... },  // called every refresh
       onEmpty: function() { ... },  // optional empty-state hook
     });
   ============================================================================= */
(function (global) {
  'use strict';

  function $(sel) {
    if (!sel) return null;
    if (typeof sel === 'string') return document.querySelector(sel);
    return sel;
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  function readQuery() {
    var q = new URLSearchParams(location.search);
    return {
      q: (q.get('q') || '').trim(),
      sort: q.get('sort') || '',
      status: (q.get('status') || '').split(',').filter(Boolean)
    };
  }

  function writeQuery(state, keepKeys) {
    var qs = new URLSearchParams(location.search);
    // preserve any keys outside our control (e.g. id=, view=)
    var ours = ['q', 'sort', 'status'];
    ours.forEach(function (k) { qs.delete(k); });
    if (state.q) qs.set('q', state.q);
    if (state.sort) qs.set('sort', state.sort);
    if (state.status && state.status.length) qs.set('status', state.status.join(','));
    var s = qs.toString();
    var url = location.pathname + (s ? '?' + s : '') + location.hash;
    history.replaceState(null, '', url);
  }

  function statusLabel(s) {
    return String(s || '')
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // Build the filter-bar DOM if it's empty. Lets pages drop a bare
  // `<div class="filter-bar" id="filter-bar"></div>` and have us fill it in.
  function ensureBar(barEl, opts) {
    if (barEl.querySelector('input[type="search"]')) return; // already built

    var search = document.createElement('input');
    search.type = 'search';
    search.placeholder = opts.searchPlaceholder || 'Search…';
    search.autocomplete = 'off';
    search.setAttribute('aria-label', opts.searchPlaceholder || 'Search');
    search.className = 'q';

    var chipRow = document.createElement('div');
    chipRow.className = 'chip-row';

    var sort = document.createElement('select');
    sort.className = 'sort';
    sort.setAttribute('aria-label', 'Sort');
    (opts.sortOptions || []).forEach(function (o) {
      var op = document.createElement('option');
      op.value = o.value; op.textContent = o.label;
      sort.appendChild(op);
    });

    var count = document.createElement('span');
    count.className = 'count';

    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'reset';
    reset.textContent = 'Clear filters';
    reset.hidden = true;

    barEl.appendChild(search);
    if ((opts.statuses || []).length) {
      var lab = document.createElement('span');
      lab.className = 'chip-row-label';
      lab.textContent = 'Status';
      barEl.appendChild(lab);
      barEl.appendChild(chipRow);
    }
    if ((opts.sortOptions || []).length) {
      var slab = document.createElement('span');
      slab.className = 'sort-label';
      slab.textContent = 'Sort';
      barEl.appendChild(slab);
      barEl.appendChild(sort);
    }
    barEl.appendChild(count);
    barEl.appendChild(reset);
  }

  function renderChips(chipRow, statuses, selected, multi) {
    chipRow.innerHTML = '';
    statuses.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (selected.indexOf(s) >= 0 ? ' on' : '');
      b.dataset.status = s;
      b.textContent = statusLabel(s);
      b.setAttribute('aria-pressed', selected.indexOf(s) >= 0 ? 'true' : 'false');
      chipRow.appendChild(b);
    });
  }

  function mount(opts) {
    var bar = $(opts.bar);
    if (!bar) {
      console.warn('ListFilter: bar not found', opts.bar);
      return null;
    }
    ensureBar(bar, opts);

    var searchEl = bar.querySelector('input[type="search"]');
    var sortEl = bar.querySelector('select.sort');
    var chipRow = bar.querySelector('.chip-row');
    var countEl = opts.countEl ? $(opts.countEl) : bar.querySelector('.count');
    var resetEl = opts.resetEl ? $(opts.resetEl) : bar.querySelector('.reset');
    var multi = opts.multiStatus !== false;

    var initial = readQuery();
    var state = {
      q: initial.q,
      sort: initial.sort || opts.defaultSort || ((opts.sortOptions || [{}])[0].value || ''),
      status: initial.status.length ? initial.status : []
    };

    var items = opts.items || [];

    if (searchEl) searchEl.value = state.q;
    if (sortEl) sortEl.value = state.sort;
    if (chipRow && (opts.statuses || []).length) {
      renderChips(chipRow, opts.statuses, state.status, multi);
    }

    function activeStatuses() {
      return state.status.slice();
    }

    function refresh() {
      var q = state.q.toLowerCase();
      var status = activeStatuses();
      var filtered = items.filter(function (it) {
        if (status.length && opts.statusOf) {
          var s = String(opts.statusOf(it) || '').toLowerCase();
          var match = status.some(function (sel) { return sel.toLowerCase() === s; });
          if (!match) return false;
        }
        if (q) {
          var hay = '';
          if (opts.searchFields) {
            var parts = opts.searchFields(it) || [];
            hay = parts.filter(Boolean).join('  ').toLowerCase();
          } else {
            hay = JSON.stringify(it).toLowerCase();
          }
          if (hay.indexOf(q) < 0) return false;
        }
        return true;
      });
      if (state.sort && opts.sortOptions) {
        var so = opts.sortOptions.find(function (o) { return o.value === state.sort; });
        if (so && so.cmp) filtered.sort(so.cmp);
      }

      // Render
      if (typeof opts.render === 'function') {
        opts.render(filtered, { total: items.length, state: state });
      }

      // Count
      if (countEl) {
        if (items.length === filtered.length) {
          countEl.textContent = items.length === 1 ? '1 item' : items.length + ' items';
        } else {
          countEl.textContent = 'Showing ' + filtered.length + ' of ' + items.length;
        }
      }

      // Reset button visibility
      var dirty = !!state.q || (state.status && state.status.length) ||
        (state.sort !== (opts.defaultSort || ((opts.sortOptions || [{}])[0].value || '')));
      if (resetEl) resetEl.hidden = !dirty;

      // Empty hook
      if (typeof opts.onEmpty === 'function') {
        opts.onEmpty(filtered.length === 0, items.length === 0, state);
      }

      writeQuery(state);
    }

    // Wire events
    if (searchEl) {
      searchEl.addEventListener('input', debounce(function () {
        state.q = searchEl.value.trim();
        refresh();
      }, 150));
    }
    if (sortEl) {
      sortEl.addEventListener('change', function () {
        state.sort = sortEl.value;
        refresh();
      });
    }
    if (chipRow) {
      chipRow.addEventListener('click', function (e) {
        var btn = e.target.closest('.chip');
        if (!btn) return;
        var s = btn.dataset.status;
        var idx = state.status.indexOf(s);
        if (idx >= 0) {
          state.status.splice(idx, 1);
        } else {
          if (!multi) state.status = [s];
          else state.status.push(s);
        }
        renderChips(chipRow, opts.statuses, state.status, multi);
        refresh();
      });
    }
    if (resetEl) {
      resetEl.addEventListener('click', function () {
        state.q = '';
        state.status = [];
        state.sort = opts.defaultSort || ((opts.sortOptions || [{}])[0].value || '');
        if (searchEl) searchEl.value = '';
        if (sortEl) sortEl.value = state.sort;
        if (chipRow) renderChips(chipRow, opts.statuses, state.status, multi);
        refresh();
      });
    }

    // Initial render
    refresh();

    return {
      setItems: function (next) { items = next || []; refresh(); },
      refresh: refresh,
      state: function () { return JSON.parse(JSON.stringify(state)); }
    };
  }

  global.ListFilter = {
    mount: mount,
    statusLabel: statusLabel,
    // Common comparator helpers
    cmpStrAsc: function (key) {
      return function (a, b) { return String(a[key] || '').toLowerCase().localeCompare(String(b[key] || '').toLowerCase()); };
    },
    cmpStrDesc: function (key) {
      return function (a, b) { return String(b[key] || '').toLowerCase().localeCompare(String(a[key] || '').toLowerCase()); };
    },
    cmpDateAsc: function (key) {
      return function (a, b) {
        var av = a[key] || ''; var bv = b[key] || '';
        if (!av && !bv) return 0;
        if (!av) return 1;
        if (!bv) return -1;
        return String(av).localeCompare(String(bv));
      };
    },
    cmpDateDesc: function (key) {
      return function (a, b) {
        var av = a[key] || ''; var bv = b[key] || '';
        if (!av && !bv) return 0;
        if (!av) return 1;
        if (!bv) return -1;
        return String(bv).localeCompare(String(av));
      };
    },
    cmpNumDesc: function (key) {
      return function (a, b) { return Number(b[key] || 0) - Number(a[key] || 0); };
    },
    cmpNumAsc: function (key) {
      return function (a, b) { return Number(a[key] || 0) - Number(b[key] || 0); };
    }
  };
})(window);
