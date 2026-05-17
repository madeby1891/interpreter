# Section C — Job Lifecycle, Assignment Engine, and Service Coverage

> This is the operational heart of 1891 Interpreter. Every revenue dollar passes through the states, transitions, and scoring decisions documented here. The contract: schedulers go faster, interpreters get fairer offers, Deaf and limited-English consumers get qualified humans on time, and the agency owner can prove every billable minute.

---

## C1. Service modalities and language coverage

The platform must price, schedule, dispatch, bill, and pay across a wide product matrix. Modality dictates surface (in-person, video, phone, file), team rules, billable-minute math, and cancellation policy defaults. Language dictates roster filter, dialect tagging, and — for signed languages — whether a Certified Deaf Interpreter (CDI) team is required.

### Signed-language services (on-site)

- **ASL — American Sign Language (hearing interpreter).** The default sign-language SKU. RID-NIC or state BEI Master typical. Minimum billable unit: 2 hours on-site (industry-standard "2-hour minimum"). Solo up to ~60 minutes content time; team of 2 required for assignments over 90 minutes, dense content (legal, medical, conference), or high-stress emotional content. Typical agency bill rate: $75–$140/hr; interpreter payout: $55–$95/hr. Premium tiers for legal, mental health, evenings, weekends.
- **CDI — Certified Deaf Interpreter team.** A Deaf interpreter (native ASL user) paired with a hearing ASL "voicer." Required for: very young Deaf children, Deaf+ consumers (Deaf with cognitive/developmental disability), foreign-born Deaf consumers using a non-ASL signed language or "home signs," courtroom proceedings of any complexity, mental-health intakes, medical end-of-life conversations. CDI rate equals or exceeds hearing rate; both interpreters paid in full. Two-person team default; sometimes three (CDI + hearing voicer + hearing relief).
- **Oral interpreting (lipreading-focused).** Hearing oral transliterator silently mouths the speaker's words for a Deaf or hard-of-hearing consumer who reads lips. Smaller pool of certified providers (RID-OTC). Common in legal depositions and some medical settings. Solo to 60 minutes; team over.
- **DeafBlind tactile / Pro-Tactile.** Tactile reception (Deaf consumer feels signs on their hands) or Pro-Tactile (touch-based feedback on body, evolved Deaf-led methodology). Always team of 2 minimum; team of 3 for over 90 minutes due to physical stamina. Highest skill premium of any sign modality. Often paired with **SSP — Support Service Provider** for navigation, environmental description, and sighted-guide work; SSP is a separate SKU at a lower rate than tactile interpreting.
- **Trilingual — Spanish/English/ASL.** Used heavily in immigrant Deaf-Latine communities. Trilingual cert (RID-CDI with Spanish, or state trilingual cert) commands ~25% premium over ASL-only.
- **Educational K–12.** State-specific EIPA score required (e.g., EIPA 4.0 minimum in many states; 4.5 for high-school content). Often filled by long-term placements (full school year), not job-by-job. Special handling: school-calendar awareness, IEP team participation rules, FERPA-bound notes, no recording of student speech without parent consent.
- **Postsecondary / college.** RID cert typical; service often hourly with strict semester schedules.
- **Medical.** RID-NIC plus medical-specialty training (CMI is the bilingual-Spanish credential; for ASL the bar is RID-NIC + documented medical setting hours, or specific state QMHI). Mandatory in HIPAA settings; the platform stores BAA status and refuses to assign non-BAA interpreters to Title-III covered entities.
- **Mental health.** QMHI (Qualified Mental Health Interpreter) credential or documented mentorship; trauma-informed practice. Solo only if under 50 minutes; team required for forensic eval, custody eval, group therapy.
- **Legal — non-court.** Depositions, mediations, attorney-client meetings, immigration interviews. SC:L (Specialist Certificate: Legal) preferred for high-stakes; otherwise RID-NIC plus legal training hours.
- **Court — state.** State court-certified roster (varies by state; in MD, the Administrative Office of the Courts list). Solo only for under-60-min proceedings; team default.
- **Court — federal.** Federal-court-certified spoken-language interpreters or RID-SC:L for ASL. Premium tier; subject to GSA-equivalent ceiling rates in some venues. Mandatory team for any trial day.
- **Insurance.** IME, workers-comp, accident-reenactment. Standard medical rate.
- **Social services.** DSS, DHS, parole, drug-court diversion. Often state-funded; payer caps frequent.
- **Religious.** Lower-rate tier in many regions; some interpreters specialize.
- **Conference — sign language.** Platform stage, often simultaneous on a feed. Team of 2 minimum, rotating every 20 minutes. Tech rider required (confidence monitor, light, platform position).

### Spoken-language services (on-site)

Required language SKUs (30+). Each gets a separate roster filter + dialect sub-tag. Cert hierarchy: ATA / state-court-certified / CMI (Certified Medical Interpreter — CCHI or NBCMI) / qualified-bilingual-staff (lowest tier).

Spanish (Mexico / Caribbean / South-American / Castilian sub-dialects), French (Metropolitan / Canadian / West-African), Haitian Creole, Portuguese (Brazilian / European), Italian, Mandarin (Simplified / Traditional written; Standard Mandarin / Cantonese / Taiwanese-Mandarin spoken), Cantonese, Vietnamese, Korean, Tagalog, Japanese, Thai, Khmer, Lao, Hmong, Burmese, Karen, Nepali, Hindi, Urdu, Punjabi, Bengali, Gujarati, Tamil, Telugu, Arabic (MSA / Egyptian / Levantine / Iraqi / Gulf / Maghrebi), Farsi/Dari/Pashto, Kurdish (Sorani / Kurmanji), Turkish, Russian, Ukrainian, Polish, Czech, Romanian, Bulgarian, Serbian/Croatian/Bosnian, Albanian, Greek, Hebrew, Yiddish, Amharic, Tigrinya, Somali, Swahili, Oromo, Igbo, Yoruba, Wolof, Fulani, Lingala, Kinyarwanda, Quechua, K'iche', Mam, Q'anjob'al, Mixteco (the Mayan and Mexican-indigenous languages are critical for federal-court immigration work and often under-served).

Special handling: indigenous Mexican languages frequently relay through Spanish; rare-language jobs may require remote interpreters from out-of-state and travel pay; cert is often "qualified," not certified, and the platform must capture that distinction explicitly.

### Video Remote Interpreting (VRI)

