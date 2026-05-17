# Section F — Marketing Site, Pricing, and Go-to-Market

*1891 Interpreter — Master PRD, Section F*
*Author: Anthony Mowl, with Fallon Brizendine (CDI, MA Interpretation, Gallaudet)*

---

## F1. Positioning + messaging hierarchy

### F1.1 The one-line description

> **The interpreting agency platform built by the community it serves — free, forever, for Deaf-owned agencies.**

That's the hero. It does three things at once: names what the product is (an agency platform, not a marketplace, not a directory), establishes who built it (community, not outsiders), and tells the most distinctive policy commitment up front (free for Deaf-owned, no asterisk). It doesn't say "AI." It doesn't say "revolutionary." It doesn't say "platform that empowers." It says what it is.

The supporting deck under the hero, one line each:

> Scheduling. Interpreter app. Billing. Translation. Live captions. One tool.
> Spoken languages and signed languages, same tool, same price.
> Built in Frederick. Carried forward since 1891.

### F1.2 The three pillars

**1. Built by the community it serves**
*One sentence:* The co-founders are a fifth-generation-Deaf builder and a certified Deaf interpreter who chaired an interpreting program — not consultants who took a workshop.
*Proof:* Fallon Brizendine, CDI, MA Interpretation (Gallaudet), former dept chair of an ASL interpreting program. Anthony Mowl, fifth-generation Deaf since 1891. Both names on the about page. Both reachable.

**2. Universal design as default**
*One sentence:* Every screen ships keyboard-navigable, screen-reader-tested, captioned, and high-contrast on day one — not as a v2 patch.
*Proof:* Public VPAT updated every release. Live WCAG 2.2 AA conformance log at `/accessibility`. Captions default-on whenever audio plays. ASL explainer videos on every marketing page.

**3. Free forever for Deaf-owned agencies**
*One sentence:* If your agency is verified Deaf-owned, you pay nothing — full features, unlimited interpreters, unlimited jobs, BAA included, no time limit.
*Proof:* The policy itself is the proof, and the verification process is documented publicly at `/free-for-deaf-owned`. Reviewed by a board that includes Fallon and two community advisors.

A fourth pillar sits behind the three above and shows up in the comparison table rather than the hero: **One platform, every modality.** ASL, ProTactile, Spanish, Mandarin, CART, document translation — same scheduler, same invoice, same interpreter app. Competitors split signed and spoken language platforms or charge separately for them. We don't.

### F1.3 Anti-claims

The marketing site does not use any of these phrases. If a draft includes one, it gets rewritten before it ships.

- "AI-powered" — we use AI for intake parsing and minutes drafting; we don't sell AI. AI is a tool inside the product, not the product.
- "Revolutionary," "revolutionizing," "disrupting" — this industry doesn't need a disruption; it needs a tool that works.
- "Cutting-edge" — vague and dated the moment it ships.
- "Enterprise-grade" — agency owners hear "enterprise" and translate it to "expensive and slow to support a 6-person shop." We say agency-grade.
- "Empowering" / "empowerment" — saviorism flag. Deaf people aren't waiting for a hearing-led tech company to empower them.
- "Cutting through the noise" — there is no noise; there are working professionals doing real work.
- "Best-in-class" — meaningless. Show the comparison table instead.
- "Accessibility solution" — accessibility isn't a solution, it's a baseline. The product is an agency platform that happens to be accessible by default.
- "Underserved community" — the community is not underserved; existing vendors have under-served it. Different sentence, different responsibility.

### F1.4 Audience-specific messaging

**Agency owners (the economic buyer).** Lead with math and control. *"Fewer schedulers per filled job. No per-seat tax. Your interpreter roster and your client list belong to you — export them any day, in CSV or JSON, with one click."* The owner page (`/for-agencies`) is the only page where pricing math gets numerical above the fold. Show the per-job-cost comparison vs Boostlingo and InterpretManager. Lead the second fold with the data-ownership clause from the Terms — verbatim.

**Schedulers (the daily user).** Lead with workflow relief. *"The day-of view that doesn't make you swivel between five tabs."* The scheduler page (`/for-interpreters` shares the same template but with a /for-schedulers tab) shows the unified day-of board: open jobs, claimed jobs, cancellations, replacements-needed, all on one screen. Second fold: the conflict-detection rules in plain English ("we won't double-book an interpreter, we'll warn before booking back-to-back across counties, we'll surface preferred-interpreter requests from a requestor's history").

