// Stripe Connect OAuth — Mode A (Pattern G) read-only reporting.
//
// Added 2026-05-19 from the Mode-A pivot. See:
//   - shared/specs/PAYMENTS.md §2.6 Pattern G
//   - docs/PAYMENTS_IMPL.md §1.5
//
// The flow:
//   1. Agency clicks "Connect your Stripe" → /v1/connect/oauth/start
//      → we mint HMAC-signed `state`, build Stripe OAuth URL, return redirect.
//   2. Agency consents at Stripe-hosted screen (read_only scope).
//   3. Stripe redirects to /interpreter/connect/callback?code=…&state=…
//      → site posts to /v1/connect/oauth/callback
//      → we verify state HMAC, exchange code for stripe_user_id (acct_…),
//        write to Agencies row via Apps Script.
//   4. Subsequent reporting calls use the platform key with
//      `Stripe-Account: acct_<agency>` header for read-only data.
//
// Hard rules (from PAYMENTS.md §2.6):
//   - scope is ALWAYS `read_only`. Never request `read_write` without a
//     separate per-feature consent flow.
//   - state is HMAC-SHA256 signed with JWT_SECRET, 5-min expiry. An
//     attacker hijacking the callback otherwise could bind their Stripe
//     to someone else's tenant.
//   - We DON'T store the agency's Stripe access_token. The code exchange
//     gives us `stripe_user_id` only. Every subsequent API call uses the
//     platform's restricted key + `Stripe-Account` header.

import { stripeApi } from "./stripe";

export interface ConnectEnv {
  STRIPE_API_KEY?: string;
  STRIPE_CONNECT_CLIENT_ID?: string;  // ca_… from dashboard.stripe.com/settings/connect
  JWT_SECRET: string;
  APPS_SCRIPT_URL: string;
}

const OAUTH_AUTHORIZE_BASE = "https://connect.stripe.com/oauth/authorize";
const OAUTH_TOKEN_ENDPOINT = "https://connect.stripe.com/oauth/token";
const STATE_TTL_SECONDS = 300; // 5 minutes

// Default redirect URI for the agency-facing OAuth callback. Override per-env
// if needed; the platform's Stripe Connect application MUST list this exact
// URL in its "Redirects" allowlist at dashboard.stripe.com/settings/connect.
export const CONNECT_REDIRECT_URI =
  "https://madeby1891.com/interpreter/connect/callback";

// ---------------------------------------------------------------------------
// State signing (HMAC-SHA256 over tenant_id + expiry, base64url)
// ---------------------------------------------------------------------------

export interface OAuthStatePayload {
  tenant_id: string;
  email: string;       // admin who clicked Connect
  exp: number;         // unix seconds
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
  payload: OAuthStatePayload,
  secret: string
): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)).buffer);
  const sig = await hmacSign(secret, body);
  return `${body}.${sig}`;
}

export async function verifyState(
  state: string,
  secret: string
): Promise<{ ok: true; payload: OAuthStatePayload } | { ok: false; reason: string }> {
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed_state" };
  const body = parts[0]!;
  const sig = parts[1]!;
  const expected = await hmacSign(secret, body);
  if (!constantTimeEq(sig, expected)) return { ok: false, reason: "bad_signature" };
  let payload: OAuthStatePayload;
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
// OAuth start — build the Stripe authorize URL the agency redirects to
// ---------------------------------------------------------------------------

export interface OAuthStartResult {
  ok: true;
  authorize_url: string;
  state: string;
  expires_at: number;
}
export interface OAuthError {
  ok: false;
  error: string;
  status?: "unconfigured" | "bad_request";
}

export async function buildOAuthStartUrl(
  env: ConnectEnv,
  params: { tenant_id: string; email: string }
): Promise<OAuthStartResult | OAuthError> {
  if (!env.STRIPE_CONNECT_CLIENT_ID) {
    return {
      ok: false,
      error:
        "Stripe Connect platform not configured. Anthony: enable Connect at " +
        "dashboard.stripe.com/settings/connect (sign platform terms), then " +
        "`npx wrangler secret put STRIPE_CONNECT_CLIENT_ID` with the ca_… value.",
      status: "unconfigured",
    };
  }
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
      client_id: env.STRIPE_CONNECT_CLIENT_ID,
      scope: "read_only",
      redirect_uri: CONNECT_REDIRECT_URI,
      state,
    }).toString();
  return { ok: true, authorize_url: url, state, expires_at: exp };
}

