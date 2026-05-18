// Compact JWT verifier that matches the Apps Script format exactly:
//   payload   = base64url(JSON.stringify({uid, tid, role, email, iat, exp}))
//   signature = base64url(HMAC-SHA256(secret, payload))
//   token     = payload + "." + signature
//
// Notes:
// - iat / exp are MILLISECONDS (Apps Script uses Date.now()), not seconds.
// - base64url here means standard base64 with `+` → `-`, `/` → `_`, no `=`.
// - Signature compare is constant-time.

export interface JwtPayload {
  uid: string;
  tid: string;
  role: string;
  email?: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

function b64urlEncodeBytes(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecodeToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "====".slice(0, 4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlDecodeToString(s: string): string {
  return new TextDecoder().decode(b64urlDecodeToBytes(s));
}

async function hmacSha256(secret: string, payload: string): Promise<Uint8Array> {
  const keyBytes = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return new Uint8Array(sig);
}

function constantTimeEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Mint a token in the same format Apps Script uses. Useful for tests.
 */
export async function signToken(
  payload: Omit<JwtPayload, "iat" | "exp"> & { iat?: number; exp: number },
  secret: string
): Promise<string> {
  const full: JwtPayload = {
    iat: payload.iat ?? Date.now(),
    ...payload,
  } as JwtPayload;
  const json = JSON.stringify(full);
  const payloadB64 = b64urlEncodeBytes(new TextEncoder().encode(json));
  const sig = await hmacSha256(secret, payloadB64);
  return payloadB64 + "." + b64urlEncodeBytes(sig);
}

/**
 * Verify a compact JWT against the shared HMAC secret.
 * Returns the payload on success, null on any failure (bad shape, bad sig, expired, malformed JSON).
 */
export async function verifyToken(token: string, secret: string): Promise<JwtPayload | null> {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1 || dot === token.length - 1) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts as [string, string];

  let expectedSig: Uint8Array;
  let givenSig: Uint8Array;
  try {
    expectedSig = await hmacSha256(secret, payloadB64);
    givenSig = b64urlDecodeToBytes(sigB64);
  } catch {
    return null;
  }
  if (!constantTimeEq(expectedSig, givenSig)) return null;

  let payload: JwtPayload;
  try {
    payload = JSON.parse(b64urlDecodeToString(payloadB64)) as JwtPayload;
  } catch {
    return null;
  }

  if (typeof payload !== "object" || payload === null) return null;
  if (typeof payload.exp !== "number") return null;
  if (payload.exp < Date.now()) return null;
  if (typeof payload.uid !== "string" || typeof payload.tid !== "string") return null;

  return payload;
}
