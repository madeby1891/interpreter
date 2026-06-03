# Section B — Stakeholders, Roles, Permissions, and Dashboards

*Master PRD: 1891 Interpreter*
*Built in Frederick. Carried forward since 1891. Five generations Deaf.*

This section defines who uses the platform, what they can do, what they see, and how their day actually unfolds inside it. The platform is the most stakeholder-complex thing the 1891 workspace has shipped — thirteen distinct roles, three party types (agency / requestor / consumer), and a permissions model that has to satisfy HIPAA, state Medicaid billing rules, two-party-consent recording law, and the practical reality that DeShawn drives between three agencies in one Tuesday.

---

## B1. Role taxonomy

Roles are listed in the order a request flows through them, not by privilege rank.

**Requestor Contact** — *"Mariana, front-desk medical assistant, busy ENT practice in Hagerstown."* Mariana books eight to twelve interpreter appointments a week. She does this between answering the phone, rooming patients, and re-stocking otoscope tips. Her job-to-be-done is **"book the right interpreter for Mr. Park's Thursday 2pm without making the appointment late."** She does not want to learn a new app. She wants a single form, a confirmation email with the interpreter's name and photo, and a phone number to call when the interpreter is five minutes late.

**Requestor (organization)** — The legal entity the contact belongs to. Mariana's ENT clinic is a Requestor. The Requestor record holds the master service agreement, billing terms, default cancellation policy, and the list of all contacts authorized to book under it. There is usually a designated "admin contact" who can see every booking the org has ever made; everyone else sees their own.

**Payer** — *"Karen, AP clerk at Frederick Health System central billing office."* The hospital books through forty front desks but pays through one office. Karen receives invoices in a queue, batches them weekly, and ACHs out. She never books an interpreter, never sees PHI beyond service-line summaries, and gets very angry when an invoice arrives without a PO number. Her JTBD: **"clear this week's interpreter invoices before close of business Friday."**

**Consumer / Client** — *"Mr. Park, 71, Deaf since birth, prefers ASL with a CDI for medical."* Mr. Park does not book his own interpreter — Mariana does — but he has strong preferences about who interprets his oncology appointments and a "do not assign" interpreter from a bad experience three years ago. If the agency turns on the MyInterpreter portal, Mr. Park can log in and tell the system those preferences directly instead of routing them through Mariana, who routes them through the scheduler, who sometimes forgets.

**Scheduler / Coordinator** — *"Lin, scheduler at a mid-size Maryland agency, 80 interpreters on roster, 220 jobs/week."* Lin lives in the platform from 7:45am to 5pm. She has three monitors, two phones, and a coffee that goes cold by 9. Her JTBD: **"fill every job without double-booking anyone, and broadcast every change before it bites."** Tetris-fast UX is not a metaphor for Lin — she moves jobs around with keystrokes the way a Bloomberg trader moves tickers. If a screen takes two clicks where one will do, she'll resent it before lunch.

**Interpreter, W-2 staff** — *"Priya, salaried staff interpreter, urban Spanish-medical, eight years tenure."* Priya has a published Monday-Friday schedule. She gets assigned by Lin, but if she has a 90-minute gap she can grab a same-day job from the team queue. Her JTBD: **"work my assigned schedule, capture my time accurately, get paid on the 15th."** She does not negotiate rates. She does care about which clinic the assignment is at because parking at Frederick Memorial is a nightmare.

**Interpreter, 1099 contractor** — *"DeShawn, freelance ASL/English, RID-NIC, Frederick + Hagerstown + Gaithersburg."* DeShawn is on three agencies' rosters. He sets his own availability, claims jobs from a marketplace view, and tracks 1099 income across all three for his accountant. He drives 28k miles a year. His JTBD: **"keep my week 70% billable, drive the least, get paid in under 30 days."**

**Certified Deaf Interpreter (CDI)** — *"Marisol, CDI, RID-CDI, specializes in mental-health and DeafBlind."* Marisol almost never works alone — she pairs with a hearing ASL interpreter who voices for her. Her roster is small (the entire state has maybe 40 active CDIs). When a job is flagged "CDI required" — psych eval, forensic interview, a Deaf consumer with idiosyncratic language — she gets matched. JTBD: **"team well with my voicer, prep adequately, advocate for the consumer."**

**CART Captioner** — *"Jordan, NCRA-CRC certified, primarily remote."* Jordan provides realtime English text via Stenograph or voice-writing. CART is a sibling workflow to interpreting — Jordan does not "interpret" in the legal sense, but the agency books, schedules, and bills CART through the same platform. JTBD: **"connect to the meeting on time, caption clean, deliver the transcript."**

**Translator (document)** — *"Aiyana, freelance Diné↔English document translator."* Aiyana receives PDFs and Word docs, returns translated files within a stated turnaround. Different work model: no live event, no location, no arrival timestamp. Her workspace is a job-queue with file attachments and a deadline. JTBD: **"download, translate, return, invoice."**

