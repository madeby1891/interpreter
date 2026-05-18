// 1891 Interpreter — document translation Worker routes.
//
// PRD A4 spec'd a separate workers/translate service. For v1 we mount the
// translation routes inside workers/api to ship faster; a future session
// will split this into its own Worker once traffic justifies the cost.
//
// Routes (all under /v1/translate/*):
//   POST /v1/translate/prefill   — DeepL or Claude MT pre-fill for a draft
//   GET  /v1/translate/glossary  — domain glossary terms for the translator
//
// Hard-gate rule: medical, mental-health, legal, and gov service_types are
// NEVER machine pre-filled. The translator works from scratch. TM suggestions
// live on the Apps Script side (Documents tab, prior approved translations).
//
// PHI is scrubbed before any model call via redactForModel(). The audit row
// is written by Apps Script (we return the redaction summary; Apps Script
// logs the hash).

import { verifyToken } from "./jwt";
import type { Env } from "./index";

// ---------------------------------------------------------------------------
// DeepL supported pairs (Pro + Free share the same set as of 2026-05).
// Anything not in this allowlist is routed to Claude. ASL / signed languages
// are NEVER routed to DeepL — DeepL doesn't speak signed languages.
// ---------------------------------------------------------------------------
export const DEEPL_LANGS: ReadonlySet<string> = new Set([
  "en",
  "es",
  "de",
  "fr",
  "it",
  "ja",
  "pt-PT",
  "pt-BR",
  "ru",
  "zh-CN",
  "zh-TW",
  "ko",
  "nl",
  "pl",
  "sv",
  "tr",
  "ar",
]);

export const HARD_GATED_SERVICE_TYPES: ReadonlySet<string> = new Set([
  "medical",
  "mental-health",
  "legal",
  "gov",
]);

// ---------------------------------------------------------------------------
// Domain glossary — small static JSON; the translator can copy-click into
// the target pane. The list is intentionally short and curated; a tenant
// can extend via Settings (`translate.glossary.<source>-<target>`) later.
// Keys: `${source_root}-${target_root}` where root strips the region tag
// (so en-US → en, es-419 → es, etc).
// ---------------------------------------------------------------------------
type GlossaryEntry = { source: string; target: string; domain: string };

const GLOSSARY: Record<string, GlossaryEntry[]> = {
  "en-es": [
    { source: "informed consent", target: "consentimiento informado", domain: "medical" },
    { source: "advance directive", target: "directiva anticipada", domain: "medical" },
    { source: "primary care provider", target: "proveedor de atención primaria", domain: "medical" },
    { source: "deductible", target: "deducible", domain: "medical" },
    { source: "copay", target: "copago", domain: "medical" },
    { source: "court order", target: "orden judicial", domain: "legal" },
    { source: "affidavit", target: "declaración jurada", domain: "legal" },
    { source: "guardian ad litem", target: "tutor ad litem", domain: "legal" },
    { source: "subpoena", target: "citación judicial", domain: "legal" },
    { source: "individualized education program", target: "programa de educación individualizado", domain: "education" },
    { source: "request for proposal", target: "solicitud de propuesta", domain: "common" },
    { source: "thank you for your time", target: "gracias por su tiempo", domain: "common" },
  ],
  "es-en": [
    { source: "consentimiento informado", target: "informed consent", domain: "medical" },
    { source: "directiva anticipada", target: "advance directive", domain: "medical" },
    { source: "orden judicial", target: "court order", domain: "legal" },
    { source: "declaración jurada", target: "affidavit", domain: "legal" },
  ],
  "en-fr": [
    { source: "informed consent", target: "consentement éclairé", domain: "medical" },
    { source: "court order", target: "ordonnance du tribunal", domain: "legal" },
  ],
  "en-zh": [
    { source: "informed consent", target: "知情同意", domain: "medical" },
    { source: "court order", target: "法院命令", domain: "legal" },
  ],
  "en-ar": [
    { source: "informed consent", target: "الموافقة المستنيرة", domain: "medical" },
    { source: "court order", target: "أمر المحكمة", domain: "legal" },
  ],
};

function langRoot(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).toLowerCase().split(/[-_]/)[0] || "";
}

export function glossaryFor(source: string, target: string): GlossaryEntry[] {
  const key = `${langRoot(source)}-${langRoot(target)}`;
  return GLOSSARY[key] ?? [];
}

// ---------------------------------------------------------------------------
// PHI scrubber — port of _redactForModel from apps-script/Code.gs.
// Same regex set, same kinds map, same conservative posture.
// Returns the scrubbed text plus a summary the UI surfaces as chips.
// ---------------------------------------------------------------------------
export interface RedactionResult {
  text: string;
  replacements: number;
  kinds: Record<string, number>;
}

