// Unit tests for the document-translation Worker routes.
//
// What we cover (per the brief):
//   - DeepL path (supported pair, no PHI gate)
//   - Claude path (unsupported-by-DeepL pair → falls through to Claude)
//   - Hard-gate path (medical / mental-health / legal / gov → prefill_blocked)
//   - PHI redaction summary returned to the caller
//   - Glossary returns valid JSON for a known pair, empty array for an unknown one
//
// We avoid miniflare here for parity with cors.test.ts — fetch is stubbed at
// the global level and the Env shape is faked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  redactForModel,
  glossaryFor,
  shouldUseDeepL,
  routeTranslate,
  DEEPL_LANGS,
  HARD_GATED_SERVICE_TYPES,
} from "../src/translate";
import { signToken } from "../src/jwt";

const SECRET = "test-secret-do-not-use-in-prod";

interface FakeEnv {
  APPS_SCRIPT_URL: string;
  ALLOWED_ORIGIN: string;
  JWT_SECRET: string;
  JOB_BOARD_ROOM: unknown;
  DEEPL_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

function makeEnv(over: Partial<FakeEnv> = {}): FakeEnv {
  return {
    APPS_SCRIPT_URL: "https://example/exec",
    ALLOWED_ORIGIN: "https://madeby1891.com",
    JWT_SECRET: SECRET,
    JOB_BOARD_ROOM: {},
    ...over,
  };
}

async function tokenFor(tid = "acme", role = "role_scheduler"): Promise<string> {
  return signToken(
    { uid: "u1", tid, role, exp: Date.now() + 60_000 },
    SECRET
  );
}

function postPrefill(body: unknown, session: string): Request {
  return new Request(`https://api.test/v1/translate/prefill?session=${encodeURIComponent(session)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getGlossary(source: string, target: string, session: string): Request {
  return new Request(
    `https://api.test/v1/translate/glossary?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}&session=${encodeURIComponent(session)}`,
    { method: "GET" }
  );
}

// ---------------------------------------------------------------------------

describe("redactForModel", () => {
  it("redacts SSN, phone, email, MRN, DOB, and an honorific name", () => {
    // "patient" is lowercase to match the Code.gs source regex (case-sensitive).
    const r = redactForModel(
      "The patient John Smith, SSN 123-45-6789, MRN 99887766554, born 04/12/1984, phone (240) 555-1234, email john@example.com."
    );
    expect(r.text).toContain("[SSN]");
    expect(r.text).toContain("[ID]");
    expect(r.text).toContain("[DATE]");
    expect(r.text).toContain("[PHONE]");
    expect(r.text).toContain("[EMAIL]");
    expect(r.text).toContain("[NAME]");
    expect(r.text).not.toContain("123-45-6789");
    expect(r.text).not.toContain("john@example.com");
    expect(r.replacements).toBeGreaterThanOrEqual(5);
    expect(Object.keys(r.kinds)).toEqual(
      expect.arrayContaining(["ssn", "mrn", "phone", "email", "dob", "name_pattern"])
    );
  });

  it("returns zero replacements when there is nothing to scrub", () => {
    const r = redactForModel("The conference room overlooks the river.");
    expect(r.replacements).toBe(0);
    expect(r.kinds).toEqual({});
  });

  it("flags clinical red-flag terms without removing them", () => {
    const r = redactForModel("Discuss the patient's HIV diagnosis with the family.");
    expect(r.kinds.clinical_term_flagged).toBe(1);
    expect(r.text).toContain("HIV");
  });
});

// ---------------------------------------------------------------------------

describe("DeepL allowlist", () => {
  it("hard-coded set includes every documented language", () => {
    // Spec line: en, es, de, fr, it, ja, pt-PT, pt-BR, ru, zh-CN, zh-TW, ko, nl, pl, sv, tr, ar
    [
      "en", "es", "de", "fr", "it", "ja", "pt-PT", "pt-BR", "ru",
      "zh-CN", "zh-TW", "ko", "nl", "pl", "sv", "tr", "ar",
    ].forEach((l) => {
      expect(DEEPL_LANGS.has(l)).toBe(true);
    });
  });

  it("excludes ASL and other signed languages from MT routing", () => {
    expect(shouldUseDeepL({ source: "en", target: "ASL", hasKey: true })).toBe(false);
    expect(shouldUseDeepL({ source: "ASL", target: "en", hasKey: true })).toBe(false);
    expect(shouldUseDeepL({ source: "ProTactile", target: "en", hasKey: true })).toBe(false);
  });

  it("uses DeepL for a supported pair when a key is present", () => {
    expect(shouldUseDeepL({ source: "en", target: "es", hasKey: true })).toBe(true);
    expect(shouldUseDeepL({ source: "pt-BR", target: "en", hasKey: true })).toBe(true);
  });

  it("falls through to Claude when no key is configured", () => {
    expect(shouldUseDeepL({ source: "en", target: "es", hasKey: false })).toBe(false);
  });

  it("falls through to Claude for pairs DeepL doesn't speak", () => {
    expect(shouldUseDeepL({ source: "en", target: "so", hasKey: true })).toBe(false);
    expect(shouldUseDeepL({ source: "en", target: "ht", hasKey: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("hard-gate service types", () => {
  it("matches the four categories called out in CLAUDE.md / PRD", () => {
    expect(HARD_GATED_SERVICE_TYPES.has("medical")).toBe(true);
    expect(HARD_GATED_SERVICE_TYPES.has("mental-health")).toBe(true);
    expect(HARD_GATED_SERVICE_TYPES.has("legal")).toBe(true);
    expect(HARD_GATED_SERVICE_TYPES.has("gov")).toBe(true);
    expect(HARD_GATED_SERVICE_TYPES.has("community")).toBe(false);
    expect(HARD_GATED_SERVICE_TYPES.has("corporate")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("glossary", () => {
  it("returns curated en→es entries", () => {
    const terms = glossaryFor("en-US", "es-419");
    expect(terms.length).toBeGreaterThan(0);
    const sources = terms.map((t) => t.source);
    expect(sources).toContain("informed consent");
    expect(sources).toContain("court order");
  });

  it("returns an empty array for an unknown pair", () => {
    expect(glossaryFor("yi", "kk")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("routeTranslate — /v1/translate/prefill", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("hard-gates medical translation (no model call, prefill_blocked: true)", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as typeof fetch;
    const env = makeEnv({ DEEPL_API_KEY: "deep-fake:fx", ANTHROPIC_API_KEY: "ak-fake" });
    const session = await tokenFor();
    const req = postPrefill(
      {
        document_id: "d_1",
        source_lang: "en",
        target_lang: "es",
        source_text: "Please translate this consent form.",
        service_type: "medical",
      },
      session
    );
    const res = await routeTranslate(req, env as never);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { ok: boolean; prefill_blocked: boolean; reason: string; source?: string };
    expect(body.ok).toBe(true);
    expect(body.prefill_blocked).toBe(true);
    expect(body.reason).toBe("hard-gated category");
    expect(body.source).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hard-gates legal, mental-health, and gov the same way", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    const env = makeEnv({ DEEPL_API_KEY: "x:fx", ANTHROPIC_API_KEY: "ak" });
    const session = await tokenFor();
    for (const svc of ["legal", "mental-health", "gov"]) {
      const req = postPrefill(
        { source_lang: "en", target_lang: "es", source_text: "hi", service_type: svc },
        session
      );
      const res = await routeTranslate(req, env as never);
      const body = await res!.json() as { prefill_blocked: boolean };
      expect(body.prefill_blocked).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("routes a supported pair to DeepL and returns its translation", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      expect(u.host).toContain("deepl.com");
      return new Response(
        JSON.stringify({ translations: [{ text: "Hola mundo." }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const env = makeEnv({ DEEPL_API_KEY: "deep-fake:fx" });
    const session = await tokenFor();
    const req = postPrefill(
      {
        source_lang: "en",
        target_lang: "es",
        source_text: "Hello world.",
        service_type: "community",
      },
      session
    );
    const res = await routeTranslate(req, env as never);
    expect(res!.status).toBe(200);
    const body = await res!.json() as { ok: boolean; source: string; translated_text: string; redaction_summary: { replacements: number } };
    expect(body.ok).toBe(true);
    expect(body.source).toBe("deepl");
    expect(body.translated_text).toBe("Hola mundo.");
    expect(body.redaction_summary.replacements).toBe(0);
  });

  it("PHI is redacted before the vendor call (summary is surfaced)", async () => {
    let bodySeenByVendor = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      const raw = init?.body;
      if (typeof raw === "string") {
        bodySeenByVendor = raw;
      } else if (raw instanceof URLSearchParams) {
        bodySeenByVendor = raw.toString();
      } else if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
        bodySeenByVendor = new TextDecoder().decode(raw as Uint8Array | ArrayBuffer);
      } else if (raw) {
        // Last-ditch: stringify whatever shape we got.
        bodySeenByVendor = String(raw);
      }
      return new Response(
        JSON.stringify({ translations: [{ text: "redacted output" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const env = makeEnv({ DEEPL_API_KEY: "x:fx" });
    const session = await tokenFor();
    const req = postPrefill(
      {
        source_lang: "en",
        target_lang: "es",
        source_text: "Contact me at 240-555-1234 or jane@example.com — SSN 111-22-3333.",
        service_type: "community",
      },
      session
    );
    const res = await routeTranslate(req, env as never);
    const body = await res!.json() as { ok: boolean; redaction_summary: { replacements: number; kinds: Record<string, number> } };
    expect(body.ok).toBe(true);
    expect(body.redaction_summary.replacements).toBeGreaterThanOrEqual(3);
    expect(body.redaction_summary.kinds.phone).toBe(1);
    expect(body.redaction_summary.kinds.email).toBe(1);
    expect(body.redaction_summary.kinds.ssn).toBe(1);
    // The vendor wire is application/x-www-form-urlencoded — decode the `text` field
    // before asserting on its contents.
    const params = new URLSearchParams(bodySeenByVendor);
    const sentText = params.get("text") ?? "";
    expect(sentText).not.toContain("240-555-1234");
    expect(sentText).not.toContain("jane@example.com");
    expect(sentText).not.toContain("111-22-3333");
    expect(sentText).toContain("[PHONE]");
    expect(sentText).toContain("[EMAIL]");
    expect(sentText).toContain("[SSN]");
  });

  it("routes ASL targets to Claude (DeepL doesn't speak signed languages)", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push(url);
      // Claude shape:
      return new Response(
        JSON.stringify({ content: [{ text: "DOCUMENT GLOSS HERE" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const env = makeEnv({ DEEPL_API_KEY: "x:fx", ANTHROPIC_API_KEY: "ak" });
    const session = await tokenFor();
    const req = postPrefill(
      {
        source_lang: "en",
        target_lang: "ASL",
        source_text: "Welcome to the meeting.",
        service_type: "community",
      },
      session
    );
    const res = await routeTranslate(req, env as never);
    const body = await res!.json() as { ok: boolean; source: string; translated_text: string };
    expect(body.source).toBe("claude");
    expect(body.translated_text).toBe("DOCUMENT GLOSS HERE");
    expect(seen.every((u) => !u.includes("deepl.com"))).toBe(true);
    expect(seen.some((u) => u.includes("anthropic.com"))).toBe(true);
  });

  it("falls through from DeepL to Claude when DeepL errors", async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      call++;
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("deepl.com")) {
        return new Response("nope", { status: 500 });
      }
      expect(url).toContain("anthropic.com");
      return new Response(
        JSON.stringify({ content: [{ text: "fallback translation" }] }),
        { status: 200 }
      );
    }) as typeof fetch;

    const env = makeEnv({ DEEPL_API_KEY: "x:fx", ANTHROPIC_API_KEY: "ak" });
    const session = await tokenFor();
    const req = postPrefill(
      {
        source_lang: "en",
        target_lang: "es",
        source_text: "Hello.",
        service_type: "community",
      },
      session
    );
    const res = await routeTranslate(req, env as never);
    const body = await res!.json() as { ok: boolean; source: string };
    expect(body.source).toBe("claude");
    expect(call).toBe(2);
  });

  it("rejects when no session is supplied", async () => {
    const env = makeEnv();
    const req = new Request("https://api.test/v1/translate/prefill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_lang: "en", target_lang: "es", source_text: "hi", service_type: "community" }),
    });
    const res = await routeTranslate(req, env as never);
    expect(res!.status).toBe(401);
  });

  it("returns 405 for GET on /prefill", async () => {
    const env = makeEnv();
    const session = await tokenFor();
    const req = new Request(`https://api.test/v1/translate/prefill?session=${session}`, { method: "GET" });
    const res = await routeTranslate(req, env as never);
    expect(res!.status).toBe(405);
  });
});

describe("routeTranslate — /v1/translate/glossary", () => {
  it("returns valid JSON with terms for en→es", async () => {
    const env = makeEnv();
    const session = await tokenFor();
    const req = getGlossary("en-US", "es-419", session);
    const res = await routeTranslate(req, env as never);
    expect(res!.status).toBe(200);
    const body = await res!.json() as { ok: boolean; terms: Array<{ source: string; target: string; domain: string }> };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.terms)).toBe(true);
    expect(body.terms.length).toBeGreaterThan(0);
    for (const t of body.terms) {
      expect(typeof t.source).toBe("string");
      expect(typeof t.target).toBe("string");
      expect(typeof t.domain).toBe("string");
    }
  });

  it("returns an empty terms array for an unknown pair", async () => {
    const env = makeEnv();
    const session = await tokenFor();
    const req = getGlossary("yi", "kk", session);
    const res = await routeTranslate(req, env as never);
    const body = await res!.json() as { ok: boolean; terms: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.terms).toEqual([]);
  });

  it("requires a session", async () => {
    const env = makeEnv();
    const req = new Request("https://api.test/v1/translate/glossary?source=en&target=es", { method: "GET" });
    const res = await routeTranslate(req, env as never);
    expect(res!.status).toBe(401);
  });
});

describe("routeTranslate — unknown subpath", () => {
  it("returns 404 for an unknown /v1/translate/* path", async () => {
    const env = makeEnv();
    const req = new Request("https://api.test/v1/translate/nope", { method: "GET" });
    const res = await routeTranslate(req, env as never);
    expect(res!.status).toBe(404);
  });

  it("returns null for non-translate paths so the parent router can handle them", async () => {
    const env = makeEnv();
    const req = new Request("https://api.test/v1/jobs/stream", { method: "GET" });
    const res = await routeTranslate(req, env as never);
    expect(res).toBeNull();
  });
});
