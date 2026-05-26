// SMS dispatcher — Twilio outbound + inbound webhook.
//
// Pattern B per shared/specs/SMS.md — direct adapter inside this Worker
// (interpreter is a single self-contained Worker, no multi-channel fan-out
// hub yet, so Pattern A is overkill).
//
// Outbound (Apps Script → Worker) is internal-only (X-1891-Internal header
// equals JWT_SECRET).
//
// Inbound (Twilio → Worker) is verified against Twilio's HMAC-SHA1 signature
// over (fullUrl + sortedFormParams). On success we parse the body, normalise
// the text, dispatch to Apps Script as `sms_inbound` (signed with a 60s
// worker JWT, purpose='twilio_inbound') and echo a TwiML confirmation back to
// the user. The Worker is idempotent on Twilio's MessageSid (cached in
// memory for the lifetime of the isolate; Apps Script also dedupes on the
// Communications row), and rate-limits any single phone to 10 inbound/min.
//
// Config required to actually send (set via `wrangler secret put`):
//   TWILIO_ACCOUNT_SID            account SID (shared 1891 account)
//   TWILIO_API_KEY_SID            preferred — individually revocable
//   TWILIO_API_KEY_SECRET         paired secret for the API key
//   TWILIO_AUTH_TOKEN             legacy fallback if API key absent
//   TWILIO_MESSAGING_SERVICE_SID  default: MGc34cd9467b4a9e6b0cce3d043d093eb4
//                                 ('1891 SMS Gateway' — shared per SMS.md §2)
//
// `TWILIO_FROM_NUMBER` is accepted as a legacy fallback if no MS is set, but
// MessagingServiceSid is preferred — it carries A2P 10DLC registration and
// STOP/HELP routing at the Twilio layer (SMS.md §4.2).
//
// Without the required secrets, /v1/sms/send returns { ok:false, configured:false }
// so the Apps Script side can degrade gracefully (the platform plan gate).

import type { Env } from './index';
import { callAppsScript } from './internal';

