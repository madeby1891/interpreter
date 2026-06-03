// QuickBooks Online (QBO) OAuth2 — push interpreter Invoices to QuickBooks.
//
// Added 2026-06-02. Mirrors the Stripe Connect (Pattern G) shape in connect.ts:
//   - HMAC-signed `state` (JWT_SECRET, 10-min TTL) carrying tenant_id
//   - start / callback / refresh / push helpers
//   - { ok:false, status:'unconfigured' } when env secrets are unset
//
// The flow:
//   1. Admin clicks "Connect QuickBooks Online" → /v1/qbo/oauth/start
//      → we mint HMAC-signed `state`, build the Intuit authorize URL, return it.
//   2. Admin consents at the Intuit-hosted screen (accounting scope).
//   3. Intuit redirects to QBO_REDIRECT_URI?code=…&state=…&realmId=…
//      → site posts to /v1/qbo/oauth/callback
//      → we verify state HMAC, exchange code at Intuit's token endpoint with
//        Basic auth of client_id:client_secret, return access+refresh tokens
//        and the realm_id (the QBO company id).
//   4. Apps Script persists the realm_id on the Agencies row and stores the
//      refresh_token in Script Properties (server-side, keyed by tenant) —
//      the same place Code_Sso.gs keeps its confidential client secret. The
//      worker never persists tokens itself; connect.ts likewise stamps the
//      Agencies row via Apps Script and keeps no secret store of its own.
//   5. push-invoice: Apps Script gathers the interpreter Invoice + lines and
//      the tenant's stored refresh_token + realm_id, posts here; we refresh the
//      access token, then create a QBO Invoice via the v3 company API.
//
// Hard rules (mirror connect.ts):
//   - state is HMAC-SHA256 signed with JWT_SECRET, 10-min expiry. An attacker
//     hijacking the callback otherwise could bind their QuickBooks company to
//     someone else's tenant.
//   - Refresh tokens are sensitive. The worker is a pass-through: it returns
//     the refresh_token to Apps Script (which stores it in Script Properties)
//     and accepts it back on push. We never write it to a Sheet column.

export interface QboEnv {
  QBO_CLIENT_ID?: string;
  QBO_CLIENT_SECRET?: string;
  QBO_REDIRECT_URI?: string;
  QBO_ENVIRONMENT?: string; // "sandbox" | "production"
  JWT_SECRET: string;
  APPS_SCRIPT_URL: string;
}

// Intuit OAuth2 endpoints (same host for sandbox + production; the API base
// differs, the auth host does not).
const OAUTH_AUTHORIZE_BASE = "https://appcenter.intuit.com/connect/oauth2";
const OAUTH_TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QBO_SCOPE = "com.intuit.quickbooks.accounting";
const STATE_TTL_SECONDS = 600; // 10 minutes

// API base by environment. Production data lives behind the production host;
// the developer sandbox behind the sandbox host.
const QBO_API_BASE_SANDBOX = "sandbox-quickbooks.api.intuit.com";
const QBO_API_BASE_PRODUCTION = "quickbooks.api.intuit.com";

export function qboApiBase(env: QboEnv): string {
  const e = String(env.QBO_ENVIRONMENT ?? "").toLowerCase();
  return e === "production" ? QBO_API_BASE_PRODUCTION : QBO_API_BASE_SANDBOX;
}

// ---------------------------------------------------------------------------
// State signing (HMAC-SHA256 over tenant_id + expiry, base64url)
// Identical scheme to connect.ts so the two share auditable behavior.
// ---------------------------------------------------------------------------

export interface QboStatePayload {
  tenant_id: string;
  email: string; // admin who clicked Connect
  exp: number;   // unix seconds
}

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const std = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(sig);
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signState(
  payload: QboStatePayload,
  secret: string
): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)).buffer);
  const sig = await hmacSign(secret, body);
  return `${body}.${sig}`;
}

