# 1891 Interpreter — Payments Implementation Spec

**Status:** Mode A canonical since 2026-05-19. Pattern F (SaaS subscription) live since 2026-05-18.
**Owners:** Anthony Mowl (operator), Fallon Brizendine (domain SME).
**Audience:** any agent (human or AI) modifying SaaS billing, Connect OAuth reporting, or future Mode B opt-in.
**Reads first:** `~/Desktop/1891/CLAUDE.md`, `~/Desktop/1891/shared/specs/PAYMENTS.md` (the contract, esp. **Pattern G + Pattern F**), this file.

> 🚨 **Architectural pivot — 2026-05-19.** The original 2026-05-18 build wired interpreter Connect Express accounts + platform-side invoicing + platform-side transfers — i.e. **Pattern A (platform-PayFac)**. That was a wrong default. The 1891 canonical for multi-tenant products is **Mode A = Pattern F + Pattern G**:
> - **Pattern F:** agency pays 1891 a SaaS subscription (already live and tested with a $11 test charge on 2026-05-18).
> - **Pattern G:** agency connects their own Stripe via OAuth (read-only). 1891 displays their revenue / AR / payout data in the in-app dashboard. The agency runs all customer billing + contractor payouts in their own Stripe — 1891 never touches the money.
>
> Mode A means we are NOT a money transmitter. No state licensing. Lowest compliance burden. Highest leverage.
>
> The Pattern A code paths (`account.create({type:'express'})`, `invoices.send` on our key, `transfers.create`) remain in the worker, marked **deferred pending platform Connect enablement + per-tenant opt-in**. They do not run today: the platform account is `type: standard`, not a Connect platform, so any Pattern A call would 400 at Stripe.

This file documents 1891 Interpreter's Stripe implementation. The canonical pattern lives in `shared/specs/PAYMENTS.md` — this file documents how it shows up in this project.

**Three Stripe-side states this project lives in:**

1. **Pattern F live (today).** Agencies pay 1891 the platform subscription. Validated end-to-end.
2. **Pattern G ready, awaiting platform Connect enable (today).** All worker routes, Apps Script handlers, Sheet columns, and UI scaffolding exist. Won't function until Anthony enables Stripe Connect as a platform (dashboard click + terms agreement) and the `ca_…` client_id is set as a worker secret.
3. **Pattern A deferred.** Code preserved in `workers/api/src/stripe.ts` (deprecated comments mark the relevant functions). A future per-agency opt-in flow would unlock it, but that's an opt-in, not the default.

---

## 0. Status

| | |
|---|---|
| **Mode** | Live |
| **Live since** | 2026-05-18 |
| **Stripe account** | `acct_1TYabRRyhX2OZu5s` (Made By 1891) |
| **Worker URL** | `https://1891-interpreter-api.anthonymowl.workers.dev` |
| **Webhook endpoint** | `we_1TYdCARyhX2OZu5spASL0jxI` (live, 19 events subscribed) |
| **Public Checkout entry** | `https://madeby1891.com/interpreter/pricing` → `/pay/subscribe` |
| **Owners** | Anthony Mowl + Fallon Brizendine |
| **Apps Script** | scriptId `1m74_xIJtXWBw7ok_73_srlnMkfpO50TPxZEJFXBw4pTYdRQcLaBnJEwg` |

---

## 1. The flows

> **Mode map** — as of the 2026-05-19 pivot:
>
> | Flow | Mode A (canonical default) | Mode B (deferred opt-in) |
> |---|---|---|
> | §1.1 SaaS subscription (Pattern F) | ✅ **LIVE — primary revenue path** | ✅ Same shape under either mode |
> | §1.5 Connect OAuth read-only reporting (Pattern G) | ✅ **Code shipped, gated on platform Connect enable** | — (Mode B reads via direct ownership instead) |
> | §1.2 Interpreter Connect Express onboarding (Pattern A) | ❌ **DEFERRED** — agency does this in their own Stripe | ✅ Per-agency opt-in after MTL review |
> | §1.3 Payer invoice via platform Stripe (Pattern A) | ❌ **DEFERRED** — agency invoices payer from their own Stripe | ✅ Per-agency opt-in after MTL review |
> | §1.4 Payout transfer platform → interpreter (Pattern A) | ❌ **DEFERRED** — agency runs payouts from their own Stripe | ✅ Per-agency opt-in after MTL review |
>
> The §1.2–.4 code paths are intentionally preserved in the worker — they'll come back online if a future agency opts into Mode B with a money-transmitter review attached. Until then, they 400 at Stripe (platform account is `type: standard`, not a Connect platform).

