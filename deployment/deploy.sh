#!/usr/bin/env bash
# =============================================================================
# 1891 Interpreter — deploy.sh
# Rsyncs site/ to GoDaddy cPanel over the shared ~/.ssh/ftd_godaddy_deploy key.
# Per workspace convention. Deploys to public_html/interpreter/ on the host.
#
# Usage:
#   bash deployment/deploy.sh [--dry-run]
# =============================================================================
set -euo pipefail

# --- Configuration ----------------------------------------------------------
# These values may need adjustment when deploying to the real GoDaddy host —
# the host/port/path follow the same shape as other 1891 projects (see
# mowl-tree/deployment/deploy.sh for the canonical pattern).
SSH_KEY="${HOME}/.ssh/ftd_godaddy_deploy"
# Canonical 1891 GoDaddy values (match mowl-tree, parliamentarian, msd-psa)
SSH_USER="${SSH_USER:-f6chtbdjctic}"
SSH_HOST="${SSH_HOST:-50.62.140.157}"
SSH_PORT="${SSH_PORT:-22}"
REMOTE_PATH="${REMOTE_PATH:-public_html/madeby1891.com/interpreter}"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_DIR="${PROJECT_ROOT}/site"
LIVE_URL="https://madeby1891.com/interpreter"

# --- Args -------------------------------------------------------------------
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      echo "Usage: $0 [--dry-run]"
      exit 0 ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 2 ;;
  esac
done

# ── Godview auto-registration lint ──────────────────────────────────────────
# Catches drift between this project and shared/specs/godview-metrics.json
# (missing row, stale tile, placeholder endpoint). Bypass: FORCE=1.
# Spec: shared/specs/GODVIEW_AUTO_REGISTRATION.md
bash "$HOME/Desktop/1891/shared/ops/godview-lint-gate.sh" "$HOME/Desktop/1891/projects/interpreter" || exit 1

# ── Voice / language lint ───────────────────────────────────────────────────
# Per shared/specs/HARD_RULE.md + CLAUDE.md §"Voice + language rules" — every
# customer-facing HTML/JS/TS/CSS file goes through the 8-rule check (HARD RULE
# vendor names, banned voice words, deprecated tier vocab, device-name surfaces,
# brand spelling, cost-rationalization).
echo "==> Voice / language lint…"
if python3 "$HOME/Desktop/1891/shared/ops/voice-lint.py" --project=. 2>&1 | tail -8; then
  echo "    voice-lint pass"
elif [ "${FORCE:-0}" = "1" ]; then
  echo "    voice-lint fail (FORCE=1 bypass)"
else
  echo "ERROR: voice-lint failed. Fix the FAIL lines above or set FORCE=1 to bypass." >&2
  exit 1
fi

# ── SMS-consent lint ────────────────────────────────────────────────────────
# Per shared/specs/SMS.md §6 — every project that sends SMS keeps consent,
# STOP/HELP, vendor-name HARD RULE, and rate-limit posture green pre-deploy.
echo "==> SMS consent lint…"
if python3 "$HOME/Desktop/1891/shared/ops/sms-consent-lint.py" --project=. --quiet 2>&1; then
  echo "    sms-consent-lint pass"
elif [ "${FORCE:-0}" = "1" ]; then
  echo "    sms-consent-lint fail (FORCE=1 bypass)"
else
  echo "ERROR: sms-consent-lint failed. Fix the findings or set FORCE=1 to bypass." >&2
  exit 1
fi

# ── Parallel-agent branch lint ──────────────────────────────────────────────
# Hard-blocks ONLY when an unmerged branch on origin touches files inside
# this project. Override: FORCE=1 OR ACK_BRANCHES="branch:reason".
# Spec: shared/specs/PARALLEL_AGENT_DISCIPLINE.md.
echo "==> Parallel-agent branch lint…"
INTERPRETER_ACK_ARG=""
[ -n "${ACK_BRANCHES:-}" ] && INTERPRETER_ACK_ARG="--ack-branches=$ACK_BRANCHES"
if python3 "$HOME/Desktop/1891/shared/ops/branch-watch.py" --no-fetch \
     --deploy-path=. --warn-only $INTERPRETER_ACK_ARG 2>&1; then
  echo "    branch-watch pass"
elif [ "${FORCE:-0}" = "1" ]; then
  echo "    branch-watch fail (FORCE=1 bypass)"
else
  echo "ERROR: branch-watch failed. Land the overlapping branch with shared/ops/finish-branch.sh OR rerun with ACK_BRANCHES='<branch>:<why>'. See shared/specs/PARALLEL_AGENT_DISCIPLINE.md." >&2
  exit 1
fi

# ── Dashboard-contract lint ─────────────────────────────────────────────────
# Per shared/specs/DASHBOARD_CONTRACT.md v1 — the admin surface follows the
# twelve primitives, no HARD RULE leaks, role hydrated server-side.
echo "==> Dashboard contract lint (admin)…"
if python3 "$HOME/Desktop/1891/shared/ops/dashboard-contract-lint.py" --project=. --surface=admin 2>&1 | tail -8; then
  echo "    dashboard-contract-lint pass"
elif [ "${FORCE:-0}" = "1" ]; then
  echo "    dashboard-contract-lint fail (FORCE=1 bypass)"
else
  echo "ERROR: dashboard-contract-lint failed. Fix or set FORCE=1 to bypass." >&2
  exit 1
fi

