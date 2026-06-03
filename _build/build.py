#!/usr/bin/env python3
"""
1891 Interpreter — marketing site builder.

Generates all static HTML pages from the content registry in this file,
wrapping each page body with the shared head, site header, and site footer.

Run: python3 _build/build.py
Output: site/*.html, site/features/*.html, site/legal/*.html, site/sitemap.xml

Static-site-first per workspace conventions. No external deps.
"""
from __future__ import annotations
import os
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
BASE_PATH = "/interpreter"

# Asset cache-busting. The site sits behind a CDN that caches /assets/* for
# hours with no per-file versioning — so a CSS/JS change wouldn't go live until
# the TTL expired. We append ?v=<content-hash> to every stylesheet/script href
# so any change to those files busts the edge cache the moment the (uncached)
# HTML ships. Recomputed each build from the actual file bytes.
import hashlib as _hashlib
def _asset_version() -> str:
    h = _hashlib.sha1()
    for _rel in ("assets/css/site.css", "assets/css/marketing-interact.css",
                 "assets/js/main.js", "assets/js/marketing-interact.js"):
        _p = SITE / _rel
        if _p.exists():
            h.update(_p.read_bytes())
    return h.hexdigest()[:8]
ASSET_V = _asset_version()

# Release stamping — shared/specs/CONTINUOUS_LEARNING.md §2.5.
import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_release_json import emit_release_json  # noqa: E402
from compute_event_token import event_token  # noqa: E402

EVENT_TOKEN = event_token("interpreter")
EVENT_TAGS = (
    f'<link rel="stylesheet" href="https://cdn.madeby1891.com/shared/components/feedback-widget/feedback-widget.css">\n'
    f'<script src="https://cdn.madeby1891.com/shared/lib/event-capture/event-capture.js" '
    f'data-event-capture-key="interpreter" '
    f'data-event-capture-url="https://event-capture.anthonymowl.workers.dev/e" '
    f'data-event-capture-token="{EVENT_TOKEN}" '
    f'data-event-capture-errors="true" defer></script>\n'
    f'<script src="https://cdn.madeby1891.com/shared/components/feedback-widget/feedback-widget.js" '
    f'data-project="interpreter" '
    f'data-endpoint="https://event-capture.anthonymowl.workers.dev/feedback" '
    f'data-token="{EVENT_TOKEN}" defer></script>'
)
CANONICAL_BASE = "https://madeby1891.com" + BASE_PATH
BUILD_DATE = "2026-05-17"


# -----------------------------------------------------------------------------
# Shared partials
# -----------------------------------------------------------------------------

HEAD_TPL = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="{description}">
<meta name="theme-color" content="#C8553D">
<link rel="canonical" href="{canonical}">
<link rel="icon" type="image/svg+xml" href="{base}/assets/img/favicon.svg">
<link rel="stylesheet" href="{base}/assets/css/site.css?v={asset_v}">
<link rel="stylesheet" href="{base}/assets/css/marketing-interact.css?v={asset_v}">
<meta property="og:title" content="{og_title}">
<meta property="og:description" content="{description}">
<meta property="og:type" content="website">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{canonical_root}/assets/img/og-card.svg">
<meta property="og:image:alt" content="1891 Interpreter — The interpreting agency platform built by the community it serves.">
<meta property="og:site_name" content="1891 Interpreter">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{og_title}">
<meta name="twitter:description" content="{description}">
<meta name="twitter:image" content="{canonical_root}/assets/img/og-card.svg">
<meta name="robots" content="index,follow">
<script type="application/ld+json">
{{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "1891 Interpreter",
  "url": "{canonical_root}/",
  "founder": [
    {{ "@type": "Person", "name": "Anthony Mowl" }},
    {{ "@type": "Person", "name": "Fallon Brizendine" }}
  ],
  "description": "The interpreting agency platform built by the community it serves — free, forever, for Deaf-owned agencies."
}}
</script>{extra_head}
{event_tags}
</head>
<body>
<a href="#main" class="skip">Skip to main content</a>
"""

NAV_LINKS = [
    ("agencies",     "/for-agencies",        "Agencies"),
    ("schedulers",   "/for-schedulers",      "Schedulers"),
    ("interpreters", "/for-interpreters",    "Interpreters"),
    ("features",     "/features/",           "Features"),
    ("pricing",      "/pricing",             "Pricing"),
    ("free",         "/free-for-deaf-owned", "Free for Deaf-owned"),
    ("security",     "/security",            "Security"),
    ("about",        "/about",               "About"),
]


def header_html(active: str = "") -> str:
    items = []
    for key, href, label in NAV_LINKS:
        cur = ' aria-current="page"' if key == active else ""
        items.append(f'      <a href="{BASE_PATH}{href}"{cur}>{label}</a>')
    return f"""<header class="site-header">
  <div class="wrap">
    <a href="{BASE_PATH}/" class="brand" aria-label="1891 Interpreter, home">
      <img src="{BASE_PATH}/assets/img/brand-mark.svg" alt="" class="brand-mark" width="32" height="32">
      <span>1891 <span class="brand-sub">Interpreter</span></span>
    </a>
    <button class="nav-toggle" aria-expanded="false" aria-controls="primary-nav">
      <span aria-hidden="true">☰</span> Menu
    </button>
    <nav class="nav-primary" id="primary-nav" aria-label="Primary">
{chr(10).join(items)}
      <a href="{BASE_PATH}/get-a-demo" class="btn btn-primary btn-sm nav-cta">Get a demo</a>
    </nav>
  </div>
</header>
"""


FOOTER = f"""<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      <div>
        <a href="{BASE_PATH}/" class="brand" style="color:var(--1891int-paper)">
          <img src="{BASE_PATH}/assets/img/brand-mark.svg" alt="" width="32" height="32">
          <span>1891 <span class="brand-sub" style="color:#8B939C">Interpreter</span></span>
        </a>
        <p style="font-size:14.5px; max-width:34ch; margin-top:var(--1891int-s-3)">The interpreting agency platform built by the community it serves.</p>
        <p style="font-size:13.5px; color:#8B939C">Frederick, MD · <a href="mailto:hello@madeby1891.com">hello@madeby1891.com</a></p>
      </div>
      <div>
        <h4>Product</h4>
        <ul>
          <li><a href="{BASE_PATH}/features/">Features</a></li>
          <li><a href="{BASE_PATH}/pricing">Pricing</a></li>
          <li><a href="{BASE_PATH}/free-for-deaf-owned">Free for Deaf-owned</a></li>
          <li><a href="{BASE_PATH}/changelog">Changelog</a></li>
        </ul>
      </div>
      <div>
        <h4>For</h4>
        <ul>
          <li><a href="{BASE_PATH}/for-agencies">Agencies</a></li>
          <li><a href="{BASE_PATH}/for-schedulers">Schedulers</a></li>
          <li><a href="{BASE_PATH}/for-interpreters">Interpreters</a></li>
          <li><a href="{BASE_PATH}/for-requestors">Requestors</a></li>
          <li><a href="{BASE_PATH}/for-payers">Billing / AP</a></li>
        </ul>
      </div>
      <div>
        <h4>Company</h4>
        <ul>
          <li><a href="{BASE_PATH}/about">About</a></li>
          <li><a href="{BASE_PATH}/our-1891">Our 1891</a></li>
          <li><a href="{BASE_PATH}/security">Security</a></li>
          <li><a href="{BASE_PATH}/accessibility">Accessibility</a></li>
          <li><a href="{BASE_PATH}/contact">Contact</a></li>
        </ul>
      </div>
      <div>
        <h4>Legal</h4>
        <ul>
          <li><a href="{BASE_PATH}/legal/privacy">Privacy</a></li>
          <li><a href="{BASE_PATH}/legal/terms">Terms</a></li>
          <li><a href="{BASE_PATH}/legal/baa">BAA</a></li>
          <li><a href="{BASE_PATH}/legal/subprocessors">Subprocessors</a></li>
          <li><a href="{BASE_PATH}/legal/responsible-disclosure">Disclosure</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-meta">
      <div>© <span data-year>2026</span> 1891 LLC. Built in Frederick. Carried forward since 1891.</div>
      <div><a href="{BASE_PATH}/sign-in">Sign in</a> · <a href="https://madeby1891.com/">madeby1891.com</a></div>
    </div>
  </div>
</footer>
<script src="{BASE_PATH}/assets/js/main.js?v={ASSET_V}" defer></script>
<script src="{BASE_PATH}/assets/js/marketing-interact.js?v={ASSET_V}" defer></script>
</body>
</html>
"""


def breadcrumb(*crumbs: tuple[str, str]) -> str:
    """crumbs: list of (label, href). The last crumb is current page; pass href as None or empty."""
    parts = ['<nav class="breadcrumb" aria-label="Breadcrumb"><div class="wrap">']
    last_idx = len(crumbs) - 1
    bits = []
    for i, (label, href) in enumerate(crumbs):
        if i == last_idx or not href:
            bits.append(f'<span aria-current="page">{label}</span>')
        else:
            bits.append(f'<a href="{href}">{label}</a>')
    parts.append(' › '.join(bits))
    parts.append('</div></nav>')
    return ''.join(parts)


# -----------------------------------------------------------------------------
# Page registry
# -----------------------------------------------------------------------------

@dataclass
class Page:
    path: str            # e.g. "pricing.html" or "features/scheduling.html"
    title: str
    description: str
    nav_active: str = ""
    breadcrumb_html: str = ""
    body: str = ""
    extra_head: str = ""
    og_title: str = ""

    def canonical(self) -> str:
        # 1891 convention: clean URLs everywhere — no .html in canonical or sitemap.
        # The .htaccess handles the rewrite + 301; canonical points at the clean form.
        if self.path == "index.html":
            return f"{CANONICAL_BASE}/"
        if self.path.endswith("/index.html"):
            # Subdirectory index pages (features/index.html, blog/index.html, ...) — emit "<dir>/".
            return f"{CANONICAL_BASE}/{self.path[:-len('index.html')]}"
        if self.path.endswith(".html"):
            return f"{CANONICAL_BASE}/{self.path[:-len('.html')]}"
        return f"{CANONICAL_BASE}/{self.path}"


# -----------------------------------------------------------------------------
# Page bodies — each function returns a string body
# -----------------------------------------------------------------------------

def home_body() -> str:
    return f"""
  <section class="hero">
    <div class="wrap">
      <div class="hero-grid">
        <div>
          <span class="badge">Built in Frederick · Carried forward since 1891</span>
          <h1>The interpreting agency platform built by the community it serves.</h1>
          <p class="lede">Scheduling. Interpreter app. Billing. Translation. Live captions. One tool.</p>
          <div class="supporting-deck" style="margin-top:var(--1891int-s-5)">
            <div>Spoken languages and signed languages, same tool, same price.</div>
            <div>Built so everyone in the room can use it, from the first screen.</div>
            <div>Free, forever, for verified Deaf-owned agencies.</div>
          </div>
          <div class="cluster" style="margin-top:var(--1891int-s-6)">
            <a class="btn btn-primary btn-lg" href="{BASE_PATH}/get-a-demo">Get a demo</a>
            <a class="btn btn-secondary btn-lg" href="{BASE_PATH}/free-for-deaf-owned">Free if Deaf-owned</a>
          </div>
          <p class="muted" style="margin-top:var(--1891int-s-5); font-size:14px">
            No credit card. No per-seat fees. No per-call fees. Export your data any day, with one click.
          </p>
        </div>
        <div>
          <!-- Lifecycle widget — auto-cycles a job OPEN → COMPLETED -->
          <div class="widget" data-widget="lifecycle" data-reveal></div>
        </div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <div class="center-text" style="margin-bottom:var(--1891int-s-7)">
        <span class="eyebrow">Three pillars</span>
        <h2>Why agencies switch to 1891.</h2>
      </div>
      <div class="grid grid-3">
        <div class="pillar" data-reveal>
          <span class="pillar-num" aria-hidden="true">1</span>
          <h3>Built by the community it serves</h3>
          <p>The co-founders are a fifth-generation-Deaf builder and a Certified Deaf Interpreter who chaired an interpreting program. People who've lived this work, not studied it from the outside.</p>
          <p><a href="{BASE_PATH}/about">Meet Anthony and Fallon →</a></p>
        </div>
        <div class="pillar" data-reveal data-delay="100">
          <span class="pillar-num" aria-hidden="true">2</span>
          <h3>Built so everyone can use it</h3>
          <p>Every screen works with a keyboard, reads cleanly in a screen reader, carries captions, and holds up in high contrast — from the first screen, not bolted on later.</p>
          <p><a href="{BASE_PATH}/accessibility">How we build for access →</a></p>
        </div>
        <div class="pillar" data-reveal data-delay="200">
          <span class="pillar-num" aria-hidden="true">3</span>
          <h3>Free forever for Deaf-owned agencies</h3>
          <p>Verified Deaf-owned? You pay nothing. Full features, unlimited interpreters, unlimited jobs, BAA included, no time limit.</p>
          <p><a href="{BASE_PATH}/free-for-deaf-owned">See the verification process →</a></p>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="center-text" style="margin-bottom:var(--1891int-s-6)">
        <span class="eyebrow">Click and see it</span>
        <h2 data-reveal>Four things you'd never quite believe in a screenshot.</h2>
        <p class="lede" data-reveal data-delay="100" style="margin:0 auto">Each of these is real, ready behavior. Mess with them.</p>
      </div>
      <div class="widget-showcase" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--1891int-s-6)">
        <div class="showcase-tile" data-reveal>
          <span class="eyebrow">One client, every department</span>
          <h3>Frederick Health → 4 departments → 6 locations → one billing office.</h3>
          <p>Click the client. The whole hierarchy unfolds. Invoices roll up however the client wants — by location, by specialist, or one consolidated statement per month.</p>
          <div class="widget" data-widget="clients"></div>
        </div>
        <div class="showcase-tile" data-reveal data-delay="100">
          <span class="eyebrow">What's billed, what's earned — live</span>
          <h3>Pick a job. See what the client pays and what the interpreter earns — instantly.</h3>
          <p>The premiums add up on their own — evening, weekend, short-notice. And when an interpreter's own minimum is higher, that's what wins.</p>
          <div class="widget" data-widget="rates"></div>
        </div>
        <div class="showcase-tile" data-reveal data-delay="200">
          <span class="eyebrow">Cancellations, no hidden math</span>
          <h3>Slide the clock. See what the client pays + what the interpreter still earns.</h3>
          <p>Cancel two days out and nobody's charged. The closer it gets, the more the client owes and the more the interpreter keeps. The scheduler sees this exact preview before they confirm.</p>
          <div class="widget" data-widget="cancel"></div>
        </div>
        <div class="showcase-tile" data-reveal data-delay="300">
          <span class="eyebrow">YES claims. NO declines.</span>
          <h3>Interpreters can accept an offer by text. Try it.</h3>
          <p>Reply YES to claim, NO to pass, STOP to opt out — that simple. We make sure every reply is really from them, never count a claim twice, and never put private details in a text.</p>
          <div class="widget" data-widget="sms"></div>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="grid grid-2" style="align-items:center; gap:var(--1891int-s-8)">
        <div>
          <span class="eyebrow">One platform, every modality</span>
          <h2>Signed, spoken, captioned, translated. Same scheduler, same invoice, same app.</h2>
          <p class="lede">Most platforms split signed and spoken language. Or split scheduling and billing. Or charge separately for translation. We don't.</p>
          <ul class="checks mt-5">
            <li><strong>ASL, ProTactile, and other signed languages</strong> — including CDI + voicer team configurations and relief rotations.</li>
            <li><strong>Spoken languages</strong> — Spanish, Mandarin, Arabic, Haitian Creole, and the long tail. On-site, VRI, OPI.</li>
            <li><strong>CART</strong> — NCRA-CRC realtime captioning, integrated with the same scheduling queue.</li>
            <li><strong>Document translation</strong> — with a human translator in the loop. Never pre-filled on legal or medical without review.</li>
            <li><strong>Live captions from speech</strong> — for the everyday meetings and trainings in between, with the words on screen as they're spoken.</li>
          </ul>
          <p style="margin-top:var(--1891int-s-5)"><a class="btn btn-ghost" href="{BASE_PATH}/features/">Browse all features →</a></p>
        </div>
        <div class="card card-warm">
          <h3 class="mt-0">A working day, on one screen.</h3>
          <p class="ink-soft">The scheduler day-of board shows open jobs, claimed jobs, cancellations, and replacements-needed in one view. Conflict rules in plain English. Preferred-interpreter requests surface from a requestor's history. Smart-fill explains its ranking — score breakdown is hover-visible, never a black box.</p>
          <ul class="xs mt-4">
            <li>No double-booking, ever.</li>
            <li>Warns on back-to-back across counties.</li>
            <li>Surfaces preferred interpreters from requestor history.</li>
            <li>Smart-fill ranking with transparent score breakdown.</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <div class="center-text" style="margin-bottom:var(--1891int-s-7)">
        <span class="eyebrow">Who it's for</span>
        <h2>One platform. Every party on the job.</h2>
        <p class="lede" style="margin:0 auto">Each role has a screen built for the work they actually do — not a permissions toggle on someone else's dashboard.</p>
      </div>
      <div class="grid grid-3">
        <a class="card card-hoverable" href="{BASE_PATH}/for-agencies">
          <h3>Agency owners</h3>
          <p class="ink-soft">Fewer schedulers per filled job. No per-seat tax. Your roster and your client list belong to you — export them any day.</p>
          <p class="text-bloom" style="font-weight:600">Math + data ownership →</p>
        </a>
        <a class="card card-hoverable" href="{BASE_PATH}/for-schedulers">
          <h3>Schedulers</h3>
          <p class="ink-soft">The day-of view that doesn't make you swivel between five tabs. Keyboard-first. Conflict rules in plain English.</p>
          <p class="text-bloom" style="font-weight:600">Watch the day-of demo →</p>
        </a>
        <a class="card card-hoverable" href="{BASE_PATH}/for-interpreters">
          <h3>Interpreters</h3>
          <p class="ink-soft">Claim a job in two taps. See what you'll be paid before you accept. Get paid the day the agency promised.</p>
          <p class="text-bloom" style="font-weight:600">Phone-first roster app →</p>
        </a>
        <a class="card card-hoverable" href="{BASE_PATH}/for-requestors">
          <h3>Requestors</h3>
          <p class="ink-soft">Book without learning new software. Reply to an email, fill a two-field form, or call. Same outcome.</p>
          <p class="text-bloom" style="font-weight:600">Three ways to book →</p>
        </a>
        <a class="card card-hoverable" href="{BASE_PATH}/for-payers">
          <h3>Billing / AP / CFO</h3>
          <p class="ink-soft">Net-30. Consolidated billing. GL coding. NetSuite, QuickBooks, Xero, Bill.com exports. PHI redacted by default.</p>
          <p class="text-bloom" style="font-weight:600">See a sample invoice →</p>
        </a>
        <a class="card card-hoverable" href="{BASE_PATH}/security">
          <h3>Security &amp; compliance</h3>
          <p class="ink-soft">HIPAA-defensible. BAA included on every paid tier and on the Deaf-owned tier. Audit log exportable.</p>
          <p class="text-bloom" style="font-weight:600">Read the security posture →</p>
        </a>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap-narrow">
      <span class="eyebrow">The math</span>
      <h2>Flat monthly per agency. No per-seat tax. No per-job fee.</h2>
      <p class="lede">A six-person agency with five schedulers and twenty-five interpreters pays the same as a six-person agency with two schedulers. We don't tax growth on the platform.</p>
    </div>
    <div class="wrap mt-7">
      <div class="table-scroll">
        <table class="compare">
          <thead>
            <tr>
              <th>Dimension</th>
              <th class="own">1891 Interpreter</th>
              <th>Per-seat platforms</th>
              <th>Custom FileMaker / Excel</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Pricing model</td><td class="own">Flat monthly per agency</td><td>Per-seat + per-call / per-job</td><td>One-time license + dev time</td></tr>
            <tr><td>Per-job fee</td><td class="own yes">$0</td><td>Yes, varies</td><td>$0 (no value-add)</td></tr>
            <tr><td>Free tier</td><td class="own yes">Yes — Deaf-owned, full features, unlimited</td><td class="no">No</td><td>N/A</td></tr>
            <tr><td>Data export</td><td class="own">One click — CSV + JSON</td><td>Per request</td><td>Native to your file</td></tr>
            <tr><td>Public pricing</td><td class="own">Every tier, including Network floor</td><td>Partial</td><td>N/A</td></tr>
          </tbody>
        </table>
      </div>
      <p class="muted" style="font-size:13.5px; margin-top:var(--1891int-s-3)">We don't bash. We just show the math.</p>
      <div class="cluster" style="margin-top:var(--1891int-s-5)">
        <a class="btn btn-primary" href="{BASE_PATH}/pricing">See all pricing tiers</a>
        <a class="btn btn-ghost" href="{BASE_PATH}/for-agencies">Compare your current spend</a>
      </div>
    </div>
  </section>

  <section class="section section-river">
    <div class="wrap">
      <div class="grid grid-2" style="align-items:center; gap:var(--1891int-s-8)">
        <div>
          <span class="eyebrow" style="color:#FFE2D6">Security</span>
          <h2>Built to hold up to HIPAA.</h2>
          <p class="lede" style="color:#DCE9E7">Patient details are stripped out before anything reaches an AI tool. Every time a record is opened, it's written down. And a signed BAA comes with every paid plan — and the Deaf-owned plan too.</p>
          <ul class="xs" style="margin-top:var(--1891int-s-4)">
            <li style="color:#DCE9E7">Encrypted coming and going, with your data walled off from every other agency's.</li>
            <li style="color:#DCE9E7">Maryland's two-party-consent rules built into any moment audio is captured.</li>
            <li style="color:#DCE9E7">A seven-year audit log that can't be quietly edited.</li>
            <li style="color:#DCE9E7">Our subprocessor list is public, and a BAA is signed in days, not weeks.</li>
          </ul>
          <p style="margin-top:var(--1891int-s-5)"><a class="btn btn-secondary" style="border-color:#fff;color:#fff" href="{BASE_PATH}/security">Read the security posture</a></p>
        </div>
        <div>
          <div class="card" style="background:var(--1891int-river-deep); border-color:var(--1891int-river-soft); color:var(--1891int-paper)">
            <h3 style="color:var(--1891int-paper)" class="mt-0">What the AI never sees</h3>
            <ul class="xs" style="margin:0">
              <li style="color:#DCE9E7">A consumer's name — shortened to initials before any of it is read.</li>
              <li style="color:#DCE9E7">Anything clinical written in free text — removed first.</li>
              <li style="color:#DCE9E7">Phone numbers, record numbers, dates of birth — swapped for stand-ins, and put back only on your side.</li>
              <li style="color:#DCE9E7">Anything said during a private session or while the mic is paused.</li>
            </ul>
            <p class="tag" style="color:#88B0AE; margin-top:var(--1891int-s-4)">The full details are on the security and BAA pages.</p>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap-narrow center-text">
      <span class="eyebrow">The 1891 lineage</span>
      <h2>Built in Frederick. Carried forward since 1891.</h2>
      <p class="lede" style="margin:0 auto">Five generations Deaf in one family. The lineage is the undercurrent, not the headline — universal-design framing leads. This page is reputation, not conversion.</p>
      <p style="margin-top:var(--1891int-s-5)"><a class="btn btn-ghost" href="{BASE_PATH}/our-1891">Read the story →</a></p>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap center-text">
      <h2>Two ways to start.</h2>
      <p class="lede" style="margin:0 auto var(--1891int-s-6)">Either path gets you to a real person within one business day.</p>
      <div class="cluster" style="justify-content:center">
        <a class="btn btn-primary btn-lg" href="{BASE_PATH}/get-a-demo">Walk through it with us</a>
        <a class="btn btn-secondary btn-lg" href="{BASE_PATH}/free-for-deaf-owned">Start free if Deaf-owned</a>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="center-text" style="margin-bottom:var(--1891int-s-7)">
        <span class="eyebrow">From the workspace</span>
        <h2>The kit the products are built from.</h2>
        <p class="lede" style="margin:0 auto">A handful of capabilities the studio sharpens every year. Each product picks the ones its room needs.</p>
      </div>
      <div class="grid grid-3">
        <div class="pillar"><h3>Multi-device web</h3><p>Tablet on the podium. TV at the front of the room. Phone in every hand. Same URL, three floor plans. Nothing to install.</p></div>
        <div class="pillar"><h3>One Stripe spine</h3><p>Every product takes money the same way. Receipts arrive from the same address. The studio doesn't sit in the middle of your funds.</p></div>
        <div class="pillar"><h3>Your data, yours.</h3><p>Records, archives, rosters belong to you. Export anything, anytime, in plain formats. If you ever leave, you leave with everything.</p></div>
        <div class="pillar"><h3>Live at the edge</h3><p>Counters update the moment the vote does. Brackets update the moment the game ends. No refresh.</p></div>
        <div class="pillar"><h3>Captions default-on</h3><p>Audio is additive, never sole. Every state change carries color, icon, and text. Speakers muted, the product still works.</p></div>
        <div class="pillar"><h3>Built in Frederick</h3><p>The same person who solders the board writes the firmware and pushes the deploy. The studio that built it is the studio that runs it.</p></div>
      </div>
      <p class="muted" style="text-align:center; margin-top:var(--1891int-s-6); font-size:14px">See the workspace at <a href="https://madeby1891.com/products/" style="color:inherit; text-decoration:underline">madeby1891.com/products</a>.</p>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <div class="center-text" style="margin-bottom:var(--1891int-s-6)">
        <span class="eyebrow">From the studio that builds</span>
        <h2>Three other 1891 products.</h2>
      </div>
      <div class="grid grid-3">
        <a class="pillar" href="https://madeby1891.com/parliamentarian/" style="text-decoration:none; color:inherit; display:block">
          <h3>Parliamentarian</h3>
          <p>Robert's Rules, on the screen at the front of the room and in every hand.</p>
          <p style="font-size:14px; color:#5B6770">Walk through it →</p>
        </a>
        <a class="pillar" href="https://madeby1891.com/meetings/" style="text-decoration:none; color:inherit; display:block">
          <h3>Meetings</h3>
          <p>Plain meetings. Real signal from the room.</p>
          <p style="font-size:14px; color:#5B6770">Walk through it →</p>
        </a>
        <a class="pillar" href="https://madeby1891.com/arena/" style="text-decoration:none; color:inherit; display:block">
          <h3>Arena</h3>
          <p>Two sports. One arena. Brackets that update live.</p>
          <p style="font-size:14px; color:#5B6770">Walk through it →</p>
        </a>
      </div>
    </div>
  </section>