This project moves money in five distinct shapes. Each gets its own ASCII diagram so the next agent doesn't have to reverse-engineer it from code.

### 1.1 SaaS subscription (agency pays 1891 for the platform)

The agency lands on the public pricing page, picks a tier + billing cadence, lands on Stripe Checkout, pays. Webhook flips their tenant row to `subscription_status='active'` and grants access to the gated features for that tier.

```
agency                                                       1891 platform
  ──────                                                       (Stripe MoR)
  │                                                                ▲
  │ visits madeby1891.com/interpreter/pricing                      │
  │                                                                │
  │ POST /v1/public/billing/checkout                               │
  │  {tier, billing, customer_email, agency_name?}                 │
  ▼                                                                │
Worker creates Checkout Session ────────────────────────► Stripe
  (mode=subscription, idempotency-keyed)                           │
  │                                                                │
  │ ◄── 303 redirect to hosted Checkout URL                        │
  │                                                                │
  │ enters card on Stripe-hosted page ─────────────────────────────┤
  │                                                                │
  │ ◄── /pay/success?session_id=…                                  │
  │                                                                │
                                                          Stripe fires webhook
                                                          → /v1/stripe/webhook
                                                          → Apps Script
                                                            payments_webhook_event
                                                          → flips Agencies row
                                                            subscription_tier=<tier>
                                                            subscription_status='active'
```

Tiers + prices live in §2.

### 1.2 Connect onboarding (interpreter 1099 payout target) — ⚠️ DEFERRED (Mode B opt-in)

Each interpreter onboards a Stripe Connect Express account, owned under our platform. We never touch a bank routing number. Stripe issues 1099-NEC at year end automatically.

```
interpreter                                              Stripe
  ──────────                                              ──────
  │                                                          ▲
  │ from /app: "Connect your bank"                           │
  │                                                          │
  │ Apps Script apiConnectAccountLink ──► Worker             │
  │ POST /v1/stripe/account/create                           │
  │  {interpreter_id, email}                                 │
  │ POST /v1/stripe/account/onboard                          │
  │  {account_id, return_url, refresh_url}                   │
  ▼                                                          │
Worker → Stripe accounts.create + accountLinks.create ──────┤
  │ ◄── url, expires_at                                      │
  │                                                          │
  │ redirected to Stripe-hosted KYC flow ────────────────────┤
  │   (legal name, DOB, SSN last 4, bank acct, 1099 info)    │
  │                                                          │
  │ ◄── return_url back to /app/me/payouts                   │
  │                                                          │
                                                  Stripe fires webhook
                                                  account.updated
                                                  → /v1/stripe/webhook
                                                  → handleWebhookEvent
                                                  → Apps Script update_interpreter
                                                    (stripe_charges_enabled,
                                                     stripe_payouts_enabled,
                                                     stripe_details_submitted)
```

Worker source: `workers/api/src/stripe.ts` → `createConnectAccount`, `createAccountLink`, `fetchAccount`.

### 1.3 Payer invoice (agency bills payer via Stripe Invoicing) — ⚠️ DEFERRED (Mode B opt-in)

The agency closes a job, builds invoice lines from the assignment ledger, and sends one Stripe Invoice to the payer (court system, hospital, school district). Payer pays; webhook flips the invoice to `paid`. This is the Pattern E inbound from `shared/specs/PAYMENTS.md` §2.4.