**Agency Admin / Owner** — *"Fallon, CDI, owner of a Deaf-owned interpreting agency."* Fallon configures rate cards, certifies that her agency meets Deaf-owned criteria, hires and fires staff interpreters, approves 1099 onboarding, and watches AR aging like a hawk. Her JTBD: **"keep the agency profitable, the roster credentialed, and the consumers well-served."**

**Auditor / Compliance** — *"Rabia, external HIPAA auditor, contracted twice a year."* Rabia comes in for two weeks, reviews logs, asks pointed questions, leaves. She has read-only access to the audit log. She does not need PHI unless she's investigating a specific incident, and even then access is logged. JTBD: **"verify the agency is doing what it says it does."**

**Anthony — Platform owner (cross-tenant superadmin)** — Anthony's role is support and incident response across all agency tenants. Every cross-tenant action requires a typed reason, fires an email + SMS to the affected agency admin, and lands in an immutable append-only log that even Anthony cannot edit. JTBD: **"fix what's broken without becoming a PHI risk."**

---

## B2. Permissions matrix

R = read, W = write, R/W = read-and-write, RW* = restricted write (own records or limited fields), N = none, BG = break-glass with logged justification.

| Capability | Agency Admin | Scheduler | Interp. W-2 | Interp. 1099 | CDI | CART | Translator | Requestor Contact | Payer | Consumer | Auditor | Anthony |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| View own profile | R/W | R/W | R/W | R/W | R/W | R/W | R/W | R/W | R/W | R/W | R/W | R/W |
| Edit own profile | R/W | R/W | R/W | R/W | R/W | R/W | R/W | R/W | R/W | R/W | R/W | R/W |
| View own assigned jobs | R | R/W | R | R | R | R | R | R | R | R | R | BG |
| Claim jobs (marketplace) | N | N | RW* | R/W | R/W | R/W | R/W | N | N | N | N | N |
| Decline jobs | N | R/W | RW* | R/W | R/W | R/W | R/W | N | N | N | N | N |
| Cancel own jobs | N | R/W | RW* | RW* | RW* | RW* | RW* | RW* | N | RW* | N | BG |
| View team interpreters' jobs | R | R/W | RW* | RW* | RW* | RW* | N | N | N | N | R | BG |
| View consumer PHI (full) | R | R | R | R | R | R | RW* | RW* | N | RW* | N | BG |
| View consumer PHI (initials only) | — | — | — | — | — | — | — | — | R | — | R | — |
| Create/edit Requestors | R/W | R/W | N | N | N | N | N | RW* | N | N | N | BG |
| Create/edit Locations | R/W | R/W | N | N | N | N | N | RW* | N | N | N | BG |
| Create/edit Consumers | R/W | R/W | N | N | N | N | N | RW* | N | RW* | N | BG |
| Assign interpreters | N | R/W | N | N | N | N | N | N | N | N | N | BG |
| Unassign / Reassign | N | R/W | N | N | N | N | N | N | N | N | N | BG |
| Edit rate cards | R/W | R | N | N | N | N | N | N | N | N | R | BG |
| Edit cancellation policies | R/W | R | N | N | N | N | N | N | N | N | R | BG |
| View invoices | R | R | RW* | RW* | RW* | RW* | RW* | R | R | N | R | BG |
| Pay invoices | R/W | N | N | N | N | N | N | N | R/W | N | N | BG |
| Approve payouts | R/W | N | N | N | N | N | N | N | N | N | R | BG |
| View audit log | R | R | RW* | RW* | RW* | RW* | RW* | RW* | RW* | RW* | R | R/W |
| Cross-tenant access | N | N | N | N | N | N | N | N | N | N | N | BG |
| Approve Deaf-owned verification | R/W | N | N | N | N | N | N | N | N | N | N | R |

Notes on the matrix:
- "Restricted W" on interpreter rows for "view team jobs" means an interpreter can see *who is assigned* to other jobs on the same date (for team-coordination purposes) but not PHI for jobs they're not on.
- Consumer's RW* on "Create/edit Consumers" means: a consumer can edit their *own* record (preferences, do-not-assign list, comm preferences) but cannot create new consumer records.
- Anthony's "BG" entries mean every action is gated by a justification modal, logged immutably, and triggers a notification to the agency admin in real time. There is no "silent superadmin" mode.

---

## B3. Per-role surfaces

### B3.1 Scheduler Dashboard

The single most-used surface on the platform — Lin lives here. The design north star is **a parliamentary clerk's command center, not a calendar app**. Information density is high, every keystroke maps to a verb, and conflicts surface before they happen rather than after.

