/**
 * 1891 Interpreter — Stripe subscription state + webhook bridge (Apps Script).
 *
 * Mirrors the FDT bridge contract in `projects/fairytale-dreamers/FDT Web
 * Assets/docs/PAYMENTS_IMPL.md §3.4`. The Cloudflare Worker (Agent B) is the
 * Stripe signature verifier + canonical receiver; this file owns:
 *
 *   1. Idempotent forensic log of every event the Worker forwards (Stripe_Events).
 *   2. Subscription state per agency tenant (Subscriptions + Agencies columns).
 *   3. Downstream Sheet writes triggered by individual event types
 *      (Connect onboarding refresh, payout/transfer status, invoice paid…).
 *   4. Public-checkout helper that proxies marketing-page hops to the Worker.
 *   5. Read-side endpoint that surfaces the current tenant's subscription
 *      state to the in-app UI.
 *
 * Tabs touched:
 *   - Stripe_Events    (created here, forensic event log)
 *   - Subscriptions    (created here, one row per stripe_subscription_id)
 *   - Agencies         (extended here, six new columns appended)
 *   - Invoices         (status updates from invoice.paid / .payment_failed)
 *   - Payouts          (status updates from transfer/payout events)
 *   - Interpreters     (Connect onboarding flags from account.updated)
 *
 * Audit-log policy: Stripe_Events IS the forensic log for inbound events, so
 * webhook arrivals don't double-log to Audit_Log. State changes derived from
 * a webhook (subscription tier flip, payout marked paid, …) DO write an
 * Audit_Log row with tenant_id = the affected row's tenant.
 *
 * NEVER log card PANs, SSNs, full bank-account numbers. Stripe payloads don't
 * carry them, but if a stray SSN pattern slips into `payload_excerpt` we
 * redact before writing the row.
 *
 * Routes registered in `Code.gs`:
 *   POST action=payments_webhook_event   → apiPaymentsWebhookEvent
 *   POST action=subscription_intent_url  → apiSubscriptionIntentUrl  (public)
 *   GET  action=subscription_intent_url  → apiSubscriptionIntentUrl  (JSONP)
 *   GET  action=subscription_status      → apiSubscriptionStatus     (session)
 *
 * Operator: after deploying this file, run `migrateSubscriptionsSchema()` from
 * the Apps Script editor once. It's idempotent — safe to re-run.
 */

// ============================================================================
// CONSTANTS
// ============================================================================

var SUB_T = {
  StripeEvents: 'Stripe_Events',
  Subscriptions: 'Subscriptions'
};

var SUB_EVENT_HEADERS = [
  'event_id', 'received_at', 'event_type', 'object_id', 'object_type',
  'livemode', 'metadata_json', 'summary', 'payload_excerpt',
  'handled', 'handler_notes'
];

var SUB_SUBSCRIPTION_HEADERS = [
  'id', 'created_at', 'agency_id', 'stripe_customer_id', 'stripe_subscription_id',
  'tier', 'billing_interval', 'price_id', 'status', 'current_period_end',
  'cancel_at_period_end', 'trial_end', 'billing_email', 'source',
  'updated_at', 'notes'
];

// Columns appended (idempotent) to the existing Agencies tab.
var SUB_AGENCY_COLS = [
  'stripe_customer_id',
  'subscription_tier',
  'subscription_status',
  'subscription_price_id',
  'current_period_end',
  'billing_email'
];

// Live Stripe price IDs → tier + billing_interval. Source of truth lives in
// the Worker (`workers/api/src/billing.ts:PRICE_CATALOG`). Keep these two
// tables in lock-step — the brief includes them verbatim.
var SUB_PRICE_TO_TIER = {
  // Solo
  'price_1TYdAiRyhX2OZu5s587CRrWw': { tier: 'solo',     billing_interval: 'annual'  },
  'price_1TYdAjRyhX2OZu5sO0eTxOJx': { tier: 'solo',     billing_interval: 'monthly' },
  // Practice
  'price_1TYdAlRyhX2OZu5sZUZQabVt': { tier: 'practice', billing_interval: 'annual'  },
  'price_1TYdAlRyhX2OZu5s7Ht18JkL': { tier: 'practice', billing_interval: 'monthly' },
  // Studio
  'price_1TYdApRyhX2OZu5sK8rpU7KJ': { tier: 'studio',   billing_interval: 'annual'  },
  'price_1TYdAqRyhX2OZu5sVDaRZlFS': { tier: 'studio',   billing_interval: 'monthly' }
};

var SUB_VALID_TIERS = {
  free_deaf_owned: true, solo: true, practice: true,
  studio: true, network: true, none: true
};

var SUB_VALID_STATUSES = {
  trialing: true, active: true, past_due: true,
  canceled: true, incomplete: true, none: true
};

// Where dispute / EFW notifications land. Per Code.gs:
// NOTIFY_EMAIL = 'hello@madeby1891.com', SECURITY_NOTIFY = 'security@…'.
// Disputes are time-critical → SECURITY_NOTIFY (Anthony's monitored alias).

// ============================================================================
// SCHEMA MIGRATION — public, idempotent
// ============================================================================

/**
 * Operator runs this once from the Apps Script editor after deploy.
 * Idempotent — re-running is safe. Returns a summary so the operator can
 * confirm what was touched.
 */