```
agency scheduler                                         Stripe                 payer
  ───────────────                                         ──────                ─────
  │                                                                                ▲
  │ closes Job, invoice draft assembled in Sheet                                   │
  │                                                                                │
  │ Apps Script apiInvoiceSend ──► Worker                                          │
  │ POST /v1/stripe/invoice/send                                                   │
  │  {invoice_id, payer_id, payer_email,                                           │
  │   line_items: [{description, amount_cents, quantity}]}                         │
  ▼                                                                                │
Worker → findOrCreateCustomer                                                      │
       → /v1/invoiceitems (one per line, idempotency-keyed)                        │
       → /v1/invoices (collection_method=send_invoice, days_until_due=30)          │
       → /v1/invoices/{id}/send ──────────────────────────────────────────────────►│
                                                                                   │
                                                          ◄─ Stripe emails payer ──┤
                                                                                   │
                                                          payer pays via            │
                                                          hosted_invoice_url ──────►│
                                                                                   │
                                                  Stripe fires webhook
                                                  invoice.paid / invoice.payment_succeeded
                                                  → /v1/stripe/webhook
                                                  → Apps Script mark_invoice_paid
                                                    (invoice_id, stripe_invoice_id, paid_at)
```

Worker source: `workers/api/src/stripe.ts` → `findOrCreateCustomer`, `createAndSendInvoice`.

### 1.4 Payout transfer (1891 → interpreter Connect account) — ⚠️ DEFERRED (Mode B opt-in)

After the payer pays the agency, the agency runs the payout to the interpreter. The platform fee (10% default, per `shared/specs/PAYMENTS.md` §2.4) stays on the 1891 balance.

```
1891 platform                                            Stripe                  interpreter
  ──────────────                                          ──────                ───────────
  │                                                          ▲                       ▲
  │ admin clicks "Release payout" or cron tick                                       │
  │                                                          │                       │
  │ Apps Script apiPayoutSend ──► Worker                     │                       │
  │ POST /v1/stripe/transfer/send                            │                       │
  │  {payout_id, amount_cents, destination_account}          │                       │
  ▼                                                          │                       │
Worker → /v1/transfers ───────────────────────────────────────┤                       │
  body: {amount, currency=usd, destination=acct_…,           │                       │
         metadata:{payout_id, platform=1891-interpreter}}    │                       │
  idempotency-key: transfer_<payout_id>                      │                       │
                                                  Stripe fires webhook
                                                  transfer.created → transfer.paid
                                                  → /v1/stripe/webhook
                                                  → Apps Script mark_payout_paid
                                                    (payout_id, stripe_transfer_id, paid_at)
                                                                                  │
                                          Stripe auto-pays out to interpreter ────┤
                                          bank per their configured cadence       │
                                                                                  ▼
                                                                            (bank deposit)
```

Worker source: `workers/api/src/stripe.ts` → `createTransfer`.

---

### 1.5 Agency Stripe Connect OAuth read-only reporting (Pattern G — Mode A canonical) — ⏸️ DEFERRED 2026-05-19

> **Status: code shipped + dormant. Not driving Stripe activation until a real agency asks for the reporting view.**
>
> **Why deferred** — Stripe's modern Connect onboarding blocks live-mode platform setup behind a sandbox-prototype gate ("You must set up this feature in your sandbox account before using it in your live account"). To get a live `ca_…`, the platform owner has to (a) walk through Stripe's sandbox wizard, (b) build the integration against test keys, (c) submit Connect for live activation review (Stripe's queue, hours-to-days). All for a feature with zero current customer demand. Not worth the operational tax today.
>
> **What's already shipped and waiting** — every code surface below exists in git + the deployed worker + the deployed site. Each route gracefully returns `{ok:false, status:'unconfigured'}` while `STRIPE_CONNECT_CLIENT_ID` is unset. The "Connect with Stripe" card on `/app/payments` shows a yellow "platform not enabled yet" banner. Nothing is broken; nothing is half-built.
>
> **To re-light Pattern G when a customer asks** — see "Gated on:" at the bottom of this subsection. Roughly: switch to sandbox, walk wizard, get `ca_test_…`, submit Connect for live activation, swap in live `ca_…`, set `STRIPE_CONNECT_CLIENT_ID` worker secret, retry `clasp push` for `Code_Connect.gs`, run `migrateSubscriptionsSchema()`, build the `/app/reports` UI to consume `/v1/connect/report`. Budget: ~1-2 days work + Stripe's review wait.
>
> **Added 2026-05-19 from the Mode-A pivot. See `shared/specs/PAYMENTS.md` §2.6 Pattern G for the full canonical pattern.**

The agency clicks "Connect your Stripe" in the in-app Payments tab. The platform redirects them to Stripe's OAuth consent screen with `scope=read_only`. The agency logs into their Stripe (or creates a Standard Connect account if they don't have one yet). Stripe redirects back with a `code`; the platform exchanges it for the agency's `stripe_user_id` (`acct_…`) and stamps it on the agency row. Subsequent platform calls use the platform's restricted key with the `Stripe-Account: acct_<agency>` header to pull read-only data: balance, AR, recent invoices, recent payouts.

