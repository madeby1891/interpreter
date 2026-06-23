#!/usr/bin/env python3
"""
inject_event_tags.py — sweep a built site tree and inject the shared
event-capture v2 helper + feedback-widget script tags before every
`</head>`.

Per shared/specs/CONTINUOUS_LEARNING.md §2 + §2.3.

Idempotent: a sentinel comment is left behind so re-runs replace the block
rather than appending. Safe to call from a project's build.py after the
output tree (dist/, site/public_html/, _build/output/, etc.) is finalized.

Usage from a build.py:

    from inject_event_tags import inject_event_tags
    inject_event_tags("travel", OUT)  # OUT = pathlib.Path(...)

Or from the shell (so a deploy.sh without a build can call it):

    python3 _build/inject_event_tags.py --project=travel --site=site

────────────────────────────────────────────────────────────────────────────
BEACON ORIGIN — SINGLE SOURCE OF TRUTH (do not hard-code the host below)

Every project vendors its OWN copy of this file, so a hard-coded beacon URL
drifted family-wide on every host change (the 2026-06-23 manual sweep of ~13
repos). The origin now resolves, in order, from:

  1. $EVENT_CAPTURE_ORIGIN in the environment — deploy.sh / build.py source
     ~/.config/1891/event-ingest-secrets.env, the same file the per-day token
     secret comes from; then
  2. the EVENT_CAPTURE_ORIGIN= line read straight out of that same secrets
     file — so a project whose deploy does NOT pre-source it still resolves the
     one canonical value (most deploys don't source it); then
  3. DEFAULT_EVENT_CAPTURE_ORIGIN below — only for environments without the
     secrets file (CI, a fresh clone). Keep it equal to the canonical origin.

Repoint the whole family by editing the ONE EVENT_CAPTURE_ORIGIN line in
~/.config/1891/event-ingest-secrets.env; every project picks it up on its next
build. Build scripts that bake the tags themselves (no injector) import
capture_url()/feedback_url() from here so they share the same source.
────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import argparse
import os
import pathlib
import sys

# Lives next to this script so the import works without site-packages.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from compute_event_token import event_token  # noqa: E402

SENTINEL_BEGIN = "<!-- BEGIN EVENT-CAPTURE 1891 -->"
SENTINEL_END = "<!-- END EVENT-CAPTURE 1891 -->"

# Fallback origin for environments without the shared secrets file (CI, a fresh
# clone). The AUTHORITATIVE value is EVENT_CAPTURE_ORIGIN in
# ~/.config/1891/event-ingest-secrets.env — see the module docstring. Keep this
# literal equal to the canonical origin; it must never be the place you repoint.
DEFAULT_EVENT_CAPTURE_ORIGIN = "https://events.madeby1891.com"
_SECRETS_ENV_FILE = pathlib.Path.home() / ".config" / "1891" / "event-ingest-secrets.env"


def _origin_from_secrets_file() -> str:
    """Read EVENT_CAPTURE_ORIGIN straight out of the shared secrets file.

    Lets a project whose deploy.sh doesn't pre-source the file still resolve the
    one canonical origin. Only the EVENT_CAPTURE_ORIGIN line is parsed; the HMAC
    secrets in the same file are never read into anything observable.
    """
    try:
        for raw in _SECRETS_ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line.startswith("#") or "EVENT_CAPTURE_ORIGIN=" not in line:
                continue
            # tolerate `export EVENT_CAPTURE_ORIGIN=...` and surrounding quotes
            _, _, val = line.partition("EVENT_CAPTURE_ORIGIN=")
            val = val.strip().strip('"').strip("'")
            if val:
                return val
    except OSError:
        pass
    return ""


def capture_origin() -> str:
    """The event-capture beacon origin (scheme + host), no trailing slash."""
    val = os.environ.get("EVENT_CAPTURE_ORIGIN", "").strip()
    if not val:
        val = _origin_from_secrets_file()
    return (val or DEFAULT_EVENT_CAPTURE_ORIGIN).rstrip("/")


def capture_url() -> str:
    """Full event-capture ingest URL (the value for data-event-capture-url)."""
    return capture_origin() + "/e"


def feedback_url() -> str:
    """Full feedback-widget endpoint (the value for data-endpoint)."""
    return capture_origin() + "/feedback"


def tags(project: str, *, with_widget: bool = True) -> str:
    """Build the script-tag block (no surrounding sentinels)."""
    token = event_token(project)
    lines = [
        '<script src="/shared/lib/event-capture/event-capture.js"',
        f'        data-event-capture-key="{project}"',
        f'        data-event-capture-url="{capture_url()}"',
        f'        data-event-capture-token="{token}"',
        '        data-event-capture-errors="true"',
        '        defer></script>',
    ]
    if with_widget:
        lines.extend([
            '<link rel="stylesheet" href="/shared/components/feedback-widget/feedback-widget.css">',
            '<script src="/shared/components/feedback-widget/feedback-widget.js"',
            f'        data-project="{project}"',
            f'        data-endpoint="{feedback_url()}"',
            f'        data-token="{token}"',
            '        defer></script>',
        ])
    return "\n".join(lines)


def _block(project: str, with_widget: bool) -> str:
    return (
        SENTINEL_BEGIN + "\n" +
        tags(project, with_widget=with_widget) + "\n" +
        SENTINEL_END
    )


def _patch_one(path: pathlib.Path, block: str) -> bool:
    """Return True if the file was changed."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    if "</head>" not in text:
        return False

    if SENTINEL_BEGIN in text and SENTINEL_END in text:
        # Replace the existing sentinel block.
        start = text.index(SENTINEL_BEGIN)
        end = text.index(SENTINEL_END) + len(SENTINEL_END)
        new_text = text[:start] + block + text[end:]
    else:
        # Insert immediately before </head>.
        new_text = text.replace("</head>", block + "\n</head>", 1)

    if new_text == text:
        return False
    path.write_text(new_text, encoding="utf-8")
    return True


def inject_event_tags(
    project: str,
    site_root: pathlib.Path,
    *,
    with_widget: bool = True,
    pattern: str = "*.html",
) -> tuple[int, int]:
    """Walk `site_root` recursively and patch every HTML file with `</head>`.

    Returns (patched, scanned).
    """
    block = _block(project, with_widget)
    patched = 0
    scanned = 0
    for p in site_root.rglob(pattern):
        if not p.is_file():
            continue
        scanned += 1
        if _patch_one(p, block):
            patched += 1
    print(f"  event-tags: patched {patched}/{scanned} html files in {site_root}")
    return patched, scanned


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True, help="project slug")
    parser.add_argument("--site", required=True, help="site root to walk")
    parser.add_argument("--no-widget", action="store_true",
                        help="skip the feedback-widget tag (admin-only surfaces)")
    args = parser.parse_args(argv)
    root = pathlib.Path(args.site).resolve()
    if not root.is_dir():
        print(f"  site root not found: {root}", file=sys.stderr)
        return 1
    inject_event_tags(args.project, root, with_widget=not args.no_widget)
    return 0


if __name__ == "__main__":
    sys.exit(main())
