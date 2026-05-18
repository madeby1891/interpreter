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
<link rel="stylesheet" href="{base}/assets/css/site.css">
<link rel="stylesheet" href="{base}/assets/css/marketing-interact.css">
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
<script src="{BASE_PATH}/assets/js/main.js" defer></script>
<script src="{BASE_PATH}/assets/js/marketing-interact.js" defer></script>
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
            <div>Universal design as default — not a v2 patch.</div>
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
          <p>The co-founders are a fifth-generation-Deaf builder and a certified Deaf interpreter who chaired an interpreting program — not consultants who took a workshop.</p>
          <p><a href="{BASE_PATH}/about">Meet Anthony and Fallon →</a></p>
        </div>
        <div class="pillar" data-reveal data-delay="100">
          <span class="pillar-num" aria-hidden="true">2</span>
          <h3>Universal design as default</h3>
          <p>Every screen ships keyboard-navigable, screen-reader-tested, captioned, and high-contrast on day one. Public VPAT updated every release.</p>
          <p><a href="{BASE_PATH}/accessibility">Read the conformance log →</a></p>
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
        <p class="lede" data-reveal data-delay="100" style="margin:0 auto">Each of these is real, shipped behavior. Mess with them.</p>
      </div>
      <div class="widget-showcase" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--1891int-s-6)">
        <div data-reveal>
          <span class="eyebrow">One client, every department</span>
          <h3 style="margin-top:6px">Frederick Health → 4 departments → 6 locations → one billing office.</h3>
          <p class="ink-soft">Click the client. The whole hierarchy unfolds. Invoices roll up however the client wants — by location, by specialist, or one consolidated statement per month.</p>
          <div class="widget" data-widget="clients"></div>
        </div>
        <div data-reveal data-delay="100">
          <span class="eyebrow">Bill side / pay side, live</span>
          <h3 style="margin-top:6px">Pick a job. See what the client pays and what the interpreter earns — instantly.</h3>
          <p class="ink-soft">Modifiers stack: evening +15%, weekend +25%, last-minute +25%. Interpreter pay-rate floors override the formula when their floor is higher.</p>
          <div class="widget" data-widget="rates"></div>
        </div>
        <div data-reveal data-delay="200">
          <span class="eyebrow">Cancellation tiers, no hidden math</span>
          <h3 style="margin-top:6px">Slide the clock. See what the client pays + what the interpreter still earns.</h3>
          <p class="ink-soft">≥48h: 0/0. 24-48h: 50/25. 12-24h: 100/50. &lt;12h: 100/100. The scheduler sees the same preview before they confirm a cancellation.</p>
          <div class="widget" data-widget="cancel"></div>
        </div>
        <div data-reveal data-delay="300">
          <span class="eyebrow">YES claims. NO declines.</span>
          <h3 style="margin-top:6px">Interpreters can accept an offer by text. Try it.</h3>
          <p class="ink-soft">Twilio webhook with signature verification. Idempotent on the message SID. STOP unsubscribes (TCPA-clean). PII never appears in the reply.</p>
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
            <li><strong>Live captions from speech</strong> — vendor-abstracted at the Worker boundary so we can swap providers without touching your workflow.</li>
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
            <tr><td>Accessibility commitment</td><td class="own">Public VPAT, WCAG 2.2 AA log per release</td><td>Per public materials</td><td>None (depends on your build)</td></tr>
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
          <h2>HIPAA-defensible by default.</h2>
          <p class="lede" style="color:#DCE9E7">PHI is redacted before it ever reaches an AI model. Every PHI read writes to an append-only audit log. BAA included on every paid tier and on the Deaf-owned tier.</p>
          <ul class="xs" style="margin-top:var(--1891int-s-4)">
            <li style="color:#DCE9E7">Encrypted at rest and in transit; tenant-isolated keys.</li>
            <li style="color:#DCE9E7">Maryland two-party-consent rules baked into the audio-capture path.</li>
            <li style="color:#DCE9E7">7-year audit log with hash-chain integrity.</li>
            <li style="color:#DCE9E7">Subprocessor list public; BAA on request, executed in days, not weeks.</li>
          </ul>
          <p style="margin-top:var(--1891int-s-5)"><a class="btn btn-secondary" style="border-color:#fff;color:#fff" href="{BASE_PATH}/security">Read the security posture</a></p>
        </div>
        <div>
          <div class="card" style="background:var(--1891int-river-deep); border-color:var(--1891int-river-soft); color:var(--1891int-paper)">
            <h3 style="color:var(--1891int-paper)" class="mt-0">What never reaches Claude or DeepL raw</h3>
            <ul class="xs" style="margin:0">
              <li style="color:#DCE9E7">Consumer names — redacted to initials before any model call.</li>
              <li style="color:#DCE9E7">Free-text clinical notes — scrubbed by regex + NER.</li>
              <li style="color:#DCE9E7">Phone numbers, MRNs, DOBs — token-replaced for the model, hydrated client-side after.</li>
              <li style="color:#DCE9E7">Executive-session and paused-mic portions of any meeting.</li>
            </ul>
            <p class="tag" style="color:#88B0AE; margin-top:var(--1891int-s-4)">Documented in detail at /security and /legal/baa.</p>
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
        <a class="btn btn-primary btn-lg" href="{BASE_PATH}/get-a-demo">Get a demo</a>
        <a class="btn btn-secondary btn-lg" href="{BASE_PATH}/free-for-deaf-owned">Start free if Deaf-owned</a>
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
      <p class="lede">Flat per agency, no per-seat tax, no per-job fee. Real Client → Requestor → Location → Specialist hierarchy. Hash-chained audit log. Roster, clients, invoices, and audit log export to CSV or JSON in one click.</p>
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
            <li>No per-job fee. Not a percentage, not a flat. You book a job, you don't pay us for that job.</li>
            <li>No per-call/per-minute fee on VRI or OPI. Call infrastructure is passed through at vendor cost and itemized.</li>
            <li>No payment-processing skim. Stripe fees are passed through at Stripe's published rate. We don't add bps.</li>
          </ul>
          <p style="margin-top:var(--1891int-s-5)"><a class="btn btn-ghost" href="{BASE_PATH}/pricing">See all tiers</a></p>
        </div>
        <div class="card card-warm" id="calculator">
          <span class="badge">Quick math</span>
          <h3 class="mt-0" style="margin-top:var(--1891int-s-3)">If you have…</h3>
          <ul class="xs">
            <li><strong>1–5 interpreters</strong> — Solo ($9/mo) or Practice ($249/mo) once you hire a scheduler.</li>
            <li><strong>6–25 interpreters</strong> — Practice tier. $249/mo flat, no surprises.</li>
            <li><strong>26–100 interpreters</strong> — Studio tier. $749/mo with SSO + custom domain.</li>
            <li><strong>100+ interpreters, multi-state</strong> — Network tier. From $2,400/mo with white-label, SIEM export, dedicated SLA.</li>
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
          <p class="ink-soft">Every entity — interpreters, requestors, consumers, jobs, invoices, payouts, rate cards — exports to both formats. Schema-stable across releases; we publish a changelog when we add columns.</p>
        </div>
        <div class="card">
          <h3 class="mt-0">No data ransom</h3>
          <p class="ink-soft">Cancel today and your full export waits in your inbox before the trial expires. We don't hold roster data hostage to force a contract renewal.</p>
        </div>
        <div class="card">
          <h3 class="mt-0">Plaintext audit log</h3>
          <p class="ink-soft">Your audit log exports too. Every PHI read, every assignment, every refund, with timestamps and the acting user. Hash-chained for integrity.</p>
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
            <li>ASL and other signed languages. CDI + voicer team configurations.</li>
            <li>Spoken languages — on-site, VRI, OPI.</li>
            <li>CART (NCRA-CRC) realtime captioning.</li>
            <li>Document translation with human-in-the-loop.</li>
            <li>Live captions from speech (Deepgram Nova-3 default; vendor-abstracted).</li>
          </ul>
        </div>
        <div>
          <h3>Billing</h3>
          <ul class="checks">
            <li>Per-hour, per-event, per-word — your rate cards.</li>
            <li>Net-30 invoicing with 5 consolidation modes (one_per_client / requestor / location / specialist / job).</li>
            <li>Monotonic invoice numbers per tenant per year — <code>INV-2026-0001</code>.</li>
            <li>1099-NEC issuance via track1099. Stripe Connect Express for payouts.</li>
            <li>GL coding to NetSuite, QuickBooks, Xero, Bill.com.</li>
            <li>Payout PDF with separate Labor and Expenses tables and subtotals.</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">Agency health dashboard</span>
      <h2>Roster, clients, jobs, and A/R — one screen.</h2>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">Live roster signal</h3><p class="ink-soft">Roster active, available right now, doc-compliant percent. Catch a lapsed cert or expiring W-9 before it costs you a fill.</p></div>
        <div class="card"><h3 class="mt-0">Operations metrics</h3><p class="ink-soft">Open jobs, fill rate, median time-to-fill, active clients, top clients by volume. Click any tile to drill in to the filtered dashboard.</p></div>
        <div class="card"><h3 class="mt-0">Money in flight</h3><p class="ink-soft">Outstanding A/R rolled up across all clients, aged. Outstanding payouts owed to your interpreters. The number you actually want to see Monday morning.</p></div>
      </div>
      <p class="tag" style="margin-top:var(--1891int-s-4)">Audit log viewer at <code>/app/admin/audit</code>: filter by date / user / action, export to CSV. Hash-chained for integrity.</p>
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