export async function verifyState(
  state: string,
  secret: string
): Promise<{ ok: true; payload: QboStatePayload } | { ok: false; reason: string }> {
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed_state" };
  const body = parts[0]!;
  const sig = parts[1]!;
  const expected = await hmacSign(secret, body);
  if (!constantTimeEq(sig, expected)) return { ok: false, reason: "bad_signature" };
  let payload: QboStatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return { ok: false, reason: "expired_state" };
  if (!payload.tenant_id) return { ok: false, reason: "missing_tenant_id" };
  return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// Configuration guard
// ---------------------------------------------------------------------------

export interface QboError {
  ok: false;
  error: string;
  status?: "unconfigured" | "bad_request" | "qbo_error";
  http_status?: number;
}

export function isConfigured(env: QboEnv): boolean {
  return Boolean(
    env.QBO_CLIENT_ID &&
      env.QBO_CLIENT_SECRET &&
      env.QBO_REDIRECT_URI
  );
}

export function unconfigured(): QboError {
  return {
    ok: false,
    error:
      "QuickBooks Online not configured. Set QBO_CLIENT_ID, QBO_CLIENT_SECRET, " +
      "QBO_REDIRECT_URI (and optionally QBO_ENVIRONMENT) via `wrangler secret put`.",
    status: "unconfigured",
  };
}

// ---------------------------------------------------------------------------
// OAuth start — build the Intuit authorize URL the admin redirects to
// ---------------------------------------------------------------------------

export interface QboStartResult {
  ok: true;
  authorize_url: string;
  state: string;
  expires_at: number;
}

export async function buildOAuthStartUrl(
  env: QboEnv,
  params: { tenant_id: string; email: string }
): Promise<QboStartResult | QboError> {
  if (!isConfigured(env)) return unconfigured();
  if (!params.tenant_id) return { ok: false, error: "tenant_id required", status: "bad_request" };
  if (!params.email) return { ok: false, error: "email required", status: "bad_request" };
  const exp = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
  const state = await signState(
    { tenant_id: params.tenant_id, email: params.email, exp },
    env.JWT_SECRET
  );
  const url =
    `${OAUTH_AUTHORIZE_BASE}?` +
    new URLSearchParams({
      response_type: "code",
      client_id: env.QBO_CLIENT_ID!,
      scope: QBO_SCOPE,
      redirect_uri: env.QBO_REDIRECT_URI!,
      state,
    }).toString();
  return { ok: true, authorize_url: url, state, expires_at: exp };
}

// ---------------------------------------------------------------------------
// OAuth callback — exchange code for access + refresh tokens, capture realm_id
// ---------------------------------------------------------------------------

export interface QboTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;             // access token TTL (seconds)
  x_refresh_token_expires_in: number; // refresh token TTL (seconds)
}

export interface QboCallbackResult {
  ok: true;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
  realm_id: string;
  tenant_id: string;
  email: string;
}

// Basic auth header for the confidential-client token call (client_id:secret).
function basicAuthHeader(clientId: string, clientSecret: string): string {
  // btoa is available in the Workers runtime.
  return "Basic " + btoa(`${clientId}:${clientSecret}`);
}

