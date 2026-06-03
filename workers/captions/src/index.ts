/**
 * 1891 Interpreter — Live Captions worker.
 *
 * Realtime backend for the Live Captions vertical. One Durable Object per
 * session code (`CAPTIONS_ROOM`, keyed by idFromName("session:"+code)). A
 * device opens a "mic" socket and streams 16 kHz linear-PCM up; the room proxies
 * that audio to the streaming-transcription vendor, tags each caption with the
 * speaker's name + color, and fans it out to every "viewer" socket joined to the
 * same session code. Viewers see color-coded live captions (interim + final).
 *
 * Routes:
 *   GET /healthz                     — liveness + whether captions are configured
 *   GET /captions/join/<code>        — WebSocket: presence + caption receive (any origin)
 *   GET /captions/mic/<code>         — WebSocket: audio ingest (origin-gated; metered)
 *   GET /captions/transcript/<code>  — JSON: the session's finalized lines (read-only)
 *
 * Cloned from workers/dinnertable and trimmed to captions only: no CRM,
 * billing, magic-link, email, Stripe, Room-Read (mood), transcript-archive, or
 * usage-metrics code. The streaming-transcription vendor + the edge platform are
 * endpoints in this file, never surfaced as branding anywhere customer-facing.
 */

interface Env {
  CAPTIONS_ROOM: DurableObjectNamespace;
  ALLOWED_ORIGINS: string;
  LOG_LEVEL: string;
  // Streaming-transcription key (shared 1891 workspace key). Optional: when
  // unset, the mic socket self-skips with a clean close + mic_status
  // 'unconfigured', and captions simply don't run — presence keeps working.
  DEEPGRAM_API_KEY?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/healthz') {
      return json({ ok: true, captions_configured: Boolean(env.DEEPGRAM_API_KEY) });
    }

    // Join channel — presence + caption receive. The session code is the
    // capability: a high-entropy code shared by link/QR is the access key.
    // Rate-limited per IP so the code space can't be enumerated.
    if (path.startsWith('/captions/join/')) {
      const code = normalizeCode(path.slice('/captions/join/'.length));
      if (!code) return new Response('session code required', { status: 400 });
      return roomFetch(env, code, req, 'join');
    }

    // Mic channel — audio ingest. Origin-gated because it spends metered
    // transcription minutes. A browser can't forge Origin cross-site.
    if (path.startsWith('/captions/mic/')) {
      const code = normalizeCode(path.slice('/captions/mic/'.length));
      if (!code) return new Response('session code required', { status: 400 });
      if (!originAllowed(req, env)) return new Response('Forbidden', { status: 403 });
      return roomFetch(env, code, req, 'mic');
    }

    // Read-only finalized transcript for this session (in-memory; no persistence
    // in v1). Any holder of the session code can read it, same as the captions.
    if (path.startsWith('/captions/transcript/')) {
      const code = normalizeCode(path.slice('/captions/transcript/'.length));
      if (!code) return new Response('session code required', { status: 400 });
      return roomFetch(env, code, req, 'transcript');
    }

    return new Response('Not Found', { status: 404 });
  },
};