**Interpreters (the roster the buyer must keep happy).** Lead with respect and money. *"Claim a job in two taps. See what you'll be paid before you accept. Get paid on the day the agency promised."* The interpreter page shows a phone screenshot, a 1099 year-to-date strip, and the payment-cadence guarantee. We are explicit that interpreters are not the customer in the contract sense — agencies are — but they're the only reason the contract has any value, and the product treats them that way.

A fourth audience worth its own page is **requestors** (front-desk staff at hospitals, school district 504 coordinators, court clerks): *"Book an interpreter without learning new software. Reply to an email, fill a two-field form, or call our number. Same outcome."*

---

## F2. Sitemap

```
/                                  — home / hero / three pillars / proof
/for-agencies                      — buyer page; math + data ownership
/for-schedulers                    — daily-user page; day-of board
/for-interpreters                  — roster retention; claim + pay
/for-requestors                    — front-desk staff who book a job
/for-payers                        — billing/AP/CFO audience
/pricing                           — tiers, public, all of them
/free-for-deaf-owned               — verification process + badge spec
/features                          — feature index, links to all below
  /features/scheduling
  /features/interpreter-app
  /features/billing
  /features/translation
  /features/ai-intake
  /features/vri-opi
  /features/cart
  /features/reporting
  /features/integrations
/security                          — HIPAA, encryption, BAA, subprocessors
/accessibility                     — VPAT, WCAG conformance log, ASL videos
/about                             — Anthony + Fallon + the team
/our-1891                          — the lineage page; lighter on home, deeper here
/blog                              — content marketing index
/case-studies                      — long-form customer stories
/customers                         — logo wall (with permission)
/resources                         — guides, glossaries, templates
  /resources/glossary              — interpreting industry terms, ASL videos
  /resources/baa-explained
  /resources/scheduler-runbooks
/changelog                         — what's new, every release
/sign-in                           — magic link
/get-a-demo                        — qualified inbound (Practice + above)
/start-free                        — self-serve onboarding for Deaf-owned
/contact
/legal/privacy
/legal/terms
/legal/baa
/legal/dpa
/legal/subprocessors
/legal/accessibility-statement
/legal/responsible-disclosure
/legal/dmca
/404                               — real 404; no soft redirect (per FDT audit)
```

**Page specs, one paragraph each:**

**`/` (home).** Universal — agency owners, schedulers, interpreters, journalists. Hero one-liner + three pillars + a 60-second ASL+captioned explainer video + a customer-logo strip once we have permission. CTA: *Get a demo* (primary), *Start free if Deaf-owned* (secondary).

**`/for-agencies`.** Agency owners. Math, data ownership, BAA, no-per-seat. Two CTAs: *Compare your current spend* (links to a real calculator) and *Talk to us*.

**`/for-schedulers`.** Schedulers in any agency. Day-of board, conflict rules, keyboard shortcuts, multi-monitor support. CTA: *Watch the day-of demo (4 min, captioned).*

**`/for-interpreters`.** Roster interpreters. Phone screenshot, claim-in-two-taps, payment cadence, 1099 download. CTA: *Ask your agency to invite you* + a deep link to the App Store / Play Store.

**`/for-requestors`.** Hospital front-desks, school 504 coordinators, court clerks, corporate L&D. Book by email/web/phone. Sample request form. CTA: *Request an interpreter through an agency you already work with.*

**`/for-payers`.** Billing managers, AP, CFOs at large institutions. Net-30 invoicing, consolidated billing, GL coding, NetSuite/QuickBooks export. CTA: *Get a sample invoice + GL mapping*.

**`/pricing`.** Universal — public prices for every tier including Network (with a starting price, not "talk to us"). Comparison table vs typical competitor pricing model. CTA: *Get a demo* or *Start free if Deaf-owned*.

**`/free-for-deaf-owned`.** Deaf-owned agency owners and allies who want to vouch. Full verification process, board members named, edge cases addressed, application form. CTA: *Apply* + a downloadable PDF of the verification standard for legal teams.

