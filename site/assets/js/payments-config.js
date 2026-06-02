/* 1891 Interpreter — Public payments runtime config.
 *
 * This file is loaded by every /interpreter/pay/* page. Only PUBLIC values
 * live here. Both the Worker URL and the Stripe publishable key are designed
 * to be in the browser bundle — they're not secrets.
 *
 * `publishableKey` is empty by default. Anthony fills in the live `pk_live_*`
 * after the Worker deploy (see DISASTER_RECOVERY for the rotation procedure).
 * Until then the subscribe page still works — Stripe.js is not loaded on the
 * subscribe page; we just redirect to the hosted Checkout URL the Worker
 * returns. The publishable key is reserved for any future embedded surface
 * (Payment Element on the success page, customer portal embed, etc.).
 */
(function (root) {
  'use strict';
  root.IntPayments = {
    // Edge API base URL. Public.
    workerBase: 'https://1891-interpreter-api.anthonymowl.workers.dev',
    // Stripe publishable key. Public by design (PAYMENTS.md §6.3).
    // Fill in `pk_live_*` post-deploy. Empty value is fine for the subscribe
    // → hosted-Checkout flow; only matters once we embed Stripe Elements.
    publishableKey: ''
  };
})(window);