The agency keeps merchant-of-record status. The platform never holds the agency's customer money, never issues payouts to the agency's interpreters. We are a SaaS + reporting layer.

```
agency owner               1891 platform                     Stripe
─────────────              ─────────────                     ──────
clicks "Connect" ──────►   /v1/connect/oauth/start   ──────► OAuth consent screen
                           (build URL with state=          (agency logs in / creates)
                            HMAC(tenant_id, exp))
                                                       ◄────  redirect with ?code=…&state=…
returns to               /v1/connect/oauth/callback
/connect/callback  ───►   - verify HMAC of state
                           - POST /oauth/token with code
                           - Stripe returns
                             { stripe_user_id: 'acct_…',
                               scope: 'read_only' }
                           - stamp on Agencies row

Later, for in-app reports:
                           /v1/connect/report?tenant_id=…
                            → GET /v1/balance
                              Stripe-Account: acct_…
                            → GET /v1/invoices?limit=100
                              Stripe-Account: acct_…
                            → render summary in /app/reports
```

**Scopes:** always `read_only`. Never `read_write` without a separate per-feature consent. The OAuth state is HMAC-signed (key reused from `JWT_SECRET`) with a 5-minute expiry — see PAYMENTS.md §2.6 hard rules.

**Deauthorization:** `account.application.deauthorized` event flips the Agencies row's `stripe_connect_status` to `deauthorized`. The in-app report views surface a "reconnect" prompt.

Worker source: `workers/api/src/connect.ts` → `buildOAuthStartUrl`, `exchangeOAuthCode`, `fetchAgencyReport`.
Apps Script source: `apps-script/Code_Connect.gs` → `apiAgencyConnectStart`, `apiAgencyConnectCallback`, `apiAgencyStripeReport`.

**Gated on:** Anthony enabling Connect-as-a-platform at `dashboard.stripe.com/settings/connect` (one-time terms agreement) and setting `STRIPE_CONNECT_CLIENT_ID` (`ca_…`) + `STRIPE_CONNECT_CLIENT_SECRET` as worker secrets. Until that lands, the OAuth start route returns `{status:'unconfigured'}` and the UI surfaces a "Connect not yet enabled" banner.

---

## 2. Stripe products & prices

These are **LIVE prices** on `acct_1TYabRRyhX2OZu5s`. Updates require coordination + a price-version bump in `workers/api/src/billing.ts::PRICE_CATALOG`. Do not create new prices from code; use the dashboard or the Stripe MCP and copy the IDs back.

| Tier | Stripe product | Annual price ID | Annual amount | Monthly price ID | Monthly amount |
|---|---|---|---|---|---|
| Solo | `prod_UXib0kZfbUmUrD` | `price_1TYdAiRyhX2OZu5s587CRrWw` | $108/yr | `price_1TYdAjRyhX2OZu5sO0eTxOJx` | $11/mo |
| Practice | `prod_UXibA4kI4OGdtf` | `price_1TYdAlRyhX2OZu5sZUZQabVt` | $2,988/yr | `price_1TYdAlRyhX2OZu5s7Ht18JkL` | $299/mo |
| Studio | `prod_UXib4IJPnk7pJm` | `price_1TYdApRyhX2OZu5sK8rpU7KJ` | $8,988/yr | `price_1TYdAqRyhX2OZu5sVDaRZlFS` | $899/mo |

Monthly prices are a ~20% premium over the annual equivalent (per `site/pricing.html`), nudging agencies toward annual.

The free Deaf-owned tier is not a Stripe product — those agencies get an Agencies row with `subscription_tier='free_deaf_owned'`, `subscription_status='active'`, and no `stripe_customer_id`.

