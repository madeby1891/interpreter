// Stripe API client + webhook handler.
//
// Scope (per PRD section E):
//   - Connect Express accounts for interpreter 1099 payouts
//   - Stripe-billed invoices for payer collection
//   - Transfer.send for individual payouts
//   - Webhook receiver with HMAC-SHA256 signature verification per Stripe's
//     v1 scheme: t=<ts>,v1=<hex>
//
// We DO NOT depend on the Stripe SDK. The SDK pulls in Node-isms (axios,
// querystring, util.inspect) that don't fit a Cloudflare Worker cleanly,
// and our surface here is small enough that hand-rolling the HTTP calls is
// the simpler path. We use Stripe's flat HTTP API at https://api.stripe.com/v1.
//
// Test mode is determined by the key prefix (`sk_test_*`). Both test and live
// modes hit the same host; we surface the mode in audit logs only.
//
// What's intentionally NOT in this module:
//   - Apps Script state flips. Those go via internal.ts → Apps Script callback.
//   - PII. Stripe IDs only. We never log card numbers, CVV, SSN, or bank PANs.

import { callAppsScript } from "./internal";

export interface StripeEnv {
  STRIPE_API_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  APPS_SCRIPT_URL: string;
  JWT_SECRET: string;
}

const STRIPE_API_BASE = "https://api.stripe.com/v1";

// Webhooks tolerate ~5 min of skew per Stripe's recommendation.
const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface StripeError {
  ok: false;
  error: string;
  status?: "unconfigured" | "stripe_error" | "bad_request";
  stripe_code?: string;
  http_status?: number;
}

export function unconfigured(): StripeError {
  return {
    ok: false,
    error: "Stripe not configured. Set STRIPE_API_KEY via `wrangler secret put STRIPE_API_KEY`.",
    status: "unconfigured",
  };
}

export function isConfigured(env: StripeEnv): boolean {
  return Boolean(env.STRIPE_API_KEY && env.STRIPE_API_KEY.length > 0);
}

export function isTestMode(env: StripeEnv): boolean {
  return Boolean(env.STRIPE_API_KEY && env.STRIPE_API_KEY.startsWith("sk_test_"));
}

// ---------------------------------------------------------------------------
// Low-level Stripe HTTP client
// ---------------------------------------------------------------------------

function formEncode(obj: Record<string, unknown>, prefix = ""): string {
  // Stripe accepts nested form params: foo[bar]=baz. Encode recursively.
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object" && item !== null) {
          parts.push(formEncode(item as Record<string, unknown>, `${key}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else if (typeof v === "object") {
      parts.push(formEncode(v as Record<string, unknown>, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

export interface StripeCallOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}

export async function stripeApi<T = unknown>(
  env: StripeEnv,
  path: string,
  opts: StripeCallOptions = {}
): Promise<T | StripeError> {
  if (!isConfigured(env)) return unconfigured();
  const method = opts.method ?? "POST";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.STRIPE_API_KEY}`,
    "Stripe-Version": "2024-06-20",
  };
  let body: string | undefined;
  let url = `${STRIPE_API_BASE}${path}`;
  if (opts.body && method === "GET") {
    const qs = formEncode(opts.body);
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  } else if (opts.body) {
    body = formEncode(opts.body);
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body });
  } catch (err) {
    return {
      ok: false,
      error: "stripe_unreachable",
      status: "stripe_error",
      stripe_code: String(err),
    };
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: "stripe_non_json",
      status: "stripe_error",
      http_status: res.status,
    };
  }
  if (!res.ok) {
    const obj = parsed as { error?: { message?: string; code?: string } };
    return {
      ok: false,
      error: obj?.error?.message ?? "stripe_http_error",
      status: "stripe_error",
      stripe_code: obj?.error?.code,
      http_status: res.status,
    };
  }
  return parsed as T;
}

// ---------------------------------------------------------------------------
// Connect Express
// ---------------------------------------------------------------------------

export interface ConnectAccount {
  id: string;
  object: "account";
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements?: { disabled_reason?: string | null; currently_due?: string[] };
  capabilities?: Record<string, string>;
}

export async function createConnectAccount(
  env: StripeEnv,
  params: { email?: string; country?: string; interpreter_id: string }
): Promise<ConnectAccount | StripeError> {
  // Express account, interpreter is the "individual" service-agreement holder.
  return stripeApi<ConnectAccount>(env, "/accounts", {
    method: "POST",
    body: {
      type: "express",
      country: params.country ?? "US",
      email: params.email,
      capabilities: {
        transfers: { requested: true },
      },
      business_type: "individual",
      metadata: { interpreter_id: params.interpreter_id, platform: "1891-interpreter" },
    },
    idempotencyKey: `acct_create_${params.interpreter_id}`,
  });
}

