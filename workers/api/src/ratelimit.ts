// ratelimit.ts — KV-backed sliding-window throttle, keyed per IP and route.
//
// Adapted from workers/identity-broker/src/ratelimit.ts. Two differences:
//   1. It reuses this Worker's existing IDEMPOTENCY KV binding (no new
//      namespace, no wrangler.toml change) under an `rl:` key prefix so the
//      rate-limit counters can't collide with the Stripe webhook idempotency
//      log that also lives in that namespace.
//   2. It fails OPEN — if the KV binding is missing or a get/put throws, the
//      request is allowed. A throttle that hard-fails a real lead is worse
//      than a throttle that occasionally lets one extra request through.
//
// Routes (public, unauthenticated marketing-form hops):
//   - lead: 5/min, 30/hour   (form submissions — generous enough for a
//                             typo→retry, tight enough to stop a flood)
//   - mail: 3/min, 10/hour   (magic-link / auth_request — each one sends an
//                             email, so this is the costliest public hop)
//
// Implementation: two counter keys per (route, ip) — a 1-minute and a
// 60-minute window. Each key holds a JSON counter incremented with put();
// `expirationTtl` handles eviction. Not a true atomic sliding window — at our
// traffic level we don't need one. If we ever cross ~100 RPS, move to a DO.

import type { Env } from "./index";

interface Counter {
  count: number;
  reset_at: number; // seconds since epoch
}

export type RouteKey = "lead" | "mail";

const LIMITS: Record<RouteKey, { perMin: number; perHour: number }> = {
  lead: { perMin: 5, perHour: 30 },
  mail: { perMin: 3, perHour: 10 },
};

/**
 * clientIp — best-effort caller IP. Cloudflare always sets CF-Connecting-IP
 * at the edge; X-Forwarded-For is the fallback for the local test harness /
 * `wrangler dev`. Empty → a single shared "unknown" bucket so a header-less
 * caller can't get an unlimited per-request reset.
 */
export function clientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ||
    (req.headers.get("X-Forwarded-For") || "").split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * checkRate — returns `{ ok: true }` if `ip` is within both windows for
 * `route`, else `{ ok: false, retry_after: <seconds> }`. Fails OPEN on a
 * missing binding or any KV error.
 *
 * Caller is responsible for sending a 429 with a `Retry-After` header.
 */
export async function checkRate(
  ip: string,
  env: Env,
  route: RouteKey,
): Promise<{ ok: true } | { ok: false; retry_after: number }> {
  const kv = env.IDEMPOTENCY;
  if (!kv) return { ok: true }; // fail open — no binding wired

  const now = Math.floor(Date.now() / 1000);
  const limits = LIMITS[route];

  const minKey = `rl:${route}:min:${ip}`;
  const hourKey = `rl:${route}:hour:${ip}`;

  try {
    const [minRaw, hourRaw] = await Promise.all([kv.get(minKey), kv.get(hourKey)]);

    const min = parseCounter(minRaw, now, 60);
    const hour = parseCounter(hourRaw, now, 3600);

    if (min.count >= limits.perMin) {
      return { ok: false, retry_after: Math.max(1, min.reset_at - now) };
    }
    if (hour.count >= limits.perHour) {
      return { ok: false, retry_after: Math.max(1, hour.reset_at - now) };
    }

    min.count++;
    hour.count++;

    await Promise.all([
      kv.put(minKey, JSON.stringify(min), {
        expirationTtl: Math.max(60, min.reset_at - now),
      }),
      kv.put(hourKey, JSON.stringify(hour), {
        expirationTtl: Math.max(60, hour.reset_at - now),
      }),
    ]);

    return { ok: true };
  } catch (err) {
    console.error("ratelimit KV error (failing open)", route, String(err));
    return { ok: true };
  }
}

function parseCounter(raw: string | null, now: number, windowSec: number): Counter {
  if (!raw) return { count: 0, reset_at: now + windowSec };
  try {
    const c = JSON.parse(raw) as Counter;
    if (typeof c.count !== "number" || typeof c.reset_at !== "number" || c.reset_at < now) {
      return { count: 0, reset_at: now + windowSec };
    }
    return c;
  } catch {
    return { count: 0, reset_at: now + windowSec };
  }
}
