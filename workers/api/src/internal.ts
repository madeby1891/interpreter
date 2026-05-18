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
//     header. Apps Script verifies the header against the script property and
//     skips the session-JWT check on those routes.
//
// Both directions share one secret. Trade-offs:
//   - Single secret = one place to rotate; same `/exec?action=_rotate_hmac` route
//     already exists.
//   - We DO NOT log this header anywhere. Apps Script's audit log records the
//     action + record_id, never the secret.
//   - Constant-time compare on the Worker side to avoid timing-leak shenanigans.
//
// If JWT_SECRET is unset, every internal call fails closed with a clear error.

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
 */
export async function callAppsScript(
  appsScriptUrl: string,
  secret: string,
  action: string,
  params: Record<string, string>
): Promise<unknown> {
  const { url, init } = buildAppsScriptCallback(appsScriptUrl, secret, action, params);
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
