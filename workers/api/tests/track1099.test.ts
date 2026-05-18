// Unit tests for the track1099 module.
// Like stripe.test.ts we mock fetch — no live calls.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isConfigured,
  unconfigured,
  createNec1099,
  getForm,
  type Track1099Env,
} from "../src/track1099";

const ENV_OK: Track1099Env = {
  TRACK1099_API_KEY: "fake-token-for-tests",
};
const ENV_OVERRIDE: Track1099Env = {
  TRACK1099_API_KEY: "fake-token-for-tests",
  TRACK1099_BASE: "https://sandbox.track1099.test/api/v2",
};
const ENV_UNSET: Track1099Env = {};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

describe("track1099 — configuration", () => {
  it("isConfigured + unconfigured shape", () => {
    expect(isConfigured(ENV_OK)).toBe(true);
    expect(isConfigured(ENV_UNSET)).toBe(false);
    const u = unconfigured();
    expect(u.ok).toBe(false);
    expect(u.status).toBe("unconfigured");
    expect(u.error).toContain("TRACK1099_API_KEY");
  });

  it("API helpers return unconfigured when env is empty", async () => {
    const r = await createNec1099(ENV_UNSET, {
      tax_year: 2026,
      recipient: { name: "x", tin: "0", address1: "1", city: "y", state: "z", zip: "00000" },
      nonemployee_comp_cents: 100000,
      interpreter_id: "int_1",
      tenant_id: "host",
    });
    expect((r as { ok?: false }).ok).toBe(false);
    expect((r as { status?: string }).status).toBe("unconfigured");
  });
});

describe("track1099 — base URL override", () => {
  it("uses TRACK1099_BASE when set", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ id: "form_TEST", status: "queued", tax_year: 2026 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    await createNec1099(ENV_OVERRIDE, {
      tax_year: 2026,
      recipient: { name: "x", tin: "000000000", address1: "1", city: "y", state: "MD", zip: "21701" },
      nonemployee_comp_cents: 100000,
      interpreter_id: "int_1",
      tenant_id: "host",
    });
    expect(capturedUrl).toBe("https://sandbox.track1099.test/api/v2/1099_nec/forms");
  });
});

describe("track1099 — createNec1099", () => {
  it("POSTs to /1099_nec/forms with token auth header", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedInit = init;
      return new Response(JSON.stringify({ id: "form_TEST", status: "queued", tax_year: 2026 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const r = await createNec1099(ENV_OK, {
      tax_year: 2026,
      recipient: {
        name: "Jane Doe",
        tin: "123-45-6789",
        tin_type: "SSN",
        email: "j@example.test",
        address1: "100 Main",
        city: "Frederick",
        state: "MD",
        zip: "21701",
      },
      nonemployee_comp_cents: 250000,
      interpreter_id: "int_42",
      tenant_id: "host",
    });
    expect(capturedUrl).toBe("https://www.track1099.com/api/v2/1099_nec/forms");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("fake-token-for-tests");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(capturedInit?.body ?? "{}"));
    expect(body.tax_year).toBe(2026);
    expect(body.recipient.tin).toBe("123456789");        // dashes stripped
    expect(body.recipient.tin_type).toBe("SSN");
    expect(body.nonemployee_compensation_cents).toBe(250000);
    expect(body.metadata.interpreter_id).toBe("int_42");
    expect(body.metadata.tenant_id).toBe("host");
    expect((r as { id?: string }).id).toBe("form_TEST");
  });

  it("never logs or echoes the API key in the response object", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ id: "form_X", status: "queued", tax_year: 2026 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const r = await createNec1099(ENV_OK, {
      tax_year: 2026,
      recipient: { name: "x", tin: "123456789", address1: "1", city: "y", state: "MD", zip: "21701" },
      nonemployee_comp_cents: 60000,
      interpreter_id: "int_x",
      tenant_id: "host",
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain("fake-token-for-tests");
  });

  it("surfaces 4xx errors with the error message field", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "Missing recipient.tin" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const r = await createNec1099(ENV_OK, {
      tax_year: 2026,
      recipient: { name: "x", tin: "", address1: "1", city: "y", state: "MD", zip: "21701" },
      nonemployee_comp_cents: 60000,
      interpreter_id: "int_x",
      tenant_id: "host",
    });
    expect((r as { ok?: false }).ok).toBe(false);
    expect((r as { error?: string }).error).toBe("Missing recipient.tin");
    expect((r as { http_status?: number }).http_status).toBe(400);
  });

  it("falls back gracefully when fetch throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const r = await createNec1099(ENV_OK, {
      tax_year: 2026,
      recipient: { name: "x", tin: "123456789", address1: "1", city: "y", state: "MD", zip: "21701" },
      nonemployee_comp_cents: 60000,
      interpreter_id: "int_x",
      tenant_id: "host",
    });
    expect((r as { ok?: false }).ok).toBe(false);
    expect((r as { error?: string }).error).toBe("track1099_unreachable");
  });
});

describe("track1099 — getForm", () => {
  it("GETs /forms/:id", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedInit = init;
      return new Response(JSON.stringify({
        id: "form_TEST",
        status: "e-filed",
        tax_year: 2026,
        recipient_name: "Jane Doe",
        efile_status: "accepted",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const r = await getForm(ENV_OK, "form_TEST");
    expect(capturedUrl).toBe("https://www.track1099.com/api/v2/forms/form_TEST");
    expect(capturedInit?.method).toBe("GET");
    expect((r as { efile_status?: string }).efile_status).toBe("accepted");
  });
});
