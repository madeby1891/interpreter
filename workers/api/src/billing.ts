// SaaS subscription billing — Stripe Checkout flow.
//
// Scope: the public pricing page redirects the visitor to `/pay/subscribe`,
// which posts to the Worker. The Worker creates a Stripe Checkout Session in
// `mode=subscription` and returns the hosted Checkout URL. The visitor is
// redirected to Stripe, completes payment, and lands back on `/pay/success`.
// Stripe fires `checkout.session.completed` + `customer.subscription.created`
// to the existing /v1/stripe/webhook handler (Agent B owns that side).
//
// We deliberately do NOT pull in the Stripe SDK — matches stripe.ts style.
// stripeApi() from stripe.ts is the only HTTP helper used here.
//
// Price IDs are frozen — the Stripe products + prices were provisioned ahead
// of this build. Do NOT create new prices from code; reverse-lookup with
// tierFromPriceId() if you only have a price ID coming back from a webhook.

import { stripeApi, type StripeEnv, type StripeError } from "./stripe";

// ---------------------------------------------------------------------------
// Price catalog (live Stripe IDs — Made By 1891 acct_1TYabRRyhX2OZu5s)
// ---------------------------------------------------------------------------

export type Tier = "solo" | "practice" | "studio";
export type Billing = "monthly" | "annual";

export const PRICE_CATALOG: Readonly<Record<Tier, Readonly<Record<Billing, string>>>> = Object.freeze({
  solo: Object.freeze({
    annual: "price_1TYdAiRyhX2OZu5s587CRrWw",   // $108/yr
    monthly: "price_1TYdAjRyhX2OZu5sO0eTxOJx",  // $11/mo
  }),
  practice: Object.freeze({
    annual: "price_1TYdAlRyhX2OZu5sZUZQabVt",   // $2,988/yr
    monthly: "price_1TYdAlRyhX2OZu5s7Ht18JkL",  // $299/mo
  }),
  studio: Object.freeze({
    annual: "price_1TYdApRyhX2OZu5sK8rpU7KJ",   // $8,988/yr
    monthly: "price_1TYdAqRyhX2OZu5sVDaRZlFS",  // $899/mo
  }),
});

// Single source of truth for where Stripe sends the user post-Checkout.
// Use SUCCESS_URL_BASE + '/success?session_id={CHECKOUT_SESSION_ID}' / '/cancel'.
export const SUCCESS_URL_BASE = "https://madeby1891.com/interpreter/pay";

// ---------------------------------------------------------------------------
// Reverse lookup: price ID → { tier, billing }
// ---------------------------------------------------------------------------

export interface TierLookup {
  tier: Tier;
  billing: Billing;
}

export function tierFromPriceId(priceId: string): TierLookup | null {
  if (!priceId) return null;
  for (const tier of Object.keys(PRICE_CATALOG) as Tier[]) {
    for (const billing of Object.keys(PRICE_CATALOG[tier]) as Billing[]) {
      if (PRICE_CATALOG[tier][billing] === priceId) return { tier, billing };
    }
  }
  return null;
}

export function isTier(v: unknown): v is Tier {
  return v === "solo" || v === "practice" || v === "studio";
}

export function isBilling(v: unknown): v is Billing {
  return v === "monthly" || v === "annual";
}

// ---------------------------------------------------------------------------
// Idempotency key — bucket by 5 minutes so a click-spam doesn't open N sessions
// ---------------------------------------------------------------------------

async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-1", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i]!.toString(16);
    hex += h.length === 1 ? "0" + h : h;
  }
  return hex;
}

function fiveMinuteBucket(now: number = Date.now()): number {
  return Math.floor(now / (5 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Stripe Checkout Session — subscription mode
// ---------------------------------------------------------------------------

export interface CheckoutSession {
  id: string;
  object: "checkout.session";
  url: string;
  mode: "subscription";
  customer_email?: string;
  metadata?: Record<string, string>;
}

export interface CreateSubscriptionParams {
  tier: Tier;
  billing: Billing;
  customer_email: string;
  agency_name?: string;
}

/**
 * Create a Stripe Checkout Session for a 1891 Interpreter subscription.
 *
 * Returns the session object (with `.url` to redirect to) or a StripeError.
 * Idempotency: keyed on tier+billing+sha1(email)+5min-bucket so a double-click
 * within the same 5-minute window returns the same session rather than two.
 */
export async function createSubscriptionCheckoutSession(
  env: StripeEnv,
  params: CreateSubscriptionParams
): Promise<CheckoutSession | StripeError> {
  const tier = params.tier;
  const billing = params.billing;
  if (!isTier(tier)) {
    return { ok: false, error: "invalid tier", status: "bad_request" };
  }
  if (!isBilling(billing)) {
    return { ok: false, error: "invalid billing", status: "bad_request" };
  }
  const email = String(params.customer_email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { ok: false, error: "valid customer_email required", status: "bad_request" };
  }
  const priceId = PRICE_CATALOG[tier][billing];
  if (!priceId) {
    return { ok: false, error: "no price for tier/billing", status: "bad_request" };
  }

  const emailHash = await sha1Hex(email);
  const bucket = fiveMinuteBucket();
  const idempotencyKey = `subscribe:${tier}:${billing}:${emailHash}:${bucket}`;

  const metadata: Record<string, string> = {
    project: "interpreter",
    tier: tier,
    billing: billing,
  };
  if (params.agency_name) {
    // Trim and cap — Stripe metadata values are limited to 500 chars per key.
    metadata.agency_name = String(params.agency_name).trim().slice(0, 500);
  }

  // Human-readable tier name for invoice description + email subject lines.
  const tierName = tier.charAt(0).toUpperCase() + tier.slice(1);
  const billingLabel = billing === "annual" ? "annual" : "monthly";
  const subscriptionDescription = `1891 Interpreter — ${tierName} plan (billed ${billingLabel})`;
  const invoiceFooter =
    `Questions about this invoice? Email contact@madeby1891.com or visit ` +
    `https://madeby1891.com/interpreter. Manage your subscription any time ` +
    `from the link in your receipt — change plan, update card, or cancel.`;

  return stripeApi<CheckoutSession>(env, "/checkout/sessions", {
    method: "POST",
    body: {
      mode: "subscription",
      customer_email: email,
      line_items: [
        { price: priceId, quantity: 1 },
      ],
      success_url: `${SUCCESS_URL_BASE}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SUCCESS_URL_BASE}/cancel`,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      // automatic_tax is OFF until head_office is set in Stripe Tax settings
      // and we register in any state that actually taxes interpreting services
      // (HI, NM, SD per E_billing.md §E6.1; MD does not). Flip to true once
      // Stripe Tax status is "active" and a per-state nexus has registered.
      // automatic_tax: { enabled: true },
      // Brand-clear subscription description renders on the Stripe-generated
      // invoice PDF + the receipt email, replacing the default "Subscription
      // creation" stub with something the customer actually recognizes.
      // The footer + brand color come from account.settings.invoices (set
      // separately via the Stripe API at deploy time).
      subscription_data: {
        metadata,
        description: subscriptionDescription,
      },
      metadata,
    },
    idempotencyKey,
  });
}
