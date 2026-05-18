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