```
+-----------------------------------------------------------------------------+
| 1891 Interpreter — SCHEDULER          Lin K.  Frederick Office  [agency v] |
+-----------------------------------------------------------------------------+
| [Today] [Tomorrow] [Week] [Month]   Filter: [Lang v][Mod v][Setting v][Cert v]
| Smart-fill ▶  Unfilled: 4  Conflicts: 1  Expiring this wk: 2   [+ New job] |
+-----------------------------------------------------------------------------+
| TIMELINE (drag to reassign, double-click to edit, K-bindings active)        |
|       6a    7    8    9   10   11   12p   1    2    3    4    5    6      |
| ─────────────────────────────────────────────────────────────────────────── |
| Priya  ░░[ENT 8-9 Span][▓▓▓▓ Onco 10-12 Span ▓▓▓▓]░░░░░[ER 2-3]░░░░░░░░░░░ |
| DeShawn░░░░░░░░░[Dep 9-11 ASL CDI-team]░░░░░░░░░░░░░░░░[Sch IEP 3-5 ASL]░░ |
| Marisol░░░░░░░░░[Dep 9-11 ASL CDI-team]░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ |
| Jordan ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░[CART board mtg 1-4 remote]░░░░░░░░░ |
| (open) [⚠ UNFILLED MRI 10:30 ASL][⚠ UNFILLED Court 1p Mandarin]░░░░░░░░░░░ |
+-----------------------------------------------------------------------------+
| RIGHT RAIL: selected job → [Mr. Park · Onco 10-12 · Frederick Memorial 4N] |
|   Consumer: Park, J. (Deaf, ASL, CDI preferred for onco)  [view chart]     |
|   Requestor: FMH Oncology · Mariana W.                                     |
|   Status: CONFIRMED · 2-person team · prep packet attached (3 pgs)         |
|   [Reassign] [Add team member] [Broadcast change] [Cancel] [Add note]      |
+-----------------------------------------------------------------------------+
```

**Screens Lin can reach:**
- Timeline (Today / Tomorrow / Week / Month views)
- Unfilled queue
- Conflict resolver
- New job form (with NL intake)
- Interpreter roster (with availability, certs, distance)
- Requestor directory
- Consumer directory (search by name, MRN, last visit)
- Broadcasts / change history per job
- Rate-card viewer (read-only)
- Reports (fill rate, time-to-fill, no-show rate, top requestors)

**Today widget:** "Unfilled in next 24h: 4. CDI-required and still solo: 1. Interpreter no-shows last 7d: 0. Expiring certs by Friday: 2 (Priya BEI-court, DeShawn RID dues)."

**Notifications:** email + in-app for new requests, in-app toast for interpreter cancellations within 24h, SMS for unfilled-within-2h, browser push for any "URGENT" tag from a requestor contact.

**Top 5 actions:** (1) Assign interpreter to open job (drag-drop or `A` keystroke); (2) Smart-fill all unfilled (button + review-each-suggestion modal); (3) Broadcast change ("location moved to building 4N"); (4) Reassign existing job (drag to new interpreter row, confirm); (5) Cancel job with reason code.

### B3.2 Interpreter Mobile-First Dashboard

Designed for DeShawn in his Civic with the engine running, ten minutes before a job. iPhone-sized, big touch targets, never more than two taps from any verb.

```
┌──────────────────────────────┐
│ 1891 Interpreter      [≡]    │
│ Hi DeShawn — Acme Agency  ▾  │  ← agency switcher
├──────────────────────────────┤
│ NEXT JOB · in 14 min         │
│ ─────────────────────────── │
│ Deposition · 9:00–11:00 AM   │
│ ASL · Team w/ Marisol (CDI)  │
│ Smith & Klein Law            │
│ 200 W Patrick St, Frederick  │
│ [🗺 Navigate]  [📞 Call site]│
│ Prep packet (3 pgs) ▾        │
│ ─────────────────────────── │
│       [ I'VE ARRIVED ]       │  ← big, green, full-width
└──────────────────────────────┘
│ TODAY (3 jobs · 5.5 billable)│
│ • 9–11 Deposition  ✅ confirmed
│ • 1–3  IEP mtg     ✅ confirmed
│ • 4–4.5 Phone tri  ⏳ unconfirmed
├──────────────────────────────┤
│ [Open jobs] [My certs] [Avail]│
│ [Pay] [Profile] [Help]        │
└──────────────────────────────┘
```

**Screens:** Today, Open Jobs (marketplace), My Schedule (week / month), Pay (this period + YTD + 1099 download), My Certs (status + expiry), Availability (block-out calendar), Profile (rate, languages, modalities, service area, vehicle/parking notes), Help / Contact agency.

**Today widget:** countdown to next job, prep packet preview, "team partner is 5 min away" presence indicator when both have opened the app.

**Notifications:** push for new offer in marketplace, push for assignment change, SMS for assignment within 24h, push for "you have not pressed Arrived for a job starting in 5 min" nudge.

**Top 5 actions:** (1) "I've Arrived" timestamp button; (2) "Close job" — confirms end time, prompts for notes, lets DeShawn attach a photo of a signed time sheet if the requestor wants paper; (3) Navigate (one-tap to Apple Maps / Google Maps based on device default); (4) Claim open job from marketplace; (5) Mark unavailable for a date range.