def for_schedulers_body() -> str:
    return f"""
  {audience_switch("schedulers")}
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">For schedulers</span>
      <h1>Six dashboards. One filter bar. Hit back, your filters survive.</h1>
      <p class="lede">Jobs, Interpreters, Clients, Requestors, Invoices, Payouts — same search box, same status chips, same sort. State lives in the URL, so back-button, share-link, and tab-restore all just work.</p>
      <div class="cluster" style="margin-top:var(--1891int-s-6)">
        <a class="btn btn-primary btn-lg" href="{BASE_PATH}/get-a-demo">Watch the day-of demo</a>
        <a class="btn btn-ghost btn-lg" href="{BASE_PATH}/features/scheduling">Feature detail</a>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-8); align-items:flex-start">
        <div>
          <h2>One board, every job in flight.</h2>
          <p class="ink-soft">Today's roster, today's jobs, today's exceptions — all in your viewport. Click a row to expand; press <kbd>/</kbd> to filter; press <kbd>j</kbd> and <kbd>k</kbd> to move through the queue. Multi-monitor: drag the day-of board to a second screen, keep job detail on the primary.</p>
          <ul class="checks">
            <li>Status-chip filters and search on every dashboard. Combine them; they survive a refresh.</li>
            <li>Sort by any column — last click wins, persisted in the URL.</li>
            <li>Inline edit on most fields without opening a modal.</li>
            <li>Audit-log viewer at <code>/app/admin/audit</code> with date / user / action filters and CSV export.</li>
          </ul>
        </div>
        <div class="card card-warm">
          <h3 class="mt-0">Plain-English conflict rules</h3>
          <p class="ink-soft">Every conflict rule has a one-sentence reason next to it, so you know why a warning fired — not just that it did.</p>
          <ul class="xs">
            <li><strong>No double-booking, ever.</strong> Hard block. Override requires explicit reason.</li>
            <li><strong>Back-to-back across counties.</strong> Soft warning with the drive-time estimate.</li>
            <li><strong>Skill mismatch.</strong> Warns when an interpreter's certs don't match what the venue requires.</li>
            <li><strong>Consumer-preference miss.</strong> Surfaces "this requestor has booked this interpreter 4× this quarter" before you send the offer.</li>
            <li><strong>Team mismatch.</strong> Flags a CDI assignment with no voicer attached.</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">Client hierarchy</span>
      <h2>One Client. Many Requestors. Many Locations. Many Specialists. One bill.</h2>
      <p class="lede">Frederick Health is one Client. Cardiology, ED, Peds, and Oncology are Requestors. Main Hospital, Urbana, Mt Airy, and Brunswick are Locations. The doctor on the chart is a Specialist. All roll to one billing office on one cycle — or split however the contract says.</p>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">Five consolidation modes</h3><p class="ink-soft"><code>one_per_client</code>, <code>one_per_requestor</code>, <code>one_per_location</code>, <code>one_per_specialist</code>, <code>one_per_job</code>. Set per client; mix on the same Net-30 cycle.</p></div>
        <div class="card"><h3 class="mt-0">Per-client document library</h3><p class="ink-soft">Contracts, BAAs, COIs, W-9s — uploaded once, surfaced on the Client view with expiry chips so nothing lapses on you.</p></div>
        <div class="card"><h3 class="mt-0">Invoice line detail</h3><p class="ink-soft">Each line shows location + specialist + consumer initials + interpreter name (whichever the client requires). Invoice numbers are monotonic per tenant per year — <code>INV-2026-0001</code>.</p></div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-8); align-items:flex-start">
        <div>
          <span class="eyebrow">Cancellation modal</span>
          <h2>Live tier preview before you confirm.</h2>
          <p class="ink-soft">The cancel button doesn't fire-and-pray. The modal previews the exact charge against the client and the exact payout to each interpreter, per your tier rules, before you click confirm. <em>"Cancel now bills $X and pays $Y per interpreter."</em></p>
        </div>
        <div>
          <span class="eyebrow">PII reveal-on-accept</span>
          <h2>Redacted offer. Full detail unlocks on claim.</h2>
          <p class="ink-soft">Interpreter browses the offer with consumer initials, generic venue, time, and rate. The moment they tap Accept, the full record opens — and the unlock is written to the audit log with their user ID and a timestamp.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="center-text" style="margin-bottom:var(--1891int-s-7)">
        <span class="eyebrow">Smart-fill</span>
        <h2>Ranked candidates with a score breakdown — never a black box.</h2>
        <p class="lede" style="margin:0 auto">Five factors: certification fit, location proximity, requestor preference, workload balance, prior performance with this consumer. Hover any score, see the math.</p>
      </div>
      <div class="grid grid-3">
        <div class="card">
          <h3 class="mt-0">Transparent weights</h3>
          <p class="ink-soft">Every weight is visible and tunable in <code>/app/settings</code>. Default weights are public.</p>
        </div>
        <div class="card">
          <h3 class="mt-0">Cascade pattern</h3>
          <p class="ink-soft">Parallel-3, first-claim-wins by default. Three top candidates get the offer simultaneously; whoever claims first locks the job.</p>
        </div>
        <div class="card">
          <h3 class="mt-0">Open marketplace</h3>
          <p class="ink-soft">If cascade exhausts, the job opens to any qualified interpreter in your roster. First-claim, written to the audit log.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <h2>Team invitations with a role-scoped allowlist.</h2>
      <p class="lede">Open <code>/app/settings/team</code> and invite. Managers can invite schedulers, interpreters, and client / requestor / billing contacts — but never other managers (only an owner does that). Invitation tokens live 7 days, then expire.</p>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">7-tier role hierarchy</h3><p class="ink-soft">platform_staff → owner → manager → scheduler, interpreter, client_contact, requestor_contact, billing_contact. The role on the invite scopes everything that user sees.</p></div>
        <div class="card"><h3 class="mt-0">Magic-link sign-in</h3><p class="ink-soft">No passwords. Click the email link, you're in. Sessions are agency-scoped; multi-agency users pick which tenant on landing.</p></div>
        <div class="card"><h3 class="mt-0">Agency health dashboard</h3><p class="ink-soft">Roster active, available right now, active clients, open jobs, fill rate, median time-to-fill, doc-compliant percent, top clients by volume, outstanding A/R rollup — one screen.</p></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <h2>Keyboard shortcuts we got right.</h2>
      <p class="lede">If you live on the board, your hands stay on the keys.</p>
      <div class="grid grid-3 mt-5">
        <div><h3>Navigation</h3><ul class="xs"><li><kbd>j</kbd> / <kbd>k</kbd> — next / previous job</li><li><kbd>/</kbd> — focus search</li><li><kbd>g</kbd> then <kbd>o</kbd> — go to open jobs</li><li><kbd>?</kbd> — show all shortcuts</li></ul></div>
        <div><h3>Actions</h3><ul class="xs"><li><kbd>a</kbd> — assign interpreter</li><li><kbd>r</kbd> — request replacement</li><li><kbd>c</kbd> — mark confirmed</li><li><kbd>x</kbd> — cancel job (asks for reason)</li></ul></div>
        <div><h3>Inspection</h3><ul class="xs"><li><kbd>e</kbd> — expand job detail</li><li><kbd>shift</kbd>+<kbd>e</kbd> — expand all today</li><li><kbd>?</kbd> over a score — explain the ranking</li><li><kbd>cmd</kbd>+<kbd>k</kbd> — command palette</li></ul></div>
      </div>
    </div>
  </section>

  {cta_band("See the board in motion.", "Watch the day-of demo", f"{BASE_PATH}/get-a-demo", "Feature detail", f"{BASE_PATH}/features/scheduling")}
"""


