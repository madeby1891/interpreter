// CORS proxy for the Apps Script web app.
//
// Apps Script web apps return:
//   - 302 redirect to script.googleusercontent.com
//   - the JSON body at that follow-up URL
//   - no Access-Control-Allow-Origin headers (this is why we exist)
//
// Workers can follow redirects server-side, so we just `fetch(..., { redirect: "follow" })`
// and rewrap the response with our own CORS headers.
//
// Origin gate (Security review, abuse hardening): the rewrap above hands a
// CORS-cleared response back to the browser, but CORS only protects what a
// *browser* will read — it does nothing against a scripted client that posts
// directly. So before forwarding a write (POST), we require the request to
// carry an Origin (or Referer) whose origin is on our allowlist, and reject
// header-less POSTs outright. GET reads (incl. header-less JSONP) are left
// alone — they're idempotent and the response-layer CORS check still governs
// what a cross-site page can actually read.

export interface ProxyOptions {
  appsScriptUrl: string;
  // The site origin allowed to POST through this proxy (env.ALLOWED_ORIGIN).
  // POSTs whose Origin/Referer origin isn't this (or a known dev origin) get
  // a 403 before we forward anything upstream.
  allowedOrigin: string;
  // Optional path suffix to forward as ?_path=, useful if you start using
  // a hierarchy of Apps Script doPost handlers. Not required today.
  pathSuffix?: string;
}

const FORWARD_REQUEST_HEADERS = new Set([
  "content-type",
  "accept",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
  "keep-alive",
  // Strip any incoming CORS header — we set our own.
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-max-age",
  "vary",
]);

// Dev origins permitted to POST during local testing. Kept in sync with the
// DEV_ORIGINS set in cors.ts so the server-side gate and the response-layer
// CORS check agree on what "allowed" means.
const DEV_ORIGINS = new Set([
  "http://localhost:8080",
  "http://localhost:5173",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:5173",
]);

// Extract the origin (scheme://host[:port]) from an Origin or Referer header
// value. Returns null if absent or unparseable. The Origin header is already
// just an origin; Referer is a full URL, so we normalize via URL().
function headerOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function originAllowed(origin: string | null, allowedOrigin: string): boolean {
  if (!origin) return false;
  if (origin === allowedOrigin) return true;
  if (DEV_ORIGINS.has(origin)) return true;
  return false;
}

export async function proxyToAppsScript(
  req: Request,
  opts: ProxyOptions
): Promise<Response> {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Server-side origin gate for writes. A browser always sends Origin on a
  // cross-origin POST; if neither Origin nor Referer resolves to an allowed
  // origin (or the POST carries no such header at all), refuse before we touch
  // the backend. GET is exempt so JSONP reads and same-origin no-Origin reads
  // keep working.
  if (method === "POST") {
    const claimed =
      headerOrigin(req.headers.get("Origin")) ??
      headerOrigin(req.headers.get("Referer"));
    if (!originAllowed(claimed, opts.allowedOrigin)) {
      return new Response(
        JSON.stringify({ ok: false, error: "Origin not allowed" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  const incomingUrl = new URL(req.url);
  const target = new URL(opts.appsScriptUrl);
  // Preserve every incoming query param.
  incomingUrl.searchParams.forEach((v, k) => target.searchParams.append(k, v));

  const forwardHeaders = new Headers();
  req.headers.forEach((v, k) => {
    if (FORWARD_REQUEST_HEADERS.has(k.toLowerCase())) forwardHeaders.set(k, v);
  });

  const init: RequestInit = {
    method,
    headers: forwardHeaders,
    redirect: "follow",
  };
  if (method === "POST") {
    // Stream-passthrough; URLSearchParams bodies come through as text/plain.
    init.body = await req.clone().arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), init);
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: "Upstream fetch failed", detail: String(err) }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) responseHeaders.set(k, v);
  });
  if (!responseHeaders.has("Content-Type")) {
    responseHeaders.set("Content-Type", "application/json");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