"""


def for_agencies_body() -> str:
    return f"""
  {audience_switch("agencies")}
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">For agency owners</span>
      <h1>The math, and your data, in your hands.</h1>
      <p class="lede">Flat per agency — no per-seat tax, no per-job fee. One clean bill per client, however their departments and locations are organized. A tamper-evident audit log. And your roster, clients, and invoices export with one click, any day you like.</p>
      <div class="cluster" style="margin-top:var(--1891int-s-6)">
        <a class="btn btn-primary btn-lg" href="#calculator">Compare your current spend</a>
        <a class="btn btn-secondary btn-lg" href="{BASE_PATH}/get-a-demo">Talk to us</a>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-8); align-items:flex-start">
        <div>
          <span class="eyebrow">Pricing model</span>
          <h2>Flat monthly per agency.</h2>
          <p class="ink-soft">A six-person agency on a per-seat platform with five schedulers and twenty-five interpreters ends up in the high-three-figures to low-four-figures monthly once per-job fees layer in. <strong>Practice at $249 flat</strong> is a deliberate price wall. Round number, easy to defend to a CFO, doesn't require a procurement cycle.</p>
          <ul class="checks">
            <li>No per-seat fees. Five schedulers cost the same as one.</li>
            <li>No per-job fee. Not a percentage, not a flat fee. You book a job, you don't pay us for that job.</li>
            <li>No per-minute fee on video or phone interpreting. You pay the call's actual cost, itemized — never marked up.</li>
            <li>No skim on payments. The card processor's standard rate is all you pay; we don't take a cut on top.</li>
          </ul>
          <p style="margin-top:var(--1891int-s-5)"><a class="btn btn-ghost" href="{BASE_PATH}/pricing">See all tiers</a></p>
        </div>
        <div class="card card-warm" id="calculator">
          <span class="badge">Quick math</span>
          <h3 class="mt-0" style="margin-top:var(--1891int-s-3)">If you have…</h3>
          <ul class="xs">
            <li><strong>1–5 interpreters</strong> — Solo ($9/mo) or Practice ($249/mo) once you hire a scheduler.</li>
            <li><strong>6–25 interpreters</strong> — Practice tier. $249/mo flat, no surprises.</li>
            <li><strong>26–100 interpreters</strong> — Studio tier. $749/mo, with single sign-on and your own web address.</li>
            <li><strong>100+ interpreters, multi-state</strong> — Network tier. From $2,400/mo, with your own branding, security-log export, and a dedicated support agreement.</li>
            <li><strong>Verified Deaf-owned</strong> — $0. Full features. No asterisks.</li>
          </ul>
          <p class="tag" style="margin-top:var(--1891int-s-4)">Compare against any quote you've gotten. The math is on our side.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <div class="center-text" style="margin-bottom:var(--1891int-s-7)">
        <span class="eyebrow">Data ownership</span>
        <h2>Export your roster, your client list, your invoices. Any day. One click.</h2>
        <p class="lede" style="margin:0 auto">The export button sits on the same page as the cancel-account button. Same place. Same prominence.</p>
      </div>
      <div class="grid grid-3">
        <div class="card">
          <h3 class="mt-0">CSV + JSON</h3>
          <p class="ink-soft">Everything — interpreters, requestors, consumers, jobs, invoices, payouts, rate cards — exports to both formats. The layout stays steady release to release, and we note any change in the changelog.</p>
        </div>
        <div class="card">
          <h3 class="mt-0">No data ransom</h3>
          <p class="ink-soft">Cancel today and your full export waits in your inbox before the trial expires. We don't hold roster data hostage to force a contract renewal.</p>
        </div>
        <div class="card">
          <h3 class="mt-0">Your audit log, in plain text</h3>
          <p class="ink-soft">The audit log exports too. Every record opened, every assignment, every refund — with the time and the person who did it. Tamper-evident, so it can't be quietly edited.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">What it covers</span>
      <h2>Every modality, every party, every billing model.</h2>
      <div class="grid grid-2" style="margin-top:var(--1891int-s-6)">
        <div>
          <h3>Modalities</h3>
          <ul class="checks">
            <li>ASL and other signed languages, including team jobs.</li>
            <li>Spoken languages — on-site, by video, or by phone.</li>
            <li>Real-time captioning (CART).</li>
            <li>Document translation, with a person checking every page.</li>
            <li>Live captions from speech for everyday meetings.</li>
          </ul>
        </div>
        <div>
          <h3>Billing</h3>
          <ul class="checks">
            <li>Per-hour, per-event, per-word — your rates, your way.</li>
            <li>One clean bill per client, however their departments and locations are organized.</li>
            <li>Invoice numbers that run in order, with no gaps to chase.</li>
            <li>1099 filing handled, and interpreters paid by direct deposit.</li>
            <li>Hands off to QuickBooks, Xero, NetSuite, and Bill.com.</li>
            <li>Payment stubs that separate the work from the expenses, each with its own total.</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-8); align-items:center">
        <div data-reveal>
          <span class="eyebrow">Your Monday-morning screen</span>
          <h2>Roster, clients, jobs, and money owed — one place.</h2>
          <p class="ink-soft">The numbers you actually check, in one glance — and you can click any of them to drill into the detail behind it.</p>
          <ul class="checks mt-4">
            <li><strong>Roster at a glance.</strong> Who's active, who's free right now, and a heads-up before a credential or W-9 lapses and costs you a fill.</li>
            <li><strong>How things are running.</strong> Open jobs, fill rate, how fast you're filling, your busiest clients.</li>
            <li><strong>Where the money is.</strong> What clients still owe, by age, and what you still owe your interpreters.</li>
          </ul>
        </div>
        <div data-reveal data-delay="100">{mock_frame("This week · your agency", ui_reporting(), caption="The numbers that matter, ready every morning.")}</div>
      </div>
      <p class="tag" style="margin-top:var(--1891int-s-6)">And a full audit log behind it all — filter by date, person, or action, and export to a spreadsheet. Tamper-evident, so the record holds up.</p>
    </div>
  </section>

  <section class="section section-river">
    <div class="wrap">
      <div class="center-text">
        <h2>BAA included on every paid tier and on the Deaf-owned tier.</h2>
        <p class="lede" style="color:#DCE9E7; margin:0 auto">Signed in days, not weeks. Our standard BAA covers every product surface that touches PHI. Custom redlines welcome on Studio and Network.</p>
        <p style="margin-top:var(--1891int-s-5)"><a class="btn btn-secondary" style="border-color:#fff;color:#fff" href="{BASE_PATH}/legal/baa">Read the BAA</a> <a class="btn btn-ghost" style="border-color:#FFE2D6;color:#fff" href="{BASE_PATH}/security">Security posture</a></p>
      </div>
    </div>
  </section>

  {cta_band("Talk to us about your agency.", "Get a demo", f"{BASE_PATH}/get-a-demo", "Start free if Deaf-owned", f"{BASE_PATH}/free-for-deaf-owned")}
"""


def audience_switch(active: str) -> str:
    items = [
        ("agencies",     "/for-agencies",     "Agencies"),
        ("schedulers",   "/for-schedulers",   "Schedulers"),
        ("interpreters", "/for-interpreters", "Interpreters"),
        ("requestors",   "/for-requestors",   "Requestors"),
        ("payers",       "/for-payers",       "Billing / AP"),
    ]
    parts = ['<div class="wrap" style="padding-top:var(--1891int-s-6);padding-bottom:0"><nav class="audience-switch" aria-label="Audience">']
    for key, href, label in items:
        cur = ' aria-current="page"' if key == active else ''
        parts.append(f'<a href="{BASE_PATH}{href}"{cur}>{label}</a>')
    parts.append('</nav></div>')
    return ''.join(parts)


def cta_band(headline: str, btn1: str, href1: str, btn2: str, href2: str) -> str:
    return f"""
  <section class="section section-warm">
    <div class="wrap center-text">
      <h2>{headline}</h2>
      <p class="lede" style="margin:0 auto var(--1891int-s-6)">Either path gets you to a real person within one business day.</p>
      <div class="cluster" style="justify-content:center">
        <a class="btn btn-primary btn-lg" href="{href1}">{btn1}</a>
        <a class="btn btn-secondary btn-lg" href="{href2}">{btn2}</a>
      </div>
    </div>
  </section>
