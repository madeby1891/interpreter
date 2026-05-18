// Tests for the JobBoardRoom Durable Object — focused on broadcast semantics
// and tenant isolation. We exercise the DO class directly with a fake
// DurableObjectState; the worker top-level handler `handleSubscribe` derives
// the DO id from `tenant:${tid}`, so each tenant lands on a distinct DO
// instance and a broadcast sent to tenant A's DO can never reach a
// subscriber connected to tenant B's DO.

import { describe, it, expect } from "vitest";
import { JobBoardRoom } from "../src/durable/JobBoardRoom";

function makeState(): DurableObjectState {
  // The DO ctor only stores the state; we don't exercise persisted storage
  // here. A minimal stub is enough.
  return {} as unknown as DurableObjectState;
}

describe("JobBoardRoom — broadcast", () => {
  it("delivers the broadcast payload to every connected SSE subscriber", async () => {
    const room = new JobBoardRoom(makeState(), { JWT_SECRET: "x" });

    const sub = await (room as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
      new Request("https://room/subscribe/sse?_uid=u1")
    );
    expect(sub.status).toBe(200);
    expect(sub.headers.get("Content-Type")).toMatch(/text\/event-stream/);

    const reader = sub.body!.getReader();
    // First frame is the `hello` event.
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value!)).toContain("event: hello");

    const bcast = await (room as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
      new Request("https://room/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "job.created", data: { job_id: "j_abc" } }),
      })
    );
    expect(bcast.status).toBe(200);
    const result = (await bcast.json()) as { ok: boolean; delivered: number };
    expect(result.ok).toBe(true);
    expect(result.delivered).toBeGreaterThanOrEqual(1);

    // Next frame on the stream should carry our broadcast.
    const next = await reader.read();
    const text = new TextDecoder().decode(next.value!);
    expect(text).toContain("event: job.created");
    expect(text).toContain("j_abc");

    // Hygiene: cancel so the stream releases its lock + heartbeat timer.
    await reader.cancel();
  });

  it("rejects non-POST broadcasts", async () => {
    const room = new JobBoardRoom(makeState(), { JWT_SECRET: "x" });
    const res = await (room as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
      new Request("https://room/broadcast", { method: "GET" })
    );
    expect(res.status).toBe(405);
  });

  it("rejects malformed broadcast JSON", async () => {
    const room = new JobBoardRoom(makeState(), { JWT_SECRET: "x" });
    const res = await (room as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
      new Request("https://room/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("isolates tenants: a broadcast on tenant-A's DO does not touch tenant-B's DO", async () => {
    // Two separate DO instances stand in for the two tenant rooms. The worker
    // routes a tenant to its DO by id (idFromName(`tenant:${tid}`)), so the
    // DO instances are always distinct. We assert the broadcast on one
    // doesn't deliver to subscribers on the other.
    const roomA = new JobBoardRoom(makeState(), { JWT_SECRET: "x" });
    const roomB = new JobBoardRoom(makeState(), { JWT_SECRET: "x" });

    const fA = (roomA as unknown as { fetch: (r: Request) => Promise<Response> }).fetch.bind(roomA);
    const fB = (roomB as unknown as { fetch: (r: Request) => Promise<Response> }).fetch.bind(roomB);

    const subA = await fA(new Request("https://room/subscribe/sse?_uid=ua"));
    const subB = await fB(new Request("https://room/subscribe/sse?_uid=ub"));

    const rA = subA.body!.getReader();
    const rB = subB.body!.getReader();

    // Consume each room's hello frame.
    await rA.read();
    await rB.read();

    // Broadcast on room A only.
    const bcast = await fA(
      new Request("https://room/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "job.created", data: { job_id: "j_only_a" } }),
      })
    );
    const out = (await bcast.json()) as { delivered: number };
    expect(out.delivered).toBe(1);

    // Room A's reader sees the broadcast.
    const aNext = await rA.read();
    expect(new TextDecoder().decode(aNext.value!)).toContain("j_only_a");

    // Room B's reader sees nothing for tenant A; we race a short timeout
    // against rB.read() and expect the timeout to win.
    const raced = await Promise.race([
      rB.read().then((r) => ({ kind: "data" as const, value: r.value })),
      new Promise<{ kind: "timeout" }>((res) =>
        setTimeout(() => res({ kind: "timeout" }), 50)
      ),
    ]);
    expect(raced.kind).toBe("timeout");

    await rA.cancel();
    await rB.cancel();
  });
});
