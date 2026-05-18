// CORS helpers. We intentionally allow a single origin (the marketing site)
// plus localhost for dev. Anything else gets a bare 200/4xx without the
// Access-Control-Allow-* headers, which is the correct way to reject in CORS.

export interface CorsConfig {
  allowedOrigin: string;
  allowedMethods?: string;
  allowedHeaders?: string;
  maxAge?: number;
}

const DEV_ORIGINS = new Set([
  "http://localhost:8080",
  "http://localhost:5173",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:5173",
]);

export function resolveOrigin(reqOrigin: string | null, allowed: string): string | null {
  if (!reqOrigin) return null;
  if (reqOrigin === allowed) return reqOrigin;
  if (DEV_ORIGINS.has(reqOrigin)) return reqOrigin;
  return null;
}

export function corsHeaders(reqOrigin: string | null, cfg: CorsConfig): Headers {
  const h = new Headers();
  const origin = resolveOrigin(reqOrigin, cfg.allowedOrigin);
  if (origin) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
  }
  h.set("Access-Control-Allow-Methods", cfg.allowedMethods ?? "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", cfg.allowedHeaders ?? "Content-Type, Authorization");
  h.set("Access-Control-Max-Age", String(cfg.maxAge ?? 600));
  return h;
}

export function handlePreflight(req: Request, cfg: CorsConfig): Response {
  const headers = corsHeaders(req.headers.get("Origin"), cfg);
  return new Response(null, { status: 204, headers });
}

export function withCors(res: Response, req: Request, cfg: CorsConfig): Response {
  const cors = corsHeaders(req.headers.get("Origin"), cfg);
  const merged = new Headers(res.headers);
  cors.forEach((v, k) => merged.set(k, v));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: merged });
}
