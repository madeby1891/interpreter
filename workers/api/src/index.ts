// 1891 Interpreter — workers/api
//
// Two responsibilities for v1:
//   1. CORS proxy for the Apps Script web app at /v1/proxy/* and /interpreter-api/*
//   2. Live job board fan-out at /v1/jobs/stream (SSE) and /v1/jobs/ws (WebSocket)
//      driven by a per-tenant `JobBoardRoom` Durable Object.
//
// The Apps Script web app POSTs to /v1/notify/job to publish an event; we
// authenticate that hop with the shared JWT_SECRET via a static header.
//
// Everything else returns 404. Keep the surface small until we need more.

import { handlePreflight, withCors, type CorsConfig } from "./cors";
import { proxyToAppsScript } from "./proxy";
import { verifyToken } from "./jwt";
import { JobBoardRoom } from "./durable/JobBoardRoom";
import { routeTranslate } from "./translate";
import { routePhi } from "./phi";
import { verifyInternalHeader } from "./internal";
import { handleSmsSend, handleSmsInbound } from "./sms";
import {
  createConnectAccount,
  createAccountLink,
  fetchAccount,
  createTransfer,
  findOrCreateCustomer,
  createAndSendInvoice,
  verifyWebhookSignature,
  handleWebhookEvent,
  isConfigured as stripeConfigured,
  isTestMode as stripeTestMode,
  unconfigured as stripeUnconfigured,
  SUBSCRIBED_EVENTS,
} from "./stripe";
import {
  createSubscriptionCheckoutSession,
  isTier,
  isBilling,
  type Tier,
  type Billing,
} from "./billing";
import {
  buildOAuthStartUrl,
  exchangeOAuthCode,
  fetchAgencyReport,
  CONNECT_REDIRECT_URI,
} from "./connect";
import {
  createNec1099,
  getForm as get1099Form,
  isConfigured as track1099Configured,
  unconfigured as track1099Unconfigured,
} from "./track1099";

export { JobBoardRoom };

export interface Env {
  APPS_SCRIPT_URL: string;
  ALLOWED_ORIGIN: string;
  JWT_SECRET: string;
  JOB_BOARD_ROOM: DurableObjectNamespace;
  // Translation Worker secrets — set with `wrangler secret put`.
  // Either may be absent; if both are absent, /v1/translate/prefill returns 502.
  DEEPL_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  // Payment-gateway secrets — set with `wrangler secret put`.
  // Any missing key causes the corresponding /v1/stripe/* or /v1/track1099/*
  // route to return { ok:false, status:'unconfigured' } rather than 500.
  STRIPE_API_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  // Pattern G — Stripe Connect OAuth read-only reporting. Until Anthony
  // enables Connect-as-platform at dashboard.stripe.com/settings/connect AND
  // copies the ca_… client_id into `wrangler secret put STRIPE_CONNECT_CLIENT_ID`,
  // /v1/connect/* routes return { ok:false, status:'unconfigured' }.
  STRIPE_CONNECT_CLIENT_ID?: string;
  TRACK1099_API_KEY?: string;
  TRACK1099_BASE?: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  // Twilio (SMS) — set with `wrangler secret put`.
  // Missing keys → /v1/sms/send returns { ok:false, configured:false }.
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
  // PHI column-level encryption — set with `wrangler secret put PHI_MASTER_KEY`.
  // Must be ≥32 random bytes, base64url-encoded. Never set in wrangler.toml.
  PHI_MASTER_KEY?: string;
  // Stripe webhook idempotency log (PAYMENTS.md §7.2). Optional so a Worker
  // can boot without the binding — we emit a one-time warning and proceed.
  // Bind via wrangler.toml's [[kv_namespaces]] block (binding = "IDEMPOTENCY").
  IDEMPOTENCY?: KVNamespace;
}