**`/features` + children.** Buyers in research mode and existing customers looking up specific functionality. Each child page is a single feature, one screenshot, one demo video (captioned, with ASL inset), one set of "how it works" steps, one FAQ. CTA: *Try it in a demo*.

**`/security`.** Compliance-oriented buyers (medical, legal, government). HIPAA posture, encryption at rest/in transit, key management, subprocessor list, BAA on request, SOC 2 status (where we are in the journey — honest about Type II timeline). CTA: *Download the security overview PDF*.

**`/accessibility`.** Procurement, compliance, end-users with disabilities. Current VPAT, WCAG 2.2 AA conformance log, list of known issues with target-fix dates, contact for accessibility-specific feedback. CTA: *Report an accessibility issue* (priority queue).

**`/about`.** Press, prospective customers doing diligence, candidates. Anthony, Fallon, advisors, where we are (Frederick, MD), where we incorporate, who funds us. Photos, real bios, real emails.

**`/our-1891`.** Anyone who wants the story. The lineage — five generations Deaf since 1891, what that means, why it's the undercurrent and not the headline. Light on the home, deep here. No CTA; this page is reputation, not conversion.

**`/blog`, `/case-studies`, `/customers`, `/resources`, `/changelog`.** Standard. The blog is the content engine; changelog is the trust engine (we ship; it's visible).

**`/sign-in`, `/get-a-demo`, `/start-free`, `/contact`.** Conversion endpoints.

**`/legal/*`.** Procurement, legal counsel, GDPR officers. Plain-English summaries above each legal doc; the doc itself below. Subprocessor page lists every vendor with a one-line description of what they do.

---

## F3. Pricing model

| Tier | Monthly (paid annually) | Monthly (paid monthly) | Audience | Caps |
|---|---|---|---|---|
| **Deaf-Owned** | **$0** | **$0** | Verified Deaf-owned agencies, all sizes | Unlimited interpreters, jobs, requestors, storage; AI intake at fair-use cap |
| **Solo** | $9 | $12 | Individual freelance interpreters acting as their own agency | 1 user; 200 jobs/yr; 1099 + invoicing |
| **Practice** | $249 | $299 | Small agencies, up to 25 active interpreters | Unlimited schedulers and requestors; standard AI intake; BAA included |
| **Studio** | $749 | $899 | Mid agencies, up to 100 active interpreters | + SSO, custom domain, location-specific phone numbers, advanced reporting |
| **Network** | from $2,400 | from $2,800 | Large agencies (100+ interpreters), multi-state, enterprise | + white-label, SIEM export, dedicated SLA, custom integrations, multi-region |

**Why these numbers.**

*Solo at $9.* The freelance-interpreter-acting-as-their-own-agency is a real and growing segment, especially post-pandemic VRI. $9/mo is below most invoicing tools (FreshBooks, Honeybook) because we're vertical-specific and we want this tier to grow into Practice for the ones who hire.

*Practice at $249 flat.* Anchored against Boostlingo's per-seat math: a 6-person agency on Boostlingo with five schedulers and 25 interpreters ends up in the high-three-figures to low-four-figures monthly once per-job fees are layered in. Practice at $249 flat is a deliberate price wall. Round number, easy to defend internally to a CFO, doesn't require a procurement cycle.

*Studio at $749.* Where a 50-person agency that needs SSO and reporting ends up. Still cheaper than Boostlingo at that headcount, and the features (SSO, custom domain, per-location numbers) are the actual things a mid-agency procurement officer asks for.

*Network from $2,400.* We publish the floor. We don't do "talk to us" pricing because that's a trust signal we're not willing to spend. Above the floor, custom integrations and multi-region pricing are itemized in the contract, not in a Sales magic number.

**What's never in any paid tier:**

- **No per-job fee.** Not a percentage, not a flat. You book a job, you don't pay us for that job.
- **No per-call/per-minute fee on VRI or OPI.** We charge the platform fee; the call infrastructure cost (Twilio or equivalent) is passed through at cost and itemized.
- **No payment-processing skim.** When an agency takes payment from a requestor through us (Stripe), the Stripe fee is passed through at Stripe's published rate. We don't add bps.
- **No data ransom.** Export your roster, your client list, your invoices, your job history — CSV or JSON — any day. The export button is on the same page as the cancel-account button. Same place. Same prominence.
- **No locked features by tier on accessibility.** Every accessibility feature is in every tier including Solo and Deaf-Owned.

**Comparison table — pricing model only (full feature matrix in F9):**

| | 1891 Interpreter | Boostlingo (per public pricing page) | InterpretManager (per public materials) | Custom FileMaker/Excel |
|---|---|---|---|---|
| Pricing model | Flat monthly per agency | Per-seat + per-call/per-job | Per-seat + setup fee | License + ongoing dev time |
| Per-job fee | $0 | Yes (varies by call type) | No (per public materials) | $0 (but no value-add) |
| Free tier | Yes (Deaf-owned, full features) | No | No | N/A |
| Data export | One click, CSV+JSON | Per request | Per request | Native (your file) |
| Public price floor | Yes, every tier | Partial | No | N/A |

We don't bash. We just show the math.

---

## F4. Deaf-owned verification process

**The standard.** A Deaf-owned agency, for purposes of the Free Forever tier, is an agency where a Deaf, DeafBlind, or hard-of-hearing person — or a group of such persons — holds more than 50% of ownership interest and exercises operational control. We use the same baseline that state DBE/MBE and SBA programs use, and we accept any of the following as documentation:

1. State Deaf-owned business certification (where the state offers one — a small but growing number).
2. SBA self-certification for a Deaf-owned small business.
3. NAD agency-member designation (where applicable to the agency's classification).
4. A sworn attestation, signed by the owner, used where no state pathway exists. The attestation is one page, plain English, and Fallon co-signs the program-level standard so the attestation is verifying against a clear definition, not a vibe.

**The workflow.**

1. **Apply.** Owner submits a short form at `/free-for-deaf-owned`: agency legal name, state of formation, owner name, contact email, ownership documentation (file upload or attestation).
2. **Acknowledge.** Auto-reply within 5 minutes. A real person (Fallon or designated board secretary) responds within 2 business days to confirm receipt.
3. **Board review.** The verification board — Fallon plus two community advisors, rotating — reviews within 5 business days. Decision is binary (approve/deny) with a written reason either way. No "pending forever" status.
4. **Approve path.** Tier flipped to Free Forever on the same day as approval. Badge ("Deaf-owned · 1891 verified") becomes available for the public profile page and as an embeddable SVG for the agency's own website. BAA is auto-attached.
5. **Annual recertification.** Light. Once a year we email "still owned by the same person/people? reply yes." We don't ask for re-documentation unless ownership changed.
6. **Deny path.** Reasoned response. The applicant can appeal within 30 days. **All denials are reviewed by the full board, not a single reviewer.** A denied agency is welcome to use the platform on a paid tier — the badge is the gate, not the platform.
7. **Withdraw.** If an agency's ownership changes such that it no longer qualifies (sale, merger, change in operational control), the badge comes down and the agency transitions to the appropriate paid tier with 90 days' notice and no service interruption.

**Edge cases — addressed explicitly on the page.**

- **Deaf-CODA-owned agency.** The CODA is hearing. Not Deaf-owned by our standard; eligible for paid tier. Many CODA-led agencies are deeply community-aligned, and we'll happily feature their work; the badge stays a Deaf-ownership marker.
- **Mixed-ownership 51% Deaf-owned.** Qualifies. The standard is >50% ownership; 51% is more than 50%.
- **Deaf-led nonprofit but not Deaf-owned.** Nonprofits don't have "owners" in the equity sense. If the executive director and the majority of the board are Deaf, the agency qualifies. Documented via board minutes or 990 attestation. Reviewed individually.
- **Hearing-allied agency.** Not eligible for the badge. Eligible for every paid tier. We don't do "honorary" allyship badges — that would dilute the meaning of the badge for the agencies who actually built their businesses Deaf-owned.
- **Deaf person owns the agency on paper but a hearing spouse runs it operationally.** This is the trickiest edge case. The standard requires operational control, not just paper ownership. Reviewed by the full board; the burden is on the applicant to show operational control, not on us to disprove it. We err toward approval if the documentation is reasonable; we deny if it looks like a workaround.

The verification page closes with a line we want on the record: *We will get this wrong sometimes. When we do, the board reconsiders. The badge means something because we hold it to a standard, and the standard exists because the community asked for one.*

---

## F5. Brand identity primitives

**Logo concept (spec only — design happens elsewhere).** The mark is "1891" in a custom-set display numeral pair with a single connecting glyph between the 8 and the 9 that reads simultaneously as a handshape contact point (interpreting) and a generational link (lineage). The mark works at 24px (favicon, app icon, table headers) and at 240px (hero, business card). On agency tenant pages, the agency's own logo leads; "powered by 1891 Interpreter" sits in the footer at quiet weight. We never put our mark over an agency's logo on their tenant; they're the brand, we're the substrate.

**Color palette (4 tokens, mapped to `~/Desktop/1891/shared/design-system/tokens/colors.css`):**

- `--ink` — `#0F1419`. Body text, primary UI affordance. Near-black, not pure black; reads warm on paper.
- `--paper` — `#FAFAF7`. Page background. Warm white with a trace of cream so it doesn't fight printed materials.
- `--bloom` — `#C8553D`. Primary accent. A muted terracotta — the "1891 bloom." Used for primary buttons, links, and the badge. Chosen because it's distinct from the medical-blue and tech-purple of every competitor, and because it tests well at WCAG 2.2 AA contrast against both paper and ink.
- `--river` — `#2E5E5C`. Secondary accent. A deep teal-green. Used for the security/trust surfaces (`/security`, BAA modals, audit-log UI) where bloom would feel too warm.

All four tokens pass WCAG 2.2 AA at body text size. A separate `--bloom-strong` and `--river-strong` exist for AAA contexts (small text on colored backgrounds).

**Typography.** System stack, no webfont penalty.

- Display: `ui-serif, "Iowan Old Style", "Apple Garamond", Georgia, serif`. The serif communicates "this is a tool with a history" rather than the sans-serif "we are a 2024 startup" default. Used for the hero, page titles, the lineage page.
- Body: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`. Base size `1.0625rem` (17px), line-height `1.55`. Readable defaults; respects user font-size preferences.
- Monospace (for code, ID strings, audit logs): `ui-monospace, "SF Mono", Menlo, monospace`.

**Voice samples.**

- *Hero:* "The interpreting agency platform built by the community it serves."
- *Primary button:* "Get a demo" (not "Request demo" — declarative, not asking permission).
- *Empty state (scheduler with no jobs today):* "Nothing on the board. Quiet day, or did the office close early?"
- *Error state (failed to send a job offer):* "We couldn't send that offer. We didn't lose it — your draft is saved at the top of the queue. Try again or check the interpreter's contact info."
- *Confirmation (job filled):* "Filled. Interpreter notified. Requestor notified. You can close this tab."

**Photography guidance.** Real people in real interpreting work. Hospital rooms, classrooms, conference stages, courtrooms, kitchens. Representation across Deaf, DeafBlind (with ProTactile, when the interpreter consents to being photographed in that work), and hard-of-hearing communities, and across spoken-language interpreting (Spanish, Mandarin, Arabic, Haitian Creole — the actual language mix our customers serve). All subjects consent in writing, are paid (industry rate for time and likeness), and can revoke at any time. Photos credit the subjects and the interpreters by name where the subject prefers. We don't use stock photography of "diverse hands" or "ASL alphabet flat lay."

**Visual treatments to avoid.**

- No fingerspelled words as decoration. ASL is a language, not a typeface.
- No isolated handshapes without context (a hand in a void communicates nothing and reads as cliché).
- No "ear with line through it" disability iconography. We're not selling deafness-as-deficit; we're selling a working agency platform.
- No "hands joining" stock imagery as a shorthand for "interpreting." Show interpreters working.
- No graphics that fingerspell "1891." The numerals are typeset; the lineage is not a handshape gag.

---

## F6. Content plan — first 6 months

Cadence: 2 blog posts/month + 1 case study/quarter + 1 webinar/quarter + ongoing glossary entries (target 50 entries by month 6). Total monthly output: ~3 long-form pieces, ~6 glossary entries.

| Month | Long-form | Glossary | Other |
|---|---|---|---|
| 1 | "How a Deaf-owned interpreting agency operates" (founder story, Fallon byline) | 8 entries (CDI, RID, BEI, VRS, VRI, OPI, CART, ProTactile) | Launch announcement, AMA with Fallon (recorded, captioned) |
| 2 | "The math on per-seat platforms vs flat-fee" — anti-Boostlingo-math piece, with the calculator linked | 8 entries (LSP, ASL/English interpreter, trilingual interpreter, deaf interpreter, hearing interpreter, COE, NAD, RID) | Webinar #1: "Picking software when you're the only IT person in a 6-person agency" |
| 3 | "Universal design in a scheduler dashboard" (Fallon byline) + first case study (design partner #1) | 8 entries (procurement-side terms: BAA, HIPAA, FERPA, ADA Title III, Section 504, Section 508, VPAT, WCAG) | — |
| 4 | "Why we'll never charge a Deaf-owned agency" (manifesto, Anthony byline) | 8 entries (compensation: 1099, W-9, T&E, mileage, premium pay, on-call, cancel-fee, no-show) | Webinar #2: "Running an open hiring loop for interpreters that actually shows up to the second interview" |
| 5 | "Interpreter retention math: why your roster turnover is your biggest hidden cost" + second case study | 8 entries (technical: SSO, SAML, magic-link, two-factor, audit log, SIEM, encryption-at-rest, PHI) | AMA #2 with a guest agency owner from the design partner cohort |
| 6 | "Six months in: what we got wrong and what we shipped" (changelog-style retrospective) | 10 entries (rare-language and regional: triadic, relay, deaf-blind, certified deaf interpreter, designated interpreter, educational interpreter, medical interpreter, legal interpreter, conference interpreter, community interpreter) | Webinar #3: "Live captions in mixed-hearing meetings — what works, what's a research problem" |

Every glossary entry has: a plain-English definition, an ASL video (Fallon or a vetted contributor, captioned and audio-described), and a Spanish translation. Glossary entries are the SEO long tail. They also become the basis for the in-product help system.

---

## F7. SEO + organic strategy

**Primary keyword targets** (commercial intent, high-conversion):

- "interpreting agency software" — `/`, `/for-agencies`
- "ASL interpreter scheduling software" — `/features/scheduling`, `/for-schedulers`
- "language service provider platform" — `/for-agencies`
- "Boostlingo alternative" — dedicated comparison page (yes, the brand-name comparison page is a real SEO play; we keep the tone factual)
- "interpreter management system" — `/features` index
- "free interpreting agency platform" — `/free-for-deaf-owned`
- "HIPAA-compliant interpreter scheduling" — `/security` + `/features/scheduling`
- "Deaf-owned interpreting agency platform" — `/free-for-deaf-owned`, `/about`

**Long-tail / informational** (mid-funnel, content-led):

- "What is a CDI" — glossary
- "Difference between VRS and VRI" — glossary
- "How to invoice for interpreting work" — resource piece linking to billing feature
- "1099 vs W-2 for interpreters" — resource piece (with a disclaimer pointing to a CPA)
- "RID certification requirements 2026" — annual refresh
- "How to start a Deaf-owned interpreting agency" — pillar piece

**Schema.org markup** — every page:

- `Organization` schema on all pages with logo, founder names, sameAs links to LinkedIn and GitHub.
- `SoftwareApplication` schema on `/`, `/features/*`, `/pricing` with pricing tier offers.
- `FAQPage` schema on `/pricing`, `/free-for-deaf-owned`, `/security`.
- `HowTo` schema on resource pages with step-by-step instructions.
- `BreadcrumbList` schema site-wide.
- `Article` schema with `author` (Fallon or Anthony, with sameAs links) on every blog post.

**Internal linking map.** Every glossary entry links to the relevant feature page. Every feature page links to one case study and one blog post. Every comparison page links to `/pricing` and `/free-for-deaf-owned`. The footer carries the full sitemap so crawlers reach every URL within two hops of `/`.

**Backlink targets — prioritized by realism, not by domain authority:**

1. **NAD, RID, AVLIC** — community-org domains. We don't pay for placement; we earn it through case studies, the manifesto, and Fallon's standing in the community.
2. **Gallaudet University** — alumni listings, dept of interpretation resource pages.
3. **State commissions for Deaf and hard-of-hearing** (CT, MD, TX, CA, MN, MA, WI — the ones with active commissions). We provide them a vendor-neutral guide to picking software; they list us as a vendor.
4. **ATA, NCRA** — for spoken-language interpreting and CART respectively.
5. **State RID affiliate chapters** — local sponsorships and meetup hosting.
6. **Accessibility and disability-rights aggregators** — DREDF, NDRN, NCD (where appropriate).
7. **Vertical press**: ATA Chronicle, RID VIEWS, Hearing Journal, Deaf Life.

---

## F8. Launch plan

**Phase 0 — Design partner onboarding (now, months 0–3).**
Two Deaf-owned agencies and one hearing-allied small agency. White-glove. Free. Weekly check-ins, Fallon and Anthony on every call. Goal: ship 100% of the features the design partners actually use, fix every accessibility issue they flag, build the first two case studies (months 3 and 5).
*Success metric:* All three partners actively scheduling jobs through the platform for 60 consecutive days. Zero blocking accessibility issues open at end of phase.
*Growth tactic:* Word of mouth in the design partners' direct community. No paid acquisition.
*Support commitment:* Same-day response on any issue, weekly 30-min check-in.

**Phase 1 — Open beta for Deaf-owned agencies (months 3–6).**
Free Forever tier opens for verified Deaf-owned agencies via the `/free-for-deaf-owned` flow. Paid tiers (Practice, Studio) open to allied agencies on case-by-case approval, with onboarding done by Anthony directly. Network and Solo tiers stay closed.
*Success metric:* 15 verified Deaf-owned agencies onboarded; 5 paid Practice agencies onboarded; <72h verification turnaround; NPS from interpreters on the platform >40.
*Growth tactic:* Manifesto post ("Why we'll never charge a Deaf-owned agency") at start of phase, AMA with Fallon, NAD/RID/AVLIC outreach for backlinks.
*Support commitment:* 4-hour response during business hours, on-call rotation for outages.

**Phase 2 — Self-serve + public launch (months 6–12).**
All tiers open. Self-serve signup for Solo, Practice, Studio. Network still has a sales conversation but with a published floor price and a one-page contract template. Public launch event (virtual, ASL+English+Spanish captioned).
*Success metric:* 50 paid agencies; 40 Deaf-owned agencies; gross revenue covering all platform infrastructure costs and Fallon's compensation as CDI advisor.
*Growth tactic:* Comparison-page SEO, podcast tour (interpreting podcasts, Deaf-business podcasts, accessibility podcasts), state commission listings.
*Support commitment:* 2-hour business-hours response; 24/7 incident response for paid tiers; written SLA for Network.

**Phase 3 — Partnerships and mid-market (months 12–24).**
Partnerships with state Deaf commissions (we provide a free instance for the commission's referral list); NAD and RID partnership conversations; mid-market sales push to 100+ interpreter agencies; first international expansion (Canada, with bilingual EN/FR; Spain or Mexico for spoken Spanish).
*Success metric:* 150 paid agencies; 100 Deaf-owned agencies; SOC 2 Type II completed; one Network customer live.
*Growth tactic:* Co-marketing with state commissions, presence at NAD biennial and RID conference, case studies in three verticals (medical, legal, education).
*Support commitment:* Full 24/7 for Studio and Network; dedicated CSM for Network.

---

## F9. Pricing/positioning competitive matrix

| Dimension | 1891 Interpreter | Boostlingo | InterpretManager | Custom FileMaker/Excel |
|---|---|---|---|---|
| Pricing model | Flat monthly per agency | Per-seat + per-call/per-job (per public pricing page) | Per-seat + setup fee (per public materials) | One-time license + ongoing internal dev time |
| Per-seat tax | None | Yes | Yes | None |
| Per-job/per-call transaction fee | $0 | Yes (varies; per public pricing page) | Not in base plan (per public materials) | $0 |
| Free tier | Yes — Deaf-owned, full features, unlimited | No | No | N/A |
| Public pricing | Yes, every tier including Network floor | Partial (some tiers contact-sales) | Contact-sales | N/A |
| Data ownership / one-click export | Yes (CSV + JSON, same prominence as cancel button) | Per request | Per request | Native to user's own file |
| Accessibility commitment | Public VPAT, WCAG 2.2 AA conformance log per release, ASL videos on every marketing page | Per public materials | Per public materials | None (depends on user's own build) |
| AI intake | Included in Practice and above; standard usage caps | Add-on (per public pricing page) | Limited (per public materials) | None |
| Document translation | Included | Add-on | Limited | None |
| Live captions / STT integration | Vendor-abstracted (Deepgram default, AssemblyAI/Cloudflare Whisper alternates) | Per public materials | Per public materials | None |
| BAA included | Yes, all paid tiers + Deaf-owned | Yes (per public materials) | Yes (per public materials) | DIY |
| SSO / SAML | Studio and above | Per public pricing page | Per public materials | DIY |
| White-label | Network | Add-on (per public materials) | Add-on (per public materials) | DIY |
| Audit log export to SIEM | Network | Per public materials | Not standard | DIY |
| Deployment model | Multi-tenant SaaS, optional single-tenant on Network | Multi-tenant SaaS | Multi-tenant SaaS | Self-hosted |

Where the row says "per public pricing page" or "per public materials," that's because we've reviewed what's published as of the PRD date and haven't fabricated specifics. The marketing version of this table cites publication dates inline.

---

## F10. Open marketing/positioning decisions

Ten decisions Anthony should weigh in on before the marketing site goes live. Each one has a recommendation; Anthony overrides any of them.

1. **Domain choice.** *Recommendation:* `1891interpreter.app` for the marketing site and the tenant root (`<agency>.1891interpreter.app`). The `.app` TLD has enforced HTTPS at the registry level, which is the right default for a HIPAA-adjacent product. Alternates considered: `1891interpreter.com` (more familiar but no HTTPS-by-default), `1891.coop` (mission-aligned but unfamiliar to enterprise buyers). Register all three; canonical is `.app`.

2. **Hero leads with universal design or HIPAA?** *Recommendation:* Universal design. HIPAA is table stakes for any vendor in this space; leading with it makes us sound like every other competitor. Universal design as default is differentiated and matches who built the product. HIPAA gets its own page (`/security`) and is referenced in the second fold on `/for-agencies`.

3. **Publish Network tier price or "talk to us"?** *Recommendation:* Publish the floor ("from $2,400/mo"). Hidden pricing is a trust-cost we're not willing to pay. Custom integrations above the floor are itemized in the contract, not in a Sales magic number.

4. **Brand the badge as "Deaf-owned · 1891 verified" or "1891 verified Deaf-owned"?** *Recommendation:* "Deaf-owned · 1891 verified." Deaf-owned is the noun; 1891-verified is the modifier. The community status leads; we're the verifier, not the brand on the agency's chest.

5. **Use the term "Deaf-owned" or "DHH-owned" (Deaf, Hard-of-Hearing)?** *Recommendation:* Deaf-owned as the public-facing term (proper-noun Deaf, capital D, the cultural identifier), with the qualifier on the verification page that the standard includes DeafBlind and hard-of-hearing owners. This matches how the community talks about itself and avoids the acronym creep that dilutes meaning. Fallon's call to override.

6. **Spoken-language and signed-language equal billing on the home page, or signed-language-led with spoken-language as a "we also do" sub-fold?** *Recommendation:* Equal billing. The unified-platform claim only works if it shows up in the hero. The home page shows both modalities in the explainer video and both in the feature list. The lineage and the community story differentiate us from spoken-only competitors, so we don't lose that signal by giving spoken languages equal real estate.

7. **Should we publish customer logos before we have signed permission, with names redacted?** *Recommendation:* No. The `/customers` page launches empty and stays empty until permission is signed. An empty page is more honest than a fuzzy-logo page. Case studies launch first; logos follow.

8. **Should the comparison page name Boostlingo by name?** *Recommendation:* Yes, but factual only. The page cites Boostlingo's public pricing page with the date we reviewed it. We don't editorialize; we publish the math. If Boostlingo's pricing changes, we update the page within 30 days. The page title is "Boostlingo vs 1891 Interpreter" — the SEO target is exactly that comparison query.

9. **AMA cadence — quarterly or monthly?** *Recommendation:* Quarterly for the first year, with the option to go monthly in year 2 if engagement supports it. Monthly AMAs are a tax on Fallon's time that competes with her real interpreting and advisory work. Quarterly with high preparation beats monthly with low.

10. **Should the marketing site itself be open source?** *Recommendation:* Yes. The static-site source goes in a public GitHub repo. The marketing site is reputation infrastructure, not a moat. Other Deaf-owned organizations can fork the verification-page template if they want to build similar programs. The product itself stays private.

---

*End of Section F.*
