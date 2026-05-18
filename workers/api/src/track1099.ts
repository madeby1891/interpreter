// track1099 API client.
//
// track1099 (https://www.track1099.com) is a flat REST service that handles
// IRS e-file + recipient mailing for 1099-NEC / 1099-MISC / 1099-K. The PRD
// (E10 #3) recommends always routing 1099 issuance through them rather than
// building IRS FIRE / IRIS plumbing ourselves.
//
// We DO NOT depend on a track1099 SDK (there isn't one in any maintained
// form). API is documented at https://www.track1099.com/info/api_v2 — token
// auth via `Authorization: <token>` header.
//
// Test-mode: track1099 has a sandbox base. We honor the TRACK1099_BASE env
// override; default to live.

import { stripUndef } from "./internal_helpers";

export interface Track1099Env {
  TRACK1099_API_KEY?: string;
  TRACK1099_BASE?: string;
}

export interface Track1099Error {
  ok: false;
  error: string;
  status?: "unconfigured" | "track1099_error";
  http_status?: number;
}

export function unconfigured(): Track1099Error {
  return {
    ok: false,
    error: "track1099 not configured. Set TRACK1099_API_KEY via `wrangler secret put TRACK1099_API_KEY`.",
    status: "unconfigured",
  };
}

export function isConfigured(env: Track1099Env): boolean {
  return Boolean(env.TRACK1099_API_KEY);
}

function baseUrl(env: Track1099Env): string {
  return env.TRACK1099_BASE ?? "https://www.track1099.com/api/v2";
}

async function track1099Api<T = unknown>(
  env: Track1099Env,
  path: string,
  init: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: Record<string, unknown> } = {}
): Promise<T | Track1099Error> {
  if (!isConfigured(env)) return unconfigured();
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: env.TRACK1099_API_KEY!,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (init.body) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(stripUndef(init.body));
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl(env)}${path}`, { method, headers, body });
  } catch (err) {
    return { ok: false, error: "track1099_unreachable", status: "track1099_error", http_status: undefined };
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return {
      ok: false,
      error: "track1099_non_json",
      status: "track1099_error",
      http_status: res.status,
    };
  }
  if (!res.ok) {
    const obj = parsed as { error?: string; message?: string };
    return {
      ok: false,
      error: obj?.error ?? obj?.message ?? "track1099_http_error",
      status: "track1099_error",
      http_status: res.status,
    };
  }
  return parsed as T;
}

// ---------------------------------------------------------------------------
// 1099-NEC create
// ---------------------------------------------------------------------------

export interface Form1099Input {
  payer_id_in_track1099?: string;         // track1099 payer record (the agency)
  tax_year: number;
  recipient: {
    name: string;
    tin: string;          // SSN or EIN; we accept formatted "***-**-1234" → strip dashes on send
    tin_type?: "SSN" | "EIN";
    email?: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    zip: string;
    country?: string;
  };
  // 1099-NEC has one main box: Box 1 nonemployee comp.
  nonemployee_comp_cents: number;
  // Backup withholding (24%) if Stripe TIN-match failed (PRD E4.3).
  federal_income_tax_withheld_cents?: number;
  // Our internal correlation ID — interpreter row in this tenant.
  interpreter_id: string;
  tenant_id: string;
}

export interface Form1099Created {
  id: string;
  status: string;          // 'created' | 'queued' | 'e-filed' | 'mailed' etc.
  tax_year: number;
}

export async function createNec1099(
  env: Track1099Env,
  input: Form1099Input
): Promise<Form1099Created | Track1099Error> {
  // track1099's create-form endpoint takes the form-type as a path segment.
  return track1099Api<Form1099Created>(env, "/1099_nec/forms", {
    method: "POST",
    body: {
      tax_year: input.tax_year,
      payer_id: input.payer_id_in_track1099,
      recipient: {
        name: input.recipient.name,
        tin: input.recipient.tin.replace(/\D/g, ""),
        tin_type: input.recipient.tin_type ?? "SSN",
        email: input.recipient.email,
        address1: input.recipient.address1,
        address2: input.recipient.address2,
        city: input.recipient.city,
        state: input.recipient.state,
        zip: input.recipient.zip,
        country: input.recipient.country ?? "US",
      },
      // track1099 takes dollars-as-cents on the `_cents` fields per their v2 docs
      // (or dollars on the bare fields). We send cents for predictability.
      nonemployee_compensation_cents: input.nonemployee_comp_cents,
      federal_income_tax_withheld_cents: input.federal_income_tax_withheld_cents ?? 0,
      metadata: {
        interpreter_id: input.interpreter_id,
        tenant_id: input.tenant_id,
        platform: "1891-interpreter",
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Form fetch (for status polling)
// ---------------------------------------------------------------------------

export interface Form1099Status {
  id: string;
  status: string;
  tax_year: number;
  recipient_name?: string;
  efile_status?: string;
  mail_status?: string;
}

export async function getForm(
  env: Track1099Env,
  formId: string
): Promise<Form1099Status | Track1099Error> {
  return track1099Api<Form1099Status>(env, `/forms/${encodeURIComponent(formId)}`, {
    method: "GET",
  });
}
