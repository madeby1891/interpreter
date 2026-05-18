// CORS proxy for the Apps Script web app.
//
// Apps Script web apps return:
//   - 302 redirect to script.googleusercontent.com
//   - the JSON body at that follow-up URL
//   - no Access-Control-Allow-Origin headers (this is why we exist)
//
// Workers can follow redirects server-side, so we just `fetch(..., { redirect: "follow" })`
// and rewrap the response with our own CORS headers.

export interface ProxyOptions {
  appsScriptUrl: string;
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