function migrateSubscriptionsSchema() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var events = getOrCreateStripeEventsSheet_(ss);
  var subs = getOrCreateSubscriptionsSheet_(ss);
  var agencyReport = extendAgenciesSchema_(ss);
  var report = {
    stripe_events_tab: events.getName(),
    subscriptions_tab: subs.getName(),
    agencies_columns_appended: agencyReport.appended,
    agencies_columns_already_present: agencyReport.already_present
  };
  _logAudit('subscriptions.schema_migrated', 'host', 'system', JSON.stringify(report));
  return report;
}

function getOrCreateStripeEventsSheet_(ss) {
  return _getOrCreateSheet(ss, SUB_T.StripeEvents, SUB_EVENT_HEADERS);
}

function getOrCreateSubscriptionsSheet_(ss) {
  return _getOrCreateSheet(ss, SUB_T.Subscriptions, SUB_SUBSCRIPTION_HEADERS);
}

/**
 * Append the six subscription columns to Agencies if they aren't already
 * present. Never reorder or rewrite existing headers. Returns
 * { appended: [...], already_present: [...] }.
 */
function extendAgenciesSchema_(ss) {
  var sh = ss.getSheetByName(T.Agencies);
  if (!sh) {
    // First-time bootstrap may not have created Agencies yet — make it.
    sh = _ensureTab(ss, T.Agencies, _tenantSchema().Agencies);
  }
  var lastCol = sh.getLastColumn() || 1;
  var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var appended = [];
  var alreadyPresent = [];
  for (var i = 0; i < SUB_AGENCY_COLS.length; i++) {
    var col = SUB_AGENCY_COLS[i];
    if (hdr.indexOf(col) >= 0) {
      alreadyPresent.push(col);
      continue;
    }
    var idx = sh.getLastColumn() + 1;
    sh.getRange(1, idx).setValue(col).setFontWeight('bold');
    hdr.push(col);
    appended.push(col);
  }
  return { appended: appended, already_present: alreadyPresent };
}

// ============================================================================
// WEBHOOK BRIDGE — apiPaymentsWebhookEvent
// ============================================================================

/**
 * Receives one forwarded Stripe event from the Cloudflare Worker (after the
 * Worker has verified the Stripe signature).
 *
 * Auth: `_requireSessionOrWorker(e, 'stripe_webhook')`. Apps Script can't read
 * inbound HTTP headers, so the Worker authenticates via a 60-second worker
 * JWT minted with the shared HMAC secret, passed as `session=<jwt>`. This is
 * the same pattern used by `apiMarkInvoicePaid` and `apiMarkPayoutPaid`.
 *
 * Idempotency: a Stripe_Events row keyed on `event_id` is the durable seen-set.
 * If we've already logged this event, we short-circuit with
 * `{ ok:true, idempotent_skip:true }`.
 *
 * Routing: dispatched by `event_type`; unknown types still log to
 * Stripe_Events with `handled='unhandled'` and return ok so Stripe doesn't
 * retry forever.
 */
function apiPaymentsWebhookEvent(e) {
  var auth = _requireSessionOrWorker(e, 'stripe_webhook');
  if (!auth.ok) return _json({ ok: false, error: auth.error }, 401);
  if (!auth.is_worker) {
    // Defensive: this endpoint is worker-only. A user session with a stolen
    // session token shouldn't be able to forge Stripe events into the log.
    return _json({ ok: false, error: 'worker-only endpoint' }, 403);
  }

  var p = (e && e.parameter) || {};
  var eventId = String(p.event_id || '').trim();
  if (!eventId) return _json({ ok: false, error: 'event_id required' });
  var eventType = String(p.event_type || '').trim();
  if (!eventType) return _json({ ok: false, error: 'event_type required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var eventsSh = getOrCreateStripeEventsSheet_(ss);

  // Idempotency probe — scan the existing rows for this event_id.
  if (_subEventAlreadyLogged_(eventsSh, eventId)) {
    return _json({ ok: true, idempotent_skip: true, event_id: eventId });
  }

  // Parse metadata (worker forwards JSON-stringified). Tolerate bad JSON.
  var metadata = {};
  if (p.metadata) {
    try { metadata = JSON.parse(String(p.metadata)) || {}; }
    catch (_) { metadata = {}; }
  }
  var payloadExcerpt = _subRedactPayload_(String(p.payload_excerpt || ''));
  var livemode = String(p.livemode || '');
  var summary = String(p.summary || '');
  var objectId = String(p.object_id || '');
  var objectType = String(p.object_type || '');
  var receivedAt = new Date().toISOString();

  // Insert the forensic row with handled='pending'; we'll patch handled/notes
  // after the handler runs so callers see the final state.
  eventsSh.appendRow([
    eventId, receivedAt, eventType, objectId, objectType,
    livemode, JSON.stringify(metadata), summary, payloadExcerpt,
    'pending', ''
  ]);
  var rowNum = eventsSh.getLastRow();

  // Dispatch.
  var ctx = {
    ss: ss,
    eventId: eventId,
    eventType: eventType,
    objectId: objectId,
    objectType: objectType,
    metadata: metadata,
    livemode: livemode,
    summary: summary,
    payloadExcerpt: payloadExcerpt,
    rawParams: p
  };
  var outcome;
  try {
    outcome = _subDispatchEvent_(ctx);
  } catch (err) {
    outcome = { handled: 'error', notes: 'handler_threw: ' + String(err) };
  }

  _subStampEventOutcome_(eventsSh, rowNum, outcome.handled || 'ok', outcome.notes || '');

  return _json({
    ok: true,
    action: eventType,
    handled: outcome.handled || 'ok',
    notes: outcome.notes || ''
  });
}

function _subEventAlreadyLogged_(sh, eventId) {
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return false;
  var hdr = data[0];
  var iId = hdr.indexOf('event_id');
  if (iId < 0) return false;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) === eventId) return true;
  }
  return false;
}