### B3.3 Agency Admin Dashboard

Fallon's view. Financials at the top, operations in the middle, configuration in the rail.

```
+---------------------------------------------------------------------+
| 1891 Interpreter · ADMIN · Acme Agency (Deaf-owned verified ✓)      |
+---------------------------------------------------------------------+
| Revenue MTD: $148,200  ↑ 12%   Payouts MTD: $92,400   AR>60d: $14k |
| Top requestors:  FMH (38%) · MCPS (21%) · FCC Court (12%)           |
+---------------------------------------------------------------------+
| OPERATIONS                                                          |
| Open jobs: 24    Unfilled >24h: 3    Expiring certs (30d): 6        |
| New 1099 applications pending review: 2                             |
| Consumer complaints open: 0                                         |
+---------------------------------------------------------------------+
| [Users] [Rate cards] [Cancellation policies] [Branding]             |
| [Requestors] [Consumers] [Reports] [Integrations] [Audit log]       |
+---------------------------------------------------------------------+
```

**Screens:** Dashboard, Users (staff + contractor + scheduler + admin), Roster (certs, skills, performance), Rate Cards (per language, per modality, per setting, per requestor contract overrides), Cancellation Policies, Branding (logo, brand color, ASL onboarding video upload), Reports (financial, operational, compliance), Requestors (contracts, terms, default rates), Consumers (PHI-gated), Integrations (Stripe, ADP/Gusto/Paychex, Bill.com, QuickBooks, Deepgram), Audit Log, Deaf-Owned Verification (status + renewal).

**Today widget:** "3 jobs unfilled >24h; 2 1099 apps awaiting your sign-off; AR over 60 days is $14k across 3 requestors; cert renewal reminder: Priya BEI-court expires Friday."

**Notifications:** daily morning digest email, in-app toasts for compliance flags, SMS for any "URGENT" admin escalation from scheduler, email when Anthony invokes cross-tenant access.

**Top 5 actions:** approve new 1099 onboarding; edit rate card; export 1099-NEC batch at year end; review AR aging report; flag a requestor as on-hold for non-payment.

### B3.4 Requestor Contact Portal

Mariana's view. Two main jobs, two main screens. Everything else is hidden.

```
+----------------------------------------------+
| FMH ENT · Hi Mariana                          |
+----------------------------------------------+
| [+ NEW REQUEST]   [My Requests (7)]           |
+----------------------------------------------+
| MY REQUESTS                                    |
| Thu 5/14 2:00p · Mr. Park · ASL · CDI team    |
|    ✅ Confirmed · DeShawn N. (RID-NIC) + Marisol P. (CDI)
|    [photo] [photo]  [Reschedule] [Cancel]     |
| Fri 5/15 9:30a · Ms. Garcia · Spanish         |
|    ⏳ Searching for interpreter · ETA 2 hrs    |
+----------------------------------------------+
```

**New Request screen** leads with a free-text NL field ("Tell us what you need — e.g., 'ASL interpreter for Mr. Park Thursday 2pm, oncology follow-up, 60 min'"). The parser fills the structured fields underneath; Mariana confirms.

**Screens:** New Request, My Requests, Org-wide Requests (admin contact only), Locations (the clinics under FMH), Contacts (other people in her org with portal access), Help.

**Today widget:** "2 confirmed today. 1 still searching. 0 awaiting your confirmation."

**Notifications:** email + SMS when an interpreter is confirmed (with name, photo, cert badges); email-only when the request is still searching after 1 hour; SMS for any same-day change.

**Top 5 actions:** submit a new request, reschedule, cancel, view confirmed interpreter details, message the scheduler.

### B3.5 Payer Portal

Karen's view. Spreadsheet density, no fluff.

```
+----------------------------------------------------------------+
| FMH Central Billing · Hi Karen                                  |
+----------------------------------------------------------------+
| Invoice queue:  Open: 14  Disputed: 1  Paid this wk: $48,200    |
+----------------------------------------------------------------+
| INV-2026-0481  4/22-4/28  $12,400  ▶ Open                       |
|   38 jobs · FMH Oncology, ENT, ER, Mat-Fetal                    |
|   [Download PDF] [Download CSV] [Dispute] [Mark paid] [Pay ACH] |
| INV-2026-0480  4/15-4/21  $11,920  ✅ Paid 5/2                  |
+----------------------------------------------------------------+
```

**Screens:** Invoices (queue), Disputes, Reports (spend by service line, by month, by language), Bank Setup (Stripe ACH), Tax Documents.

**Today widget:** "$12,400 due this Friday; 1 dispute open (INV-0476, Mariana flagged duration mismatch); next batch posts Monday."

**Notifications:** email on new invoice issued, email on dispute resolution, email on payment confirmation.

