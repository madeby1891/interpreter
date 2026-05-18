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

if [[ $FAIL -ne 0 ]]; then
  echo "==> $FAIL check(s) failed." >&2
  exit 1
fi
echo "==> All smoke checks passed."