def for_interpreters_body() -> str:
    return f"""
  {audience_switch("interpreters")}
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">For interpreters</span>
      <h1>Two-tap claim. SMS YES/NO works too. See your pay before you accept.</h1>
      <p class="lede">Phone-friendly portal. Reply to a job offer by text if your hands are full. Close out with actual times, expenses, and receipts. Approved expenses roll into your next payout automatically.</p>
      <p class="ink-soft" style="margin-top:var(--1891int-s-3); font-size:15px"><strong>You're not the customer in the contract sense — agencies are.</strong> But you're the only reason the contract has any value, and the product treats you that way.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-8); align-items:center">
        <div>
          <h2>The phone app, in plain terms.</h2>
          <ul class="checks">
            <li><strong>Two-tap claim.</strong> Offer shows the rate, initials of the consumer, generic venue, team — full record unlocks the moment you accept.</li>
            <li><strong>SMS YES/NO works too.</strong> Reply <code>YES</code> to claim, <code>NO</code> to decline. Twilio inbound with signature verify; same audit trail as a tap.</li>
            <li><strong>See your pay before you accept.</strong> Hourly, per-event, mileage, premium pay — itemized. Pay-side floor is 60% of the client charge; you see both numbers when your agency turns that on.</li>
            <li><strong>Quiet by default.</strong> Per-event cadence per channel: immediate, daily 6am ET digest, weekly Monday 7am ET digest, or off. Email / SMS each independent. (Mobile push isn't shipped yet — email and SMS are.)</li>
            <li><strong>1099 year-to-date strip.</strong> Open the app, see your earnings in seconds. Multi-agency interpreters see each agency's slice.</li>
            <li><strong>Get paid on the day the agency promised.</strong> Stripe Connect Express by default; manual ACH fallback. 1099-NEC issued via track1099 each January.</li>
          </ul>
        </div>
        <div>
          <div class="card card-warm" style="max-width:340px; margin:0 auto; padding:var(--1891int-s-5)">
            <div style="background:var(--1891int-paper); border-radius:var(--1891int-radius-md); padding:var(--1891int-s-5); border:1px solid var(--1891int-line)">
              <div class="tag" style="color:var(--1891int-bloom-deep)">TODAY · 2:00 PM</div>
              <h3 class="mt-0" style="margin-top:6px; font-size:22px">Medical · ASL</h3>
              <p class="ink-soft" style="font-size:14.5px; margin-bottom:6px">Consumer: J.M. · 90 min<br>Frederick Health Hospital, Room 412</p>
              <div style="border-top:1px solid var(--1891int-line); margin:var(--1891int-s-4) 0; padding-top:var(--1891int-s-4)">
                <div style="display:flex;justify-content:space-between;font-size:15px"><span>Hourly</span><strong>$95/hr</strong></div>
                <div style="display:flex;justify-content:space-between;font-size:15px"><span>2-hr minimum</span><strong>$190</strong></div>
                <div style="display:flex;justify-content:space-between;font-size:15px"><span>Mileage (12 mi)</span><strong>$8.04</strong></div>
                <div style="display:flex;justify-content:space-between;font-size:17px;border-top:1px solid var(--1891int-line);padding-top:8px;margin-top:8px;font-weight:700"><span>You'll be paid</span><span style="color:var(--1891int-bloom-deep)">$198.04</span></div>
              </div>
              <button class="btn btn-primary" style="width:100%">Claim</button>
              <p class="tag" style="text-align:center;margin-top:var(--1891int-s-3)">Two taps. No surprises.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <span class="eyebrow">Close-out modal</span>
      <h2>Actual times, expenses, receipts — one screen.</h2>
      <p class="lede">After the job, open the close-out: enter actual start and end times, add any expense lines (mileage / parking / tolls / supplies / meal / other), attach a receipt if needed, leave a note.</p>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">Live divergence preview</h3><p class="ink-soft">If your actual time diverges from the scheduled time by 25% or more, the modal flags it so you can add a sentence of context before submitting. The scheduler sees the same flag on their side.</p></div>
        <div class="card"><h3 class="mt-0">Receipts up to 8 MB</h3><p class="ink-soft">Image or PDF, attached to the expense line. Stored in Drive in v1 (works for low/medium scale; R2 migration is on the roadmap). The receipt is attached to the expense — not to the client.</p></div>
        <div class="card"><h3 class="mt-0">Approved expenses roll forward</h3><p class="ink-soft">Once the scheduler approves your expense lines, they roll into your next Payout PDF automatically — pay-side only. Expenses are <strong>never</strong> billed back to the client.</p></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">Payouts</span>
      <h2>Labor and Expenses, side by side, on every Payout PDF.</h2>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">Two tables, two subtotals</h3><p class="ink-soft">Labor lines (job, rate, hours) and Expense lines (category, receipt link) live in separate tables of the same PDF, each with its own subtotal. Grand total at the foot.</p></div>
        <div class="card"><h3 class="mt-0">Stripe Connect Express</h3><p class="ink-soft">Direct deposit to the bank account on your Stripe Connect profile. Backend works today; the fully self-serve onboarding UI isn't finished yet — we walk new payees through the setup.</p></div>
        <div class="card"><h3 class="mt-0">Aging visible to you</h3><p class="ink-soft">Open invoices the agency hasn't yet paid show their aging on your dashboard. No more guessing where your money is.</p></div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap-narrow">
      <h2>Fairness dashboard.</h2>
      <p class="lede">You see your own data — how often you've been offered jobs, claim rate, fill rate, average rating, rotation position. This is yours to read; we don't gate it.</p>
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
        <div class="card"><h3 class="mt-0">Reply to email</h3><p class="ink-soft">Replying to one of your agency's job confirmations with a new request kicks off an intake. The parser pulls language, date, location, and modality into a draft job. A scheduler reviews and confirms — usually within the hour during business hours.</p></div>
        <div class="card"><h3 class="mt-0">Short web form</h3><p class="ink-soft">Below. No login. No phone tree. The scheduler picks up the request and replies with options.</p></div>
        <div class="card"><h3 class="mt-0">Call the agency's number</h3><p class="ink-soft">Studio and Network agencies have a per-location phone number. Voicemail intake is parsed and routed; you get a confirmation back the same day. (Studio adds custom domain + SSO; Network adds white-label and SIEM.)</p></div>
      </div>
      <p class="tag" style="margin-top:var(--1891int-s-3)">Drafts are always reviewed by a human before they reach an interpreter. Auto-confirmation on clinical or legal work is hard-gated off.</p>
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
      <span class="eyebrow">For Billing, AP, and CFOs</span>
      <h1>Net-30. Five consolidation modes per client. GL-coded on day one.</h1>
      <p class="lede">PHI redacted from invoices by default. Each line shows location + specialist + consumer initials + interpreter name (whichever the client requires). Invoice numbers are monotonic per tenant per year (<code>INV-2026-0001</code>). Sample-invoice anatomy below — no real data, all the structure.</p>
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
          <h2>Five consolidation modes, set per client.</h2>
          <ul class="checks">
            <li><code>one_per_client</code> — one invoice covers everything for the calendar month.</li>
            <li><code>one_per_requestor</code> — one per department (Cardiology, ED, Peds, Oncology) on the same cycle.</li>
            <li><code>one_per_location</code> — one per site (Main Hospital, Urbana, Mt Airy, Brunswick).</li>
            <li><code>one_per_specialist</code> — one per doctor on the chart, when each provider gets billed separately.</li>
            <li><code>one_per_job</code> — one invoice per event (conferences, single-shot legal engagements).</li>
          </ul>
          <p class="ink-soft">Set the mode per client; mix freely on the same Net-30 cycle.</p>
        </div>
        <div>
          <h2>Exports + payouts.</h2>
          <ul class="checks">
            <li>QuickBooks Online — direct OAuth export.</li>
            <li>Xero — direct OAuth export.</li>
            <li>NetSuite — SuiteApp connector, custom field mapping.</li>
            <li>Bill.com — vendor-bill push.</li>
            <li>Plain CSV / JSON — for everything else.</li>
            <li>1099-NEC and 1042-S issuance via track1099.</li>
            <li>Payout PDF: separate Labor + Expenses tables with subtotals.</li>
            <li>Invoice numbers monotonic per tenant per year — <code>INV-2026-0001</code>.</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  {cta_band("Want a sample invoice + GL mapping?", "Get a demo", f"{BASE_PATH}/get-a-demo", "Read the BAA", f"{BASE_PATH}/legal/baa")}
"""