function _subStampEventOutcome_(sh, rowNum, handled, notes) {
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var iHandled = hdr.indexOf('handled');
  var iNotes = hdr.indexOf('handler_notes');
  if (iHandled >= 0) sh.getRange(rowNum, iHandled + 1).setValue(handled);
  if (iNotes >= 0 && notes) sh.getRange(rowNum, iNotes + 1).setValue(notes);
}

/**
 * Redact obvious SSN-shaped substrings from payload excerpts before they hit
 * the Sheet. Stripe doesn't send SSNs in event payloads, but the excerpt is
 * an unstructured truncation of `event.data.object` — paranoia is cheap.
 * `last4` / `brand` on card objects is safe to keep; we don't touch those.
 */
function _subRedactPayload_(s) {
  if (!s) return '';
  return s.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]');
}

// ============================================================================
// DISPATCH TABLE
// ============================================================================

function _subDispatchEvent_(ctx) {
  switch (ctx.eventType) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return _subHandleSubscriptionEvent_(ctx);

    case 'checkout.session.completed':
      return _subHandleCheckoutCompleted_(ctx);

    case 'invoice.paid':
      return _subHandleInvoicePaid_(ctx);

    case 'invoice.payment_failed':
      return _subHandleInvoicePaymentFailed_(ctx);

    case 'account.updated':
      return _subHandleAccountUpdated_(ctx);

    case 'account.application.deauthorized':
      return _subHandleAccountDeauthorized_(ctx);

    case 'transfer.created':
      return _subHandleTransferCreated_(ctx);

    case 'transfer.reversed':
    case 'transfer.canceled':
      return _subHandleTransferReversed_(ctx);

    case 'payout.paid':
    case 'payout.failed':
      return _subHandlePayoutStatusChange_(ctx);

    case 'charge.refunded':
      return _subHandleChargeRefunded_(ctx);

    case 'charge.dispute.created':
    case 'charge.dispute.closed':
      return _subHandleDispute_(ctx);

    case 'radar.early_fraud_warning.created':
      return _subHandleEarlyFraudWarning_(ctx);

    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
      // v1: log only. The invoice / charge sibling events drive state.
      return { handled: 'ok', notes: 'logged; no state mutation' };

    default:
      return { handled: 'unhandled', notes: 'no handler for ' + ctx.eventType };
  }
}

// ============================================================================
// HANDLER — customer.subscription.{created,updated,deleted}
// ============================================================================

/**
 * Upsert a row in Subscriptions keyed on `stripe_subscription_id`. Also pushes
 * tier/status/price_id/current_period_end to the matching Agencies row by
 * `stripe_customer_id`. If no Agencies row matches, the Subscriptions row
 * still gets written and we leave a `handler_notes` breadcrumb for manual
 * reconcile.
 */
function _subHandleSubscriptionEvent_(ctx) {
  var ss = ctx.ss;
  var meta = ctx.metadata || {};

  // Pull the subscription fields we care about. The Worker doesn't currently
  // forward these in first-class form, so we parse them out of payload_excerpt
  // where we can. Failing that, we fall back to metadata + sane defaults.
  var sub = _subParseSubscriptionFromExcerpt_(ctx.payloadExcerpt);
  var subscriptionId = ctx.objectId || (sub.id || '');
  if (!subscriptionId) {
    return { handled: 'error', notes: 'subscription_id missing from event' };
  }
  var customerId = sub.customer || meta.customer || '';
  var priceId = sub.price_id || meta.price_id || '';
  var status = sub.status || 'incomplete';
  if (ctx.eventType === 'customer.subscription.deleted') status = 'canceled';
  var currentPeriodEnd = sub.current_period_end || meta.current_period_end || '';
  var cancelAtPeriodEnd = sub.cancel_at_period_end != null
    ? sub.cancel_at_period_end
    : (meta.cancel_at_period_end === 'true');
  var trialEnd = sub.trial_end || '';

  // Derive tier from the price_id.
  var derived = priceId && SUB_PRICE_TO_TIER[priceId] ? SUB_PRICE_TO_TIER[priceId] : null;
  var tier = derived ? derived.tier : (meta.tier || 'none');
  var billingInterval = derived ? derived.billing_interval : (meta.billing || '');
  if (!SUB_VALID_TIERS[tier]) tier = 'none';
  if (!SUB_VALID_STATUSES[status]) status = 'incomplete';

  // Best-effort agency match by stripe_customer_id.
  var agencyMatch = _subFindAgencyByCustomerId_(ss, customerId);
  var agencyId = agencyMatch ? agencyMatch.tenantId : '';
  var billingEmail = sub.customer_email || meta.billing_email ||
    (agencyMatch ? agencyMatch.billing_email : '');

  // Upsert into Subscriptions.
  var subsSh = getOrCreateSubscriptionsSheet_(ss);
  var existing = _subFindSubscriptionRow_(subsSh, subscriptionId);
  var nowIso = new Date().toISOString();
  if (existing) {
    _subWriteSubscriptionRow_(subsSh, existing.row, existing.hdr, {
      stripe_customer_id: customerId,
      tier: tier,
      billing_interval: billingInterval,
      price_id: priceId,
      status: status,
      current_period_end: currentPeriodEnd,
      cancel_at_period_end: cancelAtPeriodEnd,
      trial_end: trialEnd,
      billing_email: billingEmail || existing.row_obj.billing_email,
      agency_id: agencyId || existing.row_obj.agency_id,
      updated_at: nowIso
    });
  } else {
    subsSh.appendRow([
      _ulid('sub'),                // id
      nowIso,                      // created_at
      agencyId,                    // agency_id
      customerId,                  // stripe_customer_id
      subscriptionId,              // stripe_subscription_id
      tier,                        // tier
      billingInterval,             // billing_interval
      priceId,                     // price_id
      status,                      // status
      currentPeriodEnd,            // current_period_end
      Boolean(cancelAtPeriodEnd),  // cancel_at_period_end
      trialEnd,                    // trial_end
      billingEmail,                // billing_email
      'stripe_webhook',            // source
      nowIso,                      // updated_at
      ''                           // notes
    ]);
  }

  // Patch the Agencies row if we matched one.
  if (agencyMatch) {
    _subWriteAgencyFields_(ss, agencyMatch, {
      subscription_tier: tier,
      subscription_status: status,
      subscription_price_id: priceId,
      current_period_end: currentPeriodEnd
    });
    if (billingEmail && !agencyMatch.row_obj.billing_email) {
      _subWriteAgencyFields_(ss, agencyMatch, { billing_email: billingEmail });
    }
    _logAudit('subscription.' + ctx.eventType.split('.').pop(),
              agencyId, 'worker:stripe_webhook',
              subscriptionId + ' tier=' + tier + ' status=' + status);
    return { handled: 'ok', notes: 'agency=' + agencyId + ' tier=' + tier };
  }

  // Orphan — write a breadcrumb so the operator can reconcile.
  return {
    handled: 'ok',
    notes: 'no matching tenant — orphan subscription, needs reconcile (customer=' + customerId + ')'
  };
}

