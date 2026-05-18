// JobBoardRoom — one Durable Object per tenant.
//
// Responsibilities:
//  1. Hold the live set of subscribers (WebSocket + SSE) for a tenant.
//  2. Accept a JWT-authed upgrade and add the connection to the room.
//  3. Accept a server-to-server `/broadcast` POST (HMAC-protected via JWT_SECRET)
//     and fan the event out to every connection.
//
// Why a DO? Workers are edge-distributed and stateless. A DO gives us a single
// authoritative instance per tenant where every subscriber for that tenant
// converges, so a single broadcast reaches every subscriber.
//
// Naming: `tenant:<tid>` — the DO id is derived via idFromName(`tenant:${tid}`).

import { frameEvent, sseResponse, type SseEvent } from "../sse";

interface Env {
  JWT_SECRET: string;
}

interface SseSubscriber {
  kind: "sse";
  controller: ReadableStreamDefaultController<Uint8Array>;
  uid: string;
}

interface WsSubscriber {
  kind: "ws";
  socket: WebSocket;
  uid: string;
}

type Subscriber = SseSubscriber | WsSubscriber;

export class JobBoardRoom {
  private subscribers = new Set<Subscriber>();
  private heartbeatTimer: number | null = null;

  constructor(_state: DurableObjectState, _env: Env) {
    // We intentionally do not persist subscriber state — it is connection-bound
    // and a DO restart drops all sockets anyway.
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/subscribe/sse":
        return this.handleSseSubscribe(req);
      case "/subscribe/ws":
        return this.handleWsSubscribe(req);
      case "/broadcast":
        return this.handleBroadcast(req);
      case "/stats":
        return new Response(
          JSON.stringify({ ok: true, count: this.subscribers.size }),
          { headers: { "Content-Type": "application/json" } }
        );
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private handleSseSubscribe(req: Request): Response {
    const url = new URL(req.url);
    const uid = url.searchParams.get("_uid") ?? "anon";
    const self = this;
    let sub: SseSubscriber;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        sub = { kind: "sse", controller, uid };
        self.subscribers.add(sub);
        controller.enqueue(frameEvent({ event: "hello", data: { ok: true, uid } }));
        self.ensureHeartbeat();
      },
      cancel() {
        if (sub) self.subscribers.delete(sub);
      },
    });

    return sseResponse(stream);
  }

  private handleWsSubscribe(req: Request): Response {
    const upgrade = req.headers.get("Upgrade") ?? "";
    if (upgrade.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(req.url);
    const uid = url.searchParams.get("_uid") ?? "anon";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const sub: WsSubscriber = { kind: "ws", socket: server, uid };
    this.subscribers.add(sub);
    this.ensureHeartbeat();

    server.addEventListener("close", () => this.subscribers.delete(sub));
    server.addEventListener("error", () => this.subscribers.delete(sub));

    try {
      server.send(JSON.stringify({ event: "hello", data: { ok: true, uid } }));
    } catch {
      // ignore — close event will clean up
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleBroadcast(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ ok: false, error: "bad json" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const ev: SseEvent = {
      event: (payload as { event?: string }).event ?? "message",
      data: (payload as { data?: unknown }).data ?? payload,
    };
    const sseFrame = frameEvent(ev);
    const wsFrame = JSON.stringify({ event: ev.event, data: ev.data });

    let delivered = 0;
    for (const sub of [...this.subscribers]) {
      try {
        if (sub.kind === "sse") {
          sub.controller.enqueue(sseFrame);
        } else {
          sub.socket.send(wsFrame);
        }
        delivered++;
      } catch {
        this.subscribers.delete(sub);
      }
    }

    return new Response(JSON.stringify({ ok: true, delivered }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    // Comment-only SSE heartbeat every 25s keeps intermediaries from closing
    // an idle connection. WebSocket has its own ping frames.
    const tick = () => {
      if (this.subscribers.size === 0) {
        this.heartbeatTimer = null;
        return;
      }
      const beat = new TextEncoder().encode(": keepalive\n\n");
      for (const sub of [...this.subscribers]) {
        if (sub.kind !== "sse") continue;
        try {
          sub.controller.enqueue(beat);
        } catch {
          this.subscribers.delete(sub);
        }
      }
      this.heartbeatTimer = setTimeout(tick, 25_000) as unknown as number;
    };
    this.heartbeatTimer = setTimeout(tick, 25_000) as unknown as number;
  }
}