export function redactForModel(input: string): RedactionResult {
  const kinds: Record<string, number> = {};
  let n = 0;
  let text = String(input || "");

  function tally(kind: string, count: number) {
    if (count <= 0) return;
    kinds[kind] = (kinds[kind] ?? 0) + count;
    n += count;
  }

  // SSN ###-##-####
  text = text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => {
    tally("ssn", 1);
    return "[SSN]";
  });
  // MRN-like 8-12 digit runs
  text = text.replace(/\b\d{8,12}\b/g, () => {
    tally("mrn", 1);
    return "[ID]";
  });
  // US phone
  text = text.replace(/(\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, () => {
    tally("phone", 1);
    return "[PHONE]";
  });
  // DOB-style date M/D/YYYY
  text = text.replace(/\b(0?[1-9]|1[0-2])[\/\-](0?[1-9]|[12]\d|3[01])[\/\-](19|20)\d{2}\b/g, () => {
    tally("dob", 1);
    return "[DATE]";
  });
  // Email
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => {
    tally("email", 1);
    return "[EMAIL]";
  });
  // Honorific + capitalized name (Mr / Mrs / Ms / Dr / patient)
  text = text.replace(/\b(patient|Mr\.?|Mrs\.?|Ms\.?|Dr\.?)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g, (m) => {
    tally("name_pattern", 1);
    const head = m.split(/\s+/)[0] ?? m;
    return `${head} [NAME]`;
  });
  // Clinical red-flag terms — flagged but kept (the translator may need them)
  if (/\b(diagnosis|HIV|cancer|chemotherapy|psychiatric|MRN)\b/i.test(text)) {
    tally("clinical_term_flagged", 1);
  }

  return { text, replacements: n, kinds };
}

// ---------------------------------------------------------------------------
// JSON helper + auth gate (mirrors index.ts)
// ---------------------------------------------------------------------------
function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

async function requireSession(req: Request, env: Env) {
  // Accept either ?session= or Authorization: Bearer for parity with the
  // existing JSONP-driven client. The site sends ?session=.
  const url = new URL(req.url);
  let token = url.searchParams.get("session") ?? "";
  if (!token) {
    const auth = req.headers.get("Authorization") ?? "";
    if (auth.startsWith("Bearer ")) token = auth.slice(7);
  }
  if (!token) {
    return { ok: false as const, error: "missing session", status: 401 };
  }
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) return { ok: false as const, error: "invalid session", status: 401 };
  return { ok: true as const, payload };
}

// ---------------------------------------------------------------------------
// Vendor calls. Each one wrapped so the test suite can stub `fetch`.
// ---------------------------------------------------------------------------
export interface PrefillRequest {
  source_lang: string;
  target_lang: string;
  source_text: string;
  service_type: string;
}

export interface PrefillResponse {
  ok: true;
  translated_text?: string;
  source?: "deepl" | "claude";
  redaction_summary: { replacements: number; kinds: Record<string, number> };
  prefill_blocked?: boolean;
  reason?: string;
}

interface DeepLEnv {
  DEEPL_API_KEY?: string;
}
interface ClaudeEnv {
  ANTHROPIC_API_KEY?: string;
}

/**
 * Map our BCP-47-ish language ids to DeepL's expected codes.
 * DeepL is loose about most regional tags but pinning Brazilian/European
 * Portuguese and Simplified/Traditional Chinese matters for quality.
 */
function toDeepLCode(lang: string): string {
  const root = langRoot(lang);
  if (lang === "pt-BR" || lang === "pt-PT") return lang.toUpperCase();
  if (lang === "zh-CN") return "ZH";
  if (lang === "zh-TW") return "ZH-HANT";
  return root.toUpperCase();
}

export function shouldUseDeepL(opts: {
  source: string;
  target: string;
  hasKey: boolean;
}): boolean {
  if (!opts.hasKey) return false;
  const s = langRoot(opts.source);
  const t = langRoot(opts.target);
  // ASL / signed languages → never DeepL
  if (s === "asl" || t === "asl" || s === "pse" || t === "pse" || s === "protactile" || t === "protactile" || s === "cdi" || t === "cdi") {
    return false;
  }
  // Both must be on the allowlist
  return DEEPL_LANGS.has(opts.source) && DEEPL_LANGS.has(opts.target)
    || (DEEPL_LANGS.has(s) && DEEPL_LANGS.has(t));
}

async function callDeepL(
  env: DeepLEnv,
  text: string,
  source: string,
  target: string
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!env.DEEPL_API_KEY) return { ok: false, error: "no DEEPL_API_KEY configured" };
  // Pick the Free endpoint by default. If the org upgrades, swap this URL.
  // DeepL Free keys end with `:fx`; treat that as the signal.
  const isFree = env.DEEPL_API_KEY.endsWith(":fx");
  const endpoint = isFree
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";

  const body = new URLSearchParams();
  body.append("text", text);
  body.append("source_lang", toDeepLCode(source));
  body.append("target_lang", toDeepLCode(target));
  body.append("preserve_formatting", "1");

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${env.DEEPL_API_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch (err) {
    return { ok: false, error: `DeepL fetch failed: ${String(err)}` };
  }
  if (!res.ok) {
    return { ok: false, error: `DeepL returned ${res.status}` };
  }
  let parsed: { translations?: Array<{ text?: string }> };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    return { ok: false, error: "DeepL returned non-JSON" };
  }
  const out = parsed.translations?.[0]?.text;
  if (typeof out !== "string") return { ok: false, error: "DeepL response missing translation" };
  return { ok: true, text: out };
}

