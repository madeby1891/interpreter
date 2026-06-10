/* 1891 Interpreter — sandbox engine (/try/).
 *
 * Instant-boot, client-side sandbox with a tease-then-gate email step.
 * Deviations from DEMO_SANDBOX.md v1, on purpose (gated-sandbox variant):
 *   - No setup page: the console boots immediately on a default scenario.
 *   - After GATE_AT meaningful actions the sandbox hard-gates on a work
 *     email; a signed continuation link (7 days) re-opens it. Return visits
 *     stay locked until the link is clicked.
 *   - Funnel events fire through the site's standard event beacon
 *     (window.track) — same consent posture as every marketing page.
 * Demo data still lives ONLY in localStorage. Payments/SMS/AI are faked.
 *
 * Storage keys: itp-sandbox-config | itp-sandbox-state |
 *               itp-sandbox-started-at | itp-sandbox-gate
 */
(function () {
  'use strict';

  var NS = 'itp-sandbox-';
  var SANDBOX_DAYS = 14;
  var GATE_AT = 5;               // meaningful actions before the gate
  var RESEND_COOLDOWN_S = 60;
  var FORMS_ENDPOINT = 'https://1891-interpreter-api.anthonymowl.workers.dev/v1/proxy/exec';
  var BASE = '/interpreter';

  // --- storage ----------------------------------------------------------------

  function storageOk() {
    try {
      localStorage.setItem(NS + 'probe', '1');
      localStorage.removeItem(NS + 'probe');
      return true;
    } catch (_) { return false; }
  }
  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(NS + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }
  function save(key, val) { localStorage.setItem(NS + key, JSON.stringify(val)); }
  function drop(key) { localStorage.removeItem(NS + key); }

  // --- tiny helpers -------------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function $(sel, el) { return (el || document).querySelector(sel); }
  function $all(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  function tk(name, props) { if (window.track) { try { window.track(name, props || {}); } catch (_) {} } }
  function fmtMoney(n) {
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtTime(iso) {
    var t = new Date(iso);
    return t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function fmtDay(iso) {
    var t = new Date(iso), today = new Date(); today.setHours(0,0,0,0);
    var that = new Date(t); that.setHours(0,0,0,0);
    var diff = Math.round((that - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function isToday(iso) { return fmtDay(iso) === 'Today'; }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#sbx-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 3400);
  }

  // --- state -------------------------------------------------------------------

  var SEEDS = window.ITP_SANDBOX_SEEDS;
  var config, state, gate;

  function defaultConfig() {
    return { vibe: SEEDS.default_vibe, theme: 'terra', brand: '', created_at: new Date().toISOString() };
  }
  function seedFor(vibe) { return SEEDS.vibes[vibe] || SEEDS.vibes[SEEDS.default_vibe]; }

  function freshState(vibe) {
    var s = JSON.parse(JSON.stringify(seedFor(vibe)));   // deep clone, never a reference
    s.actions = 0;
    s.events = {};
    s.jobs.forEach(function (j) {
      s.events[j.job_id] = [{ at: j.starts_at, label: 'Created from request' }];
      if (j.claimed_by) s.events[j.job_id].push({ at: j.starts_at, label: 'Claimed by ' + j.claimed_by });
      if (j.offered_to) s.events[j.job_id].push({ at: j.starts_at, label: 'Offered to ' + j.offered_to });
    });
    s.seq = 50;
    return s;
  }
  function saveState() { save('state', state); }

  function daysLeft() {
    var started = Number(load('started-at', Date.now()));
    var elapsed = (Date.now() - started) / 86400000;
    return Math.max(0, Math.ceil(SANDBOX_DAYS - elapsed));
  }

  // --- gate -------------------------------------------------------------------

  function gateLocked() { return gate && gate.fired_at && !gate.verified; }

  function fireGate() {
    gate.fired_at = new Date().toISOString();
    save('gate', gate);
    tk('sandbox_gate_shown', { actions: state.actions, vibe: config.vibe });
    renderGate();
  }

  function countAction(kind) {
    state.actions = (state.actions || 0) + 1;
    saveState();
    tk('sandbox_action', { kind: kind, n: state.actions });
    if (!gate.verified && !gate.fired_at && state.actions >= GATE_AT) fireGate();
  }

  function gateSubmit(email, consent) {
    var btn = $('#sbx-gate-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    var body = new URLSearchParams();
    body.append('form_id', 'sandbox_gate');
    body.append('email', email);
    body.append('marketing_consent', consent ? 'yes' : 'no');
    body.append('page', location.pathname);
    fetch(FORMS_ENDPOINT, { method: 'POST', body: body, mode: 'cors' })
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        if (resp && resp.ok) {
          gate.email = email;
          gate.sent_at = new Date().toISOString();
          save('gate', gate);
          tk('sandbox_gate_submitted', {});
          renderGate();
        } else {
          var err = $('#sbx-gate-err');
          if (err) err.textContent = (resp && resp.error) || 'Something went wrong — try again.';
          if (btn) { btn.disabled = false; btn.textContent = 'Email me my sandbox link'; }
        }
      })
      .catch(function () {
        var err = $('#sbx-gate-err');
        if (err) err.textContent = 'We couldn’t reach the server. Check your connection and try again — or email hello@madeby1891.com.';
        if (btn) { btn.disabled = false; btn.textContent = 'Email me my sandbox link'; }
      });
  }

  function verifyToken(token) {
    var body = new URLSearchParams();
    body.append('action', 'sandbox_verify');
    body.append('token', token);
    return fetch(FORMS_ENDPOINT, { method: 'POST', body: body, mode: 'cors' })
      .then(function (r) { return r.json(); });
  }

  function renderGate() {
    var root = $('#sbx-gate');
    if (!root) return;
    if (!gateLocked()) { root.hidden = true; root.innerHTML = ''; document.body.classList.remove('sbx-locked'); return; }
    document.body.classList.add('sbx-locked');
    root.hidden = false;

    var inner;
    if (!gate.sent_at) {
      inner =
        '<h2 id="sbx-gate-title">You’re clearly getting somewhere.</h2>' +
        '<p>You’ve run ' + esc(state.actions) + ' real actions in this sandbox. To keep going — and to be able to ' +
        'come back to exactly this screen later — tell us where to send your link.</p>' +
        '<form id="sbx-gate-form">' +
        '  <label for="sbx-gate-email">Work email</label>' +
        '  <input id="sbx-gate-email" type="email" required autocomplete="email" placeholder="you@youragency.com">' +
        '  <label class="sbx-check"><input id="sbx-gate-consent" type="checkbox"> Also send the short series on how agencies run on this. Optional — the link comes either way.</label>' +
        '  <button id="sbx-gate-submit" type="submit" class="sbx-btn sbx-btn-primary">Email me my sandbox link</button>' +
        '  <p id="sbx-gate-err" class="sbx-err" role="alert" aria-live="polite"></p>' +
        '</form>' +
        '<p class="sbx-fine">Your demo data stays in this browser — it never leaves your machine. Your email comes to us, and a real person can answer it.</p>' +
        '<p class="sbx-fine sbx-gate-alts">Rather not? <a href="' + BASE + '/pricing">See pricing</a> · ' +
        '<a href="' + BASE + '/free-for-deaf-owned">Free if Deaf-owned</a> · ' +
        '<a href="' + BASE + '/get-a-demo">Book a working session</a></p>';
    } else {
      inner =
        '<h2 id="sbx-gate-title">Check your inbox.</h2>' +
        '<p>We sent a link to <strong>' + esc(gate.email) + '</strong>. The sandbox unlocks the moment you open it — ' +
        'same data, same screen, for 14 more days.</p>' +
        '<p class="sbx-fine">Nothing arriving? Check spam, or:</p>' +
        '<button id="sbx-gate-resend" class="sbx-btn">Resend the link</button> ' +
        '<button id="sbx-gate-change" class="sbx-btn sbx-btn-ghost">Use a different email</button>' +
        '<p id="sbx-gate-err" class="sbx-err" role="alert" aria-live="polite"></p>';
    }

    root.innerHTML =
      '<div class="sbx-gate-card" role="dialog" aria-modal="true" aria-labelledby="sbx-gate-title">' + inner + '</div>';

    var form = $('#sbx-gate-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var email = $('#sbx-gate-email').value.trim();
        var consent = $('#sbx-gate-consent').checked;
        if (!email) return;
        gateSubmit(email, consent);
      });
      var first = $('#sbx-gate-email');
      if (first) first.focus();
    }
    var resend = $('#sbx-gate-resend');
    if (resend) {
      resend.addEventListener('click', function () {
        var last = gate.resent_at ? new Date(gate.resent_at).getTime() : 0;
        var waited = (Date.now() - Math.max(last, new Date(gate.sent_at).getTime())) / 1000;
        if (waited < RESEND_COOLDOWN_S) {
          $('#sbx-gate-err').textContent = 'Give it ' + Math.ceil(RESEND_COOLDOWN_S - waited) + 's, then try again.';
          return;
        }
        gate.resent_at = new Date().toISOString();
        save('gate', gate);
        gateSubmit(gate.email, false);
        $('#sbx-gate-err').textContent = 'Sent again.';
      });
    }
    var change = $('#sbx-gate-change');
    if (change) {
      change.addEventListener('click', function () {
        gate.sent_at = null;
        save('gate', gate);
        renderGate();
      });
    }
    // Hard gate: clicking the backdrop nudges, never dismisses.
    root.addEventListener('click', function (e) {
      if (e.target === root) {
        var card = $('.sbx-gate-card', root);
        if (card) { card.classList.remove('nudge'); void card.offsetWidth; card.classList.add('nudge'); }
      }
    });
  }

  // --- expiry -------------------------------------------------------------------

  function renderExpiry() {
    var root = $('#sbx-expiry');
    if (!root) return;
    if (daysLeft() > 0) { root.hidden = true; return; }
    root.hidden = false;
    root.innerHTML =
      '<div class="sbx-gate-card" role="dialog" aria-modal="true" aria-labelledby="sbx-exp-title">' +
      '<h2 id="sbx-exp-title">This sandbox wound down.</h2>' +
      '<p>Fourteen days came and went. Start a fresh one any time — or claim the real thing.</p>' +
      '<button id="sbx-exp-restart" class="sbx-btn sbx-btn-primary">Start a fresh sandbox</button> ' +
      '<a class="sbx-btn sbx-btn-ghost" href="' + BASE + '/pricing">See pricing</a>' +
      '</div>';
    tk('sandbox_expired', {});
    $('#sbx-exp-restart').addEventListener('click', function () {
      drop('state'); drop('started-at');
      tk('sandbox_reset', {});
      location.reload();
    });
  }

  // --- domain actions ------------------------------------------------------------

  function findJob(id) {
    for (var i = 0; i < state.jobs.length; i++) if (state.jobs[i].job_id === id) return state.jobs[i];
    return null;
  }
  function clientName(id) {
    for (var i = 0; i < state.clients.length; i++) if (state.clients[i].client_id === id) return state.clients[i].name;
    return id;
  }
  function logEvent(jobId, label) {
    if (!state.events[jobId]) state.events[jobId] = [];
    state.events[jobId].push({ at: new Date().toISOString(), label: label });
  }

  function claimJob(id, who) {
    var j = findJob(id); if (!j) return;
    j.status = 'CLAIMED';
    j.claimed_by = who || 'You (interpreter view)';
    delete j.offered_to;
    logEvent(id, 'Claimed by ' + j.claimed_by);
    saveState(); countAction('claim'); renderAll();
    toast(j.job_id + ' claimed — scheduler sees it instantly.');
  }
  function offerJob(id, who) {
    var j = findJob(id); if (!j) return;
    j.status = 'OFFERED';
    j.offered_to = who;
    logEvent(id, 'Offered to ' + who + ' (text + app)');
    saveState(); countAction('offer'); renderAll();
    toast('Offer sent to ' + who + ' — in the live product that’s a text they answer YES to.');
  }
  function confirmJob(id) {
    var j = findJob(id); if (!j) return;
    j.status = 'CONFIRMED';
    if (j.offered_to && !j.claimed_by) { j.claimed_by = j.offered_to; delete j.offered_to; }
    logEvent(id, 'Confirmed — requestor notified');
    saveState(); countAction('confirm'); renderAll();
    toast(j.job_id + ' confirmed. Requestor gets the email + calendar invite.');
  }
  function completeJob(id) {
    var j = findJob(id); if (!j) return;
    j.status = 'COMPLETED';
    logEvent(id, 'Completed — billing line drafted');
    var draft = null;
    for (var i = 0; i < state.invoices.length; i++) {
      if (state.invoices[i].status === 'draft' && state.invoices[i].client_id === j.client_id) draft = state.invoices[i];
    }
    if (!draft) {
      state.seq += 1;
      draft = { invoice_id: 'INV-' + (2032 + state.seq), client_id: j.client_id, period: 'Current period',
                amount: 0, status: 'draft', due: null, lines: 0 };
      state.invoices.unshift(draft);
    }
    var est = Number(String(j.pay_estimate || '$120').replace(/[^0-9.]/g, '').split('.')[0] || 120);
    draft.amount = Math.round((draft.amount + est * 1.45) * 100) / 100;  // agency rate over interpreter pay
    draft.lines += 1;
    saveState(); countAction('complete'); renderAll();
    toast(j.job_id + ' closed out → line added to ' + draft.invoice_id + ' (draft).');
  }
  function cancelJob(id) {
    var j = findJob(id); if (!j) return;
    j.status = 'CANCELED';
    logEvent(id, 'Canceled — cancellation policy preview shown');
    saveState(); countAction('cancel'); renderAll();
    toast(j.job_id + ' canceled. The live product shows the fee preview before you do this.');
  }
  function markPaid(id) {
    for (var i = 0; i < state.invoices.length; i++) {
      if (state.invoices[i].invoice_id === id) {
        state.invoices[i].status = 'paid';
        saveState(); countAction('invoice_paid'); renderAll();
        toast(id + ' marked paid.');
        return;
      }
    }
  }
  function sendInvoice(id) {
    for (var i = 0; i < state.invoices.length; i++) {
      if (state.invoices[i].invoice_id === id && state.invoices[i].status === 'draft') {
        state.invoices[i].status = 'sent';
        var due = new Date(); due.setDate(due.getDate() + 30);
        state.invoices[i].due = due.toISOString();
        saveState(); countAction('invoice_send'); renderAll();
        toast(id + ' sent (sandbox: nothing actually emails).');
        return;
      }
    }
  }

  function genericCandidates(job) {
    // For visitor-created jobs: score the roster with the same public weights
    // the live placeholder logic uses (language 30 · remote-vs-onsite 20|12 ·
    // preference 10 · workload by recent load · performance 11).
    return state.interpreters.map(function (i) {
      var langOk = (i.languages || []).indexOf(job.language) >= 0;
      var c = langOk ? 30 : 0;
      var l = job.modality !== 'on-site' ? 20 : 12;
      var w = Math.max(4, 15 - Math.round((i.jobs_30d || 10) / 3));
      var cd = { interpreter_id: i.interpreter_id, display_name: i.display_name, deaf: i.deaf,
                 score: { total: c + l + 10 + w + 11, max: 100,
                          breakdown: { certification: c, location: l, preference: 10, workload: w, performance: 11 } },
                 note: langOk ? '' : 'No ' + job.language + ' — shown for contrast' };
      return cd;
    }).sort(function (a, b) { return b.score.total - a.score.total; }).slice(0, 5);
  }

  function createJob(fields) {
    state.seq += 1;
    var id = 'J-' + (4000 + state.seq);
    var starts = new Date(); starts.setDate(starts.getDate() + 1); starts.setHours(10, 0, 0, 0);
    var ends = new Date(starts.getTime() + 60 * 60000);
    var job = {
      job_id: id, status: 'OPEN', client_id: fields.client_id, setting: fields.setting || 'New request',
      location: fields.modality === 'on-site' ? (clientName(fields.client_id)) : fields.modality.toUpperCase(),
      modality: fields.modality, language: fields.language,
      starts_at: starts.toISOString(), ends_at: ends.toISOString(),
      consumer: 'initials on file', pay_estimate: '$96–$128', requirements: [], team_size: 1, created_in_sandbox: true
    };
    state.jobs.unshift(job);
    state.events[id] = [{ at: new Date().toISOString(), label: 'Created in the sandbox' }];
    state.smartfill[id] = genericCandidates(job);
    saveState(); countAction('create_job'); renderAll();
    toast(id + ' created — run smart-fill to rank the roster for it.');
    openDrawer(id);
  }

  // --- rendering -----------------------------------------------------------------

  var activeTab = 'today';
  var drawerJob = null;
  var smartfillShown = {};   // job_id → true once revealed this session

  function statusChip(s) {
    var cls = { OPEN: 'open', OFFERED: 'offered', CLAIMED: 'claimed', CONFIRMED: 'confirmed', COMPLETED: 'done', CANCELED: 'canceled' }[s] || 'open';
    return '<span class="sbx-chip sbx-chip-' + cls + '">' + esc(s) + '</span>';
  }

  function jobCard(j) {
    var who = j.claimed_by || j.offered_to || '';
    return (
      '<button class="sbx-card sbx-jobcard" data-job="' + esc(j.job_id) + '" aria-haspopup="dialog">' +
      '<div class="sbx-card-top">' + statusChip(j.status) +
      '<span class="sbx-when">' + esc(fmtDay(j.starts_at)) + ' · ' + esc(fmtTime(j.starts_at)) + '</span></div>' +
      '<strong>' + esc(j.setting) + '</strong>' +
      '<span class="sbx-meta">' + esc(clientName(j.client_id)) + ' · ' + esc(j.language) + ' · ' + esc(j.modality) + '</span>' +
      (who ? '<span class="sbx-meta">→ ' + esc(who) + '</span>' : '') +
      '</button>'
    );
  }

  function renderKpis() {
    var todays = state.jobs.filter(function (j) { return isToday(j.starts_at) && j.status !== 'CANCELED'; });
    var open = state.jobs.filter(function (j) { return j.status === 'OPEN'; });
    var filled = todays.filter(function (j) { return j.status !== 'OPEN'; });
    var fillRate = todays.length ? Math.round(100 * filled.length / todays.length) : 100;
    var ar = state.invoices.filter(function (i) { return i.status === 'sent'; })
      .reduce(function (a, i) { return a + i.amount; }, 0);
    var overdue = state.invoices.filter(function (i) {
      return i.status === 'sent' && i.due && new Date(i.due) < new Date();
    }).length;
    $('#sbx-kpis').innerHTML =
      '<div class="sbx-kpi"><span>' + todays.length + '</span>jobs today</div>' +
      '<div class="sbx-kpi' + (open.length ? ' warn' : '') + '"><span>' + open.length + '</span>need an interpreter</div>' +
      '<div class="sbx-kpi"><span>' + fillRate + '%</span>today filled</div>' +
      '<div class="sbx-kpi' + (overdue ? ' warn' : '') + '"><span>' + fmtMoney(ar) + '</span>invoiced &amp; unpaid' +
      (overdue ? ' · ' + overdue + ' overdue' : '') + '</div>';
  }

  function renderToday(el) {
    var lanes = [
      { key: 'OPEN', label: 'Needs an interpreter', hint: 'Open the job and run smart-fill.' },
      { key: 'OFFERED', label: 'Offered — waiting on a YES' },
      { key: 'CLAIMED', label: 'Claimed' },
      { key: 'CONFIRMED', label: 'Confirmed' },
      { key: 'COMPLETED', label: 'Done' }
    ];
    var soon = state.jobs.slice().sort(function (a, b) { return new Date(a.starts_at) - new Date(b.starts_at); });
    el.innerHTML = '<div class="sbx-lanes">' + lanes.map(function (lane) {
      var jobs = soon.filter(function (j) { return j.status === lane.key; });
      return '<section class="sbx-lane"><h3>' + esc(lane.label) + ' <span class="sbx-count">' + jobs.length + '</span></h3>' +
        (jobs.length ? jobs.map(jobCard).join('') :
          '<p class="sbx-empty">' + esc(lane.hint || 'Nothing here right now.') + '</p>') +
        '</section>';
    }).join('') + '</div>';
  }

  function renderJobs(el) {
    var rows = state.jobs.map(function (j) {
      return '<tr><td><button class="sbx-link" data-job="' + esc(j.job_id) + '">' + esc(j.job_id) + '</button></td>' +
        '<td>' + esc(j.setting) + '</td><td>' + esc(clientName(j.client_id)) + '</td>' +
        '<td>' + esc(fmtDay(j.starts_at)) + ' ' + esc(fmtTime(j.starts_at)) + '</td>' +
        '<td>' + esc(j.language) + '</td><td>' + statusChip(j.status) + '</td></tr>';
    }).join('');
    var clientOpts = state.clients.map(function (c) {
      return '<option value="' + esc(c.client_id) + '">' + esc(c.name) + '</option>';
    }).join('');
    var langs = {};
    state.interpreters.forEach(function (i) { (i.languages || []).forEach(function (l) { langs[l] = true; }); });
    var langOpts = Object.keys(langs).map(function (l) { return '<option>' + esc(l) + '</option>'; }).join('');
    el.innerHTML =
      '<form id="sbx-newjob" class="sbx-newjob">' +
      '<strong>New job</strong>' +
      '<input name="setting" placeholder="What is it? e.g. Cardiology follow-up" required>' +
      '<select name="client_id" aria-label="Client">' + clientOpts + '</select>' +
      '<select name="language" aria-label="Language">' + langOpts + '</select>' +
      '<select name="modality" aria-label="Modality"><option>on-site</option><option>VRI</option><option>OPI</option></select>' +
      '<button class="sbx-btn sbx-btn-primary" type="submit">Create</button>' +
      '<span class="sbx-fine">Tomorrow 10am, one hour — the live product asks properly.</span>' +
      '</form>' +
      '<table class="sbx-table"><thead><tr><th>Job</th><th>Setting</th><th>Client</th><th>When</th><th>Language</th><th>Status</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
    $('#sbx-newjob').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      createJob({ setting: f.setting.value.trim(), client_id: f.client_id.value,
                  language: f.language.value, modality: f.modality.value });
    });
  }

  function renderClaim(el) {
    var open = state.jobs.filter(function (j) { return j.status === 'OPEN'; });
    el.innerHTML =
      '<p class="sbx-viewnote">This is the <strong>interpreter’s</strong> view — what your roster sees on their phone. ' +
      'Pay is shown before they accept. In the live product this also works by text: reply YES to claim.</p>' +
      '<div class="sbx-phone">' + (open.length ? open.map(function (j) {
        return '<div class="sbx-offer">' +
          '<div class="sbx-card-top"><strong>' + esc(fmtDay(j.starts_at)) + ' · ' + esc(fmtTime(j.starts_at)) + '</strong>' +
          '<span class="sbx-pay">' + esc(j.pay_estimate) + '</span></div>' +
          '<span>' + esc(j.setting) + '</span>' +
          '<span class="sbx-meta">' + esc(j.location) + ' · ' + esc(j.language) + ' · ' + esc(j.modality) + '</span>' +
          ((j.requirements || []).length ? '<span class="sbx-meta">Needs: ' + esc(j.requirements.join(' · ')) + '</span>' : '') +
          '<div class="sbx-row"><button class="sbx-btn sbx-btn-primary" data-claim="' + esc(j.job_id) + '">Claim</button>' +
          '<button class="sbx-btn sbx-btn-ghost" data-pass="' + esc(j.job_id) + '">Pass</button></div>' +
          '</div>';
      }).join('') : '<p class="sbx-empty">No open jobs — create one on the Jobs tab.</p>') + '</div>';
  }

  function renderInterpreters(el) {
    el.innerHTML = '<div class="sbx-grid">' + state.interpreters.map(function (i) {
      return '<div class="sbx-card">' +
        '<strong>' + esc(i.display_name) + (i.deaf ? ' <span class="sbx-badge">Deaf</span>' : '') + '</strong>' +
        '<span class="sbx-meta">' + esc((i.languages || []).join(', ')) + ' · ' + esc((i.modalities || []).join(', ')) + '</span>' +
        '<span class="sbx-meta">' + esc((i.certifications || []).join(' · ') || 'No certifications on file') + '</span>' +
        '<span class="sbx-meta">' + esc(i.base_rate) + ' · ' + esc(i.jobs_30d) + ' jobs last 30 days</span>' +
        '</div>';
    }).join('') + '</div>' +
    '<p class="sbx-fine">The live roster also holds documents (licenses, COIs, W-9s), rate cards per client, and availability.</p>';
  }

  function renderInvoices(el) {
    el.innerHTML = '<table class="sbx-table"><thead><tr><th>Invoice</th><th>Client</th><th>Period</th><th>Lines</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>' +
      state.invoices.map(function (i) {
        var overdue = i.status === 'sent' && i.due && new Date(i.due) < new Date();
        var act = i.status === 'draft'
          ? '<button class="sbx-btn sbx-btn-sm" data-send-inv="' + esc(i.invoice_id) + '">Send</button>'
          : (i.status === 'sent' ? '<button class="sbx-btn sbx-btn-sm" data-pay-inv="' + esc(i.invoice_id) + '">Mark paid</button>' : '');
        return '<tr><td>' + esc(i.invoice_id) + '</td><td>' + esc(clientName(i.client_id)) + '</td>' +
          '<td>' + esc(i.period) + '</td><td>' + esc(i.lines) + '</td><td>' + fmtMoney(i.amount) + '</td>' +
          '<td><span class="sbx-chip sbx-chip-' + (i.status === 'paid' ? 'done' : overdue ? 'canceled' : i.status === 'sent' ? 'confirmed' : 'open') + '">' +
          esc(overdue ? 'overdue' : i.status) + '</span></td><td>' + act + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="sbx-fine">Completing a job on the board drafts its billing line automatically — try it. Numbers run in order, patient details stay off invoices.</p>';
  }

  function renderSettings(el) {
    var vibeOpts = Object.keys(SEEDS.vibes).map(function (k) {
      var sel = k === config.vibe ? ' selected' : '';
      return '<option value="' + esc(k) + '"' + sel + '>' + esc(SEEDS.vibes[k].label) + '</option>';
    }).join('');
    var themes = [['terra', 'Terracotta'], ['river', 'River teal'], ['slate', 'Slate']];
    el.innerHTML =
      '<div class="sbx-settings">' +
      '<label>Agency name <input id="sbx-set-brand" value="' + esc(config.brand || seedFor(config.vibe).agency.name) + '"></label>' +
      '<label>Scenario <select id="sbx-set-vibe">' + vibeOpts + '</select></label>' +
      '<div class="sbx-themes" role="group" aria-label="Theme">' + themes.map(function (t) {
        return '<button class="sbx-swatch sbx-swatch-' + t[0] + (config.theme === t[0] ? ' on' : '') + '" data-theme="' + t[0] + '" aria-pressed="' + (config.theme === t[0]) + '">' + esc(t[1]) + '</button>';
      }).join('') + '</div>' +
      '<button id="sbx-set-save" class="sbx-btn sbx-btn-primary">Save</button> ' +
      '<button id="sbx-set-reset" class="sbx-btn sbx-btn-ghost">Start over (wipe demo data)</button>' +
      '<div class="sbx-honest"><strong>What’s real here?</strong> Every click you make — the board, claims, smart-fill, invoices — is the real console UI. ' +
      'What’s faked: payments, texts, emails, and AI calls (those cost money or touch third parties). ' +
      'Your demo data lives in this browser’s storage, not on our servers. Switching scenarios resets the data.</div>' +
      '</div>';
    $('#sbx-set-save').addEventListener('click', function () {
      config.brand = $('#sbx-set-brand').value.trim();
      var newVibe = $('#sbx-set-vibe').value;
      var vibeChanged = newVibe !== config.vibe;
      config.vibe = newVibe;
      save('config', config);
      if (vibeChanged) {
        var acts = state.actions;
        state = freshState(config.vibe);
        state.actions = acts;          // scenario hop doesn't dodge the gate
        saveState();
      }
      countAction('settings_save');
      applyTheme(); renderAll();
      toast(vibeChanged ? 'Scenario switched — fresh data loaded.' : 'Saved.');
    });
    $('#sbx-set-reset').addEventListener('click', function () {
      drop('state'); drop('started-at'); drop('config');
      tk('sandbox_reset', {});
      location.reload();
    });
    $all('.sbx-swatch', el).forEach(function (b) {
      b.addEventListener('click', function () {
        config.theme = b.getAttribute('data-theme');
        save('config', config);
        applyTheme();
        $all('.sbx-swatch', el).forEach(function (x) {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-pressed', String(x === b));
        });
      });
    });
  }

  // --- job drawer (detail + smart-fill) -------------------------------------------

  function openDrawer(jobId) {
    drawerJob = jobId;
    renderDrawer();
  }
  function closeDrawer() {
    drawerJob = null;
    var root = $('#sbx-drawer');
    root.hidden = true; root.innerHTML = '';
  }

  function breakdownBars(b) {
    var parts = [['certification', 30], ['location', 20], ['preference', 20], ['workload', 15], ['performance', 15]];
    return '<div class="sbx-bars">' + parts.map(function (p) {
      var v = b[p[0]] || 0;
      return '<div class="sbx-bar"><span class="sbx-bar-label">' + p[0] + ' ' + v + '/' + p[1] + '</span>' +
        '<span class="sbx-bar-track"><span class="sbx-bar-fill" style="width:' + Math.round(100 * v / p[1]) + '%"></span></span></div>';
    }).join('') + '</div>';
  }

  function renderDrawer() {
    var root = $('#sbx-drawer');
    if (!drawerJob) { root.hidden = true; return; }
    var j = findJob(drawerJob);
    if (!j) { closeDrawer(); return; }
    root.hidden = false;

    var actions = [];
    if (j.status === 'OPEN') actions.push('<button class="sbx-btn sbx-btn-primary" data-smartfill="' + esc(j.job_id) + '">Run smart-fill</button>');
    if (j.status === 'OFFERED') actions.push('<button class="sbx-btn sbx-btn-primary" data-confirm="' + esc(j.job_id) + '">They said YES — confirm</button>');
    if (j.status === 'CLAIMED') actions.push('<button class="sbx-btn sbx-btn-primary" data-confirm="' + esc(j.job_id) + '">Confirm</button>');
    if (j.status === 'CONFIRMED') actions.push('<button class="sbx-btn sbx-btn-primary" data-complete="' + esc(j.job_id) + '">Close out (done)</button>');
    if (j.status !== 'COMPLETED' && j.status !== 'CANCELED') actions.push('<button class="sbx-btn sbx-btn-ghost" data-cancel="' + esc(j.job_id) + '">Cancel job</button>');

    var sf = '';
    if (smartfillShown[j.job_id] && state.smartfill[j.job_id]) {
      sf = '<h4>Smart-fill — ranked, with the working shown</h4>' +
        '<p class="sbx-fine">Certification 30 · location 20 · requestor preference 20 · workload balance 15 · prior performance 15.</p>' +
        state.smartfill[j.job_id].map(function (c) {
          return '<div class="sbx-cand">' +
            '<div class="sbx-cand-head"><strong>' + esc(c.display_name) + (c.deaf ? ' <span class="sbx-badge">Deaf</span>' : '') + '</strong>' +
            '<span class="sbx-score">' + c.score.total + '<small>/100</small></span></div>' +
            breakdownBars(c.score.breakdown) +
            (c.note ? '<span class="sbx-meta">' + esc(c.note) + '</span>' : '') +
            (j.status === 'OPEN' ? '<button class="sbx-btn sbx-btn-sm" data-offer="' + esc(j.job_id) + '|' + esc(c.display_name) + '">Offer this job</button>' : '') +
            '</div>';
        }).join('');
    }

    var timeline = (state.events[j.job_id] || []).map(function (ev) {
      return '<li><span>' + esc(fmtDay(ev.at)) + ' ' + esc(fmtTime(ev.at)) + '</span> ' + esc(ev.label) + '</li>';
    }).join('');

    root.innerHTML =
      '<div class="sbx-drawer-card" role="dialog" aria-modal="true" aria-label="Job ' + esc(j.job_id) + '">' +
      '<button class="sbx-drawer-x" data-close-drawer aria-label="Close">×</button>' +
      '<div class="sbx-card-top">' + statusChip(j.status) + '<span class="sbx-meta">' + esc(j.job_id) + '</span></div>' +
      '<h3>' + esc(j.setting) + '</h3>' +
      '<p class="sbx-meta">' + esc(clientName(j.client_id)) + ' · ' + esc(fmtDay(j.starts_at)) + ' ' + esc(fmtTime(j.starts_at)) + '–' + esc(fmtTime(j.ends_at)) +
      ' · ' + esc(j.location) + '</p>' +
      '<p class="sbx-meta">Language: ' + esc(j.language) + ' · ' + esc(j.modality) +
      ' · consumer: ' + esc(j.consumer) + ' · team of ' + esc(j.team_size) + '</p>' +
      ((j.requirements || []).length ? '<p class="sbx-meta">Needs: ' + esc(j.requirements.join(' · ')) + '</p>' : '') +
      '<p class="sbx-meta">Interpreter pay estimate: <strong>' + esc(j.pay_estimate) + '</strong> — shown to the interpreter before they accept.</p>' +
      '<div class="sbx-row">' + actions.join('') + '</div>' +
      sf +
      '<h4>Timeline</h4><ul class="sbx-timeline">' + timeline + '</ul>' +
      '<p class="sbx-fine">Every step lands in the audit log in the live product.</p>' +
      '</div>';
    root.addEventListener('click', function (e) { if (e.target === root) closeDrawer(); });
  }

  // --- shell -------------------------------------------------------------------

  var TABS = [
    ['today', 'Today'], ['jobs', 'Jobs'], ['claim', 'Interpreter view'],
    ['interpreters', 'Roster'], ['invoices', 'Invoices'], ['settings', 'Settings']
  ];

  function applyTheme() {
    document.documentElement.setAttribute('data-sandbox-theme', config.theme || 'terra');
    var brand = config.brand || seedFor(config.vibe).agency.name;
    $('#sbx-brand').textContent = brand;
    $('#sbx-vibe-label').textContent = seedFor(config.vibe).agency.tagline;
  }

  function renderTabs() {
    $('#sbx-tabs').innerHTML = TABS.map(function (t) {
      return '<button class="sbx-tab' + (activeTab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '" aria-selected="' + (activeTab === t[0]) + '" role="tab">' + t[1] + '</button>';
    }).join('');
  }

  function renderView() {
    var el = $('#sbx-view');
    if (activeTab === 'today') renderToday(el);
    else if (activeTab === 'jobs') renderJobs(el);
    else if (activeTab === 'claim') renderClaim(el);
    else if (activeTab === 'interpreters') renderInterpreters(el);
    else if (activeTab === 'invoices') renderInvoices(el);
    else renderSettings(el);
  }

  function renderCountdown() {
    var n = daysLeft();
    $('#sbx-days').textContent = gate.verified
      ? n + ' days left · verified'
      : n + ' days left in this sandbox';
  }

  function renderAll() {
    applyTheme();
    renderKpis();
    renderTabs();
    renderView();
    renderCountdown();
    if (drawerJob) renderDrawer();
  }

  // --- event delegation -----------------------------------------------------------

  function wireDelegation() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-tab],[data-job],[data-claim],[data-pass],[data-smartfill],[data-offer],[data-confirm],[data-complete],[data-cancel],[data-pay-inv],[data-send-inv],[data-close-drawer]') : null;
      if (!t) return;
      if (t.hasAttribute('data-tab')) { activeTab = t.getAttribute('data-tab'); renderTabs(); renderView(); return; }
      if (t.hasAttribute('data-close-drawer')) { closeDrawer(); return; }
      if (t.hasAttribute('data-job')) { openDrawer(t.getAttribute('data-job')); return; }
      if (t.hasAttribute('data-claim')) { claimJob(t.getAttribute('data-claim')); return; }
      if (t.hasAttribute('data-pass')) { toast('Passed — the next ranked interpreter gets it. Nothing is ever forced.'); return; }
      if (t.hasAttribute('data-smartfill')) {
        var id = t.getAttribute('data-smartfill');
        smartfillShown[id] = true;
        if (!state.smartfill[id]) state.smartfill[id] = genericCandidates(findJob(id));
        countAction('smart_fill');
        renderDrawer();
        return;
      }
      if (t.hasAttribute('data-offer')) {
        var p = t.getAttribute('data-offer').split('|');
        offerJob(p[0], p[1]);
        return;
      }
      if (t.hasAttribute('data-confirm')) { confirmJob(t.getAttribute('data-confirm')); return; }
      if (t.hasAttribute('data-complete')) { completeJob(t.getAttribute('data-complete')); return; }
      if (t.hasAttribute('data-cancel')) { cancelJob(t.getAttribute('data-cancel')); return; }
      if (t.hasAttribute('data-pay-inv')) { markPaid(t.getAttribute('data-pay-inv')); return; }
      if (t.hasAttribute('data-send-inv')) { sendInvoice(t.getAttribute('data-send-inv')); return; }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawerJob) closeDrawer();
    });
    // Exit CTAs: count clicks (links navigate normally).
    $all('.sbx-exits a').forEach(function (a) {
      a.addEventListener('click', function () { tk('sandbox_exit_click', { href: a.getAttribute('href') }); });
    });
    // If a second tab verifies the gate, unlock this one live.
    window.addEventListener('storage', function (ev) {
      if (ev.key === NS + 'gate') {
        gate = load('gate', gate);
        if (!gateLocked()) { renderGate(); renderCountdown(); toast('Verified — welcome back.'); }
      }
    });
  }

  // --- boot --------------------------------------------------------------------

  function boot() {
    if (!SEEDS) { alert('The sandbox seed data failed to load. Refresh, or email hello@madeby1891.com.'); return; }
    if (!storageOk()) {
      alert('Your browser blocked localStorage. The sandbox needs it to remember your data — private windows usually block it.');
      return;
    }

    config = load('config', null);
    var firstVisit = !config;
    if (!config) {
      config = defaultConfig();
      save('config', config);
      save('started-at', Date.now());
    }
    state = load('state', null) || freshState(config.vibe);
    saveState();
    gate = load('gate', { fired_at: null, verified: false, email: null, sent_at: null });

    var params = new URLSearchParams(location.search);
    var sbt = params.get('sbt');

    function finishBoot() {
      renderAll();
      renderGate();
      renderExpiry();
      wireDelegation();
      setInterval(function () { renderCountdown(); renderExpiry(); }, 60000);
      tk('sandbox_boot', { vibe: config.vibe, first: firstVisit, verified: !!gate.verified, actions: state.actions || 0 });
      if (firstVisit) toast('This is a live sandbox — click anything. The data is yours to break.');
    }

    if (sbt) {
      verifyToken(sbt).then(function (resp) {
        history.replaceState(null, '', location.pathname);
        if (resp && resp.ok) {
          gate.verified = true;
          gate.verified_email = resp.email;
          save('gate', gate);
          save('started-at', Date.now());   // verified → a fresh 14-day window
          tk('sandbox_gate_verified', {});
          finishBoot();
          toast('Verified — this sandbox is yours for 14 more days.');
        } else {
          if (resp && resp.code === 'expired' && gate.email) gate.sent_at = null;  // re-offer the form
          save('gate', gate);
          finishBoot();
          if (resp && resp.code === 'expired') toast('That link expired — ask for a fresh one.');
          else toast('That link didn’t check out — ask for a fresh one.');
        }
      }).catch(function () { finishBoot(); });
    } else {
      finishBoot();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