Reverse-lookup helper: `tierFromPriceId(priceId)` in `billing.ts` maps a price ID back to `{tier, billing}` so webhook handlers don't have to hardcode the mapping twice.

---

## 3. Worker routes

All under `https://1891-interpreter-api.anthonymowl.workers.dev`. Source: `workers/api/src/index.ts`.

### 3.1 Public + health

| Method + Path | Purpose | Auth |
|---|---|---|
| `GET /health` | Liveness + stripe-mode banner data. Returns `{ok, service, stripe_mode: 'live'|'test'|'unconfigured'}`. | none |
| `POST /v1/public/billing/checkout` | Public Subscribe entry from `pricing.html` → `/pay/subscribe`. Rate-limited 10/5min per IP. Body: `{tier, billing, customer_email, agency_name?}`. Returns `{url, session_id, test_mode}`. | none (rate-limit only) |
| `POST /v1/stripe/webhook` | Stripe → Worker. Signature-verified via `STRIPE_WEBHOOK_SECRET`. Idempotency-checked against KV `IDEMPOTENCY`. | Stripe signature |

### 3.2 Internal — gated by `X-1891-Internal` (or `Bearer <jwt>`) matching `JWT_SECRET`

These are the routes Apps Script calls. See `workers/api/src/internal.ts` for the header contract.

| Method + Path | Purpose | Source |
|---|---|---|
| `POST /v1/billing/checkout` | Same as the public route, but authenticated (no rate limit). Used by the in-app upgrade flow. | `index.ts::handleBillingCheckoutInternal` → `billing.ts::createSubscriptionCheckoutSession` |
| `POST /v1/stripe/account/create` | Create a Connect Express account for an interpreter. Body: `{interpreter_id, email?, country?}`. | `stripe.ts::createConnectAccount` |
| `POST /v1/stripe/account/onboard` | Create an Account Link for KYC. Body: `{account_id, return_url, refresh_url}`. | `stripe.ts::createAccountLink` |
| `POST /v1/stripe/account/refresh` | Fetch latest account state from Stripe (for the polling "are we onboarded yet?" path). Body: `{account_id}`. | `stripe.ts::fetchAccount` |
| `POST /v1/stripe/transfer/send` | Payout to an interpreter Connect account. Body: `{amount_cents, destination_account, payout_id}`. Idempotency: `transfer_<payout_id>`. | `stripe.ts::createTransfer` |
| `POST /v1/stripe/invoice/send` | Create + send a Stripe Invoice to a payer. Body: `{invoice_id, payer_id, payer_email?, payer_name?, line_items[]}`. | `stripe.ts::findOrCreateCustomer` + `createAndSendInvoice` |

Reference: `index.ts::handleStripeInternal` is the dispatcher.

### 3.3 Adjacent routes (existing)

These aren't payment routes but live in the same worker; documented here so the Stripe-related debug surface is contiguous: `/v1/proxy/*`, `/interpreter-api/*`, `/v1/jobs/stream`, `/v1/jobs/ws`, `/v1/notify/job`, `/v1/translate/*`, `/v1/phi/*`, `/v1/track1099/*`, `/v1/sms/*`.

---

## 4. Apps Script actions

Apps Script is the source of truth for the Sheet ledger. The Worker is the source of truth for Stripe state. The two stay in sync via the `payments_webhook_event` action (Worker → Apps Script) and the `*_send` family (Apps Script → Worker).

### 4.1 Existing actions (in `Code_Payments.gs`)