Live video session, often on-demand or scheduled. Two flavors: (1) **agency-hosted** — the consumer/requestor joins the platform's WebRTC client embedded in the meeting link, (2) **external** — interpreter joins the requestor's Zoom / Teams / Doxy.me. Average call length 8–25 minutes; healthcare averages 11 minutes. Bill in 5- or 15-minute increments, not 2-hour minimums. Quality monitoring (jitter, packet loss, RTT) surfaced in interpreter UI; auto-failover to backup interpreter if connection drops.

### Over-the-Phone Interpreting (OPI)

Voice-only, spoken-language only. Twilio-backed dial-in line per agency, then conference-bridge with the on-demand interpreter. Call length frequently under 5 minutes; bill in 1-minute increments after first-minute floor. Highest volume product by call count, lowest revenue per call. Marketplace cascade is effectively instant — first qualified interpreter to pick up wins.

### CART (Communication Access Realtime Translation)

NCRA-certified captioner produces verbatim text in real time. On-site CART (captioner at venue with steno + projector), remote CART (captioner remotes in, captions stream to attendee screens), hybrid (one on-site, one remote backup). 2-hour minimum on-site; remote billed in 1-hour increments. Team of 2 for events over 90 minutes (captioners fatigue like interpreters).

### C-Print / TypeWell

Meaning-for-meaning text — captioner compresses for readability, not verbatim. Cheaper than CART; common in K–12 and undergraduate classrooms. Distinct cert (TypeWell or C-Print transcriber credential). Bill rate 60–70% of CART.

### Document translation

Written source → written target. File-based, asynchronous, longer turnaround (24h–10 business days depending on length and complexity). Sub-types:
- **Certified translation** — translator's signed attestation of accuracy; required for USCIS immigration filings, state vital records, court evidence.
- **Notarized translation** — certified translation + notary stamp on attestation; required for some legal filings.
- **ATA-certified** — performed by an American Translators Association certified translator in the relevant pair; commands premium.
- **Medical** — HCP-reviewed; back-translation step optional for high-stakes patient-facing material.
- **Technical** — engineering, pharma, regulatory; subject-matter glossary required.
- **Marketing localization** — transcreation, not translation; pricing is per project, not per word.
- **School IEP / 504 documents** — FERPA-protected; document never leaves the agency tenant; translator works in a watermarked viewer; final delivery is encrypted PDF; retention is hard-deleted at year-end.

Bill per source word ($0.18–$0.45 depending on language and certification level). Minimum project fee. Translation Memory (TM) and termbase per client.

### Audio/video transcription + translation

Recording → transcript in another language. Two steps: transcribe source, translate transcript. Bill per audio minute + per translated word, or as a flat per-minute rate if the agency prefers simple pricing. Speaker diarization required for multi-speaker recordings; the platform's STT (Deepgram Nova-3, per the speech-processing contract) drafts the transcript and the human translator polishes and translates.

### Sight translation

A document is read aloud, on the fly, in the target language at a meeting. Common in legal (reading a plea form to a defendant), medical (reading consent), social services. Billed as part of the on-site assignment, not separately, but the engine tags the requirement so the assigned interpreter has the document at least 30 minutes pre-job.

### Conference interpreting

Simultaneous, often in a booth with proper equipment (interpreter console, headset, ISO-2603 booth or tabletop equivalent). Team of 2 per language pair minimum; 3 for full-day. Relay common (Mandarin → English → ASL means 2 hops, 3+ interpreters in the chain). Equipment rental coordination is a first-class platform feature.

### Asynchronous video translation

Deaf consumer records ASL on phone → uploads → ASL-fluent translator returns English text or English audio. Used by government agencies for accessible-form completion and by businesses for accessible-feedback channels. Bill per source minute; turnaround 24–72 hours.

### SKU summary table

| Modality | Typical duration | Team requirement | Typical bill rate | Platform features required | Notes |
|---|---|---|---|---|---|
| ASL on-site | 1–4 hrs, 2-hr min | Solo <90m, Team ≥90m | $75–$140/hr | Roster, geo, team-assembly | Default |
| CDI team | 1–4 hrs, 2-hr min | Always team of 2 | $150–$260/hr (both) | Team-assembly, CDI roster | Required pediatric, foreign-born Deaf, complex legal |
| Oral transliteration | 1–3 hrs | Solo <60m, team ≥60m | $85–$150/hr | RID-OTC roster filter | Smaller pool |
| Tactile / Pro-Tactile | 2–8 hrs | Team of 2, often 3 | $110–$200/hr per | SSP pairing, stamina rotation | DeafBlind |
| SSP (support service) | 2–8 hrs | Solo | $35–$70/hr | Separate roster, geo, mobility notes | Not interpreting, support |
| Trilingual Sp/Eng/ASL | 1–4 hrs | per ASL rules | $95–$180/hr | Trilingual cert filter | Immigrant Deaf-Latine |
| Educational K–12 | Semester / full-day | per state EIPA | $45–$80/hr | EIPA filter, school calendar | Often staffed long-term |
| Medical | 0.5–4 hrs | per modality | $85–$170/hr | BAA flag, HIPAA logging | |
| Mental health | 1–2 hrs | Solo <50m, team ≥50m | $110–$200/hr | QMHI filter, trauma-informed | |
| Legal (non-court) | 1–4 hrs | per modality | $100–$200/hr | SC:L filter | |
| Court (state) | 0.5–8 hrs | Team default | $90–$180/hr | State-court roster | |
| Court (federal) | 0.5–8 hrs | Team always | $120–$220/hr | Federal-court roster | GSA-style caps |
| Conference (signed) | Half/full-day | Team 2–3 | $1,200–$2,400/day | Equipment, run-of-show, tech rider | |
| Spoken on-site (common) | 1–3 hrs, 2-hr min | Solo | $55–$110/hr | Roster, dialect tag | |
| Spoken on-site (rare/indigenous) | 1–3 hrs | Solo, often relay | $90–$200/hr | Rare-language network, relay engine | Travel pay common |
| VRI (agency-hosted) | 5–30 min | Solo | $2.00–$3.75/min | WebRTC, quality monitor, failover | |
| VRI (external Zoom/Teams) | 15–60 min | Solo | $95–$160/hr | Calendar invite, dial-in | |
| OPI | 1–10 min | Solo | $1.10–$2.25/min | Twilio bridge, instant cascade | |
| CART on-site | 1–4 hrs | Solo <90m, team ≥90m | $130–$220/hr | Steno + projector kit | |
| CART remote | 0.5–4 hrs | Solo | $100–$175/hr | Streamtext or equivalent | |
| C-Print / TypeWell | 1–4 hrs | Solo | $75–$120/hr | Distinct cert filter | |
| Doc translation (general) | 24h–10d | Solo + reviewer | $0.18–$0.30/word | TM, glossary, file vault | |
| Doc translation (certified) | 48h–10d | Solo + attestation | $0.25–$0.45/word + cert fee | Attestation generator | USCIS, court |
| Doc translation (IEP) | 3–7 business days | Solo | $0.22–$0.32/word | FERPA vault, watermark, hard-delete | School |
| Transcription + translation | per minute audio | Solo (STT-assisted) | $4–$10/audio-min | STT pipeline, diarization | |
| Sight translation | Within on-site job | n/a | included in on-site rate | Pre-job doc share | |
| Async ASL video translation | 24–72 hrs | Solo | $5–$12/source-min | Video vault, upload UI | |