"""


# -----------------------------------------------------------------------------
# Product mockups — clickable "screenshot" frames + the little UIs inside them.
# These let every feature page SHOW the screen, not just describe it. Each frame
# can be wrapped as a link (whole picture is clickable) with an "open the live
# demo" pill that fades in on hover. Styling lives in marketing-interact.css.
# -----------------------------------------------------------------------------

def mock_frame(tab: str, inner: str, href: str = "", caption: str = "",
               open_label: str = "Open the live demo") -> str:
    """A browser-window screenshot frame. If href is set, the whole frame is a
    clickable link with a hover 'open demo' overlay."""
    bar = (
        '<div class="mock-bar">'
        '<span class="mock-dots"><span></span><span></span><span></span></span>'
        f'<span class="mock-tab">{tab}</span>'
        '</div>'
    )
    body = f'<div class="mock-body">{inner}</div>'
    if href:
        overlay = (f'<span class="mock-open">{open_label} '
                   f'<span class="mock-open-arrow" aria-hidden="true">→</span></span>')
        frame = f'<a class="mock" href="{href}" aria-label="{open_label}">{bar}{body}{overlay}</a>'
    else:
        frame = f'<div class="mock">{bar}{body}</div>'
    cap = f'<p class="mock-caption">{caption}</p>' if caption else ''
    return f'<div class="mock-stage">{frame}{cap}</div>'


def mock_phone(inner: str, caption: str = "") -> str:
    cap = f'<p class="mock-caption">{caption}</p>' if caption else ''
    return (f'<div class="mock-stage"><div class="mock-phone">'
            f'<span class="mock-notch"></span>'
            f'<div class="mock-screen">{inner}</div></div>{cap}</div>')


# --- Inner UIs (one per feature) --------------------------------------------

def ui_scheduler_board() -> str:
    return """
      <div class="ui-toolbar">
        <span class="ui-search">Today · all jobs</span>
        <span class="mchip is-open">Open 3</span>
        <span class="mchip is-claimed">Claimed 5</span>
        <span class="mchip is-confirmed">Confirmed 9</span>
      </div>
      <div class="ui-row">
        <div class="ui-row-main"><span class="ui-row-title">Medical · ASL · 2:00 PM</span><span class="ui-row-sub">Frederick Health Cardiology · M.R.</span></div>
        <span class="mchip is-open">Open</span>
      </div>
      <div class="ui-row is-highlight">
        <div class="ui-row-main"><span class="ui-row-title">Legal · Spanish · 3:30 PM</span><span class="ui-row-sub">Filling now — offer out to 3 interpreters</span></div>
        <span class="mchip is-offered">Offered</span>
      </div>
      <div class="ui-row">
        <div class="ui-row-main"><span class="ui-row-title">School IEP · ASL · 4:00 PM</span><span class="ui-row-sub">Pat M. · confirmed, calendar invite sent</span></div>
        <span class="mchip is-confirmed">Confirmed</span>
      </div>"""


def ui_smartfill() -> str:
    return """
      <div class="ui-row is-highlight">
        <div class="ui-row-main"><span class="ui-row-title">Pat Morales, CDI</span><span class="ui-row-sub">Best match for this job</span></div>
        <span class="ui-row-side">94</span>
      </div>
      <div class="ui-score"><span class="ui-score-lbl">Right credential</span><span class="ui-score-track"><span class="ui-score-fill" style="width:96%"></span></span><span class="ui-score-val">96</span></div>
      <div class="ui-score"><span class="ui-score-lbl">Close by</span><span class="ui-score-track"><span class="ui-score-fill" style="width:88%"></span></span><span class="ui-score-val">88</span></div>
      <div class="ui-score"><span class="ui-score-lbl">Asked for before</span><span class="ui-score-track"><span class="ui-score-fill" style="width:100%"></span></span><span class="ui-score-val">100</span></div>
      <div class="ui-score"><span class="ui-score-lbl">Fair rotation</span><span class="ui-score-track"><span class="ui-score-fill" style="width:82%"></span></span><span class="ui-score-val">82</span></div>"""


def ui_conflict_rules() -> str:
    return """
      <div class="ui-row"><div class="ui-row-main"><span class="ui-row-title">No double-booking</span><span class="ui-row-sub">Already on a 2:00 job — this one is blocked</span></div><span class="mchip is-warn">Blocked</span></div>
      <div class="ui-row"><div class="ui-row-main"><span class="ui-row-title">Back-to-back, two counties</span><span class="ui-row-sub">38-minute drive between them — heads up</span></div><span class="mchip is-open">Warning</span></div>
      <div class="ui-row"><div class="ui-row-main"><span class="ui-row-title">Asked for by this clinic</span><span class="ui-row-sub">Booked here 4× this quarter</span></div><span class="mchip is-confirmed">Good fit</span></div>"""


def ui_interpreter_offer() -> str:
    return """
      <div class="tag" style="color:var(--1891int-bloom-deep)">TODAY · 2:00 PM</div>
      <h3 class="mt-0" style="margin:6px 0 4px;font-size:21px">Medical · ASL</h3>
      <p class="ink-soft" style="font-size:13.5px;margin-bottom:10px">Consumer J.M. · 90 min<br>Frederick Health, Room 412</p>
      <div style="border-top:1px solid var(--1891int-line);padding-top:10px">
        <div style="display:flex;justify-content:space-between;font-size:13.5px;padding:2px 0"><span>Hourly</span><strong>$95/hr</strong></div>
        <div style="display:flex;justify-content:space-between;font-size:13.5px;padding:2px 0"><span>2-hour minimum</span><strong>$190.00</strong></div>
        <div style="display:flex;justify-content:space-between;font-size:13.5px;padding:2px 0"><span>Mileage · 12 mi</span><strong>$8.04</strong></div>
        <div class="ui-total" style="margin-top:8px;padding-top:8px"><span style="font-size:14px">You'll be paid</span><span class="ui-total-num" style="font-size:20px">$198.04</span></div>
      </div>
      <button class="btn btn-primary" style="width:100%;margin-top:12px" type="button">Claim</button>
      <p class="tag" style="text-align:center;margin-top:8px">Two taps. No surprises.</p>"""


def ui_closeout() -> str:
    return """
      <strong style="font-family:var(--1891int-display);font-size:17px">Close out — Medical · ASL</strong>
      <div class="ui-field" style="margin-top:10px"><span class="ui-field-k">Scheduled</span><span class="ui-field-v">2:00 – 3:30 PM</span></div>
      <div class="ui-field"><span class="ui-field-k">Actual</span><span class="ui-field-v">2:00 – 3:42 PM</span></div>
      <div class="ui-row" style="margin-top:10px"><div class="ui-row-main"><span class="ui-row-title">Mileage · 12 mi</span><span class="ui-row-sub">Receipt attached</span></div><span class="ui-row-side">$8.04</span></div>
      <div class="ui-row"><div class="ui-row-main"><span class="ui-row-title">Parking</span><span class="ui-row-sub">Receipt attached</span></div><span class="ui-row-side">$6.00</span></div>
      <div style="display:flex;gap:6px;margin-top:10px;align-items:center;flex-wrap:wrap"><span class="mchip is-warn">Ran 12 min long — add a note</span></div>"""


def ui_invoice() -> str:
    return """
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <strong style="font-family:var(--1891int-display);font-size:18px">Invoice · 0042</strong>
        <span class="mchip is-plain">Net 30</span>
      </div>
      <p class="ink-soft" style="font-size:12px;margin:0 0 12px">Frederick Health — one bill for every department</p>
      <div class="ui-row"><div class="ui-row-main"><span class="ui-row-title">Cardiology · ASL · 2 hr</span><span class="ui-row-sub">Urbana Clinic · M.R.</span></div><span class="ui-row-side">$210.00</span></div>
      <div class="ui-row"><div class="ui-row-main"><span class="ui-row-title">Emergency · Spanish · 1 hr</span><span class="ui-row-sub">FH Emergency · J.D.</span></div><span class="ui-row-side">$135.00</span></div>
      <div class="ui-row"><div class="ui-row-main"><span class="ui-row-title">Pediatrics · ASL · 1.5 hr</span><span class="ui-row-sub">Mt Airy · L.P.</span></div><span class="ui-row-side">$172.50</span></div>
      <div class="ui-total"><span>Total due</span><span class="ui-total-num">$517.50</span></div>"""


def ui_reporting() -> str:
    return """
      <div class="ui-kpis">
        <div class="ui-kpi"><div class="ui-kpi-num">94%</div><div class="ui-kpi-lbl">Jobs filled</div><div class="ui-kpi-trend">▲ 6 pts</div></div>
        <div class="ui-kpi"><div class="ui-kpi-num">38m</div><div class="ui-kpi-lbl">Time to fill</div><div class="ui-kpi-trend">▲ faster</div></div>
        <div class="ui-kpi"><div class="ui-kpi-num">$12k</div><div class="ui-kpi-lbl">Money owed</div><div class="ui-kpi-trend">on track</div></div>
      </div>
      <div class="ui-chart" aria-hidden="true">
        <div class="ui-col"><i style="height:42%"></i><span>Mon</span></div>
        <div class="ui-col"><i style="height:64%"></i><span>Tue</span></div>
        <div class="ui-col"><i style="height:51%"></i><span>Wed</span></div>
        <div class="ui-col"><i style="height:78%"></i><span>Thu</span></div>
        <div class="ui-col"><i style="height:88%"></i><span>Fri</span></div>
        <div class="ui-col"><i style="height:30%"></i><span>Sat</span></div>
      </div>"""


def ui_intake() -> str:
    return """
      <div class="ui-panes">
        <div class="ui-pane">
          <h5>The email that came in</h5>
          “Hi — we need an ASL interpreter for a cardiology follow-up next Tuesday at 2pm, about 90 minutes, at the Urbana clinic. Patient is <span class="ui-redact">REDACTED</span>.”
        </div>
        <div class="ui-pane is-out">
          <h5>A draft job, ready for you to check</h5>
          <div class="ui-field"><span class="ui-field-k">Language</span><span class="ui-field-v">ASL</span></div>
          <div class="ui-field"><span class="ui-field-k">Setting</span><span class="ui-field-v">Medical</span></div>
          <div class="ui-field"><span class="ui-field-k">When</span><span class="ui-field-v">Tue · 2:00 PM</span></div>
          <div class="ui-field"><span class="ui-field-k">Length</span><span class="ui-field-v">90 min</span></div>
          <div class="ui-field"><span class="ui-field-k">Where</span><span class="ui-field-v">Urbana clinic</span></div>
          <div class="ui-field"><span class="ui-field-k">Patient</span><span class="ui-token">kept private</span></div>
        </div>
      </div>"""


def ui_vri() -> str:
    return """
      <div class="ui-stage">
        <div class="ui-tile t-a"><span class="ui-tile-tag">Interpreter</span></div>
        <div class="ui-tile t-b"><span class="ui-tile-tag">Provider &amp; patient</span></div>
      </div>
      <div class="ui-caption" style="margin-top:10px">
        <p class="ui-cap-line"><span class="ui-cap-spk">Captions on</span> · recording only with consent</p>
        <p class="ui-cap-line ui-cap-live">“Let's go over your results together”</p>
      </div>"""


def ui_captions() -> str:
    return """
      <div class="ui-caption">
        <p class="ui-cap-line"><span class="ui-cap-spk">Chair:</span> Thank you all for coming this evening.</p>
        <p class="ui-cap-line"><span class="ui-cap-spk">Member:</span> I move that we approve the budget as presented.</p>
        <p class="ui-cap-line ui-cap-live">The motion is seconded and open for discussion</p>
      </div>
      <div style="display:flex;gap:6px;margin-top:10px;align-items:center;flex-wrap:wrap">
        <span class="mchip is-confirmed">Captions on</span>
        <span class="mchip is-plain">Transcript saved</span>
      </div>"""


def ui_translation() -> str:
    return """
      <div class="ui-panes">
        <div class="ui-pane"><h5>Source · English</h5>Please arrive 15 minutes before your appointment and bring a photo ID and your insurance card.</div>
        <div class="ui-pane is-out"><h5>Spanish · translator reviewing</h5>Por favor, llegue 15 minutos antes de su cita y traiga una identificación con foto y su tarjeta del seguro.</div>
      </div>
      <div style="display:flex;gap:6px;margin-top:10px;align-items:center;flex-wrap:wrap">
        <span class="mchip is-claimed">A person reviews every page</span>
        <span class="mchip is-warn">Never auto-filled on medical or legal</span>
      </div>"""


def ui_integrations() -> str:
    return """
      <div class="ui-integ">
        <div class="ui-itile"><div class="ui-itile-ico">📒</div><span class="ui-itile-lbl">Accounting</span></div>
        <div class="ui-itile"><div class="ui-itile-ico">💳</div><span class="ui-itile-lbl">Payouts</span></div>
        <div class="ui-itile"><div class="ui-itile-ico">🧾</div><span class="ui-itile-lbl">1099 filing</span></div>
        <div class="ui-itile"><div class="ui-itile-ico">👥</div><span class="ui-itile-lbl">Payroll hours</span></div>
        <div class="ui-itile"><div class="ui-itile-ico">✉️</div><span class="ui-itile-lbl">Email &amp; text</span></div>
        <div class="ui-itile"><div class="ui-itile-ico">🔐</div><span class="ui-itile-lbl">Single sign-on</span></div>
      </div>"""


def for_schedulers_body() -> str:
    return f"""
  {audience_switch("schedulers")}
  <section class="feature-hero">
    <div class="wrap">
      <div class="hero-grid">
        <div>
          <span class="eyebrow">For schedulers</span>
          <h1>The whole day on one board. No more swiveling between tabs.</h1>
          <p class="lede">Jobs, interpreters, clients, invoices — one place, one search, one set of filters. Your view survives a refresh, a shared link, and the back button, so you never lose your spot.</p>
          <div class="cluster" style="margin-top:var(--1891int-s-6)">
            <a class="btn btn-primary btn-lg" href="{BASE_PATH}/get-a-demo">Watch the day-of demo</a>
            <a class="btn btn-ghost btn-lg" href="{BASE_PATH}/features/scheduling">See the feature</a>
          </div>
        </div>
        <div data-reveal data-delay="100">{mock_frame("Today's board · your agency", ui_scheduler_board(), href=f"{BASE_PATH}/get-a-demo", caption="Open, claimed, confirmed — at a glance. <strong>Click to walk through it.</strong>")}</div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-8); align-items:flex-start">
        <div>
          <h2>One board, every job in flight.</h2>
          <p class="ink-soft">Today's roster, today's jobs, today's surprises — all on one screen. Filter by status, search anyone, sort by any column, and edit most fields right in place without opening a thing. Drag the board to a second monitor and keep the job you're working on the first.</p>
          <ul class="checks">
            <li>Filters and search on every list. Stack them; they stick through a refresh.</li>
            <li>Sort by any column with a click.</li>
            <li>Edit most fields in place — no pop-up to wait on.</li>
            <li>A full audit log, filterable by date, person, or action, exportable to a spreadsheet.</li>
          </ul>
        </div>
        <div class="card card-warm">
          <h3 class="mt-0">Warnings that explain themselves</h3>
          <p class="ink-soft">Every flag comes with a one-line reason, so you know why it fired — not just that it did.</p>
          <ul class="xs">
            <li><strong>No double-booking, ever.</strong> A hard stop; overriding asks you why.</li>
            <li><strong>Back-to-back across town.</strong> A heads-up with the drive time.</li>
            <li><strong>Wrong fit.</strong> Flags when an interpreter's credentials don't match what the job needs.</li>
            <li><strong>A favorite is free.</strong> Tells you this clinic has booked this interpreter 4× this quarter — before you send the offer.</li>
            <li><strong>Missing a teammate.</strong> Catches a team job that still needs its second interpreter.</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-8); align-items:center">
        <div data-reveal>
          <span class="eyebrow">One client, one bill</span>
          <h2>However their departments are organized, it's one clean statement.</h2>
          <p class="ink-soft">A hospital might be one client with four departments, half a dozen locations, and a dozen doctors. You choose how the bill comes together — all on one statement, by department, by location, or one per job — and you can do it differently for each client. <strong>Click the client to open it up →</strong></p>
          <ul class="xs mt-4">
            <li>A document shelf per client — contracts, agreements, certificates of insurance, W-9s — with reminders before anything lapses.</li>
            <li>Every invoice line shows exactly what the client wants to see, and invoice numbers run in order with no gaps.</li>
          </ul>
        </div>
        <div data-reveal data-delay="100"><div class="widget" data-widget="clients"></div></div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-8); align-items:flex-start">
        <div>
          <span class="eyebrow">Before you cancel</span>
          <h2>See what it costs — then confirm.</h2>
          <p class="ink-soft">Canceling doesn't mean guessing. Before you confirm, you see exactly what the client is billed and what each interpreter still earns, under that client's own rules. No awkward call later. <em>“Cancel now bills $X and pays $Y per interpreter.”</em></p>
        </div>
        <div>
          <span class="eyebrow">Private until claimed</span>
          <h2>Just enough to decide. The rest opens on accept.</h2>
          <p class="ink-soft">Interpreters browse offers with the kind of job, the time, the pay, and the consumer's initials. The moment they accept, the full details open — and that hand-off is written down with a name and a time.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-8); align-items:center">
        <div data-reveal>
          <span class="eyebrow">Suggested for you</span>
          <h2>The right interpreter, ranked — and it shows its work.</h2>
          <p class="ink-soft">For every open job you get a short list of the best people for it, ranked by who has the right credential, who's nearby, who this clinic has asked for before, and whose turn it is. Each suggestion shows why it ranks where it does, so it's a head start — never a black box. When you send it out, the offer goes to the top three at once and whoever says yes first gets the job.</p>
        </div>
        <div data-reveal data-delay="100">{mock_frame("Suggested for this job", ui_smartfill(), caption="The reasons behind every ranking, in plain sight.")}</div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <h2>Your team, with the right doors open.</h2>
      <p class="lede">Invite anyone in a couple of clicks. Each person sees only what their job needs — a scheduler's view isn't a billing contact's view — and invitations expire on their own if they're not used.</p>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">Roles that fit the work</h3><p class="ink-soft">Owners, managers, schedulers, interpreters, and client, requestor, and billing contacts — each with the right reach. Managers can invite their team; only owners add other managers.</p></div>
        <div class="card"><h3 class="mt-0">No passwords to manage</h3><p class="ink-soft">Sign in with a link sent to your email — nothing to remember or reset. If you work with more than one agency, you pick which one when you land.</p></div>
        <div class="card"><h3 class="mt-0">Your Monday-morning screen</h3><p class="ink-soft">Roster on hand, who's available right now, open jobs, fill rate, how fast you're filling, money owed — the numbers you actually check, all in one place.</p></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap-narrow center-text">
      <span class="eyebrow">Built for the keyboard</span>
      <h2>If you live on the board, your hands stay on the keys.</h2>
      <p class="lede" style="margin:0 auto">Move through the queue, jump to search, assign, confirm, or cancel — all without reaching for the mouse. Press <kbd>?</kbd> any time to see the full list. The shortcuts are there when you want them and out of the way when you don't.</p>
    </div>
  </section>

  {cta_band("See the board in motion.", "Watch the day-of demo", f"{BASE_PATH}/get-a-demo", "See the feature", f"{BASE_PATH}/features/scheduling")}
"""


def for_interpreters_body() -> str:
    return f"""
  {audience_switch("interpreters")}
  <section class="feature-hero">
    <div class="wrap">
      <div class="hero-grid">
        <div>
          <span class="eyebrow">For interpreters</span>
          <h1>Claim a job in two taps. Or just reply YES to a text.</h1>
          <p class="lede">Phone-friendly, for wherever the job takes you. See exactly what you'll be paid before you accept, close out with your real times and expenses in one screen, and get paid the day you were promised.</p>
          <p class="ink-soft" style="margin-top:var(--1891int-s-3); font-size:15px"><strong>The agency signs the contract — but you're the reason it's worth anything.</strong> The app is built like it.</p>
          <div class="cluster" style="margin-top:var(--1891int-s-6)">
            <a class="btn btn-primary btn-lg" href="{BASE_PATH}/features/interpreter-app">See the app</a>
            <a class="btn btn-ghost btn-lg" href="{BASE_PATH}/get-a-demo">Get a demo</a>
          </div>
        </div>
        <div data-reveal data-delay="100">{mock_phone(ui_interpreter_offer(), caption="The offer, the pay, and the Claim button — one tap from your texts.")}</div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-8); align-items:center">
        <div data-reveal>
          <h2>Or just reply YES to a text.</h2>
          <p class="ink-soft">Hands full between assignments? Reply <strong>YES</strong> to claim or <strong>NO</strong> to pass — no app to open, no password to dig up. It counts exactly the same as tapping Claim. <strong>Try it on the right →</strong></p>
          <ul class="checks mt-4">
            <li><strong>See your pay before you say yes.</strong> Hourly, minimums, mileage, and any evening or weekend premium — added up to one number. When your agency turns on pay transparency, you see what the client is billed too.</li>
            <li><strong>Quiet by default.</strong> Hear from us the moment a job posts, once a morning, once a week, or not at all — your call, per channel.</li>
            <li><strong>Your earnings, always a tap away.</strong> Year-to-date totals in seconds, and a separate line for each agency if you work with more than one.</li>
          </ul>
        </div>
        <div data-reveal data-delay="100"><div class="widget" data-widget="sms"></div></div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-8); align-items:center">
        <div data-reveal>
          <span class="eyebrow">Close out</span>
          <h2>Your real times and expenses — one screen.</h2>
          <p class="ink-soft">After the job, enter your actual start and end times, add expenses like mileage or parking, snap a receipt, and you're done. If you ran long, it gently asks for a sentence of context. Receipts stay attached to the expense, never shown to the client.</p>
          <ul class="xs mt-4">
            <li>Approved expenses ride along on your next payment automatically.</li>
            <li>Expenses are <strong>never</strong> billed back to the client — they're yours.</li>
          </ul>
        </div>
        <div data-reveal data-delay="100">{mock_frame("Close out · Medical · ASL", ui_closeout(), caption="Real times and expenses, attached in seconds.")}</div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">Getting paid</span>
      <h2>On time, with a stub you can actually read.</h2>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">Work and expenses, separated</h3><p class="ink-soft">Your stub lists your jobs and your expenses on their own lines, each with a subtotal and a grand total at the bottom. Nothing to decode.</p></div>
        <div class="card"><h3 class="mt-0">Straight to your account</h3><p class="ink-soft">Direct deposit to your bank, on the day the agency promised. New to the platform? We walk you through setting it up.</p></div>
        <div class="card"><h3 class="mt-0">See where your money is</h3><p class="ink-soft">If the agency hasn't paid an invoice yet, you can see it and how long it's been waiting. No more guessing.</p></div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap-narrow">
      <h2>A fair look at your own work.</h2>
      <p class="lede">You can see your own numbers — how often you're offered jobs, how often you claim, your average rating, and where you sit in the rotation. It's yours to read. We don't hide it from you.</p>
      <p style="margin-top:var(--1891int-s-5)"><a class="btn btn-ghost" href="{BASE_PATH}/about">Why this matters to us</a></p>
    </div>
  </section>

  {cta_band("Ask your agency to invite you.", "Send your agency this page", "mailto:?subject=Try%201891%20Interpreter&body=I'd%20like%20to%20use%201891%20Interpreter.%20Take%20a%20look%3A%20https%3A%2F%2Fmadeby1891.com%2Finterpreter%2F", "Browse features", f"{BASE_PATH}/features/")}
"""


def for_requestors_body() -> str:
    return f"""
  {audience_switch("requestors")}
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">For requestors</span>
      <h1>Book an interpreter without learning new software.</h1>
      <p class="lede">Reply to an email. Fill a two-field web form. Call our number. Same outcome — a confirmed interpreter, a confirmation email, a calendar invite.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">Three ways</span>
      <h2>Pick the one that fits your day.</h2>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">Reply to an email</h3><p class="ink-soft">Just reply to one of your agency's confirmations with a new request. The details — language, date, place — are pulled into a draft, and a scheduler confirms it, usually within the hour during business hours.</p></div>
        <div class="card"><h3 class="mt-0">A short web form</h3><p class="ink-soft">Right below. No login, no phone tree. The scheduler picks it up and replies with options.</p></div>
        <div class="card"><h3 class="mt-0">Call the agency</h3><p class="ink-soft">Leave a voicemail and it's turned into a request and routed to a scheduler — you get a confirmation back the same day.</p></div>
      </div>
      <p class="tag" style="margin-top:var(--1891int-s-3)">A person always reviews a request before it reaches an interpreter. A clinical or legal job is never booked automatically — a scheduler confirms it first.</p>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap-narrow">
      <span class="eyebrow">Sample request form</span>
      <h2>Two required fields. Everything else helps.</h2>
      <form class="form-card" data-form action="/api/lead" method="post" aria-label="Sample request form">
        <input type="hidden" name="form_id" value="requestor_sample">
        <div class="consent-block">
          <strong>Important:</strong> Do not include patient names, diagnoses, medical record numbers, or other clinical details in this form. The interpreter receives only what's needed to do their work — generic context, not records.
        </div>
        <div class="field">
          <label for="r_name">Your name <span aria-hidden="true">*</span></label>
          <input id="r_name" name="requestor_name" type="text" required aria-required="true" autocomplete="name">
        </div>
        <div class="field">
          <label for="r_org">Your organization <span aria-hidden="true">*</span></label>
          <input id="r_org" name="organization" type="text" required aria-required="true">
          <span class="hint">Hospital, school district, court, employer — whichever fits.</span>
        </div>
        <div class="field">
          <label for="r_lang">Language needed</label>
          <select id="r_lang" name="language">
            <option>ASL (American Sign Language)</option>
            <option>ProTactile ASL (DeafBlind)</option>
            <option>Spanish</option>
            <option>Mandarin</option>
            <option>Arabic</option>
            <option>Haitian Creole</option>
            <option>Other — describe in notes</option>
          </select>
        </div>
        <div class="field">
          <label for="r_when">When</label>
          <input id="r_when" name="when" type="text" placeholder="e.g. Thursday 2pm or week of June 9">
        </div>
        <div class="field">
          <label for="r_setting">Setting type</label>
          <select id="r_setting" name="setting">
            <option>Medical (general)</option>
            <option>Legal / Court</option>
            <option>Educational / K-12</option>
            <option>Higher education</option>
            <option>Corporate / Workplace</option>
            <option>Community / Public</option>
          </select>
          <span class="hint">No diagnosis or case details — the interpreter doesn't need them and we don't store them.</span>
        </div>
        <div class="field">
          <label for="r_notes">Anything else useful (optional)</label>
          <textarea id="r_notes" name="notes" placeholder="e.g. preferred interpreter from prior bookings, room number for arrival, parking detail"></textarea>
        </div>
        <button class="btn btn-primary btn-lg" type="submit">Send request</button>
        <p class="tag" style="margin-top:var(--1891int-s-3)">By submitting you agree to our <a href="{BASE_PATH}/legal/privacy">privacy notice</a>. We forward this to the agency you're working with; we don't keep your info beyond what's needed to route the request.</p>
        <span class="form-status" aria-live="polite"></span>
      </form>
    </div>
  </section>

  {cta_band("Ask your agency to use 1891.", "Get a demo", f"{BASE_PATH}/get-a-demo", "How agencies bill", f"{BASE_PATH}/for-payers")}