/**
 * Parse the subset of subscription fields we care about out of
 * `payload_excerpt`. The Worker truncates at 3000 chars, so this is best-
 * effort; missing fields are returned as undefined and the caller falls back
 * to metadata.
 */
function _subParseSubscriptionFromExcerpt_(excerpt) {
  if (!excerpt) return {};
  var obj;
  try { obj = JSON.parse(excerpt); }
  catch (_) {
    // Truncated JSON — best-effort give up. The Worker truncates at 3000
    // chars, so for a subscription object the head usually contains id +
    // customer + status. Try a salvage by lopping the trailing ellipsis
    // marker and counting unbalanced braces.
    var cleaned = excerpt.replace(/…\[truncated\]\s*$/, '').replace(/\.{3}\s*$/, '');
    try { obj = JSON.parse(cleaned); }
    catch (_2) { return {}; }
  }
  if (!obj || typeof obj !== 'object') return {};
  var result = {
    id: obj.id,
    customer: obj.customer,
    status: obj.status,
    current_period_end: obj.current_period_end
      ? new Date(Number(obj.current_period_end) * 1000).toISOString()
      : '',
    cancel_at_period_end: obj.cancel_at_period_end,
    trial_end: obj.trial_end ? new Date(Number(obj.trial_end) * 1000).toISOString() : ''
  };
  // Price ID lives under items.data[0].price.id for subscription objects.
  try {
    var items = obj.items && obj.items.data;
    if (items && items.length && items[0].price && items[0].price.id) {
      result.price_id = String(items[0].price.id);
    }
  } catch (_) { /* ignore */ }
  return result;
}

function _subFindSubscriptionRow_(sh, subscriptionId) {
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iSub = hdr.indexOf('stripe_subscription_id');
  if (iSub < 0) return null;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iSub]) === subscriptionId) {
      return { row: r + 1, hdr: hdr, row_obj: _rowToObj(hdr, data[r]) };
    }
  }
  return null;
}

function _subWriteSubscriptionRow_(sh, rowNum, hdr, patch) {
  Object.keys(patch).forEach(function (k) {
    var idx = hdr.indexOf(k);
    if (idx < 0) return;
    sh.getRange(rowNum, idx + 1).setValue(patch[k]);
  });
}

// ============================================================================
// HANDLER — checkout.session.completed
// ============================================================================

function _subHandleCheckoutCompleted_(ctx) {
  // For subscription mode, the subsequent customer.subscription.created
  // does the real work. We still log so the forensic trail is complete.
  // For payment-mode (one-off), the matching payment_intent.succeeded event
  // is what we'd act on (logged-only in v1).
  var meta = ctx.metadata || {};
  if (meta.mode === 'subscription' || ctx.summary.indexOf('subscription') >= 0) {
    return { handled: 'ok', notes: 'subscription mode — subscription.created will upsert' };
  }
  return { handled: 'ok', notes: 'logged; non-subscription checkout' };
}

// ============================================================================
// HANDLER — invoice.paid / invoice.payment_failed
// ============================================================================