function jsonResponse(_req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

interface SendBody {
  tenant_id: string;
  to: string;        // E.164 like +13015551234
  body: string;      // SMS message text, ≤ 160 chars per SMS segment
  job_id?: string;
}

export async function handleSmsSend(request: Request, env: Env): Promise<Response> {
  // Internal auth: the X-1891-Internal header must equal JWT_SECRET
  const auth = request.headers.get('X-1891-Internal');
  if (!auth || auth !== env.JWT_SECRET) {
    return jsonResponse(request, { ok: false, error: 'Forbidden' }, 403);
  }

  let body: SendBody;
  try { body = await request.json() as SendBody; }
  catch { return jsonResponse(request, { ok: false, error: 'Invalid JSON' }, 400); }
  if (!body.to || !body.body) {
    return jsonResponse(request, { ok: false, error: 'to + body required' }, 400);
  }
  if (!/^\+[1-9]\d{6,14}$/.test(body.to)) {
    return jsonResponse(request, { ok: false, error: 'to must be E.164 (+countrycodeNUMBER)' }, 400);
  }

  // Config check. Prefer API key + Messaging Service (SMS.md §2).
  // Fall back to legacy Auth Token + From number so this Worker keeps
  // working through the rotation window.
  const sid = env.TWILIO_ACCOUNT_SID;
  const apiKeySid = env.TWILIO_API_KEY_SID;
  const apiKeySecret = env.TWILIO_API_KEY_SECRET;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID;
  const fromNumber = env.TWILIO_FROM_NUMBER;
  const credsOk = sid && ((apiKeySid && apiKeySecret) || authToken);
  const sourceOk = messagingServiceSid || fromNumber;
  if (!credsOk || !sourceOk) {
    return jsonResponse(request, {
      ok: false,
      configured: false,
      error: 'SMS not configured. Set TWILIO_ACCOUNT_SID + (TWILIO_API_KEY_SID/SECRET preferred, or TWILIO_AUTH_TOKEN) + TWILIO_MESSAGING_SERVICE_SID (or legacy TWILIO_FROM_NUMBER) via wrangler secret put.'
    }, 503);
  }

  // Twilio REST API call. MessagingServiceSid lets Twilio pick the right
  // sender pool + carries A2P 10DLC + auto-STOP/HELP routing.
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const params: Record<string, string> = { To: body.to, Body: body.body };
  if (messagingServiceSid) params.MessagingServiceSid = messagingServiceSid;
  else params.From = fromNumber!;
  const formBody = new URLSearchParams(params);
  const userId = apiKeySid || sid;
  const userPwd = apiKeySecret || authToken!;
  const basic = btoa(`${userId}:${userPwd}`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formBody.toString()
    });
    const respText = await res.text();
    if (!res.ok) {
      return jsonResponse(request, {
        ok: false,
        configured: true,
        status_code: res.status,
        twilio_error: respText.slice(0, 400)
      }, res.status);
    }
    let resp: any = null;
    try { resp = JSON.parse(respText); } catch { resp = { raw: respText.slice(0, 400) }; }
    return jsonResponse(request, {
      ok: true,
      configured: true,
      twilio_sid: resp?.sid,
      twilio_status: resp?.status,
      to: body.to
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse(request, { ok: false, configured: true, error: msg }, 502);
  }
}

// ---------------------------------------------------------------------------
// Inbound webhook (Twilio → Worker)
// ---------------------------------------------------------------------------

// Twilio retries on 5xx, so we have to be idempotent on MessageSid. We cache
// the previously-computed TwiML response in this isolate-local map; the
// Communications row in the Sheet is the durable copy.
const INBOUND_CACHE: Map<string, { reply: string; at: number }> = new Map();
const INBOUND_CACHE_MAX = 500;
const INBOUND_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Per-phone rate limiter — 10 inbound / minute. Sliding window of timestamps.
const RATE_BUCKETS: Map<string, number[]> = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 10;

function checkRate(phone: string, nowMs: number): boolean {
  const bucket = RATE_BUCKETS.get(phone) || [];
  const fresh = bucket.filter((t) => nowMs - t < RATE_WINDOW_MS);
  fresh.push(nowMs);
  RATE_BUCKETS.set(phone, fresh);
  // Opportunistic cleanup so the map doesn't grow forever on a hot isolate.
  if (RATE_BUCKETS.size > 1000) {
    for (const [k, v] of RATE_BUCKETS.entries()) {
      const stillFresh = v.filter((t) => nowMs - t < RATE_WINDOW_MS);
      if (!stillFresh.length) RATE_BUCKETS.delete(k);
      else RATE_BUCKETS.set(k, stillFresh);
    }
  }
  return fresh.length <= RATE_MAX;
}

function rememberReply(sid: string, reply: string): void {
  if (!sid) return;
  INBOUND_CACHE.set(sid, { reply, at: Date.now() });
  // Crude LRU: prune anything past TTL once we cross the max.
  if (INBOUND_CACHE.size > INBOUND_CACHE_MAX) {
    const cutoff = Date.now() - INBOUND_CACHE_TTL_MS;
    for (const [k, v] of INBOUND_CACHE.entries()) {
      if (v.at < cutoff) INBOUND_CACHE.delete(k);
    }
  }
}

function previousReply(sid: string): string | null {
  if (!sid) return null;
  const hit = INBOUND_CACHE.get(sid);
  if (!hit) return null;
  if (Date.now() - hit.at > INBOUND_CACHE_TTL_MS) {
    INBOUND_CACHE.delete(sid);
    return null;
  }
  return hit.reply;
}

/**
 * Base64-encode a Uint8Array (Workers don't have Buffer).
 */
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/**
 * Twilio request signature.
 *
 *   signature = base64(HMAC-SHA1(authToken, fullUrl + sortedConcatOfFormParams))
 *
 * where sortedConcatOfFormParams = key1 + value1 + key2 + value2 ... in
 * alphabetical order of the keys. The URL must be the EXACT one Twilio used
 * to POST (we reconstruct from the request — same scheme, host, path, query).
 *
 * Spec: https://www.twilio.com/docs/usage/security#validating-requests
 */
export async function verifyTwilioSignature(
  fullUrl: string,
  params: Record<string, string>,
  signature: string,
  authToken: string
): Promise<boolean> {
  if (!signature || !authToken) return false;
  const keys = Object.keys(params).sort();
  let body = fullUrl;
  for (const k of keys) body += k + params[k];

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const macBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected = bytesToB64(new Uint8Array(macBuf));

  // Constant-time compare on equal-length strings; bail early otherwise.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

type ParsedAction = 'accept' | 'decline' | 'optout' | 'help' | 'unknown';

/**
 * Map an inbound SMS body to a structured action. Mirrors STOP / HELP keywords
 * Twilio compliance expects, plus our domain-specific YES/NO/CLAIM/PASS set.
 *
 * Returns the lowercase-canonical normalised body too — Apps Script gets the
 * normalised string for its audit row.
 */
export function parseInboundBody(raw: string): { action: ParsedAction; normalised: string } {
  const normalised = (raw || '').trim().toUpperCase().replace(/\s+/g, ' ');
  switch (normalised) {
    case 'YES':
    case 'Y':
    case 'ACCEPT':
    case 'CLAIM':
    case 'OK':
    case 'OKAY':
      return { action: 'accept', normalised };
    case 'NO':
    case 'N':
    case 'DECLINE':
    case 'PASS':
    case 'SKIP':
      return { action: 'decline', normalised };
    case 'STOP':
    case 'STOPALL':
    case 'UNSUBSCRIBE':
    case 'CANCEL':
    case 'END':
    case 'QUIT':
      return { action: 'optout', normalised };
    case 'HELP':
    case 'INFO':
      return { action: 'help', normalised };
    default:
      return { action: 'unknown', normalised };
  }
}

function twiml(message: string): Response {
  // Escape the five XML special chars — Twilio's TwiML parser is strict.
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>${escaped}</Message></Response>`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' }
  });
}

function emptyTwiml(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' }
  });
}

function buildReplyText(action: ParsedAction, asResult: Record<string, unknown> | null): string {
  // Fallback canned copy used when Apps Script is unreachable or returns an
  // unrecognised shape. The Apps Script handler is the source of truth and
  // returns a `reply_text` field when it wants something specific.
  if (asResult && typeof asResult.reply_text === 'string' && asResult.reply_text) {
    return String(asResult.reply_text);
  }
  if (asResult && asResult.ok === false) {
    const err = String(asResult.error || 'unknown_error');
    if (err === 'no_user') {
      return "We don't recognize this number. Sign in via the portal to manage your offers.";
    }
    if (err === 'no_pending_offers') {
      return 'No pending offers right now. Open the portal for your upcoming jobs.';
    }
    return 'Something went wrong on our end. Please use the portal.';
  }
  switch (action) {
    case 'accept':  return 'Got it — confirmed. Details in the portal.';
    case 'decline': return 'Got it — declined. Thanks for the quick reply.';
    case 'optout':  return "You're unsubscribed from 1891 SMS. Reply START to opt back in.";
    case 'help':    return 'Reply YES to claim the latest offer, NO to decline, STOP to unsubscribe.';
    default:        return "Sorry, we didn't recognize that. Reply YES, NO, or open the portal.";
  }
}

export async function handleSmsInbound(request: Request, env: Env): Promise<Response> {
  // 1) Read the raw form body once — we need it for signature verification AND
  //    to extract the message fields.
  let rawText = '';
  try {
    rawText = await request.text();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(rawText).entries()) {
    params[k] = v;
  }

  // 2) Signature verification — HARD requirement when AUTH_TOKEN is present.
  //    If TWILIO_AUTH_TOKEN isn't configured we refuse outright; we never want
  //    to accept unsigned inbound webhooks in production.
  const sig = request.headers.get('X-Twilio-Signature') || '';
  if (!env.TWILIO_AUTH_TOKEN) {
    console.warn('sms_inbound: TWILIO_AUTH_TOKEN not configured; refusing');
    return new Response('Forbidden', { status: 403 });
  }
  // Twilio signs the original public URL (scheme + host + path + query). The
  // Worker sees the request as Twilio sent it, so request.url is exactly what
  // Twilio used. (If you front this Worker with another proxy that rewrites
  // the host, you must reconstruct the URL Twilio knows about.)
  const fullUrl = request.url;
  const ok = await verifyTwilioSignature(fullUrl, params, sig, env.TWILIO_AUTH_TOKEN);
  if (!ok) {
    console.warn('sms_inbound: signature mismatch from=', params.From);
    return new Response('Forbidden', { status: 403 });
  }

  const from = (params.From || '').trim();
  const body = params.Body || '';
  const msgSid = (params.MessageSid || params.SmsMessageSid || '').trim();

  if (!from) return emptyTwiml();

  // 3) Idempotency on MessageSid.
  const prev = previousReply(msgSid);
  if (prev !== null) return twiml(prev);

  // 4) Per-phone rate limit.
  if (!checkRate(from, Date.now())) {
    const r = "Slow down — too many messages. Try again in a minute.";
    rememberReply(msgSid, r);
    return twiml(r);
  }

  // 5) Parse + dispatch.
  const { action, normalised } = parseInboundBody(body);

  // HELP is purely informational; never round-trip to Apps Script for it.
  if (action === 'help') {
    const r = buildReplyText('help', null);
    rememberReply(msgSid, r);
    return twiml(r);
  }

  let asResult: Record<string, unknown> | null = null;
  try {
    const out = await callAppsScript(
      env.APPS_SCRIPT_URL,
      env.JWT_SECRET,
      'sms_inbound',
      {
        from_phone: from,
        body_raw: body,
        body_normalised: normalised,
        action,
        twilio_msg_sid: msgSid
      },
      { purpose: 'twilio_inbound', ttlSeconds: 60 }
    );
    asResult = (out as Record<string, unknown>) ?? null;
  } catch (err) {
    console.error('sms_inbound dispatch failed', err);
    asResult = { ok: false, error: 'apps_script_unreachable' };
  }

  const reply = buildReplyText(action, asResult);
  rememberReply(msgSid, reply);
  return twiml(reply);
}

// ---------------------------------------------------------------------------
// Inbound from the shared SMS hub (workers/sms → Worker)
// ---------------------------------------------------------------------------
//
// Contract per workers/sms/src/callback.ts: the hub POSTs JSON of shape
//   { action: 'sms.inbound' | 'sms.optout' | 'sms.optin_confirmed' |
//             'sms.info_request',
//     from, [to,] [body,] [vendor_id,] received_at }
// signed with HMAC-SHA256 hex of the raw body, using HMAC_SECRET_INTERPRETER.
// Signature delivered both as ?sig= query param AND x-sms-worker-signature
// header (the hub double-sends because Apps Script can't read headers; we
// accept either path).
//
// The hub owns user-visible reply text (STOP/HELP/START); this handler
// just persists side-effects (Audit_Log, Communications row, claim flow).
// 200 = processed; 4xx = bad-sig; 5xx = retry-me.

type HubEvent = {
  action: 'sms.inbound' | 'sms.optout' | 'sms.optin_confirmed' | 'sms.info_request';
  from: string;
  to?: string;
  body?: string;
  vendor_id?: string;
  received_at: string;
};

async function verifyHubSignature(
  rawBody: string,
  signatureHex: string,
  secret: string,
): Promise<boolean> {
  if (!signatureHex || !secret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const macBuf = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(rawBody),
  );
  const macBytes = new Uint8Array(macBuf);
  let expected = '';
  for (let i = 0; i < macBytes.length; i++) {
    expected += macBytes[i]!.toString(16).padStart(2, '0');
  }
  if (expected.length !== signatureHex.length) return false;
  let diff = 0;
  const lower = signatureHex.toLowerCase();
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ lower.charCodeAt(i);
  }
  return diff === 0;
}

export async function handleSmsInboundFromHub(
  request: Request,
  env: Env,
): Promise<Response> {
  const secret = env.HMAC_SECRET_INTERPRETER;
  if (!secret) {
    console.warn('inbound-from-hub: HMAC_SECRET_INTERPRETER not set; refusing');
    return new Response('Forbidden', { status: 403 });
  }

  const rawBody = await request.text();
  const sig =
    request.headers.get('x-sms-worker-signature') ||
    new URL(request.url).searchParams.get('sig') ||
    '';
  const ok = await verifyHubSignature(rawBody, sig, secret);
  if (!ok) {
    console.warn('inbound-from-hub: signature mismatch');
    return new Response('Forbidden', { status: 403 });
  }

  let event: HubEvent;
  try {
    event = JSON.parse(rawBody) as HubEvent;
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const from = (event.from || '').trim();
  if (!from) return new Response('ok', { status: 200 });

  // sms.optin_confirmed / sms.info_request: hub handled the reply; no
  // side effects we currently track on the interpreter side. Log only.
  if (event.action === 'sms.optin_confirmed' || event.action === 'sms.info_request') {
    return new Response('ok', { status: 200 });
  }

  // sms.optout: hub already flipped its own consent ledger; we need to
  // clear the local Users.phone_e164 + force sms_mode='off' via Apps
  // Script so the agency's roster reflects it (and so we don't try to
  // re-send through the hub on subsequent offers).
  if (event.action === 'sms.optout') {
    try {
      await callAppsScript(env.APPS_SCRIPT_URL, env.JWT_SECRET, 'sms_inbound', {
        from_phone: from,
        body_raw: '',
        body_normalised: 'STOP',
        action: 'optout',
        twilio_msg_sid: event.vendor_id || `hub:${event.received_at}`,
      }, { purpose: 'twilio_inbound', ttlSeconds: 60 });
    } catch (err) {
      console.error('inbound-from-hub: optout dispatch failed', err);
      return new Response('retry', { status: 502 });
    }
    return new Response('ok', { status: 200 });
  }

  // sms.inbound: free-text or YES/NO. Parse it the same way the direct
  // handler does, then dispatch to Apps Script. The hub already replied;
  // we ignore the returned reply_text.
  const body = event.body || '';
  const { action, normalised } = parseInboundBody(body);
  try {
    await callAppsScript(env.APPS_SCRIPT_URL, env.JWT_SECRET, 'sms_inbound', {
      from_phone: from,
      body_raw: body,
      body_normalised: normalised,
      action,
      twilio_msg_sid: event.vendor_id || `hub:${event.received_at}`,
    }, { purpose: 'twilio_inbound', ttlSeconds: 60 });
  } catch (err) {
    console.error('inbound-from-hub: dispatch failed', err);
    return new Response('retry', { status: 502 });
  }
  return new Response('ok', { status: 200 });
}

// Test-only helpers — exported so tests can drive the cache deterministically.
export function __resetInboundCacheForTests(): void {
  INBOUND_CACHE.clear();
  RATE_BUCKETS.clear();
}