"""


def for_payers_body() -> str:
    return f"""
  {audience_switch("payers")}
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">For billing, AP, and finance</span>
      <h1>Net-30, GL-coded, and one clean bill per client.</h1>
      <p class="lede">Patient details kept off every invoice by default. Each line shows exactly what your client asked to see — location, provider, consumer initials, interpreter — and invoice numbers run in order with no gaps. Here's what one actually looks like.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">Invoice anatomy</span>
      <h2>What a 1891-generated invoice actually looks like.</h2>
      <p class="lede">All identifiers below are illustrative — no real consumers, no real codes.</p>

      <div class="card mt-6" style="max-width:780px; margin-left:auto; margin-right:auto; padding:0">
        <div style="background:var(--1891int-river); color:var(--1891int-paper); padding:var(--1891int-s-5) var(--1891int-s-6); border-radius:var(--1891int-radius-lg) var(--1891int-radius-lg) 0 0; display:flex; justify-content:space-between; flex-wrap:wrap; gap:var(--1891int-s-4)">
          <div>
            <div class="tag" style="color:#DCE9E7">INVOICE</div>
            <h3 style="color:var(--1891int-paper);margin:6px 0 0">SAMPLE-ABC · 2026-06</h3>
            <p style="color:#DCE9E7; font-size:14px; margin:6px 0 0">From: Example Interpreting Agency<br>To: Example Health System — Patient Access</p>
          </div>
          <div style="text-align:right">
            <div class="tag" style="color:#DCE9E7">Net 30 · Due 2026-07-15</div>
            <div style="font-family:var(--1891int-display); font-size:32px; font-weight:700; margin-top:4px">$2,484.00</div>
          </div>
        </div>
        <div style="padding:var(--1891int-s-6)">
          <div class="table-scroll">
            <table class="compare" style="margin:0">
              <thead><tr><th>Date</th><th>Setting</th><th>Consumer (redacted)</th><th>Lang</th><th>Hours</th><th>GL code</th><th style="text-align:right">Amount</th></tr></thead>
              <tbody>
                <tr><td>2026-06-03</td><td>Outpatient</td><td>ABC-1029</td><td>ASL</td><td>2.0</td><td>6210-INTERPRET</td><td style="text-align:right">$190.00</td></tr>
                <tr><td>2026-06-07</td><td>Outpatient</td><td>ABC-1133</td><td>Spanish</td><td>1.5</td><td>6210-INTERPRET</td><td style="text-align:right">$142.50</td></tr>
                <tr><td>2026-06-11</td><td>Inpatient</td><td>ABC-1218</td><td>ASL (CDI+voicer)</td><td>3.0</td><td>6210-INTERPRET</td><td style="text-align:right">$540.00</td></tr>
                <tr><td>2026-06-14</td><td>Document translation</td><td>—</td><td>Spanish (1,840 wds)</td><td>—</td><td>6215-TRANSLATE</td><td style="text-align:right">$368.00</td></tr>
                <tr><td>2026-06-19</td><td>VRI</td><td>ABC-1392</td><td>Mandarin</td><td>0.5</td><td>6210-INTERPRET</td><td style="text-align:right">$95.00</td></tr>
                <tr><td>2026-06-22</td><td>Outpatient</td><td>ABC-1455</td><td>Haitian Creole</td><td>2.0</td><td>6210-INTERPRET</td><td style="text-align:right">$240.00</td></tr>
                <tr><td>2026-06-27</td><td>Late cancel (consumer)</td><td>ABC-1392</td><td>—</td><td>—</td><td>6219-CANCEL</td><td style="text-align:right">$95.00</td></tr>
                <tr><td>2026-06-28</td><td>OPI minutes</td><td>various</td><td>various</td><td>—</td><td>6212-OPI</td><td style="text-align:right">$813.50</td></tr>
              </tbody>
            </table>
          </div>
          <p class="tag" style="margin-top:var(--1891int-s-4)">Consumer identifiers redact to opaque tokens per agency policy. PHI never appears on the invoice — your AP team doesn't need it, and HIPAA prefers it gone.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-8); align-items:flex-start">
        <div>
          <h2>Five ways to group the bill, set per client.</h2>
          <ul class="checks">
            <li><strong>One per client</strong> — a single invoice covers everything for the month.</li>
            <li><strong>One per department</strong> — Cardiology, ED, Peds, and Oncology each get their own, on the same cycle.</li>
            <li><strong>One per location</strong> — a bill per site (Main Hospital, Urbana, Mt Airy, Brunswick).</li>
            <li><strong>One per provider</strong> — a bill per doctor, when each is paid separately.</li>
            <li><strong>One per job</strong> — a bill per event, for conferences or one-off legal work.</li>
          </ul>
          <p class="ink-soft">Pick the grouping per client; mix them freely on the same Net-30 cycle.</p>
        </div>
        <div>
          <h2>Exports and payouts.</h2>
          <ul class="checks">
            <li>Sends straight to QuickBooks Online and Xero.</li>
            <li>Connects to NetSuite, with your fields mapped your way.</li>
            <li>Pushes bills to Bill.com.</li>
            <li>Plain spreadsheet or data file for everything else.</li>
            <li>1099 filing handled for you.</li>
            <li>Payment stubs that separate the work from the expenses, each with its own total.</li>
            <li>Invoice numbers that run in order, with no gaps to chase.</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  {cta_band("Want a sample invoice + GL mapping?", "Get a demo", f"{BASE_PATH}/get-a-demo", "Read the BAA", f"{BASE_PATH}/legal/baa")}
"""


def pricing_body() -> str:
    # tier_slug: paid tier slug ("solo"/"practice"/"studio") wires the card to
    # the /pay/subscribe Checkout flow. None routes to the legacy single-CTA
    # path (Deaf-Owned → Apply, Network → Talk to us).
    tiers = [
        ("Deaf-Owned", "$0", "/mo", "Verified Deaf-owned agencies, any size.",
         ["Unlimited interpreters, jobs, requestors, storage",
          "AI intake at fair-use cap",
          "BAA included",
          "Full feature parity with paid tiers",
          "No time limit, no payment method"],
         "Apply for verification", "/free-for-deaf-owned", True, None),
        ("Solo", "$9", "/mo (annual)", "Individual freelance interpreters acting as their own agency.",
         ["1 user",
          "200 jobs/year",
          "1099 + invoicing",
          "Direct-deposit payouts",
          "BAA available on request"],
         None, None, False, "solo"),
        ("Practice", "$249", "/mo (annual)", "Small agencies, up to 25 active interpreters.",
         ["Unlimited schedulers and requestors",
          "Standard AI intake",
          "BAA included",
          "Document translation",
          "CART scheduling",
          "QuickBooks / Xero export"],
         None, None, False, "practice"),
        ("Studio", "$749", "/mo (annual)", "Mid agencies, up to 100 active interpreters.",
         ["Everything in Practice",
          "Single sign-on",
          "Your own web address (yourname.1891interpreter.app)",
          "Per-location phone numbers",
          "Advanced reporting",
          "NetSuite + Bill.com connectors"],
         None, None, False, "studio"),
        ("Network", "from $2,400", "/mo (annual)", "Large agencies (100+ interpreters), multi-state.",
         ["Everything in Studio",
          "Your own branding (white-label)",
          "Security-log export",
          "Dedicated support agreement + a named contact",
          "Custom integrations",
          "Multi-region option"],
         "Talk to us", "/contact", False, None),
    ]
    tier_html = []
    for name, price, unit, sub, features, cta, href, featured, tier_slug in tiers:
        feat_class = "tier featured" if featured else "tier"
        lis = "".join(f"<li>{f}</li>" for f in features)
        if tier_slug:
            cta_block = f"""
          <a class="btn btn-primary" href="{BASE_PATH}/pay/subscribe?tier={tier_slug}&amp;billing=annual">Subscribe annually</a>
          <a class="btn btn-ghost btn-sm" href="{BASE_PATH}/pay/subscribe?tier={tier_slug}&amp;billing=monthly" style="margin-left:8px">Or monthly</a>
          <p style="margin-top:var(--1891int-s-3); font-size:13.5px"><a href="{BASE_PATH}/get-a-demo">Get a demo first &rarr;</a></p>"""
        else:
            cta_block = f"""
          <a class="btn {'btn-primary' if featured else 'btn-secondary'}" href="{BASE_PATH}{href}">{cta}</a>"""
        tier_html.append(f"""
        <div class="{feat_class}">
          <h3>{name}</h3>
          <p class="ink-soft" style="font-size:14.5px; margin-bottom:0">{sub}</p>
          <div class="price">{price} <small>{unit}</small></div>
          <ul>{lis}</ul>{cta_block}
        </div>
        """)
    return f"""
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">Pricing</span>
      <h1>Public prices, every tier. Flat per agency. No per-job fee.</h1>
      <p class="lede">Annual is the published number; monthly is roughly 20% more. Cancel any time — your data exports on the way out, one click.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="tier-grid">
        {''.join(tier_html)}
      </div>
      <p class="muted center-text" style="margin-top:var(--1891int-s-6); font-size:14px">No credit card to start a demo. No per-seat tax. No payment-processing skim. Call infrastructure (VRI / OPI) passed through at vendor cost, itemized.</p>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <span class="eyebrow">Why these numbers</span>
      <h2>Built to be defensible to a CFO without a procurement cycle.</h2>
      <div class="grid grid-2" style="margin-top:var(--1891int-s-5)">
        <div>
          <h3>Solo at $9</h3>
          <p class="ink-soft">The freelance-interpreter-acting-as-their-own-agency is a real and growing segment. $9/mo is below most invoicing tools because we're vertical-specific. Solos who hire grow into Practice.</p>
          <h3>Practice at $249 flat</h3>
          <p class="ink-soft">Anchored against per-seat platforms: a six-person agency with five schedulers and 25 interpreters ends up in the high-three-figures monthly once per-job fees layer in. $249 flat is a deliberate price wall. Round number, easy to defend.</p>
        </div>
        <div>
          <h3>Studio at $749</h3>
          <p class="ink-soft">Where a 50-person agency that needs single sign-on and deeper reporting lands. Still cheaper than per-seat at that size, with the things procurement actually asks for.</p>
          <h3>Network from $2,400</h3>
          <p class="ink-soft">We publish the floor. We don't do "talk to us" pricing — that's a trust cost we're not willing to spend. Above the floor, custom integrations and multi-region are itemized in the contract, not in a sales magic number.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">What's never in any paid tier</span>
      <h2>No fine print on the things that matter.</h2>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">No per-job fee</h3><p class="ink-soft">Not a percentage, not a flat. You book a job, you don't pay us for that job.</p></div>
        <div class="card"><h3 class="mt-0">No per-call fee</h3><p class="ink-soft">VRI and OPI call infrastructure is passed through at carrier cost and itemized.</p></div>
        <div class="card"><h3 class="mt-0">No payment skim</h3><p class="ink-soft">When you take payment via Stripe, the fee is Stripe's published rate — passed through, not marked up.</p></div>
        <div class="card"><h3 class="mt-0">No data ransom</h3><p class="ink-soft">Export everything — roster, clients, invoices, audit log — in CSV or JSON, one click, same prominence as cancel-account.</p></div>
        <div class="card"><h3 class="mt-0">No accessibility paywall</h3><p class="ink-soft">Every accessibility feature is in every tier, including Solo and Deaf-Owned.</p></div>
        <div class="card"><h3 class="mt-0">No surprise renewal</h3><p class="ink-soft">We email 60 days, 30 days, and 7 days before renewal. You can cancel any time before the next term starts.</p></div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <span class="eyebrow">Compare to typical industry pricing</span>
      <h2>Same math, no jargon.</h2>
      <div class="table-scroll" style="margin-top:var(--1891int-s-5)">
        <table class="compare">
          <thead><tr><th></th><th class="own">1891 Interpreter</th><th>Per-seat platforms</th><th>Custom build</th></tr></thead>
          <tbody>
            <tr><td>Pricing model</td><td class="own">Flat monthly per agency</td><td>Per-seat + per-call / per-job</td><td>One-time license + dev time</td></tr>
            <tr><td>Per-job fee</td><td class="own yes">$0</td><td>Yes (varies)</td><td>$0 (no value-add)</td></tr>
            <tr><td>Free tier</td><td class="own yes">Yes — Deaf-owned, full features</td><td class="no">No</td><td>N/A</td></tr>
            <tr><td>Data export</td><td class="own">One click, CSV + JSON</td><td>Per request</td><td>Native to your file</td></tr>
            <tr><td>Public Network price</td><td class="own">Yes — floor visible</td><td>Partial</td><td>N/A</td></tr>
            <tr><td>BAA included</td><td class="own yes">Yes</td><td>Per public materials</td><td>DIY</td></tr>
          </tbody>
        </table>
      </div>
      <p class="tag" style="margin-top:var(--1891int-s-3)">We don't bash. We just show the math. Comparison reviewed {BUILD_DATE}.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap-narrow">
      <span class="eyebrow">FAQ</span>
      <h2>Pricing questions, answered straight.</h2>
      <details class="card mt-5"><summary style="font-weight:700; cursor:pointer">What if I add more interpreters mid-year?</summary><p class="ink-soft" style="margin-top:var(--1891int-s-3)">If you stay within your tier's headcount cap, nothing changes. If you cross a cap, we move you up and prorate. We don't bill retroactively for the growth — we only bill from the day the next cap is crossed.</p></details>
      <details class="card mt-3"><summary style="font-weight:700; cursor:pointer">What counts as an "active" interpreter?</summary><p class="ink-soft" style="margin-top:var(--1891int-s-3)">An interpreter who claimed or was assigned a job in the trailing 90 days. Interpreters on your roster who haven't worked in 90+ days don't count toward the cap.</p></details>
      <details class="card mt-3"><summary style="font-weight:700; cursor:pointer">Are there setup fees?</summary><p class="ink-soft" style="margin-top:var(--1891int-s-3)">No. Onboarding is white-glove for our early agencies and Network customers, included in the subscription price. Self-serve for Solo and Practice.</p></details>
      <details class="card mt-3"><summary style="font-weight:700; cursor:pointer">What's the Deaf-owned verification process?</summary><p class="ink-soft" style="margin-top:var(--1891int-s-3)">A short application, documentation review by a board that includes Fallon Brizendine, decision within 5 business days. Full process is at <a href="{BASE_PATH}/free-for-deaf-owned">Free for Deaf-owned</a>.</p></details>
      <details class="card mt-3"><summary style="font-weight:700; cursor:pointer">What if my ownership changes?</summary><p class="ink-soft" style="margin-top:var(--1891int-s-3)">If ownership changes such that you no longer qualify for Deaf-Owned, the badge comes down and you transition to the appropriate paid tier with 90 days' notice and no service interruption.</p></details>
      <details class="card mt-3"><summary style="font-weight:700; cursor:pointer">Do you offer discounts for nonprofits?</summary><p class="ink-soft" style="margin-top:var(--1891int-s-3)">Deaf-led nonprofits qualify for the Deaf-Owned tier through the same verification process. Other 501(c)(3) interpreting nonprofits get 30% off Practice and Studio.</p></details>
    </div>
  </section>

  {cta_band("Pick a path.", "Get a demo", f"{BASE_PATH}/get-a-demo", "Start free if Deaf-owned", f"{BASE_PATH}/free-for-deaf-owned")}
"""


def free_body() -> str:
    return f"""
  <section class="feature-hero">
    <div class="wrap">
      <span class="badge">Deaf-owned · 1891 verified</span>
      <h1>Free, forever, for verified Deaf-owned agencies.</h1>
      <p class="lede">If your agency is verified Deaf-owned, you pay nothing — full features, unlimited interpreters, unlimited jobs, BAA included, no time limit. The policy is the proof. The verification process is public.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">The standard</span>
      <h2>Deaf-owned, by our definition.</h2>
      <p>A Deaf-owned agency, for purposes of the Free Forever tier, is an agency where a Deaf, DeafBlind, or hard-of-hearing person — or a group of such persons — holds <strong>more than 50% of ownership interest and exercises operational control</strong>. We use the same baseline that state DBE/MBE and SBA programs use.</p>
      <h3>We accept any of:</h3>
      <ul class="checks">
        <li>State Deaf-owned business certification (where the state offers one).</li>
        <li>SBA self-certification for a Deaf-owned small business.</li>
        <li>NAD agency-member designation (where applicable to the agency's classification).</li>
        <li>A sworn attestation — used where no state pathway exists. One page, plain English. Fallon co-signs the program-level standard so the attestation is verifying against a clear definition, not a vibe.</li>
      </ul>
      <p class="muted" style="font-size:14px">Full standard: <a href="{BASE_PATH}/legal/deaf-owned-verification-standard">HTML</a> · <a href="{BASE_PATH}/assets/docs/deaf-owned-verification-standard.pdf">PDF</a></p>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <span class="eyebrow">The workflow</span>
      <h2>Seven steps. No "pending forever."</h2>
      <ol class="stack-5" style="counter-reset:step; padding-left:0; list-style:none">
        <li class="card"><strong>1. Apply.</strong> Owner submits the form below: agency legal name, state of formation, owner name, contact email, documentation type.</li>
        <li class="card"><strong>2. Acknowledge.</strong> Auto-reply within 5 minutes. A real person (Fallon or board secretary) confirms receipt within 2 business days.</li>
        <li class="card"><strong>3. Board review.</strong> The verification board — Fallon plus two community advisors, rotating — reviews within 5 business days. Decision is binary (approve/deny) with a written reason either way.</li>
        <li class="card"><strong>4. Approve path.</strong> Tier flipped to Free Forever on the same day. Badge ("Deaf-owned · 1891 verified") becomes available for your public profile and as an embeddable SVG for your own site. BAA auto-attached.</li>
        <li class="card"><strong>5. Annual recertification.</strong> Light. Once a year we email: "still owned by the same person/people? Reply yes." No re-documentation unless ownership changed.</li>
        <li class="card"><strong>6. Deny path.</strong> Reasoned response. Appeal within 30 days. <strong>All denials are reviewed by the full board, not a single reviewer.</strong> A denied agency is welcome on a paid tier — the badge is the gate, not the platform.</li>
        <li class="card"><strong>7. Withdraw.</strong> If ownership changes such that you no longer qualify, the badge comes down and you transition to the appropriate paid tier with 90 days' notice. No service interruption.</li>
      </ol>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">Edge cases — addressed</span>
      <h2>We've thought about the hard ones.</h2>
      <div class="grid grid-2 mt-5">
        <div class="note"><strong>Deaf-CODA-owned agency.</strong> The CODA is hearing. Not Deaf-owned by our standard; eligible for paid tier. Many CODA-led agencies are deeply community-aligned — we'll feature their work. The badge stays a Deaf-ownership marker.</div>
        <div class="note"><strong>Mixed-ownership at 51% Deaf-owned.</strong> Qualifies. The standard is &gt;50% ownership; 51% is more than 50%.</div>
        <div class="note"><strong>Deaf-led nonprofit but not Deaf-owned.</strong> Nonprofits don't have "owners" in the equity sense. If the executive director and the majority of the board are Deaf, the agency qualifies. Documented via board minutes or 990 attestation. Reviewed individually.</div>
        <div class="note"><strong>Hearing-allied agency.</strong> Not eligible for the badge. Eligible for every paid tier. We don't do honorary allyship badges — that would dilute the meaning for agencies who actually built their businesses Deaf-owned.</div>
        <div class="note"><strong>Deaf person owns on paper, hearing spouse runs it operationally.</strong> The trickiest case. The standard requires operational control, not just paper ownership. Reviewed by the full board; burden is on the applicant. We err toward approval if documentation is reasonable; we deny if it looks like a workaround.</div>
        <div class="note-river"><strong>The standard exists because the community asked for one.</strong> We will get this wrong sometimes. When we do, the board reconsiders. The badge means something because we hold it to a standard.</div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap-narrow">
      <span class="eyebrow">Apply</span>
      <h2>Verification application.</h2>
      <p class="lede">The board reviews within 5 business days. Both approvals and denials come back with written reasons.</p>
      <form class="form-card" data-form action="/api/lead" method="post" aria-label="Deaf-owned verification application">
        <input type="hidden" name="form_id" value="deaf_owned_application">
        <div class="consent-block">
          <strong>What happens to this info:</strong> It goes to the verification board (Fallon Brizendine + two community advisors). We retain applications for 24 months from submission, longer if approved. See our <a href="{BASE_PATH}/legal/privacy">privacy notice</a>.
        </div>
        <div class="field">
          <label for="dao_legal">Agency legal name <span aria-hidden="true">*</span></label>
          <input id="dao_legal" name="agency_legal_name" type="text" required aria-required="true">
        </div>
        <div class="field">
          <label for="dao_state">State of formation <span aria-hidden="true">*</span></label>
          <input id="dao_state" name="state_of_formation" type="text" required aria-required="true">
        </div>
        <div class="field">
          <label for="dao_owner">Owner name <span aria-hidden="true">*</span></label>
          <input id="dao_owner" name="owner_name" type="text" required aria-required="true">
        </div>
        <div class="field">
          <label for="dao_email">Contact email <span aria-hidden="true">*</span></label>
          <input id="dao_email" name="contact_email" type="email" required aria-required="true">
        </div>
        <div class="field">
          <label for="dao_doctype">Documentation type</label>
          <select id="dao_doctype" name="documentation_type">
            <option value="state_cert">State Deaf-owned certification</option>
            <option value="sba">SBA self-certification</option>
            <option value="nad">NAD agency-member designation</option>
            <option value="attestation">Sworn attestation (no state pathway)</option>
          </select>
        </div>
        <div class="field">
          <label for="dao_upload">Documentation upload (optional at this stage)</label>
          <input id="dao_upload" name="documentation_file" type="file">
          <span class="hint">PDF or image. If you'd rather email it after we acknowledge, that's fine — just leave blank.</span>
        </div>
        <div class="field">
          <label for="dao_notes">Anything else the board should know</label>
          <textarea id="dao_notes" name="notes"></textarea>
        </div>
        <p style="font-size:14px; color:var(--1891int-fog); margin:0 0 var(--1891int-s-4)">We do not ask for SSN, EIN, or tax IDs in this form. Those are exchanged outside the public site after approval.</p>
        <button class="btn btn-primary btn-lg" type="submit">Submit application</button>
        <span class="form-status" aria-live="polite"></span>
      </form>
    </div>
  </section>
"""


def get_demo_body() -> str:
    return f"""
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">Get a demo</span>
      <h1>30 minutes. Your agency on the screen.</h1>
      <p class="lede">No slide deck. We open the app with your data shape (a few sample rows you give us, no real PHI) and walk through your day-of board, smart-fill, billing, and the BAA.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-7); align-items:flex-start">
        <div class="form-card">
          <form data-form action="/api/lead" method="post" aria-label="Demo request">
            <input type="hidden" name="form_id" value="demo_request">
            <div class="field">
              <label for="d_name">Your name <span aria-hidden="true">*</span></label>
              <input id="d_name" name="full_name" type="text" required aria-required="true" autocomplete="name">
            </div>
            <div class="field">
              <label for="d_email">Work email <span aria-hidden="true">*</span></label>
              <input id="d_email" name="work_email" type="email" required aria-required="true" autocomplete="email">
            </div>
            <div class="field">
              <label for="d_agency">Agency name</label>
              <input id="d_agency" name="agency_name" type="text">
            </div>
            <div class="field">
              <label for="d_size">Agency size</label>
              <select id="d_size" name="agency_size">
                <option>1–5 interpreters</option>
                <option>6–25 interpreters</option>
                <option>26–100 interpreters</option>
                <option>100+ interpreters</option>
                <option>Just me (freelance)</option>
              </select>
            </div>
            <fieldset class="field" style="border:0; padding:0">
              <legend style="font-weight:600; font-size:14.5px; margin-bottom:var(--1891int-s-2)">Primary modality interest</legend>
              <div class="check"><input id="m_asl" type="checkbox" name="modality" value="asl"><label for="m_asl" style="font-weight:500">ASL / signed languages</label></div>
              <div class="check"><input id="m_spoken" type="checkbox" name="modality" value="spoken"><label for="m_spoken" style="font-weight:500">Spoken languages</label></div>
              <div class="check"><input id="m_cart" type="checkbox" name="modality" value="cart"><label for="m_cart" style="font-weight:500">CART (realtime captioning)</label></div>
              <div class="check"><input id="m_trans" type="checkbox" name="modality" value="translation"><label for="m_trans" style="font-weight:500">Document translation</label></div>
            </fieldset>
            <div class="field">
              <label for="d_current">Currently using</label>
              <input id="d_current" name="current_platform" type="text" placeholder="e.g. Boostlingo, InterpretManager, Excel, FileMaker">
            </div>
            <div class="field">
              <label for="d_helps">What would make this useful for you?</label>
              <textarea id="d_helps" name="helps"></textarea>
            </div>
            <div class="consent-block">By submitting you agree to our <a href="{BASE_PATH}/legal/privacy">privacy notice</a>. We respond within one business day. We don't add you to a list or sell your data.</div>
            <button class="btn btn-primary btn-lg" type="submit">Send</button>
            <span class="form-status" aria-live="polite"></span>
          </form>
        </div>
        <div>
          <h2 class="mt-0">What you'll see in the demo.</h2>
          <ul class="checks">
            <li><strong>Day-of board.</strong> Open jobs, claimed jobs, replacements-needed, on one screen.</li>
            <li><strong>Smart-fill</strong> with the score breakdown visible — never a black box.</li>
            <li><strong>Interpreter app</strong> on a phone — two-tap claim, see-your-pay-first.</li>
            <li><strong>Sample invoice</strong> with GL coding and PHI redacted by default.</li>
            <li><strong>BAA + security posture</strong> walkthrough.</li>
          </ul>
          <h3>And then we hand you the keys.</h3>
          <p class="ink-soft">Trial accounts are real accounts on a real tenant. We don't show fake demos and pretend they're product.</p>
          <p style="margin-top:var(--1891int-s-5)"><a class="btn btn-ghost" href="{BASE_PATH}/free-for-deaf-owned">Verified Deaf-owned? Skip the demo →</a></p>
        </div>
      </div>
    </div>
  </section>