function _subHandleInvoicePaid_(ctx) {
  var ss = ctx.ss;
  var meta = ctx.metadata || {};
  var parsed = _subParseInvoiceFromExcerpt_(ctx.payloadExcerpt);
  var subscriptionId = parsed.subscription || meta.subscription || '';
  var customerId = parsed.customer || meta.customer || '';
  var currentPeriodEnd = parsed.period_end || meta.current_period_end || '';

  if (!subscriptionId && !customerId) {
    return { handled: 'ok', notes: 'invoice.paid with no subscription — likely one-off invoice; logged only' };
  }

  // Stamp the Subscriptions row's current_period_end + flip status to active.
  var notes = [];
  if (subscriptionId) {
    var subsSh = getOrCreateSubscriptionsSheet_(ss);
    var existing = _subFindSubscriptionRow_(subsSh, subscriptionId);
    if (existing) {
      var patch = { status: 'active', updated_at: new Date().toISOString() };
      if (currentPeriodEnd) patch.current_period_end = currentPeriodEnd;
      _subWriteSubscriptionRow_(subsSh, existing.row, existing.hdr, patch);
      notes.push('subscription=' + subscriptionId + ' status=active');
    } else {
      notes.push('subscription=' + subscriptionId + ' not yet in Subscriptions tab (subscription.created may arrive next)');
    }
  }

  // Patch the Agencies row's status + current_period_end.
  if (customerId) {
    var match = _subFindAgencyByCustomerId_(ss, customerId);
    if (match) {
      var ap = { subscription_status: 'active' };
      if (currentPeriodEnd) ap.current_period_end = currentPeriodEnd;
      _subWriteAgencyFields_(ss, match, ap);
      _logAudit('subscription.invoice_paid', match.tenantId, 'worker:stripe_webhook', subscriptionId);
      notes.push('agency=' + match.tenantId + ' status=active');
    } else {
      notes.push('no agency match for customer=' + customerId);
    }
  }

  return { handled: 'ok', notes: notes.join('; ') };
}

function _subHandleInvoicePaymentFailed_(ctx) {
  var ss = ctx.ss;
  var meta = ctx.metadata || {};
  var parsed = _subParseInvoiceFromExcerpt_(ctx.payloadExcerpt);
  var subscriptionId = parsed.subscription || meta.subscription || '';
  var customerId = parsed.customer || meta.customer || '';

  if (!subscriptionId && !customerId) {
    return { handled: 'ok', notes: 'one-off invoice payment failed; logged only' };
  }

  var notes = [];
  if (subscriptionId) {
    var subsSh = getOrCreateSubscriptionsSheet_(ss);
    var existing = _subFindSubscriptionRow_(subsSh, subscriptionId);
    if (existing) {
      _subWriteSubscriptionRow_(subsSh, existing.row, existing.hdr, {
        status: 'past_due',
        updated_at: new Date().toISOString()
      });
      notes.push('subscription=' + subscriptionId + ' status=past_due');
    }
  }
  if (customerId) {
    var match = _subFindAgencyByCustomerId_(ss, customerId);
    if (match) {
      _subWriteAgencyFields_(ss, match, { subscription_status: 'past_due' });
      _logAudit('subscription.payment_failed', match.tenantId, 'worker:stripe_webhook', subscriptionId);
      notes.push('agency=' + match.tenantId + ' status=past_due');
    }
  }
  return { handled: 'ok', notes: notes.join('; ') };
}

function _subParseInvoiceFromExcerpt_(excerpt) {
  if (!excerpt) return {};
  try {
    var obj = JSON.parse(excerpt);
    if (!obj || typeof obj !== 'object') return {};
    return {
      subscription: obj.subscription || '',
      customer: obj.customer || '',
      period_end: obj.period_end ? new Date(Number(obj.period_end) * 1000).toISOString() : ''
    };
  } catch (_) {
    return {};
  }
}

// ============================================================================
// HANDLER — account.updated / account.application.deauthorized (Connect)
// ============================================================================

/**
 * Mirror Connect onboarding state onto the matching Interpreter row. The
 * Worker forwards `details_submitted`, `charges_enabled`, `payouts_enabled`
 * as first-class params (see workers/api/src/stripe.ts:752) so we don't have
 * to re-parse the payload.
 */
function _subHandleAccountUpdated_(ctx) {
  var ss = ctx.ss;
  var accountId = ctx.objectId;
  if (!accountId) return { handled: 'error', notes: 'no account_id on event' };

  var meta = ctx.metadata || {};
  var interpreterId = String(meta.interpreter_id || meta.internal_id || '');

  // Pull the booleans the Worker forwarded.
  var detailsSubmitted = String(ctx.rawParams.details_submitted || '') === 'true';
  var payoutsEnabled = String(ctx.rawParams.payouts_enabled || '') === 'true';
  var chargesEnabled = String(ctx.rawParams.charges_enabled || '') === 'true';

  // Find the interpreter row by stripe_account_id (preferred) or interpreter_id.
  var found = _subFindInterpreterByAccount_(ss, accountId, interpreterId);
  if (!found) {
    return { handled: 'ok', notes: 'no matching interpreter for account=' + accountId };
  }
  _payWriteInterpreterField(found, 'stripe_charges_enabled', chargesEnabled);
  _payWriteInterpreterField(found, 'stripe_payouts_enabled', payoutsEnabled);
  _payWriteInterpreterField(found, 'stripe_details_submitted', detailsSubmitted);
  if (payoutsEnabled) {
    _payWriteInterpreterField(found, 'payment_method', 'stripe_connect_express');
  }
  var tenantId = String(found.data[found.hdr.indexOf('tenant_id')] || '');
  _logAudit('stripe.account_updated_via_webhook', tenantId, 'worker:stripe_webhook',
            accountId + ' charges=' + chargesEnabled + ' payouts=' + payoutsEnabled);
  return {
    handled: 'ok',
    notes: 'interpreter=' + String(found.data[found.hdr.indexOf('interpreter_id')]) +
           ' charges=' + chargesEnabled + ' payouts=' + payoutsEnabled
  };
}

