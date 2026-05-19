# Payments — Agent B notes (Worker webhook + Apps Script bridge)

Last touched: 2026-05-18 by Agent B.

This file is the cross-agent handoff for the Stripe webhook flow. Agents A
(Checkout), C (Apps Script schema), and D (deploy/docs) should read this before
shipping their pieces.

## What the Worker now does

`POST /v1/stripe/webhook` (route already wired in `workers/api/src/index.ts`)
runs this pipeline for every Stripe delivery:

1. Read raw bytes (no JSON parse before sig check).
2. Verify `Stripe-Signature` against `STRIPE_WEBHOOK_SECRET` (existing
   HMAC-SHA256 v1 implementation in `stripe.ts`).
3. If `env.IDEMPOTENCY.get(event.id)` returns a value → respond
   `200 { received: true, idempotent: true, action: <type> }` and stop.
   If the binding is missing, log a warning once per isolate and continue.
4. Normalize the event into a flat string→string map (see "Bridge payload"
   below) and POST it to Apps Script as
   `?action=payments_webhook_event`. A 60s worker JWT (`purpose='stripe_webhook'`)
   is attached as the `session` param.
5. On success → `env.IDEMPOTENCY.put(event.id, '1', { expirationTtl: 7d })`,
   respond `200 { received: true, ok: true, action: <type>, apps_script: ... }`.
6. If `handleWebhookEvent` throws → respond `500` so Stripe retries.

## The 19 events the worker handles

Listed in `SUBSCRIBED_EVENTS` (exported from `stripe.ts` and surfaced in
`/health` as `webhook_events: 19`):

```
checkout.session.completed
payment_intent.succeeded
payment_intent.payment_failed
charge.refunded
charge.dispute.created           ← also console.error("STRIPE DISPUTE", …)
charge.dispute.closed
account.updated                  ← also forwards details_submitted, payouts_enabled,
                                   charges_enabled, requirements_currently_due
account.application.deauthorized
payout.paid
payout.failed
transfer.created
transfer.reversed
transfer.canceled
invoice.paid
invoice.payment_failed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
radar.early_fraud_warning.created ← also console.error("STRIPE EARLY FRAUD WARNING", …)
```

Unrecognized event types are still forwarded — Apps Script writes a
Stripe_Events row regardless. We'd rather 200 every retry than block Stripe.

## Bridge payload (what Apps Script will receive)

Every forwarded event posts URL-encoded form body to:

```
POST <APPS_SCRIPT_URL>?action=payments_webhook_event
Content-Type: application/x-www-form-urlencoded
X-1891-Internal: <JWT_SECRET>
```

Body params (all values are strings; multi-value structures are JSON-stringified):

| param | example | notes |
|---|---|---|
| `action` | `payments_webhook_event` | matches the URL query param |
| `session` | `<worker-issued JWT>` | 60s TTL, `purpose='stripe_webhook'`. Verify with `_verifyWorkerJwt`. |
| `event_id` | `evt_3OqXgT2eZvKYlo2C…` | de-dupe on this column on the AS side |
| `event_type` | `invoice.paid` | one of the 19 (or "some.random.event" for unknowns) |
| `livemode` | `true` \| `false` | string |
| `created` | `1700000000` | Stripe unix timestamp, stringified |
| `object_id` | `in_1Ox…`, `pi_3O…`, `acct_1T…`, `cs_test_…` | extracted from `event.data.object.id` |
| `object_type` | `invoice`, `payment_intent`, `account`, … | from `event.data.object.object` |
| `metadata` | `{"our_invoice_id":"inv_abc"}` | JSON-stringified flat string→string map |
| `summary` | `"Invoice paid — $125.00 USD"` | short human string for log views |
| `payload_excerpt` | `{"id":"in_TEST",…}` | `JSON.stringify(event.data.object)` capped to ~3000 chars; suffix `…[truncated]` if cut |

Additional params **only** on `account.updated`:

