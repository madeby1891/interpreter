// 1891 Interpreter — Payments live-mode go-live runbook
# Payments — Live-mode Go-Live Runbook

**Audience:** Anthony Mowl. You run these steps in order. Agents prep the script; you run it.
**Status:** First run 2026-05-18. Reuse this runbook every time a payments secret rotates or the Worker / Apps Script payments code changes.
**Read first:** `~/Desktop/1891/CLAUDE.md`, `docs/PAYMENTS_IMPL.md`.

---

## 1. Set Worker secrets + create KV namespace

Open a fresh terminal in the worker dir. Paste the `whsec_…` value from the chat where the agent shared it.

```bash
cd ~/Desktop/1891/projects/interpreter/workers/api

# Restricted live key (rk_live_…) — see PAYMENTS_IMPL.md §7 for scope.
npx wrangler secret put STRIPE_API_KEY
# > paste live restricted key, press enter

# Webhook signing secret for we_1TYdCARyhX2OZu5spASL0jxI.
npx wrangler secret put STRIPE_WEBHOOK_SECRET
# > paste whsec_… value: <PASTE FROM CHAT>

# KV namespace for inbound-webhook idempotency. Capture the IDs in the output,
# then paste them into wrangler.toml (both `id` and `preview_id`).
npx wrangler kv namespace create 1891-interpreter-idempotency
npx wrangler kv namespace create 1891-interpreter-idempotency --preview
```

After the two `kv namespace create` calls, open `workers/api/wrangler.toml` and replace both `<placeholder>` strings under `[[kv_namespaces]]` with the IDs Wrangler printed.

Now deploy:

```bash
npx wrangler deploy
```

Verify the deployment:

```bash
curl -fsS https://1891-interpreter-api.anthonymowl.workers.dev/health | jq .
# expect: {"ok":true,"service":"1891-interpreter-api","stripe_mode":"live"}
```

If `stripe_mode` is `"unconfigured"` the `STRIPE_API_KEY` didn't land — re-run `wrangler secret put STRIPE_API_KEY` and re-deploy.

---

## 2. Apps Script — run the migration + 4-click deploy

Open the script editor:

> 🚨 **Anthony — the script:** `https://script.google.com/d/1m74_xIJtXWBw7ok_73_srlnMkfpO50TPxZEJFXBw4pTYdRQcLaBnJEwg/edit`

In the editor:

1. From the function picker (top toolbar), choose **`migrateSubscriptionsSchema`** and click **Run**. This creates the `Subscriptions` and `Stripe_Events` tabs and appends the new `subscription_*` columns to the Agencies tab. Safe to re-run if the migration was already partially applied.
2. **Deploy → Manage deployments → ✏️ pencil → "New version" → Deploy.** This is the 4-click flow that cannot be automated (Material listboxes require trusted clicks). The agent who pushed the code already wrote it to disk via clasp; you're just publishing the new version.

---

## 3. Site deploy (worker already up — don't re-deploy it here)

```bash
DEPLOY_WORKER=0 bash ~/Desktop/1891/projects/interpreter/deployment/deploy.sh
```

This rsyncs `site/` to GoDaddy. The `DEPLOY_WORKER=0` is the default but pass it explicitly so the next operator reading this script knows the option exists.

---

## 4. Smoke test

```bash
bash ~/Desktop/1891/projects/interpreter/deployment/smoke.sh
```

All checks must be green. The new payments-specific checks are at the bottom (worker `/health`, webhook signature rejection, pricing CTA presence, `/pay/subscribe` reachable, `/pay/success` reachable).

If a webhook signature check fails with anything other than HTTP 400, the worker isn't reading `STRIPE_WEBHOOK_SECRET` correctly — re-run `wrangler secret put STRIPE_WEBHOOK_SECRET` and `wrangler deploy`.

---

## 5. End-to-end verification (manual, real card)

Use a real card on a real address — this is **live mode**. The first run is intentionally a small charge so the dispute window isn't scary.

1. Open `https://madeby1891.com/interpreter/pricing` in a **Chrome incognito window** (so you're not signed in as an admin).
2. Click **Subscribe annually** on the **Solo** tier ($108/yr).
3. Stripe Checkout opens. Pay with a real card. (If by some chance the worker is still in test mode — `/health` reports `stripe_mode: "test"` — use `4242 4242 4242 4242` instead. The smoke step above should have already caught that.)
4. You should land on `/pay/success?session_id=cs_…` within 5 seconds of the payment landing at Stripe.
5. **Within 30 seconds**, open the agency Google Sheet and check:
   - **`Stripe_Events` tab** — there's a new row with `event_type='customer.subscription.created'` (and likely a `checkout.session.completed` row too). `handled='ok'`.
   - **`Subscriptions` tab** — new row with the agency, `tier='solo'`, `billing='annual'`, `status='active'`, `current_period_end` 365 days out.
   - **`Agencies` tab** — the row for this agency now shows `subscription_tier='solo'`, `subscription_status='active'`, `subscription_renews_at` populated, `stripe_customer_id` populated.
6. Confirm the Stripe receipt email arrived at the email you used at Checkout.
7. (Optional) Test cancel: in the Stripe dashboard, cancel the subscription. Within 30 seconds, `Stripe_Events` should gain a `customer.subscription.deleted` row and the Agencies row should reflect `subscription_status='canceled'`.

---

## 6. Rollback

If something goes sideways in steps 2–5:

- **Roll the worker back:** `cd ~/Desktop/1891/projects/interpreter/workers/api && npx wrangler rollback`. Stripe-side state (the subscription Stripe holds) is unaffected.
- **Refund the test charge:** dashboard → Payments → click the charge → Refund full. Stripe re-emails a refund receipt automatically.
- **Disable the webhook endpoint** (do this only if events are firing and the worker is misbehaving): dashboard → Developers → Webhooks → `we_1TYdCARyhX2OZu5spASL0jxI` → "Disable endpoint." Re-enable after fix; Stripe will retry the queued events.

Document the incident in `HANDOFF.md` and `DISASTER_RECOVERY.md` if anything beyond a "small bug, fixed, re-deployed" played out.

---

## 7. What "done" looks like

- `curl -fsS https://1891-interpreter-api.anthonymowl.workers.dev/health` → `stripe_mode: "live"`.
- `bash deployment/smoke.sh` → all green.
- A real subscription has been created end-to-end and reflected in the Sheet.
- `HANDOFF.md` is updated with the "Payments — live as of 2026-05-18" entry.