**Top 5 actions:** download invoice PDF, pay via ACH, flag a dispute with line-item note, run a spend report, export to AP system.

### B3.6 Consumer Portal — "MyInterpreter"

Off by default per agency. When the agency turns it on, Mr. Park can opt in via a magic link.

```
+----------------------------------------+
| MyInterpreter · Hi Mr. Park             |
+----------------------------------------+
| Upcoming                                |
|   Thu 2:00p · Oncology · FMH · ASL+CDI  |
|   Interpreters: DeShawn N. · Marisol P. |
|   [photo] [photo]                       |
| ─────────────────────────────────────── |
| My preferences                          |
|   Preferred interpreters: ★ Marisol P.  |
|   Do not assign: ⛔ J. Reyes            |
|   Contact me by: ☑ Videophone ☐ SMS    |
|   Need CDI for medical: ☑              |
+----------------------------------------+
| [Request a future job] [My history]    |
+----------------------------------------+
```

**Screens:** Home, Upcoming, History, Preferences, Request Future Job (consumer-initiated; gets routed to the agency scheduler, not auto-confirmed), Transcripts (only if a session was captured with consent and the agency approved release), Help.

**Today widget:** next appointment with team photo + cert badges; preferences last updated date.

**Notifications:** SMS or videophone-friendly notification (per their preference) 24h and 2h before a job; in-app when a preferred interpreter is assigned.

**Top 5 actions:** flag preferred interpreter, flag do-not-assign, update communication preference, request a future job, request a session transcript.

### B3.7 Auditor View

Rabia's view. Read-only log explorer.

```
+-----------------------------------------------------------+
| AUDIT · Acme Agency · Rabia M. (external auditor)         |
+-----------------------------------------------------------+
| Filters: [User v] [Record v] [Action v] [Date range]      |
+-----------------------------------------------------------+
| 2026-05-14 10:14:22  Lin K.  REASSIGN  job/8821  →DeShawn |
| 2026-05-14 10:13:55  Lin K.  CANCEL    job/8819  reason=… |
| 2026-05-14 09:58:01  Anthony BG-VIEW   tenant/acme  why=… |
+-----------------------------------------------------------+
| [Export CSV] [Request PHI access for record …]            |
+-----------------------------------------------------------+
```

PHI is masked by default. Rabia clicks "Request PHI access" on a specific record, types a justification, and a separate row gets logged. If the agency admin has pre-granted her PHI access for an open investigation, the click is one tap; otherwise it requires admin approval.

**Screens:** Log Explorer, Saved Queries, Exports, PHI Access Requests.

**Top actions:** filter, export CSV, drill into a record's full history, request PHI unlock.

### B3.8 Platform-Owner Cross-Tenant Console (Anthony)

```
+-----------------------------------------------------------+
| 1891 OPS · cross-tenant (BREAK-GLASS REQUIRED)            |
+-----------------------------------------------------------+
| Select tenant: [ Acme Agency v ]                          |
| Why are you entering this tenant? (required, logged)       |
| [_______________________________________________________] |
| Affected agency admin: Fallon B. — will be notified now.  |
| [ Confirm and enter ]   [ Cancel ]                        |
+-----------------------------------------------------------+
```

Every action thereafter is logged with `cross_tenant=true`, the justification string, and Anthony's session ID. The agency admin gets a real-time email + SMS: *"Anthony (1891 platform support) entered your tenant at 10:14:22 ET. Reason: 'Investigating WebSocket disconnect reported in ticket #4421.' His session expires automatically at 11:14:22 ET. Reply STOP to revoke immediately."*

Anthony cannot edit or delete the cross-tenant log. Even his own audit entries are append-only.

---

## B4. Team interpreter dynamics

A "team" job has more than one interpreter assigned because the work cannot safely be done by one person. The canonical case is a CDI + hearing ASL interpreter pairing, but teams are also routine for any assignment over 90 minutes (fatigue-related accuracy degradation is documented), and for any setting that is high-stakes-by-default (surgical, forensic, legal deposition, mental-health intake, conference platform).

**Flagging "needs team" at intake** happens in three ways:
1. **Requestor self-flags** in the New Request form via a "Setting" dropdown (Surgical / Forensic / Deposition / Mental Health / Conference / Other) — selecting any high-stakes setting pre-checks "Team recommended."
2. **NL intake parser** detects duration > 90 min, or detects phrases like "psych eval," "grand jury," "all-day training" and pre-flags.
3. **Scheduler manually flags** based on knowledge the parser doesn't have ("this Deaf consumer is non-standard ASL, we always team CDI here").

**Roles within a team:**
- **Primary** — leads the assignment, takes the first "on-mic" rotation, owns the prep packet.
- **Voicer** (for CDI jobs) — the hearing ASL interpreter who voices what the CDI signs and signs what the hearing party says, for the CDI to consume and re-render to the Deaf consumer in language the consumer actually understands.
- **CDI** — the Deaf interpreter who works with the Deaf consumer directly.
- **Monitor / Support** — the second interpreter on a long assignment, switching every 20–30 minutes with the primary. Monitor also catches errors in real time.
- **Backup** — confirmed standby for high-stakes jobs; paid a reduced "hold" rate per agency policy.

