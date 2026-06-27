// captions.js — 1891 Interpreter Live Captions.
//
// Every device that opens this page joins a session by code and sees live
// captions of the whole conversation. Any device can turn itself into the
// microphone (after a consent check) so its speaker's words show up captioned
// on everyone's screen. Spoken English -> text only — this never auto-captions
// ASL. No install, just a name and a shared code.
//
// Backend: workers/captions (one realtime room per session code). The room URL
// is an endpoint in code, not branding — carries no platform name in the UI.

(function () {
  'use strict';

  // The realtime room. Override with ?api= for local dev (e.g. ws://localhost:8787).
  var API = new URLSearchParams(location.search).get('api') ||
    'wss://1891-interpreter-captions.anthonymowl.workers.dev';

  // ---- Captioning Magic (opt-in) ------------------------------------------
  // ?magic=1 turns this page into a Shazam-style "press to search for captions"
  // experience: the mic does NOT listen continuously — a separate module
  // (captioning-magic.js) drives an explicit idle -> searching -> locked|no-match
  // state machine and calls these hooks. When the flag is absent, MAGIC is false
  // and every hook below is a no-op, so the group/classroom continuous-listen
  // flow is byte-for-byte unchanged. The module only attaches if MAGIC is true.
  var MAGIC = (function () {
    try { return new URLSearchParams(location.search).get('magic') === '1'; }
    catch (e) { return false; }
  })();
  // Thin event bus the magic module subscribes to. Created unconditionally so
  // the engine code can fire into it cheaply, but only ever read in MAGIC mode.
  var MagicBus = {
    _h: { level: [], caption: [], micstatus: [], micopen: [], micclose: [] },
    on: function (k, fn) { if (this._h[k]) this._h[k].push(fn); },
    emit: function (k, a) {
      if (!MAGIC) return;
      var hs = this._h[k]; if (!hs) return;
      for (var i = 0; i < hs.length; i++) { try { hs[i](a); } catch (e) {} }
    }
  };

  // ---- tiny DOM helpers ---------------------------------------------------
  function $(sel) { return document.querySelector(sel); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  function toast(msg) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show';
    setTimeout(function () { t.className = 'toast'; }, 3200);
  }

  // ---- persistent identity ------------------------------------------------
  function deviceId() {
    var k = 'intcap:deviceId', v = '';
    try { v = localStorage.getItem(k) || ''; } catch (e) {}
    if (!v) {
      v = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
      try { localStorage.setItem(k, v); } catch (e) {}
    }
    return v;
  }
  function savedName() { try { return localStorage.getItem('intcap:name') || ''; } catch (e) { return ''; } }
  function saveName(n) { try { localStorage.setItem('intcap:name', n); } catch (e) {} }

  // ---- session code -------------------------------------------------------
  function newCode() {
    // 10 chars x 32-symbol alphabet ~ 50 bits of entropy — the code IS the
    // capability (shared by link), so it must be unguessable, not enumerable.
    var alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars; 32 divides 256 -> unbiased
    var n = 10, bytes = new Uint8Array(n);
    (crypto.getRandomValues ? crypto.getRandomValues(bytes) : bytes.fill(0));
    var s = '';
    for (var i = 0; i < n; i++) s += alpha[bytes[i] % alpha.length];
    return s;
  }
  function normCode(c) { return (c || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24); }

  // ===========================================================================
  // State
  // ===========================================================================
  var S = {
    id: deviceId(),
    name: '',
    code: '',
    join: null,          // join WebSocket
    joinTries: 0,
    joinTimer: null,
    heartbeat: null,
    members: [],
    me: null,            // {id,name,color}
    people: {},          // id -> {name,color}: current label per speaker (for re-labeling)
    captionsConfigured: true,
    committed: [],       // finalized caption frames in order
    interim: {},         // id -> {id,name,color,text}
    starting: false,
    mic: {               // microphone capture state
      on: false,
      ws: null,
      stream: null,
      ctx: null,
      node: null,
      level: 0
    }
  };

  // ===========================================================================
  // Start panel (lobby)
  // ===========================================================================
  function showStart() {
    var p = new URLSearchParams(location.search);
    var code = normCode(p.get('s') || p.get('session') || '');
    $('#f-code').value = code;
    $('#f-name').value = savedName();
    $('#start-view').style.display = '';
    $('#session-view').style.display = 'none';
    setTimeout(function () { $('#f-name').focus(); }, 50);
  }

  function startNewSession() {
    $('#f-code').value = newCode();
    S.starting = true; // marks this as a fresh session
    $('#f-name').focus();
  }

  function submitStart(e) {
    if (e) e.preventDefault();
    var name = ($('#f-name').value || '').trim();
    if (!name) { $('#f-name').focus(); return; }
    var code = normCode($('#f-code').value || '') || newCode();
    saveName(name);
    S.name = name;
    S.code = code;
    S.starting = false;
    history.replaceState(null, '', location.pathname + '?s=' + encodeURIComponent(code));
    enterSession();
  }

  // ===========================================================================
  // Session view
  // ===========================================================================
  function enterSession() {
    $('#start-view').style.display = 'none';
    $('#session-view').style.display = 'block';
    $('#session-code').textContent = S.code;
    renderInvite();
    connectJoin();
    updateMicButton();
  }

  function inviteLink() {
    return location.origin + location.pathname + '?s=' + encodeURIComponent(S.code);
  }
  function renderInvite() {
    $('#invite-link').textContent = inviteLink().replace(/^https?:\/\//, '');
  }
  function copyInvite() {
    var link = inviteLink();
    var done = function () { toast('Link copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, function () { legacyCopy(link); done(); });
    } else { legacyCopy(link); done(); }
  }
  function legacyCopy(text) {
    var t = el('textarea'); t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(t);
  }

  function leaveSession() {
    stopMic();
    if (S.join) { try { S.join.close(); } catch (e) {} S.join = null; }
    if (S.heartbeat) { clearInterval(S.heartbeat); S.heartbeat = null; }
    if (S.joinTimer) { clearTimeout(S.joinTimer); S.joinTimer = null; }
    S.committed = []; S.interim = {}; S.members = [];
    history.replaceState(null, '', location.pathname);
    showStart();
  }

  // ===========================================================================
  // Join socket — presence + caption receive (with auto-reconnect)
  // ===========================================================================
  function connectJoin() {
    var u = API + '/captions/join/' + encodeURIComponent(S.code) +
      '?id=' + encodeURIComponent(S.id) + '&name=' + encodeURIComponent(S.name);
    var ws;
    try { ws = new WebSocket(u); } catch (e) { scheduleReconnect(); return; }
    S.join = ws;
    setConn('connecting');

    ws.onopen = function () {
      S.joinTries = 0;
      setConn('connected');
      if (S.heartbeat) clearInterval(S.heartbeat);
      S.heartbeat = setInterval(function () {
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
      }, 25000);
    };
    ws.onmessage = function (ev) {
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleServer(msg);
    };
    ws.onclose = function () { setConn('offline'); scheduleReconnect(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function scheduleReconnect() {
    if (S.heartbeat) { clearInterval(S.heartbeat); S.heartbeat = null; }
    if ($('#session-view').style.display === 'none') return; // left the session
    S.joinTries++;
    var delay = Math.min(15000, 600 * Math.pow(1.6, Math.min(S.joinTries, 8)));
    if (S.joinTimer) clearTimeout(S.joinTimer);
    S.joinTimer = setTimeout(connectJoin, delay);
  }

  function setConn(state) {
    var dot = $('#conn-dot'), label = $('#conn-label');
    dot.dataset.state = state;
    label.textContent = state === 'connected' ? 'Connected'
      : state === 'connecting' ? 'Joining…'
      : 'Reconnecting…';
  }

  function handleServer(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'welcome') {
      S.me = msg.you;
      S.members = msg.members || [];
      learnPeople(S.members);
      if (msg.you) S.people[msg.you.id] = { name: msg.you.name, color: msg.you.color };
      S.captionsConfigured = msg.captions_configured !== false;
      S.committed = (msg.history || []).slice();
      S.committed.forEach(function (f) { S.people[f.id] = { name: f.name, color: f.color }; });
      S.interim = {};
      renderRoster(); renderCaptions(); renderCaptionsNote();
    } else if (msg.type === 'roster') {
      S.members = msg.members || [];
      learnPeople(S.members);
      renderRoster(); renderCaptions();
    } else if (msg.type === 'relabel') {
      var prev = S.people[msg.id] || {};
      S.people[msg.id] = { name: msg.name, color: msg.color || prev.color };
      renderRoster(); renderCaptions();
    } else if (msg.type === 'caption') {
      onCaption(msg);
    }
  }
  function learnPeople(members) {
    (members || []).forEach(function (m) { S.people[m.id] = { name: m.name, color: m.color }; });
  }

  // ===========================================================================
  // Caption rendering (color-coded; interim vs final)
  // ===========================================================================
  function onCaption(f) {
    S.people[f.id] = { name: f.name, color: f.color };
    MagicBus.emit('caption', f); // press-to-search "lock" detection (magic mode)
    if (f.is_final) {
      delete S.interim[f.id];
      if (f.text) {
        S.committed.push(f);
        if (S.committed.length > 400) S.committed.shift();
      }
    } else {
      S.interim[f.id] = { id: f.id, name: f.name, color: f.color, text: f.text };
    }
    renderCaptions();
  }

  // Group CONSECUTIVE captions from the same speaker into one running turn, so a
  // continuous speaker shows their name once and keeps going — not a new
  // "Name:" on every sentence. A new turn starts only when the speaker changes.
  function buildTurns(committed, interim) {
    var turns = [];
    var push = function (id, name, color, text, isInterim) {
      var last = turns[turns.length - 1];
      if (last && last.id === id) { last.parts.push({ text: text, interim: isInterim }); }
      else { turns.push({ id: id, name: name, color: color, parts: [{ text: text, interim: isInterim }] }); }
    };
    committed.forEach(function (f) { push(f.id, f.name, f.color, f.text, false); });
    Object.keys(interim).forEach(function (id) {
      var it = interim[id];
      if (it && it.text) push(it.id, it.name, it.color, it.text, true);
    });
    return turns;
  }

  function renderCaptions() {
    var feed = $('#feed');
    var atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    var lines = $('#lines');
    var turns = buildTurns(S.committed, S.interim);
    var frag = document.createDocumentFragment();
    turns.forEach(function (t) { frag.appendChild(captionTurn(t)); });
    lines.innerHTML = '';
    lines.appendChild(frag);
    $('#empty-state').hidden = S.committed.length > 0 || Object.keys(S.interim).length > 0;
    if (atBottom) feed.scrollTop = feed.scrollHeight;
  }

  // One block per speaker turn: the name once (in the speaker's color), then
  // every sentence in that run.
  function captionTurn(t) {
    var p = S.people[t.id] || { name: t.name, color: t.color }; // current label (re-labeling)
    var allInterim = t.parts.every(function (x) { return x.interim; });
    var line = el('p', { class: 'cap-line' + (allInterim ? ' interim' : '') });
    var who = el('span', { class: 'who', text: p.name });
    who.style.color = p.color || 'var(--1891int-ink)';
    line.appendChild(who);
    t.parts.forEach(function (part) {
      line.appendChild(document.createTextNode(' '));
      var cls = 'said' + (part.interim && !allInterim ? ' said-interim' : '');
      line.appendChild(el('span', { class: cls, text: part.text }));
    });
    return line;
  }

  function renderCaptionsNote() {
    $('#no-captions').hidden = S.captionsConfigured;
  }

  // ===========================================================================
  // Roster
  // ===========================================================================
  function renderRoster() {
    var wrap = $('#roster');
    wrap.innerHTML = '';
    var people = S.members.filter(function (m) { return !m.voice; });
    $('#people-count').textContent = people.length + (people.length === 1 ? ' person' : ' people');
    S.members.forEach(function (m) {
      var unknownVoice = m.voice && !m.named;
      var chip = el('span', { class: 'cap-chip' + (m.speaking ? ' speaking' : '') });
      var dot = el('span', { class: 'cdot' }); dot.style.background = m.color;
      chip.appendChild(dot);
      var nm = (m.id === S.id) ? (m.name + ' (you)') : m.name;
      chip.appendChild(el('span', { class: 'cname', text: nm }));
      if (unknownVoice) {
        var b = el('button', { class: 'name-voice', type: 'button', text: 'name' });
        b.addEventListener('click', function () { nameVoice(m.id, m.name); });
        chip.appendChild(b);
      } else if (m.speaking) {
        chip.appendChild(el('span', { class: 'mic-on', 'aria-label': 'speaking', text: '🎙' }));
      }
      wrap.appendChild(chip);
    });
  }
  // Put a name to an unknown diarized voice — becomes known everywhere, incl. past lines.
  function nameVoice(id, current) {
    var next = (prompt('Name this voice', current && /^Speaker /.test(current) ? '' : current || '') || '').trim();
    if (!next) return;
    try { S.join && S.join.send(JSON.stringify({ type: 'name_voice', id: id, name: next })); } catch (e) {}
  }

  // ===========================================================================
  // Microphone — consent gate -> capture -> stream PCM
  // ===========================================================================
  function updateMicButton() {
    var btn = $('#mic-btn');
    btn.dataset.on = S.mic.on ? '1' : '0';
    btn.setAttribute('aria-pressed', S.mic.on ? 'true' : 'false');
    $('#mic-btn-label').textContent = S.mic.on ? 'Stop the microphone' : 'Use this device as the microphone';
    $('#rec-indicator').hidden = !S.mic.on;
  }

  function onMicClick() {
    if (S.mic.on) { stopMic(); return; }
    if (!S.captionsConfigured) { toast('Live captions are not available right now.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('This device can’t share a microphone in the browser.'); return;
    }
    openConsent();
  }

  function openConsent() { $('#consent').hidden = false; }
  function closeConsent() { $('#consent').hidden = true; }
  function agreeConsent() { closeConsent(); startMic(); }

  function startMic() {
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
    }).then(function (stream) {
      S.mic.stream = stream;
      return setupAudio(stream);
    }).then(function () {
      openMicSocket();
    }).catch(function (err) {
      stopMic();
      toast('Couldn’t start the microphone: ' + (err && err.message ? err.message : err));
    });
  }

  function setupAudio(stream) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx();
    S.mic.ctx = ctx;
    return ctx.audioWorklet.addModule('./audio-worklet.js?v=1').then(function () {
      var src = ctx.createMediaStreamSource(stream);
      var node = new AudioWorkletNode(ctx, 'pcm-downsampler', {
        processorOptions: { targetRate: 16000 }
      });
      S.mic.node = node;
      node.port.onmessage = function (ev) {
        var d = ev.data;
        S.mic.level = d.rms || 0;
        drawLevel();
        MagicBus.emit('level', S.mic.level);
        var ws = S.mic.ws;
        if (ws && ws.readyState === 1 && d.pcm) {
          try { ws.send(d.pcm.buffer); } catch (e) {}
        }
      };
      src.connect(node);
      // Keep the worklet pulling without routing mic audio to the speakers
      // (no echo): connect to a muted gain -> destination.
      var sink = ctx.createGain(); sink.gain.value = 0;
      node.connect(sink); sink.connect(ctx.destination);
      if (ctx.state === 'suspended') return ctx.resume();
    });
  }

  function openMicSocket() {
    var u = API + '/captions/mic/' + encodeURIComponent(S.code) +
      '?id=' + encodeURIComponent(S.id) + '&name=' + encodeURIComponent(S.name);
    var ws;
    try { ws = new WebSocket(u); } catch (e) { stopMic(); return; }
    ws.binaryType = 'arraybuffer';
    S.mic.ws = ws;
    ws.onopen = function () { S.mic.on = true; updateMicButton(); MagicBus.emit('micopen'); };
    ws.onmessage = function (ev) {
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.type === 'mic_status' && msg.status !== 'live') {
        MagicBus.emit('micstatus', msg.status);
        stopMic();
        if (!MAGIC) toast('Live captions are not available right now.');
      }
    };
    ws.onclose = function () { MagicBus.emit('micclose'); if (S.mic.on) stopMic(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function stopMic() {
    S.mic.on = false;
    if (S.mic.ws) { try { S.mic.ws.close(); } catch (e) {} S.mic.ws = null; }
    if (S.mic.node) { try { S.mic.node.disconnect(); } catch (e) {} S.mic.node = null; }
    if (S.mic.stream) {
      S.mic.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      S.mic.stream = null;
    }
    if (S.mic.ctx) { try { S.mic.ctx.close(); } catch (e) {} S.mic.ctx = null; }
    S.mic.level = 0;
    drawLevel();
    updateMicButton();
  }

  function drawLevel() {
    var bar = $('#level');
    if (!bar) return;
    var pct = Math.min(100, Math.round(S.mic.level * 220));
    bar.style.width = pct + '%';
  }

  // ===========================================================================
  // Rename · Export
  // ===========================================================================
  function renameSelf() {
    var next = (prompt('Your name in this session', S.name) || '').trim();
    if (!next || next === S.name) return;
    S.name = next; saveName(next);
    S.people[S.id] = { name: next, color: (S.people[S.id] || {}).color };
    try { S.join && S.join.send(JSON.stringify({ type: 'rename', name: next })); } catch (e) {}
    renderRoster(); renderCaptions();
  }

  // Export the client-side copy of the captions this device received. (The room
  // also serves a finalized transcript at /captions/transcript/<code>, but the
  // local copy is enough for v1 and works with no extra round-trip.)
  function exportTranscript() {
    var lines = (S.committed || []).filter(function (f) { return f.text; }).map(function (f) {
      var nm = (S.people[f.id] && S.people[f.id].name) || f.name || 'Speaker';
      return '[' + new Date(f.ts).toLocaleTimeString() + '] ' + nm + ': ' + f.text;
    });
    if (!lines.length) { toast('No captions to export yet.'); return; }
    var header = 'Live Captions — session ' + S.code + '\n' +
      lines.length + ' lines · exported ' + new Date().toLocaleString() + '\n' +
      '----------------------------------------\n\n';
    var blob = new Blob([header + lines.join('\n') + '\n'], { type: 'text/plain' });
    var a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'live-captions-' + (S.code || 'transcript') + '.txt';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ===========================================================================
  // Wire-up
  // ===========================================================================
  function init() {
    $('#start-form').addEventListener('submit', submitStart);
    $('#new-session').addEventListener('click', startNewSession);
    $('#copy-btn').addEventListener('click', copyInvite);
    $('#rename-btn').addEventListener('click', renameSelf);
    $('#export-btn').addEventListener('click', exportTranscript);
    $('#leave-btn').addEventListener('click', leaveSession);
    $('#mic-btn').addEventListener('click', onMicClick);
    $('#consent-agree').addEventListener('click', agreeConsent);
    $('#consent-cancel').addEventListener('click', closeConsent);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeConsent();
    });
    // Stop the mic if the page is hidden/closed (privacy + frees the device).
    window.addEventListener('pagehide', stopMic);

    // Captioning Magic (opt-in): hand the engine to the press-to-search module.
    // Only in MAGIC mode — otherwise nothing is exposed and the group flow runs
    // exactly as before. The module reads these to start/stop a single search.
    if (MAGIC) {
      window.__capEngine = {
        bus: MagicBus,
        // Begin ONE listening attempt (getUserMedia -> worklet -> mic socket).
        // Reuses the exact same capture path as the group flow.
        start: function () {
          if (!S.captionsConfigured) return false;
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
          if (S.mic.on) return true;
          startMic();
          return true;
        },
        // End the current listening attempt (stop tracks, close socket, free mic).
        stop: function () { stopMic(); },
        isListening: function () { return !!S.mic.on; },
        configured: function () { return !!S.captionsConfigured; },
        level: function () { return S.mic.level || 0; }
      };
      document.documentElement.setAttribute('data-magic', '1');
      // Let the module know the engine is ready (it may have loaded first).
      try { document.dispatchEvent(new Event('capengine:ready')); } catch (e) {}
    }

    // Magic mode is a personal, single-user press-to-search tool — no lobby,
    // no session code to share, no name prompt. Auto-enter a private room so the
    // join socket is live (caption frames flow through it) and the user lands
    // straight on the search orb. The group lobby is skipped entirely.
    if (MAGIC) {
      S.name = savedName() || 'You';
      S.code = normCode(new URLSearchParams(location.search).get('s') || '') || newCode();
      history.replaceState(null, '', location.pathname + location.search);
      enterSession();
      return;
    }

    showStart();
    // If arrived via a shared link (?s=<code>), drop straight into the join flow
    // once a name is present; otherwise the start panel collects the name first.
    var code = normCode(new URLSearchParams(location.search).get('s') || '');
    if (code && savedName()) {
      S.name = savedName();
      S.code = code;
      enterSession();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