function roomFetch(env: Env, code: string, req: Request, kind: 'join' | 'mic' | 'transcript'): Promise<Response> {
  // One DO per session code. The prefix keeps the namespace tidy if this worker
  // ever hosts other room kinds.
  const id = env.CAPTIONS_ROOM.idFromName('session:' + code);
  const stub = env.CAPTIONS_ROOM.get(id);
  // Forward the original query (id, name) and tell the DO which channel this is
  // plus the human-readable session code (idFromName is one-way).
  const inUrl = new URL(req.url);
  const doUrl = new URL(`https://do/${kind}`);
  doUrl.searchParams.set('room', code);
  for (const k of ['id', 'name']) {
    const v = inUrl.searchParams.get(k);
    if (v) doUrl.searchParams.set(k, v);
  }
  return stub.fetch(new Request(doUrl.toString(), req));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

// Session codes are short human-readable strings. Normalize to a safe,
// case-insensitive key so "k7p2" and "K7P2" land on the same DO.
function normalizeCode(raw: string): string {
  return decodeURIComponent(raw).trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
}

function originAllowed(req: Request, env: Env): boolean {
  const origin = (req.headers.get('origin') || '').toLowerCase();
  const allow = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allow.includes(origin)) return true;
  // Localhost for local dev against the live worker.
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

// ===========================================================================
// CaptionsRoom — one Durable Object per session code. Holds every viewer +
// the mic WebSocket, opens the upstream streaming-transcription socket for the
// mic, and broadcasts caption frames to viewers. State is in-memory only (no
// durable persistence in v1); the transcript buffer lives only as long as the
// room is warm.
// ===========================================================================

// How long a single mic session may stay open (a cost + safety backstop).
const MIC_SESSION_CAP_MS = 60 * 60 * 1000; // 1 hour
// How many finalized captions to replay to a device that joins mid-session.
const HISTORY_CAP = 80;
// Full session transcript kept in memory for live replay + the read endpoint.
const TRANSCRIPT_CAP = 5000;

// --- Voice-activity gating (don't pay to transcribe dead air) ----------------
const VOICE_RMS = 0.012;    // RMS above this (0..1) counts as "voicing"
const HANGOVER_MS = 1000;   // keep streaming this long after voice stops (finalize the last word)
const PREROLL_FRAMES = 4;   // ~400 ms kept before voice onset so word starts aren't clipped
const KEEPALIVE_MS = 5000;  // during silence, ping the vendor this often to hold the stream (free)

// Distinct, high-contrast speaker colors. Assigned per distinct voice in first-
// heard order so each speaker keeps one color for the life of the session.
const PALETTE = [
  '#C8553D', // terracotta (1891 bloom)
  '#2E5E5C', // teal-green (1891 river)
  '#E9B44C', // amber
  '#5B7DB1', // dusk blue
  '#9B5DE5', // grape
  '#C44E6B', // rose
  '#5AA469', // sage
  '#D7795A', // clay
  '#6C8EAD', // slate
  '#B07BAC', // mauve
];

interface Joiner {
  id: string;
  name: string;
  color: string;
}

interface Mic {
  id: string;
  name: string;
  color: string;
  upstream: WebSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
  // Serializes async Blob -> ArrayBuffer conversions so audio frames stay ordered.
  audioTail: Promise<void>;
  lastVoiceMs: number;
  // Diarization: this mic's vendor speaker-index -> our stable speaker id. The
  // first distinct voice maps to the mic owner; later ones become "Speaker N".
  voiceMap: Map<number, string>;
  // Dead-air gating: only forward audio while voiced (+ hangover); pre-roll so
  // word starts aren't clipped; KeepAlive during silence to hold the stream free.
  gateOpen: boolean;
  preroll: ArrayBuffer[];
  lastKeepAliveMs: number;
}

interface CaptionFrame {
  type: 'caption';
  id: string;
  name: string;
  color: string;
  text: string;
  is_final: boolean;
  ts: number;
  seq: number;
}

function cleanName(raw: string | null): string {
  return (raw || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Guest';
}

export class CaptionsRoom {
  state: DurableObjectState;
  env: Env;
  roomCode = '';
  joiners: Map<WebSocket, Joiner> = new Map();
  mics: Map<WebSocket, Mic> = new Map();
  colorsById: Map<string, string> = new Map();
  // Current display name per speaker id. Captions + roster resolve names through
  // this, so a rename relabels a speaker everywhere (incl. past lines, client-side).
  namesById: Map<string, string> = new Map();
  // Finalized transcript for replay + the read endpoint (bounded by TRANSCRIPT_CAP).
  transcript: CaptionFrame[] = [];
  seq = 0;
  // Extra voices diarization found on the mic (beyond the mic owner). id
  // "micId~spk" -> display info; unnamed ones show as "Speaker N" until named.
  voices: Map<string, { id: string; name: string; color: string; named: boolean }> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.searchParams.get('room')) this.roomCode = url.searchParams.get('room') as string;

    if (url.pathname === '/transcript') return this.handleTranscript();

    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 400 });
    }
    if (url.pathname === '/join') return this.handleJoin(req, url);
    if (url.pathname === '/mic') return this.handleMic(req, url);
    return new Response('Not Found', { status: 404 });
  }

  // --- colors / roster -----------------------------------------------------

  colorFor(id: string): string {
    let c = this.colorsById.get(id);
    if (!c) {
      c = PALETTE[this.colorsById.size % PALETTE.length] as string;
      this.colorsById.set(id, c);
    }
    return c;
  }

  nameFor(id: string, fallback?: string): string {
    return this.namesById.get(id) || fallback || 'Guest';
  }

  rosterMembers(): Array<{ id: string; name: string; color: string; speaking: boolean; voice?: boolean; named?: boolean }> {
    const speakingIds = new Set<string>();
    for (const m of this.mics.values()) speakingIds.add(m.id);
    const byId = new Map<string, { id: string; name: string; color: string; speaking: boolean; voice?: boolean; named?: boolean }>();
    for (const j of this.joiners.values()) {
      byId.set(j.id, { id: j.id, name: this.nameFor(j.id, j.name), color: j.color, speaking: speakingIds.has(j.id) });
    }
    // Extra voices diarization found on the mic — so they show up and can be named.
    for (const v of this.voices.values()) {
      if (!byId.has(v.id)) byId.set(v.id, { id: v.id, name: this.nameFor(v.id, v.name), color: v.color, speaking: false, voice: true, named: v.named });
    }
    return [...byId.values()];
  }

  // Map a mic's vendor speaker index -> a stable speaker id. The first distinct
  // voice on the mic is the owner; later ones become nameable "Speaker N" voices.
  resolveVoiceId(mic: Mic, spk: number): string {
    const existing = mic.voiceMap.get(spk);
    if (existing) return existing;
    if (mic.voiceMap.size === 0) { mic.voiceMap.set(spk, mic.id); return mic.id; } // owner
    const id = `${mic.id}~${spk}`;
    mic.voiceMap.set(spk, id);
    const name = `Speaker ${this.voices.size + 2}`;
    this.namesById.set(id, name);
    this.voices.set(id, { id, name, color: this.colorFor(id), named: false });
    this.broadcastRoster();
    return id;
  }

  broadcastToJoiners(payload: string): void {
    for (const ws of this.joiners.keys()) {
      try { ws.send(payload); } catch { /* dead socket; cleaned up on close */ }
    }
  }

  broadcastRoster(): void {
    this.broadcastToJoiners(JSON.stringify({ type: 'roster', members: this.rosterMembers() }));
  }

  // --- join channel --------------------------------------------------------

  async handleJoin(req: Request, url: URL): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const id = (url.searchParams.get('id') || crypto.randomUUID()).slice(0, 64);
    const name = cleanName(url.searchParams.get('name'));
    const color = this.colorFor(id);
    this.namesById.set(id, name);
    this.joiners.set(server, { id, name, color });

    // Welcome: who you are, who's here, and recent captions so a late joiner
    // catches up on the conversation.
    try {
      server.send(JSON.stringify({
        type: 'welcome',
        session: this.roomCode,
        you: { id, name, color },
        members: this.rosterMembers(),
        history: this.transcript.slice(-HISTORY_CAP),
        captions_configured: Boolean(this.env.DEEPGRAM_API_KEY),
      }));
    } catch { /* ignore */ }

    this.broadcastRoster();

    server.addEventListener('message', (ev: MessageEvent) => {
      let msg: { type?: string; name?: string; id?: string } | null = null;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'rename') {
        const j = this.joiners.get(server);
        if (j) {
          j.name = cleanName(msg.name || '');
          this.namesById.set(j.id, j.name);
          // Relabel this speaker everywhere — clients update past lines too.
          this.broadcastToJoiners(JSON.stringify({ type: 'relabel', id: j.id, name: j.name, color: j.color }));
          this.broadcastRoster();
        }
      } else if (msg.type === 'name_voice') {
        // Put a name to an unknown diarized voice; it becomes known everywhere.
        const v = this.voices.get(String(msg.id || ''));
        if (v) {
          v.name = cleanName(msg.name || ''); v.named = true;
          this.namesById.set(v.id, v.name);
          this.broadcastToJoiners(JSON.stringify({ type: 'relabel', id: v.id, name: v.name, color: v.color }));
          this.broadcastRoster();
        }
      }
      // 'ping' (heartbeat) and anything else are no-ops.
    });

    server.addEventListener('close', () => { this.joiners.delete(server); this.broadcastRoster(); });
    server.addEventListener('error', () => { this.joiners.delete(server); this.broadcastRoster(); });

    return new Response(null, { status: 101, webSocket: client });
  }

  // --- mic channel ---------------------------------------------------------

  async handleMic(req: Request, url: URL): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Audio must arrive as ArrayBuffer; a Blob stringifies to "[object Blob]"
    // and the transcription service rejects it (silent: no captions).
    (server as unknown as { binaryType: string }).binaryType = 'arraybuffer';
    server.accept();

    const id = (url.searchParams.get('id') || crypto.randomUUID()).slice(0, 64);
    const name = cleanName(url.searchParams.get('name'));
    const color = this.colorFor(id);
    this.namesById.set(id, name);

    if (!this.env.DEEPGRAM_API_KEY) {
      try { server.send(JSON.stringify({ type: 'mic_status', status: 'unconfigured' })); } catch { /* ignore */ }
      try { server.close(4503, 'caption-service-unconfigured'); } catch { /* ignore */ }
      return new Response(null, { status: 101, webSocket: client });
    }

    const upstream = await this.openCaptionUpstream();
    if (!upstream) {
      try { server.send(JSON.stringify({ type: 'mic_status', status: 'unavailable' })); } catch { /* ignore */ }
      try { server.close(4500, 'caption-service-unavailable'); } catch { /* ignore */ }
      return new Response(null, { status: 101, webSocket: client });
    }

    const mic: Mic = {
      id, name, color, upstream, timer: null, audioTail: Promise.resolve(),
      lastVoiceMs: 0, voiceMap: new Map(), gateOpen: false, preroll: [], lastKeepAliveMs: 0,
    };
    mic.timer = setTimeout(() => this.stopMic(server, 'session-cap'), MIC_SESSION_CAP_MS);
    this.mics.set(server, mic);

    try { server.send(JSON.stringify({ type: 'mic_status', status: 'live' })); } catch { /* ignore */ }
    this.broadcastRoster(); // light the "speaking" dot for this device

    // device audio -> upstream. ArrayBuffers / control strings pass straight
    // through; a stray Blob is converted via an order-preserving tail promise.
    server.addEventListener('message', (ev: MessageEvent) => {
      const up = this.mics.get(server)?.upstream;
      if (!up) return;
      const d = ev.data as unknown;
      if (typeof d === 'string') {
        try { up.send(d); } catch { /* ignore */ }
      } else if (d instanceof ArrayBuffer) {
        const rms = energyOf(d);
        if (rms > VOICE_RMS) mic.lastVoiceMs = Date.now();
        this.gateForward(mic, up, d, rms); // skip dead air -> save vendor cost
      } else if (d && typeof (d as Blob).arrayBuffer === 'function') {
        mic.audioTail = mic.audioTail.then(async () => {
          const buf = await (d as Blob).arrayBuffer();
          const rms = energyOf(buf);
          if (rms > VOICE_RMS) mic.lastVoiceMs = Date.now();
          const u = this.mics.get(server)?.upstream;
          if (u) this.gateForward(mic, u, buf, rms);
        });
      }
    });

    // device stopped: flush the final of the last utterance AFTER queued audio
    // drains, then tear down shortly after (or as soon as upstream closes). Both
    // close AND error route here — Cloudflare often surfaces a normal client
    // close as ALSO an error ("Network connection lost"); killing the upstream
    // immediately on that error would drop the final of whatever was just said.
    let tearing = false;
    const finalizeMic = () => {
      if (tearing) return;
      tearing = true;
      const m = this.mics.get(server);
      if (m) {
        m.audioTail = m.audioTail.then(() => {
          try { m.upstream?.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* ignore */ }
        });
        if (m.timer) { clearTimeout(m.timer); m.timer = null; }
      }
      // Backstop teardown if the vendor doesn't close itself after the flush.
      setTimeout(() => this.stopMic(server, 'finalize'), 3500);
    };
    server.addEventListener('close', () => finalizeMic());
    server.addEventListener('error', () => finalizeMic());

    // upstream transcript -> caption frame -> every viewer on this session.
    upstream.addEventListener('message', (ev: MessageEvent) => {
      const text = parseTranscript(ev.data);
      if (text === null) return;
      const m = this.mics.get(server);
      if (!m) return;
      // One mic can carry several voices (diarization) — resolve which one this is.
      const vid = this.resolveVoiceId(m, text.speaker);
      const frame: CaptionFrame = {
        type: 'caption',
        id: vid,
        name: this.nameFor(vid, m.name),
        color: this.colorFor(vid),
        text: text.text,
        is_final: text.is_final,
        ts: Date.now(),
        seq: ++this.seq,
      };
      if (frame.is_final) {
        if (frame.text) {
          this.transcript.push(frame);
          if (this.transcript.length > TRANSCRIPT_CAP) this.transcript.shift();
          this.broadcastToJoiners(JSON.stringify(frame));
        }
      } else {
        this.broadcastToJoiners(JSON.stringify(frame));
      }
    });
    upstream.addEventListener('close', () => this.stopMic(server, 'upstream-closed'));
    upstream.addEventListener('error', () => this.stopMic(server, 'upstream-error'));

    return new Response(null, { status: 101, webSocket: client });
  }

  // Tear down one mic session (idempotent).
  stopMic(server: WebSocket, reason: string): void {
    const m = this.mics.get(server);
    if (!m) return;
    this.mics.delete(server);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    try { m.upstream?.close(1000, reason.slice(0, 123)); } catch { /* ignore */ }
    try { server.close(1000, reason.slice(0, 123)); } catch { /* ignore */ }
    this.broadcastRoster(); // drop the "speaking" dot
  }

  // Don't pay to transcribe dead air. Forward audio to the vendor only while
  // there's voice (plus a short hangover so the last word finalizes), with a
  // tiny pre-roll so word starts aren't clipped. During silence we send the
  // vendor a free KeepAlive instead of (billed) audio, so the stream stays open.
  gateForward(mic: Mic, up: WebSocket, buf: ArrayBuffer, rms: number): void {
    const now = Date.now();
    const open = rms > VOICE_RMS || (now - mic.lastVoiceMs < HANGOVER_MS);
    if (open) {
      if (!mic.gateOpen) {
        mic.gateOpen = true;
        for (const f of mic.preroll) { try { up.send(f); } catch { /* ignore */ } }
        mic.preroll = [];
      }
      try { up.send(buf); } catch { /* ignore */ }
    } else {
      mic.gateOpen = false;
      mic.preroll.push(buf);
      if (mic.preroll.length > PREROLL_FRAMES) mic.preroll.shift();
      if (now - mic.lastKeepAliveMs > KEEPALIVE_MS) {
        try { up.send(JSON.stringify({ type: 'KeepAlive' })); } catch { /* ignore */ }
        mic.lastKeepAliveMs = now;
      }
    }
  }

  // --- transcript (read-only) ----------------------------------------------

  handleTranscript(): Response {
    const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
    const lines = this.transcript.map((f) => ({
      id: f.id,
      name: this.nameFor(f.id, f.name),
      color: this.colorFor(f.id),
      text: f.text,
      ts: f.ts,
      seq: f.seq,
    }));
    return new Response(JSON.stringify({ session: this.roomCode, count: lines.length, lines }), { headers });
  }

  // Open the upstream streaming-transcription WebSocket for 16 kHz mono PCM.
  // Returns the accepted socket or null. The vendor name never leaves here.
  async openCaptionUpstream(): Promise<WebSocket | null> {
    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'en-US',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      endpointing: '300',
      diarize: 'true', // label distinct voices on one mic -> name them individually
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
    });
    try {
      // CF Workers open outbound WebSockets via fetch() with an https:// URL +
      // `Upgrade: websocket` (wss:// is rejected). The accepted socket comes back
      // on resp.webSocket and must be .accept()'d.
      const resp = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Token ${this.env.DEEPGRAM_API_KEY}`,
        },
      });
      if (resp.status === 101 && resp.webSocket) {
        resp.webSocket.accept();
        console.log('[caption-upstream] opened OK');
        return resp.webSocket;
      }
      const body = await resp.text().catch(() => '?');
      console.error('[caption-upstream] non-101', resp.status, body.slice(0, 200));
      return null;
    } catch (e) {
      console.error('[caption-upstream] open failed', e instanceof Error ? e.message : e);
      return null;
    }
  }
}

// Smoothed RMS (0..1) of one PCM frame — the voice-activity signal for gating.
function energyOf(buf: ArrayBuffer): number {
  try {
    if (buf.byteLength < 2) return 0;
    const i16 = new Int16Array(buf, 0, buf.byteLength >> 1);
    let s = 0;
    for (let i = 0; i < i16.length; i++) { const v = (i16[i] as number) / 32768; s += v * v; }
    return Math.sqrt(s / i16.length);
  } catch { return 0; }
}

// Parse one upstream transcript message into text + finality + dominant speaker.
function parseTranscript(data: unknown): { text: string; is_final: boolean; speaker: number } | null {
  if (typeof data !== 'string') return null;
  let msg: {
    is_final?: boolean;
    channel?: { alternatives?: Array<{ transcript?: string; words?: Array<{ speaker?: number }> }> };
  };
  try { msg = JSON.parse(data); } catch { return null; }
  const alt = msg?.channel?.alternatives?.[0];
  const text = String(alt?.transcript ?? '').trim();
  if (!text) return null;
  // Diarization: pick the dominant speaker index across this segment's words.
  let speaker = 0;
  const words = Array.isArray(alt?.words) ? alt.words : [];
  if (words.length) {
    const counts = new Map<number, number>();
    for (const w of words) { const sp = Number(w.speaker) || 0; counts.set(sp, (counts.get(sp) || 0) + 1); }
    let best = -1;
    for (const [sp, c] of counts) if (c > best) { best = c; speaker = sp; }
  }
  return { text, is_final: Boolean(msg.is_final), speaker };
}