function _subHandleAccountDeauthorized_(ctx) {
  var ss = ctx.ss;
  var accountId = ctx.objectId;
  if (!accountId) return { handled: 'error', notes: 'no account_id on event' };
  var found = _subFindInterpreterByAccount_(ss, accountId, '');
  if (!found) {
    return { handled: 'ok', notes: 'no matching interpreter for account=' + accountId };
  }
  _payWriteInterpreterField(found, 'stripe_charges_enabled', false);
  _payWriteInterpreterField(found, 'stripe_payouts_enabled', false);
  _payWriteInterpreterField(found, 'stripe_details_submitted', false);
  var tenantId = String(found.data[found.hdr.indexOf('tenant_id')] || '');
  _logAudit('stripe.account_deauthorized', tenantId, 'worker:stripe_webhook', accountId);
  return { handled: 'ok', notes: 'connect account deauthorized' };
}

function _subFindInterpreterByAccount_(ss, accountId, interpreterIdFallback) {
  _payEnsureInterpreterCols(ss);
  var sh = ss.getSheetByName(T.Interpreters);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iAcct = hdr.indexOf('stripe_account_id');
  var iId = hdr.indexOf('interpreter_id');
  for (var r = 1; r < data.length; r++) {
    if (iAcct >= 0 && String(data[r][iAcct]) === String(accountId)) {
      return { row: r + 1, hdr: hdr, data: data[r], sh: sh };
    }
    if (interpreterIdFallback && iId >= 0 && String(data[r][iId]) === String(interpreterIdFallback)) {
      return { row: r + 1, hdr: hdr, data: data[r], sh: sh };
    }
  }
  return null;
}

// ============================================================================
// HANDLER — transfer.created / transfer.reversed / transfer.canceled
// ============================================================================

/**
 * Locate the payout row via `metadata.payout_id` (set by the Worker on
 * apiPayoutSend) and stamp the transfer ID. We don't flip status here —
 * payout.paid does that.
 */
function _subHandleTransferCreated_(ctx) {
  var ss = ctx.ss;
  var meta = ctx.metadata || {};
  var payoutId = String(meta.payout_id || '');
  if (!payoutId) {
    return { handled: 'ok', notes: 'transfer.created with no payout_id metadata; logged only' };
  }
  var stamped = _subStampPayoutRow_(ss, payoutId, {
    stripe_transfer_id: ctx.objectId
  });
  if (!stamped) {
    return { handled: 'ok', notes: 'no payout row matching payout_id=' + payoutId };
  }
  _logAudit('stripe.transfer_created', stamped.tenantId, 'worker:stripe_webhook',
            payoutId + ' transfer=' + ctx.objectId);
  return { handled: 'ok', notes: 'payout=' + payoutId + ' transfer=' + ctx.objectId };
}

function _subHandleTransferReversed_(ctx) {
  var ss = ctx.ss;
  var meta = ctx.metadata || {};
  var payoutId = String(meta.payout_id || '');
  // If metadata is empty (rare for reversal — Stripe carries the original
  // transfer's metadata through), we fall back to searching by transfer ID.
  var stamped;
  if (payoutId) {
    stamped = _subStampPayoutRow_(ss, payoutId, { status: 'reversed' });
  } else {
    stamped = _subStampPayoutByTransferId_(ss, ctx.objectId, { status: 'reversed' });
  }
  if (!stamped) {
    return { handled: 'ok', notes: 'no payout row matching transfer=' + ctx.objectId };
  }
  _logAudit('stripe.transfer_' + ctx.eventType.split('.').pop(),
            stamped.tenantId, 'worker:stripe_webhook',
            stamped.payoutId + ' transfer=' + ctx.objectId);
  return { handled: 'ok', notes: 'payout=' + stamped.payoutId + ' status=reversed' };
}

function _subStampPayoutRow_(ss, payoutId, patch) {
  var sh = ss.getSheetByName(T.Payouts);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iId = hdr.indexOf('payout_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iUpdated = hdr.indexOf('_updated_at');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) !== String(payoutId)) continue;
    Object.keys(patch).forEach(function (k) {
      var idx = hdr.indexOf(k);
      if (idx >= 0) sh.getRange(r + 1, idx + 1).setValue(patch[k]);
    });
    if (iUpdated >= 0) sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
    return { tenantId: String(data[r][iTenant] || ''), payoutId: payoutId };
  }
  return null;
}

function _subStampPayoutByTransferId_(ss, transferId, patch) {
  var sh = ss.getSheetByName(T.Payouts);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iTransfer = hdr.indexOf('stripe_transfer_id');
  var iId = hdr.indexOf('payout_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iUpdated = hdr.indexOf('_updated_at');
  if (iTransfer < 0) return null;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iTransfer]) !== String(transferId)) continue;
    Object.keys(patch).forEach(function (k) {
      var idx = hdr.indexOf(k);
      if (idx >= 0) sh.getRange(r + 1, idx + 1).setValue(patch[k]);
    });
    if (iUpdated >= 0) sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
    return { tenantId: String(data[r][iTenant] || ''), payoutId: String(data[r][iId] || '') };
  }
  return null;
}

