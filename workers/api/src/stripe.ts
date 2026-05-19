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
//   - PII. Stripe IDs only. We never log card numbers, CVV, SSN, or bank PANs.
//
// ---------------------------------------------------------------------------
// Apps Script bridge — every Stripe event the worker handles posts to:
//   POST <APPS_SCRIPT_URL>?action=payments_webhook_event
//   body: {
//     session,           // worker-issued 60s JWT, purpose='stripe_webhook'
//     event_id,          // Stripe event.id (idempotency key on the AS side)
//     event_type,        // e.g. 'invoice.paid', 'charge.dispute.created'
//     livemode,          // 'true' | 'false'
//     created,           // Stripe unix timestamp, stringified
//     object_id,         // pi_… | in_… | tr_… | acct_… | sub_… | dp_… | po_… | cs_…
//     object_type,       // 'payment_intent' | 'invoice' | 'transfer' | …
//     metadata,          // JSON-stringified flat string→string map from the object
//     summary,           // short human string ("PaymentIntent succeeded — $125.00 USD")
//     payload_excerpt    // JSON.stringify(event.data.object) truncated to ~3000 chars
//   }
//
// Apps Script is responsible for: idempotent write to a Stripe_Events tab,
// then any downstream Sheet updates (subscription state, payout state, etc.)
// based on event_type. Worker is source of truth for Stripe state;
// Apps Script is source of truth for the Sheet.
//
// Idempotency is enforced TWICE: the worker checks KV (env.IDEMPOTENCY) before
// forwarding, and Apps Script de-dupes on event_id when writing the Sheet row.
// Belt-and-suspenders — Stripe retries are routine.
// ---------------------------------------------------------------------------

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
  // Connect platform-on-behalf-of: when set, adds `Stripe-Account: <acct_…>`
  // header so the call reads/writes against the connected account's data,
  // not the platform's. Pattern G uses this for read-only reporting.
  stripeAccount?: string;
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
  if (opts.stripeAccount) headers["Stripe-Account"] = opts.stripeAccount;
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
// Connect Express  —  ⚠️ DEFERRED 2026-05-19 (Pattern A / Mode B opt-in only)
//
// These functions create Express accounts UNDER THE PLATFORM, run platform-side
// invoicing, and transfer money on behalf of agencies. That's the platform-PayFac
// model (Mode B) — it makes 1891 a money transmitter in ~49 states and requires
// state-by-state MTL registration.
//
// The Mode A canonical (post-2026-05-19) is: agencies link their OWN Stripe via
// OAuth (read-only), keep merchant-of-record, run their own customer billing +
// payouts. See `./connect.ts` for the Mode A flow.
//
// Code below is preserved for:
//   1. A future per-agency Mode B opt-in (with money-transmitter review attached)
//   2. The FDT broker-invoicing Pattern E (which uses similar Stripe primitives
//      but operates on FDT's own account, not on behalf of agencies)
//
// Calling these today against the live platform account WILL 400 at Stripe —
// the account is `type: standard`, not a Connect platform. Don't wire UI to
// these unless Connect-as-platform has been enabled in the dashboard AND the
// agency has opted into Mode B.
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
// Webhook event router → Apps Script bridge
// ---------------------------------------------------------------------------
//
// Every supported event normalizes to a single bridge payload and forwards via
// `callAppsScript(..., 'payments_webhook_event', ...)`. Apps Script de-dupes
// on event_id and dispatches downstream Sheet writes per event_type.
//
// The list of "supported" events is exactly the 19 we subscribe the live
// webhook endpoint to (PAYMENTS.md §7.1). Unknown event_types are still
// forwarded so Apps Script can record them in Stripe_Events for forensics —
// we never throw on an unrecognized type, because Stripe occasionally adds
// new ones and we'd rather keep the 200 flowing than block retries.

export interface WebhookHandlerResult {
  ok: true;
  action: string;
  apps_script?: unknown;
}

// Events we explicitly subscribe to. Kept here for /health to surface the
// count and for callers (tests, the Worker entry) to reason about coverage.
export const SUBSCRIBED_EVENTS: readonly string[] = [
  "checkout.session.completed",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "account.updated",
  "account.application.deauthorized",
  "payout.paid",
  "payout.failed",
  "transfer.created",
  "transfer.reversed",
  "transfer.canceled",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "radar.early_fraud_warning.created",
] as const;

const PAYLOAD_EXCERPT_MAX = 3000;

function fmtUsd(cents: number | undefined, currency: string | undefined): string {
  if (typeof cents !== "number" || Number.isNaN(cents)) return "—";
  const amt = (cents / 100).toFixed(2);
  const cur = (currency ?? "usd").toUpperCase();
  return `$${amt} ${cur}`;
}