---

## C2. Job lifecycle — full state machine

The lifecycle has one main spine and a small constellation of side states. Every transition writes a row to `job_events` (event-sourced) with `actor_id`, `actor_role`, `from_state`, `to_state`, `reason_code`, `metadata_json`, `ts`. The Cloudflare Durable Object per agency holds the hot copy of every open job; the Apps Script Sheet is the audit ledger.

### Main spine (ASCII)

```
   ┌────────┐    submit     ┌───────────┐  auto-triage   ┌────────┐
   │ DRAFT  │──────────────▶│ SUBMITTED │───────────────▶│ TRIAGE │
   └────────┘               └───────────┘                └────┬───┘
                                                              │ scheduler-lock
                                                              ▼
                                                          ┌────────┐
                                                          │  OPEN  │
                                                          └────┬───┘
                                                               │ engine-offer
                                                               ▼
                                                          ┌─────────┐
                                                          │ OFFERED │
                                                          └────┬────┘
                                                               │ interpreter-claim
                                                               ▼
                                                       ┌──────────────┐
                                                       │   ASSIGNED   │
                                                       └──────┬───────┘
                                                              │ interpreter-confirm
                                                              ▼
                                                       ┌──────────────┐
                                                       │  CONFIRMED   │
                                                       └──────┬───────┘
                                                              │ tap "en route"
                                                              ▼
                                                       ┌──────────────┐
                                                       │   EN_ROUTE   │
                                                       └──────┬───────┘
                                                              │ tap "arrived"
                                                              ▼
                                                       ┌──────────────┐
                                                       │   ON_SITE    │
                                                       └──────┬───────┘
                                                              │ tap "started"
                                                              ▼
                                                       ┌──────────────┐
                                                       │ IN_PROGRESS  │
                                                       └──────┬───────┘
                                                              │ tap "ended"
                                                              ▼
                                                       ┌──────────────┐
                                                       │   COMPLETE   │
                                                       └──────┬───────┘
                                                              │ scheduler-review + lock-minutes
                                                              ▼
                                                       ┌──────────────┐
                                                       │    CLOSED    │
                                                       └──────┬───────┘
                                                              │ billing-run
                                                              ▼
                                                       ┌──────────────┐
                                                       │  INVOICED    │───┐
                                                       └──────┬───────┘   │ parallel
                                                              │           ▼
                                                              │      ┌──────────┐
                                                              │      │ PAYABLE  │
                                                              ▼      └────┬─────┘
                                                       ┌──────────────┐  │ payroll-run
                                                       │    PAID      │  ▼
                                                       └──────────────┘  ┌──────────┐
                                                                         │ PAID_OUT │
                                                                         └──────────┘
```

### Side states (entry points marked)

```
 from any active state:
   ─▶ CANCELLED_BY_REQUESTOR  (sub_reason, hours_notice)   billable per policy
   ─▶ CANCELLED_BY_AGENCY     (sub_reason)                 no bill, may still pay
   ─▶ CANCELLED_BY_INTERPRETER (sub_reason)                re-opens job, reliability hit
   ─▶ NO_SHOW_REQUESTOR       (after ON_SITE + grace)      full bill, full pay
   ─▶ NO_SHOW_INTERPRETER     (after CONFIRMED + grace)    no pay, reliability hit
   ─▶ RESCHEDULED             creates linked successor job
   ─▶ PARTIAL                 from IN_PROGRESS, actual<scheduled
   ─▶ DISPUTED                from CLOSED/INVOICED/PAYABLE
   ─▶ HOLD                    blocks engine until released (insurance pre-auth, consumer confirm)
```

### Transition table

| From | To | Trigger | Preconditions | Side effects | Allowed roles | Reversible? |
|---|---|---|---|---|---|---|
| – | DRAFT | requestor saves form mid-fill | none | row written; no notify | requestor, scheduler | yes (discard) |
| DRAFT | SUBMITTED | requestor hits "Submit" | required fields valid | confirmation email; sheet row; scheduler queue ping | requestor, scheduler | no |
| SUBMITTED | TRIAGE | auto on submit | – | auto-tag (modality, lang, cert, est-duration, est-travel) | system | no |
| TRIAGE | OPEN | scheduler "Lock job" | tags confirmed, payer valid | engine eligible | scheduler | yes → TRIAGE |
| TRIAGE | HOLD | missing pre-auth or consumer confirm | – | notify requestor "info needed" | scheduler | yes |
| OPEN | OFFERED | engine fires offers | candidate pool ≥1 | push+SMS+email to N candidates | system, scheduler | yes (cancel offer) |
| OFFERED | OFFERED | candidate declines; cascade | window expired or decline | next candidate notified | system | – |
| OFFERED | OPEN | cascade exhausted | – | "needs manual sourcing" flag | system | yes (re-run) |
| OFFERED | ASSIGNED | interpreter claims | within window, still qualified | competing offers withdrawn; calendar block | interpreter | yes → OPEN if scheduler revokes |
| ASSIGNED | CONFIRMED | interpreter confirms details | logistics acknowledged | requestor notified "interpreter confirmed (name redacted by policy)"; prep materials sent | interpreter | yes within 1hr |
| CONFIRMED | EN_ROUTE | interpreter tap | within travel window | scheduler sees ETA; requestor NOT notified by default | interpreter | yes |
| EN_ROUTE | ON_SITE | interpreter tap (geofence assist) | within X meters or self-attested | scheduler sees on-site; timer begins | interpreter | yes |
| CONFIRMED/EN_ROUTE | NO_SHOW_INTERPRETER | grace window passed (15 min default) | no "on-site" tap | replacement cascade fires; reliability event | system, scheduler | yes (with note) |
| ON_SITE | NO_SHOW_REQUESTOR | scheduler confirms after 15-min grace | interpreter waited the floor | full-bill flag; interpreter paid in full | scheduler | yes |
| ON_SITE | IN_PROGRESS | interpreter tap "started" | – | billable_minutes_running=true | interpreter | yes |
| IN_PROGRESS | COMPLETE | interpreter tap "ended" | – | billable_minutes_locked; close-out form | interpreter | yes within 24h |
| IN_PROGRESS | PARTIAL | tap "ended early" with reason | actual < scheduled | partial-bill rules; reason captured | interpreter, scheduler | yes |
| COMPLETE | CLOSED | scheduler review + minute lock | duration sane, no open dispute | sheet append-only; invoice eligible | scheduler | no |
| CLOSED | INVOICED | nightly billing run | requestor billing terms allow | invoice PDF emitted; AR row | system | no (issue credit memo) |
| CLOSED | PAYABLE | nightly payroll qualifier | interpreter W9/W8 on file | AP row queued | system | no |
| INVOICED | PAID | payment posted | matched in payment provider | AR closed; receipt | system, finance | no (refund flow) |
| PAYABLE | PAID_OUT | payroll run completes | scheduled cycle | direct-deposit or check; 1099 accrued | system, finance | no (reversal flow) |
| any active | CANCELLED_BY_REQUESTOR | requestor cancel | – | cancellation policy applied; interpreter notified; reliability NOT affected | requestor, scheduler | no |
| any active | CANCELLED_BY_AGENCY | scheduler cancel | – | requestor notified; interpreter paid per policy | scheduler, admin | no |
| OFFERED..CONFIRMED | CANCELLED_BY_INTERPRETER | interpreter cancel | – | re-open + cascade; reliability event | interpreter, scheduler | no |
| CONFIRMED | RESCHEDULED | mutual agreement | – | linked successor DRAFT; original closed-out as rescheduled | scheduler | no |
| CLOSED..PAID/PAID_OUT | DISPUTED | requestor/interpreter dispute | within 30 days | freeze payout/AR; ticket opens | requestor, interpreter, scheduler | yes on resolution |
| HOLD | OPEN | unblock condition met | – | engine eligible | scheduler | – |

