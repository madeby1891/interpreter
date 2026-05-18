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

export { JobBoardRoom };

export interface Env {
  APPS_SCRIPT_URL: string;
  ALLOWED_ORIGIN: string;
  JWT_SECRET: string;
  JOB_BOARD_ROOM: DurableObjectNamespace;
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

  return withCors(json({ ok: false, error: "not found" }, { status: 404 }), req, cfg);
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