function strMetadata(obj: unknown): Record<string, string> {
  const meta = (obj as { metadata?: Record<string, unknown> } | null | undefined)?.metadata;
  if (!meta || typeof meta !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    out[k] = String(v);
  }
  return out;
}

function safeExcerpt(obj: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(obj);
  } catch {
    return "";
  }
  if (json.length <= PAYLOAD_EXCERPT_MAX) return json;
  return json.slice(0, PAYLOAD_EXCERPT_MAX) + "…[truncated]";
}

interface NormalizedEvent {
  object_id: string;
  object_type: string;
  summary: string;
}

function normalize(event: StripeWebhookEvent): NormalizedEvent {
  const o = event.data.object as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const objectType = typeof o.object === "string" ? o.object : "";

  switch (event.type) {
    case "checkout.session.completed": {
      const mode = String(o.mode ?? "payment");
      const amount = Number(o.amount_total ?? 0);
      const currency = String(o.currency ?? "usd");
      return {
        object_id: id,
        object_type: objectType || "checkout.session",
        summary: `Checkout completed (${mode}) — ${fmtUsd(amount, currency)}`,
      };
    }
    case "payment_intent.succeeded": {
      const amount = Number(o.amount_received ?? o.amount ?? 0);
      const currency = String(o.currency ?? "usd");
      return {
        object_id: id,
        object_type: objectType || "payment_intent",
        summary: `PaymentIntent succeeded — ${fmtUsd(amount, currency)}`,
      };
    }
    case "payment_intent.payment_failed": {
      const lpe = (o.last_payment_error as { message?: string } | undefined)?.message ?? "unknown";
      return {
        object_id: id,
        object_type: objectType || "payment_intent",
        summary: `PaymentIntent failed — ${lpe}`,
      };
    }
    case "charge.refunded": {
      const amount = Number(o.amount_refunded ?? 0);
      const currency = String(o.currency ?? "usd");
      return {
        object_id: id,
        object_type: objectType || "charge",
        summary: `Charge refunded — ${fmtUsd(amount, currency)}`,
      };
    }
    case "charge.dispute.created": {
      const amount = Number(o.amount ?? 0);
      const currency = String(o.currency ?? "usd");
      const reason = String(o.reason ?? "unknown");
      return {
        object_id: id,
        object_type: objectType || "dispute",
        summary: `Dispute opened (${reason}) — ${fmtUsd(amount, currency)}`,
      };
    }
    case "charge.dispute.closed": {
      const status = String(o.status ?? "closed");
      return {
        object_id: id,
        object_type: objectType || "dispute",
        summary: `Dispute closed — ${status}`,
      };
    }
    case "account.updated": {
      const detailsSubmitted = Boolean(o.details_submitted);
      const payoutsEnabled = Boolean(o.payouts_enabled);
      const chargesEnabled = Boolean(o.charges_enabled);
      return {
        object_id: id,
        object_type: objectType || "account",
        summary: `Account updated — details_submitted=${detailsSubmitted} charges_enabled=${chargesEnabled} payouts_enabled=${payoutsEnabled}`,
      };
    }
    case "account.application.deauthorized": {
      return {
        object_id: id,
        object_type: objectType || "account",
        summary: `Connect application deauthorized`,
      };
    }
    case "payout.paid": {
      const amount = Number(o.amount ?? 0);
      const currency = String(o.currency ?? "usd");
      return {
        object_id: id,
        object_type: objectType || "payout",
        summary: `Payout paid — ${fmtUsd(amount, currency)}`,
      };
    }
    case "payout.failed": {
      const amount = Number(o.amount ?? 0);
      const currency = String(o.currency ?? "usd");
      const code = String(o.failure_code ?? "unknown");
      return {
        object_id: id,
        object_type: objectType || "payout",
        summary: `Payout failed (${code}) — ${fmtUsd(amount, currency)}`,
      };
    }
    case "transfer.created": {
      const amount = Number(o.amount ?? 0);
      const currency = String(o.currency ?? "usd");
      return {
        object_id: id,
        object_type: objectType || "transfer",
        summary: `Transfer created — ${fmtUsd(amount, currency)}`,
      };
    }
    case "transfer.reversed": {
      const amount = Number(o.amount_reversed ?? o.amount ?? 0);
      const currency = String(o.currency ?? "usd");
      return {
        object_id: id,
        object_type: objectType || "transfer",
        summary: `Transfer reversed — ${fmtUsd(amount, currency)}`,
      };
    }
    case "transfer.canceled": {
      return {
        object_id: id,
        object_type: objectType || "transfer",
        summary: `Transfer canceled`,
      };
    }
    case "invoice.paid": {
      const amount = Number(o.amount_paid ?? o.total ?? 0);
      const currency = String(o.currency ?? "usd");
      return {
        object_id: id,
        object_type: objectType || "invoice",
        summary: `Invoice paid — ${fmtUsd(amount, currency)}`,
      };
    }
    case "invoice.payment_failed": {
      const amount = Number(o.amount_due ?? o.total ?? 0);
      const currency = String(o.currency ?? "usd");
      const attempt = Number(o.attempt_count ?? 0);
      return {
        object_id: id,
        object_type: objectType || "invoice",
        summary: `Invoice payment failed (attempt ${attempt}) — ${fmtUsd(amount, currency)}`,
      };
    }
    case "customer.subscription.created": {
      const status = String(o.status ?? "unknown");
      return {
        object_id: id,
        object_type: objectType || "subscription",
        summary: `Subscription created — ${status}`,
      };
    }
    case "customer.subscription.updated": {
      const status = String(o.status ?? "unknown");
      const cancelAtPeriodEnd = Boolean(o.cancel_at_period_end);
      return {
        object_id: id,
        object_type: objectType || "subscription",
        summary: `Subscription updated — status=${status}${cancelAtPeriodEnd ? " (cancel_at_period_end)" : ""}`,
      };
    }
    case "customer.subscription.deleted": {
      return {
        object_id: id,
        object_type: objectType || "subscription",
        summary: `Subscription deleted`,
      };
    }
    case "radar.early_fraud_warning.created": {
      const actionable = Boolean(o.actionable);
      const reason = String(o.fraud_type ?? "unknown");
      return {
        object_id: id,
        object_type: objectType || "radar.early_fraud_warning",
        summary: `Early fraud warning (${reason})${actionable ? " — actionable" : ""}`,
      };
    }
    default: {
      return {
        object_id: id,
        object_type: objectType || "unknown",
        summary: `Unhandled event type ${event.type}`,
      };
    }
  }
}