**Coordination tools the platform provides:**
- Shared **job thread** (in-platform chat between assigned interpreters, scheduler, optionally consumer if portal is enabled). Messages are part of the job record and retained per the audit retention policy.
- **Prep materials** uploaded by the requestor (e.g., the deposition's exhibits, the IEP's prior report, the surgical procedure's name + surgeon's typical vocabulary) — visible to all assigned team members 24h before.
- **Rotation plan** field on the job ("DeShawn 0:00–0:30, Marisol 0:30–1:00, swap every 30 thereafter") — purely advisory; the team adjusts in the room.
- **Supervision flag** — a CDI may be assigned as a mentor for a less-experienced CDI; the platform notes this and the senior CDI signs off on the mentee's first 10 mentored jobs.

**Pay split conventions:** Each interpreter is paid **the full posted rate**. Teams do not split a single fee. This is canonical for the industry — pretending otherwise is a way agencies lose interpreters. The platform must compute and pay each team member independently, and the invoice to the requestor reflects the actual cost (two line items for a two-person team). Rate-card setup must support a per-role multiplier (e.g., CDI rate may be set 1.2x of standard ASL) without forcing the agency to manually math it.

**Scheduler's "team configured correctly?" warnings:**
- "This 2-hour deposition has only 1 interpreter assigned; teams recommended above 90 minutes."
- "CDI-required tag is set but no CDI is on the team."
- "CDI is assigned but no hearing voicer is on the team — CDIs cannot work solo with hearing parties."
- "Primary and Monitor are the same person."
- "Backup interpreter has not confirmed within 4 hours of start."

These warnings are non-blocking by default — Lin can override after confirming she knows what she's doing — but they're loud yellow banners on the job detail rail, and the override is logged.

---

## B5. W-2 vs 1099 split

The platform treats staff and contractor interpreters as **different entities at the data model layer**, sharing a common Interpreter base record but with role-specific fields and workflows. Every screen that touches pay, availability, taxes, or job offering branches on this flag.

| Concern | W-2 staff (Priya) | 1099 contractor (DeShawn) |
|---|---|---|
| **Onboarding** | Admin creates account internally. HR docs collected outside the platform (or via a checklist). Cert verification still required. | Self-service magic-link onboarding. Uploads W-9, COI (certificate of insurance), driver's license, cert(s), direct-deposit info. Admin approves after TIN match + cert API verification + COI review. |
| **TIN match** | Not required (handled via payroll provider). | Required. Platform calls IRS TIN match API; failure blocks activation. |
| **Insurance** | Covered by agency policy. | Must upload COI showing professional liability + auto, naming the agency as additional insured (configurable per agency). |
| **Availability** | Published Mon–Fri schedule per agency calendar. Block-outs require approval. | Self-managed. DeShawn marks unavailable hours/days himself; nobody approves. |
| **Job offering** | Sees assigned-to-me directly on dashboard. Can claim from team queue for same-day fills. | Sees a marketplace tab — open jobs matching their language/modality/service area. First-claim or scheduler-pick depending on the job's offering mode. |
| **Cancellation pay** | Per agency policy — typical: paid full rate if cancelled <24h before start. | Per rate-card cancellation policy — typical: 50% of fee if cancelled <24h, 100% if cancelled <2h. |
| **Pay flow** | Hours captured in-platform → exported to ADP / Gusto / Paychex via integration → agency runs payroll → interpreter paid through agency payroll bank account. Platform shows estimated pay only. | Job-by-job invoice generated automatically at close → batched weekly → paid via Stripe ACH (platform-native) or pushed to Bill.com if agency uses it. 1099-NEC generated at year-end with downloadable PDF. |
| **Mileage/parking** | Reimbursed per agency policy; capture in platform with receipt photo upload; flows to payroll. | Captured for the interpreter's own records (1099 deductible mileage); does not automatically bill the requestor unless rate card includes mileage pass-through. |
| **Tax forms** | W-2 from agency payroll provider; platform shows nothing tax-related. | 1099-NEC downloadable by Jan 31; YTD income summary at any time; per-job earnings statement on close. |
| **Termination** | Admin offboards; payroll handles final pay. | Admin deactivates from roster; outstanding invoices still pay out per terms. |

---

## B6. The multi-agency 1099 (DeShawn's Tuesday)

DeShawn is on three agencies' rosters: Acme (Frederick), Capitol (Hagerstown), and Bridge (Gaithersburg). One login (`deshawn@gmail.com`), three agency contexts. The platform must handle this without making DeShawn maintain three calendars.

