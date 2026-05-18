// Unit tests for cors, jwt, and proxy modules.
// These run under vanilla vitest (Node 18+ has fetch / crypto.subtle / btoa / atob
// built in, which is all we need). No miniflare required for this layer.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { corsHeaders, handlePreflight, withCors, resolveOrigin } from "../src/cors";
import { signToken, verifyToken } from "../src/jwt";
import { proxyToAppsScript } from "../src/proxy";

const ALLOWED = "https://madeby1891.com";
const cfg = { allowedOrigin: ALLOWED };

describe("cors", () => {
  it("resolveOrigin allows the configured origin", () => {
    expect(resolveOrigin(ALLOWED, ALLOWED)).toBe(ALLOWED);
  });

  it("resolveOrigin allows known dev origins", () => {
    expect(resolveOrigin("http://localhost:8080", ALLOWED)).toBe("http://localhost:8080");
  });

  it("resolveOrigin rejects unknown origins", () => {
    expect(resolveOrigin("https://evil.example", ALLOWED)).toBeNull();
  });

  it("corsHeaders include Vary: Origin when origin matches", () => {
    const h = corsHeaders(ALLOWED, cfg);
    expect(h.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
    expect(h.get("Vary")).toBe("Origin");
    expect(h.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(h.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(h.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });

  it("corsHeaders omit Allow-Origin when origin does not match", () => {
    const h = corsHeaders("https://evil.example", cfg);
    expect(h.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("handlePreflight returns 204 with CORS headers", () => {
    const req = new Request("https://api.madeby1891.com/v1/proxy", {
      method: "OPTIONS",
      headers: { Origin: ALLOWED, "Access-Control-Request-Method": "POST" },
    });
    const res = handlePreflight(req, cfg);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
  });

  it("withCors merges headers into an existing response", async () => {
    const req = new Request("https://api.madeby1891.com/v1/proxy", {
      method: "GET",
      headers: { Origin: ALLOWED },
    });
    const upstream = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Upstream": "yes" },
    });
    const res = withCors(upstream, req, cfg);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
    expect(res.headers.get("X-Upstream")).toBe("yes");
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("jwt", () => {
  const SECRET = "test-secret-do-not-use-in-prod";

  it("verifies a freshly-signed token", async () => {
    const exp = Date.now() + 60_000;
    const token = await signToken({ uid: "u1", tid: "acme", role: "role_owner", exp }, SECRET);
    const payload = await verifyToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.uid).toBe("u1");
    expect(payload?.tid).toBe("acme");
    expect(payload?.role).toBe("role_owner");
  });

  it("rejects a tampered signature", async () => {
    const exp = Date.now() + 60_000;
    const token = await signToken({ uid: "u1", tid: "acme", role: "role_owner", exp }, SECRET);
    const [payloadPart, sigPart] = token.split(".");
    // Flip one character in the signature.
    const tampered = payloadPart + "." + (sigPart!.startsWith("A") ? "B" : "A") + sigPart!.slice(1);
    expect(await verifyToken(tampered, SECRET)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const exp = Date.now() + 60_000;
    const token = await signToken({ uid: "u1", tid: "acme", role: "role_owner", exp }, SECRET);
    expect(await verifyToken(token, "some-other-secret")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const exp = Date.now() - 1_000;
    const token = await signToken({ uid: "u1", tid: "acme", role: "role_owner", exp }, SECRET);
    expect(await verifyToken(token, SECRET)).toBeNull();
  });

  it("rejects garbage input", async () => {
    expect(await verifyToken("", SECRET)).toBeNull();
    expect(await verifyToken("not-a-token", SECRET)).toBeNull();
    expect(await verifyToken("a.b.c", SECRET)).toBeNull();
    expect(await verifyToken(".sig", SECRET)).toBeNull();
    expect(await verifyToken("payload.", SECRET)).toBeNull();
  });

  it("matches Apps Script base64url (no padding, - and _)", async () => {
    // The first segment must never contain '=', '+', or '/'.
    const exp = Date.now() + 60_000;
    const token = await signToken({ uid: "u1", tid: "acme", role: "role_owner", exp }, SECRET);
    expect(token).not.toContain("=");
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token.split(".").length).toBe(2);
  });
});

describe("proxy", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    // no-op; each test sets its own mock
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("forwards GET query string and rewraps as JSON", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      expect(u.searchParams.get("action")).toBe("list_jobs");
      expect(u.searchParams.get("status")).toBe("open");
      return new Response(JSON.stringify({ ok: true, jobs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const req = new Request(
      "https://api.madeby1891.com/v1/proxy?action=list_jobs&status=open",
      { method: "GET" }
    );
    const res = await proxyToAppsScript(req, { appsScriptUrl: "https://example/exec" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, jobs: [] });
  });

  it("forwards POST body", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const buf = init?.body as ArrayBuffer;
      const text = new TextDecoder().decode(buf);
      expect(text).toContain("action=create_job");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const req = new Request("https://api.madeby1891.com/v1/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "action=create_job&lang=es",
    });
    const res = await proxyToAppsScript(req, { appsScriptUrl: "https://example/exec" });
    expect(res.status).toBe(200);
  });

  it("returns 405 for non-GET/POST", async () => {
    const req = new Request("https://api.madeby1891.com/v1/proxy", { method: "DELETE" });
    const res = await proxyToAppsScript(req, { appsScriptUrl: "https://example/exec" });
    expect(res.status).toBe(405);
  });

  it("returns 502 on upstream failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network blew up");
    }) as typeof fetch;
    const req = new Request("https://api.madeby1891.com/v1/proxy", { method: "GET" });
    const res = await proxyToAppsScript(req, { appsScriptUrl: "https://example/exec" });
    expect(res.status).toBe(502);
  });

  it("strips upstream CORS headers so we set our own", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("{}", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          Vary: "Origin",
        },
      });
    }) as typeof fetch;
    const req = new Request("https://api.madeby1891.com/v1/proxy", { method: "GET" });
    const res = await proxyToAppsScript(req, { appsScriptUrl: "https://example/exec" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Vary")).toBeNull();
  });
});
