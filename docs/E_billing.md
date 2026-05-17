# Section E — Billing, Payments, and Accounting

The agency makes money by charging payers and paying interpreters. This section specifies the system of record for both sides of the ledger, the rate-construct vocabulary the industry actually uses, the Stripe object model that backs it, the tax artifacts that come out the back, and the accounting-system integrations that keep the agency's books clean. The platform must be billing-first even on the Deaf-owned-agency free tier — the agency still bills its own customers, so AR/AP is not premium-gated functionality; only platform-level fees are.

---

## E1. Pricing model lexicon (industry conventions)

Interpreting and translation rates are not a single number. Every job is a structured fee calculation pulled from a **rate card** — a versioned, dated, named bundle of line-item rate rules. A rate card resolves at job-creation time and is **frozen onto the job** (so retroactive rate-card edits never silently rewrite past invoices).

### E1.1 Rate constructs the platform must support

| Construct | Typical usage | Example |
|---|---|---|
| **Flat hourly** | On-site ASL, most common | $85/hr ASL community, 2-hr minimum, billed in 15-min increments after |
| **Half-day / full-day** | Conferences, court, multi-day deps | $400 half-day (≤4 hrs), $750 full-day (≤8 hrs) |
| **Per-minute** | OPI / VRI on-demand | $1.95/min Spanish OPI, 1-min minimum, billed to the second after |
| **Per-word** | Document translation | $0.22/word ES→EN; +25% rush <48h; +40% rush <24h |
| **Per-page** | Certified translation (birth certs, diplomas) | $35/page certified, $10 notary |
| **Cancellation tier (bill side)** | What payer owes if they cancel | 100% < 24h, 50% < 48h, 0% > 48h |
| **Cancellation tier (pay side)** | What interpreter is paid on cancel | 100% < 24h, 50% < 48h — can differ from bill side |
| **Travel time** | Paid commute beyond a threshold | Paid after 30 min one-way OR after 30 miles, at $45/hr "drive-time rate" |
| **Mileage reimbursement** | Per-mile, configurable | IRS standard ($0.70/mi for 2026), payer-toggleable |
| **Premium surcharge** | Time-of-day / day-of-week uplifts | +20% evenings (after 6pm), +25% weekends, +50% holidays, +100% overnight (10pm–6am), +25% last-minute (<4 hr notice) |
| **Team-of-2** | Each interpreter paid their **full** rate (NOT split) | A 90-min medical assignment with 2 interpreters = bill 1.5 × $110 × 2 = $330 |
| **CART** | Realtime captioning | $145/hr, 2-hr min — typically higher than ASL |
| **CDI** | Certified Deaf Interpreter (works in tandem with hearing) | Configurable: some agencies equal to ASL rate, some +15–25% |
| **VRI per-minute / per-session** | Video Remote Interpreting | $2.50/min VRI medical, or $90 flat per 60-min scheduled VRI |
| **Subscription / retainer** | School district unlimited up to cap | $4,800/mo, includes 60 hrs/mo, overage at $95/hr |
| **Equipment rental** | Booth, headsets, CART display | $1,200/day booth + technician, $35/headset/day, $400 CART display |
| **Travel expenses (pass-through)** | Hotel, parking, tolls, per-diem | GSA per-diem rates for conferences; receipts required >$25 |

### E1.2 `Rate_Cards` tab structure

One Google Sheet tab, multi-card per agency. Schema (rows = line items, not whole cards — a card is a `card_id` grouping):

```
card_id | agency_id | card_name | effective_start | effective_end |
line_type | language | modality | setting | min_units | unit | rate |
increment_minutes | applies_to_role | premium_window | premium_rate_pct |
cancel_tier_hours | cancel_pct_bill | cancel_pct_pay | notes
```

Examples (`card_id = "STD-2026"` for a typical agency):

```
STD-2026 | ag_001 | Standard 2026 | 2026-01-01 | NULL |
hourly | ASL | onsite | community | 2 | hour | 85.00 | 15 | interpreter | NULL | NULL | NULL | NULL | NULL | "2hr min, 15min increments after"

STD-2026 | ag_001 | Standard 2026 | 2026-01-01 | NULL |
premium | ASL | onsite | * | 0 | pct | NULL | NULL | * | evening_after_18 | 20 | NULL | NULL | NULL | "Evening uplift"

STD-2026 | ag_001 | Standard 2026 | 2026-01-01 | NULL |
cancellation | * | * | * | NULL | NULL | NULL | NULL | * | NULL | NULL | 24 | 100 | 100 | "Inside 24h, 100% bill & pay"

STD-2026 | ag_001 | Standard 2026 | 2026-01-01 | NULL |
mileage | * | onsite | * | 30 | mile | 0.70 | NULL | * | NULL | NULL | NULL | NULL | NULL | "IRS rate, after 30mi one-way"
```