export interface AccountLink {
  object: "account_link";
  url: string;
  expires_at: number;
  created: number;
}

export async function createAccountLink(
  env: StripeEnv,
  params: { account: string; return_url: string; refresh_url: string }
): Promise<AccountLink | StripeError> {
  return stripeApi<AccountLink>(env, "/account_links", {
    method: "POST",
    body: {
      account: params.account,
      refresh_url: params.refresh_url,
      return_url: params.return_url,
      type: "account_onboarding",
    },
  });
}

export async function fetchAccount(
  env: StripeEnv,
  accountId: string
): Promise<ConnectAccount | StripeError> {
  return stripeApi<ConnectAccount>(env, `/accounts/${encodeURIComponent(accountId)}`, {
    method: "GET",
  });
}

// ---------------------------------------------------------------------------
// Transfers (payout to a Connect account)
// ---------------------------------------------------------------------------

export interface Transfer {
  id: string;
  object: "transfer";
  amount: number;
  currency: string;
  destination: string;
  metadata?: Record<string, string>;
}

export async function createTransfer(
  env: StripeEnv,
  params: { amount_cents: number; destination_account: string; payout_id: string; currency?: string }
): Promise<Transfer | StripeError> {
  return stripeApi<Transfer>(env, "/transfers", {
    method: "POST",
    body: {
      amount: params.amount_cents,
      currency: (params.currency ?? "usd").toLowerCase(),
      destination: params.destination_account,
      metadata: { payout_id: params.payout_id, platform: "1891-interpreter" },
    },
    idempotencyKey: `transfer_${params.payout_id}`,
  });
}

// ---------------------------------------------------------------------------
// Customers + Invoices (payer collection)
// ---------------------------------------------------------------------------

export interface StripeCustomer {
  id: string;
  object: "customer";
  email?: string;
}

export async function findOrCreateCustomer(
  env: StripeEnv,
  params: { existing_id?: string; payer_id: string; email?: string; name?: string }
): Promise<StripeCustomer | StripeError> {
  if (params.existing_id) {
    return stripeApi<StripeCustomer>(env, `/customers/${encodeURIComponent(params.existing_id)}`, {
      method: "GET",
    });
  }
  return stripeApi<StripeCustomer>(env, "/customers", {
    method: "POST",
    body: {
      email: params.email,
      name: params.name,
      metadata: { payer_id: params.payer_id, platform: "1891-interpreter" },
    },
    idempotencyKey: `customer_create_${params.payer_id}`,
  });
}

export interface StripeInvoice {
  id: string;
  object: "invoice";
  status: string;
  hosted_invoice_url?: string;
  total: number;
}

export async function createAndSendInvoice(
  env: StripeEnv,
  params: {
    customer: string;
    invoice_id: string;
    line_items: Array<{ description: string; amount_cents: number; quantity: number }>;
    days_until_due?: number;
  }
): Promise<StripeInvoice | StripeError> {
  // 1. Create line items (InvoiceItems) on the customer.
  for (const ln of params.line_items) {
    const item = await stripeApi<{ id: string }>(env, "/invoiceitems", {
      method: "POST",
      body: {
        customer: params.customer,
        amount: ln.amount_cents,
        currency: "usd",
        description: ln.description,
        quantity: ln.quantity,
        metadata: { invoice_id: params.invoice_id },
      },
      idempotencyKey: `iitem_${params.invoice_id}_${hashShort(ln.description)}`,
    });
    if ((item as StripeError).ok === false) return item as StripeError;
  }
  // 2. Create the invoice draft.
  const inv = await stripeApi<StripeInvoice>(env, "/invoices", {
    method: "POST",
    body: {
      customer: params.customer,
      collection_method: "send_invoice",
      days_until_due: params.days_until_due ?? 30,
      metadata: { our_invoice_id: params.invoice_id, platform: "1891-interpreter" },
    },
    idempotencyKey: `invoice_${params.invoice_id}`,
  });
  if ((inv as StripeError).ok === false) return inv as StripeError;
  // 3. Send it.
  const sent = await stripeApi<StripeInvoice>(
    env,
    `/invoices/${encodeURIComponent((inv as StripeInvoice).id)}/send`,
    { method: "POST" }
  );
  return sent;
}