"""


def start_free_body() -> str:
    return f"""
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">Start free</span>
      <h1>Verified Deaf-owned? Skip the demo. Start the application.</h1>
      <p class="lede">"Start free" routes through the same verification process as <a href="{BASE_PATH}/free-for-deaf-owned">Free for Deaf-owned</a> — this page is for owners who already know they qualify and want to go straight to the form.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap-narrow">
      <div class="cluster" style="justify-content:center">
        <a class="btn btn-primary btn-lg" href="{BASE_PATH}/free-for-deaf-owned#apply">Open the application</a>
        <a class="btn btn-secondary btn-lg" href="{BASE_PATH}/get-a-demo">Or get a demo first</a>
      </div>
      <h2 style="margin-top:var(--1891int-s-7)">A few quick FAQs.</h2>
      <details class="card mt-3"><summary style="font-weight:700; cursor:pointer">Do I have to upload documentation immediately?</summary><p class="ink-soft" style="margin-top:var(--1891int-s-3)">No. You can submit the application now and email documentation after we acknowledge.</p></details>
      <details class="card mt-3"><summary style="font-weight:700; cursor:pointer">How fast is approval?</summary><p class="ink-soft" style="margin-top:var(--1891int-s-3)">Acknowledgment within 5 minutes, board review within 5 business days, decision the same day as review.</p></details>
      <details class="card mt-3"><summary style="font-weight:700; cursor:pointer">What if I'm denied?</summary><p class="ink-soft" style="margin-top:var(--1891int-s-3)">All denials come with written reasoning and a 30-day appeal window. Appeals are reviewed by the full board, not a single reviewer. You're welcome on a paid tier in the meantime.</p></details>
      <details class="card mt-3"><summary style="font-weight:700; cursor:pointer">Can I start using the platform before approval?</summary><p class="ink-soft" style="margin-top:var(--1891int-s-3)">Yes — a trial Practice account opens on the day you apply, and converts to Free Forever the day you're approved. No payment method asked while your application is pending.</p></details>
      <p class="muted" style="margin-top:var(--1891int-s-6); font-size:14px">Need to talk to a human first? <a href="{BASE_PATH}/contact">Contact us</a>.</p>
    </div>
  </section>
"""


def contact_body() -> str:
    return f"""
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">Contact</span>
      <h1>Three ways. One inbox, real humans.</h1>
      <p class="lede">All paths route to the same small team. Anthony or Fallon answers most inbound during business hours.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="grid grid-3">
        <div class="card">
          <h3 class="mt-0">General</h3>
          <p class="ink-soft">Questions about the product, the company, the lineage.</p>
          <p><a href="mailto:hello@madeby1891.com">hello@madeby1891.com</a></p>
        </div>
        <div class="card">
          <h3 class="mt-0">Accessibility feedback</h3>
          <p class="ink-soft">Anything not working well with a screen reader, keyboard, or magnification? This goes to a priority queue.</p>
          <p><a href="mailto:accessibility@madeby1891.com">accessibility@madeby1891.com</a></p>
        </div>
        <div class="card">
          <h3 class="mt-0">Responsible disclosure</h3>
          <p class="ink-soft">Found a security issue? Please don't post it — email us. Process and PGP key on the <a href="{BASE_PATH}/legal/responsible-disclosure">disclosure page</a>.</p>
          <p><a href="mailto:security@madeby1891.com">security@madeby1891.com</a></p>
        </div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap-narrow">
      <h2>Or send us a note.</h2>
      <form class="form-card" data-form action="/api/lead" method="post" aria-label="Contact form">
        <input type="hidden" name="form_id" value="contact">
        <div class="field"><label for="c_name">Your name</label><input id="c_name" name="name" type="text" autocomplete="name"></div>
        <div class="field"><label for="c_email">Email <span aria-hidden="true">*</span></label><input id="c_email" name="email" type="email" required aria-required="true" autocomplete="email"></div>
        <div class="field"><label for="c_topic">Topic</label>
          <select id="c_topic" name="topic">
            <option>Product question</option>
            <option>Press / media</option>
            <option>Partnership</option>
            <option>Speaking / events</option>
            <option>Just saying hi</option>
          </select>
        </div>
        <div class="field"><label for="c_msg">Message <span aria-hidden="true">*</span></label><textarea id="c_msg" name="message" required aria-required="true"></textarea></div>
        <div class="consent-block">By submitting you agree to our <a href="{BASE_PATH}/legal/privacy">privacy notice</a>. We respond within one business day during normal hours.</div>
        <button class="btn btn-primary btn-lg" type="submit">Send</button>
        <span class="form-status" aria-live="polite"></span>
      </form>
    </div>
  </section>
"""


def sign_in_body() -> str:
    return f"""
  <section class="section" style="padding-top:var(--1891int-s-9)">
    <div class="wrap-narrow center-text">
      <span class="eyebrow">Sign in</span>
      <h1>Magic link. No password.</h1>
      <p class="lede">Enter your work email — we'll send a one-time sign-in link that expires in 15 minutes.</p>
    </div>
    <div class="wrap-narrow" style="margin-top:var(--1891int-s-6)">
      <form class="form-card" id="signin-form" aria-label="Sign in">
        <div class="field">
          <label for="s_email">Work email</label>
          <input id="s_email" name="email" type="email" required aria-required="true" autocomplete="email" placeholder="you@youragency.com">
        </div>
        <button class="btn btn-primary btn-lg" type="submit" style="width:100%" id="signin-submit">Send sign-in link</button>
        <span class="form-status" aria-live="polite" id="signin-status"></span>
      </form>
      <div class="note-river" style="margin-top:var(--1891int-s-5)">
        <strong>We don't use passwords.</strong> Magic links expire in 15 minutes. Pro and Studio tiers can require a passkey (WebAuthn) on every sign-in. Free and Solo tiers have passkeys optional.
      </div>
      <p class="center-text muted" style="margin-top:var(--1891int-s-5); font-size:14px">
        No account yet? <a href="{BASE_PATH}/get-a-demo">Get a demo</a> or <a href="{BASE_PATH}/free-for-deaf-owned">start free if Deaf-owned</a>.
      </p>
    </div>
  </section>
  <script src="{BASE_PATH}/assets/js/api.js" defer></script>
  <script>
  document.addEventListener('DOMContentLoaded', function () {{
    var form = document.getElementById('signin-form');
    var status = document.getElementById('signin-status');
    var btn = document.getElementById('signin-submit');
    form.addEventListener('submit', function (e) {{
      e.preventDefault();
      var email = document.getElementById('s_email').value.trim();
      if (!email) return;
      btn.disabled = true;
      btn.textContent = 'Sending…';
      status.style.display = 'block';
      status.style.marginTop = '12px';
      status.textContent = '';
      IntApi.authRequest(email).then(function () {{
        status.style.color = 'var(--1891int-ok)';
        status.textContent = 'Check your inbox. The link expires in 15 minutes.';
        btn.textContent = 'Sent';
      }}).catch(function () {{
        status.style.color = 'var(--1891int-err)';
        status.textContent = 'Could not send. Try again in a minute.';
        btn.disabled = false;
        btn.textContent = 'Send sign-in link';
      }});
    }});
  }});
  </script>
"""


def features_index_body() -> str:
    # (slug, title, plain-language one-liner) — friendly, no jargon.
    feats = [
        ("scheduling.html",     "Scheduling",           "Every job for the day on one board. The right interpreter, suggested for you. See what a cancellation costs before you confirm it."),
        ("interpreter-app.html","Interpreter app",      "Claim a job in two taps — or just reply YES to a text. See exactly what you'll be paid before you accept."),
        ("billing.html",        "Billing &amp; payouts","Your rates, your invoices. One client, one bill — however their departments are organized. Interpreters paid on time."),
        ("translation.html",    "Document translation", "Translate forms and letters with a real translator checking every page. Never auto-filled on anything medical or legal."),
        ("ai-intake.html",      "Smart intake",         "An email or voicemail becomes a tidy draft job in seconds. You review every one before it's booked. Patient details stay private."),
        ("vri-opi.html",        "Video &amp; phone",    "Bring an interpreter on screen or on the line, right inside the same schedule. Captions on, recording only with consent."),
        ("cart.html",           "Live captions (CART)", "Real-time captioning booked alongside your sign and spoken-language jobs — same rates, same invoice."),
        ("reporting.html",      "Reports",              "Plain-English answers about your agency: jobs filled, time to fill, money owed. Ask a question, get a number you can export."),
        ("integrations.html",   "Connections",         "Plays nicely with the accounting, payroll, and payout tools you already use. Nothing to re-key."),
    ]
    def _clean(slug: str) -> str:
        return slug[:-len(".html")] if slug.endswith(".html") else slug
    cards = "".join(f"""
        <a class="card card-hoverable feat-card" href="{BASE_PATH}/features/{_clean(p)}" data-reveal>
          <h3 class="mt-0">{t}</h3>
          <p class="ink-soft">{d}</p>
          <p class="text-bloom" style="font-weight:600">See how it works <span class="arrow" aria-hidden="true">→</span></p>
        </a>""" for p, t, d in feats)
    hero_media = mock_frame(
        "Today's board · your agency",
        ui_scheduler_board(),
        href=f"{BASE_PATH}/get-a-demo",
        caption="A real day on the board. <strong>Click to walk through it with us.</strong>",
    )
    return f"""
  <section class="feature-hero">
    <div class="wrap">
      <div class="hero-grid">
        <div>
          <span class="eyebrow">Features</span>
          <h1>Sign, spoken, captioned, translated. One tool for the whole job.</h1>
          <p class="lede">Nine things the platform does — scheduling, the interpreter app, billing, translation, video and phone, live captions, reports, and the connections to the tools you already run. Each one has its own walkthrough below.</p>
          <div class="cluster" style="margin-top:var(--1891int-s-6)">
            <a class="btn btn-primary btn-lg" href="{BASE_PATH}/get-a-demo">Get a demo</a>
            <a class="btn btn-ghost btn-lg" href="{BASE_PATH}/pricing">See pricing</a>
          </div>
        </div>
        <div data-reveal data-delay="100">{hero_media}</div>
      </div>
    </div>
  </section>
  <section class="section">
    <div class="wrap">
      <div class="center-text" style="margin-bottom:var(--1891int-s-7)">
        <span class="eyebrow">Pick a screen</span>
        <h2 data-reveal>Open any one and see it in action.</h2>
      </div>
      <div class="grid grid-3">{cards}</div>
    </div>
  </section>
  {cta_band("Want the guided tour?", "Get a demo", f"{BASE_PATH}/get-a-demo", "See pricing", f"{BASE_PATH}/pricing")}
"""


def feature_page_body(label: str, eyebrow: str, lede: str,
                      hero_media: str, rows: list[dict], demo_href: str = "") -> str:
    """Feature page: a hero with a clickable screenshot, then alternating
    picture + plain-language rows. `rows` is a list of dicts with keys
    h (heading), body (html), and optional media (html)."""
    demo_href = demo_href or f"{BASE_PATH}/get-a-demo"
    out = [f"""
  <section class="feature-hero">
    <div class="wrap">
      <div class="hero-grid">
        <div>
          <span class="eyebrow">{eyebrow}</span>
          <h1>{label}</h1>
          <p class="lede">{lede}</p>
          <div class="cluster" style="margin-top:var(--1891int-s-6)">
            <a class="btn btn-primary btn-lg" href="{demo_href}">See it in a demo</a>
            <a class="btn btn-ghost btn-lg" href="{BASE_PATH}/features/">All features</a>
          </div>
        </div>
        <div data-reveal data-delay="100">{hero_media}</div>
      </div>
    </div>
  </section>
  <section class="section">
    <div class="wrap">"""]
    for r in rows:
        media = r.get("media")
        if media:
            out.append(f"""
      <div class="feature-row" data-reveal>
        <div class="fr-prose">
          <h2>{r['h']}</h2>
          {r['body']}
        </div>
        <div class="fr-media">{media}</div>
      </div>""")
        else:
            out.append(f"""
      <div class="feature-row" data-reveal style="grid-template-columns:1fr">
        <div class="fr-prose" style="max-width:74ch">
          <h2>{r['h']}</h2>
          {r['body']}
        </div>
      </div>""")
    out.append("""
    </div>
  </section>""")
    out.append(cta_band(f"See {eyebrow.split('·')[-1].strip().lower()} for yourself.",
                        "Get a demo", demo_href, "Back to all features", f"{BASE_PATH}/features/"))
    return "".join(out)


def about_body() -> str:
    return f"""
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">About</span>
      <h1>Built by the people who use it. Run by the people who built it.</h1>
      <p class="lede">Two co-founders and a small team — in Frederick and remote — growing slowly, on purpose.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-8); align-items:flex-start">
        <div class="card">
          <span class="eyebrow">Co-founder</span>
          <h2 class="mt-0">Anthony Mowl</h2>
          <p class="ink-soft">Fifth-generation Deaf, in a family line that goes back to 1891 — that's where the name comes from. He runs the business and builds the product, out of Frederick, Maryland. The voice you're reading across this site is his: plain, direct, allergic to buzzwords.</p>
          <p><a href="mailto:hello@madeby1891.com">hello@madeby1891.com</a> · <a href="https://madeby1891.com/">madeby1891.com</a></p>
        </div>
        <div class="card">
          <span class="eyebrow">Co-founder</span>
          <h2 class="mt-0">Fallon Brizendine</h2>
          <p class="ink-soft">A Certified Deaf Interpreter with a master's in interpretation from Gallaudet, and years spent chairing an ASL interpreting program. She leads on the things that have to be right — how the work actually happens, the languages we support, and what it means to be Deaf-owned. She's spent her career in this community, and it shows in every decision.</p>
          <p><a href="mailto:hello@madeby1891.com">hello@madeby1891.com</a></p>
        </div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <span class="eyebrow">How we work</span>
      <h2>Small team. Work in the open. Slow growth on purpose.</h2>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">Frederick, MD</h3><p class="ink-soft">Based in Frederick, remote-first. We're hiring carefully — a few people at a time, not a hiring spree.</p></div>
        <div class="card"><h3 class="mt-0">In the open</h3><p class="ink-soft">When a release goes out, it shows up on the <a href="{BASE_PATH}/changelog">changelog</a>. We'd rather you see the work than take our word for it.</p></div>
        <div class="card"><h3 class="mt-0">Built to share</h3><p class="ink-soft">This marketing site is open source, so other Deaf-owned organizations can borrow the verification-page template. The product itself stays private.</p></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap-narrow">
      <span class="eyebrow">Deaf-owned verification</span>
      <h2>Right now, this is Fallon's call.</h2>
      <p>Fallon reviews Deaf-owned applications herself. We're bringing on a small group of community advisors — people with real standing among Deaf agency owners — to review alongside her, and we'll name them here once they're seated. Until that group is in place, we're glad to take applications, but we're holding final decisions rather than have anyone verified by a board that doesn't fully exist yet. We'd rather be slow than pretend.</p>
    </div>
  </section>

  {cta_band("Want to know more?", "Read our 1891 story", f"{BASE_PATH}/our-1891", "Get a demo", f"{BASE_PATH}/get-a-demo")}