| `action` | Handler | Purpose |
|---|---|---|
| `list_stripe_accounts` | `apiListStripeAccounts` | List interpreters + their Connect status |
| `list_1099_forms` | `apiList1099Forms` | List issued 1099-NEC forms |
| `payment_setup_status` | `apiPaymentSetupStatus` | Are Stripe / track1099 / Plaid credentials set? |
| `connect_account_link` | `apiConnectAccountLink` | Get a fresh Stripe Account Link for an interpreter |
| `connect_account_refresh` | `apiConnectAccountRefresh` | Pull latest account state from Stripe and write back |
| `invoice_send` | `apiInvoiceSend` | Build line items from a Sheet invoice + post to Worker |
| `payout_send` | `apiPayoutSend` | Run a transfer to an interpreter's Connect account |
| `issue_1099_nec` | `apiIssue1099Nec` | Issue a 1099-NEC via track1099 |
| `setup_stripe_credentials` | `apiSetupStripeCredentials` | Admin-only: store Stripe keys in Script Properties |
| `setup_track1099_credentials` | `apiSetupTrack1099Credentials` | Admin-only: store track1099 keys |
| `setup_plaid_credentials` | `apiSetupPlaidCredentials` | Admin-only: store Plaid keys |
| `mark_invoice_paid` | `apiMarkInvoicePaid` | Webhook-driven: flip Invoices row to paid |
| `mark_payout_paid` | `apiMarkPayoutPaid` | Webhook-driven: flip Payouts row to paid |
| `update_interpreter` | `apiUpdateInterpreter` | Webhook-driven: write Stripe Connect status onto Users row |

### 4.2 New actions (added by Agent C, 2026-05-18)

| `action` | Purpose | Body | Returns |
|---|---|---|---|
| `payments_webhook_event` | Bridge endpoint the Worker calls for every verified webhook. Idempotent on `event_id`. Writes a `Stripe_Events` row, then fans out to downstream Subscription / Agency writes by `event_type`. | `{event_id, event_type, livemode, created, object_id, object_type, metadata, summary, payload_excerpt}` | `{ok, handled, skipped?}` |
| `subscription_intent_url` | Mint a Stripe Checkout URL for an authenticated user who wants to upgrade from inside the app (uses internal `/v1/billing/checkout`). | `{tier, billing}` | `{ok, url, session_id}` |
| `subscription_status` | Read the calling tenant's current subscription state. | — | `{ok, tier, status, current_period_end?, cancel_at_period_end?, stripe_subscription_id?}` |
| `migrateSubscriptionsSchema` | One-shot migration (Function picker, not via `doPost`). Adds the `Subscriptions` tab, the `Stripe_Events` tab, and the `subscription_*` columns on the Agencies tab. Safe to re-run — uses `getOrCreateSheet` + missing-column append. | — | (returns status string in editor logs) |

---

## 5. Webhook events covered

Subscribed to `we_1TYdCARyhX2OZu5spASL0jxI`. All 19 events from `shared/specs/PAYMENTS.md` §7.1 are subscribed. The Worker handles each; unhandled ones still get logged to `Stripe_Events` for the forensic trail.