Cards are **assigned to payers** (`Payers.default_rate_card_id`) and can be **overridden per-contract** (`Contracts.rate_card_id`). Interpreters have a **pay-side rate card** separately (`Interpreters.pay_rate_card_id`) — the bill-side and pay-side cards are independent so the agency's margin lives in the spread.

A reusable card library: `STANDARD`, `PREMIUM`, `FEDERAL-COURT`, `K12-RETAINER`, `MEDICAL-INSURANCE`, `LEGAL-DEPO`, `CONFERENCE`, `EMERGENCY`. Agency clones and edits — never edits the seed.

### E1.3 Fee calculator (single source of truth)

A pure function `computeJobFees(job, rateCard) → {billLines[], payLines[]}` lives in `shared/lib/fees.js`, runs identically in the Apps Script (for batch invoicing) and in the Cloudflare Worker (for live "what will this cost?" quotes in the booking flow). Anchors the math to the rate card frozen at job-creation. Unit tests live in `shared/lib/fees.test.js` with ~120 golden cases drawn from Fallon's real-world examples (CDI team jobs, last-minute cancels-on-the-clock, conference half-day with travel time, etc.).

---

## E2. Invoice generation

### E2.1 Triggers

Three modes, configurable per `Payer`:

1. **Per-job** — every closed job becomes an invoice the moment it closes. Apps Script `closeJob()` writes a row to `Invoices` and emails the payer PDF within ~5 minutes. Used by walk-up clinics, small attorneys, anyone who wants real-time billing.
2. **Batch (weekly / biweekly / monthly)** — nightly Apps Script trigger collects all closed jobs since last batch for that payer, generates a single multi-line invoice. Default for hospitals, school districts, courts.
3. **Manual** — admin clicks "Invoice now" on a job or a batch in the admin console. Useful for off-cycle one-offs or held jobs released after dispute resolution.

Invoice numbers are monotonically increasing per agency, optionally prefixed: `INV-2026-04812`. Numbering is **never** reused; voids preserve the number with status `voided`.

### E2.2 Invoice composition

**Header:** agency legal name, address, EIN, contact email/phone. Payer billing name, address, AP contact. Invoice #, issue date, due date (computed from `Payer.payment_terms` — Net-15, Net-30, Net-45 most common). PO number if payer requires.

**Lines:** one per job. Columns:

```
Job ID | Service Date | Modality | Language | Setting | Duration | Base Rate | Subtotal | Surcharges | Travel | Mileage | Expenses | Line Total
```

Surcharges expand on hover/print (e.g., "+20% evening, +25% last-minute").

