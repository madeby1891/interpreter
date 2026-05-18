#!/usr/bin/env python3
"""
One-shot URL cleanup: strip `.html` from internal hrefs and canonical/og URLs
across every HTML page in site/. Idempotent — running twice is a no-op.

Rules:
  - href="/interpreter/foo.html"          -> href="/interpreter/foo"
  - href="/interpreter/features/x.html"   -> href="/interpreter/features/x"
  - href="bar.html"                       -> href="bar"      (relative)
  - href="bar.html#anchor"                -> href="bar#anchor"
  - href="bar.html?q=1"                   -> href="bar?q=1"
  - <link rel="canonical" href="...html"> -> ...
  - <meta property="og:url"               -> ...
  - <meta property="og:image"             -> .html is on assets, untouched
  - external https://other.com/x.html     -> untouched (host is not our canonical)
  - downloads (.pdf, .csv, .zip, .svg)    -> untouched (not .html)
  - <a href="/interpreter/legal/...html"> -> cleaned
  - mailto:, tel:, javascript:            -> untouched

Run from project root:
  python3 _build/strip_html_urls.py
"""
from __future__ import annotations
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
CANONICAL_HOST = "https://madeby1891.com"

# Matches `href="...foo.html"` or `href="...foo.html#anchor"` or `href="...foo.html?q=..."`.
# Captures: (1) full quote+prefix, (2) base path no .html, (3) suffix (anchor/query), (4) closing quote
# We only strip .html when:
#   - the URL starts with "/" (absolute path on our host) OR
#   - the URL is a bare relative ref (no scheme, no //) OR
#   - the URL is "https://madeby1891.com/..."
ATTR_RE = re.compile(
    r'''(\b(?:href|content)\s*=\s*["'])'''   # 1: opener
    r'''([^"'?#]*?)'''                       # 2: the URL up to .html
    r'''\.html'''                            # literal .html (without trailing /)
    r'''([#?][^"']*)?'''                     # 3: optional fragment / query
    r'''(["'])'''                            # 4: closer
)


def should_strip(url: str) -> bool:
    """Decide whether this URL is one of ours and safe to strip."""
    if not url:
        return False
    if url.startswith(("mailto:", "tel:", "javascript:", "#")):
        return False
    # External link to a different host: leave alone
    if url.startswith("http://") or url.startswith("https://"):
        return url.startswith(CANONICAL_HOST + "/") or url.startswith("https://www.madeby1891.com/")
    if url.startswith("//"):
        return False  # protocol-relative external
    # Relative or absolute-path on our host — strip
    return True


def transform(match: re.Match) -> str:
    opener = match.group(1)
    base = match.group(2)
    suffix = match.group(3) or ""
    closer = match.group(4)

    url_full = base + ".html" + suffix
    if not should_strip(url_full):
        return match.group(0)

    # Special-case: index.html at the end of a path becomes a trailing slash.
    # e.g. /interpreter/features/index.html -> /interpreter/features/
    if base.endswith("/index"):
        new_url = base[:-len("index")] + suffix  # drop "index", keep slash
    else:
        new_url = base + suffix

    return f"{opener}{new_url}{closer}"


def clean(text: str) -> str:
    return ATTR_RE.sub(transform, text)


def main() -> int:
    html_files = sorted(SITE.rglob("*.html"))
    changed = 0
    total = 0
    for p in html_files:
        total += 1
        original = p.read_text(encoding="utf-8")
        cleaned = clean(original)
        if cleaned != original:
            p.write_text(cleaned, encoding="utf-8")
            changed += 1
            print(f"  cleaned: {p.relative_to(ROOT)}")

    # Also clean sitemap.xml — same regex works for <loc>...</loc>.
    sm = SITE / "sitemap.xml"
    if sm.exists():
        original = sm.read_text(encoding="utf-8")
        # Sitemap uses <loc>https://madeby1891.com/interpreter/foo.html</loc>
        # — simpler regex.
        SITEMAP_RE = re.compile(r'(<loc>)([^<]+?)\.html(</loc>)')

        def sm_sub(m):
            base = m.group(2)
            if base.endswith("/index"):
                return f"{m.group(1)}{base[:-len('index')]}{m.group(3)}"
            return f"{m.group(1)}{base}{m.group(3)}"

        cleaned = SITEMAP_RE.sub(sm_sub, original)
        if cleaned != original:
            sm.write_text(cleaned, encoding="utf-8")
            changed += 1
            print(f"  cleaned: {sm.relative_to(ROOT)}")

    print(f"\nDone. {changed} of {total + 1} files changed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