/**
 * Forward a verified Stripe webhook event to Apps Script. Never throws on
 * a known-bad event shape — returns `{ ok: true, action: <event_type> }` so
 * the caller can 200 Stripe even when there's nothing more to do. The caller
 * is expected to handle network/throw from `callAppsScript` by returning 500.
 */
export async function handleWebhookEvent(
  env: StripeEnv,
  event: StripeWebhookEvent
): Promise<WebhookHandlerResult> {
  const norm = normalize(event);
  const metadata = strMetadata(event.data.object);

  // High-priority alerts. We don't have Slack wired yet, so console.error is
  // the cheapest way to surface in `wrangler tail`. Worker logs are retained
  // by Cloudflare for 24h on the free plan; that's enough for Anthony to
  // spot a dispute the same day.
  if (event.type === "charge.dispute.created") {
    console.error("STRIPE DISPUTE", {
      event_id: event.id,
      object_id: norm.object_id,
      summary: norm.summary,
      metadata,
    });
  }
  if (event.type === "radar.early_fraud_warning.created") {
    console.error("STRIPE EARLY FRAUD WARNING", {
      event_id: event.id,
      object_id: norm.object_id,
      summary: norm.summary,
      metadata,
    });
  }

  // account.updated carries Connect-onboarding state we want to forward in
  // first-class form so Apps Script doesn't have to re-parse the payload.
  const extra: Record<string, string> = {};
  if (event.type === "account.updated") {
    const o = event.data.object as {
      details_submitted?: boolean;
      payouts_enabled?: boolean;
      charges_enabled?: boolean;
      requirements?: { currently_due?: string[] };
    };
    extra.details_submitted = String(Boolean(o.details_submitted));
    extra.payouts_enabled = String(Boolean(o.payouts_enabled));
    extra.charges_enabled = String(Boolean(o.charges_enabled));
    const due = o.requirements?.currently_due;
    if (Array.isArray(due)) extra.requirements_currently_due = JSON.stringify(due);
  }

  const params: Record<string, string> = {
    event_id: event.id,
    event_type: event.type,
    livemode: String(Boolean(event.livemode)),
    created: String(event.created ?? Math.floor(Date.now() / 1000)),
    object_id: norm.object_id,
    object_type: norm.object_type,
    metadata: JSON.stringify(metadata),
    summary: norm.summary,
    payload_excerpt: safeExcerpt(event.data.object),
    ...extra,
  };

  const result = await callAppsScript(
    env.APPS_SCRIPT_URL,
    env.JWT_SECRET,
    "payments_webhook_event",
    params,
    { purpose: "stripe_webhook" }
  );

  return { ok: true, action: event.type, apps_script: result };
}
