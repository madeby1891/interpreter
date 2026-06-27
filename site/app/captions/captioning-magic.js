// captioning-magic.js — "press to search for captions" (opt-in: ?magic=1)
//
// A Shazam / SoundHound-style flow layered on top of the existing live-captions
// engine (captions.js + workers/captions). The mic does NOT listen continuously.
// The user presses one button to run a single, bounded search; the page shows a
// clear "searching" state, then either LOCKED (captions found and flowing) or
// NO MATCH (with retry + a contextual hint), and STOPS listening every time it
// leaves the searching state.
//
// Why this is a UI/state-machine refactor and not a new backend: the "lock" is
// simply "the live transcription engine returned real speech tokens." We drive
// it entirely off two signals the existing pipeline already produces —
//   • audio level (worklet RMS, via the 'level' bus event), and
//   • caption frames arriving (the 'caption' bus event).
// No audio-fingerprint catalog, no caption-track sync service. The hints map the
// observed signals to plain guidance:
//   • silence / very low level for the whole window  -> "wait for the ride or
//     show to start — there's nothing to caption yet."
//   • sustained audio but zero speech tokens          -> "this sounds like music
//     with no narration — nothing to caption yet; try again when someone speaks."
//   • a transient error / engine not configured       -> generic retry.
//
// This module is INERT unless window.__capEngine exists (i.e. ?magic=1). The
// group/classroom continuous-listen flow never loads any of this behavior.