"""


def our_1891_body() -> str:
    return f"""
  <section class="feature-hero">
    <div class="wrap-narrow">
      <span class="eyebrow">Our 1891</span>
      <h1>Five generations Deaf. One number. One commitment.</h1>
      <p class="lede">The lineage is the undercurrent, not the headline. Universal-design framing leads. But the "1891" matters, and this page is where we say why.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap-narrow">
      <h2>What "1891" actually refers to.</h2>
      <p>1891 is the year the Mowl family's continuous Deaf lineage begins, in our records. Five generations later, the line is intact. The number is not a slogan — it's a date.</p>
      <p>We use it as a brand mark because brand marks should mean something specific. "1891" means: a Deaf-built product that descends from a long Deaf family. That's it. We don't dress it up.</p>

      <h2 style="margin-top:var(--1891int-s-7)">Why it's the undercurrent and not the headline.</h2>
      <p>Universal design is the lead because universal design is the right frame for what this product does — it's a tool that works for everyone in the room, hearing or Deaf, in or out of the audio path. Leading with "Deaf-owned" or "1891" would put the founder identity in front of the work; the work is what we want you to look at first.</p>
      <p>But this page exists because the 1891 lineage is the thing that lets us hold the Deaf-owned verification badge to a standard. A verifier with no skin in the community can't credibly maintain a community-standard badge. We can.</p>

      <h2 style="margin-top:var(--1891int-s-7)">What we don't do with the lineage.</h2>
      <ul class="checks">
        <li>We don't fingerspell "1891" in marketing graphics. ASL is a language, not a typeface.</li>
        <li>We don't use isolated handshapes as decoration. Hands in voids communicate nothing.</li>
        <li>We don't put "ear with line through it" iconography anywhere. We are not selling deafness-as-deficit.</li>
        <li>We don't put the 1891 mark on agency tenant pages. The agency's logo leads on their tenant; "powered by 1891 Interpreter" sits in the footer at quiet weight.</li>
      </ul>

      <h2 style="margin-top:var(--1891int-s-7)">What we do.</h2>
      <p>Build a tool that works for the people who do this work. Show our work in the open. Pay interpreters on the day the agency promised. Keep the Deaf-owned badge meaningful by keeping the standard real. Answer email.</p>

      <div class="pull-quote">
        Built in Frederick. Carried forward since 1891.
        <cite>— The line we use, on purpose, with no asterisk.</cite>
      </div>

      <p class="muted" style="margin-top:var(--1891int-s-6)">No CTA on this page. This page is reputation, not conversion.</p>
    </div>
  </section>
"""


def security_body() -> str:
    return f"""
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">Security &amp; compliance</span>
      <h1>HIPAA-defensible by default. Auditable on demand.</h1>
      <p class="lede">PHI is redacted before it ever reaches an AI model. Every PHI read writes to an append-only audit log. BAA included on every paid tier and on the Deaf-owned tier — signed in days, not weeks.</p>
      <div class="cluster" style="margin-top:var(--1891int-s-6)">
        <a class="btn btn-primary" href="{BASE_PATH}/legal/baa">Read the BAA</a>
        <a class="btn btn-secondary" href="{BASE_PATH}/legal/subprocessors">Subprocessor list</a>
        <a class="btn btn-ghost" href="mailto:security@madeby1891.com">Responsible disclosure</a>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">PHI handling</span>
      <h2>What the AI never sees, raw.</h2>
      <div class="grid grid-2 mt-5">
        <div class="card card-warm">
          <h3 class="mt-0">Redacted before the model sees it</h3>
          <ul class="xs">
            <li>Consumer names → initials only.</li>
            <li>Free-text clinical notes → regex + NER scrub.</li>
            <li>Phone numbers, MRNs, DOBs, SSNs → token-replaced for the model; hydrated client-side after the response.</li>
            <li>Executive-session and paused-mic portions → never captured, never transcribed.</li>
          </ul>
          <p class="tag" style="margin-top:var(--1891int-s-4)">Implementation: lib/redact.ts redactForModel(). Every model call writes an AI_Audit row with input/output hashes.</p>
        </div>
        <div class="card card-warm">
          <h3 class="mt-0">Per-tenant prompt-cache isolation</h3>
          <p class="ink-soft">Every model call begins with <code>tenant_id: &lt;id&gt;</code> in the system prompt. The model provider's prompt-caching keys on prefix, which means cache hits cannot cross tenant boundaries even if two prompts are otherwise identical.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <span class="eyebrow">The audit log</span>
      <h2>Tamper-evident, kept for years, and yours to export.</h2>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">Every record opened</h3><p class="ink-soft">Whenever someone — interpreter, scheduler, requestor — opens a record with patient details in it, the log notes who, what, when, and why.</p></div>
        <div class="card"><h3 class="mt-0">Kept seven years</h3><p class="ink-soft">The log can only be added to. Entries can't be edited or deleted by anyone, and it's held for seven years.</p></div>
        <div class="card"><h3 class="mt-0">Can't be quietly changed</h3><p class="ink-soft">Each entry is sealed to the one before it. If anything is altered after the fact, that seal breaks and the next check catches it.</p></div>
        <div class="card"><h3 class="mt-0">Security-log export</h3><p class="ink-soft">On the Network plan, the audit log streams into your own security tooling. The format is documented and stays steady.</p></div>
        <div class="card"><h3 class="mt-0">Subject access</h3><p class="ink-soft">Consumers can request their own access log under HIPAA's right of access. The response is a redacted PDF, ready in 30 days or less.</p></div>
        <div class="card"><h3 class="mt-0">Tenant export</h3><p class="ink-soft">Your full audit log exports with your other data. CSV or JSON. Same one-click button.</p></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">Encryption + keys</span>
      <h2>Encrypted at rest and in transit. Tenant-isolated.</h2>
      <ul class="checks">
        <li><strong>At rest (v1):</strong> Per-tenant access controls plus initials-only mode for clinical fields. Records are protected and access-logged; column-level AES is on the roadmap, not in v1.</li>
        <li><strong>In transit:</strong> TLS 1.3 everywhere. HSTS preload submitted; Strict-Transport-Security with includeSubDomains and preload directive.</li>
        <li><strong>Tenant-isolated records:</strong> A signed BAA covers the per-agency record store. Each tenant's records have their own access controls and audit log.</li>
        <li><strong>Receipt storage:</strong> Encrypted object storage with per-tenant prefixes; tracked publicly in the changelog.</li>
        <li><strong>Tenant isolation:</strong> Durable Objects named <code>AgencyHub:&lt;tenant_id&gt;</code>. KV keys prefixed <code>&lt;tenant_id&gt;:</code>. Prompt-cache keyed by tenant_id so model cache hits cannot cross tenants.</li>
      </ul>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">Roles + sign-in</span>
      <h2>7-tier role hierarchy. Magic-link sign-in. 7-day invitation TTL.</h2>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">Seven roles, role-scoped UI</h3><p class="ink-soft">platform_staff → owner → manager → scheduler, interpreter, client_contact, requestor_contact, billing_contact. The role on the invite scopes everything that user sees in <code>/app/</code>.</p></div>
        <div class="card"><h3 class="mt-0">Role-scoped invitation allowlist</h3><p class="ink-soft">Managers can invite the five contact-tier roles, but not other managers. Only owners create managers. The allowlist is enforced server-side; the UI in <code>/app/settings/team</code> just reflects it.</p></div>
        <div class="card"><h3 class="mt-0">No passwords</h3><p class="ink-soft">Magic-link sign-in only. Invitation tokens live 7 days, then expire. Sessions are agency-scoped; multi-agency users pick which tenant on landing.</p></div>
      </div>
    </div>
  </section>

  <section class="section section-river">
    <div class="wrap">
      <span class="eyebrow" style="color:#FFE2D6">Audio + speech</span>
      <h2>Two-party consent. RECORDING indicator. PAUSE.</h2>
      <p class="lede" style="color:#DCE9E7">Maryland is a two-party-consent state, and most of our audiences are mixed-hearing PSAs / boards / conferences. We apply the strictest rule everywhere, not just in Maryland.</p>
      <ul class="xs" style="margin-top:var(--1891int-s-4)">
        <li style="color:#DCE9E7"><strong>Announce.</strong> Every audio-recorded session announces — verbally and visually — at start.</li>
        <li style="color:#DCE9E7"><strong>Consent at check-in.</strong> Every attendee gives explicit consent, default unchecked.</li>
        <li style="color:#DCE9E7"><strong>RECORDING indicator</strong> on every shared screen for the duration.</li>
        <li style="color:#DCE9E7"><strong>One-tap PAUSE</strong> for the chair / host — executive session, off-the-record, personnel matters.</li>
        <li style="color:#DCE9E7"><strong>Non-consenting lines flagged</strong> in the transcript, redacted from any public output.</li>
      </ul>
      <p style="margin-top:var(--1891int-s-5)"><a class="btn btn-secondary" style="border-color:#fff;color:#fff" href="{BASE_PATH}/features/cart">CART feature detail</a></p>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">Retention</span>
      <h2>Defaults you don't have to ask for.</h2>
      <div class="table-scroll">
        <table class="compare">
          <thead><tr><th>Data type</th><th>Default retention</th><th>What happens after</th></tr></thead>
          <tbody>
            <tr><td>Raw audio</td><td>30 days</td><td>Auto-delete (cannot be extended without legal review)</td></tr>
            <tr><td>Transcript (timed, machine-readable)</td><td>1 year</td><td>Archive (cold storage, restorable on request)</td></tr>
            <tr><td>Approved minutes / human-edited summary</td><td>Permanent</td><td>This is the legal record</td></tr>
            <tr><td>Executive-session / paused-mic portions</td><td>Never captured</td><td>Cannot be retroactively recorded</td></tr>
            <tr><td>Audit log</td><td>7 years</td><td>Add-only, tamper-evident, then archived</td></tr>
            <tr><td>Operational data (jobs, invoices, etc.)</td><td>As long as you're a customer</td><td>One-click export on cancellation</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <span class="eyebrow">Compliance posture</span>
      <h2>Where we are — honest about the timeline.</h2>
      <div class="grid grid-3">
        <div class="card"><h3 class="mt-0">HIPAA</h3><p class="ink-soft">BAA executed. Technical, administrative, and physical safeguards documented. Annual risk assessment.</p></div>
        <div class="card"><h3 class="mt-0">SOC 2</h3><p class="ink-soft">Type I targeted for Q4 2026; Type II for Q3 2027. We won't claim a Type II we don't have. Status is on this page when it changes.</p></div>
        <div class="card"><h3 class="mt-0">GDPR / UK GDPR</h3><p class="ink-soft">DPA available on request. EU/UK customers gated behind data-residency review until our EU presence is set up.</p></div>
        <div class="card"><h3 class="mt-0">FERPA</h3><p class="ink-soft">School-district customers have a FERPA-compatible DPA covering student records. K-12 settings default to no recording.</p></div>
        <div class="card"><h3 class="mt-0">Accessibility (Section 508 / WCAG)</h3><p class="ink-soft">Built to the recognized standards from the first screen. The formal statement is on the <a href="{BASE_PATH}/accessibility">accessibility</a> page.</p></div>
        <div class="card"><h3 class="mt-0">PCI</h3><p class="ink-soft">No card data touches our servers. Payments are processed end-to-end by Stripe. We hold tokens, not PANs.</p></div>
      </div>
      <p style="margin-top:var(--1891int-s-6)"><a class="btn btn-primary" href="{BASE_PATH}/legal/subprocessors">See the full subprocessor list</a></p>
    </div>
  </section>

  {cta_band("Need the BAA? It takes days, not weeks.", "Read the BAA", f"{BASE_PATH}/legal/baa", "Talk to us", f"{BASE_PATH}/contact")}
"""


def accessibility_body() -> str:
    return f"""
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">Accessibility</span>
      <h1>Built so everyone in the room can use it.</h1>
      <p class="lede">Keyboard, screen reader, captions, color and contrast, motion — handled on the first screen and every screen after it. Not to earn a badge. Because it's the work, and it's the right way to do it.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">What that means, plainly</span>
      <h2>Day-to-day, here's what we do.</h2>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">Keyboard</h3><p class="ink-soft">Every action works from the keyboard. You can always see where you are. The order you tab through matches the order you'd read. Nowhere to get stuck.</p></div>
        <div class="card"><h3 class="mt-0">Screen reader</h3><p class="ink-soft">Tested with the screen readers people actually use, every release. When something changes on screen, it's announced. We lean on plain, correct markup over clever tricks.</p></div>
        <div class="card"><h3 class="mt-0">Color &amp; contrast</h3><p class="ink-soft">Text is easy to read against its background. Color is never the only signal — every change carries an icon and words too, so it works whether or not you see color the same way.</p></div>
        <div class="card"><h3 class="mt-0">Captions</h3><p class="ink-soft">On by default whenever there's audio. Our explainer videos carry captions and an ASL version. Audio inside the product is captioned as it happens.</p></div>
        <div class="card"><h3 class="mt-0">ASL</h3><p class="ink-soft">Where a page explains how something works, there's an ASL version. Glossary terms come with an ASL video — many of them signed by Fallon herself.</p></div>
        <div class="card"><h3 class="mt-0">Motion</h3><p class="ink-soft">If your device asks for less motion, the site listens and the animations turn off. We check it every release.</p></div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap-narrow">
      <span class="eyebrow">Where we are, honestly</span>
      <h2>This is the marketing site today. The app comes next.</h2>
      <p class="ink-soft">Right now what's public is this site, and it's built to the same bar we hold the product to. The app comes online with our first agencies later this year, and we'll keep this page current as it does — including the things still on our list and when we expect to have them fixed. If you hit something that doesn't work, that's a bug to us, the same as any other.</p>
      <p style="margin-top:var(--1891int-s-4)">Found something? Email <a href="mailto:accessibility@madeby1891.com">accessibility@madeby1891.com</a> and a person will read it.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap-narrow">
      <span class="eyebrow">What you can count on</span>
      <h2>The promises behind it.</h2>
      <ol class="stack-3" style="padding-left:1.2em">
        <li>Access is in everything we make, for everyone, at no extra charge. Charging for it would be backwards.</li>
        <li>When a page explains how the product works, it comes with ASL and captions.</li>
        <li>Tell us something isn't working and you'll hear back from a person within two business days, with a real fix date soon after.</li>
        <li>An access problem blocks a release the same as any other bug — because it is one.</li>
        <li>We don't auto-caption sign language. Getting that right is a research problem, not something to fake. We do caption spoken English, live.</li>
      </ol>
      <p style="margin-top:var(--1891int-s-5)"><a class="btn btn-primary" href="{BASE_PATH}/legal/accessibility-statement">The formal, standards-language statement</a></p>
    </div>
  </section>
"""


def changelog_body() -> str:
    return f"""
  <section class="feature-hero">
    <div class="wrap-narrow">
      <span class="eyebrow">Changelog</span>
      <h1>What's new.</h1>
      <p class="lede">This is where releases show up as they land. It's early, so the list is short — we'd rather it be honest than padded.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap-narrow">
      <article class="card">
        <div class="tag" style="color:var(--1891int-bloom-deep)">{BUILD_DATE} · The marketing site</div>
        <h2 class="mt-0" style="margin-top:6px">This site went live at madeby1891.com/interpreter.</h2>
        <ul class="checks">
          <li>Home, the pages for each role (agencies, schedulers, interpreters, requestors, billing), pricing, free for Deaf-owned, security, accessibility, about, and our 1891.</li>
          <li>Nine walkthroughs of what the product does.</li>
          <li>The legal pages — privacy, terms, BAA, data processing, subprocessors, disclosure, and the accessibility statement.</li>
          <li>Built for access from the first screen.</li>
        </ul>
        <p class="ink-soft">The product itself isn't open to everyone yet — it starts with our first agencies later this year. For now, this is the front door and the place to apply for Deaf-owned verification.</p>
      </article>
    </div>
  </section>
"""


# Stub generator for placeholder pages
def stub_body(eyebrow: str, h1: str, lede: str) -> str:
    return f"""
  <section class="feature-hero">
    <div class="wrap-narrow">
      <span class="eyebrow">{eyebrow}</span>
      <h1>{h1}</h1>
      <p class="lede">{lede}</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap-narrow">
      <p class="ink-soft">This page is on the public sitemap and ready to fill as content lands. Until then, please reach us at <a href="mailto:hello@madeby1891.com">hello@madeby1891.com</a> for anything you'd expect to find here.</p>
      <p style="margin-top:var(--1891int-s-5)"><a class="btn btn-ghost" href="{BASE_PATH}/">Back to home</a></p>
    </div>
  </section>
"""


def legal_body(title: str, eyebrow: str, body_html: str) -> str:
    return f"""
  <section class="feature-hero">
    <div class="wrap-narrow">
      <span class="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
    </div>
  </section>
  <section class="section">
    <div class="wrap-narrow">
      {body_html}
      <hr style="border:0;border-top:1px solid var(--1891int-line);margin:var(--1891int-s-7) 0">
      <p class="tag">Last updated: {BUILD_DATE}. Questions: <a href="mailto:hello@madeby1891.com">hello@madeby1891.com</a>.</p>
    </div>
  </section>
"""


def fourohfour_body() -> str:
    return f"""
  <section class="section" style="padding-top:var(--1891int-s-10); padding-bottom:var(--1891int-s-10)">
    <div class="wrap-narrow center-text">
      <span class="eyebrow">404</span>
      <h1>Not the page you were looking for.</h1>
      <p class="lede" style="margin:0 auto">If you got here from a link on our own site, that's a bug — please <a href="mailto:hello@madeby1891.com">tell us</a> and we'll fix it.</p>
      <div class="cluster" style="justify-content:center; margin-top:var(--1891int-s-6)">
        <a class="btn btn-primary" href="{BASE_PATH}/">Home</a>
        <a class="btn btn-ghost" href="{BASE_PATH}/features/">Features</a>
        <a class="btn btn-ghost" href="{BASE_PATH}/pricing">Pricing</a>
      </div>
    </div>
  </section>
