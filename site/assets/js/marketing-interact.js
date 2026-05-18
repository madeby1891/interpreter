/* =============================================================================
 * 1891 Interpreter — marketing-interact.js
 * Scroll-reveal + count-up + five interactive widgets.
 * Vanilla JS, single IIFE, defer-loaded, no dependencies.
 * Respects prefers-reduced-motion.
 *
 * ─── WIDGET MARKUP — drop these into the page where you want them ──────────
 *
 * WIDGET: lifecycle
 *   <div class="widget" data-widget="lifecycle" data-reveal></div>
 *
 * WIDGET: rate engine
 *   <div class="widget" data-widget="rates" data-reveal></div>
 *
 * WIDGET: cancellation tier
 *   <div class="widget" data-widget="cancel" data-reveal></div>
 *
 * WIDGET: SMS YES/NO
 *   <div class="widget" data-widget="sms" data-reveal></div>
 *
 * WIDGET: client hierarchy
 *   <div class="widget" data-widget="clients" data-reveal></div>
 *
 * SCROLL-REVEAL: add `data-reveal` to any element. Optionally
 *   `data-delay="100"` (100/200/300/400/500/600) for stagger.
 *
 * COUNT-UP STAT: add `data-countup` to an element whose textContent
 *   is the final integer (e.g. `<span class="stat num" data-countup>37</span>`).
 *
 * ============================================================================= */