// ---------------------------------------------------------------------------
// OAuth callback — exchange code for stripe_user_id (acct_…)
// ---------------------------------------------------------------------------

export interface OAuthTokenResponse {
  access_token: string;          // sk_... — we do NOT persist this
  livemode: boolean;
  refresh_token?: string;
  token_type: string;
  scope: "read_only" | "read_write";
  stripe_publishable_key?: string;
  stripe_user_id: string;        // acct_… — THIS is the keeper
}

export interface OAuthCallbackResult {
  ok: true;
  stripe_user_id: string;
  scope: string;
  livemode: boolean;
  tenant_id: string;
  email: string;
}

export async function exchangeOAuthCode(
  env: ConnectEnv,
  params: { code: string; state: string }
): Promise<OAuthCallbackResult | OAuthError> {
  if (!env.STRIPE_API_KEY) {
    return { ok: false, error: "STRIPE_API_KEY not set", status: "unconfigured" };
  }
  if (!env.STRIPE_CONNECT_CLIENT_ID) {
    return { ok: false, error: "STRIPE_CONNECT_CLIENT_ID not set", status: "unconfigured" };
  }
  const stateCheck = await verifyState(params.state, env.JWT_SECRET);
  if (!stateCheck.ok) {
    return { ok: false, error: `state: ${stateCheck.reason}`, status: "bad_request" };
  }
  // Exchange the code for an access_token + stripe_user_id.
  const body = new URLSearchParams({
    client_secret: env.STRIPE_API_KEY,
    code: params.code,
    grant_type: "authorization_code",
  }).toString();
  let res: Response;
  try {
    res = await fetch(OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    return { ok: false, error: `network: ${(err as Error).message}` };
  }
  let parsed: OAuthTokenResponse | { error?: string; error_description?: string };
  try {
    parsed = await res.json();
  } catch {
    return { ok: false, error: "non-json response from Stripe oauth/token" };
  }
  if (!res.ok || !("stripe_user_id" in parsed)) {
    const errObj = parsed as { error?: string; error_description?: string };
    return {
      ok: false,
      error: errObj.error_description || errObj.error || "stripe_oauth_error",
    };
  }
  const t = parsed as OAuthTokenResponse;
  return {
    ok: true,
    stripe_user_id: t.stripe_user_id,
    scope: t.scope,
    livemode: t.livemode,
    tenant_id: stateCheck.payload.tenant_id,
    email: stateCheck.payload.email,
  };
}

// ---------------------------------------------------------------------------
// Reporting — read-only via Stripe-Account header
// ---------------------------------------------------------------------------

export interface AgencyReport {
  ok: true;
  acct: string;
  balance: { available_cents: number; pending_cents: number; currency: string }[];
  recent_invoices: {
    id: string;
    status: string;
    total: number;
    currency: string;
    created: number;
    hosted_invoice_url: string | null;
    customer_email: string | null;
  }[];
  recent_payouts: {
    id: string;
    amount: number;
    currency: string;
    status: string;
    arrival_date: number;
    method: string;
  }[];
  recent_charges: {
    id: string;
    amount: number;
    currency: string;
    status: string;
    created: number;
    description: string | null;
    refunded: boolean;
  }[];
}

/**
 * Read-only data pull for an agency-linked Stripe account. Uses the platform's
 * restricted key with `Stripe-Account: <acct>` header per Stripe's standard
 * platform-on-behalf-of pattern.
 */
export async function fetchAgencyReport(
  env: ConnectEnv,
  params: { stripe_user_id: string; limit?: number }
): Promise<AgencyReport | OAuthError> {
  if (!env.STRIPE_API_KEY) {
    return { ok: false, error: "STRIPE_API_KEY not set", status: "unconfigured" };
  }
  const acct = params.stripe_user_id;
  const limit = Math.max(1, Math.min(50, params.limit ?? 20));
  const onBehalfOf = { stripeAccount: acct };
  const [balance, invoices, payouts, charges] = await Promise.all([
    stripeApi<{ available: { amount: number; currency: string }[]; pending: { amount: number; currency: string }[] }>(
      env as Parameters<typeof stripeApi>[0],
      "/balance",
      { method: "GET", ...onBehalfOf }
    ),
    stripeApi<{ data: AgencyInvoice[] }>(
      env as Parameters<typeof stripeApi>[0],
      `/invoices?limit=${limit}`,
      { method: "GET", ...onBehalfOf }
    ),
    stripeApi<{ data: AgencyPayout[] }>(
      env as Parameters<typeof stripeApi>[0],
      `/payouts?limit=${limit}`,
      { method: "GET", ...onBehalfOf }
    ),
    stripeApi<{ data: AgencyCharge[] }>(
      env as Parameters<typeof stripeApi>[0],
      `/charges?limit=${limit}`,
      { method: "GET", ...onBehalfOf }
    ),
  ]);
  // Any of the four can error; surface the first error encountered.
  for (const r of [balance, invoices, payouts, charges]) {
    if ((r as { ok?: false }).ok === false) return r as OAuthError;
  }
  const bal = balance as { available: { amount: number; currency: string }[]; pending: { amount: number; currency: string }[] };
  const balanceRows: AgencyReport["balance"] = [];
  const allBal: Record<string, { available_cents: number; pending_cents: number }> = {};
  for (const a of bal.available || []) {
    allBal[a.currency] = { ...(allBal[a.currency] || { available_cents: 0, pending_cents: 0 }), available_cents: a.amount };
  }
  for (const p of bal.pending || []) {
    allBal[p.currency] = { ...(allBal[p.currency] || { available_cents: 0, pending_cents: 0 }), pending_cents: p.amount };
  }
  for (const currency of Object.keys(allBal)) {
    const row = allBal[currency]!;
    balanceRows.push({ currency, available_cents: row.available_cents, pending_cents: row.pending_cents });
  }
  return {
    ok: true,
    acct,
    balance: balanceRows,
    recent_invoices: ((invoices as { data: AgencyInvoice[] }).data || []).map((i) => ({
      id: i.id,
      status: i.status,
      total: i.total,
      currency: i.currency,
      created: i.created,
      hosted_invoice_url: i.hosted_invoice_url ?? null,
      customer_email: i.customer_email ?? null,
    })),
    recent_payouts: ((payouts as { data: AgencyPayout[] }).data || []).map((p) => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      arrival_date: p.arrival_date,
      method: p.method,
    })),
    recent_charges: ((charges as { data: AgencyCharge[] }).data || []).map((c) => ({
      id: c.id,
      amount: c.amount,
      currency: c.currency,
      status: c.status,
      created: c.created,
      description: c.description ?? null,
      refunded: c.refunded,
    })),
  };
}

interface AgencyInvoice {
  id: string;
  status: string;
  total: number;
  currency: string;
  created: number;
  hosted_invoice_url?: string;
  customer_email?: string;
}
interface AgencyPayout {
  id: string;
  amount: number;
  currency: string;
  status: string;
  arrival_date: number;
  method: string;
}
interface AgencyCharge {
  id: string;
  amount: number;
  currency: string;
  status: string;
  created: number;
  description?: string;
  refunded: boolean;
}