"""


# -----------------------------------------------------------------------------
# Page registry
# -----------------------------------------------------------------------------

def build_pages() -> list[Page]:
    pages: list[Page] = []

    pages.append(Page(
        path="index.html",
        title="1891 Interpreter — The interpreting agency platform built by the community it serves",
        description="Scheduling, the interpreter app, billing, translation, and live captions in one tool. The whole day on one board. Claim a job by text. Close out with expenses in one screen. One clean bill per client. Free forever for verified Deaf-owned agencies.",
        nav_active="",
        body=home_body(),
        og_title="1891 Interpreter — built by the community it serves",
    ))

    pages.append(Page(
        path="for-agencies.html",
        title="For agency owners — 1891 Interpreter",
        description="Flat per agency — no per-seat tax, no per-job fee. One clean bill per client, however their departments are organized. A tamper-evident audit log, the numbers you check every morning, and your data exportable any day with one click.",
        nav_active="agencies",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("For agencies", "")),
        body=for_agencies_body(),
    ))
    pages.append(Page(
        path="for-schedulers.html",
        title="For schedulers — 1891 Interpreter",
        description="The whole day on one board — open, claimed, confirmed. The right interpreter suggested for you, warnings that explain themselves, and a clear preview of what a cancellation costs before you confirm it.",
        nav_active="schedulers",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("For schedulers", "")),
        body=for_schedulers_body(),
    ))
    pages.append(Page(
        path="for-interpreters.html",
        title="For interpreters — 1891 Interpreter",
        description="Two-tap claim. SMS YES/NO works too. See your pay before you accept. Close out with actual times, expenses, and receipts. Approved expenses roll into your next payout automatically.",
        nav_active="interpreters",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("For interpreters", "")),
        body=for_interpreters_body(),
    ))
    pages.append(Page(
        path="for-requestors.html",
        title="For requestors — 1891 Interpreter",
        description="Book an interpreter without learning new software. Reply to an email, fill a short form, or call. Same outcome — confirmed interpreter, confirmation email, calendar invite — usually within the hour.",
        nav_active="",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("For requestors", "")),
        body=for_requestors_body(),
    ))
    pages.append(Page(
        path="for-payers.html",
        title="For billing, AP, and CFOs — 1891 Interpreter",
        description="One clean bill per client, however their departments and locations are organized. Invoice lines with exactly the detail your client needs, patient details kept private by default, and a tidy hand-off to QuickBooks, Xero, NetSuite, and Bill.com.",
        nav_active="",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Billing & AP", "")),
        body=for_payers_body(),
    ))

    pages.append(Page(
        path="pricing.html",
        title="Pricing — 1891 Interpreter",
        description="Public prices, every tier. Flat per agency. No per-job fee. Free forever for verified Deaf-owned agencies. Solo $9, Practice $249, Studio $749, Network from $2,400.",
        nav_active="pricing",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Pricing", "")),
        body=pricing_body(),
    ))
    pages.append(Page(
        path="free-for-deaf-owned.html",
        title="Free forever for Deaf-owned agencies — 1891 Interpreter",
        description="Verified Deaf-owned agencies pay nothing — full features, unlimited interpreters, unlimited jobs, BAA included, no time limit. Verification process is public.",
        nav_active="free",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Free for Deaf-owned", "")),
        body=free_body(),
    ))
    pages.append(Page(
        path="get-a-demo.html",
        title="Get a demo — 1891 Interpreter",
        description="30 minutes on a real account, no slide deck. Your agency on the screen.",
        nav_active="",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Get a demo", "")),
        body=get_demo_body(),
    ))
    pages.append(Page(
        path="start-free.html",
        title="Start free if Deaf-owned — 1891 Interpreter",
        description="Skip the demo, start the Deaf-owned verification application directly.",
        nav_active="",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Start free", "")),
        body=start_free_body(),
    ))
    pages.append(Page(
        path="contact.html",
        title="Contact — 1891 Interpreter",
        description="Three ways to reach the team. General, accessibility feedback, responsible disclosure.",
        nav_active="",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Contact", "")),
        body=contact_body(),
    ))
    pages.append(Page(
        path="sign-in.html",
        title="Sign in — 1891 Interpreter",
        description="Magic link sign-in. No passwords.",
        nav_active="",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Sign in", "")),
        body=sign_in_body(),
    ))

    pages.append(Page(
        path="features/index.html",
        title="Features — 1891 Interpreter",
        description="Scheduling with smart-fill and cancellation tier preview, interpreter app with SMS YES/NO claim and close-out modal, billing with 5 consolidation modes, translation, AI intake, VRI/OPI, CART, reporting, integrations.",
        nav_active="features",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Features", "")),
        body=features_index_body(),
    ))

    _demo = f"{BASE_PATH}/get-a-demo"
    feature_specs = [
        {
            "slug": "scheduling.html", "label": "Scheduling", "eyebrow": "Feature · Scheduling",
            "lede": "Every job for the day on one board — open, claimed, confirmed, and the few that still need a hand. The right interpreter is suggested for you, and you always see what a change costs before you make it.",
            "description": "One board for the whole day. The right interpreter suggested for you, warnings that explain themselves, and a clear preview of what a cancellation costs before you confirm it.",
            "hero": mock_frame("Today's board · your agency", ui_scheduler_board(), href=_demo,
                               caption="A real day on the board. <strong>Click to walk through it with us.</strong>"),
            "rows": [
                {"h": "The right interpreter, suggested for you",
                 "body": "<p class=\"ink-soft\">For every open job, you get a short list of the best people for it — ranked by who has the right credential, who's nearby, who this clinic has asked for before, and whose turn it is. Each suggestion shows <em>why</em> it's a match, so it's a head start, never a black box.</p>",
                 "media": mock_frame("Suggested for this job", ui_smartfill(),
                                     caption="Why each interpreter ranks where they do — in plain sight.")},
                {"h": "See what a cancellation costs — before you confirm",
                 "body": "<p class=\"ink-soft\">Slide to the time the job is canceling and the screen shows exactly what the client is billed and what each interpreter still earns, under that client's own rules. No fire-and-pray, no awkward call later. <strong>Try the slider →</strong></p>",
                 "media": '<div class="widget" data-widget="cancel" data-reveal></div>'},
                {"h": "Warnings that explain themselves",
                 "body": "<p class=\"ink-soft\">Every flag comes with a one-line reason, so you know why it fired — not just that it did. No double-booking, ever. A heads-up when two jobs are back-to-back across town. A nudge when this clinic has a favorite interpreter who's free.</p>",
                 "media": mock_frame("Before you send the offer", ui_conflict_rules(),
                                     caption="Plain-English reasons next to every warning.")},
                {"h": "Private until it's claimed",
                 "body": "<p class=\"ink-soft\">Interpreters see just enough to decide — the kind of job, the time, the pay, and the consumer's initials. The full details open the moment they accept, and that hand-off is written down with a name and a time. Nobody browses patient details they haven't picked up.</p>",
                 "media": None},
            ],
        },
        {
            "slug": "interpreter-app.html", "label": "The interpreter app", "eyebrow": "Feature · The interpreter app",
            "lede": "Built for a phone in one hand. Claim a job in two taps — or just reply YES to a text. See exactly what you'll be paid before you accept, and close out with your real times and expenses in one screen.",
            "description": "Claim a job in two taps or reply YES to a text. See your pay before you accept. Close out with your actual times, expenses, and receipts in one screen — and get paid on the day you were promised.",
            "hero": mock_phone(ui_interpreter_offer(),
                               caption="The offer, the pay, and the Claim button — one tap from your text messages."),
            "rows": [
                {"h": "Or just reply YES to a text",
                 "body": "<p class=\"ink-soft\">Hands full between assignments? Reply <strong>YES</strong> to claim a job or <strong>NO</strong> to pass — no app to open, no password to remember. It counts exactly the same as tapping Claim in the app. <strong>Try it on the right →</strong></p>",
                 "media": '<div class="widget" data-widget="sms" data-reveal></div>'},
                {"h": "See your pay before you say yes",
                 "body": "<p class=\"ink-soft\">Every offer shows the full math up front — hourly, minimums, mileage, and any evening or weekend premium — added up to one number. When your agency turns on pay transparency, you see what the client is billed too. No surprises at payout time.</p>",
                 "media": None},
                {"h": "Close out in one screen",
                 "body": "<p class=\"ink-soft\">After the job, enter your real start and end times, add expenses like mileage or parking, snap a receipt, and you're done. If you ran long, it gently asks for a sentence of context. Approved expenses ride along on your next payment automatically — and they're never billed back to the client.</p>",
                 "media": mock_frame("Close out · Medical · ASL", ui_closeout(),
                                     caption="Real times and expenses, attached to the job in seconds.")},
                {"h": "Get paid on the day you were promised",
                 "body": "<p class=\"ink-soft\">Direct deposit to your account, with a clear stub that lists your work and your expenses on separate lines. Your year-to-date earnings are always a tap away, and if you work for more than one agency on the platform, you see each one's share. Your 1099 shows up every January.</p>",
                 "media": None},
                {"h": "Quiet by default",
                 "body": "<p class=\"ink-soft\">You decide how often you hear from us — the moment a job posts, a once-a-day morning digest, a weekly roundup, or nothing at all. Set it per channel. We'd rather be useful than noisy.</p>",
                 "media": None},
            ],
        },
        {
            "slug": "billing.html", "label": "Billing &amp; payouts", "eyebrow": "Feature · Billing",
            "lede": "Your rates, your invoices. One client gets one bill — no matter how many departments and locations sit underneath them. And your interpreters get paid on time, with a stub they can actually read.",
            "description": "Set your own rates. Send one clean bill per client, however their departments and locations are organized. Pay interpreters on time with a clear stub. Sends to the accounting and payroll tools you already use.",
            "hero": mock_frame("Invoice · Frederick Health", ui_invoice(), href=_demo,
                               caption="One bill for a client with four departments. <strong>Click to see the live demo.</strong>"),
            "rows": [
                {"h": "One client, one bill — however they're organized",
                 "body": "<p class=\"ink-soft\">A hospital might be one client with four departments, six locations, and a dozen doctors. You decide how the bill comes together — all on one statement, split by department, split by location, or one per job — and you can do it differently for each client on the same monthly cycle. <strong>Open the client on the right →</strong></p>",
                 "media": '<div class="widget" data-widget="clients" data-reveal></div>'},
                {"h": "Your rates, your way",
                 "body": "<p class=\"ink-soft\">Set rates by the kind of work, the language, the time of day, and the team — and the evening, weekend, and short-notice premiums add themselves. When you raise a rate, old invoices keep the price they were billed at. <strong>Play with the rate engine on the right →</strong></p>",
                 "media": '<div class="widget" data-widget="rates" data-reveal></div>'},
                {"h": "Interpreters paid on time, with a clear stub",
                 "body": "<p class=\"ink-soft\">Each payment stub lists the work and the expenses on separate lines, each with its own subtotal and a grand total at the bottom. Patient details are kept private on every bill and stub by default. The day you promised is the day they're paid.</p>",
                 "media": None},
                {"h": "Sends to the books you already keep",
                 "body": "<p class=\"ink-soft\">Hours and invoices hand off cleanly to the accounting and payroll tools you already run — QuickBooks, Xero, NetSuite, ADP, Gusto, and the rest — and your 1099 filings go out automatically. Nothing to re-key, no copy-paste at month end.</p>",
                 "media": None},
            ],
        },
        {
            "slug": "translation.html", "label": "Document translation", "eyebrow": "Feature · Document translation",
            "lede": "Turn forms, letters, and consents into another language with a real translator checking every page. Nothing medical or legal is ever auto-filled — a person reviews it, every time.",
            "description": "Translate documents with a real translator checking every page. Nothing medical or legal is ever auto-filled. It remembers what it's translated before, and gives the file back the way you need it.",
            "hero": mock_frame("Translate · intake form", ui_translation(), href=_demo,
                               caption="Side by side, with a translator reviewing. <strong>Click for the live demo.</strong>"),
            "rows": [
                {"h": "A real person on every page",
                 "body": "<p class=\"ink-soft\">A translator from your roster (or the open pool, your choice) handles every document. For ordinary material they can start from a machine draft to save time — but for anything medical or legal, consent forms, court filings, or a student's IEP, that shortcut is switched off entirely. A person translates it, full stop.</p>",
                 "media": None},
                {"h": "It remembers what it's translated before",
                 "body": "<p class=\"ink-soft\">The same phrases come up again and again — appointment reminders, standard instructions, common consents. Once your translator approves a phrasing, it's suggested next time, so your wording stays consistent and the work goes faster. Your library is yours alone; it's never shared with another agency.</p>",
                 "media": None},
                {"h": "Back the way you need it",
                 "body": "<p class=\"ink-soft\">You get a clean file that keeps the look of the original wherever possible. When a certified or sworn translation is required, it comes with the translator's certification and signature page attached.</p>",
                 "media": None},
            ],
        },
        {
            "slug": "ai-intake.html", "label": "Smart intake", "eyebrow": "Feature · Smart intake",
            "lede": "An email or a voicemail becomes a tidy draft job in seconds — language, time, place, length, all filled in for you. You check every one before it's booked, and the patient's details never leave your agency.",
            "description": "An email or voicemail becomes a tidy draft job in seconds — language, time, place, and length filled in. You review every one before it's booked, and patient details stay private.",
            "hero": mock_frame("Intake · new request", ui_intake(), href=_demo,
                               caption="A request comes in; a draft job comes out. <strong>Click to see it live.</strong>"),
            "rows": [
                {"h": "You're always the one who hits ‘book’",
                 "body": "<p class=\"ink-soft\">When a request arrives by email or voicemail, the platform pulls out the details and lays them out as a draft — never a confirmed job. A scheduler looks it over and accepts. Anything it wasn't sure about is highlighted, so your eyes go straight to it.</p>",
                 "media": None},
                {"h": "Private details stay private",
                 "body": "<p class=\"ink-soft\">Before any of this happens, names and personal details — phone numbers, dates of birth, anything clinical in the message — are stripped out and kept on your side. The part that does the reading only ever sees a tidied-up version with the sensitive bits removed, and every step is logged.</p>",
                 "media": None},
                {"h": "Honest about what's ready",
                 "body": "<p class=\"ink-soft\">The intake and review screens are live and in daily use. A couple of the deeper AI assists are still being switched on, and we mark exactly what's live and what's coming on the <a href=\"" + BASE_PATH + "/changelog\">changelog</a>. We'd rather under-promise.</p>",
                 "media": None},
            ],
        },
        {
            "slug": "vri-opi.html", "label": "Video &amp; phone interpreting", "eyebrow": "Feature · Video &amp; phone",
            "lede": "Bring an interpreter onto a screen or onto the line, right inside the same schedule you already use. Captions on, and recording only when everyone agrees to it.",
            "description": "Video Remote and Over-the-Phone interpreting, booked in the same schedule as your on-site jobs. Captions on by default, recording only with consent. This is VRI/OPI — not the federally-funded VRS relay.",
            "hero": mock_frame("Live session · VRI", ui_vri(), href=_demo,
                               caption="An interpreter on screen, captions on. <strong>Click for the live demo.</strong>"),
            "rows": [
                {"h": "On screen, in the same schedule",
                 "body": "<p class=\"ink-soft\">Video appointments live right alongside your on-site jobs — same board, same rates, same invoice. The session opens in the browser with captions on, you can bring a second interpreter on with a tap, and nothing is ever recorded unless everyone on the call agrees to it.</p>",
                 "media": None},
                {"h": "By phone when that's simpler",
                 "body": "<p class=\"ink-soft\">Some calls just need a voice on the line. Over-the-phone interpreting is booked the same way, through the same queue. You only pay for the minutes used, passed along at cost and itemized on the invoice — never marked up.</p>",
                 "media": None},
                {"h": "This isn't VRS",
                 "body": "<p class=\"ink-soft\">Quick clarification, because the names sound alike: this is video and phone interpreting that an agency books and pays for. It is <strong>not</strong> VRS — the free, federally-funded Deaf-to-hearing phone relay. Different service, different rules. We don't do VRS.</p>",
                 "media": None},
            ],
        },
        {
            "slug": "cart.html", "label": "Live captions (CART)", "eyebrow": "Feature · Live captions",
            "lede": "Real-time captioning, booked right alongside your sign- and spoken-language jobs — same rates, same invoice. And plain live captions for the meetings in between.",
            "description": "Real-time CART captioning scheduled alongside your other jobs, same rates and invoice. Plus plain live captions for everyday meetings — consent first, with retention you control.",
            "hero": mock_frame("Live captions · board meeting", ui_captions(), href=_demo,
                               caption="Words on the screen as they're spoken. <strong>Click for the live demo.</strong>"),
            "rows": [
                {"h": "Booked like any other job",
                 "body": "<p class=\"ink-soft\">A certified captioner's work schedules right next to your sign- and spoken-language jobs, on the same rates and the same invoice. One roster, one board, one bill — captioning isn't a separate system bolted on the side.</p>",
                 "media": None},
                {"h": "Captions for the in-between moments",
                 "body": "<p class=\"ink-soft\">For the everyday meetings, trainings, and calls where a captioner isn't booked but people still need the words on screen, the platform can caption live speech on its own. It's clearly labeled as automatic captioning — and we never auto-caption sign language, because that's not something to fake.</p>",
                 "media": None},
                {"h": "Consent first, always",
                 "body": "<p class=\"ink-soft\">Everyone is asked before anything is captured, a clear recording indicator shows on every shared screen, and the chair can pause for a private moment. You decide how long transcripts are kept. The full retention table is on the <a href=\"" + BASE_PATH + "/security\">security page</a>.</p>",
                 "media": None},
            ],
        },
        {
            "slug": "reporting.html", "label": "Reports", "eyebrow": "Feature · Reports",
            "lede": "Plain-English answers about your agency: how many jobs you filled, how fast you filled them, and how much money is owed. Ask a question, get a number you can export.",
            "description": "The numbers you actually check — jobs filled, time to fill, money owed — on one screen. Ask a question in plain English and get an answer you can export to a spreadsheet or PDF.",
            "hero": mock_frame("Reports · this week", ui_reporting(), href=_demo,
                               caption="The Monday-morning numbers, at a glance. <strong>Click to explore the demo.</strong>"),
            "rows": [
                {"h": "Ask in plain English",
                 "body": "<p class=\"ink-soft\">Type a question the way you'd say it out loud — <em>“How many ASL medical jobs did we cancel late last month, and who was on them?”</em> — and get a straight answer with the jobs behind it. It only ever reads your data to answer; it can't change anything.</p>",
                 "media": mock_frame("Ask anything", '<div class="ui-pane" style="background:var(--1891int-bloom-tint);border-color:var(--1891int-bloom-soft);color:var(--1891int-bloom-deep)">“How many ASL medical jobs did we cancel late last month?”</div><div class="ui-row" style="margin-top:10px"><div class="ui-row-main"><span class="ui-row-title">3 late cancellations</span><span class="ui-row-sub">2 interpreters affected · Apr 1–30</span></div><span class="mchip is-confirmed">Export</span></div>',
                                     caption="Plain question in, clear answer out.")},
                {"h": "The numbers you actually check",
                 "body": "<p class=\"ink-soft\">Fill rate, time to fill, late-cancellation rate, who's getting their fair share of work, money owed and how long it's been outstanding — all ready out of the box. Pin the ones you care about to your home screen so they're there every morning.</p>",
                 "media": None},
                {"h": "Export anything, anytime",
                 "body": "<p class=\"ink-soft\">Every number drops straight into a spreadsheet or a PDF for the board packet. Want a weekly email roundup? Turn it on. Don't want one? Leave it off — most people do.</p>",
                 "media": None},
            ],
        },
        {
            "slug": "integrations.html", "label": "Connections", "eyebrow": "Feature · Connections",
            "lede": "Plays nicely with the accounting, payroll, payout, and sign-in tools you already run. Hours and invoices flow where they need to go — nothing to re-key.",
            "description": "Connects to the accounting, payroll, payout, and identity tools you already use — QuickBooks, Xero, NetSuite, ADP, Gusto, and more. Hours and invoices flow automatically, with nothing to re-key.",
            "hero": mock_frame("Connections", ui_integrations(), href=_demo,
                               caption="The tools you already run, wired in. <strong>Click for the live demo.</strong>"),
            "rows": [
                {"h": "The tools you already run",
                 "body": "<p class=\"ink-soft\">Send invoices and hours to your accounting books (QuickBooks, Xero, NetSuite, Bill.com), push payroll hours to ADP, Gusto, Paychex, or Rippling, pay interpreters by direct deposit, and file 1099s automatically. Sign-in works with single sign-on for the bigger plans, and passkeys for everyone.</p>",
                 "media": None},
                {"h": "Nothing to re-key",
                 "body": "<p class=\"ink-soft\">The point of every connection is to save you the copy-paste. Numbers move on their own, on a schedule, so month-end close stops being an evening of retyping. Where a direct connection isn't available, a clean spreadsheet export is always one click away.</p>",
                 "media": None},
            ],
        },
    ]
    for spec in feature_specs:
        pages.append(Page(
            path=f"features/{spec['slug']}",
            title=f"{spec['label']} — 1891 Interpreter",
            description=spec["description"],
            nav_active="features",
            breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Features", f"{BASE_PATH}/features/"), (spec["label"], "")),
            body=feature_page_body(spec["label"], spec["eyebrow"], spec["lede"], spec["hero"], spec["rows"], _demo),
        ))

    pages.append(Page(
        path="security.html",
        title="Security &amp; compliance — 1891 Interpreter",
        description="Built to hold up to HIPAA. Patient details are stripped out before anything reaches an AI tool. Every record opened is written down, in a log that can't be quietly edited. Maryland two-party consent is built in. A signed BAA comes with every paid plan and the Deaf-owned plan.",
        nav_active="security",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Security", "")),
        body=security_body(),
    ))
    pages.append(Page(
        path="accessibility.html",
        title="Accessibility — 1891 Interpreter",
        description="Built so everyone in the room can use it — keyboard, screen reader, captions, color and contrast, and reduced motion, on the first screen and every screen after. ASL where it explains the product. Not for a badge; because it's the right way to do the work.",
        nav_active="",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Accessibility", "")),
        body=accessibility_body(),
    ))
    pages.append(Page(
        path="about.html",
        title="About — 1891 Interpreter",
        description="Anthony Mowl, Fallon Brizendine, and the small team building 1891 Interpreter from Frederick, MD.",
        nav_active="about",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("About", "")),
        body=about_body(),
    ))
    pages.append(Page(
        path="our-1891.html",
        title="Our 1891 — 1891 Interpreter",
        description="Five generations Deaf. One number. What '1891' refers to, why it's the undercurrent not the headline, and what we don't do with the lineage.",
        nav_active="",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Our 1891", "")),
        body=our_1891_body(),
    ))
    pages.append(Page(
        path="changelog.html",
        title="Changelog — 1891 Interpreter",
        description="What's new at 1891 Interpreter. Every release, visible.",
        nav_active="",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Changelog", "")),
        body=changelog_body(),
    ))

    # Story / content stubs
    pages.append(Page(
        path="blog/index.html",
        title="Blog — 1891 Interpreter",
        description="Writing from the 1891 Interpreter team.",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Blog", "")),
        body=stub_body("Blog", "Writing from the team.", "We're working on the first few posts — plain writing about how this work actually gets done. They'll show up here when they're ready, not before."),
    ))
    pages.append(Page(
        path="case-studies/index.html",
        title="Case studies — 1891 Interpreter",
        description="Customer stories from agencies using 1891 Interpreter.",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Case studies", "")),
        body=stub_body("Case studies", "Customer stories.", "Our first stories will come from the agencies we work with early on — and only with their written permission. Nothing here until they're ready to be named."),
    ))
    pages.append(Page(
        path="customers/index.html",
        title="Customers — 1891 Interpreter",
        description="The agencies running on 1891 Interpreter (logos with signed permission only).",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Customers", "")),
        body=stub_body("Customers", "This page is empty on purpose.",
                       "An empty page is more honest than a wall of borrowed logos. We'll add an agency here only with their written permission — never before."),
    ))
    pages.append(Page(
        path="resources/index.html",
        title="Resources — 1891 Interpreter",
        description="Guides, glossaries, and templates from 1891 Interpreter.",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Resources", "")),
        body=stub_body("Resources", "Guides, glossaries, templates.", "A plain-language glossary is in the works — each term with an ASL video and a Spanish translation — along with a few practical guides. We'll add them here as they're ready."),
    ))

    # Legal cluster
    privacy_html = """
      <h2>What we collect — and what we don't.</h2>
      <p>The marketing site (this site) collects only what you submit through a form. We do not run third-party trackers, advertising pixels, or behavioral analytics. We do not set non-essential cookies. We do not fingerprint visitors.</p>
      <p>The product (when you have an account) collects what's needed to do interpreting agency work: rosters, requestors, jobs, invoices, and — where it's necessary — minimal PHI tied to a job. We collect the least we can. We retain it for the periods documented on the <a href=\"""" + BASE_PATH + """/security\">security page</a>.</p>

      <h2>Marketing forms.</h2>
      <p>When you fill a form on this site, the data is routed to a small team inbox (Anthony, Fallon, or the inbound queue). We retain inbound inquiries for 24 months from submission. We do not sell or share the data. We do not add you to a third-party newsletter list without your explicit opt-in.</p>

      <h2>Cookies.</h2>
      <p>We use a single session cookie set only after you sign in, and only to maintain your session. No third-party cookies. No analytics cookies on the public marketing site at launch.</p>

      <h2>Your rights.</h2>
      <p>You can request a copy of any personal data we hold about you, ask us to correct or delete it, or withdraw consent at any time. Email <a href=\"mailto:privacy@madeby1891.com\">privacy@madeby1891.com</a>. We respond within 30 days.</p>

      <h2>HIPAA.</h2>
      <p>If you are a covered entity or business associate, our <a href=\"""" + BASE_PATH + """/legal/baa\">BAA</a> governs PHI handling and takes precedence over this privacy notice for PHI specifically.</p>

      <h2>Where the data lives.</h2>
      <p>Primary data residency is in the United States (Cloudflare R2 in US regions, Google Workspace US tenant). EU/UK data residency is targeted for 2027. See the <a href=\"""" + BASE_PATH + """/legal/subprocessors\">subprocessor list</a>.</p>
    """
    pages.append(Page(
        path="legal/privacy.html",
        title="Privacy notice — 1891 Interpreter",
        description="What we collect, what we don't, how to exercise your rights.",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Legal", ""), ("Privacy", "")),
        body=legal_body("Privacy notice", "Legal", privacy_html),
    ))

    terms_html = """
      <p class="ink-soft">Plain-English summary above each section; the actual contractual text is below.</p>

      <h2>Acceptance.</h2>
      <p><em>Plain English:</em> Using the product means agreeing to these terms. If you don't agree, don't use it.</p>
      <p>By accessing or using the 1891 Interpreter service (the &quot;Service&quot;), you agree to be bound by these Terms of Service (&quot;Terms&quot;). If you are entering into these Terms on behalf of an organization, you represent that you have authority to bind that organization.</p>

      <h2>The free Deaf-owned tier.</h2>
      <p><em>Plain English:</em> Verified Deaf-owned agencies pay nothing. The verification standard is on the public site. If your ownership changes, the badge comes down.</p>
      <p>Eligibility, verification process, and recertification are documented at <a href=\"""" + BASE_PATH + """/free-for-deaf-owned\">/free-for-deaf-owned</a>. Verification decisions are made by a board that includes Fallon Brizendine and rotating community advisors. Denials are reviewed by the full board on appeal.</p>

      <h2>Your data.</h2>
      <p><em>Plain English:</em> Your data is yours. Export it any day. We don't sell it. We don't ransom it on cancellation.</p>
      <p>You retain all right, title, and interest in customer data. We will provide a complete export in CSV and JSON within 5 business days of any request. Cancellation triggers an automatic export delivered to the account owner. We do not transfer or sell customer data to third parties for marketing or advertising purposes.</p>

      <h2>HIPAA.</h2>
      <p>The <a href=\"""" + BASE_PATH + """/legal/baa\">BAA</a> governs all PHI processing and takes precedence over these Terms for PHI specifically.</p>

      <h2>Payment.</h2>
      <p>Paid tiers are billed monthly or annually in advance. Refunds are available pro rata for unused service if you cancel; we don't make you wait for the term to end to recoup unused months.</p>

      <h2>Acceptable use.</h2>
      <p>Don't use the Service for anything illegal, infringing, or harmful. Don't try to extract data on consumers, interpreters, or other customers outside your tenant. Don't reverse-engineer the platform to build a competing service. Be a good neighbor.</p>

      <h2>Termination.</h2>
      <p>Either party can terminate for convenience with 30 days' notice. We can suspend the Service immediately if continued operation would violate law, expose other customers to risk, or breach a third-party contract we're bound by. Suspension always includes an export window.</p>

      <h2>Limitation of liability.</h2>
      <p>To the extent permitted by law, our aggregate liability is limited to fees paid in the 12 months preceding the claim. We exclude indirect, incidental, consequential, and punitive damages. Nothing in these Terms limits liability that cannot be limited by law (e.g., gross negligence, willful misconduct).</p>

      <h2>Governing law.</h2>
      <p>These Terms are governed by the laws of Maryland, United States, without regard to conflict-of-laws principles. Venue is Frederick County, Maryland, unless we agree otherwise.</p>
    """
    pages.append(Page(
        path="legal/terms.html",
        title="Terms of service — 1891 Interpreter",
        description="The agreement between you and 1891 Interpreter for using the service.",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Legal", ""), ("Terms", "")),
        body=legal_body("Terms of service", "Legal", terms_html),
    ))

    baa_html = """
      <p class="ink-soft">This page is a plain-English summary of the BAA. The signed legal-form document is provided by request and on every paid-tier and Deaf-owned account at provisioning.</p>

      <h2>What the BAA covers.</h2>
      <p>The BAA between 1891 LLC (Business Associate) and your organization (Covered Entity, where applicable) governs how we use, disclose, and safeguard PHI in connection with the Service. It tracks the HHS-published model BAA closely; redlines are welcome on Studio and Network.</p>

      <h2>Permitted uses.</h2>
      <p>We use PHI only to provide the Service: scheduling interpreters, generating invoices, producing transcripts and minutes for your sessions, and performing the audit logging required by HIPAA. We do not use PHI for marketing, sale, or any other purpose not explicitly required by the Service.</p>

      <h2>Safeguards we maintain.</h2>
      <p>Technical, administrative, and physical safeguards as required by HIPAA Security Rule, including encryption at rest and in transit, role-based access, append-only audit logging with hash-chain integrity, retention defaults documented at <a href=\"""" + BASE_PATH + """/security\">/security</a>, and an annual risk assessment.</p>

      <h2>Subprocessors and PHI.</h2>
      <p>We use a short list of subprocessors who each carry their own BAA. The full list and per-vendor BAA status lives at <a href=\"""" + BASE_PATH + """/legal/subprocessors\">/legal/subprocessors</a>.</p>

      <h2>Breach notification.</h2>
      <p>We notify you of any breach affecting your PHI within 30 days, with as much detail as we have. For low-risk events, we notify in our quarterly summary; for high-risk events, we notify within 24 hours and walk you through the response together.</p>

      <h2>How to get the BAA.</h2>
      <p>Email <a href=\"mailto:legal@madeby1891.com\">legal@madeby1891.com</a> with your organization name and we'll send the executable PDF. Most BAAs are countersigned within 3 business days. Redlines are welcome on Studio and Network; we'll work them with our counsel and yours.</p>
    """
    pages.append(Page(
        path="legal/baa.html",
        title="Business Associate Agreement (BAA) — 1891 Interpreter",
        description="Plain-English summary of the BAA and how to get the signed version.",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Legal", ""), ("BAA", "")),
        body=legal_body("Business Associate Agreement (BAA)", "Legal", baa_html),
    ))

    dpa_html = """
      <h2>Scope.</h2>
      <p>The Data Processing Agreement (DPA) governs our processing of personal data on your behalf for GDPR, UK GDPR, and California CPRA purposes. The DPA forms part of the Terms when your organization or your end-users are subject to those regulations.</p>

      <h2>Roles.</h2>
      <p>Your organization is the data controller; 1891 LLC is the data processor. We process personal data only to provide the Service and only on your documented instructions.</p>

      <h2>Sub-processing.</h2>
      <p>Our subprocessor list is public and we notify you 30 days before adding a new subprocessor that processes personal data. See <a href=\"""" + BASE_PATH + """/legal/subprocessors\">/legal/subprocessors</a>.</p>

      <h2>International transfers.</h2>
      <p>Primary data residency is US. EU/UK customer data is gated behind data-residency review until our EU presence is established (targeted 2027). Standard Contractual Clauses (SCCs) and UK IDTA apply where transfers occur.</p>

      <h2>How to get the DPA.</h2>
      <p>Email <a href=\"mailto:legal@madeby1891.com\">legal@madeby1891.com</a>. Standard DPA signed within 3 business days.</p>
    """
    pages.append(Page(
        path="legal/dpa.html",
        title="Data Processing Agreement (DPA) — 1891 Interpreter",
        description="GDPR / UK GDPR / CPRA processing terms.",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Legal", ""), ("DPA", "")),
        body=legal_body("Data Processing Agreement (DPA)", "Legal", dpa_html),
    ))

    sub_html = """
      <p>Updated every time we change a subprocessor. We notify paid-tier customers 30 days before adding a subprocessor that processes their personal data.</p>
      <div class="table-scroll">
        <table class="compare">
          <thead><tr><th>Subprocessor</th><th>Purpose</th><th>Data type</th><th>Location</th><th>BAA / DPA</th></tr></thead>
          <tbody>
            <tr><td>Google Workspace</td><td>Per-agency Sheets (system of record)</td><td>Operational data, PHI</td><td>United States</td><td class="yes">BAA + DPA</td></tr>
            <tr><td>Cloudflare (Enterprise)</td><td>Workers, R2, KV, DO, queues</td><td>Operational data, PHI (paid tiers)</td><td>Global edge</td><td class="yes">BAA + DPA</td></tr>
            <tr><td>Anthropic</td><td>Claude API (redacted inputs only)</td><td>Redacted PHI projections, NOT raw PHI</td><td>United States</td><td class="yes">BAA (direct API)</td></tr>
            <tr><td>DeepL</td><td>Document translation (general)</td><td>Redacted text, NOT medical/legal raw</td><td>EU</td><td class="yes">DPA</td></tr>
            <tr><td>Deepgram</td><td>Streaming STT for live captions</td><td>Audio + transcripts</td><td>United States</td><td class="yes">BAA available</td></tr>
            <tr><td>Twilio</td><td>SMS Verify and Programmable SMS</td><td>Phone numbers, OTP codes</td><td>United States</td><td class="yes">BAA (HIPAA-eligible products)</td></tr>
            <tr><td>Postmark</td><td>Transactional email</td><td>Email addresses, message body</td><td>United States</td><td class="yes">BAA add-on</td></tr>
            <tr><td>Stripe + Stripe Connect</td><td>Payment processing and payouts</td><td>Payment tokens, bank info</td><td>United States</td><td class="yes">DPA</td></tr>
            <tr><td>track1099</td><td>1099-NEC and 1042-S issuance</td><td>TIN, payee info, payment totals</td><td>United States</td><td class="yes">DPA</td></tr>
            <tr><td>Plaid</td><td>ACH account verification</td><td>Bank account verification</td><td>United States</td><td class="yes">DPA</td></tr>
          </tbody>
        </table>
      </div>
      <p class="tag">Reviewed and updated """ + BUILD_DATE + """.</p>
    """
    pages.append(Page(
        path="legal/subprocessors.html",
        title="Subprocessor list — 1891 Interpreter",
        description="Every vendor we use, what they do, where they are, and BAA / DPA status.",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Legal", ""), ("Subprocessors", "")),
        body=legal_body("Subprocessor list", "Legal", sub_html),
    ))

    a11y_stmt_html = """
      <h2>Conformance target.</h2>
      <p>1891 Interpreter targets WCAG 2.2 Level AA across the public marketing site and the product. Section 508 conformance follows from WCAG conformance per the 2018 ICT Refresh.</p>

      <h2>How we maintain conformance.</h2>
      <p>Every release runs automated checks (axe-core), manual screen-reader testing (VoiceOver, NVDA, JAWS, TalkBack), and keyboard-only smoke tests. Releases block on regressions. The conformance log at <a href=\"""" + BASE_PATH + """/accessibility\">/accessibility</a> is updated per release.</p>

      <h2>How to report a barrier.</h2>
      <p>Email <a href=\"mailto:accessibility@madeby1891.com\">accessibility@madeby1891.com</a>. Reports go to a priority queue: response within 2 business days, target fix date within 5.</p>

      <h2>Formats and assistive tech.</h2>
      <p>The product works with current versions of major screen readers and browsers. We test against Safari + VoiceOver on macOS and iOS, Chrome + NVDA on Windows, Firefox + JAWS, and Chrome + TalkBack on Android. Older browsers may have degraded experience; we maintain a documented support matrix in the product help.</p>
    """
    pages.append(Page(
        path="legal/accessibility-statement.html",
        title="Accessibility statement — 1891 Interpreter",
        description="Our legal-form accessibility statement.",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Legal", ""), ("Accessibility statement", "")),
        body=legal_body("Accessibility statement", "Legal", a11y_stmt_html),
    ))

    rd_html = """
      <h2>Reporting a vulnerability.</h2>
      <p>If you discover a security issue in our platform, please email <a href=\"mailto:security@madeby1891.com\">security@madeby1891.com</a>. We acknowledge within 1 business day and provide a response within 5 business days.</p>

      <h2>Safe harbor.</h2>
      <p>We will not pursue legal action against researchers who:</p>
      <ul class="checks">
        <li>Test only on accounts you own, or accounts the agency has authorized for testing.</li>
        <li>Do not access, modify, or destroy data belonging to other customers.</li>
        <li>Do not perform denial-of-service testing against production.</li>
        <li>Do not disclose the issue publicly before we've had reasonable time to fix it (90 days is typical; we'll work with you if the issue is more complex).</li>
        <li>Make a good-faith effort to follow this policy.</li>
      </ul>

      <h2>What's in scope.</h2>
      <p>Any production system at <code>madeby1891.com/interpreter</code>, <code>1891interpreter.app</code> (when live), or any tenant subdomain.</p>

      <h2>What's out of scope.</h2>
      <ul class="checks">
        <li>Social engineering of our team or customers.</li>
        <li>Physical attacks.</li>
        <li>Spam, automated scans without prior coordination.</li>
        <li>Issues already publicly known or in active remediation (we'll tell you if you find one of these).</li>
      </ul>

      <h2>What we'll do.</h2>
      <p>Acknowledge within 1 business day. Triage within 5. Communicate the fix timeline. Credit you publicly (with your permission) when the issue is closed. We do not run a paid bug-bounty at this stage; we will offer a thank-you in writing and on the security page.</p>
    """
    pages.append(Page(
        path="legal/responsible-disclosure.html",
        title="Responsible disclosure — 1891 Interpreter",
        description="How to report a security issue, what we promise in return.",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Legal", ""), ("Responsible disclosure", "")),
        body=legal_body("Responsible disclosure", "Legal", rd_html),
    ))

    dmca_html = """
      <h2>Notice of claimed infringement.</h2>
      <p>If you believe content hosted on 1891 Interpreter infringes a copyright you own or are authorized to act for, please send a written notice to our designated agent.</p>

      <h2>Designated agent.</h2>
      <p>1891 LLC · Frederick, Maryland<br>Email: <a href=\"mailto:legal@madeby1891.com\">legal@madeby1891.com</a></p>

      <h2>What to include.</h2>
      <ol class="stack-3" style="padding-left:1.2em">
        <li>Physical or electronic signature of the rights holder or authorized agent.</li>
        <li>Identification of the copyrighted work claimed to have been infringed.</li>
        <li>Identification of the allegedly infringing material and information reasonably sufficient to permit us to locate it.</li>
        <li>Your contact information.</li>
        <li>A statement that you have a good-faith belief that use of the material is not authorized.</li>
        <li>A statement, under penalty of perjury, that the information is accurate and you are authorized to act.</li>
      </ol>

      <h2>Counter-notice.</h2>
      <p>If your content was removed and you believe in good faith it was misidentified, you may submit a counter-notice with the same information plus a statement consenting to jurisdiction in Maryland.</p>
    """
    pages.append(Page(
        path="legal/dmca.html",
        title="DMCA — 1891 Interpreter",
        description="DMCA notice procedure.",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Legal", ""), ("DMCA", "")),
        body=legal_body("DMCA notice procedure", "Legal", dmca_html),
    ))

    # Deaf-owned standard mirror page
    standard_html = """
      <p>This is the public, human-readable mirror of the verification standard. A PDF copy for legal teams is provided on request.</p>

      <h2>The definition.</h2>
      <p>A Deaf-owned agency, for purposes of the Free Forever tier, is an agency where a Deaf, DeafBlind, or hard-of-hearing person — or a group of such persons — holds more than 50% of ownership interest and exercises operational control.</p>

      <h2>Documentation we accept.</h2>
      <ul class="checks">
        <li>State Deaf-owned business certification (where the state offers one).</li>
        <li>SBA self-certification for a Deaf-owned small business.</li>
        <li>NAD agency-member designation (where applicable to the agency's classification).</li>
        <li>A sworn attestation by the owner — used where no state pathway exists. One page, plain English.</li>
      </ul>

      <h2>The board.</h2>
      <p>Fallon Brizendine (CDI, MA Interpretation, Gallaudet) plus two community advisors rotating annually. The community advisors are drawn from a pool with explicit standing in the Deaf agency-owner community. The board reviews every application within 5 business days. All denials are reviewed by the full board, not a single reviewer.</p>

      <h2>Edge cases.</h2>
      <p>See <a href=\"""" + BASE_PATH + """/free-for-deaf-owned\">/free-for-deaf-owned</a> for the public edge-case table covering CODA-owned agencies, mixed-ownership at 51%, Deaf-led nonprofits, hearing-allied agencies, and ownership-vs-operational-control situations.</p>

      <h2>Recertification.</h2>
      <p>Annual, light. Once a year we email: 'still owned by the same person/people? Reply yes.' Documentation is not required again unless ownership changed.</p>

      <h2>The line we want on the record.</h2>
      <div class="pull-quote">We will get this wrong sometimes. When we do, the board reconsiders. The badge means something because we hold it to a standard, and the standard exists because the community asked for one.</div>
    """
    pages.append(Page(
        path="legal/deaf-owned-verification-standard.html",
        title="Deaf-owned verification standard — 1891 Interpreter",
        description="Public mirror of the standard the verification board applies.",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Legal", ""), ("Deaf-owned standard", "")),
        body=legal_body("Deaf-owned verification standard", "Legal", standard_html),
    ))

    # 404
    pages.append(Page(
        path="404.html",
        title="Not found — 1891 Interpreter",
        description="The page you're looking for doesn't exist here.",
        body=fourohfour_body(),
        extra_head='\n<meta name="robots" content="noindex">',
    ))

    return pages


# -----------------------------------------------------------------------------
# Render + sitemap
# -----------------------------------------------------------------------------

def render(page: Page) -> str:
    canonical_root = CANONICAL_BASE
    head = HEAD_TPL.format(
        title=page.title,
        description=page.description,
        canonical=page.canonical(),
        canonical_root=canonical_root,
        og_title=(page.og_title or page.title),
        base=BASE_PATH,
        extra_head=page.extra_head,
        event_tags=EVENT_TAGS,
        asset_v=ASSET_V,
    )
    return head + header_html(page.nav_active) + page.breadcrumb_html + f'<main id="main">\n{page.body}\n</main>\n' + FOOTER


def write_pages(pages: list[Page]) -> list[Path]:
    written: list[Path] = []
    for page in pages:
        out = SITE / page.path
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(render(page), encoding="utf-8")
        written.append(out)
    return written


def write_sitemap(pages: list[Page]) -> Path:
    urls = []
    for page in pages:
        if page.path == "404.html":
            continue
        # 1891 convention: clean URLs everywhere — no .html in sitemap.
        # canonical() handles the path-to-URL conversion (including index → /).
        urls.append(page.canonical())
    today = datetime.now().strftime("%Y-%m-%d")
    body = ['<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        body.append(f"  <url><loc>{u}</loc><lastmod>{today}</lastmod></url>")
    body.append("</urlset>")
    out = SITE / "sitemap.xml"
    out.write_text("\n".join(body) + "\n", encoding="utf-8")
    return out


def write_robots() -> Path:
    body = f"""User-agent: *
Allow: /

Sitemap: {CANONICAL_BASE}/sitemap.xml
"""
    out = SITE / "robots.txt"
    out.write_text(body, encoding="utf-8")
    return out


def main() -> None:
    pages = build_pages()
    written = write_pages(pages)
    sm = write_sitemap(pages)
    rb = write_robots()
    print(f"Wrote {len(written)} pages.")
    for p in written:
        print(f"  {p.relative_to(ROOT)}")
    print(f"Wrote {sm.relative_to(ROOT)}")
    print(f"Wrote {rb.relative_to(ROOT)}")
    emit_release_json("interpreter", SITE, repo_root=ROOT)


if __name__ == "__main__":
    main()