(function () {
  'use strict';

  // Bail immediately when not in magic mode — keeps the group flow untouched.
  if (!/[?&]magic=1(?:&|$)/.test(location.search)) return;

  // ---- tunables -----------------------------------------------------------
  var SEARCH_MS = 12000;      // hard cap on one search attempt
  var SILENCE_LEVEL = 0.012;  // RMS at/below this counts as "silence"
  var SILENCE_GRACE_MS = 4500;// if no audio at all by here -> "wait for it to start"
  var IDLE_AUTO_STOP_MS = 30000; // safety: never leave the mic live while idle

  // ---- state machine ------------------------------------------------------
  // idle -> searching -> (locked | nomatch) -> idle ...
  var ST = { IDLE: 'idle', SEARCHING: 'searching', LOCKED: 'locked', NOMATCH: 'nomatch' };
  var M = {
    state: ST.IDLE,
    engine: null,
    startedAt: 0,
    sawAnyAudio: false,    // level ever rose above silence
    sawSpeech: false,      // any caption frame with text arrived
    capCount: 0,           // committed caption frames this search
    timers: { cap: null, idle: null },
    els: {}
  };

  function $(s, r) { return (r || document).querySelector(s); }
  function elc(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ---- DOM: build the search panel ---------------------------------------
  // We REPLACE the group mic footer's affordance in magic mode. The session view
  // already exists in index.html; we mount our panel into #magic-mount (added to
  // index.html for magic mode) and hide the group mic button.
  function buildUI() {
    var mount = $('#magic-mount');
    if (!mount) return false;

    var card = elc('div', 'mg-card');

    var orb = elc('button', 'mg-orb');
    orb.type = 'button';
    orb.id = 'mg-orb';
    orb.setAttribute('aria-live', 'off');
    var orbIcon = elc('span', 'mg-orb-icon');
    orbIcon.setAttribute('aria-hidden', 'true');
    orbIcon.textContent = '🔍';
    var orbRing = elc('span', 'mg-orb-ring');
    orbRing.setAttribute('aria-hidden', 'true');
    orb.appendChild(orbRing);
    orb.appendChild(orbIcon);

    var status = elc('p', 'mg-status');
    status.id = 'mg-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'Tap to search for captions';

    var hint = elc('p', 'mg-hint');
    hint.id = 'mg-hint';
    hint.hidden = true;

    var retry = elc('button', 'btn btn-primary btn-lg mg-retry');
    retry.type = 'button';
    retry.id = 'mg-retry';
    retry.textContent = 'Search again';
    retry.hidden = true;

    card.appendChild(orb);
    card.appendChild(status);
    card.appendChild(hint);
    card.appendChild(retry);
    mount.appendChild(card);

    M.els = { orb: orb, status: status, hint: hint, retry: retry, ring: orbRing, icon: orbIcon };

    orb.addEventListener('click', onPrimaryClick);
    retry.addEventListener('click', onPrimaryClick);
    return true;
  }

  function onPrimaryClick() {
    if (M.state === ST.SEARCHING) { cancelSearch('You stopped the search.'); return; }
    startSearch();
  }

  // ---- transitions --------------------------------------------------------
  function setState(next) {
    M.state = next;
    var el = document.documentElement;
    el.setAttribute('data-mg-state', next);
    render();
  }

  function render() {
    var e = M.els;
    if (!e.orb) return;
    switch (M.state) {
      case ST.SEARCHING:
        e.status.textContent = 'Listening for captions…';
        e.hint.hidden = true;
        e.retry.hidden = true;
        e.orb.setAttribute('aria-pressed', 'true');
        e.icon.textContent = '🎧';
        break;
      case ST.LOCKED:
        e.status.textContent = 'Locked on — captions are live below.';
        e.hint.hidden = true;
        e.retry.hidden = false;
        e.retry.textContent = 'Search again';
        e.orb.setAttribute('aria-pressed', 'false');
        e.icon.textContent = '✓';
        break;
      case ST.NOMATCH:
        e.status.textContent = 'No captions found.';
        e.hint.hidden = false;
        e.retry.hidden = false;
        e.retry.textContent = 'Try again';
        e.orb.setAttribute('aria-pressed', 'false');
        e.icon.textContent = '🔍';
        break;
      default: // IDLE
        e.status.textContent = 'Tap to search for captions';
        e.hint.hidden = true;
        e.retry.hidden = true;
        e.orb.setAttribute('aria-pressed', 'false');
        e.icon.textContent = '🔍';
    }
  }

  // ---- search lifecycle ---------------------------------------------------
  function startSearch() {
    if (!M.engine) { hardFail('Captions aren’t available right now.'); return; }
    if (!M.engine.configured()) { hardFail('Captions aren’t available right now.'); return; }

    // reset per-search signal accounting
    M.startedAt = Date.now();
    M.sawAnyAudio = false;
    M.sawSpeech = false;
    M.capCount = 0;

    var ok = M.engine.start();
    if (!ok) { hardFail('This device can’t share a microphone in the browser.'); return; }

    setState(ST.SEARCHING);

    // Hard cap on the attempt.
    clearTimer('cap');
    M.timers.cap = setTimeout(function () { resolveNoMatch(); }, SEARCH_MS);

    // Safety net: never leave the mic live if something wedges.
    armIdleStop();
  }

  // A "lock" = real speech tokens arrived. Confirmed once we have a final frame
  // with text (or enough interim text to be sure it isn't a blip).
  function maybeLock() {
    if (M.state !== ST.SEARCHING) return;
    if (M.capCount >= 1) {
      clearTimer('cap');
      setState(ST.LOCKED);
      // Captions keep flowing into the feed for as long as the user wants. We
      // STOP the mic here: the search is about *finding* a lock; once locked,
      // the engine has confirmed there's narration to caption. (For a continuous
      // live feed the user can simply leave the mic on — but the press-to-search
      // contract is an explicit, bounded action, so we end listening on lock.)
      M.engine.stop();
      disarmIdleStop();
    }
  }

  function resolveNoMatch() {
    if (M.state !== ST.SEARCHING) return;
    M.engine.stop();
    clearTimer('cap');
    disarmIdleStop();
    setState(ST.NOMATCH);
    M.els.hint.textContent = chooseHint();
  }

  // Contextual hint driven entirely by the signals we observed this search.
  function chooseHint() {
    if (!M.sawAnyAudio) {
      return 'It’s quiet right now — wait for the ride or show to start, then ' +
             'search again. There’s nothing to caption until it begins.';
    }
    if (M.sawAnyAudio && !M.sawSpeech) {
      return 'This sounds like music with no narration — there’s nothing to ' +
             'caption yet. Try again once someone starts speaking.';
    }
    // Heard speech-ish audio but the engine never confirmed a caption.
    return 'We heard sound but couldn’t lock onto captions. Move a little closer ' +
           'to the speaker and try again.';
  }

  function cancelSearch(msg) {
    if (M.engine) M.engine.stop();
    clearTimer('cap');
    disarmIdleStop();
    setState(ST.IDLE);
    if (msg) M.els.status.textContent = msg;
  }

  function hardFail(msg) {
    if (M.engine) M.engine.stop();
    clearTimer('cap');
    disarmIdleStop();
    setState(ST.NOMATCH);
    M.els.hint.hidden = false;
    M.els.hint.textContent = msg;
  }

  // ---- engine signal handlers --------------------------------------------
  function onLevel(level) {
    if (M.state !== ST.SEARCHING) return;
    if (level > SILENCE_LEVEL) M.sawAnyAudio = true;
    // Early "it's silent" nudge: if by the grace window we've heard nothing at
    // all, end the attempt early with the wait-for-it-to-start hint rather than
    // making the user wait out the full timeout on a dead-silent room.
    if (!M.sawAnyAudio && (Date.now() - M.startedAt) >= SILENCE_GRACE_MS) {
      resolveNoMatch();
    }
  }

  function onCaption(f) {
    if (M.state !== ST.SEARCHING) return;
    if (f && f.text && f.text.trim()) {
      M.sawSpeech = true;
      if (f.is_final) { M.capCount++; maybeLock(); }
    }
  }

  function onMicStatus(status) {
    // Engine told us captions aren't live (e.g. vendor key missing server-side).
    if (M.state === ST.SEARCHING) hardFail('Captions aren’t available right now.');
  }

  function onMicClose() {
    // The socket closed mid-search without a lock -> treat as no match.
    if (M.state === ST.SEARCHING) resolveNoMatch();
  }

  // ---- timers / lifecycle safety -----------------------------------------
  function clearTimer(k) { if (M.timers[k]) { clearTimeout(M.timers[k]); M.timers[k] = null; } }
  function armIdleStop() {
    disarmIdleStop();
    M.timers.idle = setTimeout(function () {
      // Belt-and-suspenders: should never fire before the search cap, but if the
      // mic is somehow still live while not searching, kill it.
      if (M.engine && M.engine.isListening() && M.state !== ST.SEARCHING) {
        M.engine.stop();
      }
    }, IDLE_AUTO_STOP_MS);
  }
  function disarmIdleStop() { if (M.timers.idle) { clearTimeout(M.timers.idle); M.timers.idle = null; } }

  // Stop searching the moment the page is hidden (battery, privacy, mic release).
  function onVisibility() {
    if (document.visibilityState === 'hidden' && M.state === ST.SEARCHING) {
      cancelSearch();
    }
  }

  // ---- attach to engine ---------------------------------------------------
  function attach() {
    var eng = window.__capEngine;
    if (!eng) return false;
    M.engine = eng;
    eng.bus.on('level', onLevel);
    eng.bus.on('caption', onCaption);
    eng.bus.on('micstatus', onMicStatus);
    eng.bus.on('micclose', onMicClose);
    return true;
  }

  function init() {
    if (!buildUI()) return; // no mount point -> not the magic surface
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', function () { if (M.engine) M.engine.stop(); });
    // The engine may attach before or after us.
    if (!attach()) {
      document.addEventListener('capengine:ready', function once() {
        document.removeEventListener('capengine:ready', once);
        attach();
      });
    }
    setState(ST.IDLE);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