(function () {
  'use strict';

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------------------
  // Scroll-reveal observer
  // ---------------------------------------------------------------------------
  function initReveal() {
    var nodes = document.querySelectorAll('[data-reveal]');
    if (!nodes.length) return;
    if (reduced || !('IntersectionObserver' in window)) {
      nodes.forEach(function (n) { n.classList.add('is-visible'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('is-visible');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.15 });
    nodes.forEach(function (n) { io.observe(n); });
  }

  // ---------------------------------------------------------------------------
  // Count-up stat animator
  // ---------------------------------------------------------------------------
  function initCountUp() {
    var nodes = document.querySelectorAll('[data-countup]');
    if (!nodes.length) return;
    if (reduced || !('IntersectionObserver' in window)) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var el = e.target;
        io.unobserve(el);
        var target = parseInt((el.textContent || '0').replace(/[^0-9-]/g, ''), 10);
        if (!isFinite(target)) return;
        var duration = 1200;
        var start = performance.now();
        var prefix = (el.dataset.prefix || '');
        var suffix = (el.dataset.suffix || '');
        function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
        function tick(now) {
          var t = Math.min(1, (now - start) / duration);
          var v = Math.round(easeOut(t) * target);
          el.textContent = prefix + v + suffix;
          if (t < 1) requestAnimationFrame(tick);
          else el.textContent = prefix + target + suffix;
        }
        el.textContent = prefix + '0' + suffix;
        requestAnimationFrame(tick);
      });
    }, { threshold: 0.4 });
    nodes.forEach(function (n) { io.observe(n); });
  }

  // ---------------------------------------------------------------------------
  // Tiny DOM helper
  // ---------------------------------------------------------------------------
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') el.className = attrs[k];
        else if (k === 'html') el.innerHTML = attrs[k];
        else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else if (k === 'data') {
          Object.keys(attrs.data).forEach(function (dk) { el.dataset[dk] = attrs.data[dk]; });
        }
        else el.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  // ---------------------------------------------------------------------------
  // Widget: lifecycle
  // ---------------------------------------------------------------------------
  var LIFECYCLE_STATES = [
    { key: 'OPEN',        label: 'Open',        note: 'Posted 2 min ago — looking for an interpreter' },
    { key: 'OFFERED',     label: 'Offered',     note: 'Sent to 3 qualified interpreters via SMS' },
    { key: 'CLAIMED',     label: 'Claimed',     note: 'Pat M. replied YES — holding for confirmation' },
    { key: 'CONFIRMED',   label: 'Confirmed',   note: 'Requestor notified · calendar invite sent' },
    { key: 'IN_PROGRESS', label: 'In progress', note: 'On-site check-in at 1:58 PM' },
    { key: 'COMPLETED',   label: 'Completed',   note: 'Close-out submitted: 1h actual + 12 mi · ready to invoice' }
  ];

  function mountLifecycle(host) {
    host.classList.add('widget');
    var titleEl = h('div', { class: 'widget-title' }, ['Job lifecycle']);
    var card = h('div', { class: 'lifecycle-card' }, [
      h('div', { class: 'cluster-tight' }, [
        h('span', { class: 'lifecycle-chip', data: { state: 'OPEN' } }, ['Open']),
        h('span', { class: 'lifecycle-ts' }, ['#JR-4821 · 14:00'])
      ]),
      h('div', { class: 'lifecycle-job' }, ['Medical · ASL · Tomorrow 2:00 PM']),
      h('div', { class: 'lifecycle-meta' }, ['Frederick Health Cardiology — Patient: M.R.']),
      h('div', { class: 'lifecycle-note', html: '<small class="muted">Posted 2 min ago — looking for an interpreter</small>' }),
      h('div', { class: 'lifecycle-progress' }, LIFECYCLE_STATES.map(function () { return h('span', {}, []); }))
    ]);
    host.appendChild(titleEl);
    host.appendChild(card);
    host.appendChild(h('small', { class: 'widget-caption' }, ['Hover or focus to pause.']));

    var chip   = card.querySelector('.lifecycle-chip');
    var meta   = card.querySelector('.lifecycle-meta');
    var note   = card.querySelector('.lifecycle-note small');
    var bars   = card.querySelectorAll('.lifecycle-progress span');

    var idx = 0, paused = false, timer;

    function render() {
      var s = LIFECYCLE_STATES[idx];
      chip.dataset.state = s.key;
      chip.textContent = s.label;
      note.textContent = s.note;
      bars.forEach(function (b, i) { b.classList.toggle('is-done', i <= idx); });
    }
    function advance() {
      idx = (idx + 1) % LIFECYCLE_STATES.length;
      render();
    }
    function loop() {
      timer = setTimeout(function () {
        if (!paused) advance();
        loop();
      }, 2500);
    }
    host.addEventListener('mouseenter', function () { paused = true; });
    host.addEventListener('mouseleave', function () { paused = false; });
    host.addEventListener('focusin',   function () { paused = true; });
    host.addEventListener('focusout',  function () { paused = false; });

    render();
    if (!reduced) loop();
  }

  // ---------------------------------------------------------------------------
  // Widget: rate engine playground
  // ---------------------------------------------------------------------------
  var RATE_SERVICES = [
    { v: 'medical',  label: 'Medical',         base: 95 },
    { v: 'mental',   label: 'Mental health',   base: 105 },
    { v: 'legal',    label: 'Legal',           base: 125 },
    { v: 'edu',      label: 'Education',       base: 85 },
    { v: 'comm',     label: 'Community',       base: 70 }
  ];
  var RATE_MODALITIES = [
    { v: 'onsite', label: 'On-site', delta: 0 },
    { v: 'vri',    label: 'VRI',     delta: -10 },
    { v: 'opi',    label: 'OPI',     delta: -20 }
  ];
  var RATE_TIMES = [
    { v: 'day',     label: 'Day',       mult: 1.00 },
    { v: 'evening', label: 'Evening',   mult: 1.15 },
    { v: 'weekend', label: 'Weekend',   mult: 1.25 },
    { v: 'overnight', label: 'Overnight', mult: 1.40 }
  ];

  function fmtCurrency(n) { return '$' + n.toFixed(2); }
  function roundToHalf(n) { return Math.round(n * 2) / 2; }

  function mountRates(host) {
    host.classList.add('widget');
    var state = { service: 'medical', modality: 'onsite', time: 'day' };

    var serviceSel = h('select', { 'aria-label': 'Service type' },
      RATE_SERVICES.map(function (s) { return h('option', { value: s.v }, [s.label]); }));
    serviceSel.value = state.service;

    var modalitySel = h('select', { 'aria-label': 'Modality' },
      RATE_MODALITIES.map(function (m) { return h('option', { value: m.v }, [m.label]); }));
    modalitySel.value = state.modality;

    var chipButtons = RATE_TIMES.map(function (t) {
      return h('button', {
        type: 'button',
        'aria-pressed': t.v === state.time ? 'true' : 'false',
        data: { time: t.v }
      }, [t.label]);
    });
    var chips = h('div', { class: 'widget-chips', role: 'group', 'aria-label': 'Time of day' }, chipButtons);

    var billVal = h('div', { class: 'val' }, ['$0.00']);
    var payVal  = h('div', { class: 'val' }, ['$0.00']);
    var modsBox = h('div', { class: 'widget-mods', 'aria-live': 'polite' }, []);

    host.appendChild(h('div', { class: 'widget-title' }, ['Rate engine — try it']));
    host.appendChild(h('div', { class: 'widget-controls' }, [
      h('div', {}, [ h('label', {}, ['Service']), serviceSel ]),
      h('div', {}, [ h('label', {}, ['Modality']), modalitySel ]),
      h('div', {}, [ h('label', {}, ['Time']), chips ])
    ]));
    host.appendChild(h('div', { class: 'widget-figures' }, [
      h('div', { class: 'widget-fig is-bloom' }, [
        h('span', { class: 'lbl' }, ['Bill rate (per hr)']),
        billVal
      ]),
      h('div', { class: 'widget-fig is-river' }, [
        h('span', { class: 'lbl' }, ['Interpreter pay (per hr)']),
        payVal
      ])
    ]));
    host.appendChild(modsBox);
    host.appendChild(h('small', { class: 'widget-caption' },
      ['Pay = 65% of bill, rounded to the nearest $0.50. Demo math — real per-client rules support 5 consolidation modes.']));

    function recompute() {
      var svc = RATE_SERVICES.find(function (s) { return s.v === state.service; });
      var mod = RATE_MODALITIES.find(function (m) { return m.v === state.modality; });
      var tm  = RATE_TIMES.find(function (t) { return t.v === state.time; });
      var bill = (svc.base + mod.delta) * tm.mult;
      var pay  = roundToHalf(bill * 0.65);
      billVal.textContent = fmtCurrency(bill);
      payVal.textContent  = fmtCurrency(pay);

      // Rebuild explainer chips
      modsBox.innerHTML = '';
      modsBox.appendChild(h('span', { class: 'widget-mod' }, ['base ' + fmtCurrency(svc.base)]));
      if (mod.delta !== 0) {
        modsBox.appendChild(h('span', { class: 'widget-mod' + (mod.delta < 0 ? ' is-neg' : '') },
          [(mod.delta < 0 ? '' : '+') + '$' + Math.abs(mod.delta) + ' ' + mod.label.toLowerCase()]));
      }
      if (tm.mult !== 1) {
        var pct = Math.round((tm.mult - 1) * 100);
        modsBox.appendChild(h('span', { class: 'widget-mod' }, ['+' + pct + '% ' + tm.label.toLowerCase()]));
      }
    }

    serviceSel.addEventListener('change', function () { state.service = serviceSel.value; recompute(); });
    modalitySel.addEventListener('change', function () { state.modality = modalitySel.value; recompute(); });
    chipButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        chipButtons.forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
        btn.setAttribute('aria-pressed', 'true');
        state.time = btn.dataset.time;
        recompute();
      });
    });
    recompute();
  }

  // ---------------------------------------------------------------------------
  // Widget: cancellation tier preview
  // ---------------------------------------------------------------------------
  function tierForHours(h) {
    if (h >= 48) return { key: 't0', label: '48 hours or more',   bill: 0,   pay: 0 };
    if (h >= 24) return { key: 't1', label: '24 to 48 hours',     bill: 50,  pay: 25 };
    if (h >= 12) return { key: 't2', label: '12 to 24 hours',     bill: 100, pay: 50 };
    return                 { key: 't3', label: 'Less than 12 hours', bill: 100, pay: 100 };
  }

  function mountCancel(host) {
    host.classList.add('widget');
    var slider = h('input', { type: 'range', min: '0', max: '72', value: '36', class: 'cancel-slider', 'aria-label': 'Hours before job' });
    var readout = h('div', { class: 'cancel-readout' }, [
      h('span', {}, ['0 h']), h('span', {}, ['24 h']), h('span', {}, ['48 h']), h('span', {}, ['72 h'])
    ]);
    var hoursTxt = h('div', { class: 'lifecycle-meta', style: 'font-weight:700;margin-top:0' }, ['36 hours before the job']);
    var tierBadge = h('div', { class: 'cancel-tier' }, ['Tier']);
    var billVal = h('div', { class: 'val' }, ['0%']);
    var payVal  = h('div', { class: 'val' }, ['0%']);

    host.appendChild(h('div', { class: 'widget-title' }, ['Cancellation — what gets billed']));
    host.appendChild(h('label', {}, ['Hours before scheduled start']));
    host.appendChild(slider);
    host.appendChild(readout);
    host.appendChild(hoursTxt);
    host.appendChild(tierBadge);
    host.appendChild(h('div', { class: 'widget-figures' }, [
      h('div', { class: 'widget-fig is-bloom' }, [
        h('span', { class: 'lbl' }, ['Client billed']),
        billVal
      ]),
      h('div', { class: 'widget-fig is-river' }, [
        h('span', { class: 'lbl' }, ['Interpreter paid']),
        payVal
      ])
    ]));
    host.appendChild(h('small', { class: 'widget-caption' },
      ['Default tiers — every client can override these in their billing rules.']));

    function update() {
      var hrs = parseInt(slider.value, 10);
      var t = tierForHours(hrs);
      hoursTxt.textContent = hrs + ' hour' + (hrs === 1 ? '' : 's') + ' before the job';
      tierBadge.textContent = t.label;
      tierBadge.dataset.tier = t.key;
      billVal.textContent = t.bill + '%';
      payVal.textContent  = t.pay + '%';
    }
    slider.addEventListener('input', update);
    update();
  }

  // ---------------------------------------------------------------------------
  // Widget: SMS YES/NO simulator
  // ---------------------------------------------------------------------------
  function mountSms(host) {
    host.classList.add('widget');
    var phone = h('div', { class: 'sms-phone' });
    var thread = h('div', { class: 'sms-thread', role: 'log', 'aria-live': 'polite' });
    var input  = h('input', { type: 'text', placeholder: 'Type YES, NO, or STOP…', 'aria-label': 'Your reply' });
    var submit = h('button', { type: 'submit' }, ['Send']);
    var form   = h('form', { class: 'sms-form' }, [input, submit]);
    phone.appendChild(thread);
    phone.appendChild(form);

    host.appendChild(h('div', { class: 'widget-title' }, ['Claim a job by text']));
    host.appendChild(phone);
    host.appendChild(h('small', { class: 'widget-caption' },
      ['Try typing YES, NO, or STOP. This is the same flow that runs on real offers — no app install needed.']));

    function bubble(side, text) {
      var b = h('div', { class: 'sms-bubble from-' + side }, [text]);
      thread.appendChild(b);
      thread.scrollTop = thread.scrollHeight;
      return b;
    }

    // Opening offer
    bubble('agency',
      'Job offer: Medical ASL — Tomorrow 2:00 PM at Frederick Health Cardiology. Reply YES to accept, NO to decline. ~1h, on-site.');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var val = (input.value || '').trim();
      if (!val) return;
      bubble('user', val);
      input.value = '';
      var v = val.toLowerCase();

      setTimeout(function () {
        if (v === 'yes' || v === 'y') {
          bubble('agency', 'Confirmed for Tue 2:00 PM, Frederick Health Cardiology. Full details + directions in your portal.');
        } else if (v === 'no' || v === 'n' || v === 'decline') {
          bubble('agency', 'Got it — we will find another interpreter. Reply STOP to opt out of SMS offers.');
        } else if (v === 'stop') {
          bubble('agency', 'You are unsubscribed from SMS offers. Sign in to the portal to re-enable.');
        } else {
          bubble('agency', 'Reply YES to claim, NO to pass, or sign in for full details.');
        }
      }, 380);
    });
  }

  // ---------------------------------------------------------------------------
  // Widget: client hierarchy tree
  // ---------------------------------------------------------------------------
  var CLIENT_TREE = {
    name: 'Frederick Health',
    meta: '4 departments · 6 locations · 7 specialists',
    summary: 'All consolidated to one billing office · NET 30',
    depts: [
      {
        name: 'Cardiology',
        locations: 'Main Hospital · Urbana Clinic',
        specialists: 'Dr. Aisha Patel · Dr. Mei Chen'
      },
      {
        name: 'Emergency Department',
        locations: 'FH Emergency',
        specialists: 'Dr. Marco Rossi'
      },
      {
        name: 'Pediatrics',
        locations: 'Mt Airy · Brunswick',
        specialists: 'Dr. Lena Park'
      },
      {
        name: 'Oncology Center',
        locations: 'Stockman Cancer Institute',
        specialists: 'Dr. James Okafor'
      }
    ]
  };

  function mountClients(host) {
    host.classList.add('widget');
    host.appendChild(h('div', { class: 'widget-title' }, ['One client. Many departments. One bill.']));

    var children = CLIENT_TREE.depts.map(function (d) {
      return h('li', {}, [
        h('span', { class: 'dept-title' }, [d.name]),
        h('span', { class: 'dept-meta' }, [d.locations]),
        h('span', { class: 'dept-meta' }, [d.specialists])
      ]);
    });
    var childList = h('ul', { class: 'tree-children' }, children);

    var header = h('button', {
      type: 'button',
      class: 'tree-header',
      'aria-expanded': 'false',
      'aria-controls': 'tree-children-fh'
    }, [
      h('span', { class: 'tree-caret', 'aria-hidden': 'true' }, ['›']),
      h('span', {}, [CLIENT_TREE.name]),
      h('span', { class: 'tree-count' }, [CLIENT_TREE.meta])
    ]);
    childList.id = 'tree-children-fh';

    function toggle() {
      var open = header.getAttribute('aria-expanded') === 'true';
      header.setAttribute('aria-expanded', open ? 'false' : 'true');
      childList.classList.toggle('is-open', !open);
    }
    header.addEventListener('click', toggle);

    host.appendChild(h('div', { class: 'tree' }, [
      h('div', { class: 'tree-node' }, [header, childList])
    ]));
    host.appendChild(h('div', { class: 'tree-summary' }, ['→ ' + CLIENT_TREE.summary]));
    host.appendChild(h('small', { class: 'widget-caption' },
      ['Click the client to expand. Real platform supports 5 consolidation modes per client.']));
  }

  // ---------------------------------------------------------------------------
  // Bootstrap widgets
  // ---------------------------------------------------------------------------
  var WIDGETS = {
    lifecycle: mountLifecycle,
    rates: mountRates,
    cancel: mountCancel,
    sms: mountSms,
    clients: mountClients
  };

  function initWidgets() {
    document.querySelectorAll('[data-widget]').forEach(function (host) {
      if (host.dataset.widgetMounted === '1') return;
      var fn = WIDGETS[host.dataset.widget];
      if (!fn) return;
      try {
        fn(host);
        host.dataset.widgetMounted = '1';
      } catch (err) {
        if (window.console) console.warn('[marketing-interact] widget failed:', host.dataset.widget, err);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Go
  // ---------------------------------------------------------------------------
  function start() {
    initWidgets();
    initReveal();
    initCountUp();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