function hashShort(s: string): string {
  // Tiny non-crypto hash, good enough to dedupe idempotency keys per line item.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// ---------------------------------------------------------------------------
// Webhook signature verification (Stripe-Signature: t=<ts>,v1=<hex>)
// ---------------------------------------------------------------------------

function parseStripeSignature(header: string): { t: number; v1: string[] } | null {
  // Format: t=1234567890,v1=hex,v1=hex,v0=...
  const parts = header.split(",").map((p) => p.trim());
  let t = NaN;
  const v1: string[] = [];
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (k === "t") t = Number(v);
    else if (k === "v1") v1.push(v);
  }
  if (!t || !v1.length) return null;
  return { t, v1 };
}

function constantTimeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i]!.toString(16);
    hex += h.length === 1 ? "0" + h : h;
  }
  return hex;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  event?: StripeWebhookEvent;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
  livemode?: boolean;
  created?: number;
}

/**
 * Verify a Stripe webhook signature. Reads the raw body (must be the bytes the
 * signature was computed over — DO NOT re-stringify a parsed JSON object).
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<VerifyResult> {
  if (!signatureHeader) return { ok: false, reason: "missing Stripe-Signature header" };
  const parsed = parseStripeSignature(signatureHeader);
  if (!parsed) return { ok: false, reason: "malformed Stripe-Signature header" };
  if (Math.abs(now - parsed.t) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }
  const signedPayload = `${parsed.t}.${rawBody}`;
  const expected = await hmacSha256Hex(webhookSecret, signedPayload);
  const matched = parsed.v1.some((sig) => constantTimeEqHex(sig, expected));
  if (!matched) return { ok: false, reason: "no matching v1 signature" };
  let evt: StripeWebhookEvent;
  try {
    evt = JSON.parse(rawBody) as StripeWebhookEvent;
  } catch {
    return { ok: false, reason: "bad json body" };
  }
  return { ok: true, event: evt };
}

// ---------------------------------------------------------------------------
// Webhook event router → Apps Script callbacks
// ---------------------------------------------------------------------------

export interface WebhookHandlerResult {
  ok: boolean;
  handled: string;
  apps_script?: unknown;
  skipped?: string;
}

export async function handleWebhookEvent(
  env: StripeEnv,
  event: StripeWebhookEvent
): Promise<WebhookHandlerResult> {
  switch (event.type) {
    case "invoice.paid":
    case "invoice.payment_succeeded": {
      const obj = event.data.object as { metadata?: Record<string, string>; id?: string };
      const ourInvoiceId = obj?.metadata?.our_invoice_id;
      if (!ourInvoiceId) return { ok: true, handled: event.type, skipped: "no our_invoice_id metadata" };
      const result = await callAppsScript(env.APPS_SCRIPT_URL, env.JWT_SECRET, "mark_invoice_paid", {
        invoice_id: ourInvoiceId,
        stripe_invoice_id: obj.id ?? "",
        paid_at: new Date().toISOString(),
      });
      return { ok: true, handled: event.type, apps_script: result };
    }
    case "transfer.paid":
    case "transfer.created": {
      const obj = event.data.object as { metadata?: Record<string, string>; id?: string };
      const payoutId = obj?.metadata?.payout_id;
      if (!payoutId) return { ok: true, handled: event.type, skipped: "no payout_id metadata" };
      const result = await callAppsScript(env.APPS_SCRIPT_URL, env.JWT_SECRET, "mark_payout_paid", {
        payout_id: payoutId,
        stripe_transfer_id: obj.id ?? "",
        paid_at: new Date().toISOString(),
      });
      return { ok: true, handled: event.type, apps_script: result };
    }
    case "account.updated": {
      const obj = event.data.object as {
        id?: string;
        metadata?: Record<string, string>;
        charges_enabled?: boolean;
        payouts_enabled?: boolean;
        details_submitted?: boolean;
      };
      const interpreterId = obj?.metadata?.interpreter_id;
      if (!interpreterId) return { ok: true, handled: event.type, skipped: "no interpreter_id metadata" };
      const result = await callAppsScript(env.APPS_SCRIPT_URL, env.JWT_SECRET, "update_interpreter", {
        interpreter_id: interpreterId,
        stripe_account_id: obj.id ?? "",
        stripe_charges_enabled: String(obj.charges_enabled ?? false),
        stripe_payouts_enabled: String(obj.payouts_enabled ?? false),
        stripe_details_submitted: String(obj.details_submitted ?? false),
        _internal_source: "stripe_webhook",
      });
      return { ok: true, handled: event.type, apps_script: result };
    }
    case "charge.dispute.created":
    case "charge.refunded":
    case "charge.failed":
      // Acknowledge and forward as audit-only; state flips happen in admin UI.
      return { ok: true, handled: event.type, skipped: "audit_only_for_v1" };
    default:
      return { ok: true, handled: event.type, skipped: "unhandled_event_type" };
  }
}