def pricing_body() -> str:
    tiers = [
        ("Deaf-Owned", "$0", "/mo", "Verified Deaf-owned agencies, any size.",
         ["Unlimited interpreters, jobs, requestors, storage",
          "AI intake at fair-use cap",
          "BAA included",
          "Full feature parity with paid tiers",
          "No time limit, no payment method"],
         "Apply for verification", "/free-for-deaf-owned", True),
        ("Solo", "$9", "/mo (annual)", "Individual freelance interpreters acting as their own agency.",
         ["1 user",
          "200 jobs/year",
          "1099 + invoicing",
          "Stripe Connect payouts",
          "BAA available on request"],
         "Get a demo", "/get-a-demo", False),
        ("Practice", "$249", "/mo (annual)", "Small agencies, up to 25 active interpreters.",
         ["Unlimited schedulers and requestors",
          "Standard AI intake",
          "BAA included",
          "Document translation",
          "CART scheduling",
          "QuickBooks / Xero export"],
         "Get a demo", "/get-a-demo", False),
        ("Studio", "$749", "/mo (annual)", "Mid agencies, up to 100 active interpreters.",
         ["Everything in Practice",
          "SSO / SAML",
          "Custom domain (yourname.1891interpreter.app)",
          "Per-location phone numbers",
          "Advanced reporting",
          "NetSuite + Bill.com connectors"],
         "Get a demo", "/get-a-demo", False),
        ("Network", "from $2,400", "/mo (annual)", "Large agencies (100+ interpreters), multi-state.",
         ["Everything in Studio",
          "White-label tenant",
          "SIEM export of audit log",
          "Dedicated SLA + named CSM",
          "Custom integrations",
          "Multi-region option"],
         "Talk to us", "/contact", False),
    ]
    tier_html = []
    for name, price, unit, sub, features, cta, href, featured in tiers:
        feat_class = "tier featured" if featured else "tier"
        lis = "".join(f"<li>{f}</li>" for f in features)
        tier_html.append(f"""
        <div class="{feat_class}">
          <h3>{name}</h3>
          <p class="ink-soft" style="font-size:14.5px; margin-bottom:0">{sub}</p>
          <div class="price">{price} <small>{unit}</small></div>
          <ul>{lis}</ul>
          <a class="btn {'btn-primary' if featured else 'btn-secondary'}" href="{BASE_PATH}{href}">{cta}</a>
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
          <p class="ink-soft">Where a 50-person agency that needs SSO and reporting lands. Still cheaper than per-seat at that headcount, with the features procurement actually asks for.</p>
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
        <div class="card"><h3 class="mt-0">No per-call fee</h3><p class="ink-soft">VRI and OPI call infrastructure is passed through at vendor cost (Twilio, etc.) and itemized.</p></div>
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
      <details class="card mt-3"><summary style="font-weight:700; cursor:pointer">Are there setup fees?</summary><p class="ink-soft" style="margin-top:var(--1891int-s-3)">No. Onboarding is white-glove for Phase 0 and Network customers, included in the subscription price. Self-serve for Solo and Practice.</p></details>
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
    feats = [
        ("scheduling.html",     "Scheduling",          "Six dashboards, one filter bar. URL-persisted state. Smart-fill with score breakdown. Cancellation modal with live tier preview."),
        ("interpreter-app.html","Interpreter app",     "Two-tap claim or SMS YES/NO. See-your-pay-first. Close-out modal with actual times, expenses, and receipts."),
        ("billing.html",        "Billing",             "Five consolidation modes per client. Monotonic invoice numbers. Payout PDF with Labor + Expenses tables. QuickBooks, Xero, NetSuite, Bill.com."),
        ("translation.html",    "Document translation","Human-in-the-loop. DeepL Pro where it supports the pair; Claude elsewhere. No pre-fill on medical or legal."),
        ("ai-intake.html",      "AI intake",           "Natural-language intake parses email/voicemail to a draft job — every parse reviewable, never auto-confirmed for clinical work. PHI redacted before any model call."),
        ("vri-opi.html",        "VRI &amp; OPI",       "Built-in WebRTC video client; OPI bridge via Twilio. Per-minute infrastructure passed through at vendor cost."),
        ("cart.html",           "CART",                "NCRA-CRC realtime captioning, in the same scheduling queue. Vendor-abstracted live-STT (Deepgram Nova-3 default)."),
        ("reporting.html",      "Reporting",           "Read-only natural-language reporting. Pre-built KPIs (fill rate, time-to-fill, A/R aging). Export to CSV, PDF, or the audit trail."),
        ("integrations.html",   "Integrations",        "QuickBooks, Xero, NetSuite, Bill.com, ADP, Gusto, Paychex, Rippling, track1099, Plaid, Stripe Connect, Postmark, Twilio."),
    ]
    # Strip trailing .html for clean URLs in nav cards.
    def _clean(slug: str) -> str:
        return slug[:-len(".html")] if slug.endswith(".html") else slug
    cards = "".join(f"""
        <a class="card card-hoverable" href="{BASE_PATH}/features/{_clean(p)}">
          <h3 class="mt-0">{t}</h3>
          <p class="ink-soft">{d}</p>
          <p class="text-bloom" style="font-weight:600">Read more →</p>
        </a>""" for p, t, d in feats)
    return f"""
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">Features</span>
      <h1>Every modality, every party, every billing model. One tool.</h1>
      <p class="lede">Nine feature areas, each with a one-screenshot summary and a "how it works" walkthrough. ASL videos coming online with the design-partner cohort in Phase 0.</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap">
      <div class="grid grid-3">{cards}</div>
    </div>
  </section>
  {cta_band("Try it in a demo.", "Get a demo", f"{BASE_PATH}/get-a-demo", "See pricing", f"{BASE_PATH}/pricing")}
"""


def feature_page_body(slug: str, title: str, eyebrow: str, lede: str, sections: list[tuple[str, str]]) -> str:
    body = [f"""
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p class="lede">{lede}</p>
    </div>
  </section>
"""]
    for heading, content in sections:
        body.append(f"""
  <section class="section">
    <div class="wrap">
      <h2>{heading}</h2>
      {content}
    </div>
  </section>
""")
    body.append(cta_band(f"See {eyebrow.lower()} in motion.", "Get a demo", f"{BASE_PATH}/get-a-demo", "Back to all features", f"{BASE_PATH}/features/"))
    return "".join(body)


def about_body() -> str:
    return f"""
  <section class="feature-hero">
    <div class="wrap">
      <span class="eyebrow">About</span>
      <h1>Built by the people who use it. Run by the people who built it.</h1>
      <p class="lede">Two co-founders. A community advisory board. A small remote team that's growing on purpose, slowly.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="grid grid-2" style="gap:var(--1891int-s-8); align-items:flex-start">
        <div class="card">
          <span class="eyebrow">Co-founder · CEO</span>
          <h2 class="mt-0">Anthony Mowl</h2>
          <p class="ink-soft">Fifth-generation Deaf since 1891. Operator and builder; ships software with AI agents daily. Frederick, MD. The "1891" in the name is his family's continuous Deaf lineage. The brand voice is his: plain-spoken builder, no buzzwords, visible diffs.</p>
          <p><a href="mailto:hello@madeby1891.com">hello@madeby1891.com</a> · <a href="https://madeby1891.com/">madeby1891.com</a></p>
        </div>
        <div class="card">
          <span class="eyebrow">Co-founder · CDI &amp; head of community</span>
          <h2 class="mt-0">Fallon Brizendine</h2>
          <p class="ink-soft">Certified Deaf Interpreter. MA in Interpretation, Gallaudet. Former department chair of an ASL interpreting program. Fallon is the subject-matter authority on Sections B (stakeholders), C (modalities), and F (Deaf-owned verification) of the PRD; her standing in the community is the reason the verification board has any credibility.</p>
          <p><a href="mailto:hello@madeby1891.com">hello@madeby1891.com</a></p>
        </div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <span class="eyebrow">How we work</span>
      <h2>Small team. Visible diffs. Slow growth on purpose.</h2>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">Frederick, MD</h3><p class="ink-soft">Headquartered in Frederick. Remote-first. We hire across the US and into Canada in year 2.</p></div>
        <div class="card"><h3 class="mt-0">Open changelog</h3><p class="ink-soft">Every release shows up at <a href="{BASE_PATH}/changelog">/changelog</a>. We ship; it's visible.</p></div>
        <div class="card"><h3 class="mt-0">Open marketing site</h3><p class="ink-soft">This site is open source. Other Deaf-owned organizations can fork the verification-page template. Product itself stays private.</p></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap-narrow">
      <span class="eyebrow">Verification board</span>
      <h2>Fallon, plus two community advisors.</h2>
      <p>The board reviews every Deaf-owned application within 5 business days. The two community advisors rotate annually, drawn from a pool of advisors with explicit standing in the Deaf agency-owner community. We'll name them publicly once finalized. Until then, applications are received but decisions are paused.</p>
      <p class="muted" style="font-size:14.5px">Per PRD F4: all denials are reviewed by the full board, not a single reviewer.</p>
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
      <p>Build a tool that works for the people who do this work. Ship visible diffs. Pay interpreters on the day the agency promised. Keep the badge meaningful by keeping the standard real. Update the changelog every release. Answer email.</p>

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
      <h2>What never reaches Claude, DeepL, or any other model raw.</h2>
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
          <p class="ink-soft">Every model call begins with <code>tenant_id: &lt;id&gt;</code> in the system prompt. Anthropic prompt-caching keys on prefix, which means cache hits cannot cross tenant boundaries even if two prompts are otherwise identical.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <span class="eyebrow">The audit log</span>
      <h2>Append-only, hash-chained, exportable.</h2>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">Every PHI read</h3><p class="ink-soft">Every time someone — interpreter, scheduler, requestor — opens a record that contains PHI, an Audit_Log row is written: who, what, when, why.</p></div>
        <div class="card"><h3 class="mt-0">7-year retention</h3><p class="ink-soft">Audit log retained 7 years. Apps Script editor protections enforce append-only; deletes are physically blocked.</p></div>
        <div class="card"><h3 class="mt-0">Hash-chain integrity</h3><p class="ink-soft">Each row carries a SHA-256 of itself + the prior row. Any tampering breaks the chain and shows up on the next integrity check.</p></div>
        <div class="card"><h3 class="mt-0">SIEM export</h3><p class="ink-soft">Network tier exports the audit log to your SIEM (Splunk, Datadog, Elastic, custom). Format is documented and stable.</p></div>
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
        <li><strong>At rest (v1):</strong> Per-tenant Google Sheet ACLs plus initials-only mode for clinical fields. Sheets are protected and access-logged through Google Workspace; column-level AES is on the roadmap, not in v1.</li>
        <li><strong>In transit:</strong> TLS 1.3 everywhere. HSTS preload submitted; Strict-Transport-Security with includeSubDomains and preload directive.</li>
        <li><strong>Sheets-as-source-of-truth:</strong> Google Workspace BAA covers the per-agency Google Sheet. Each tenant Sheet has its own protected ranges and ACL.</li>
        <li><strong>Receipt storage:</strong> Drive-backed in v1 (works for low and medium scale). R2 with per-tenant prefixes is the planned migration; tracked publicly in the changelog.</li>
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
            <tr><td>Audit log</td><td>7 years</td><td>Append-only, hash-chained, archive after</td></tr>
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
        <div class="card"><h3 class="mt-0">Section 508 / WCAG 2.2 AA</h3><p class="ink-soft">Public <a href="{BASE_PATH}/accessibility">VPAT and conformance log</a> updated every release.</p></div>
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
      <h1>Universal design as default, not a v2 patch.</h1>
      <p class="lede">Every screen ships keyboard-navigable, screen-reader-tested, captioned, and high-contrast on day one. We publish the VPAT. We publish the conformance log. We publish the known issues with target fix dates.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <span class="eyebrow">Conformance</span>
      <h2>WCAG 2.2 AA across the product. Updated every release.</h2>
      <div class="grid grid-3 mt-5">
        <div class="card"><h3 class="mt-0">Keyboard</h3><p class="ink-soft">Every action reachable via keyboard. Focus is visible on every interactive element. Tab order matches reading order. No focus traps.</p></div>
        <div class="card"><h3 class="mt-0">Screen reader</h3><p class="ink-soft">VoiceOver, NVDA, JAWS, TalkBack tested every release. Live regions for dynamic content. ARIA used minimally and correctly.</p></div>
        <div class="card"><h3 class="mt-0">Contrast</h3><p class="ink-soft">Body text at AAA contrast. UI affordances at AA minimum. Color is never the only signal — every state change has color + icon + text.</p></div>
        <div class="card"><h3 class="mt-0">Captions</h3><p class="ink-soft">Default-on whenever audio plays. Every marketing video has English captions and ASL inset. Every product audio has captions in real time.</p></div>
        <div class="card"><h3 class="mt-0">ASL videos</h3><p class="ink-soft">Every marketing page that explains a concept has an ASL inset version. Glossary entries each have an ASL video by Fallon or a vetted contributor.</p></div>
        <div class="card"><h3 class="mt-0">Reduced motion</h3><p class="ink-soft">prefers-reduced-motion: reduce disables all transitions and motion. Tested in every release.</p></div>
      </div>
    </div>
  </section>

  <section class="section section-warm">
    <div class="wrap">
      <span class="eyebrow">Conformance log</span>
      <h2>What's tested, what's outstanding, when it's fixed.</h2>
      <div class="table-scroll">
        <table class="compare">
          <thead><tr><th>Release</th><th>Status</th><th>Notes</th></tr></thead>
          <tbody>
            <tr><td>2026-05-17 (this site)</td><td class="yes">WCAG 2.2 AA target</td><td>Static marketing site. No known blocking issues at launch. ASL inset videos added with Phase 0.</td></tr>
            <tr><td>Phase 0 design partners (Q3 2026)</td><td>Targeted</td><td>Full app: scheduler dashboard, interpreter app, billing screens. VPAT 1.0 published with this release.</td></tr>
            <tr><td>Public launch (Q4 2026)</td><td>Targeted</td><td>VPAT 2.0 with full coverage matrix.</td></tr>
          </tbody>
        </table>
      </div>
      <p class="muted" style="font-size:14px; margin-top:var(--1891int-s-4)">Found something not on the list? Email <a href="mailto:accessibility@madeby1891.com">accessibility@madeby1891.com</a> — it routes to a priority queue.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap-narrow">
      <span class="eyebrow">Accessibility statement</span>
      <h2>What we commit to.</h2>
      <ol class="stack-3" style="padding-left:1.2em">
        <li>Every screen ships WCAG 2.2 AA-conformant. We block releases on regressions.</li>
        <li>Every marketing page has ASL with English captions when it explains a product concept.</li>
        <li>Every accessibility issue reported via <a href="mailto:accessibility@madeby1891.com">accessibility@madeby1891.com</a> gets a response within 2 business days and a target fix date within 5.</li>
        <li>VPAT is public, on this page, updated every release. No "VPAT available on request" gatekeeping.</li>
        <li>Accessibility features are in every tier. Never paywalled.</li>
        <li>We don't auto-caption ASL. That's a research problem, not a product feature. We do auto-caption English speech with vendor-abstracted live STT.</li>
      </ol>
      <p style="margin-top:var(--1891int-s-5)"><a class="btn btn-primary" href="{BASE_PATH}/legal/accessibility-statement">Read the legal-form accessibility statement</a></p>
    </div>
  </section>
"""


def changelog_body() -> str:
    return f"""
  <section class="feature-hero">
    <div class="wrap-narrow">
      <span class="eyebrow">Changelog</span>
      <h1>What's new.</h1>
      <p class="lede">Every release shows up here. We ship; it's visible.</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap-narrow">
      <article class="card">
        <div class="tag" style="color:var(--1891int-bloom-deep)">{BUILD_DATE} · Marketing site v1</div>
        <h2 class="mt-0" style="margin-top:6px">Public marketing site live at madeby1891.com/interpreter.</h2>
        <ul class="checks">
          <li>Home, audience pages (agencies, schedulers, interpreters, requestors, payers), pricing, free-for-Deaf-owned, security, accessibility, about, our-1891.</li>
          <li>Nine feature pages.</li>
          <li>Legal cluster (privacy, terms, BAA, DPA, subprocessors, responsible disclosure, DMCA, accessibility statement).</li>
          <li>WCAG 2.2 AA target across the site at launch.</li>
        </ul>
        <p class="ink-soft">No product yet — the app itself begins onboarding with the Phase 0 design-partner cohort. This is the marketing presence and the verification surface.</p>
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
        description="Scheduling, interpreter app, billing, translation, and live captions in one tool. Six-dashboard board with URL-persisted filters. SMS YES/NO claim. Close-out modal with expenses. Five consolidation modes per client. Hash-chained audit log. Free forever for verified Deaf-owned agencies.",
        nav_active="",
        body=home_body(),
        og_title="1891 Interpreter — built by the community it serves",
    ))

    pages.append(Page(
        path="for-agencies.html",
        title="For agency owners — 1891 Interpreter",
        description="Flat per agency. No per-seat tax, no per-job fee. Real Client → Requestor → Location → Specialist hierarchy. Hash-chained audit log. Health dashboard at a glance. Export everything, one click.",
        nav_active="agencies",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("For agencies", "")),
        body=for_agencies_body(),
    ))
    pages.append(Page(
        path="for-schedulers.html",
        title="For schedulers — 1891 Interpreter",
        description="Six dashboards, one filter bar. Status-chip filters and URL-persisted state. Smart-fill with score breakdown. Cancellation modal with live tier preview. Audit log viewer at /app/admin/audit.",
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
        description="Net-30. Five consolidation modes per client. Monotonic invoice numbers (INV-2026-0001). Per-line location + specialist + interpreter detail. PHI redacted by default. QuickBooks, Xero, NetSuite, Bill.com.",
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

    feature_specs = [
        ("scheduling.html", "Scheduling", "Feature · Scheduling",
         "Six dashboards, one filter bar. URL-persisted state. Smart-fill with a five-factor score breakdown. Cancellation modal with live tier preview. Plain-English conflict rules.",
         [("Six dashboards, one filter bar", "<p>Jobs, Interpreters, Clients, Requestors, Invoices, Payouts — same search box, same status chips, same column sort. Combine filters; they live in the URL, so back-button, share-link, and tab-restore all just work. Keyboard-first navigation: <kbd>j</kbd>/<kbd>k</kbd>/<kbd>/</kbd>/<kbd>?</kbd>. Drag the board to a second monitor.</p>"),
          ("Smart-fill with transparent ranking", "<p>Five-factor weighted score: certification fit, location proximity, requestor preference, workload balance, prior performance with this consumer. Every weight is visible and tunable in <code>/app/settings</code>. Hover any score and see the components. No black box.</p>"),
          ("Cascade pattern", "<p>Parallel-3, first-claim-wins by default. Three top candidates get the offer simultaneously; whoever claims first locks the job. Configurable per agency.</p>"),
          ("Cancellation modal with tier preview", "<p>Before you confirm a cancel, the modal previews the exact charge against the client and the exact payout to each interpreter, per your tier rules. <em>\"Cancel now bills $X and pays $Y per interpreter.\"</em> No fire-and-pray.</p>"),
          ("PII reveal-on-accept", "<p>Interpreters see a redacted offer — consumer initials, generic venue, time, rate. The moment they accept, the full record opens and the unlock is written to the audit log with user ID and timestamp.</p>"),
          ("Conflict rules in plain English", "<p>Every rule has a one-sentence reason next to it. No double-booking, ever. Back-to-back across counties warns with the drive-time estimate. Skill mismatch flags missing certs. Consumer-preference miss surfaces prior bookings. CDI assignment without a voicer flags the gap.</p>")]),

        ("interpreter-app.html", "Interpreter app", "Feature · Interpreter app",
         "Phone-friendly portal. Two-tap claim, or reply SMS YES/NO. See your pay first. Close out with actual times, expenses, and receipts.",
         [("Two-tap claim", "<p>Tap the offer. See the rate, the consumer's initials, the venue, the team. Tap 'Claim.' Done. Same flow for ASL, spoken-language, CART, and document-translation jobs.</p>"),
          ("SMS YES/NO", "<p>Reply <code>YES</code> to claim, <code>NO</code> to decline. Twilio inbound with signature verify; same audit trail as a tap. Useful when your hands are full or you're between assignments.</p>"),
          ("See-your-pay-first", "<p>Hourly, per-event, mileage, premium pay — itemized before you accept. Pay-side floor is 60% of the client charge when your agency enables transparency; you see both numbers.</p>"),
          ("Close-out modal", "<p>After the job: actual start and end times, expense lines (mileage / parking / tolls / supplies / meal / other), optional receipt upload (≤ 8 MB image or PDF), notes. Live divergence preview warns at ≥ 25% from scheduled. Approved expenses roll into the next Payout PDF automatically.</p>"),
          ("Quiet by default", "<p>Per-event cadence per channel: immediate, daily 6am ET digest, weekly Monday 7am ET digest, or off. Email and SMS each independent. Mobile push isn't shipped yet — email and SMS are.</p>"),
          ("1099 strip", "<p>Year-to-date 1099 totals visible in the app. 1099-NEC issued each January via track1099. Multi-agency interpreters see each agency's slice.</p>")]),

        ("billing.html", "Billing", "Feature · Billing",
         "Rate cards. Five consolidation modes. Monotonic invoice numbers. Payout PDFs with separate Labor + Expenses tables. PHI redacted by default.",
         [("Rate cards", "<p>Each agency configures rate cards by setting (medical, legal, K-12, conference) × modality (ASL, Spanish, etc.) × team config (solo, CDI+voicer, relief). Rate cards are versioned; old invoices retain the rate card that priced them.</p>"),
          ("Five consolidation modes", "<p>Per client: <code>one_per_client</code>, <code>one_per_requestor</code>, <code>one_per_location</code>, <code>one_per_specialist</code>, <code>one_per_job</code>. Mix freely on the same Net-30 cycle. Sample-invoice anatomy is on the <a href=\"" + BASE_PATH + "/for-payers\">Billing & AP page</a>.</p>"),
          ("Invoice numbering", "<p>Monotonic per tenant per year — <code>INV-2026-0001</code>, <code>INV-2026-0002</code>, never skipping. AP teams that audit by sequence don't have to chase gaps.</p>"),
          ("Per-line detail", "<p>Each line shows location + specialist + consumer initials + interpreter name (whichever the client requires). PHI is redacted by default; consumer identifiers are opaque tokens unless the client contract requires otherwise.</p>"),
          ("Payouts", "<p>Stripe Connect Express for 1099 contractors. Payout PDF has separate Labor and Expenses tables with their own subtotals and a grand total. Self-serve onboarding UI isn't finished yet (backend works); new payees get walked through setup.</p>"),
          ("Tax + payroll", "<p>W-2 hours export to ADP, Gusto, Paychex, Rippling. 1099-NEC and 1042-S issuance via track1099.</p>")]),

        ("translation.html", "Document translation", "Feature · Document translation",
         "Human-in-the-loop. Translation memory. No pre-fill on medical or legal without review.",
         [("Workflow", "<p>Customer uploads source document. Translator (in your roster or open marketplace) claims the job. Machine-translation pre-fill is available for general documents using DeepL Pro where the language pair is supported, Claude elsewhere. Pre-fill is <strong>hard-gated off</strong> for medical consent forms, legal contracts, court filings, and educational IEPs.</p>"),
          ("Translation memory", "<p>Per-tenant translation memory accumulates over time. Repeat strings auto-suggest from prior approved translations. TM is tenant-isolated; we never cross TMs across customers.</p>"),
          ("Deliverables", "<p>PDF, Word, or HTML output, preserving source formatting where possible. Sworn translations (where required) include the translator's certification and signature page.</p>")]),

        ("ai-intake.html", "AI intake", "Feature · AI intake",
         "Natural-language intake parses email, voicemail, and forms into a draft job. Every parse reviewable. PHI redacted before the model sees it.",
         [("How it works", "<p>Requestor sends an email or leaves a voicemail. The intake parser extracts: language, date, time, duration, location, modality, special requirements. Output is a <em>draft</em> job, never auto-confirmed for clinical or legal work. A scheduler reviews and accepts.</p>"),
          ("PHI never reaches the model raw", "<p>Email subject and body are redacted by <code>lib/redact.ts</code> before any model call. Names → initials. Phone, MRN, DOB → tokens. Free-text clinical detail is scrubbed by regex + NER. The model sees a structured projection only. Every call writes an AI_Audit row with input and output hashes.</p>"),
          ("Reviewable, never auto-confirmed", "<p>Voicemail intake always routes to a scheduler for review. The parser's confidence is visible per field; low-confidence fields are highlighted in the scheduler's UI.</p>"),
          ("Honest about state", "<p>The intake state machine and review surfaces are in production. Some downstream AI-assist calls (translation review, term polish) are wired but the model calls themselves may be stubbed in v1 — they return a fixed structure so the workflow tests end-to-end. We'll mark those clearly in the changelog as they land.</p>")]),

        ("vri-opi.html", "VRI &amp; OPI", "Feature · VRI &amp; OPI",
         "Video Remote Interpreting and Over-the-Phone Interpreting. Built-in WebRTC video client; OPI bridge via Twilio.",
         [("VRI", "<p>WebRTC video client with captions, interpreter switching, and a 'tap to bring on a CDI' team flow. Records on consent only. Records to the audit log always. Fallover-retainer pay for interpreters when calls fail through no fault of theirs (per PRD C10 #9).</p>"),
          ("OPI", "<p>Per PRD A9 #12, OPI is deferred in v1 to a documented bridge: Twilio-based, behind the same scheduling queue. Per-minute call infrastructure is passed through at vendor cost, itemized on the invoice.</p>"),
          ("Not VRS", "<p>We do VRI, not VRS. VRS (Video Relay Service) is a federally-funded Deaf-to-hearing phone relay regulated by the FCC. We are not a VRS provider — that's a different regulated business.</p>")]),

        ("cart.html", "CART", "Feature · CART",
         "NCRA-CRC realtime captioning, in the same scheduling queue. Vendor-abstracted live-STT integration.",
         [("CRC integration", "<p>NCRA-CRC realtime captioning jobs schedule alongside ASL and spoken-language jobs. Same rate cards, same payouts, same invoicing.</p>"),
          ("Live STT for everything else", "<p>For sessions where a CRC isn't booked but live captions are needed (meetings, training, internal events), the platform calls a streaming STT vendor through the <code>StreamingStt</code> interface — Deepgram Nova-3 by default, AssemblyAI or Cloudflare Whisper as alternates. Vendor-abstracted at the Worker boundary; you can swap vendors without touching workflows.</p>"),
          ("Consent and retention", "<p>Two-party consent baked in. RECORDING indicator on every shared screen. PAUSE for executive session. Raw audio 30 days, transcripts 1 year, approved minutes permanent. See the <a href=\"" + BASE_PATH + "/security\">security page</a> for the full table.</p>")]),

        ("reporting.html", "Reporting", "Feature · Reporting",
         "Read-only natural-language reporting DSL. Pre-built KPIs. Export to CSV, PDF, or the audit trail.",
         [("Pre-built KPIs", "<p>Fill rate, time-to-fill, cancellation rate, interpreter rotation, requestor satisfaction, revenue per modality, average days outstanding, 1099 vs W-2 hours mix. All exportable.</p>"),
          ("Natural-language reporting (read-only)", "<p>Ask: 'How many ASL medical jobs did we cancel late last month, and which interpreters were on them?' Get a structured answer with a SQL-style trace. Per PRD D7 #10, NL reporting is read-only — no writes via natural language.</p>"),
          ("Custom dashboards", "<p>Build dashboards from saved queries. Pin to your home view. Schedule a weekly email digest (or skip — most people don't want one).</p>")]),

        ("integrations.html", "Integrations", "Feature · Integrations",
         "Accounting, payroll, payouts, comms, identity. All standard, all documented.",
         [("Accounting", "<p>QuickBooks Online, Xero, NetSuite, Bill.com. Direct OAuth where possible; CSV/JSON for the rest.</p>"),
          ("Payroll &amp; tax", "<p>ADP, Gusto, Paychex, Rippling for W-2 hours. track1099 for 1099-NEC and 1042-S. Plaid for ACH verification.</p>"),
          ("Payouts", "<p>Stripe Connect Express (default). Manual ACH fallback for long-tenured interpreters who decline Connect onboarding.</p>"),
          ("Comms", "<p>Postmark for transactional email (BAA). Twilio Verify and Programmable SMS (HIPAA-eligible products only).</p>"),
          ("Identity", "<p>SSO via SAML on Studio and Network. WebAuthn passkeys available on every tier; required on Pro and above per PRD A9 #10.</p>")]),
    ]
    for slug, label, eyebrow, lede, sections in feature_specs:
        pages.append(Page(
            path=f"features/{slug}",
            title=f"{label} — 1891 Interpreter",
            description=lede,
            nav_active="features",
            breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Features", f"{BASE_PATH}/features/"), (label, "")),
            body=feature_page_body(slug, label, eyebrow, lede, sections),
        ))

    pages.append(Page(
        path="security.html",
        title="Security &amp; compliance — 1891 Interpreter",
        description="HIPAA-defensible by default. PHI redacted before any AI call. SHA-256 hash-chained audit log with 7-year retention. 7-tier role hierarchy, magic-link sign-in, 7-day invitation TTL. Maryland two-party consent baked in. BAA on every paid tier and the Deaf-owned tier.",
        nav_active="security",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Security", "")),
        body=security_body(),
    ))
    pages.append(Page(
        path="accessibility.html",
        title="Accessibility — 1891 Interpreter",
        description="WCAG 2.2 AA across the product. Public VPAT updated every release. ASL videos. Keyboard-navigable everywhere.",
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
        body=stub_body("Blog", "Writing from the team.", "First posts arrive in June 2026 — including 'How a Deaf-owned interpreting agency operates' (Fallon) and 'The math on per-seat platforms vs flat-fee' (Anthony)."),
    ))
    pages.append(Page(
        path="case-studies/index.html",
        title="Case studies — 1891 Interpreter",
        description="Customer stories from agencies using 1891 Interpreter.",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Case studies", "")),
        body=stub_body("Case studies", "Customer stories.", "Our first case study lands at the end of the Phase 0 design-partner program (Q3 2026). We won't publish stories without signed permission."),
    ))
    pages.append(Page(
        path="customers/index.html",
        title="Customers — 1891 Interpreter",
        description="The agencies running on 1891 Interpreter (logos with signed permission only).",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Customers", "")),
        body=stub_body("Customers", "This page launches empty, and stays empty until permission is signed.",
                       "Per PRD F10 #7: an empty page is more honest than a fuzzy-logo page. Case studies launch first; logos follow with written permission from each agency."),
    ))
    pages.append(Page(
        path="resources/index.html",
        title="Resources — 1891 Interpreter",
        description="Guides, glossaries, and templates from 1891 Interpreter.",
        breadcrumb_html=breadcrumb(("Home", f"{BASE_PATH}/"), ("Resources", "")),
        body=stub_body("Resources", "Guides, glossaries, templates.", "The glossary is the long-tail SEO play — fifty entries by month six, each with an ASL video and a Spanish translation. First batch lands with Phase 1."),
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
      <p>We use subprocessors who have their own BAAs (Google Workspace, Cloudflare Enterprise, Anthropic, Twilio, Postmark). Full list and BAA status at <a href=\"""" + BASE_PATH + """/legal/subprocessors\">/legal/subprocessors</a>.</p>

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


if __name__ == "__main__":
    main()
