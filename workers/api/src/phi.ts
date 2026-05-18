// PHI column-level encryption — AES-GCM via Web Crypto on the Worker.
//
// Apps Script V8 has no AES primitive, so all PHI cipher operations happen
// here. The master key never leaves the Worker; per-tenant DEKs are derived
// via HKDF-SHA256 and held only in-memory for the duration of a request.
//
// Storage format: `v1:<iv_b64>:<ct_b64>`
//   v1     — versioning byte; bump if we change the algorithm
//   iv_b64 — 12-byte random IV, base64url-encoded
//   ct_b64 — ciphertext+tag, base64url-encoded
//
// Routes (internal-only, gated by X-1891-Internal header):
//   POST /v1/phi/encrypt → { tenant_id, plaintext } → { blob }
//   POST /v1/phi/decrypt → { tenant_id, blob }      → { plaintext }
//   POST /v1/phi/rotate-tenant-key (deferred — we'd build it when we need a
//     compromised-tenant-key playbook; doc'd in DISASTER_RECOVERY.md)
//
// Audit trail is the caller's responsibility — Apps Script logs every
// encrypt/decrypt to Audit_Log with the consumer_id and purpose-of-use.

import { verifyInternalHeader } from "./internal";

const PHI_VERSION = "v1";
const PHI_IV_BYTES = 12; // AES-GCM standard nonce size
const HKDF_INFO_ENCRYPT = "1891int:phi:tenant-encrypt:v1";

interface PhiEnv {
  JWT_SECRET: string;
  PHI_MASTER_KEY?: string;
}

function b64urlEncode(bytes: Uint8Array): string {
  // Standard base64, then URL-safe substitutions, strip padding
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Derive a per-tenant 32-byte DEK from the master key + tenant_id via HKDF.
async function deriveTenantKey(masterKeyB64: string, tenantId: string): Promise<CryptoKey> {
  const masterBytes = b64urlDecode(masterKeyB64);
  if (masterBytes.length < 32) {
    throw new Error("PHI_MASTER_KEY must be at least 256 bits (base64url-encoded).");
  }
  const ikm = await crypto.subtle.importKey(
    "raw",
    masterBytes.buffer.slice(masterBytes.byteOffset, masterBytes.byteOffset + masterBytes.byteLength) as ArrayBuffer,
    "HKDF",
    false,
    ["deriveKey"]
  );
  const salt = new TextEncoder().encode("1891int:phi:salt:v1").buffer as ArrayBuffer;
  const info = new TextEncoder().encode(`${HKDF_INFO_ENCRYPT}:${tenantId}`).buffer as ArrayBuffer;
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function asArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export async function encryptPhi(masterKeyB64: string, tenantId: string, plaintext: string): Promise<string> {
  if (!plaintext) return "";
  const key = await deriveTenantKey(masterKeyB64, tenantId);
  const iv = crypto.getRandomValues(new Uint8Array(PHI_IV_BYTES));
  const ptBytes = new TextEncoder().encode(plaintext);
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: asArrayBuffer(iv) }, key, asArrayBuffer(ptBytes));
  return `${PHI_VERSION}:${b64urlEncode(iv)}:${b64urlEncode(new Uint8Array(ctBuf))}`;
}

export async function decryptPhi(masterKeyB64: string, tenantId: string, blob: string): Promise<string> {
  if (!blob) return "";
  const parts = blob.split(":");
  if (parts.length !== 3 || parts[0] !== PHI_VERSION) {
    throw new Error(`Unsupported PHI blob format (version=${parts[0] || "missing"}).`);
  }
  const iv = b64urlDecode(parts[1] as string);
  const ct = b64urlDecode(parts[2] as string);
  if (iv.length !== PHI_IV_BYTES) throw new Error("Invalid PHI IV length.");
  const key = await deriveTenantKey(masterKeyB64, tenantId);
  const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: asArrayBuffer(iv) }, key, asArrayBuffer(ct));
  return new TextDecoder().decode(ptBuf);
}

// ----- HTTP routes ---------------------------------------------------------

export async function routePhi(req: Request, env: PhiEnv): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/v1/phi/")) return null;

  // Method gate
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST required" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Auth: shared X-1891-Internal header (matches the Stripe/Twilio internal-routes pattern)
  const auth = verifyInternalHeader(req, env.JWT_SECRET);
  if (!auth.authorized) {
    return new Response(JSON.stringify({ ok: false, error: "Forbidden", detail: auth.error }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!env.PHI_MASTER_KEY) {
    return new Response(JSON.stringify({
      ok: false,
      configured: false,
      error: "PHI_MASTER_KEY not set. Run: wrangler secret put PHI_MASTER_KEY (must be ≥32 random bytes, base64url-encoded)."
    }), { status: 503, headers: { "Content-Type": "application/json" } });
  }

  let body: { tenant_id?: string; plaintext?: string; blob?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body.tenant_id) {
    return new Response(JSON.stringify({ ok: false, error: "tenant_id required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    if (url.pathname === "/v1/phi/encrypt") {
      if (body.plaintext === undefined || body.plaintext === null) {
        return new Response(JSON.stringify({ ok: false, error: "plaintext required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const blob = await encryptPhi(env.PHI_MASTER_KEY, body.tenant_id, String(body.plaintext));
      return new Response(JSON.stringify({ ok: true, blob, version: PHI_VERSION }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/v1/phi/decrypt") {
      if (!body.blob) {
        return new Response(JSON.stringify({ ok: false, error: "blob required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const plaintext = await decryptPhi(env.PHI_MASTER_KEY, body.tenant_id, body.blob);
      return new Response(JSON.stringify({ ok: true, plaintext }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: false, error: "Unknown PHI route" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
