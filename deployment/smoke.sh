#!/usr/bin/env bash
# =============================================================================
# 1891 Interpreter — smoke.sh
# Post-deploy smoke checks against the live URL.
#
# Usage:
#   bash deployment/smoke.sh [BASE_URL]
# =============================================================================
set -euo pipefail

BASE="${1:-https://madeby1891.com/interpreter}"
FAIL=0

check() {
  local path="$1"
  local expected="$2"
  local label="$3"
  local actual
  actual=$(curl -sS -o /dev/null -w "%{http_code}" -L "$BASE$path")
  if [[ "$actual" == "$expected" ]]; then
    echo "  ✓  $label → $expected"
  else
    echo "  ✗  $label expected $expected, got $actual  ($BASE$path)" >&2
    FAIL=$((FAIL+1))
  fi
}

check_unfollowed() {
  local path="$1"
  local expected="$2"
  local label="$3"
  local actual
  actual=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE$path")
  if [[ "$actual" == "$expected" ]]; then
    echo "  ✓  $label → $expected"
  else
    echo "  ✗  $label expected $expected, got $actual  ($BASE$path)" >&2
    FAIL=$((FAIL+1))
  fi
}

echo "==> Smoke: $BASE"
check "/"                              "200" "Home loads"
check "/pricing"                       "200" "Pricing (clean URL) loads"
check "/free-for-deaf-owned"           "200" "Deaf-owned page (clean URL) loads"
check "/for-agencies"                  "200" "For agencies (clean URL) loads"
check "/security"                      "200" "Security (clean URL) loads"
check "/accessibility"                 "200" "Accessibility (clean URL) loads"
check "/features/"                     "200" "Features index loads"
check "/features/scheduling"           "200" "Feature: scheduling (clean URL) loads"
check "/legal/privacy"                 "200" "Privacy notice (clean URL) loads"
check "/legal/baa"                     "200" "BAA page (clean URL) loads"
check "/sitemap.xml"                   "200" "Sitemap reachable"
check "/robots.txt"                    "200" "Robots reachable"

# .html → clean URL 301 redirects (the .html form should never serve a 200)
check_unfollowed "/pricing.html"             "301" ".html → clean URL 301 (pricing)"
check_unfollowed "/for-agencies.html"        "301" ".html → clean URL 301 (for-agencies)"
check_unfollowed "/features/scheduling.html" "301" ".html → clean URL 301 (features/scheduling)"

# Real 404 — not a soft 200
check_unfollowed "/this-page-does-not-exist" "404" "Bad path returns real 404"

# Blocked paths must 403 (not 200)
check_unfollowed "/deployment/"        "403" "/deployment/ blocked"
check_unfollowed "/_build/"            "403" "/_build/ blocked"
check_unfollowed "/CLAUDE.md"          "403" "CLAUDE.md blocked"

# Security headers present?
echo "==> Header checks"
HDRS=$(curl -sSI "$BASE/")
for h in "Strict-Transport-Security" "X-Frame-Options" "X-Content-Type-Options" "Content-Security-Policy" "Referrer-Policy"; do
  if echo "$HDRS" | grep -qi "^$h:"; then
    echo "  ✓  $h present"
  else
    echo "  ✗  $h missing" >&2
    FAIL=$((FAIL+1))
  fi
done

# Payments-related checks (post-2026-05-18 go-live). These check both the
# Worker (live URL hardcoded — same worker for every environment) and the
# new public Subscribe + Success surfaces under site/pay/.
echo "==> Payments checks"

WORKER_BASE="https://1891-interpreter-api.anthonymowl.workers.dev"

# 1. Worker /health is up and reports ok:true.
HEALTH_BODY=$(curl -sS "$WORKER_BASE/health" || true)
if echo "$HEALTH_BODY" | grep -q '"ok":true'; then
  echo "  ✓  Worker /health → ok:true"
else
  echo "  ✗  Worker /health did not report ok:true. Body was: $HEALTH_BODY" >&2
  FAIL=$((FAIL+1))
fi

# 2. Webhook with a bogus signature must be rejected with 400 (not 200, not 500).
#    This is the signature-verification path — a 400 is the correct success.
WEBHOOK_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$WORKER_BASE/v1/stripe/webhook" \
  -H 'stripe-signature: bogus' \
  -H 'Content-Type: application/json' \
  -d '{}')
if [[ "$WEBHOOK_STATUS" == "400" ]]; then
  echo "  ✓  Webhook bogus-sig → 400 (signature correctly rejected)"
else
  echo "  ✗  Webhook bogus-sig expected 400, got $WEBHOOK_STATUS" >&2
  FAIL=$((FAIL+1))
fi

# 3. Pricing page renders a Subscribe CTA. One retry with a pause: mid-suite,
# this fetch intermittently catches a transient origin error (the suite has
# just fired ~25 rapid requests), and -f turns that into an empty body that
# reads like a missing CTA. Verified flaky 2026-06-10; content was correct.
PRICING_HTML=$(curl -fsS "$BASE/pricing" 2>/dev/null) || { sleep 3; PRICING_HTML=$(curl -fsS "$BASE/pricing" 2>/dev/null) || true; }
if echo "$PRICING_HTML" | grep -q "Subscribe"; then
  echo "  ✓  Pricing page contains a Subscribe CTA"
else
  echo "  ✗  Pricing page is missing a Subscribe CTA" >&2
  FAIL=$((FAIL+1))
fi

# 4. /pay/subscribe is reachable (200).
check "/pay/subscribe" "200" "/pay/subscribe loads"

# 5. /pay/success is reachable (200).
check "/pay/success"  "200" "/pay/success loads"

if [[ $FAIL -ne 0 ]]; then
  echo "==> $FAIL check(s) failed." >&2
  exit 1
fi
echo "==> All smoke checks passed."
