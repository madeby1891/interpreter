// Unit tests for the Stripe module.
//
// These tests intentionally do NOT hit the live Stripe API. We mock fetch and
// exercise:
//   - the configured/unconfigured branch
//   - test-mode detection from key prefix
//   - Connect-account creation: payload shape + idempotency key
//   - AccountLink + fetchAccount
//   - Transfer.send
//   - Customer + Invoice send sequence (3 calls)
//   - webhook signature verification: happy path, bad sig, stale timestamp,
//     malformed header, missing header
//   - webhook event router: invoice.paid, transfer.paid, account.updated,
//     unhandled event type

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isConfigured,
  isTestMode,
  unconfigured,
  createConnectAccount,
  createAccountLink,
  fetchAccount,
  createTransfer,
  findOrCreateCustomer,
  createAndSendInvoice,
  verifyWebhookSignature,
  handleWebhookEvent,
  type StripeEnv,
} from "../src/stripe";

const ENV_OK: StripeEnv = {
  STRIPE_API_KEY: "sk_test_FAKE_KEY_FOR_TESTS_ONLY",
  STRIPE_WEBHOOK_SECRET: "whsec_test_FAKE",
  APPS_SCRIPT_URL: "https://example.test/exec",
  JWT_SECRET: "test-jwt-secret",
};