Note: state transitions are append-only events. The "current state" is a materialized view of the event stream, not a mutable field. This is what lets us reconstruct exactly what happened during a dispute and what lets the Apps Script Sheet stay the system of record without lock contention.

---

## C3. Intake to assignment — the happy path step by step

1. **Request lands.** Four entry channels. (a) **Web form** at `/request` — a single-page form with conditional sections per modality. (b) **NL intake** — email to `book@<agency-domain>` or SMS to the agency's Twilio number; covered in Section D; parsed to a structured draft and dropped into `TRIAGE` with a low confidence flag if any field is ambiguous. (c) **Phone call** — scheduler types into an "Add job" panel that mirrors the web form; this is the most common channel for legacy-relationship customers. (d) **Recurring template** — a saved template ("every Tuesday 2pm, Mr. Johnson's dialysis at Fresenius Frederick, 60 minutes, ASL, RID-NIC, prefer Sara K., backup Marcus T.") spawns a new SUBMITTED job N days out, configurable per template.

2. **Triage (auto-tagging).** The Triage worker enriches the job with: detected modality, detected language(s) and direction (e.g., en→es, en↔ASL), required cert level from setting (e.g., "court → SC:L"), estimated team requirement (e.g., "duration ≥90m → team=2"), estimated duration if not explicit, estimated travel from the assigned region's centroid, payer record from requestor email/domain, billing terms (Net-15 / Net-30 / prepay), consumer record if a Deaf consumer is named (and the consumer's preferences pull in: preferred interpreters, do-not-assign list, communication preferences). The Triage worker also runs duplicate detection: similar requestor + similar time window + similar location triggers a "possible duplicate?" flag.