async function callClaude(
  env: ClaudeEnv,
  text: string,
  source: string,
  target: string,
  tenantId: string
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, error: "no ANTHROPIC_API_KEY configured" };

  const system = [
    `tenant_id: ${tenantId}`, // keep prompt-cache scoped per tenant (PRD D2.5)
    "",
    "You are a professional human-quality translator working with an interpreter agency.",
    `Translate from ${source} to ${target}. Preserve paragraph breaks and any inline lists.`,
    "Return ONLY the translated text. No commentary, no notes, no quotation wrapping.",
    "The text has already been PHI-scrubbed; placeholders like [NAME], [PHONE], [DATE], [SSN], [ID] are kept verbatim.",
    "For signed-language targets (ASL, ProTactile), produce a gloss-style English notation suitable for a Deaf translator to render into video — not English prose.",
  ].join("\n");

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: text }],
      }),
    });
  } catch (err) {
    return { ok: false, error: `Claude fetch failed: ${String(err)}` };
  }
  if (!res.ok) return { ok: false, error: `Claude returned ${res.status}` };
  let parsed: { content?: Array<{ text?: string }> };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    return { ok: false, error: "Claude returned non-JSON" };
  }
  const out = parsed.content?.[0]?.text;
  if (typeof out !== "string") return { ok: false, error: "Claude response missing content" };
  return { ok: true, text: out };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
export async function handlePrefill(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }
  const session = await requireSession(req, env);
  if (!session.ok) return json({ ok: false, error: session.error }, { status: session.status });

  let body: Partial<PrefillRequest> & { document_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const source = String(body.source_lang ?? "").trim();
  const target = String(body.target_lang ?? "").trim();
  const serviceType = String(body.service_type ?? "").trim();
  const sourceText = String(body.source_text ?? "");
  if (!source || !target) {
    return json({ ok: false, error: "source_lang and target_lang required" }, { status: 400 });
  }
  if (!sourceText.trim()) {
    return json({ ok: false, error: "source_text required" }, { status: 400 });
  }

  const redacted = redactForModel(sourceText);

  // Hard-gate: medical, mental-health, legal, gov → no MT pre-fill, ever.
  if (HARD_GATED_SERVICE_TYPES.has(serviceType)) {
    const resp: PrefillResponse = {
      ok: true,
      prefill_blocked: true,
      reason: "hard-gated category",
      redaction_summary: { replacements: redacted.replacements, kinds: redacted.kinds },
    };
    return json(resp);
  }

  const envAny = env as unknown as DeepLEnv & ClaudeEnv;
  const useDeepL = shouldUseDeepL({
    source,
    target,
    hasKey: Boolean(envAny.DEEPL_API_KEY),
  });

  if (useDeepL) {
    const r = await callDeepL(envAny, redacted.text, source, target);
    if (r.ok) {
      const resp: PrefillResponse = {
        ok: true,
        translated_text: r.text,
        source: "deepl",
        redaction_summary: { replacements: redacted.replacements, kinds: redacted.kinds },
      };
      return json(resp);
    }
    // DeepL failed — fall through to Claude.
  }

  const c = await callClaude(envAny, redacted.text, source, target, session.payload.tid);
  if (!c.ok) {
    return json({ ok: false, error: c.error }, { status: 502 });
  }
  const resp: PrefillResponse = {
    ok: true,
    translated_text: c.text,
    source: "claude",
    redaction_summary: { replacements: redacted.replacements, kinds: redacted.kinds },
  };
  return json(resp);
}

export async function handleGlossary(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }
  // Glossary is non-PHI reference content; we still gate by session so it
  // isn't enumerable by anyone with the URL.
  const session = await requireSession(req, env);
  if (!session.ok) return json({ ok: false, error: session.error }, { status: session.status });

  const url = new URL(req.url);
  const source = url.searchParams.get("source") ?? "";
  const target = url.searchParams.get("target") ?? "";
  const terms = glossaryFor(source, target);
  return json({ ok: true, source, target, terms });
}

// Mount helper — index.ts calls this for any /v1/translate/* request.
export async function routeTranslate(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname === "/v1/translate/prefill") return handlePrefill(req, env);
  if (url.pathname === "/v1/translate/glossary") return handleGlossary(req, env);
  if (url.pathname.startsWith("/v1/translate/")) {
    return json({ ok: false, error: "not found" }, { status: 404 });
  }
  return null;
}
