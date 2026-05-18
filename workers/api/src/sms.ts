// SMS dispatcher — Twilio outbound + (future) inbound webhooks.
// Internal-only (X-1891-Internal header equals JWT_SECRET).
//
// Config required to actually send (set via wrangler secret put):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_NUMBER  — your purchased Twilio number in E.164 format
//
// Without those secrets, /v1/sms/send returns { ok:false, configured:false }
// so the Apps Script side can degrade gracefully (the platform plan gate).

import type { Env } from './index';

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

  // Config check
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    return jsonResponse(request, {
      ok: false,
      configured: false,
      error: 'Twilio not configured. Set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER via wrangler secret put.'
    }, 503);
  }

  // Twilio REST API call
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const formBody = new URLSearchParams({
    To: body.to,
    From: from,
    Body: body.body
  });
  const basic = btoa(`${sid}:${token}`);

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

// Inbound webhook (delivery status, replies). Twilio signs requests with
// the auth token — we verify here. Wire later when an SMS plan is active.
export async function handleSmsInbound(request: Request, env: Env): Promise<Response> {
  // Verify Twilio signature
  const sig = request.headers.get('X-Twilio-Signature');
  if (!sig || !env.TWILIO_AUTH_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }
  // TODO: HMAC-SHA1(token, fullUrl + sortedFormParams).base64
  // For v1 — accept and ack; route to Apps Script for processing.
  const form = await request.formData();
  const payload: Record<string, string> = {};
  form.forEach((v, k) => { payload[k] = String(v); });

  // Forward to Apps Script's inbound-SMS handler (future endpoint)
  // For now, just log
  console.log('SMS inbound', JSON.stringify(payload));
  return new Response('<Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'application/xml' }
  });
}