3. **Scheduler review.** The job appears on the Open Board sorted by `job.start_at - now()` ascending. Scheduler clicks in, confirms or fixes tags, confirms requestor details, attaches any received documents (intake form, prep materials, prior interpreter's notes), and hits **Lock Job**. Lock transition: `TRIAGE → OPEN`. The Sheet now has a permanent row; the Durable Object holds the live state.

4. **Assignment — Smart Fill.** Scheduler clicks **Smart Fill**. The engine (Section C4) returns a ranked list with score breakdown. The default UI shows the top-3 with a hover-card explaining each component score. Scheduler can: (a) accept the top suggestion → cascade fires; (b) pick a different ordering and fire; (c) skip the engine and offer to a specific interpreter ("Specific Request" mode); (d) push to marketplace immediately (skipping cascade) for last-minute jobs. Transition: `OPEN → OFFERED`.

5. **Offer and response.** The offered interpreter receives: a push notification to the mobile PWA, an SMS with a short job summary and a deep-link, and an email with full details and an iCalendar attachment. The interpreter has a response window (default 5 minutes for normal jobs, 2 minutes for under-4-hour-notice jobs, 30 seconds for OPI). Three options: **Claim** (full accept), **Decline + reason** (1 of: not available, distance, fee, content concern, COI, other), or **No response** (auto-decline at window close). On claim: `OFFERED → ASSIGNED`, competing offers in the cascade withdrawn, the interpreter's calendar gets a hard block, the Sheet writes the row. On decline / timeout: next candidate gets the offer. If the cascade exhausts: the job either flips to "open marketplace" (any qualified interpreter can grab first-come) or escalates to the scheduler as "needs manual sourcing," per agency policy.

6. **Confirmation.** Within X minutes of claim (default 60), the interpreter must hit Confirm in the app. Confirm requires acknowledging: address, parking, building access, on-site contact, prep materials reviewed, any allergies/safety notes. Transition: `ASSIGNED → CONFIRMED`. The platform sends the requestor a confirmation (interpreter name optionally redacted per agency / consumer policy; some Deaf consumers want to know who's coming, others don't want it shared with the requestor at all). Prep materials, parking notes, building access codes, and the on-site contact name+phone are pushed to the interpreter's PWA.

7. **Day-of.**
   - **T-24h:** automated reminder to interpreter + requestor.
   - **T-2h:** automated reminder to interpreter; "anything change?" prompt to requestor (one-tap "all set" or "update").
   - **T-30m:** check-in nudge to interpreter; if they haven't tapped Confirm-of-confirm by T-15m, scheduler is paged.
   - **Interpreter taps "En route":** `CONFIRMED → EN_ROUTE`. ETA computed from current GPS and shared with the **scheduler only by default**, not the requestor. Rationale: an interpreter caught in traffic doesn't need a requestor texting them; the scheduler triages. Agency policy may opt-in to requestor ETA visibility per contract.
   - **Interpreter taps "Arrived":** `EN_ROUTE → ON_SITE`. Optional geofence assist confirms within radius; if not, interpreter self-attests with one tap.
   - **Interpreter taps "Started":** `ON_SITE → IN_PROGRESS`. Billable timer starts.
   - **Interpreter taps "Ended":** `IN_PROGRESS → COMPLETE`. Timer stops. Close-out form opens.

8. **Close-out.** Interpreter completes: actual start/end (defaults to tap timestamps), actual duration (with deviation reason if outside scope), any incident report, any notes for the next interpreter on a recurring, optional voluntary feedback to the requestor (separate flow, never tied to pay), and — if the requestor still uses paper — capture a photo of the signed paper timesheet (we still produce the digital timesheet PDF as the canonical record). Scheduler reviews within 24h; if no exception, the job transitions `COMPLETE → CLOSED` and `billable_minutes_locked = true`.

9. **Audit.** Every event from step 1 → step 8 is in `job_events`. Invoice and payout cycles consume the locked rows. Disputes reopen against the event stream.

---

## C4. The assignment engine

This is the brain. Build it transparent and explainable from day one; the second a scheduler can't tell why the engine surfaced a candidate, they stop trusting it and go back to spreadsheets.

### C4.1 Inputs (per job)

- **Language(s)** with directionality and dialect (e.g., `{src: en, tgt: es-MX, bidirectional: true}` or `{src: en, tgt: ASL, bidirectional: true}`).
- **Modality.** `on_site | vri_internal | vri_external | opi | cart_onsite | cart_remote | cprint | doc_translation | transcription | sight | conference_booth | async_video`.
- **Setting / domain.** `medical | mental_health | legal_noncourt | court_state | court_federal | k12 | postsecondary | social_services | insurance | religious | conference | business | community`.
- **Required cert level.** Computed from setting + agency policy. Examples: `court_federal → FCCI or RID-SC:L`, `medical → CMI or RID-NIC + medical hours`, `k12 → EIPA ≥ 4.0`.
- **Minimum experience.** Years interpreting, or hours in this domain.
- **Date, time, duration.** Absolute start, expected end, time zone.
- **Location.** Lat/lng + access notes; for VRI/OPI/translation, null.
- **Consumer preferences** (when on file and policy allows): preferred interpreters list, do-not-assign list, gender preference (especially in medical reproductive and DV-shelter settings), age range, cultural background, religious accommodations, communication style notes (e.g., "uses tactile but transitions to close-vision for written portions").
- **Requestor preferences.** Preferred interpreters, do-not-assign, billing-account constraints.
- **Team composition.** Slot list with role per slot (e.g., `[hearing_voicer, cdi]`, `[asl_team_lead, asl_team_relief]`).
- **Budget ceiling.** Per-hour or per-job cap (Medicaid, school-district contracts).
- **Urgency.** Computed as `(start_at - now()) / typical_lead_time_for_modality`.
- **COI filters.** From the COI graph (C4.8).

### C4.2 Candidate pool generation

Start with every active interpreter in the roster. Apply hard filters in order (each filter must produce a non-empty result; if not, surface a "loosen filter" suggestion to scheduler):

1. Status active (not suspended, paused, on leave).
2. Modality permitted (interpreter has consented to this modality).
3. Language match including direction and dialect (allow dialect-mismatch with a flag if scheduler approves).
4. Cert level meets requirement (cert on file, not expired, in good standing).
5. Availability — no overlapping confirmed job, calendar shows free, agency-defined buffer respected (default 30 min travel buffer plus modality minimum).
6. Location radius for on-site (default 45 minutes drive at job time, agency-configurable).
7. COI clear (auto-exclude on hard COI, soft COI carries a flag).
8. Agency restrictions (do-not-assign at agency level, contract-restricted-roster jobs).
9. Background-check requirements (some school districts and federal sites require fingerprint + Live Scan on file).

Output: candidate pool with reasons each surviving interpreter passed.

### C4.3 Scoring (transparent, explainable)

Each candidate scored 0–100 by weighted sum. Weights are agency-configurable; below are defaults. **Every signal must be a number plus a one-line human explanation; the UI renders both.**

- **Fit — 40 points.**
  - Exact language + direction + dialect match: 10
  - Cert level meets / exceeds requirement: 10 (meets = 7, exceeds by tier = 10)
  - Setting experience: up to 10 (sliding scale on #completed jobs in this setting in last 24mo)
  - Requestor / consumer prior-success: up to 5 (≥3 prior CLOSED jobs without incident = full)
  - Specialty endorsements: up to 5 (mental health, end-of-life, legal subspecialty)

- **Availability / Reliability — 20 points.**
  - Currently available + confirmed not over capacity: 5 hard / 0 fail
  - 6-month claim rate: up to 5 (claim_rate × 5)
  - 6-month no-show rate: up to 5 ((1 − no_show_rate) × 5; floor at 0)
  - 6-month on-time arrival rate: up to 5 (on_time_rate × 5)

- **Geo — 15 points.**
  - Drive time at job start: 15 if zero (VRI/OPI/translation), sliding scale (15 at 0 min, 0 at 60 min, configurable curve).

- **Cost — 15 points.**
  - Interpreter rate relative to payer budget: 15 if at-or-under budget median, sliding penalty above; floor at 0 if over ceiling. In "cheapest available" mode, weight rises and the curve steepens.

- **Preference — 5 points.**
  - Consumer's preferred interpreter: 3
  - Requestor's preferred interpreter: 2

- **Workload balance — 5 points.**
  - This interpreter's hours in the current week vs roster median: up to 5 inversely (gives the cushion to the interpreter behind on hours; helps spread work and reduce burnout concentration).

**Explainability requirement:** the scheduler UI shows the score broken into the six buckets, with one-line raw-signal text under each. Example: "Fit: 36/40 — exact ASL+English bidi (10); RID-NIC, meets req (7); 14 medical jobs in 24mo (10); 4 prior jobs with this consumer, no incidents (5); mental-health endorsement (4)."

### C4.4 Modes

- **Best fit (default).** Above weights.
- **Cheapest available.** Cost weight → 70; geo → 20; fit pass/fail at threshold 25/40 in Fit bucket; ignore preference; ignore workload balance.
- **Fastest fill.** Skip ranked surfacing entirely; auto-offer the first interpreter whose availability flag is hot ("on-call" / "marketplace-open") and whose hard filters pass. Used for OPI by default.
- **Specific interpreter request.** Bypass scoring; offer to a single named interpreter with 15-minute response window; on decline, drop back to **Best fit** for the remaining candidates.

Modes are per-job, defaulted from the requestor's contract (e.g., a Medicaid contract may force cheapest-available; a hospital VIP contract may force best-fit only).

### C4.5 Cascading offer

Default: top-3 interpreters offered **in parallel** (not sequential) with a 5-minute window; first to claim wins, the other two get a polite "another interpreter claimed this job" notification and a token of goodwill (no reliability penalty, no slot block). If all three decline / time-out, the next batch of 3 fires. If 9 candidates exhausted without a claim, the job flips to **marketplace mode** — broadcast to all qualified interpreters with notifications enabled; first-come claim. If marketplace is empty after a configurable window (default 10 minutes for last-minute, 30 minutes otherwise), the job escalates: scheduler is paged with an "unfilled" alert and a recommended action (broaden language fluency, broaden cert level, raise rate ceiling, open to partner-agency network).

> Why parallel-3, not strict-sequential? Sequential is fair-feeling but slow; for a 4-hour-out job, sequential with 5-min windows blows 15 minutes before you've even pinged a fourth person. Parallel-3 with first-claim-wins is fast and acceptably fair if the top-3 are genuinely tied — and the score breakdown proves they are. Agency-configurable.

Optional integration with regional mutual-aid networks (RID listservs, state-RID job boards) for last-resort broadcast; outbound only, scrubbed of PII per the security baseline.

### C4.6 Team configurations

The engine treats team assembly as a multi-slot fill, not a single slot.

- **Slot definition.** Each team slot has its own filter (role, cert, language direction) and its own scoring pass.
- **Slot dependencies.** Hard rules: CDI slot requires a hearing_voicer slot in the same team; conference relay slots cascade in language order; CART backup can't be assigned unless CART primary is assigned.
- **Mutual-fit signals.** `fit_bonus = +5` if the two candidates have ≥3 prior CLOSED team jobs without incident. `fit_penalty = -10` on a recorded team incident.
- **Pairing rules.** No two interpreters from a single household assigned to the same team (COI). For CDI teams, the engine prefers a hearing voicer who has worked with the specific CDI before — the voicer carries the CDI's "feed" in real time and rapport matters.
- **Stamina rules.** Over 90 minutes content → 2-person team, 20-minute rotation; over 4 hours → 3-person team for high-density content; tactile and Pro-Tactile always team, 20-minute rotation, often 3-person beyond 90 minutes.
- **Single team-fill transaction.** All slots assigned atomically — the engine doesn't lock half a team. If slot 2 can't be filled in the window, slot 1's offer is withdrawn (politely) and the job is flagged for scheduler attention.

### C4.7 Recurring + bulk jobs

- **Recurring template.** Stored as a parent record with a recurrence pattern (RFC-5545 RRULE) and a child-spawn lead time. Spawns SUBMITTED children. Engine consumes children individually.
- **Hold-the-slot mode.** For weekly recurrings, the engine prefers the original interpreter for the full series; new children auto-offer to that interpreter first with a longer response window (configurable, default 24 hours), then cascade if declined.
- **Bulk import.** School-district CSV upload (or Google Sheet paste) creates a batch of DRAFTs; one batch-review pass by the scheduler lifts them all to OPEN. The engine then runs a batch-assignment job that solves the whole batch as a constraint problem — interpreter X is preferred for jobs A, B, C if she can cover all three rather than splitting across three interpreters with different rapport. Heuristic: greedy with backtracking, capped at a few seconds compute per batch.

### C4.8 Conflict-of-interest engine

A COI graph maintained per-tenant. Nodes: interpreters, consumers, requestors. Edges typed: `relative`, `ex_employer`, `iep_team_member`, `prior_recusal`, `prior_incident`, `legal_recusal_block`, `personal_dispute`. Edges carry a severity (`hard` / `soft`) and an expiry (some recusals expire after 12 months, some are permanent).

- **Hard COI** → auto-exclude in C4.2.
- **Soft COI** → candidate survives but score flagged in UI ("Soft COI: interpreter was on this consumer's IEP team in 2023"). Scheduler decides.
- **Self-disclosure.** Interpreter can flag a COI on the offer screen ("I know this consumer personally — decline"). Self-disclosure auto-writes a node in the graph for future runs.
- **Sensitive consumer flag.** Some consumers (e.g., domestic-violence survivors in a small Deaf community) have a manually curated approved-roster; the engine restricts candidate pool to that list regardless of score.

### C4.9 Edge cases

- **Last-minute (under 4 hours).** Scarcity rate auto-applied per agency policy. Cascade window tightens to 2 minutes per batch. Marketplace opens after first cascade. SLA to fill: 15 min for under-4-hour notice.
- **Holidays / overnight.** Premium tier auto-applied (1.5× or 2× per agency tier table). Engine surfaces "premium-pay job" in the offer so interpreters know.
- **Multi-day assignments.** Engine prefers a single interpreter for continuity, but rotates a second on days 2+ if duration exceeds stamina thresholds; locks the team for the run.
- **Travel jobs (>1 hour drive).** Travel pay per policy (e.g., $0.65/mile + half-rate-per-hour for travel time over 30 min). Engine factors total cost (job + travel) when scoring vs budget.
- **VRI failover.** During an active VRI session, if the assigned interpreter's WebRTC client drops (packet loss spike or disconnect) for > 8 seconds, the Worker auto-pages the backup. Backup interpreters are "warm" — pre-paid retainer for the slot, ready in <30 seconds. If no warm backup, the engine fires a "fastest fill" cascade against marketplace-open interpreters in the right language; meanwhile the requestor sees a "reconnecting" overlay with sign-language and text instructions.
- **Rare-language relay.** When no direct candidate exists (e.g., Mam → English), the engine assembles a relay chain (Mam → Spanish → English with two interpreters) and prices the team accordingly; flags as relay so the scheduler can confirm with the requestor before firing offers.
- **Dialect mismatch.** Engine permits with a soft flag if the candidate's dialect tag is in a defined "mutually intelligible" cluster (e.g., Levantine Arabic ↔ Egyptian acceptable in non-clinical settings; not acceptable in court).

---

## C5. Cancellations, no-shows, replacements

A high-volume operational area. Bad policy here costs an agency 5–10% of revenue and a meaningful share of interpreter trust.

### Cancellation policy editor

Agency configures a policy per contract (or a default per modality). The editor produces a 2-D matrix: rows = hours-of-notice tiers, columns = bill % and pay %.

| Hours notice (modality default) | Bill % to requestor | Pay % to interpreter |
|---|---|---|
| > 48h | 0% | 0% |
| 24–48h | 0% | 0% |
| 12–24h | 50% | 50% |
| 4–12h | 75% | 75% |
| 0–4h | 100% | 100% |
| Day-of, after interpreter en-route | 100% | 100% + travel reimbursement |

Per-modality defaults: OPI cancellations almost always free; conference cancellations stricter (often a 7-day cliff). Per-contract overrides supported (some hospital systems negotiate flat-no-cancel policies). The matrix is rendered to the requestor at booking time so there's no surprise.

### "Location moved" broadcast

Scheduler updates location → fan-out within 30 seconds: push + SMS to every assigned interpreter, push + SMS to the requestor and on-site contact (consent-bounded), push to the consumer if their consent flag allows. The job-record carries an "address-changed" event with old + new + change-reason. If the new address fails geo filter (now too far for the interpreter), the engine surfaces a flag and offers to re-cascade; the original interpreter is given the choice to keep or release before re-cascade fires.

### "Interpreter dropped" replacement

Original interpreter cancels → engine re-fires cascade in **urgent mode** (tighter windows, marketplace earlier). Consumer and requestor get a "new interpreter being assigned" notice; the original interpreter's name is removed from the requestor-visible record (the consumer-visible record, if shared with the consumer, also updates). SLA: 15 minutes to a replacement claim for under-4-hour jobs, 60 minutes otherwise. Failure SLA pages the scheduler on call.

### No-show classifier

A no-show is a structured event with two narratives required when in dispute:
- Interpreter's "I was here" — geofence ping + photo of arrival location (optional) + timestamps.
- Requestor's "consumer didn't show" / "interpreter didn't show" with timestamp.

The platform never silently auto-decides whose fault; if both narratives are inconsistent, the job enters DISPUTED and an admin reviews. Reliability metric is not docked until DISPUTED resolves.

### Reliability metrics

Per interpreter, rolling 6-month window: claim_rate, decline_rate, late_cancel_rate, no_show_rate, on_time_arrival_rate, dispute_rate. Visible to the interpreter on their dashboard (so they know where they stand) and to schedulers (so scoring is explainable). Not visible to requestors. Drops to "watch" status if no_show_rate > 2% or late_cancel_rate > 5%; "watch" prompts a 1-on-1 with the agency owner before any suspension action.

---

## C6. Communication during a job

Live surfaces during an active job:

- **Job thread.** In-platform chat per job, members = assigned team + scheduler + (optionally) agency admin. Encrypted at rest; retention follows the audio/transcript policy where applicable. Threads support: text, voice notes, images (parking signs, room numbers), pinned messages (the on-site contact's number).
- **"Location changed" broadcast.** One-tap from the scheduler; immediate fan-out per C5.
- **"Running long" tap.** Interpreter signals overrun mid-job; the scheduler + billing-bot see it; the agency can warn the next assignment if the interpreter's same-day calendar is at risk.
- **Incident report.** A structured form available from the job thread: type (consumer in crisis, requestor breach, safety concern, suspected interpreter error against the interpreter being reported, other), severity (1–4), narrative, optional photo. Severity 3+ pages the agency admin within 10 minutes. The incident attaches to job audit and feeds the COI graph if it triggers a recusal.
- **End-of-job tap.** Confirms duration and minutes-locked; opens the optional voluntary feedback prompt for the requestor and consumer (separate flows; never tied to interpreter pay; feedback responses anonymized at quarterly cadence for the interpreter's review).
- **Consent / Recording indicators.** Where any audio is captured (CART, conference STT, VRI captioning), the per-session consent and RECORDING indicator from the speech-processing contract are enforced; one-tap PAUSE RECORDING for chair/host is surfaced in the job thread.

---

## C7. Modality-specific flows

### VRI (Video Remote Interpreting)

- **Agency-hosted.** Requestor and consumer get a `/v/<job_id>` URL; interpreter joins from the PWA. WebRTC via the agency's Cloudflare TURN; captions on by default for any spoken-language party (Deepgram per the speech-processing contract). Recording governed by Maryland two-party consent — opt-in per session, RECORDING indicator on every shared screen, executive-session PAUSE supported. Quality monitor (jitter, latency, packet loss, RTT) visible to the interpreter; if any metric crosses threshold, an unobtrusive banner appears and the failover backup is pinged warm.
- **External (Zoom / Teams / Doxy.me).** The platform sends the interpreter the meeting link + dial-in + waiting-room password 15 minutes pre-call; the interpreter joins their tool of choice. The platform tracks join/leave timestamps via interpreter taps (no API to those services for billing); a single screenshot of the meeting (timestamped) is requested at end-of-job for audit. Bill rate is the same; recording governed by the host's platform.
- **Failover.** Per C4.9, warm backup auto-dispatched if RTT or packet loss spikes for >8 seconds. Backup retainer is a flat per-shift fee, plus full per-minute rate if engaged.

### OPI (Over-the-Phone)

- **Inbound.** Requestor calls the agency's Twilio number; an IVR captures language (DTMF or voice), modality (OPI), and consumer ID if pre-registered, then conference-bridges to the next available interpreter.
- **Outbound bridge.** Requestor in the platform clicks "Call now in Mandarin" → Twilio dials the requestor + the on-call Mandarin interpreter + (optionally) the consumer's number → connects.
- **Metadata.** No video, minimal pre-job metadata required (language + setting). Bill in 1-minute increments after first-minute floor.

### CART

- **On-site.** Captioner brings steno + projector kit (agency-owned or BYO); platform tracks check-in via NFC tag at the venue (optional) or interpreter tap.
- **Remote.** Captioner joins a per-job Streamtext-style session (agency-hosted or 3rd-party endpoint); captions stream to participant URLs.
- **Archive.** Transcript archived per retention policy (1 year machine-readable; permanent after human review and approval). Speaker labels added in post if a multi-mic setup was used (per the speech-processing contract's "two mic stations beat one room mic" rule).

### Document translation

1. Requestor uploads source file(s) via the platform; file is hashed and stored in the agency tenant's vault.
2. Triage tags: language pair, certified yes/no, target use (USCIS / court / medical / school / general), turnaround, word count (auto-computed from supported formats; manual for scans).
3. Assignment: engine routes to qualified translator(s); for certified work, attestation template auto-generated.
4. Translation Memory (TM) and termbase per client pulled into the translator's tool of choice (XTM, MemoQ, Trados — file export, not live integration in v1).
5. Returned file goes through a reviewer pass (separate translator); discrepancies flagged.
6. Final delivery with attestation/notary as needed; version-controlled — every revision preserved in the vault.
7. School IEP / 504 files: FERPA vault, watermarked viewer, hard-delete at year-end per the security baseline.

### Conference (booth) interpreting

- **Pre-event.** Run-of-show document (or PowerPoint) uploaded; team interpreters get 7 days lead time minimum to prep.
- **Equipment.** Platform tracks equipment rental (booths, transmitters, receivers, technician) as line items on the job.
- **Day-of.** Lead interpreter has a checklist (booth setup, sound check, confidence monitor, water for interpreters, signage for the consumer audience).
- **Multi-language relay.** Each booth pair is a sub-job; the relay chain is modeled in the job record so payouts and bill lines map cleanly.
- **Recording.** Per-session consent per the speech-processing contract; conference organizers often want the recording, governed by the same retention defaults.

---

## C8. Quality assurance, feedback, and continuous improvement

- **Post-job feedback.** Two distinct flows: (1) **requestor flow** — 30-second NPS + 3 optional questions (was the interpreter on time, was the interpreter professional, would you book this interpreter again); (2) **consumer flow** — same idea but Deaf-accessible (ASL video question prompts + plain-text alternative; allows ASL video responses), and notably **on a different cadence** — consumer feedback is monthly digest, not per-job, because per-job feedback from Deaf consumers in small communities risks identifying both interpreter and consumer in retaliation patterns.
- **Interpreter peer feedback.** Optional, post-team-job: "Was your teammate prepared, professional, supportive?" — anonymized in the aggregate report after 5 ratings.
- **Cert renewal tracking + auto-reminders.** 90/60/30/14/7-day reminders; auto-suspend roster status at expiry unless interpreter has filed a renewal-in-progress flag.
- **CEU tracking.** RID requires CEUs across a 4-year cycle; the platform tracks accumulated CEUs per interpreter, sends reminders, and integrates a CEU library (link out to RID-approved CEU providers).
- **Incident log.** Severity 3+ incidents (per C6) escalate to chair-of-board; severity 4 (consumer safety event, alleged misconduct) triggers an emergency review with documented chain-of-evidence (event stream, narratives, decisions, outcomes).
- **Quality calibration sessions.** Quarterly mock interpreting sessions, recorded with explicit consent, reviewed by a credentialed evaluator. Interpreters opt in (not mandatory); evaluations attach to the interpreter's profile and are visible only to the interpreter and the agency owner.

---

## C9. KPI dashboard

The agency-admin home screen is a single page of KPIs computed from the event stream.

- **Fill rate** = `closed_or_complete / submitted` for a period.
- **Time-to-fill** = `first_claim_ts - submitted_ts`; surfaced as median + p90.
- **Time-to-confirm** = `confirmed_ts - submitted_ts`.
- **Cancellation rate by side** — `cancelled_by_requestor`, `cancelled_by_agency`, `cancelled_by_interpreter`, each over submitted.
- **On-time arrival rate** — per interpreter and agency-wide; on-time = `on_site_ts ≤ scheduled_start_ts + 5min`.
- **Revenue per filled hour** — `invoiced_revenue / billable_hours_closed`.
- **Payout per filled hour** — `payable / billable_hours_closed`.
- **Gross margin** — `(invoiced − payable − card_fees) / invoiced`.
- **Top consumers / requestors / languages** by demand (hours and revenue).
- **Interpreter utilization** — `billable_hours / declared_available_hours` per interpreter.
- **AR outstanding by aging bucket** — 0–30 / 31–60 / 61–90 / 90+.
- **AP outstanding by aging bucket** — same.
- **NPS — requestor / consumer (separate).**
- **Cert-expiry pipeline** — counts at risk in next 30 / 60 / 90 days, by cert type.
- **Marketplace pressure** — `% of jobs that hit marketplace after cascade exhausted` (a leading indicator of roster shortfall).
- **VRI quality** — median RTT, p95 packet loss, sessions with failover events.

All KPIs filterable by modality, language, payer, requestor, interpreter, date range. CSV export per panel.

---

## C10. Open lifecycle decisions

Anthony — these need a call from you (and likely a sanity-check with Fallon). My recommendation for each follows the question.

1. **Parallel-3 cascade vs strict-sequential offers.** *Recommend:* parallel-3 with first-claim-wins as default, expose strict-sequential as an agency setting for tenants who want max fairness over speed. Pure sequential burns 15+ minutes on short-notice jobs.

2. **ETA visibility to requestor.** *Recommend:* off by default; agency-policy toggle per contract. Interpreters consistently report that ETA visibility to requestors leads to texting interpreters in traffic, which is unsafe and unhelpful. Scheduler is the right relay.

3. **Consumer per-job feedback vs monthly digest.** *Recommend:* monthly digest. Per-job feedback in small Deaf communities is a retaliation risk and produces lower-signal data because the consumer is identifiable.

4. **Interpreter name disclosure to requestor pre-job.** *Recommend:* agency-policy default of "yes" for healthcare and legal (requestor needs to know to clear conflict on their side); "no" for K-12 (school district often re-requests specific interpreters in ways that create gig-economy unfairness). Per-contract override.

5. **Marketplace open after how many cascade rounds.** *Recommend:* one round of parallel-3 (so 3 candidates, 5 min), then marketplace. Tighter for under-4-hour jobs. Two rounds is what we'd guess feels safer but it's measurably slower; the second round rarely fills if the first didn't.

6. **Workload-balance signal weight.** *Recommend:* keep at 5%. Less than that and interpreters report feeling the engine picks favorites; more than that and the engine starts assigning the wrong interpreter on a fit basis. Make the weight visible in the scoring breakdown so interpreters know it's there.

7. **CDI auto-required by setting.** *Recommend:* auto-recommend CDI on `mental_health`, `court_*`, `pediatric_medical`, and `consumer.flag.cdi_preferred` — and force the scheduler to either include or explicitly dismiss with a reason. Don't auto-force; some Deaf consumers explicitly don't want CDI in their everyday medical visits.

8. **Geofence assist for on-site arrival.** *Recommend:* offer geofence assist (one-tap "confirm I'm at the venue" if within radius); never require it. Some interpreters work in basements / Faraday-cage clinics where GPS fails. Self-attestation is the floor.

9. **Backup interpreter retainer pay for VRI failover.** *Recommend:* yes, a small per-shift retainer ($15–$25) for declared warm-backups, plus full rate if engaged. Without retainer pay, interpreters won't declare warm; without warm, failover SLA fails.

10. **Hold-the-slot vs re-cascade for recurrings.** *Recommend:* hold-the-slot default for weekly recurrings of 8+ weeks; re-cascade default for sporadic recurrings. Long-running recurrings build trust between consumer and interpreter that's clinical-quality value and shouldn't be re-traded weekly.