| param | example | notes |
|---|---|---|
| `details_submitted` | `true` \| `false` | from `event.data.object.details_submitted` |
| `payouts_enabled` | `true` \| `false` | |
| `charges_enabled` | `true` \| `false` | |
| `requirements_currently_due` | `["external_account"]` | JSON-stringified array, omitted if absent |

Response expected from Apps Script: `{ ok: true, … }` (or `{ ok: false, error: ... }`).
The Worker forwards whatever it gets back into its own response body under
`apps_script`. The Worker does NOT re-throw on AS errors, so AS returning
`{ ok: false }` still 200s back to Stripe (event is recorded as forwarded).
If AS becomes unreachable, the Worker's call returns `{ ok: false, error: 'apps_script_unreachable' }`
but we still 200 Stripe — KV records the event as seen, so we won't loop on retries.

## What Agent C needs to build

Register a new Apps Script action handler:

```js
function apiPaymentsWebhookEvent(params) {
  // params is the URL-decoded form body; values are strings.
  // 1. Verify worker JWT (existing _verifyWorkerJwt(params.session, 'stripe_webhook')).
  // 2. Idempotency: SELECT from Stripe_Events WHERE event_id = params.event_id.
  //    If a row exists → return { ok: true, idempotent: true }.
  // 3. Insert a Stripe_Events row with all columns above (plus a received_at stamp).
  // 4. Dispatch downstream by event_type:
  //    - invoice.paid → flip BrokerInvoices/Subscriptions row to paid
  //    - customer.subscription.* → update Tenants.subscription_status, current_period_end
  //    - account.updated → write to Interpreters.stripe_* columns (use the
  //                        first-class params, not metadata JSON parsing)
  //    - charge.dispute.created → high-priority alert (Mail.send or Slack)
  //    - …etc.
  // 5. Return { ok: true }.
}
```

Suggested Sheet schema for `Stripe_Events` tab (Agent C owns the final
column list — this is a starter):

```
event_id (PK), event_type, livemode, created_iso, received_at_iso,
object_id, object_type, metadata_json, summary, payload_excerpt
```

## What Agent A needs to know

- `/health` now returns `webhook_events: 19` alongside Agent A's `stripe_mode`.
  Both fields coexist; the `AGENT_B_ADDED:` comment marker is in place.
- The webhook handler in `index.ts` was refactored to surround `handleWebhookEvent`
  with idempotency + try/catch. Agent A's `createSubscriptionCheckoutSession`
  path is unaffected — they're separate routes.

## What Agent D needs to know

Before `wrangler deploy` of the new build:

1. Create the KV namespaces:
   ```
   npx wrangler kv namespace create 1891-interpreter-idempotency
   npx wrangler kv namespace create 1891-interpreter-idempotency --preview
   ```
2. Paste the two ids into `workers/api/wrangler.toml`'s `[[kv_namespaces]]`
   block (currently `<placeholder>` for both `id` and `preview_id`).
3. Ensure `STRIPE_WEBHOOK_SECRET` (already-provisioned `whsec_…` for
   `https://1891-interpreter-api.anthonymowl.workers.dev/v1/stripe/webhook`)
   is set:
   ```
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```
4. Smoke test post-deploy: hit `/health` and verify
   `{"ok":true,"service":"1891-interpreter-api","stripe_mode":"…","webhook_events":19}`.

## Files touched by Agent B

- `workers/api/wrangler.toml` — added `[[kv_namespaces]]` block with placeholders.
- `workers/api/src/index.ts` — `Env.IDEMPOTENCY?: KVNamespace`; `/health` adds
  `webhook_events`; `handleStripeWebhook` adds KV-backed idempotency and
  try/catch around `handleWebhookEvent`.
- `workers/api/src/stripe.ts` — `handleWebhookEvent` rewritten as a normalizer
  → single-action bridge; exported `SUBSCRIBED_EVENTS`; top-of-file contract
  comment added.
- `workers/api/tests/stripe.test.ts` — webhook event-router tests rewritten
  for the new bridge payload (was: `mark_invoice_paid` / `mark_payout_paid`).

`npx tsc --noEmit` passes; `npx vitest run` passes (90/90 tests).
