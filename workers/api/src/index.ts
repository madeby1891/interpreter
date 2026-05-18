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
} from "./stripe";
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
  TRACK1099_API_KEY?: string;
  TRACK1099_BASE?: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  // Twilio (SMS) — set with `wrangler secret put`.
  // Missing keys → /v1/sms/send returns { ok:false, configured:false }.
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
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

  // Health.
  if (url.pathname === "/" || url.pathname === "/health") {
    return withCors(json({ ok: true, service: "1891-interpreter-api" }), req, cfg);
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

  // Stripe webhook — verified by signature, NOT by internal header.
  // Cloudflare will deliver the raw body; signature is over t + raw body.
  if (url.pathname === "/v1/stripe/webhook" && req.method === "POST") {
    return handleStripeWebhook(req, env);
  }

  // Internal Stripe routes (Apps Script → Worker), gated by X-1891-Internal.
  if (url.pathname.startsWith("/v1/stripe/") && req.method === "POST") {
    return withCors(await handleStripeInternal(req, env, url.pathname), req, cfg);
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

async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json(
      { ok: false, error: "STRIPE_WEBHOOK_SECRET not set. Configure via `wrangler secret put STRIPE_WEBHOOK_SECRET`." },
      { status: 503 }
    );
  }
  const rawBody = await req.text();
  const sig = req.headers.get("Stripe-Signature");
  const v = await verifyWebhookSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!v.ok || !v.event) {
    return json({ ok: false, error: `webhook signature: ${v.reason ?? "unknown"}` }, { status: 400 });
  }
  const result = await handleWebhookEvent(env, v.event);
  return json({ received: true, ...result });
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
  // Server-to-server auth: we accept either an `X-1891-Secret` header equal to
  // JWT_SECRET (simplest; the Apps Script already knows this value), or a
  // bearer JWT signed with the same secret. Either is fine for v1 — both rely
  // on the same shared secret. The header form avoids minting a token per hop.
  const header = req.headers.get("X-1891-Secret");
  let authorized = false;
  if (header && header === env.JWT_SECRET) {
    authorized = true;
  } else {
    const auth = req.headers.get("Authorization") ?? "";
    if (auth.startsWith("Bearer ")) {
      const payload = await verifyToken(auth.slice(7), env.JWT_SECRET);
      if (payload) authorized = true;
    }
  }
  if (!authorized) return json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { tenant_id?: string; event?: string; data?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const tenantId = body.tenant_id;
  if (!tenantId) return json({ ok: false, error: "missing tenant_id" }, { status: 400 });

  const id = env.JOB_BOARD_ROOM.idFromName(`tenant:${tenantId}`);
  const stub = env.JOB_BOARD_ROOM.get(id);
  const fwd = await stub.fetch("https://room/broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: body.event ?? "job", data: body.data ?? body }),
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
