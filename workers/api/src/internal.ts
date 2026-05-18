// Machine-to-machine auth helpers.
//
// We have two kinds of internal call:
//
//  1. Apps Script  → Worker (e.g. `POST /v1/stripe/account/create`):
//     the Apps Script web app already knows JWT_SECRET. It sets the header
//     `X-1891-Internal: <JWT_SECRET>` on every internal call.
//
//  2. Worker → Apps Script (e.g. webhook handler flipping invoice/payout state):
//     we POST to `${APPS_SCRIPT_URL}?action=<...>&_internal=1` with the same
//     header AND a short-lived worker-issued session JWT (`session=<jwt>`).
//     Apps Script can't read inbound HTTP headers, so the bearer token has to
//     ride in the body or query. The JWT has `iss='worker'` + a `purpose`
//     claim that pins it to a specific webhook action class, and a 60s TTL.
//
// Both directions share one secret. Trade-offs:
//   - Single secret = one place to rotate; same `/exec?action=_rotate_hmac` route
//     already exists.
//   - We DO NOT log the JWT or the legacy header anywhere. Apps Script's audit
//     log records the action + record_id, never the bearer.
//   - Constant-time compare on the Worker side to avoid timing-leak shenanigans.
//
// If JWT_SECRET is unset, every internal call fails closed with a clear error.

import { signWorkerJwt } from "./jwt";

export interface InternalAuthResult {
  authorized: boolean;
  error?: string;
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify the inbound X-1891-Internal header matches the shared secret.
 * Returns { authorized: true } on success, otherwise a reason string we
 * surface to the caller (NEVER the secret value itself).
 */
export function verifyInternalHeader(req: Request, secret: string | undefined): InternalAuthResult {
  if (!secret) {
    return { authorized: false, error: "internal auth not configured (JWT_SECRET unset)" };
  }
  const header = req.headers.get("X-1891-Internal");
  if (!header) return { authorized: false, error: "missing X-1891-Internal header" };
  if (!constantTimeEq(header, secret)) {
    return { authorized: false, error: "bad internal secret" };
  }
  return { authorized: true };
}

/**
 * Build a `RequestInit` for a Worker → Apps Script callback. Used by the
 * Stripe webhook handler to flip Invoice / Payout status after a Stripe event.
 *
 * Returns the URL to fetch and the init object. Caller is responsible for
 * checking response.ok and surfacing failures.
 */
export function buildAppsScriptCallback(
  appsScriptUrl: string,
  secret: string,
  action: string,
  params: Record<string, string>
): { url: string; init: RequestInit } {
  const target = new URL(appsScriptUrl);
  target.searchParams.set("action", action);
  target.searchParams.set("_internal", "1");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") target.searchParams.set(k, String(v));
  }
  const body = new URLSearchParams();
  body.set("action", action);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") body.set(k, String(v));
  }
  return {
    url: target.toString(),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-1891-Internal": secret,
      },
      body: body.toString(),
      redirect: "follow",
    },
  };
}

/**
 * Convenience: actually run the Apps Script callback. Returns the parsed JSON
 * or `{ ok: false, error: "..." }` if the upstream is unreachable.
 *
 * If `purpose` is supplied (e.g., 'stripe_webhook'), we mint a 60s worker JWT
 * and pass it as the `session` body/query param. Apps Script's webhook-action
 * handlers (`apiMarkInvoicePaid`, `apiMarkPayoutPaid`, `apiUpdateInterpreter`,
 * and any other action whitelisted by `_verifyWorkerJwt`) accept this in lieu
 * of a user session.
 */
export async function callAppsScript(
  appsScriptUrl: string,
  secret: string,
  action: string,
  params: Record<string, string>,
  opts: { purpose?: string; ttlSeconds?: number } = {}
): Promise<unknown> {
  const enriched = { ...params };
  if (opts.purpose) {
    try {
      const sess = await signWorkerJwt(
        { purpose: opts.purpose, sub: opts.purpose, ttlSeconds: opts.ttlSeconds ?? 60 },
        secret
      );
      enriched.session = sess;
    } catch (err) {
      return { ok: false, error: "worker_jwt_mint_failed", detail: String(err) };
    }
  }
  const { url, init } = buildAppsScriptCallback(appsScriptUrl, secret, action, enriched);
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: "apps_script_non_json", status: res.status, body_excerpt: text.slice(0, 200) };
    }
  } catch (err) {
    return { ok: false, error: "apps_script_unreachable", detail: String(err) };
  }
}
