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
"""

from __future__ import annotations

import argparse
import pathlib
import sys

# Lives next to this script so the import works without site-packages.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from compute_event_token import event_token  # noqa: E402

SENTINEL_BEGIN = "<!-- BEGIN EVENT-CAPTURE 1891 -->"
SENTINEL_END = "<!-- END EVENT-CAPTURE 1891 -->"


def tags(project: str, *, with_widget: bool = True) -> str:
    """Build the script-tag block (no surrounding sentinels)."""
    token = event_token(project)
    lines = [
        '<script src="/shared/lib/event-capture/event-capture.js"',
        f'        data-event-capture-key="{project}"',
        '        data-event-capture-url="https://events.madeby1891.com/e"',
        f'        data-event-capture-token="{token}"',
        '        data-event-capture-errors="true"',
        '        defer></script>',
    ]
    if with_widget:
        lines.extend([
            '<link rel="stylesheet" href="/shared/components/feedback-widget/feedback-widget.css">',
            '<script src="/shared/components/feedback-widget/feedback-widget.js"',
            f'        data-project="{project}"',
            '        data-endpoint="https://events.madeby1891.com/feedback"',
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