function corsConfig(env: Env): CorsConfig {
  return { allowedOrigin: env.ALLOWED_ORIGIN };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

async function handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  void ctx;
  const url = new URL(req.url);
  const cfg = corsConfig(env);

  if (req.method === "OPTIONS") return handlePreflight(req, cfg);

  // Health. Reports stripe_mode so the public /pay/* pages can render a
  // TEST MODE banner when the worker is wired to a `sk_test_*` key.
  if (url.pathname === "/" || url.pathname === "/health") {
    const stripeMode = !stripeConfigured(env)
      ? "unconfigured"
      : stripeTestMode(env)
        ? "test"
        : "live";
    return withCors(
      json({
        ok: true,
        service: "1891-interpreter-api",
        stripe_mode: stripeMode,
        webhook_events: SUBSCRIBED_EVENTS.length, // AGENT_B_ADDED: count of Stripe events subscribed
      }),
      req,
      cfg
    );
  }

  // CORS proxy — strip the prefix and forward.
  if (
    url.pathname.startsWith("/v1/proxy") ||
    url.pathname.startsWith("/interpreter-api")
  ) {
    const proxied = await proxyToAppsScript(req, { appsScriptUrl: env.APPS_SCRIPT_URL });
    return withCors(proxied, req, cfg);
  }

  // Live job board — SSE subscribe.
  if (url.pathname === "/v1/jobs/stream") {
    return handleSubscribe(req, env, "sse");
  }

  // Live job board — WebSocket subscribe.
  if (url.pathname === "/v1/jobs/ws") {
    return handleSubscribe(req, env, "ws");
  }

  // Apps Script → Worker server-to-server notify hook.
  if (url.pathname === "/v1/notify/job" && req.method === "POST") {
    return handleNotify(req, env);
  }

  // Document translation routes (PRD A4 §workers/translate).
  if (url.pathname.startsWith("/v1/translate/")) {
    const r = await routeTranslate(req, env);
    if (r) return withCors(r, req, cfg);
  }

  // PHI column-level encryption (internal, X-1891-Internal-gated).
  if (url.pathname.startsWith("/v1/phi/")) {
    const r = await routePhi(req, env);
    if (r) return withCors(r, req, cfg);
  }

  // Stripe webhook — verified by signature, NOT by internal header.
  // Cloudflare will deliver the raw body; signature is over t + raw body.
  if (url.pathname === "/v1/stripe/webhook" && req.method === "POST") {
    return handleStripeWebhook(req, env);
  }

  // Internal Stripe routes (Apps Script → Worker), gated by X-1891-Internal.
  if (url.pathname.startsWith("/v1/stripe/") && req.method === "POST") {
    return withCors(await handleStripeInternal(req, env, url.pathname), req, cfg);
  }

  // Subscription Checkout — internal (Apps Script → Worker, gated by X-1891-Internal).
  if (url.pathname === "/v1/billing/checkout" && req.method === "POST") {
    return withCors(await handleBillingCheckoutInternal(req, env), req, cfg);
  }

  // PUBLIC ROUTE — rate-limited, no auth.
  // The marketing site (pricing.html → /pay/subscribe) posts here unauthenticated
  // to start a Stripe Checkout. Rate-limited per IP because there is no signed-in
  // user yet. Body is strictly limited to safe params (tier, billing, email,
  // optional agency_name) — no IDs, no amounts, no metadata pass-through.
  if (url.pathname === "/v1/public/billing/checkout" && req.method === "POST") {
    return withCors(await handlePublicBillingCheckout(req, env), req, cfg);
  }

  // Pattern G — Stripe Connect OAuth read-only reporting.
  // Internal routes: Apps Script → Worker, gated by X-1891-Internal.
  if (url.pathname === "/v1/connect/oauth/start" && req.method === "POST") {
    return withCors(await handleConnectOAuthStart(req, env), req, cfg);
  }
  if (url.pathname === "/v1/connect/oauth/callback" && req.method === "POST") {
    return withCors(await handleConnectOAuthCallback(req, env), req, cfg);
  }
  if (url.pathname === "/v1/connect/report" && req.method === "POST") {
    return withCors(await handleConnectReport(req, env), req, cfg);
  }

  // Internal track1099 routes (Apps Script → Worker).
  if (url.pathname.startsWith("/v1/track1099/")) {
    return withCors(await handleTrack1099(req, env, url.pathname), req, cfg);
  }

  // SMS: outbound send (Apps Script → Worker), inbound webhook (Twilio → Worker).
  if (url.pathname === "/v1/sms/send" && req.method === "POST") {
    return withCors(await handleSmsSend(req, env), req, cfg);
  }
  if (url.pathname === "/v1/sms/inbound" && req.method === "POST") {
    return handleSmsInbound(req, env);
  }

  return withCors(json({ ok: false, error: "not found" }, { status: 404 }), req, cfg);
}