**PHI suppression (default):** consumer name is replaced by `Patient #4521` (the Job ID's last 4) or a `consumer_pseudonym` field set at intake. Agency-toggleable per-payer (`Payers.show_consumer_name`).

**Tax line:** computed from `Agency.tax_config` × `Payer.tax_exempt` × line items. Defaults to 0% (most states don't tax interpreting; never assume — see §E6).

**Totals:** subtotal, tax, total due. "Less previously paid: $X" if applicable.

**Payment instructions:** ACH details (Plaid-verified bank), check mailing address, online payment URL (deep link to payer portal with one-time token), card surcharge note if applicable.

### E2.3 Invoice formats

- **PDF** — canonical artifact. Generated server-side via headless rendering of an HTML template (`templates/invoice.html`) → Puppeteer in a Cloudflare Container or `html-pdf-node` in an Apps Script library. Stored in **R2** at `r2://invoices/{agency_id}/{year}/{invoice_id}.pdf`. URLs are short-lived signed (15-min).
- **HTML view** — same template, served in payer portal at `/portal/invoices/{invoice_id}`.
- **CSV / Excel export** — flat file for payers (especially K-12 finance offices) that load into their AP system manually.
- **EDI 837/810** — rare; stretch for one or two large insurance payers. Skip for v1; spec only.
- **Direct push to QBO / Xero** — via OAuth-connected accounting integration (§E7). Invoice mirrored as a QBO Invoice with line items mapped to QBO Items.

### E2.4 PHI on invoices (HIPAA mechanics)

Default behavior — **no consumer name, no diagnosis, no MRN** appears on any invoice. The line carries Job ID, date, duration, modality, language, and setting (e.g., "Outpatient — Cardiology"). This is enough for the payer to reconcile internally without us creating PHI we don't need to hold.

**HIPAA-covered payer toggle** (`Payers.hipaa_covered_entity = true` + signed BAA on file → `Payers.baa_signed_date`): unlocks per-payer settings to include consumer name and MRN on invoices, because the hospital's revenue-cycle team needs the linkage. Invoices to BAA'd payers are also flagged in R2 metadata for stricter retention (7yr min per HIPAA).

**White-label option:** agency uploads payer letterhead → renders invoice on hospital's letterhead. Lives in `Payers.letterhead_r2_key`.

### E2.5 Insurance billing (optional, off by default)

For agencies that bill Medicaid or commercial insurance directly for medical interpreting (a real but minority workflow — many agencies route through the hospital instead). When enabled (`Agency.insurance_billing = true`):

- **CMS-1500 export** (professional claim form) and **UB-04** (institutional, rarer for interpreting). Both as PDF and as 837P/837I EDI files.
- **HCPCS / CPT code mapping:** default to **T1013** — *"Sign language or oral interpretive services, per 15 minutes"* — the typical Medicaid code. Agency can configure additional codes per state.
- **ICD-10 capture:** if payer requires the diagnosis code on the claim, the booking form must capture it at intake. This is PHI-heavy; the agency must opt in per-payer and the intake form gates on `Payer.requires_icd10`.
- **Modifier codes per state:** e.g., `GT` (telehealth via interactive audio/video), `95` (synchronous telemedicine). State table seeded for the top 10 Medicaid states.
- **Clearinghouse integration:** stretch; route 837 files via Availity or Change Healthcare. v1 = manual download + upload by the agency.

This entire subsystem is **clearly labeled experimental** in admin settings. Most agencies will leave it off.

---

## E3. Payer portal

### E3.1 Account model

- **Payer** — one organization (e.g., "Frederick Memorial Hospital").
- **Sub-payer / cost center** — optional child entity (e.g., "FMH — Emergency Dept", "FMH — Cardiology"). Invoices roll up; payments can be applied to parent or child.
- **Payer Contact** — one human, has email + password (or magic link). Roles: `viewer`, `ap_clerk`, `ap_director`, `admin`. Permissions:

| Role | View invoices | Pay | Dispute | Manage users | See PHI (if BAA) |
|---|---|---|---|---|---|
| viewer | own sub-payer | no | no | no | no |
| ap_clerk | all | yes | yes | no | yes |
| ap_director | all | yes | yes | yes | yes |
| admin | all + settings | yes | yes | yes | yes |

### E3.2 Screens

- **Inbox** — new invoices since last login, sorted by due date.
- **All invoices** — searchable/filterable: date range, sub-payer, requestor, amount range, status (`draft / sent / viewed / partial / paid / overdue / disputed / voided`).
- **Invoice detail** — line items, PDF download, payment history, dispute trail, "download as CSV."
- **Pay now** — Stripe Checkout for one-time, or save bank/card for future. Multi-invoice batch pay supported (pay 12 invoices in one ACH).
- **Dispute** — payer flags a line ("we never had this appointment"), captures reason, routes to agency admin queue. Resolution log appended to invoice. Resolution = adjustment line, full credit memo, or dispute denied.
- **Year-end summary** — total spend by year, by sub-payer, by language. Useful for payer's own budgeting; **not** a 1099 — agencies don't issue 1099s to their customers.
- **Statements** — monthly statement of account showing all invoices, payments, balance.

### E3.3 Payment methods

| Method | Rails | Fee model |
|---|---|---|
| ACH | Stripe ACH | Agency pays 0.8% capped at $5 — usually absorbed |
| Card | Stripe card | Either agency absorbs 2.9% + 30¢ OR payer pays surcharge (configurable per-agency, with state-level legality check — surcharging is restricted in CT/MA/ME) |
| Check | Offline; record manually in admin | None |
| Wire | Offline; record manually | None |
| Lockbox import | CSV from agency bank → matcher | Stretch |

A "Pay all open" CTA bundles multiple invoices into one PaymentIntent and applies funds via Stripe's `payment.invoices` allocations.

### E3.4 AR aging + dunning

**Aging buckets** computed nightly: 0–30, 31–60, 61–90, 90+. Surfaced in admin dashboard + payer portal "your past due" banner.

**Dunning sequence** configurable per-agency, defaults:

| Trigger | Channel | Template |
|---|---|---|
| Due − 3d | Email | "Friendly reminder, invoice due Friday" |
| Due + 1d | Email | "Just past due" |
| Due + 7d | Email + SMS (if opted in) | "1 week past due" |
| Due + 14d | Email + phone-call task | "14 days past due — please reach out" |
| Due + 30d | Email + admin alert | "30 days — collections review" |
| Due + 45d | Manual: admin marks "send to collections" | CSV export to agency's chosen collections service (e.g., Receivables Performance Management, IC System) |

Dunning pauses automatically when invoice has an open dispute.

---

## E4. Interpreter payouts

### E4.1 The cycle

```
Job ends → duration locked → fees compute → "Payable" row written
   ↓
Pay-period close (configurable: weekly/biweekly/semimonthly/monthly)
   ↓
Batch builds: all Payable rows for interpreters with pay_period_end ≤ today
   ↓
Admin reviews batch → can override duration/rate per line (audit logged)
   ↓
Admin approves batch (dual-control if > $5k — §E8)
   ↓
1099: Stripe Connect Transfer + Payout
W-2: CSV export to payroll provider
   ↓
Payout posts → "Paid" row updated → interpreter sees in dashboard
```

### E4.2 W-2 staff

The platform is **not** a payroll system. It captures hours and exports them. Tax withholding, benefits, garnishments, all stay in ADP / Gusto / Paychex / Rippling.

- **Hour categories** (per IRS / DOL conventions): `interpreting`, `travel`, `training`, `paid_cancellation`, `admin`, `pto_taken`. Categorization matters for overtime and PTO accrual.
- **ACA benefits-eligibility tracking:** rolling 12-month avg hours/wk vs. 30-hr threshold; surfaces in admin to flag staff approaching ACA full-time status.
- **Export formats:** Gusto and Rippling support a CSV import schema we match; ADP has an API (RUN integration); Paychex has both CSV and Flex API. Mapping documented per provider in `shared/specs/PAYROLL_EXPORT.md`.

### E4.3 1099 contractors

**Onboarding (Stripe Connect Express):**

1. Interpreter accepts agency invite → magic-link to platform.
2. Profile setup → reaches "Payouts" step.
3. Stripe Connect Express onboarding link generated → interpreter completes KYC (name, SSN or ITIN, DOB, address, bank).
4. Stripe returns `account.charges_enabled` + `account.payouts_enabled` → interpreter status = `payout_ready`.
5. W-9 collected as part of the Stripe Connect flow (Stripe captures TIN). Annual refresh prompt at January each year.

**Standard payouts:** ACH via Stripe Connect Express on the agency's pay schedule. Transfer from agency platform account → interpreter Connect account → Payout to interpreter bank in 1–2 business days.

**Instant payouts (opt-in per interpreter):** Stripe Connect Instant Payouts. ~1% fee, paid by interpreter (deducted from payout). Caps at debit-card daily limits.

**1099-NEC at year-end:**

- Track total paid per TIN per calendar year.
- Threshold: $600+ → must issue (IRS rule).
- Generate IRS-compliant 1099-NEC PDFs.
- E-file via **track1099** (or Tax1099 — both have batch upload + e-file).
- Mail copies to interpreters by Jan 31; e-file with IRS by Jan 31.
- Make available in interpreter dashboard.

**Backup withholding:** if Stripe TIN-match fails (interpreter name/TIN don't match IRS records), apply 24% backup withholding on subsequent payouts and remit to IRS via Form 945. Surface a red banner in the interpreter dashboard urging W-9 correction.

**1099-MISC** for non-NEC items (Box 3 "other income" — e.g., a referral bonus paid to an interpreter who isn't doing the work themselves). Rare; spec only.

### E4.4 Payout line items

Each line on a payout statement:

```
Job ID | Date | Language | Setting |
Duration billed | × | Base rate | = | Subtotal
Travel time | × | Drive rate | = | Travel pay
Mileage | × | Per-mile | = | Mileage pay
Parking + tolls (receipts) | | | | Expense reimb
Premium surcharges (list each) | | | | Premium pay
Cancellation pay (if applicable) | | | | Cancel pay
                                          ────────────
                                          Line Net
Deductions (W-2 only: per-paycheck adjustments)
                                          ────────────
                                          Statement Net
```

Saved as PDF in R2 per pay period, downloadable from interpreter dashboard.

### E4.5 Interpreter income dashboard

- **This pay period** — earnings so far this cycle, projected close date.
- **YTD (calendar year)** — running 1099 estimate, useful for quarterly estimated taxes.
- **Breakdown by category** — hours billed vs. travel vs. cancellations vs. mileage reimbursements. (Note: mileage reimbursements at IRS rate are not 1099 income — segregated.)
- **Breakdown by requestor** — top 10 sub-payers by revenue to interpreter. Helps interpreters see their book.
- **Average effective hourly** — net earnings ÷ total time committed (including travel). A real eye-opener.
- **Downloadable 1099-NEC** at year-end.
- **Tax docs vault** — W-9 history, 1099s from prior years.

### E4.6 Interpreter dispute path

Interpreter flags: "I worked 90 minutes; the system shows 60." → Routed to job's scheduler → scheduler reviews check-in/check-out timestamps, payer's signed worksheet (if any), or contacts payer → resolves with duration override (audit logged with reason + supporting doc) → next payout reflects correction OR retroactive adjustment line on next statement.

Time-bar: disputes must be raised within 60 days of pay period close. After that, agency policy.

---

## E5. Money flow architecture

### E5.1 The two modes

**Mode A — Agency-of-record (default):** the agency is the merchant. Payers pay the agency. The agency pays interpreters. The platform is a record-keeper and a payment-orchestration layer. No money flows through the platform's bank account.

```
   ┌─────────┐          ┌──────────────┐          ┌─────────────┐
   │ PAYER   │  pays    │   AGENCY     │  pays    │ INTERPRETER │
   │ (clinic,│ ──────▶  │  (merchant   │ ──────▶  │ (W-2 or     │
   │  court) │          │   of record) │          │  1099)      │
   └─────────┘          └──────────────┘          └─────────────┘
        │                      │                         │
        │                      │                         │
   Stripe Customer       Stripe Account            Stripe Connect
   (or pays via check)   (platform connected       (Express, 1099 only;
                          to agency's Stripe)       W-2 paid via payroll)
```

**Mode B — Marketplace / platform-pays (opt-in, smallest agencies):** the platform is a payment facilitator. The platform's Stripe Connect Custom account holds funds; the platform pays interpreters directly on the agency's behalf and remits net to the agency. Adds money-transmitter / state licensing exposure (see §E10 #1) — we offer this only to agencies under a configurable ceiling (e.g., <$500k AR/yr) and require legal review before flipping the switch.

```
   ┌─────────┐    ┌────────────┐                  ┌─────────────┐
   │ PAYER   │ ─▶ │  PLATFORM  │ ── Transfer ──▶  │ INTERPRETER │
   └─────────┘    │  (Stripe   │                  │ (Connect    │
                  │   Connect  │                  │  Express)   │
                  │   Custom)  │ ── Remainder ─▶  ┌─────────────┐
                  └────────────┘                  │   AGENCY    │
                                                  └─────────────┘
```

### E5.2 Stripe object model (Mode A)

```
Stripe Customer (payer)
   │
   ├── PaymentMethod (ACH bank or card)
   │
   ├── Invoice (mirrors our Invoice record)
   │     │
   │     └── InvoiceItem (one per job line)
   │
   └── PaymentIntent → Charge → BalanceTransaction (funds land in agency Stripe)
                                       │
                                       ▼
                              Platform reads webhook
                              → marks our Invoice paid
                              → Sheet update + Worker cache invalidation

Connect Account (interpreter, Express)
   │
   ├── External Account (interpreter bank or debit card)
   │
   ├── Transfer (from agency Stripe → interpreter Connect)
   │
   └── Payout (Connect → interpreter bank, T+1 standard or instant)
```

### E5.3 Edge cases

| Edge case | Behavior |
|---|---|
| **Chargeback** | Stripe webhook `charge.dispute.created` → invoice flagged `disputed_externally` → admin alert → evidence-submission UI surfaces job artifacts (check-in/out, signed worksheet, transcript if any) → submit to Stripe within deadline |
| **Refund** | Admin issues refund from invoice detail → PaymentIntent refund → if interpreter was already paid for the canceled job, a clawback line goes on their next payout (with admin warning + interpreter notification) |
| **Failed ACH return** | Webhook `charge.failed` (R01–R29 codes) → invoice reverts to `sent`, banner on payer portal, dunning sequence resumes, agency alert. R01 (insufficient funds) auto-retries once after 5 days; admin handles R02–R29 manually |
| **Multi-currency** | `Agency.currency = USD / CAD / MXN`. Stripe accounts created in agency's local currency. Each invoice is single-currency. Cross-currency (a US agency billing a Canadian payer in CAD) requires a Stripe USD/CAD account and is configured per-payer (`Payer.billing_currency`). FX risk is the agency's; we surface the spot rate at invoice issue |
| **Partial payment** | Payer pays $X of $Y → invoice status `partial`, remaining balance carried, dunning continues on remainder |
| **Overpayment** | Auto-credit applied to next invoice OR refund triggered if no open balance; admin chooses default |

---

## E6. Tax handling

### E6.1 Sales tax on services

A handful of states tax language services (currently: HI, NM, SD, WV partially; SC/CT under some circumstances; **MD does not**). We never assume — every agency's tax config is explicit:

```
Agency.tax_config = {
  collect_sales_tax: bool,
  default_rate_pct: number,
  per_state_overrides: { "HI": 4.0, "NM": 5.125, ... },
  exempt_payer_types: ["nonprofit_501c3", "government", "school_district"]
}
```

Per-payer override: `Payer.tax_exempt = true` + `Payer.exempt_cert_r2_key` for proof. Avalara or TaxJar integration is a stretch goal for the few agencies operating in taxed states.

### E6.2 1099-NEC

- Threshold: $600+/calendar year/TIN.
- Tracked continuously in `Interpreter_YTD` materialized view.
- Generated and e-filed via **track1099** (preferred — clean API) or Tax1099 alternate.
- Recipient copies mailed by Jan 31; IRS e-file by Jan 31.
- Corrected 1099s supported (if a duration override changes prior-year totals after Jan 31, agency issues 1099-NEC corrected).

### E6.3 1042-S (nonresident interpreters)

A Spanish interpreter living in Mexico paid for VRI sessions from a US agency: payments to non-US persons for US-source services → 1042-S, not 1099.

- Capture W-8BEN at onboarding (`Interpreter.tax_form_type = W9 | W8BEN`).
- Default withholding: 30% on payments to non-treaty countries; treaty rates applied if interpreter claims (Mexico-US treaty: 0% for independent personal services if certain conditions met; documentation required).
- File 1042-S annually + 1042 reconciliation. Less common; document the workflow but most agencies won't hit this.

### E6.4 W-2 export

Per §E4.2 — CSV/API handoff to agency's chosen payroll provider. Platform stops at "hours by category"; payroll handles withholding, FICA, FUTA, SUTA, garnishments.

---

## E7. Accounting integration

### E7.1 QuickBooks Online (priority 1)

- OAuth flow per agency (each agency connects its own QBO subscription).
- **Outbound sync:** every invoice we issue mirrors as a QBO Invoice with line items mapped to QBO Items (one Item per service type: `ASL-Onsite`, `Spanish-OPI`, `Mileage-Reimb`, etc.). Invoice number matches.
- **Inbound sync:** QBO payments (check, wire, ACH outside Stripe) sync back to our `Payments` tab and apply to invoice. Marks invoice paid.
- **Bill-side sync (AP):** payouts to interpreters mirror as QBO Bills + Bill Payments. Useful for agency P&L in QBO.
- **Chart-of-accounts mapping:** agency configures which QBO accounts map to revenue (interpreting, translation, equipment), COGS (interpreter pay), and pass-throughs (mileage, expense reimbursements).
- **Reconciliation guardrail:** nightly job compares our Invoice totals vs. QBO Invoice totals — drift > $0.01 raises an admin alert.

### E7.2 Xero (priority 2)

Symmetric to QBO. Xero's API is cleaner in some respects (better invoice line attachment); the same outbound/inbound/bill-side flows apply.

### E7.3 Bill.com (large agencies, AP scale)

For agencies paying 200+ interpreters per cycle who already live in Bill.com. We export payout batches as Bill.com-compatible CSV or use Bill.com's API to push Bills with attached PDF statements. Bill.com handles the actual ACH; we treat it as an external payout rail (Stripe Connect not used in this path).

### E7.4 Plaid (bank verification)

For interpreters opting to receive ACH outside Stripe Connect (some prefer direct deposit from agency without a Connect account, especially older long-tenured staff), Plaid Link verifies the account, then NACHA ACH files generate via the agency's bank's API or are uploaded manually. Plaid IDV optional for KYC of new interpreters.

### E7.5 Flat-file export (universal fallback)

Every report and ledger has a CSV/Excel download. Agencies without any connected accounting system close their books on a spreadsheet — we support them.

---

## E8. Audit and SOX-light controls

Even small agencies need bookkeeping integrity for tax audits and AP/AR disputes. Full SOX is overkill, but a SOX-light pattern protects everyone.

### E8.1 Immutable audit log

`Audit_Log` tab (and mirrored to R2 monthly as append-only Parquet for tamper-evidence):

| field | example |
|---|---|
| event_id | `aud_2026_05_16_8492` |
| timestamp | ISO8601 |
| actor_user_id | `u_admin_007` |
| actor_role | `agency_admin` |
| action | `rate_override` / `duration_override` / `payout_approved` / `invoice_voided` / `rate_card_edited` / `payer_baa_uploaded` / `tax_setting_changed` |
| object_type | `job` / `invoice` / `payout_batch` / `rate_card` |
| object_id | `job_44812` |
| before | `{"duration_min": 60}` |
| after | `{"duration_min": 90}` |
| reason | "Payer-signed worksheet shows 90 min" |
| evidence_r2_key | optional pointer to uploaded doc |

Logged events: every rate change, every duration override, every manual invoice edit, every payout approval/rejection, every refund, every void, every BAA / W-9 / W-8BEN status change, every tax-config edit, every PHI-toggle change.

### E8.2 Dual control

Configurable threshold per agency (default $5k). Any payout batch exceeding the threshold requires two distinct admin users to approve before the Stripe Transfer fires. UI surfaces a "needs 2nd approval" state; second approver cannot be the first.

Also dual-control by default: refund > $1k, rate-card edits, tax-config changes, BAA uploads, "send to collections" actions on amounts > $10k.

### E8.3 Monthly reconciliation report

A scheduled monthly report (Apps Script trigger, 1st of each month, prior month's data) ties out:

```
Opening AR  + Invoices Issued  − Payments Received  − Credits Issued = Closing AR
Opening AP  + Payables Accrued − Payouts Sent      − Adjustments     = Closing AP

Cash in (Stripe + offline) − Cash out (payouts + fees + refunds) = Net cash change
Stripe balance ledger      vs   our cash record   → should match within tolerance
```

Any line that doesn't tie raises a red flag on the admin dashboard and emails the agency's accounting contact. The reconciliation report PDF is filed in R2 monthly — useful for year-end accountant prep and any future audit.

### E8.4 Data retention (billing-specific)

| Artifact | Retention |
|---|---|
| Invoices (PDF + structured) | **7 years** (IRS standard) |
| Payment records | 7 years |
| 1099s / 1042-S | 7 years (IRS: 4yr min after due date) |
| W-9 / W-8BEN | 4 years after the last payment to that person |
| Audit log | 7 years |
| Rate cards (versioned) | indefinite (small footprint, anchors historical invoices) |
| Disputed-invoice evidence | 7 years from dispute close |

Longer than the speech-processing retention in the master CLAUDE.md — tax law trumps audio law.

---

## E9. Reporting

Out-of-the-box reports, every one filterable by date range, sub-org, language, modality, setting, requestor, interpreter:

| Report | Audience | Cadence |
|---|---|---|
| **AR aging** | Agency admin, AP director | Weekly |
| **AP aging** (payables to interpreters not yet paid) | Agency admin | Per pay cycle |
| **P&L by language** | Agency admin | Monthly |
| **P&L by setting** (medical / legal / education / business / community) | Agency admin | Monthly |
| **P&L by requestor / sub-payer** | Agency admin | Monthly |
| **Interpreter utilization** (hours billed ÷ hours available) | Scheduler, agency admin | Weekly |
| **Cancellation P&L** (cancel revenue collected − cancel pay paid out) | Agency admin | Monthly — this number is often hiding a margin leak |
| **Surcharge revenue** (premium / rush / weekend uplift contribution) | Agency admin | Monthly |
| **Tax summary YTD** | Agency admin, accountant | On-demand + Jan 1 snapshot |
| **1099 dashboard** | Agency admin | Continuous; Dec 31 snapshot |
| **Refund / chargeback report** | Agency admin | Monthly |
| **Reconciliation report** (§E8.3) | Agency admin, accountant | Monthly |
| **Payer scorecard** (their volume, their on-time payment %, their dispute rate) | Agency admin → optionally shared back to payer | Quarterly |
| **Interpreter scorecard** (hours, cancellations, average rating, on-time rate) | Scheduler | Quarterly |

**Custom reports:** admin report builder with filter + groupby + aggregate + saved view + schedule (weekly email). Results delivered as CSV + HTML. Powered by SQLite views materialized nightly from the Google Sheet (Worker-side), so the Sheet itself never becomes a query engine.

---

## E10. Open billing decisions

Each comes with a recommendation; Anthony's call.

### 1. Money transmitter status — agency-of-record only, or platform-as-PayFac?

**Question:** Do we facilitate payments through the *platform's* Stripe Connect Custom account (we hold funds, we pay interpreters, we remit to agency), or always operate as a record-keeper only and let the agency be the merchant?

**Recommendation:** **Agency-of-record by default.** PayFac mode is opt-in, capped at agencies under $500k AR/yr, and requires legal review before enablement. Becoming a money transmitter triggers state licensing (49 states require it for >$X/yr) — not where we want our compliance budget to go in year one.

### 2. Mandatory Stripe Connect Express for every 1099 interpreter, or agency-managed bank payouts allowed?

**Question:** Force every contractor to onboard Stripe Connect Express, or let agencies do direct NACHA ACH from their bank for interpreters who refuse?

**Recommendation:** **Stripe Connect Express as default; manual ACH via Plaid as documented fallback.** Some long-tenured interpreters won't want a new account; we shouldn't break their workflow. But every new interpreter onboards through Connect — full stop. KYC and 1099 capture are basically free that way.

### 3. We issue 1099s ourselves, or hand off to a third party?

**Question:** Build 1099-NEC generation + e-file in-house, or always route through track1099 / Tax1099?

**Recommendation:** **Always route through track1099.** We track the YTD totals; track1099 handles the IRS e-file, recipient mailing, corrections, and the IRS account credentialing. Cost is ~$3-5 per 1099. Building this in-house is a regulatory rabbit hole.

### 4. Card surcharge — agency eats, or pass through to payer?

**Question:** Default behavior for card payments — agency absorbs 2.9%+30¢, or payer pays a surcharge?

**Recommendation:** **Agency absorbs by default; surcharge togglable per-agency with state-legality check.** Most agencies prefer to absorb to keep payer relationships smooth. Surcharging is legally restricted in CT, MA, ME — surface a warning if agency enables it in those states.

### 5. Build the insurance-billing (CMS-1500 / 837P) subsystem in v1?

**Question:** Ship the insurance-direct-billing workflow at launch, or wait for clear demand?

**Recommendation:** **Defer to v2.** Spec it, but ship v1 without it. Most agencies bill the hospital, not the insurer. The few that bill Medicaid direct can use a clearinghouse external to us in the interim. Building this prematurely risks distracting from the AR/AP core.

### 6. Multi-currency at launch?

**Question:** Support CAD and MXN at v1, or US-only?

**Recommendation:** **US-only at v1; CAD by v1.1 (Q3 2026).** Canadian agencies are a real adjacent market (Deaf-Canadian interpreter community ties to US). MXN can wait. Currency-aware data model from day one (every monetary field stores `amount_cents` + `currency_iso`); just no UI for non-USD until v1.1.

### 7. Subscription / retainer billing model at launch?

**Question:** Support the "school district pays $4,800/mo for 60 hrs included" model in v1?

**Recommendation:** **Yes, but only the simple form.** Fixed monthly fee + included hours + overage rate. No rollover, no proration on cancellation in v1. ~30% of K-12 contracts use this model — important enough to ship.

### 8. Instant payouts — opt-in per interpreter, or opt-in per agency?

**Question:** Who decides whether interpreters can use Stripe Instant Payouts?

**Recommendation:** **Agency enables the feature; interpreter opts in per-payout.** Some agencies don't want to deal with the support load ("why was my payout $0.79 less?"). Agency-level gate makes that controllable. Interpreter then chooses per-statement whether to wait T+1 or pay the fee for instant.

### 9. Dual-control threshold default?

**Question:** Default value for the dual-control payout threshold?

**Recommendation:** **$5,000.** Catches batch payouts but not individual large-job payouts (one really busy conference week for a top interpreter can hit $4k legitimately on a single statement). Agencies can lower it; some will want $1k for tighter control.

### 10. Do we publish a public price for the platform, or quote per-agency?

**Question:** SaaS pricing for the platform itself — public list, or sales-driven quote?

**Recommendation:** **Public price for ≤20 interpreters; quote for above.** The free Deaf-owned-agency tier stays free forever per the founding commitment. Above 20 interpreters, agencies span too wide a range (volume, integrations, white-label, insurance-billing) to be one number. The public price anchors trust; the quote handles enterprise. List the inclusions next to each tier; never gate AR/AP itself — billing is non-negotiable for every agency, paid or free.

---

*End of Section E.*