// ============================================================================
// HANDLER — payout.paid / payout.failed
// ============================================================================

/**
 * payout.paid / payout.failed fire when the interpreter's bank confirms
 * receipt (or rejects). The event's `object_id` is a Stripe Payout (po_…),
 * NOT our internal payout row. We match by the upstream transfer if its
 * metadata is present, or by the stripe_payout_id if we've already stamped
 * it. v1 best-effort: log the event and emit a Communication row to the
 * interpreter so they see the status change in their portal.
 */
function _subHandlePayoutStatusChange_(ctx) {
  var ss = ctx.ss;
  var meta = ctx.metadata || {};
  var payoutId = String(meta.payout_id || '');
  var newStatus = ctx.eventType === 'payout.paid' ? 'paid' : 'failed';
  if (!payoutId) {
    return { handled: 'ok', notes: 'no payout_id metadata on Stripe payout — logged only' };
  }
  var stamped = _subStampPayoutRow_(ss, payoutId, { status: newStatus });
  if (!stamped) {
    return { handled: 'ok', notes: 'no payout row matching payout_id=' + payoutId };
  }
  _logAudit('stripe.payout_' + newStatus, stamped.tenantId, 'worker:stripe_webhook',
            payoutId + ' stripe_payout=' + ctx.objectId);
  return { handled: 'ok', notes: 'payout=' + payoutId + ' status=' + newStatus };
}

// ============================================================================
// HANDLER — charge.refunded
// ============================================================================

function _subHandleChargeRefunded_(ctx) {
  // v1: log and leave reconciliation to a human. Refund flows touch invoices,
  // payouts, and (potentially) tier downgrades — a focused reconcile pass is
  // safer than auto-applying these in v1.
  return { handled: 'ok', notes: 'refund logged; manual reconciliation' };
}

// ============================================================================
// HANDLER — charge.dispute.* and radar.early_fraud_warning.created
// ============================================================================

function _subHandleDispute_(ctx) {
  var subject;
  var phase = ctx.eventType.split('.').pop(); // 'created' | 'closed'
  if (phase === 'created') {
    subject = '[1891 Interpreter] STRIPE DISPUTE OPENED — ' + (ctx.summary || ctx.objectId);
  } else {
    subject = '[1891 Interpreter] Stripe dispute closed — ' + (ctx.summary || ctx.objectId);
  }
  _subNotifyOps_(subject, ctx);
  _logAudit('stripe.dispute_' + phase, 'host', 'worker:stripe_webhook',
            ctx.objectId + ' ' + ctx.summary);
  return { handled: 'ok', notes: 'notified ops + logged dispute ' + phase };
}

function _subHandleEarlyFraudWarning_(ctx) {
  _subNotifyOps_('[1891 Interpreter] Stripe early-fraud warning — ' + (ctx.summary || ctx.objectId), ctx);
  _logAudit('stripe.early_fraud_warning', 'host', 'worker:stripe_webhook',
            ctx.objectId + ' ' + ctx.summary);
  return { handled: 'ok', notes: 'notified ops + logged EFW' };
}

function _subNotifyOps_(subject, ctx) {
  try {
    var body =
      'Stripe event: ' + ctx.eventType + '\n' +
      'Object: ' + ctx.objectType + ' ' + ctx.objectId + '\n' +
      'Summary: ' + ctx.summary + '\n' +
      'Livemode: ' + ctx.livemode + '\n' +
      'Event ID: ' + ctx.eventId + '\n\n' +
      'Metadata:\n' + JSON.stringify(ctx.metadata, null, 2) + '\n\n' +
      'Payload excerpt:\n' + (ctx.payloadExcerpt || '(empty)') + '\n\n' +
      '— 1891 Interpreter webhook bridge';
    MailApp.sendEmail({ to: SECURITY_NOTIFY, subject: subject, body: body });
  } catch (err) {
    _logAudit('stripe.ops_notify_failed', 'host', 'worker:stripe_webhook',
              ctx.eventId + ' ' + String(err));
  }
}

// ============================================================================
// Agencies-row helpers (lookup by stripe_customer_id, write columns)
// ============================================================================

function _subFindAgencyByCustomerId_(ss, customerId) {
  if (!customerId) return null;
  var sh = ss.getSheetByName(T.Agencies);
  if (!sh) return null;
  // Ensure our six columns exist; otherwise indexOf returns -1 and writes no-op.
  extendAgenciesSchema_(ss);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iCust = hdr.indexOf('stripe_customer_id');
  var iTid = hdr.indexOf('tenant_id');
  var iBilling = hdr.indexOf('billing_email');
  if (iCust < 0) return null;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iCust]) === String(customerId)) {
      return {
        sh: sh,
        row: r + 1,
        hdr: hdr,
        tenantId: String(iTid >= 0 ? data[r][iTid] : ''),
        billing_email: String(iBilling >= 0 ? data[r][iBilling] : ''),
        row_obj: _rowToObj(hdr, data[r])
      };
    }
  }
  return null;
}

function _subWriteAgencyFields_(ss, found, patch) {
  Object.keys(patch).forEach(function (k) {
    var idx = found.hdr.indexOf(k);
    if (idx < 0) return;
    found.sh.getRange(found.row, idx + 1).setValue(patch[k]);
  });
  var iUpdated = found.hdr.indexOf('_updated_at');
  if (iUpdated >= 0) found.sh.getRange(found.row, iUpdated + 1).setValue(new Date().toISOString());
}