// ---------------------------------------------------------------------------
// Stripe webhook receiver
// ---------------------------------------------------------------------------

// Flag we flip the first time we observe a missing IDEMPOTENCY binding, so we
// don't spam logs on every webhook. Module-scoped — a fresh isolate resets it,
// which is fine: we'll re-warn once per isolate boot.
let warnedMissingIdempotency = false;

async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json(
      { ok: false, error: "STRIPE_WEBHOOK_SECRET not set. Configure via `wrangler secret put STRIPE_WEBHOOK_SECRET`." },
      { status: 503 }
    );
  }

  // Read raw bytes BEFORE any JSON parsing — signature is over the raw body.
  const rawBody = await req.text();
  const sig = req.headers.get("Stripe-Signature");
  const v = await verifyWebhookSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!v.ok || !v.event) {
    return json({ ok: false, error: `webhook signature: ${v.reason ?? "unknown"}` }, { status: 400 });
  }
  const event = v.event;

  // Idempotency: if we've already processed this event.id, return 200 "seen"
  // without re-forwarding. KV is optional; if the binding is missing, log
  // once per isolate and proceed (Apps Script also de-dupes on event_id).
  const kv = env.IDEMPOTENCY;
  if (kv) {
    try {
      const seen = await kv.get(event.id);
      if (seen) return json({ received: true, idempotent: true, action: event.type });
    } catch (err) {
      console.error("IDEMPOTENCY KV get failed", event.id, String(err));
      // Fall through — better to risk a dup than to drop the event.
    }
  } else if (!warnedMissingIdempotency) {
    warnedMissingIdempotency = true;
    console.warn(
      "IDEMPOTENCY KV binding is missing. Stripe webhook retries will be re-forwarded to Apps Script. " +
        "Create with `npx wrangler kv namespace create 1891-interpreter-idempotency` and add the id to wrangler.toml."
    );
  }

  // Process. Throws here flow up to the catch in default.fetch which returns
  // 500 — that's what we want for Stripe retries (PAYMENTS.md §7.2 step 4).
  try {
    const result = await handleWebhookEvent(env, event);
    // Record success AFTER forwarding so a thrown call to Apps Script
    // doesn't silently swallow the retry path.
    if (kv) {
      try {
        await kv.put(event.id, "1", { expirationTtl: 60 * 60 * 24 * 7 });
      } catch (err) {
        console.error("IDEMPOTENCY KV put failed", event.id, String(err));
      }
    }
    return json({ received: true, ...result });
  } catch (err) {
    console.error("webhook handler failed", event.id, event.type, String(err));
    return json(
      { ok: false, error: "webhook_handler_failed", event_id: event.id, detail: String(err) },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// Stripe internal routes (Apps Script → Worker)
// ---------------------------------------------------------------------------

async function handleStripeInternal(req: Request, env: Env, pathname: string): Promise<Response> {
  const auth = verifyInternalHeader(req, env.JWT_SECRET);
  if (!auth.authorized) return json({ ok: false, error: auth.error ?? "unauthorized" }, { status: 401 });
  if (!stripeConfigured(env)) return json(stripeUnconfigured(), { status: 200 });

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Allow empty body for GET-like POSTs.
  }

  switch (pathname) {
    case "/v1/stripe/account/create": {
      const interpreterId = String(body.interpreter_id ?? "");
      if (!interpreterId) return json({ ok: false, error: "interpreter_id required" }, { status: 400 });
      const account = await createConnectAccount(env, {
        interpreter_id: interpreterId,
        email: body.email ? String(body.email) : undefined,
        country: body.country ? String(body.country) : "US",
      });
      return json({ ok: !(account as { ok?: false }).ok ? true : false, test_mode: stripeTestMode(env), account });
    }
    case "/v1/stripe/account/onboard": {
      const accountId = String(body.account_id ?? "");
      const returnUrl = String(body.return_url ?? "");
      const refreshUrl = String(body.refresh_url ?? "");
      if (!accountId || !returnUrl || !refreshUrl) {
        return json({ ok: false, error: "account_id, return_url, refresh_url required" }, { status: 400 });
      }
      const link = await createAccountLink(env, {
        account: accountId,
        return_url: returnUrl,
        refresh_url: refreshUrl,
      });
      return json({ ok: !(link as { ok?: false }).ok ? true : false, link });
    }
    case "/v1/stripe/account/refresh": {
      const accountId = String(body.account_id ?? "");
      if (!accountId) return json({ ok: false, error: "account_id required" }, { status: 400 });
      const account = await fetchAccount(env, accountId);
      return json({ ok: !(account as { ok?: false }).ok ? true : false, account });
    }
    case "/v1/stripe/transfer/send": {
      const amount = Number(body.amount_cents ?? 0);
      const destination = String(body.destination_account ?? "");
      const payoutId = String(body.payout_id ?? "");
      if (!amount || !destination || !payoutId) {
        return json({ ok: false, error: "amount_cents, destination_account, payout_id required" }, { status: 400 });
      }
      const transfer = await createTransfer(env, {
        amount_cents: amount,
        destination_account: destination,
        payout_id: payoutId,
      });
      return json({ ok: !(transfer as { ok?: false }).ok ? true : false, transfer });
    }
    case "/v1/stripe/invoice/send": {
      const ourInvoiceId = String(body.invoice_id ?? "");
      const payerId = String(body.payer_id ?? "");
      const lineItemsRaw = body.line_items;
      if (!ourInvoiceId || !payerId || !Array.isArray(lineItemsRaw) || !lineItemsRaw.length) {
        return json({ ok: false, error: "invoice_id, payer_id, line_items required" }, { status: 400 });
      }
      const customer = await findOrCreateCustomer(env, {
        existing_id: body.stripe_customer_id ? String(body.stripe_customer_id) : undefined,
        payer_id: payerId,
        email: body.payer_email ? String(body.payer_email) : undefined,
        name: body.payer_name ? String(body.payer_name) : undefined,
      });
      if ((customer as { ok?: false }).ok === false) {
        return json({ ok: false, customer });
      }
      const lineItems = (lineItemsRaw as Array<Record<string, unknown>>).map((ln) => ({
        description: String(ln.description ?? "—"),
        amount_cents: Number(ln.amount_cents ?? 0),
        quantity: Number(ln.quantity ?? 1),
      }));
      const invoice = await createAndSendInvoice(env, {
        customer: (customer as { id: string }).id,
        invoice_id: ourInvoiceId,
        line_items: lineItems,
        days_until_due: body.days_until_due ? Number(body.days_until_due) : 30,
      });
      return json({
        ok: !(invoice as { ok?: false }).ok ? true : false,
        customer_id: (customer as { id: string }).id,
        invoice,
      });
    }
    default:
      return json({ ok: false, error: "unknown stripe internal route" }, { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// Subscription Checkout (SaaS billing for the pricing page)
// ---------------------------------------------------------------------------

interface BillingCheckoutBody {
  tier?: unknown;
  billing?: unknown;
  customer_email?: unknown;
  agency_name?: unknown;
}

async function parseBillingCheckoutBody(req: Request): Promise<
  | { ok: true; tier: Tier; billing: Billing; customer_email: string; agency_name?: string }
  | { ok: false; error: string }
> {
  let body: BillingCheckoutBody = {};
  try {
    body = (await req.json()) as BillingCheckoutBody;
  } catch {
    return { ok: false, error: "bad json" };
  }
  const tier = body.tier;
  const billing = body.billing;
  const email = String(body.customer_email ?? "").trim();
  if (!isTier(tier)) return { ok: false, error: "tier must be solo|practice|studio" };
  if (!isBilling(billing)) return { ok: false, error: "billing must be monthly|annual" };
  if (!email || !email.includes("@") || email.length > 200) {
    return { ok: false, error: "valid customer_email required" };
  }
  const agency = body.agency_name ? String(body.agency_name).slice(0, 200) : undefined;
  return { ok: true, tier, billing, customer_email: email, agency_name: agency };
}

async function runBillingCheckout(
  env: Env,
  parsed: { tier: Tier; billing: Billing; customer_email: string; agency_name?: string }
): Promise<Response> {
  if (!stripeConfigured(env)) {
    // Match the stripeUnconfigured() contract — 200 with ok:false so the
    // calling page can distinguish "not wired up yet" from a real error.
    return json(stripeUnconfigured(), { status: 200 });
  }
  const session = await createSubscriptionCheckoutSession(env, {
    tier: parsed.tier,
    billing: parsed.billing,
    customer_email: parsed.customer_email,
    agency_name: parsed.agency_name,
  });
  if ((session as { ok?: false }).ok === false) {
    return json({ ok: false, error: (session as { error: string }).error }, { status: 502 });
  }
  const s = session as { id: string; url: string };
  return json({
    ok: true,
    url: s.url,
    session_id: s.id,
    test_mode: stripeTestMode(env),
  });
}

async function handleBillingCheckoutInternal(req: Request, env: Env): Promise<Response> {
  const auth = verifyInternalHeader(req, env.JWT_SECRET);
  if (!auth.authorized) {
    return json({ ok: false, error: auth.error ?? "unauthorized" }, { status: 401 });
  }
  const parsed = await parseBillingCheckoutBody(req);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, { status: 400 });
  return runBillingCheckout(env, parsed);
}

// --- public route rate-limit ------------------------------------------------
// Per-IP, in-memory token bucket. Resets when the Worker isolate cycles.
// Generous limit (10 checkouts / 5 min / IP) because legitimate retries do
// happen (typo email → corrected email), and the idempotency-key bucket in
// billing.ts already coalesces duplicate clicks server-side.
//
// In-memory is intentional: an attacker that hops isolates gets a small reset,
// but the worst they can do is open Checkout Sessions (no charge until Stripe
// collects card data). The Sheet/PHI never gets touched on this path.
const PUBLIC_RATE_LIMIT = { max: 10, windowMs: 5 * 60 * 1000 };
const publicRateBuckets = new Map<string, { count: number; resetAt: number }>();

function publicRateLimitOk(ip: string, now: number = Date.now()): boolean {
  const bucket = publicRateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    publicRateBuckets.set(ip, { count: 1, resetAt: now + PUBLIC_RATE_LIMIT.windowMs });
    return true;
  }
  if (bucket.count >= PUBLIC_RATE_LIMIT.max) return false;
  bucket.count++;
  return true;
}

async function handlePublicBillingCheckout(req: Request, env: Env): Promise<Response> {
  // Cloudflare sets CF-Connecting-IP; fall back to the first X-Forwarded-For
  // entry if absent (test harness, local wrangler). Empty string = treat as
  // a single shared bucket so misconfigured callers don't get unlimited burst.
  const ip =
    req.headers.get("CF-Connecting-IP") ||
    (req.headers.get("X-Forwarded-For") || "").split(",")[0]?.trim() ||
    "unknown";
  if (!publicRateLimitOk(ip)) {
    return json(
      { ok: false, error: "Too many checkout attempts. Try again in a few minutes." },
      { status: 429 }
    );
  }
  const parsed = await parseBillingCheckoutBody(req);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, { status: 400 });
  return runBillingCheckout(env, parsed);
}

// ---------------------------------------------------------------------------
// Connect OAuth (Pattern G — Mode A canonical) — internal routes
//
// Apps Script calls these on behalf of an admin user who clicked
// "Connect your Stripe" in the in-app Payments tab. Until
// STRIPE_CONNECT_CLIENT_ID is set as a worker secret, these return
// `{ ok:false, status:'unconfigured' }` — see docs/PAYMENTS_IMPL.md §1.5.
// ---------------------------------------------------------------------------

async function handleConnectOAuthStart(req: Request, env: Env): Promise<Response> {
  const auth = verifyInternalHeader(req, env.JWT_SECRET);
  if (!auth.authorized) return json({ ok: false, error: auth.error ?? "unauthorized" }, { status: 401 });
  let body: { tenant_id?: string; email?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const result = await buildOAuthStartUrl(env, {
    tenant_id: String(body.tenant_id ?? ""),
    email: String(body.email ?? ""),
  });
  return json(result, { status: 200 });
}

async function handleConnectOAuthCallback(req: Request, env: Env): Promise<Response> {
  const auth = verifyInternalHeader(req, env.JWT_SECRET);
  if (!auth.authorized) return json({ ok: false, error: auth.error ?? "unauthorized" }, { status: 401 });
  let body: { code?: string; state?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "bad json" }, { status: 400 });
  }
  if (!body.code || !body.state) {
    return json({ ok: false, error: "code + state required" }, { status: 400 });
  }
  const result = await exchangeOAuthCode(env, { code: body.code, state: body.state });
  return json(result, { status: 200 });
}

async function handleConnectReport(req: Request, env: Env): Promise<Response> {
  const auth = verifyInternalHeader(req, env.JWT_SECRET);
  if (!auth.authorized) return json({ ok: false, error: auth.error ?? "unauthorized" }, { status: 401 });
  let body: { stripe_user_id?: string; limit?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "bad json" }, { status: 400 });
  }
  if (!body.stripe_user_id || !/^acct_/.test(body.stripe_user_id)) {
    return json({ ok: false, error: "stripe_user_id (acct_…) required" }, { status: 400 });
  }
  const result = await fetchAgencyReport(env, {
    stripe_user_id: body.stripe_user_id,
    limit: body.limit,
  });
  return json(result, { status: 200 });
}

