// Server-Sent Events helpers.
//
// SSE is the simpler fallback when WebSocket isn't available. The connection
// stays open and we write framed text events as JSON.

export interface SseEvent {
  // Event ID (optional, used by the browser's EventSource to resume).
  id?: string;
  // Event name (defaults to "message" on the client side).
  event?: string;
  // The payload. We JSON-encode objects.
  data: unknown;
  // Optional retry hint (ms) the client uses to back off.
  retry?: number;
}

const ENCODER = new TextEncoder();

export function frameEvent(ev: SseEvent): Uint8Array {
  const lines: string[] = [];
  if (ev.id) lines.push(`id: ${ev.id}`);
  if (ev.event) lines.push(`event: ${ev.event}`);
  if (typeof ev.retry === "number") lines.push(`retry: ${ev.retry}`);
  const data = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
  // Multi-line data must repeat the "data:" prefix per line.
  for (const line of data.split("\n")) lines.push(`data: ${line}`);
  lines.push("", ""); // blank line terminates the event
  return ENCODER.encode(lines.join("\n"));
}

export function sseResponse(stream: ReadableStream, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("Connection", "keep-alive");
  // Disable Cloudflare buffering so events flush in real time.
  headers.set("X-Accel-Buffering", "no");
  return new Response(stream, { status: 200, headers });
}
