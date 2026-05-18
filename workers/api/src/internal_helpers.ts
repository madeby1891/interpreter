// Tiny shared helpers used by stripe.ts / track1099.ts / index.ts.
// Lives in its own file to avoid a cycle between internal.ts and the API
// clients.

/**
 * Drop undefined values from an object, recursively. Stripe's form encoder
 * tolerates undefined; track1099's JSON body is happier without them.
 */
export function stripUndef<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = stripUndef(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