// Silence unused-import linter — CONNECT_REDIRECT_URI is exported for docs
// and for any future site-side preflight check.
void CONNECT_REDIRECT_URI;

// ---------------------------------------------------------------------------
// track1099 internal routes
// ---------------------------------------------------------------------------

async function handleTrack1099(req: Request, env: Env, pathname: string): Promise<Response> {
  const auth = verifyInternalHeader(req, env.JWT_SECRET);
  if (!auth.authorized) return json({ ok: false, error: auth.error ?? "unauthorized" }, { status: 401 });
  if (!track1099Configured(env)) return json(track1099Unconfigured(), { status: 200 });

  if (pathname === "/v1/track1099/forms/create" && req.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: "bad json" }, { status: 400 });
    }
    const recipient = body.recipient as Record<string, unknown> | undefined;
    if (!recipient) return json({ ok: false, error: "recipient required" }, { status: 400 });
    const form = await createNec1099(env, {
      tax_year: Number(body.tax_year ?? new Date().getUTCFullYear() - 1),
      payer_id_in_track1099: body.payer_id_in_track1099 ? String(body.payer_id_in_track1099) : undefined,
      recipient: {
        name: String(recipient.name ?? ""),
        tin: String(recipient.tin ?? ""),
        tin_type: (recipient.tin_type as "SSN" | "EIN") ?? "SSN",
        email: recipient.email ? String(recipient.email) : undefined,
        address1: String(recipient.address1 ?? ""),
        address2: recipient.address2 ? String(recipient.address2) : undefined,
        city: String(recipient.city ?? ""),
        state: String(recipient.state ?? ""),
        zip: String(recipient.zip ?? ""),
        country: recipient.country ? String(recipient.country) : "US",
      },
      nonemployee_comp_cents: Number(body.nonemployee_comp_cents ?? 0),
      federal_income_tax_withheld_cents: body.federal_income_tax_withheld_cents
        ? Number(body.federal_income_tax_withheld_cents)
        : 0,
      interpreter_id: String(body.interpreter_id ?? ""),
      tenant_id: String(body.tenant_id ?? ""),
    });
    return json({ ok: !(form as { ok?: false }).ok ? true : false, form });
  }

  // GET /v1/track1099/forms/:id
  if (req.method === "GET" && pathname.startsWith("/v1/track1099/forms/")) {
    const formId = pathname.slice("/v1/track1099/forms/".length);
    if (!formId) return json({ ok: false, error: "form id required" }, { status: 400 });
    const form = await get1099Form(env, formId);
    return json({ ok: !(form as { ok?: false }).ok ? true : false, form });
  }

  return json({ ok: false, error: "unknown track1099 route" }, { status: 404 });
}