const ENV_UNSET: StripeEnv = {
  APPS_SCRIPT_URL: "https://example.test/exec",
  JWT_SECRET: "test-jwt-secret",
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("stripe — configuration", () => {
  it("isConfigured is true when STRIPE_API_KEY is set", () => {
    expect(isConfigured(ENV_OK)).toBe(true);
    expect(isConfigured(ENV_UNSET)).toBe(false);
  });

  it("isTestMode checks the sk_test_ prefix", () => {
    expect(isTestMode(ENV_OK)).toBe(true);
    expect(isTestMode({ ...ENV_OK, STRIPE_API_KEY: "sk_live_abc" })).toBe(false);
    expect(isTestMode(ENV_UNSET)).toBe(false);
  });

  it("unconfigured() returns the standard error shape", () => {
    const u = unconfigured();
    expect(u.ok).toBe(false);
    expect(u.status).toBe("unconfigured");
    expect(u.error).toContain("STRIPE_API_KEY");
  });

  it("API helpers return unconfigured when env is empty", async () => {
    const r = await createConnectAccount(ENV_UNSET, { interpreter_id: "int_1" });
    expect((r as { ok?: false }).ok).toBe(false);
    expect((r as { status?: string }).status).toBe("unconfigured");
  });
});

describe("stripe — Connect Express", () => {
  it("createConnectAccount sends type=express + idempotency key", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedInit = init;
      return new Response(JSON.stringify({
        id: "acct_TEST123",
        object: "account",
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const r = await createConnectAccount(ENV_OK, { interpreter_id: "int_42", email: "i@example.test" });
    expect(capturedUrl).toBe("https://api.stripe.com/v1/accounts");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk_test_FAKE_KEY_FOR_TESTS_ONLY");
    expect(headers["Idempotency-Key"]).toBe("acct_create_int_42");
    const body = String(capturedInit?.body ?? "");
    expect(body).toContain("type=express");
    expect(body).toContain("country=US");
    expect(body).toContain("capabilities%5Btransfers%5D%5Brequested%5D=true");
    expect(body).toContain("metadata%5Binterpreter_id%5D=int_42");
    expect((r as { id?: string }).id).toBe("acct_TEST123");
  });

  it("createAccountLink hits /account_links and forwards return/refresh URLs", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        object: "account_link",
        url: "https://connect.stripe.com/setup/c/abc",
        expires_at: 9999999999,
        created: 1700000000,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const r = await createAccountLink(ENV_OK, {
      account: "acct_X",
      return_url: "https://madeby1891.com/return",
      refresh_url: "https://madeby1891.com/refresh",
    });
    expect(capturedUrl).toBe("https://api.stripe.com/v1/account_links");
    expect(capturedBody).toContain("account=acct_X");
    expect(capturedBody).toContain("type=account_onboarding");
    expect((r as { url?: string }).url).toContain("connect.stripe.com");
  });

  it("fetchAccount GETs /accounts/:id and parses capabilities", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input.toString();
      expect(u).toBe("https://api.stripe.com/v1/accounts/acct_X");
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({
        id: "acct_X",
        object: "account",
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        capabilities: { transfers: "active" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const r = await fetchAccount(ENV_OK, "acct_X");
    expect((r as { charges_enabled?: boolean }).charges_enabled).toBe(true);
    expect((r as { payouts_enabled?: boolean }).payouts_enabled).toBe(true);
  });
});

describe("stripe — transfers", () => {
  it("createTransfer sends amount + destination + idempotency key", async () => {
    let capturedBody = "";
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({
        id: "tr_TEST",
        object: "transfer",
        amount: 12500,
        currency: "usd",
        destination: "acct_X",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const r = await createTransfer(ENV_OK, {
      amount_cents: 12500,
      destination_account: "acct_X",
      payout_id: "po_abc",
    });
    expect(capturedBody).toContain("amount=12500");
    expect(capturedBody).toContain("destination=acct_X");
    expect(capturedBody).toContain("currency=usd");
    expect(capturedHeaders["Idempotency-Key"]).toBe("transfer_po_abc");
    expect((r as { id?: string }).id).toBe("tr_TEST");
  });
});

describe("stripe — invoices", () => {
  it("createAndSendInvoice walks invoiceitems → invoice → send", async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = String(init?.body ?? "");
      calls.push({ url, body });
      if (url.endsWith("/invoiceitems")) {
        return new Response(JSON.stringify({ id: "ii_" + calls.length }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/invoices")) {
        return new Response(JSON.stringify({ id: "in_TEST", object: "invoice", status: "draft", total: 7500 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/invoices/in_TEST/send")) {
        return new Response(JSON.stringify({ id: "in_TEST", object: "invoice", status: "open", total: 7500, hosted_invoice_url: "https://invoice.stripe.test/in_TEST" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error("unexpected fetch: " + url);
    }) as typeof fetch;

    const r = await createAndSendInvoice(ENV_OK, {
      customer: "cus_X",
      invoice_id: "inv_abc",
      line_items: [
        { description: "ASL · 2026-01-15 · J.D.", amount_cents: 5000, quantity: 1 },
        { description: "Spanish · 2026-01-16 · K.M.", amount_cents: 2500, quantity: 1 },
      ],
    });
    expect(calls.length).toBe(4);          // 2 items + 1 invoice create + 1 send
    expect(calls[0]?.url).toContain("/invoiceitems");
    expect(calls[1]?.url).toContain("/invoiceitems");
    expect(calls[2]?.url).toContain("/invoices");
    expect(calls[3]?.url).toContain("/invoices/in_TEST/send");
    expect((r as { id?: string }).id).toBe("in_TEST");
    expect((r as { hosted_invoice_url?: string }).hosted_invoice_url).toContain("invoice.stripe.test");
    // Idempotency key for the invoice itself should anchor on our local ID
    expect(calls[2]?.body).toContain("metadata%5Bour_invoice_id%5D=inv_abc");
  });

  it("findOrCreateCustomer reuses existing_id without POST", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://api.stripe.com/v1/customers/cus_PREEXISTING");
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({ id: "cus_PREEXISTING", object: "customer", email: "p@example.test" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const r = await findOrCreateCustomer(ENV_OK, { existing_id: "cus_PREEXISTING", payer_id: "p_1" });
    expect((r as { id?: string }).id).toBe("cus_PREEXISTING");
  });
});

// Stripe webhook fixtures: we build the signed body locally so we don't need
// real Stripe-side test data on disk.
async function buildSignedWebhook(body: string, secret: string, t = Math.floor(Date.now() / 1000)): Promise<{ raw: string; sigHeader: string }> {
  const signedPayload = `${t}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i]!.toString(16);
    hex += h.length === 1 ? "0" + h : h;
  }
  return { raw: body, sigHeader: `t=${t},v1=${hex}` };
}

describe("stripe — webhook signature", () => {
  const SECRET = "whsec_test_FIXTURE";

  it("accepts a valid signature", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
    const { raw, sigHeader } = await buildSignedWebhook(body, SECRET);
    const r = await verifyWebhookSignature(raw, sigHeader, SECRET);
    expect(r.ok).toBe(true);
    expect(r.event?.id).toBe("evt_1");
  });

  it("rejects a tampered signature", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
    const { raw, sigHeader } = await buildSignedWebhook(body, SECRET);
    const tampered = sigHeader.replace(/v1=[0-9a-f]+/, "v1=" + "0".repeat(64));
    const r = await verifyWebhookSignature(raw, tampered, SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no matching v1 signature");
  });

  it("rejects a stale timestamp", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 10;
    const { raw, sigHeader } = await buildSignedWebhook(body, SECRET, tenMinutesAgo);
    const r = await verifyWebhookSignature(raw, sigHeader, SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("timestamp outside tolerance");
  });

  it("rejects a missing header", async () => {
    const r = await verifyWebhookSignature("{}", null, SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("missing");
  });

  it("rejects a malformed header", async () => {
    const r = await verifyWebhookSignature("{}", "this-is-not-a-stripe-sig", SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("malformed");
  });

  it("rejects with a different secret", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
    const { raw, sigHeader } = await buildSignedWebhook(body, SECRET);
    const r = await verifyWebhookSignature(raw, sigHeader, "whsec_DIFFERENT");
    expect(r.ok).toBe(false);
  });
});

describe("stripe — webhook event bridge", () => {
  // Every event the worker subscribes to is forwarded to Apps Script under the
  // single action 'payments_webhook_event' with a normalized payload. These
  // tests pin the payload shape and the summary string for each event class.

  function mockFetchOk() {
    let captured: { url: string; body: string; header: string } | null = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      captured = {
        url,
        body: String(init?.body ?? ""),
        header: (init?.headers as Record<string, string>)["X-1891-Internal"] ?? "",
      };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    return () => captured!;
  }

  function bodyParam(body: string, key: string): string | null {
    const params = new URLSearchParams(body);
    return params.get(key);
  }

  it("invoice.paid → action=payments_webhook_event with normalized fields", async () => {
    const get = mockFetchOk();
    const r = await handleWebhookEvent(ENV_OK, {
      id: "evt_1",
      type: "invoice.paid",
      livemode: false,
      created: 1700000000,
      data: {
        object: {
          id: "in_TEST",
          object: "invoice",
          amount_paid: 12500,
          currency: "usd",
          metadata: { our_invoice_id: "inv_abc" },
        },
      },
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("invoice.paid");
    const cap = get();
    expect(cap.url).toContain("action=payments_webhook_event");
    expect(cap.header).toBe(ENV_OK.JWT_SECRET);
    expect(bodyParam(cap.body, "event_id")).toBe("evt_1");
    expect(bodyParam(cap.body, "event_type")).toBe("invoice.paid");
    expect(bodyParam(cap.body, "object_id")).toBe("in_TEST");
    expect(bodyParam(cap.body, "object_type")).toBe("invoice");
    expect(bodyParam(cap.body, "livemode")).toBe("false");
    expect(bodyParam(cap.body, "summary")).toContain("Invoice paid");
    expect(bodyParam(cap.body, "summary")).toContain("$125.00");
    const meta = JSON.parse(bodyParam(cap.body, "metadata") ?? "{}");
    expect(meta.our_invoice_id).toBe("inv_abc");
  });

  it("payment_intent.succeeded uses amount_received for summary", async () => {
    const get = mockFetchOk();
    await handleWebhookEvent(ENV_OK, {
      id: "evt_pi_ok",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_TEST",
          object: "payment_intent",
          amount_received: 5000,
          currency: "usd",
        },
      },
    });
    expect(bodyParam(get().body, "summary")).toContain("PaymentIntent succeeded — $50.00 USD");
  });

  it("transfer.created forwards object_id + USD summary", async () => {
    const get = mockFetchOk();
    await handleWebhookEvent(ENV_OK, {
      id: "evt_3",
      type: "transfer.created",
      data: {
        object: {
          id: "tr_TEST",
          object: "transfer",
          amount: 12500,
          currency: "usd",
          metadata: { payout_id: "po_abc" },
        },
      },
    });
    const body = get().body;
    expect(bodyParam(body, "object_id")).toBe("tr_TEST");
    expect(bodyParam(body, "object_type")).toBe("transfer");
    expect(bodyParam(body, "summary")).toContain("Transfer created — $125.00");
    const meta = JSON.parse(bodyParam(body, "metadata") ?? "{}");
    expect(meta.payout_id).toBe("po_abc");
  });

  it("account.updated forwards Connect onboarding flags as first-class params", async () => {
    const get = mockFetchOk();
    await handleWebhookEvent(ENV_OK, {
      id: "evt_4",
      type: "account.updated",
      data: {
        object: {
          id: "acct_X",
          object: "account",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          requirements: { currently_due: ["external_account"] },
          metadata: { interpreter_id: "int_42" },
        },
      },
    });
    const body = get().body;
    expect(bodyParam(body, "object_id")).toBe("acct_X");
    expect(bodyParam(body, "charges_enabled")).toBe("true");
    expect(bodyParam(body, "payouts_enabled")).toBe("true");
    expect(bodyParam(body, "details_submitted")).toBe("true");
    expect(bodyParam(body, "requirements_currently_due")).toBe('["external_account"]');
    const meta = JSON.parse(bodyParam(body, "metadata") ?? "{}");
    expect(meta.interpreter_id).toBe("int_42");
  });

  it("charge.dispute.created still forwards (no swallowing) and logs to console.error", async () => {
    const get = mockFetchOk();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await handleWebhookEvent(ENV_OK, {
      id: "evt_dispute",
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_TEST",
          object: "dispute",
          amount: 7500,
          currency: "usd",
          reason: "fraudulent",
        },
      },
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("charge.dispute.created");
    expect(bodyParam(get().body, "summary")).toContain("Dispute opened (fraudulent)");
    expect(errSpy).toHaveBeenCalledWith("STRIPE DISPUTE", expect.any(Object));
    errSpy.mockRestore();
  });

  it("radar.early_fraud_warning.created forwards + logs", async () => {
    mockFetchOk();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleWebhookEvent(ENV_OK, {
      id: "evt_efw",
      type: "radar.early_fraud_warning.created",
      data: {
        object: {
          id: "issfr_TEST",
          object: "radar.early_fraud_warning",
          actionable: true,
          fraud_type: "made_with_stolen_card",
        },
      },
    });
    expect(errSpy).toHaveBeenCalledWith("STRIPE EARLY FRAUD WARNING", expect.any(Object));
    errSpy.mockRestore();
  });

  it("checkout.session.completed includes mode in summary", async () => {
    const get = mockFetchOk();
    await handleWebhookEvent(ENV_OK, {
      id: "evt_co",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_TEST",
          object: "checkout.session",
          mode: "subscription",
          amount_total: 9900,
          currency: "usd",
        },
      },
    });
    expect(bodyParam(get().body, "summary")).toContain("Checkout completed (subscription)");
  });

  it("unknown event types are still forwarded (not dropped)", async () => {
    const get = mockFetchOk();
    const r = await handleWebhookEvent(ENV_OK, {
      id: "evt_unknown",
      type: "some.random.event",
      data: { object: { id: "obj_X", object: "weird" } },
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("some.random.event");
    expect(bodyParam(get().body, "event_type")).toBe("some.random.event");
    expect(bodyParam(get().body, "summary")).toContain("Unhandled event type some.random.event");
  });

  it("payload_excerpt is JSON-stringified raw object and capped to ~3000 chars", async () => {
    const get = mockFetchOk();
    const longString = "x".repeat(5000);
    await handleWebhookEvent(ENV_OK, {
      id: "evt_long",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_LONG",
          object: "payment_intent",
          amount_received: 100,
          currency: "usd",
          description: longString,
        },
      },
    });
    const excerpt = bodyParam(get().body, "payload_excerpt") ?? "";
    expect(excerpt.length).toBeGreaterThan(2900);
    expect(excerpt.length).toBeLessThanOrEqual(3000 + "…[truncated]".length);
    expect(excerpt.endsWith("…[truncated]")).toBe(true);
  });
});
