/**
 * interpreter-data — HMAC envelope primitives (SHA-256, base64, body-signed).
 *
 * Extracted from index.ts so mirror.ts can SIGN its outbound D1->Sheet mirror
 * POST without a circular import (index -> mirror -> index). Same envelope
 * shape end to end: { payload: "<json string>", sig: "<base64 hmac>" } — the
 * shape DASHBOARD_CONTRACT #13, kgh-data, and the Apps Script rail share.
 * Body-signing (not a header) keeps it compatible with Apps Script, which
 * cannot read request headers (reference_apps_script_no_headers).
 *
 * Both sides sign the literal UTF-8 bytes of `payload`
 * (Utilities.newBlob(payload).getBytes() <-> TextEncoder().encode(payload)).
 */

// ('sign'|'verify')[] not KeyUsage[]: @cloudflare/workers-types has no KeyUsage
// (that's a DOM lib name) — the old inline copy in index.ts never typechecked.
async function hmacKey(secret: string, usage: ('sign' | 'verify')[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage,
  );
}

export async function signBody(secret: string, body: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

export async function verifyBody(secret: string, body: string, sig: string): Promise<boolean> {
  try {
    const expected = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), expected, new TextEncoder().encode(body));
  } catch { return false; }
}