async function handleSubscribe(
  req: Request,
  env: Env,
  kind: "sse" | "ws"
): Promise<Response> {
  const url = new URL(req.url);
  const session = url.searchParams.get("session");
  if (!session) {
    return json({ ok: false, error: "missing session" }, { status: 401 });
  }
  const payload = await verifyToken(session, env.JWT_SECRET);
  if (!payload) {
    return json({ ok: false, error: "invalid session" }, { status: 401 });
  }

  const id = env.JOB_BOARD_ROOM.idFromName(`tenant:${payload.tid}`);
  const stub = env.JOB_BOARD_ROOM.get(id);
  const sub = new URL(req.url);
  sub.pathname = kind === "sse" ? "/subscribe/sse" : "/subscribe/ws";
  sub.searchParams.set("_uid", payload.uid);

  const init: RequestInit = { method: "GET", headers: req.headers };
  return stub.fetch(sub.toString(), init);
}

async function handleNotify(req: Request, env: Env): Promise<Response> {
  // Server-to-server auth from Apps Script. Canonical path: `X-1891-Internal`
  // header equal to JWT_SECRET (this matches the rest of the internal API).
  // We also accept the legacy `X-1891-Secret` header and a `Bearer <jwt>` for
  // back-compat with earlier worker → AS callbacks; either path uses the same
  // shared secret. Constant-time compare via verifyInternalHeader.
  let authorized = false;
  const internal = verifyInternalHeader(req, env.JWT_SECRET);
  if (internal.authorized) {
    authorized = true;
  } else {
    const legacy = req.headers.get("X-1891-Secret");
    if (legacy && env.JWT_SECRET && legacy.length === env.JWT_SECRET.length) {
      // constant-time
      let diff = 0;
      for (let i = 0; i < legacy.length; i++) diff |= legacy.charCodeAt(i) ^ env.JWT_SECRET.charCodeAt(i);
      if (diff === 0) authorized = true;
    }
    if (!authorized) {
      const auth = req.headers.get("Authorization") ?? "";
      if (auth.startsWith("Bearer ")) {
        const payload = await verifyToken(auth.slice(7), env.JWT_SECRET);
        if (payload) authorized = true;
      }
    }
  }
  if (!authorized) return json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { tenant_id?: string; event?: string; job_id?: string; data?: unknown; [k: string]: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const tenantId = body.tenant_id;
  if (!tenantId) return json({ ok: false, error: "missing tenant_id" }, { status: 400 });

  // Tenant isolation: the DO id is derived from tenant_id. Subscribers attach
  // via handleSubscribe, which extracts tid from the verified JWT. A broadcast
  // sent here for tenant A can only land on the DO instance keyed `tenant:A`,
  // and only sockets that authenticated as tenant A are attached to that DO.
  // Two tenants can never observe each other's events.
  const id = env.JOB_BOARD_ROOM.idFromName(`tenant:${tenantId}`);
  const stub = env.JOB_BOARD_ROOM.get(id);
  // Echo the full payload (minus tenant_id) so the client gets every field the
  // Apps Script chose to include (job_id, status, assignment_id, …).
  const { tenant_id: _omit, event: ev, ...rest } = body;
  void _omit;
  const fwd = await stub.fetch("https://room/broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: ev ?? "job", data: rest }),
  });
  return new Response(fwd.body, { status: fwd.status, headers: fwd.headers });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handle(req, env, ctx);
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: "internal error", detail: String(err) }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
