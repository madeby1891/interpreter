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
check "/pricing.html"                  "200" "Pricing loads"
check "/free-for-deaf-owned.html"      "200" "Deaf-owned page loads"
check "/for-agencies.html"             "200" "For agencies loads"
check "/security.html"                 "200" "Security loads"
check "/accessibility.html"            "200" "Accessibility loads"
check "/features/"                     "200" "Features index loads"
check "/features/scheduling.html"      "200" "Feature: scheduling loads"
check "/legal/privacy.html"            "200" "Privacy notice loads"
check "/legal/baa.html"                "200" "BAA page loads"
check "/sitemap.xml"                   "200" "Sitemap reachable"
check "/robots.txt"                    "200" "Robots reachable"

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