| Event | What this project does |
|---|---|
| `checkout.session.completed` | SaaS subscription finalized — Apps Script flips Agencies row to `subscription_status='active'`. |
| `payment_intent.succeeded` | Non-Checkout charges (e.g., one-off payer invoice paid via Stripe Invoice's hosted-payment widget). Logged. |
| `payment_intent.payment_failed` | Mark order failed. Surface a retry CTA on `/app`. |
| `charge.refunded` | Reverse internal credits. Update payer invoice + payout state. |
| `charge.dispute.created` | High-priority — Slack alert Anthony, write a row in `disputes`, surface in admin UI. |
| `charge.dispute.closed` | Update dispute outcome. |
| `account.updated` | Connect onboarding state change — flip Interpreter's `stripe_payouts_enabled`. |
| `account.application.deauthorized` | Interpreter revoked the Connect link. Mark inactive; pause future payouts. |
| `payout.paid` | Stripe paid out to interpreter's bank. Surface in their payouts dashboard. |
| `payout.failed` | Bank rejected; notify interpreter + Anthony. |
| `transfer.created` | Worker → Connect Transfer landed at Stripe. Apps Script flips Payouts row to `transferred`. |
| `transfer.reversed` | Transfer clawed back — reconcile. |
| `invoice.paid` | Payer invoice paid — flip Invoices row to `paid`, queue the payout. |
| `invoice.payment_failed` | Subscription or payer invoice failed — dunning. |
| `customer.subscription.created` | New SaaS subscription. Grant tier access. |
| `customer.subscription.updated` | Plan changed (upgrade, downgrade, cadence swap). Adjust tier access. |
| `customer.subscription.deleted` | Sub canceled. Schedule access removal at `current_period_end`. |
| `radar.early_fraud_warning.created` | Card-network fraud hint. If amount < $200 and customer unreachable, refund preemptively. |
| `invoice.payment_succeeded` | Belt-and-suspenders alias to `invoice.paid`; both map to the same handler. |

---

## 6. Schema

All schema lives in Apps Script's `getOrCreateSheet(name, headers)` calls. New columns get appended at the right edge of existing tabs (never re-ordered).

### 6.1 `Stripe_Events` tab (new)

Forensic log of every webhook event the Worker forwards. Primary idempotency lives in the Worker's KV `IDEMPOTENCY` namespace; this Sheet row is the operator-readable backup.

```
sev_id           // sev_<22 url-safe chars>
received_at      // ISO timestamp
stripe_event_id  // evt_…  (UNIQUE — second insert with same id is a no-op)
event_type       // 'invoice.paid', 'customer.subscription.created', …
livemode         // 'true' | 'false'
object_type      // 'subscription' | 'invoice' | 'transfer' | 'account' | …
object_id        // pi_… | in_… | tr_… | acct_… | sub_… | dp_… | po_… | cs_…
metadata         // JSON string of object.metadata
summary          // short human string from Worker (e.g. "Invoice paid — $2,988.00 USD")
payload_excerpt  // JSON.stringify(event.data.object) truncated to ~3000 chars
handled          // 'ok' | 'skipped' | 'error'
notes            // first 500 chars of any error
```

### 6.2 `Subscriptions` tab (new)

One row per Stripe subscription. Joins to the Agencies tab via `agency_id`.

```
id                       // sub_<22 url-safe chars> (our internal id)
created_at               // ISO timestamp
agency_id                // foreign key → Agencies.id
stripe_customer_id       // cus_…
stripe_subscription_id   // sub_…
stripe_price_id          // price_…
tier                     // 'solo' | 'practice' | 'studio'
billing                  // 'monthly' | 'annual'
status                   // 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'unpaid'
current_period_start     // ISO timestamp
current_period_end       // ISO timestamp
cancel_at_period_end     // 'true' | 'false'
canceled_at              // ISO timestamp (or blank)
last_event_id            // evt_… of the most recent webhook touching this row
updated_at               // ISO timestamp
notes
```

### 6.3 `Agencies` tab — appended columns (existing tab)

These columns get appended to the right of the existing Agencies headers:

```
subscription_tier        // 'free_deaf_owned' | 'solo' | 'practice' | 'studio' | ''
subscription_status      // 'active' | 'trialing' | 'past_due' | 'canceled' | ''
subscription_id          // our Subscriptions.id (sub_…)
stripe_customer_id       // cus_…
subscription_renews_at   // ISO timestamp = Subscriptions.current_period_end
deaf_owned_verified_at   // ISO — set when the verification board approves
```

The `migrateSubscriptionsSchema()` migration (§4.2) creates / migrates the above. Safe to re-run.

---

## 7. Secrets

| Secret | Storage | Used by | How to rotate |
|---|---|---|---|
| `STRIPE_API_KEY` | Wrangler secret on the API Worker | `workers/api/src/stripe.ts::stripeApi` | Issue new restricted key in dashboard, `wrangler secret put`, `wrangler deploy`, revoke old. |
| `STRIPE_WEBHOOK_SECRET` | Wrangler secret on the API Worker | `workers/api/src/stripe.ts::verifyWebhookSignature` | Reveal `whsec_…` on `we_1TYdCARyhX2OZu5spASL0jxI` in dashboard, `wrangler secret put`, `wrangler deploy`. |
| `JWT_SECRET` | Wrangler secret on the API Worker + Script Property `HMAC_SECRET` on Apps Script | Worker `internal.ts`, Apps Script `_payMintInternalSession` | Generate new 32-byte random, `wrangler secret put` AND update Apps Script Script Properties. Must match exactly. |
| `STRIPE_RESTRICTED_KEY` (Apps Script) | Script Property | `Code_Payments.gs::_paySettingsKeys` (currently unused in v1 — Worker is the only Stripe caller) | Script editor → Project Settings → Script Properties. |
| `TRACK1099_API_KEY`, `TRACK1099_BASE` | Wrangler secrets | `workers/api/src/track1099.ts` | Per track1099 dashboard. |

Rotation procedure reference: `shared/specs/PAYMENTS.md` §6.1. The publishable key (`pk_live_…`) is not used in this project — there's no embedded Payment Element. All card collection happens on Stripe-hosted Checkout / Invoice pages, so no `pk_` ever needs to land in committed JS.

Live restricted key scoping (per `shared/specs/PAYMENTS.md` §5.5): customers, products, prices, checkout_sessions, subscriptions, invoices, invoiceitems, accounts, account_links, transfers, refunds, payment_intents, setup_intents, payment_methods, webhook_endpoints.

---

## 8. Deploy order

The live-mode go-live procedure with exact commands lives in **`deployment/PAYMENTS_LIVE_DEPLOY.md`**. Read that before flipping any switches. The short version:

1. Set Worker secrets (`STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`) + create KV namespace.
2. `wrangler deploy` the API Worker.
3. Apps Script: run `migrateSubscriptionsSchema()` once, then the 4-click deploy.
4. `DEPLOY_WORKER=0 bash deployment/deploy.sh` for the site (worker is already deployed in step 2).
5. `bash deployment/smoke.sh` to verify.
6. End-to-end smoke: subscribe a test agency on the live pricing page.

---

## 9. Smoke checklist

After every deploy that touches `workers/api/`, `apps-script/Code_Payments.gs`, or `site/pay/`, run:

- [ ] `bash deployment/smoke.sh` → all green (covers `/health`, webhook signature reject, pricing CTA, `/pay/subscribe`, `/pay/success`).
- [ ] `curl -fsS https://1891-interpreter-api.anthonymowl.workers.dev/health | jq '.stripe_mode'` → `"live"`.
- [ ] Pricing page CTA → Stripe Checkout opens with the correct price + amount.
- [ ] Complete a $108 Solo annual subscription end-to-end with a real card OR a `4242424242424242` test card (whichever the Worker reports).
- [ ] Within 30 seconds of payment: `Stripe_Events` tab in the Sheet gains a `customer.subscription.created` row.
- [ ] Agencies row for the new agency reflects `subscription_tier='solo'`, `subscription_status='active'`, `subscription_renews_at` set.
- [ ] If a Connect onboarding URL is requested via `connect_account_link`: it opens, KYC completes, `account.updated` arrives, `Users.stripe_payouts_enabled` flips to `true`.

---

## 10. Open work

These are deliberately deferred for v1. Note them in `HANDOFF.md` as they materialize.

- **Customer portal.** Enable Stripe Customer Portal so agencies can cancel / change tier / update payment method without a support ticket. Currently agencies email `accessibility@madeby1891.com` and Anthony handles it via dashboard.
- **Pricing-tier feature gating.** The Agencies row carries `subscription_tier`, but the worker-side and Apps Script gating on per-feature limits (job count, interpreter seats, document-translation quota, BAA-tier features) is enforced ad-hoc. Centralize into a single `tierAllows(tier, feature)` helper.
- **Connect for the agency itself (Pattern B option).** If an agency wants to be the merchant-of-record (their lawyer's preference, their public-facing brand on the statement), we'd switch their invoicing path to a `direct charge on connected account` flow. Documented in `shared/specs/PAYMENTS.md` §2.3. Defer until a real customer asks.
- **Apps Script `payments_webhook_event` idempotency.** Worker KV is the primary; Apps Script de-dupes on `stripe_event_id` UNIQUE. Verify the secondary de-dupe survives a clasp-push that wipes `Stripe_Events`.
- **Multi-currency.** USD only at launch. CAD is the next-most-likely add (some Canadian Deaf-owned agencies have asked). Defer until first request.
- **Sigma daily reconciliation.** Per `shared/specs/PAYMENTS.md` §12 — wire a daily Worker cron that pulls the last 36h of charges/transfers/refunds from Stripe and compares against the Sheet, writing mismatches to `reconciliation_alerts`. Currently silent.
- **Dispute auto-evidence collection.** `shared/specs/PAYMENTS.md` §10.2 mentions auto-collecting receipts + ToS screenshots into Drive. Not built; admin currently does it by hand when a dispute lands.