async function postTokenEndpoint(
  env: QboEnv,
  form: Record<string, string>
): Promise<QboTokenResponse | QboError> {
  const body = new URLSearchParams(form).toString();
  let res: Response;
  try {
    res = await fetch(OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(env.QBO_CLIENT_ID!, env.QBO_CLIENT_SECRET!),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
  } catch (err) {
    return { ok: false, error: `network: ${(err as Error).message}`, status: "qbo_error" };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { ok: false, error: "non-json response from Intuit token endpoint", status: "qbo_error", http_status: res.status };
  }
  if (!res.ok || !(parsed as { access_token?: string }).access_token) {
    const errObj = parsed as { error?: string; error_description?: string };
    return {
      ok: false,
      error: errObj.error_description || errObj.error || "qbo_oauth_error",
      status: "qbo_error",
      http_status: res.status,
    };
  }
  return parsed as QboTokenResponse;
}

export async function exchangeOAuthCode(
  env: QboEnv,
  params: { code: string; state: string; realm_id: string }
): Promise<QboCallbackResult | QboError> {
  if (!isConfigured(env)) return unconfigured();
  const stateCheck = await verifyState(params.state, env.JWT_SECRET);
  if (!stateCheck.ok) {
    return { ok: false, error: `state: ${stateCheck.reason}`, status: "bad_request" };
  }
  if (!params.realm_id) {
    return { ok: false, error: "realmId required from callback", status: "bad_request" };
  }
  const tok = await postTokenEndpoint(env, {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: env.QBO_REDIRECT_URI!,
  });
  if ((tok as QboError).ok === false) return tok as QboError;
  const t = tok as QboTokenResponse;
  return {
    ok: true,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_in: t.expires_in,
    refresh_token_expires_in: t.x_refresh_token_expires_in,
    realm_id: params.realm_id,
    tenant_id: stateCheck.payload.tenant_id,
    email: stateCheck.payload.email,
  };
}

// ---------------------------------------------------------------------------
// Token refresh — exchange a stored refresh_token for a fresh access_token.
// Intuit rotates the refresh_token periodically; the caller (Apps Script)
// must persist the returned refresh_token so the next call uses the latest.
// ---------------------------------------------------------------------------

export interface QboRefreshResult {
  ok: true;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
}

export async function refreshAccessToken(
  env: QboEnv,
  params: { refresh_token: string }
): Promise<QboRefreshResult | QboError> {
  if (!isConfigured(env)) return unconfigured();
  if (!params.refresh_token) {
    return { ok: false, error: "refresh_token required", status: "bad_request" };
  }
  const tok = await postTokenEndpoint(env, {
    grant_type: "refresh_token",
    refresh_token: params.refresh_token,
  });
  if ((tok as QboError).ok === false) return tok as QboError;
  const t = tok as QboTokenResponse;
  return {
    ok: true,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_in: t.expires_in,
    refresh_token_expires_in: t.x_refresh_token_expires_in,
  };
}

// ---------------------------------------------------------------------------
// Push invoice — create a QBO Invoice from an interpreter Invoice
//
// The interpreter Invoice shape (Code_Invoicing.gs): an invoice header with
// invoice_number / period / total_cents and a set of Invoice_Lines, each with a
// description + quantity (hours) + rate_cents + amount_cents. We map each line
// to a QBO SalesItemLineDetail. QBO requires an ItemRef; we default to "1"
// (Services) unless the caller passes a tenant-configured item id.
// ---------------------------------------------------------------------------

export interface PushInvoiceLine {
  description: string;
  amount_cents: number;
  quantity?: number;
  rate_cents?: number;
}

export interface PushInvoiceParams {
  refresh_token: string;
  realm_id: string;
  invoice: {
    invoice_id: string;
    invoice_number?: string;
    customer_ref?: string;        // QBO Customer id; optional
    customer_name?: string;       // display name for the customer line / private note
    due_date?: string;            // YYYY-MM-DD
    lines: PushInvoiceLine[];
    memo?: string;
  };
  item_ref?: string;              // QBO Item id for the service line; default "1"
}

export interface PushInvoiceResult {
  ok: true;
  qbo_invoice_id: string;
  qbo_doc_number: string | null;
  realm_id: string;
  refresh_token: string;          // possibly rotated — caller must persist
}

function centsToAmount(cents: number): number {
  // QBO money is a decimal number (e.g. 95.00), not cents.
  return Math.round(Number(cents) || 0) / 100;
}

export async function pushInvoice(
  env: QboEnv,
  params: PushInvoiceParams
): Promise<PushInvoiceResult | QboError> {
  if (!isConfigured(env)) return unconfigured();
  if (!params.refresh_token) return { ok: false, error: "refresh_token required", status: "bad_request" };
  if (!params.realm_id) return { ok: false, error: "realm_id required", status: "bad_request" };
  const inv = params.invoice;
  if (!inv || !Array.isArray(inv.lines) || !inv.lines.length) {
    return { ok: false, error: "invoice with at least one line required", status: "bad_request" };
  }

  // 1. Refresh the access token (also rotates the refresh token).
  const refreshed = await refreshAccessToken(env, { refresh_token: params.refresh_token });
  if ((refreshed as QboError).ok === false) return refreshed as QboError;
  const accessToken = (refreshed as QboRefreshResult).access_token;
  const rotatedRefresh = (refreshed as QboRefreshResult).refresh_token;

  // 2. Build the QBO Invoice payload.
  const itemRef = params.item_ref || "1"; // default "Services" item in a fresh QBO
  const Line = inv.lines.map((ln) => ({
    DetailType: "SalesItemLineDetail",
    Amount: centsToAmount(ln.amount_cents),
    Description: ln.description || "Interpreting services",
    SalesItemLineDetail: {
      ItemRef: { value: itemRef },
      ...(ln.quantity != null ? { Qty: Number(ln.quantity) } : {}),
      ...(ln.rate_cents != null ? { UnitPrice: centsToAmount(ln.rate_cents) } : {}),
    },
  }));

  const payload: Record<string, unknown> = { Line };
  if (inv.customer_ref) {
    payload.CustomerRef = { value: inv.customer_ref };
  } else if (inv.customer_name) {
    // Without a CustomerRef, QBO requires one; surface a clear error rather
    // than letting QBO 400 opaquely. Apps Script should resolve/create the
    // customer first (or pass customer_ref).
    return {
      ok: false,
      error: "customer_ref required (QBO Invoice needs a CustomerRef)",
      status: "bad_request",
    };
  } else {
    return {
      ok: false,
      error: "customer_ref required (QBO Invoice needs a CustomerRef)",
      status: "bad_request",
    };
  }
  if (inv.invoice_number) payload.DocNumber = String(inv.invoice_number);
  if (inv.due_date) payload.DueDate = inv.due_date;
  if (inv.memo) payload.CustomerMemo = { value: inv.memo };
  // Carry our id for traceability back from QBO.
  payload.PrivateNote = `1891 invoice ${inv.invoice_id}`;

  // 3. POST to the QBO v3 company invoice endpoint.
  const url = `https://${qboApiBase(env)}/v3/company/${encodeURIComponent(params.realm_id)}/invoice?minorversion=73`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, error: `qbo_unreachable: ${(err as Error).message}`, status: "qbo_error" };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { ok: false, error: "qbo_non_json", status: "qbo_error", http_status: res.status };
  }
  if (!res.ok) {
    const fault = parsed as { Fault?: { Error?: Array<{ Message?: string; Detail?: string }> } };
    const first = fault?.Fault?.Error?.[0];
    return {
      ok: false,
      error: first?.Detail || first?.Message || "qbo_http_error",
      status: "qbo_error",
      http_status: res.status,
    };
  }
  const created = parsed as { Invoice?: { Id?: string; DocNumber?: string } };
  const qboId = created?.Invoice?.Id;
  if (!qboId) {
    return { ok: false, error: "qbo_response_missing_invoice_id", status: "qbo_error" };
  }
  return {
    ok: true,
    qbo_invoice_id: qboId,
    qbo_doc_number: created.Invoice?.DocNumber ?? null,
    realm_id: params.realm_id,
    refresh_token: rotatedRefresh,
  };
}
