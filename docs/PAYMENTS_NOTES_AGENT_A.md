# Payments — Agent A notes (subscription Checkout flow)

Written during the 4-agent parallel build. Glue these together with Agents B/C/D's notes before final docs land in `HANDOFF.md` + `docs/E_billing.md`.

## What I shipped

| Path | Purpose |
| --- | --- |
| `workers/api/src/billing.ts` | `PRICE_CATALOG`, `createSubscriptionCheckoutSession()`, `tierFromPriceId()`, `SUCCESS_URL_BASE`. Pure HTTP, no SDK. |
| `workers/api/src/index.ts` | Added imports + 3 things: `stripe_mode` on `/health`; internal route `POST /v1/billing/checkout`; **public** route `POST /v1/public/billing/checkout` (rate-limited, no auth). |
| `site/pay/subscribe.html` | Public marketing-side form. Reads `?tier=&billing=` query params, posts to public worker route, redirects to Stripe Checkout URL. |
| `site/pay/success.html` | Landing after Stripe Checkout. Shows session_id if present, plain-English next-steps. |
| `site/pay/cancel.html` | Cancel landing. Friendly "no charge" copy + link back to pricing. |
| `site/assets/js/payments-config.js` | `window.IntPayments = { workerBase, publishableKey: '' }`. Anthony fills in `pk_live_*` post-deploy. |
| `site/pricing.html` | Replaced 3 paid-tier "Get a demo" CTAs with `Subscribe annually` + `Or monthly` + "Get a demo first" tertiary link. Deaf-Owned + Network rows unchanged. |

## Public worker route

`POST https://1891-interpreter-api.anthonymowl.workers.dev/v1/public/billing/checkout`

- **No auth header.** Per-IP token bucket: 10 checkouts / 5 min / `CF-Connecting-IP`. In-memory only; isolate cycles reset it. Acceptable risk because the worst an abuser can do is open Stripe Checkout sessions (no charges land without card entry on Stripe's side).
- **Body (JSON):** `{ tier: 'solo'|'practice'|'studio', billing: 'monthly'|'annual', customer_email, agency_name? }`.
- **Response:** `{ ok: true, url, session_id, test_mode }` or `{ ok: false, error }` (400 / 429 / 502).
- **Unconfigured path:** if `STRIPE_API_KEY` is unset, returns `stripeUnconfigured()` shape (200, `ok:false`, `status:'unconfigured'`). The subscribe page surfaces a "NOT CONFIGURED" banner.

The mirror internal route `POST /v1/billing/checkout` exists too (same parser + handler, `X-1891-Internal` gated). Use that when an authenticated app surface needs to upgrade a tenant.

## Things downstream agents should know

1. **Subscription metadata.** Every Checkout session includes `metadata: { project:'interpreter', tier, billing, agency_name? }`. The same metadata is mirrored onto `subscription_data.metadata` so it ends up on the resulting Subscription object. Agent B's webhook handler can read `tier`/`billing`/`agency_name` directly off `event.data.object.metadata` for both `checkout.session.completed` and `customer.subscription.*`.
2. **Reverse lookup.** `tierFromPriceId(priceId)` returns `{ tier, billing } | null` — Agent B can use this if the webhook payload only has the price ID.
3. **Idempotency.** `subscribe:<tier>:<billing>:<sha1(email)>:<5min-bucket>` — same params within 5 minutes return the same Checkout Session URL. The bucket isn't a hard rate limit (use the IP token bucket for that); it's a click-spam guard.
4. **`/health` shape.** I added `stripe_mode: 'live'|'test'|'unconfigured'`. Agent B added `webhook_events: <count>` alongside it — both coexist. The `/pay/*` pages only read `stripe_mode`.
5. **Stripe Customer Portal.** Not wired here. Recommend Agent D adds a Customer Portal config in the Stripe dashboard so the receipt email's "Manage subscription" link works (PAYMENTS.md §9 dark-pattern rule).
6. **`automatic_tax: { enabled: true }`** is on. Stripe will refuse if the account doesn't have Tax registered — Agent D should confirm Tax is enabled for `acct_1TYabRRyhX2OZu5s` or flip this to `false` until it is.
7. **`pk_live_*` placeholder.** `site/assets/js/payments-config.js` ships with `publishableKey: ''`. Until Anthony fills it in, the subscribe page still works (hosted Checkout doesn't need it); only matters once we embed Stripe Elements.

## Open questions

- Does Agent C's Apps Script schema have a `Subscriptions` tab? When Agent B's `checkout.session.completed` handler fires, it needs a row to write. If not, the metadata-only path is fine for v1 (we can backfill from Stripe at any time).
- The Network tier remains "Talk to us" (no Checkout). Confirm with Anthony that the Network tier should NOT be subscribable directly — current pricing.html keeps it pointed at `/contact`.
- Should we add a hidden test-mode publishable + a `?test=1` URL param for QA? Not in scope here; defer to Agent D's deploy plan.

## Verification

- `npx tsc --noEmit` in `workers/api/` is clean.
- No edits to `handleWebhookEvent`, `verifyWebhookSignature`, or anything in `# Webhook` blocks of `stripe.ts` (Agent B territory).
- No edits to `apps-script/*` (Agent C territory).
- No `wrangler deploy` (Agent D territory).