**Agency switcher pattern:** Top-left of the mobile dashboard shows the active agency name with a chevron. Tap → modal with all three agencies, last-active timestamp, count of upcoming jobs per agency. The switcher is purely a *view filter* — DeShawn's underlying schedule data is unified.

**Availability model — recommendation: unified with conflict detection.** DeShawn marks himself unavailable Wed 1–3pm (dentist) and that block is honored across all three agencies. When Capitol's scheduler tries to assign him to a Wed 2pm job, the system shows "DeShawn unavailable 1–3pm Wed" — *without* leaking which agency or what type of conflict (privacy across agencies matters). Capitol's scheduler sees "unavailable"; she does not see "booked with Acme."

**Conflict detection across agencies:** When Capitol offers DeShawn a Tuesday 10–12 job, and DeShawn already has Acme 9–11 on Tuesday, the offer screen on DeShawn's mobile shows a red banner: "Conflict with another assignment 9–11. Decline this offer or resolve the conflict first." The other agency is never named; DeShawn knows.

**Separate financial views per agency:** Pay tab in DeShawn's mobile dashboard defaults to "All agencies, this period" but can filter to one. 1099-NEC is generated *per agency* (since each is a separate payer); the platform downloads them as a bundle at year-end. The IRS doesn't care about a unified 1099 — it cares about per-payer accuracy.

**Profile data — agency-specific overrides:** DeShawn's base profile is one record (name, certs, languages, service area, default rate). Each agency can layer overrides: Acme pays him $85/hr, Capitol pays $78/hr, Bridge has a flat $90 with a 2hr minimum. The mobile profile screen shows the base; the agency-context-active rate is shown next to each agency in the switcher.

**Tech note for Section D:** identity is keyed on `interpreter.email` globally; each agency has an `agency_interpreter` join row carrying the agency-specific overrides, marketplace eligibility, and onboarding state.

---

## B7. Onboarding flows per role

Every onboarding flow uses the 1891 standard magic-link pattern (Apps Script issues a one-use token, redirect lands the user on a self-service form). No passwords. No "click here to verify your email" loops.

**Agency Admin (Fallon):**
- Invited by: Anthony at platform onboarding, or by an existing agency admin promoting a user.
- Screens: agency profile (name, EIN, address, brand color, logo, ASL welcome video upload) → Deaf-owned verification opt-in (uploads ownership docs; Anthony reviews and approves) → rate card setup wizard (per language, per modality) → cancellation policy wizard → integrations (Stripe Connect, payroll provider OAuth, optional Bill.com) → invite scheduler(s).
- Validated: EIN format, address geocode, Stripe Connect verification (KYB), Deaf-owned docs reviewed manually.
- Becomes active: after Stripe Connect approval (required for payouts) and at least one scheduler invited.

**Scheduler (Lin):**
- Invited by: agency admin.
- Screens: name, contact, photo (optional), office location, working hours, default landing view (Today / Tomorrow / Week).
- Validated: email reachable (magic-link click confirms).
- Becomes active: immediately on magic-link confirm.

**Interpreter W-2 (Priya):**
- Invited by: agency admin.
- Screens: name, contact, languages, modalities, certs (uploads + manual entry of cert number + expiry), service area (county multi-select + map), photo, ASL self-intro video (optional).
- Validated: certs verified via RID / BEI / NIC / state-specific API where available; admin verifies the rest. Drivers license uploaded for ID match.
- Becomes active: after admin clicks "Activate."