# ── Test gate (vitest) ──────────────────────────────────────────────────────
# Fail the deploy if tests fail. Bypass: FORCE=1 (matches the godview gate).
TEST_DIR="$HOME/Desktop/1891/projects/interpreter"
if [ -d "$TEST_DIR" ] && find "$TEST_DIR" -name "*.test.ts" -not -path "*/node_modules/*" | grep -q .; then
  echo "==> Running vitest…"
  if (cd "$TEST_DIR" && npx --yes vitest run --reporter=dot 2>&1 | tail -20); then
    echo "    vitest pass"
  elif [ "${FORCE:-0}" = "1" ]; then
    echo "    vitest fail (FORCE=1 bypass)"
  else
    echo "ERROR: vitest fail. Fix the broken tests or set FORCE=1 to bypass." >&2
    exit 1
  fi
fi

# --- Optional: deploy the API worker first ----------------------------------
# Set DEPLOY_WORKER=1 in env to run `npx wrangler deploy` from workers/api/
# BEFORE the site rsync. Default is off so this script stays the same one-touch
# tool for site-only iterations.
if [[ "${DEPLOY_WORKER:-0}" == "1" ]]; then
  WORKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/workers/api"
  if [[ ! -d "$WORKER_DIR" ]]; then
    echo "ERROR: DEPLOY_WORKER=1 but workers/api not found at $WORKER_DIR" >&2
    exit 1
  fi
  echo "==> Deploying API worker (DEPLOY_WORKER=1)…"
  (cd "$WORKER_DIR" && npx wrangler deploy)
fi

# --- Pre-flight -------------------------------------------------------------
if [[ ! -d "$SITE_DIR" ]]; then
  echo "ERROR: site dir not found at $SITE_DIR" >&2
  exit 1
fi
if [[ ! -f "$SSH_KEY" ]]; then
  echo "ERROR: SSH key not found at $SSH_KEY" >&2
  echo "       This is the shared 1891 deploy key. Set it up before deploying." >&2
  exit 1
fi
if [[ ! -f "$SITE_DIR/.htaccess" ]]; then
  echo "ERROR: site/.htaccess missing — refusing to deploy without security baseline." >&2
  exit 1
fi
if [[ ! -f "$SITE_DIR/404.html" ]]; then
  echo "ERROR: site/404.html missing — refusing to deploy without real 404." >&2
  exit 1
fi

# --- PII grep (FDT-audit baseline) ------------------------------------------
echo "==> PII safety scan…"
# Allowlist: founder names (public), the role inboxes, the domain itself,
# illustrative-only consumer tokens (ABC-####), and the brand mark.
if grep -rIE \
  --include='*.html' --include='*.css' --include='*.js' --include='*.xml' --include='*.txt' \
  -e '[A-Za-z0-9._%+-]+@(gmail|yahoo|outlook|hotmail|aol|icloud|me|live|protonmail)\.com' \
  -e '\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b' \
  -e '\b\(?[0-9]{3}\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}\b' \
  "$SITE_DIR" 2>/dev/null; then
  echo "ERROR: potential PII detected above. Refusing to deploy." >&2
  echo "       Review and either remove or document in .pii-allowlist before retrying." >&2
  exit 1
fi
echo "    OK — no PII patterns found."

# --- Build ------------------------------------------------------------------
echo "==> Build…"
python3 "$PROJECT_ROOT/_build/build.py"

# Strip .html from internal href attrs site-wide. build.py already emits
# clean URLs in marketing pages; this also catches the handwritten app/*
# pages and any future drift.
if [[ -f "$PROJECT_ROOT/_build/strip_html_urls.py" ]]; then
  echo "==> Clean URLs (strip .html from hrefs)…"
  python3 "$PROJECT_ROOT/_build/strip_html_urls.py"
fi

# ADVERTISING.md §3 — UMBRELLA-CONSENT injection AFTER build.py.  build.py
# regenerates marketing pages from its content registry; if we injected
# before build, the regen would wipe the sentinel.  Run the umbrella's
# inject-chrome.py as a post-build pass so the consent banner survives.
UMBRELLA_INJECT="$HOME/Desktop/1891/_build/inject-chrome.py"
if [[ -f "$UMBRELLA_INJECT" ]]; then
  echo "==> Inject UMBRELLA-CONSENT (advertising §3)…"
  python3 "$UMBRELLA_INJECT" --consent-only \
    --site-root "$PROJECT_ROOT/site" \
    --url-prefix /interpreter/
fi

# --- Rsync ------------------------------------------------------------------
echo "==> Ensure remote dir exists"
if [[ $DRY_RUN -eq 0 ]]; then
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new \
    "${SSH_USER}@${SSH_HOST}" "mkdir -p ${REMOTE_PATH}"
fi

echo "==> Rsync to ${SSH_USER}@${SSH_HOST}:${REMOTE_PATH}"
RSYNC_OPTS=(
  -avz
  --delete
  --exclude='.DS_Store'
  --exclude='*.swp'
  --exclude='*.bak'
  --exclude='.git'
  --exclude='_build'
  --exclude='deployment'
  --exclude='godview.json'
  --exclude='node_modules'
  --exclude='apps-script'
  --exclude='package*.json'
)
if [[ $DRY_RUN -eq 1 ]]; then
  RSYNC_OPTS+=(--dry-run -v)
fi

rsync "${RSYNC_OPTS[@]}" \
  -e "ssh -i $SSH_KEY -p $SSH_PORT -o StrictHostKeyChecking=accept-new" \
  "$SITE_DIR/" \
  "${SSH_USER}@${SSH_HOST}:${REMOTE_PATH}/"

# --- Smoke check ------------------------------------------------------------
if [[ $DRY_RUN -eq 0 ]]; then
  echo "==> Smoke checks against $LIVE_URL"
  bash "$PROJECT_ROOT/deployment/smoke.sh" "$LIVE_URL"
else
  echo "==> Dry-run complete. Skipping smoke checks."
fi

echo "==> Deploy complete: $LIVE_URL"