// ============================================================================
// PUBLIC — subscription_intent_url (marketing → Worker proxy)
// ============================================================================

/**
 * Public marketing-page handoff. The pricing page POSTs (or GETs via JSONP)
 * `?action=subscription_intent_url&tier=…&billing=…&email=…` and we proxy
 * to the Worker's internal `/v1/billing/checkout` (authenticated by our
 * shared HMAC secret) so the Worker can mint a Stripe Checkout Session.
 *
 * NOT session-gated — the visitor has no session yet. Rate limiting is
 * enforced at the Worker layer (token bucket on the public path); we
 * additionally throttle here implicitly via the brief idempotency-window
 * on the Worker.
 */
function apiSubscriptionIntentUrl(e) {
  var p = (e && e.parameter) || {};
  var tier = String(p.tier || '').trim().toLowerCase();
  var billing = String(p.billing || '').trim().toLowerCase();
  var email = String(p.email || '').trim().toLowerCase();
  var agencyName = String(p.agency_name || '').trim();

  // Validate locally so we don't burn a Worker round-trip on obviously-bad input.
  var validTiers = { solo: true, practice: true, studio: true };
  var validBilling = { monthly: true, annual: true };
  if (!validTiers[tier]) return _json({ ok: false, error: 'tier must be solo|practice|studio' });
  if (!validBilling[billing]) return _json({ ok: false, error: 'billing must be monthly|annual' });
  if (!_isValidEmail(email)) return _json({ ok: false, error: 'valid email required' });
  if (email.length > 200) return _json({ ok: false, error: 'email too long' });
  if (agencyName.length > 200) agencyName = agencyName.slice(0, 200);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var body = {
    tier: tier,
    billing: billing,
    customer_email: email
  };
  if (agencyName) body.agency_name = agencyName;
  var res = _payCallWorker(ss, '/v1/billing/checkout', body);
  if (!res || res.ok === false) {
    _logAudit('subscription.intent_failed', 'host', 'marketing',
              email + ' tier=' + tier + ' ' + ((res && res.error) || 'no_response'));
    return _json({
      ok: false,
      error: (res && res.error) || 'worker_unreachable',
      status: (res && res.status) || ''
    });
  }
  _logAudit('subscription.intent_created', 'host', 'marketing',
            email + ' tier=' + tier + ' billing=' + billing +
            ' session=' + (res.session_id || ''));
  return _json({
    ok: true,
    url: res.url || '',
    session_id: res.session_id || '',
    test_mode: !!res.test_mode
  });
}

// ============================================================================
// SESSION-GATED — apiSubscriptionStatus (in-app UI)
// ============================================================================

/**
 * Surface the current tenant's subscription state to the in-app UI
 * (`app/payments/index.html`). Read-only, session-gated. Pulls from the
 * Agencies row first (fast path) and supplements with the latest matching
 * Subscriptions row when one exists.
 */
function apiSubscriptionStatus(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  extendAgenciesSchema_(ss);

  var agency = _subFindAgencyByTenant_(ss, s.payload.tid);
  if (!agency) {
    return _json({ ok: true, subscription: { tier: 'none', status: 'none' } });
  }

  var customerId = String(agency.row_obj.stripe_customer_id || '');
  var sub = customerId ? _subLatestSubscriptionByCustomer_(ss, customerId) : null;

  return _json({
    ok: true,
    subscription: {
      tier: String(agency.row_obj.subscription_tier || 'none'),
      status: String(agency.row_obj.subscription_status || 'none'),
      price_id: String(agency.row_obj.subscription_price_id || ''),
      current_period_end: String(agency.row_obj.current_period_end || ''),
      billing_email: String(agency.row_obj.billing_email || ''),
      stripe_customer_id: customerId,
      // Subscription-tab supplementals (may be empty if no row exists yet).
      stripe_subscription_id: sub ? String(sub.stripe_subscription_id || '') : '',
      billing_interval: sub ? String(sub.billing_interval || '') : '',
      cancel_at_period_end: sub ? Boolean(sub.cancel_at_period_end) : false,
      trial_end: sub ? String(sub.trial_end || '') : ''
    }
  });
}

function _subFindAgencyByTenant_(ss, tenantId) {
  var sh = ss.getSheetByName(T.Agencies);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iTid = hdr.indexOf('tenant_id');
  if (iTid < 0) return null;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iTid]) === String(tenantId)) {
      return { sh: sh, row: r + 1, hdr: hdr, row_obj: _rowToObj(hdr, data[r]) };
    }
  }
  return null;
}

function _subLatestSubscriptionByCustomer_(ss, customerId) {
  var sh = ss.getSheetByName(SUB_T.Subscriptions);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iCust = hdr.indexOf('stripe_customer_id');
  var iUpdated = hdr.indexOf('updated_at');
  var iCreated = hdr.indexOf('created_at');
  if (iCust < 0) return null;
  var best = null;
  var bestTs = '';
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iCust]) !== String(customerId)) continue;
    var ts = String((iUpdated >= 0 && data[r][iUpdated]) || (iCreated >= 0 && data[r][iCreated]) || '');
    if (!best || ts > bestTs) {
      best = _rowToObj(hdr, data[r]);
      bestTs = ts;
    }
  }
  return best;
}