**Interpreter 1099 (DeShawn):**
- Invited by: agency admin (or self-applied via the agency's public-facing "join our roster" page).
- Screens: identity (legal name, address, SSN/EIN for TIN match, DOB for KYC) → docs (W-9, COI, drivers license, certs) → profile (languages, modalities, service area, default rate ask, vehicle/parking notes) → bank (Stripe ACH for payouts) → agreement (independent contractor agreement, ASL-explained video alongside the text version).
- Validated: IRS TIN match (real-time API), cert verification API, COI auto-OCR for expiry + named-insured + coverage minimums, drivers license barcode scan for identity match, Stripe identity verification.
- Becomes active: after admin reviews the COI + agreement and clicks "Activate." DeShawn sees "pending review" until then with an estimated 1–2 business day SLA.

**CDI (Marisol):** same as 1099 above plus CDI-specific cert verification (RID-CDI).

**CART captioner (Jordan):** same as 1099 above plus NCRA-CRC verification and remote-tech check (uplink speed test, redundant audio path documented).

**Translator (Aiyana):** same as 1099 above minus service-area (translation is location-agnostic), plus a translation-sample upload reviewed by the agency.

**Requestor Contact (Mariana):**
- Invited by: agency scheduler or admin who attaches her to the Requestor org, OR by the Requestor org's own admin contact.
- Screens: name, contact, role at the org, default location (if she works at one of multiple clinics under the org), notification preferences.
- Validated: email reachable.
- Becomes active: immediately on magic-link confirm.

**Payer (Karen):**
- Invited by: agency admin (after the master service agreement is signed and the Payer entity is created against the Requestor).
- Screens: name, contact, AP system in use, preferred payment method (ACH / check / Stripe), bank for ACH (if applicable, via Stripe).
- Validated: email reachable; Stripe bank verification if ACH.
- Becomes active: immediately on magic-link confirm; payment method live after Stripe verifies bank.

**Consumer (Mr. Park):**
- Invited by: agency admin opts in the tenant; specific consumer invited by scheduler or by themselves via "request access" link on the agency's public site.
- Screens: name, preferred language(s), modality preferences (ASL / tactile / PSE / spoken Spanish / etc.), communication preference (videophone number / SMS / email — videophone always offered), CDI-preferred flag, preferred and do-not-assign interpreters (populated from past assignments after consent).
- Validated: identity confirmed by the agency before activation (because the consumer record holds PHI; we don't want an impostor claiming an existing record). Agency confirms by phone or in person at the next appointment.
- Becomes active: after agency confirms identity. Read-only access until then.

**Auditor (Rabia):**
- Invited by: agency admin under a time-bounded engagement (start date, end date, default PHI-no-access).
- Screens: name, contact, scope of engagement (which date range / which records).
- Validated: email reachable; engagement scope reviewed and saved as the activation record.
- Becomes active: at the engagement start date, auto-deactivates at the end date.

---

## B8. Accessibility commitments (every dashboard)

Accessibility is the product, not a feature. Built by a Deaf-family admin (Anthony, fifth-generation Deaf since 1891; Fallon, CDI, Gallaudet-trained) for an industry whose entire purpose is communication access. The bar is higher than legal minimums because the users will notice if it's not.

- **WCAG 2.2 AA across every surface**, verified by automated scan (axe-core in CI on every PR) plus quarterly manual audit by a Deaf accessibility consultant.
- **Audio cues always have visual + haptic partners.** A chime when a job is assigned to you also flashes the status pill, increments a badge, and (on mobile) vibrates. Mute the speakers, unplug the headphones — the platform still works.
- **ASL videos for every onboarding screen**, recorded by a credentialed interpreter (default: Fallon). Each agency can replace with their own preferred interpreter; the system stores both the agency's video and the 1891 default and falls back gracefully.
- **Every interactive element keyboard-operable.** Lin uses keyboard shortcuts as her primary input; the platform must serve that. Tab order is sane; focus indicators are loud (3px contrast-compliant ring); arrow keys move along the timeline; `A` assigns, `R` reassigns, `C` cancels, `/` opens command palette.
- **Color is never the sole information channel.** Unfilled = yellow background **plus** triangle icon **plus** the literal word "Unfilled." Conflict = red **plus** ⚠ **plus** "Conflict." A grayscale screenshot of the dashboard must remain fully legible.
- **Captions default-on whenever the platform plays audio** — consumer playback of a captured session, ASL onboarding videos, recorded scheduler announcements. The user can turn captions off; they're never opt-in.
- **High-contrast mode toggle** per user (persisted to profile). Default theme is already 4.5:1 minimum; HC mode pushes to 7:1+.
- **Text size adjustable to 200%** without horizontal scroll or layout break, verified via responsive testing. Density-critical screens (Lin's timeline) get a "compact / comfortable / large" toggle.
- **Screen-reader tested on every release** with VoiceOver (macOS, iOS), JAWS (Windows), NVDA (Windows), and TalkBack (Android). Release notes call out any regressions and block deploy if a P0 SR bug is open.
- **VRS-friendly contact paths.** Wherever the platform captures a phone number (consents, two-factor, requestor callback), it never blocks a videophone area code. SMS-based 2FA has a videophone fallback ("we'll have a relay admin call you with the code"). Consents recorded by phone are also accepted by videophone with a stored video artifact.
- **DeafBlind considerations.** Consumer profile has tactile-ASL and Pro-Tactile modality flags. The MyInterpreter portal supports a high-contrast + 200% + extended-timeout mode that pairs well with refreshable Braille displays. Session reminder timing is configurable (24h / 48h / 72h before).
- **Plain language across all copy.** No "AI-powered transcription" — say "live captions from speech." No "intelligent diarization" — say "we know who spoke when." This is a brand-voice rule and an accessibility rule simultaneously; the cognitive accessibility win is real.
- **No reliance on motion.** Animations are decorative; `prefers-reduced-motion` honored everywhere. Status changes are visible without animation.
- **Time and dates are unambiguous.** "Thu May 14, 2:00pm ET" — never "2pm" without context. Different time zones in interpreter / requestor / consumer profiles are surfaced explicitly on every cross-time-zone job.

This is the floor. We design every screen first as a black-and-white wireframe operable by keyboard with a screen reader narrating; if that version doesn't make sense, the colorful version isn't allowed to ship.

---

*End of Section B. Section C covers the assignment engine, the Smart-Fill scoring logic, the rate-card model, and the conflict-resolution rules referenced above.*
