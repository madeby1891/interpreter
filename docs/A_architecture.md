# Section A — Architecture, Data Model, and Compliance

## A1. Tech-stack map

1891 Interpreter is the most surface-rich project in the workspace, but the stack contract is unchanged. Every layer maps onto the same primitives every other 1891 project uses: static HTML+CSS+vanilla-JS for surfaces, Apps Script + Sheets as the system of record for low-velocity CRM writes, Cloudflare Workers + Durable Objects + R2 + KV for any path that can't tolerate Apps Script's ~3s cold start and 90s execution limit, GoDaddy cPanel + Apache for hosting, magic-link auth, and the shared design system at `~/Desktop/1891/shared/design-system/`.

**Layer-by-layer:**

| Layer | What lives here | Why |
| --- | --- | --- |
| Static pages on GoDaddy | Marketing site (`/`, `/pricing`, `/deaf-owned-tier`), magic-link landing pages (`/auth/sent`, `/auth/callback`), agency portal shell (`/app/*`), interpreter portal shell (`/me/*`), consumer-facing public booking widget (`/book/<agency-slug>`), 404, sitemap | Apache serves static fast and free. The "shell" is HTML that fetches state from the Worker; we are NOT building an SPA, the page reloads on route change. |
| Apps Script (`backend.gs`) + Sheets | Tenant onboarding (provision a new Sheet), CRUD on cold rows (Agencies, Users, Languages, Certifications, Settings), magic-link issuance, Sheet-side validation, weekly housekeeping jobs (retention sweeper, audit-log roll-up), Postmark/Twilio fallback when the Worker is degraded | Sheet is source of truth. Apps Script is the only thing that holds a SpreadsheetApp lock. Anything that mutates a row goes through it (directly or via the sync Worker's webhook). |
| Cloudflare Workers | `workers/api`, `workers/sync`, `workers/realtime`, `workers/notify`, `workers/translate`, `workers/auth`. All TypeScript. Bound to KV (cache), R2 (blobs), Durable Objects (per-agency live state), Queues (notify fan-out), and Secrets Store. | Apps Script can't hold a WebSocket, can't sustain sub-second push, and can't safely run on a hot read path. Everything that needs <500ms p95 lives in a Worker. |
| Cloudflare R2 | Per-tenant prefix: `r2://1891-interpreter/<tenant_id>/jobs/<job_id>/...` for translation source/target files, signed COIs, certifications-on-file, captioned transcripts, ASL-voicing-of-record recordings (when consented). SSE-C with per-tenant data keys. | Sheets cannot store blobs. Drive could but escapes the BAA boundary if mis-shared. R2 is BAA-able at enterprise, cheap, and gives signed URLs. |
| Cloudflare KV | Hot read cache for `Jobs`, `Interpreters` availability, language/cert lookups. TTL 60s for jobs, 5min for static lookups. Encrypted-at-app-layer for any field flagged PHI. | Sub-10ms reads vs ~500ms+ for Sheets. KV is read-mostly; writes go to Sheet via sync. |
| Durable Objects | One DO per agency (`AgencyHub`) for live job-board state and interpreter presence. One DO per active job (`JobRoom`) only when a job is in `OFFERED` or `IN_PROGRESS` and there are connected clients (auto-destruct on idle). | DO gives strong serializable per-tenant state and WebSocket coalescing for free. |
| Observability | Worker Analytics Engine for request metrics; Logpush to R2 for retained access logs; Apps Script `Logger.log` + a custom `_Sys_Log` tab for backend; Sentry (browser + Worker) for errors. | Same observability rule as every other 1891 project: every deploy writes its sha + timestamp to `_Sys_Log`. |

**ASCII architecture diagram:**

```
                            ┌─────────────────────────────────────┐
                            │  Marketing + Auth (static, Apache)  │
                            │  1891interpreter.com/               │
                            │  /pricing  /book/<slug>  /auth/*    │
                            └──────────────┬──────────────────────┘
                                           │ HTML loads, JS fetches
                                           ▼
                ┌──────────────────────────────────────────────────┐
                │  app.1891interpreter.com (static shell)          │
                │  /app/   (agency portal)                         │
                │  /me/    (interpreter portal)                    │
                │  /req/   (requestor portal)                      │
                │  /pay/   (payer portal)                          │
                └─────────┬────────────────────┬───────────────────┘
                          │ HTTPS+JWT          │ WSS
                          ▼                    ▼
                ┌────────────────┐    ┌──────────────────────┐
                │ workers/api    │    │ workers/realtime     │
                │ REST, JWT-gated│    │ ws://.../agency/{id} │
                │ writes to sync │    │ ws://.../job/{id}    │
                └───┬────────┬───┘    └─────────┬────────────┘
                    │        │                  │ DO subscribe
                    │        │                  ▼
                    │        │       ┌──────────────────────┐
                    │        │       │ Durable Objects      │
                    │        │       │ - AgencyHub:{tid}    │
                    │        │       │ - JobRoom:{job_id}   │
                    │        │       └──────────────────────┘
                    │        │
                    │        └─────► workers/notify ──► Postmark, Twilio, Web Push
                    │
                    ▼
            ┌──────────────────┐    POST webhook    ┌──────────────────────┐
            │ workers/sync     │ ──────────────────►│ Apps Script doPost() │
            │ read-through KV  │ ◄──────────────────│ writes Sheet rows,   │
            │ write-through    │   row mutations     │ returns new row id   │
            └──────────────────┘                     └────────┬─────────────┘
                    │                                          │
                    ▼                                          ▼
            ┌──────────────────┐                     ┌──────────────────────┐
            │ KV (cache)       │                     │ Google Sheet (per-   │
            │ R2 (blobs)       │                     │ agency workbook)     │
            └──────────────────┘                     └──────────────────────┘

            workers/translate ─── R2 in/out, Claude/DeepL pipeline
            workers/auth      ─── magic-link issue, JWT mint, WebAuthn, SSO
```

Every static page boots with a single inline `__BOOT__` JSON blob (tenant slug + public env), then issues one `GET /api/v1/me` to hydrate. No SPA router. Route changes are full page loads. JS is per-page and lives at `/static/js/<surface>/<page>.js`.

---

## A2. Multi-tenant model

**Tenant = agency.** Anthony's agency (1891 Interpreting, the host tenant) gets `tenant_id = host` and is also the dogfood account. The free Deaf-owned tier and paid tiers all live on the same control plane; the tier only changes feature flags + storage caps + PHI-mode bit.

**Sheet model: one Sheet per agency, plus a small master "control" Sheet.** Justified:

- **PHI containment.** A scheduler at Agency A can never accidentally read a row that belongs to Agency B because the Sheet they're authorized against literally doesn't contain it. Apps Script enforces "which Sheet to open" using `tenant_id → spreadsheet_id` looked up from the control Sheet; if the JWT's `tenant_id` doesn't match the row, the function returns 403 before any read.
- **Data export is one click.** When an agency leaves we hand them their Sheet. No partitioned-row extract job.
- **Concurrency.** A single master Sheet would serialize all agencies behind one SpreadsheetApp lock. With ~50 agencies × tens of writes/min during peak medical hours we'd hit `LockService` timeouts. Per-agency Sheets parallelize linearly.
- **Quota headroom.** Sheets has a 10M-cell ceiling. A busy agency runs ~200k cells/year. Per-tenant gives each agency its own 10M ceiling.

**Cost of per-tenant Sheets:** onboarding has to provision a new Sheet from `tenant_template.xlsx`, set the BAA-compliant Workspace owner (`anthonymowl@gmail.com` for now, agency's own Workspace once they sign their own BAA), share to the Apps Script service account, write the row in the control Sheet. This is automated in `workers/api` `POST /v1/admin/tenants` calling Apps Script `provisionTenant(payload)`. Onboarding takes ~30s end-to-end.

**The master "control" Sheet (`1891-interpreter-control`)** has only:

| Tab | Purpose |
| --- | --- |
| `Tenants` | `tenant_id, slug, name, tier, sheet_id, r2_prefix, created_at, status, baa_signed_at, phi_mode, deaf_owned_verified_at, primary_owner_email` |
| `Tenant_Owners` | `tenant_id, email, role` — who can administer the tenant |
| `Sys_Log` | provisioning + admin events, retained 7y |

**How the Worker knows the tenant:**

1. JWT claim `tenant_id` is authoritative and signed.
2. Subdomain (`<slug>.1891interpreter.com`) is a UX hint, not a security boundary. The static shell reads it to know which agency to render, then the Worker validates the JWT's `tenant_id` against the slug.
3. Worker resolves `tenant_id → sheet_id, r2_prefix, do_id` via a KV-cached lookup off the control Sheet. Cache TTL 5min; invalidated by `POST /v1/admin/tenants/{id}/invalidate`.
4. Every DO is named `AgencyHub:{tenant_id}`. R2 keys are `s3://bucket/{tenant_id}/...`. KV keys are `{tenant_id}:...`. Nothing crosses.

**Cross-tenant isolation guarantees:**

- Apps Script rejects any call whose JWT `tenant_id` doesn't match the requested `sheet_id` — checked in a single `assertTenantAccess()` function called at the top of every handler.
- Worker request-router rejects any path whose subdomain slug ≠ JWT slug.
- R2 signed URLs are minted with `{tenant_id}` in the key prefix; Worker refuses to sign a key not prefixed with the caller's tenant.
- KV namespace `kv-1891-interpreter` uses keys with mandatory `{tenant_id}:` prefix; a lint rule in `workers/api/src/kv.ts` enforces this at compile time.
- Audit log records `tenant_id` on every row; a quarterly review script flags any row where `tenant_id` differs from the actor's home tenant.

---

## A3. Google Sheet schema

The per-agency workbook (`1891-interpreter-<slug>`) has the tabs below. All tabs include a hidden `_rev` column (monotonic integer per row, bumped on every write) for optimistic concurrency between the Worker cache and the Sheet, and `_created_at` / `_updated_at` (ISO 8601, UTC). Retention classes: **R7y** = 7 years, **R1y** = 1 year, **R30d** = 30 days, **PERM** = permanent, **OBO** = on-behalf-of-consumer (until deletion request fulfilled).

### `Agencies` (single-row tenant config; redundant with control Sheet but local for offline read)

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| tenant_id | string | `acme-interp` | No | PERM | matches control Sheet |
| legal_name | string | `Acme Interpreting LLC` | No | PERM | |
| tax_id_last4 | string | `1234` | No | PERM | full EIN in Settings, encrypted |
| tier | enum | `deaf-owned-free`, `pro`, `enterprise` | No | PERM | |
| phi_mode | enum | `full`, `initials-only`, `disabled` | No | PERM | drives consumer field masking |
| timezone | string | `America/New_York` | No | PERM | IANA |
| primary_owner_user_id | fk Users | `u_01HXY...` | No | PERM | |
| logo_r2_key | string | `host/agency/logo.png` | No | PERM | |
| brand_color | string | `#0F4C81` | No | PERM | |
| billing_email | string | `billing@acme.example` | No | PERM | not PHI |

### `Users`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| user_id | string (ULID) | `u_01HXY...` | No | R7y after deactivation | |
| tenant_id | string | | No | | |
| email | string | `pat@acme.example` | No | R7y | indexed |
| phone_e164 | string | `+13015551234` | No (staff) | R7y | |
| display_name | string | `Pat Reyes` | No | R7y | |
| role_id | fk Roles | `role_scheduler` | No | R7y | |
| interpreter_id | fk Interpreters | nullable | No | R7y | set if role contains `interpreter` |
| status | enum | `active`, `invited`, `suspended`, `archived` | No | R7y | |
| mfa_enabled | bool | `true` | No | R7y | |
| webauthn_credential_ids | json | `["..."]` | No | R7y | |
| last_login_at | ts | | No | R7y | |
| pii_scope | json | `{"consumer":"masked"}` | No | R7y | step-up scope cache |
| failed_login_count | int | | No | R7y | |
| sso_subject | string | | No | R7y | for SAML/OIDC |

### `Roles`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| role_id | string | `role_scheduler` | No | PERM | |
| tenant_id | string | `*` for system roles | No | PERM | |
| display_name | string | `Scheduler` | No | PERM | |
| permissions | json | `["job.read","job.write","consumer.read.masked"]` | No | PERM | dot-notated permission strings |
| can_break_glass | bool | `false` | No | PERM | |
| max_pii_scope | enum | `none`,`masked`,`full` | No | PERM | |

System roles ship pre-baked: `role_owner`, `role_admin`, `role_scheduler`, `role_interpreter`, `role_requestor_contact`, `role_payer_contact`, `role_consumer_self`, `role_auditor`.

### `Interpreters`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| interpreter_id | ULID | `i_01HXY...` | No | R7y | |
| user_id | fk Users | | No | R7y | |
| classification | enum | `W2`, `1099` | No | R7y | |
| legal_first | string | `Fallon` | No (staff PII) | R7y | |
| legal_last | string | `Brizendine` | No | R7y | |
| pronouns | string | `she/her` | No | R7y | |
| home_city | string | `Frederick` | No | R7y | |
| home_state | string | `MD` | No | R7y | |
| home_zip | string | `21701` | No | R7y | |
| service_radius_mi | int | `60` | No | R7y | |
| has_vehicle | bool | `true` | No | R7y | |
| modalities | json | `["on-site","VRI","OPI"]` | No | R7y | |
| languages | json | `[{lang:"ASL",dir:"bi"},{lang:"en-US",dir:"voice"}]` | No | R7y | |
| certifications | json | `[{cert:"NIC",number:"...",exp:"2028-04"}]` | No | R7y | denormalized from Certifications |
| skills | json | `["medical","mental-health","legal","education","VRS"]` | No | R7y | |
| rate_card_id | fk Settings | | No | R7y | |
| min_call_hours | decimal | `2.0` | No | R7y | |
| availability_prefs | json | `{quiet_hours:["22:00","06:00"]}` | No | R7y | |
| availability_doc_id | string | DO key | No | R7y | hot state lives in DO |
| payment_method | enum | `ach`,`check`,`paypal` | No | R7y | |
| payment_details_encrypted | string | KMS-wrapped | **PII** | R7y | envelope-encrypted |
| w9_doc_id | fk Documents | | No | R7y | |
| coi_doc_id | fk Documents | | No | R7y | certificate of insurance |
| background_check_at | date | | No | R7y | |
| deaf | bool | `true` | No | R7y | used for Deaf-owned verification and CDI routing |
| notes_internal | text | | No | R7y | |
| status | enum | `active`,`paused`,`offboarded` | No | R7y | |

### `Languages`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| language_id | string | `ASL`, `es-MX`, `cmn-CN`, `ar-MSA` | No | PERM | BCP-47-ish |
| display_name | string | `American Sign Language` | No | PERM | |
| family | enum | `signed`,`spoken`,`written` | No | PERM | |
| directionalities | json | `["bi","voice-only","sign-only"]` | No | PERM | |
| dialects | json | `["Black ASL","PSE","Contact"]` | No | PERM | |
| script | string | `Latn`, `Arab`, `Hans` | No | PERM | for written/translation jobs |
| rtl | bool | `true` for ar/he | No | PERM | |

### `Certifications`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| certification_id | string | `NIC`, `CDI`, `BEI-Master`, `CCHI`, `CMI-Spanish`, `ATA`, `FCICE`, `MD-Court-Cert` | No | PERM | |
| body | string | `RID`,`BEI`,`NBCMI`,`CCHI`,`ATA`,`AOUSC` | No | PERM | |
| display_name | string | | No | PERM | |
| applies_to_languages | json | `["ASL"]` or `["*"]` | No | PERM | |
| renewable | bool | | No | PERM | |
| ceu_required | bool | | No | PERM | |

### `Requestors`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| requestor_id | ULID | | No | R7y | |
| tenant_id | string | | No | R7y | |
| display_name | string | `Frederick Health Medical Group` | No | R7y | |
| type | enum | `medical`,`legal`,`education`,`gov`,`mental-health`,`corporate`,`other` | No | R7y | drives terminology + billing rules |
| parent_org_id | fk self | nullable | No | R7y | |
| billing_payer_id | fk Payers | | No | R7y | |
| default_location_id | fk Locations | | No | R7y | |
| contract_doc_id | fk Documents | | No | R7y | |
| po_required | bool | | No | R7y | |
| notes | text | | No | R7y | |
| status | enum | `active`,`paused`,`archived` | No | R7y | |

### `Requestor_Contacts`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| contact_id | ULID | | No | R7y | |
| requestor_id | fk | | No | R7y | |
| user_id | fk Users | nullable | No | R7y | set only if the contact has portal login |
| first | string | `Maria` | No | R7y | not patient, this is the booker |
| last | string | `Gomez` | No | R7y | |
| email | string | | No | R7y | |
| phone_e164 | string | | No | R7y | |
| title | string | `Front Desk Lead` | No | R7y | |
| preferred_channel | enum | `email`,`sms`,`portal` | No | R7y | |
| status | enum | | No | R7y | |

### `Payers`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| payer_id | ULID | | No | R7y | |
| tenant_id | string | | No | R7y | |
| display_name | string | `Frederick Health Central Billing` | No | R7y | |
| billing_email | string | | No | R7y | |
| billing_address | json | | No | R7y | |
| net_terms | int | `30` | No | R7y | |
| tax_exempt | bool | | No | R7y | |
| stripe_customer_id | string | nullable | No | R7y | |
| qb_customer_id | string | nullable | No | R7y | |
| status | enum | | No | R7y | |

### `Consumers` (PHI-heavy)

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| consumer_id | ULID | | No | OBO | id itself is non-PHI |
| tenant_id | string | | No | OBO | |
| display_initials | string | `J.M.` | **PHI** | OBO | shown by default |
| legal_first_encrypted | string | KMS-wrapped | **PHI** | OBO | envelope encryption, sealed |
| legal_last_encrypted | string | | **PHI** | OBO | |
| dob_encrypted | string | | **PHI** | OBO | |
| mrn_encrypted | string | per-requestor MRN | **PHI** | OBO | unique per requestor |
| primary_language_id | fk Languages | | **PHI** | OBO | language preference is PHI in clinical context |
| dialect | string | | **PHI** | OBO | |
| communication_prefs | json | `{deaf:true,uses_cdi:true,tactile:false}` | **PHI** | OBO | |
| notes_sealed | text encrypted | | **PHI** | OBO | break-glass required to read |
| do_not_contact | bool | | No | OBO | |
| consent_recording_default | bool | | No | OBO | |
| created_by_user_id | fk Users | | No | OBO | |
| deletion_requested_at | ts | nullable | No | OBO | starts the 30-day fulfillment SLA |

PHI rule: a free-tier (`phi_mode = initials-only`) agency cannot write any column flagged PHI other than `display_initials`. Apps Script enforces this at the handler.

### `Locations`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| location_id | ULID | | No | R7y | |
| requestor_id | fk | | No | R7y | |
| display_name | string | `Frederick Health — Audiology, Suite 210` | No | R7y | |
| street | string | | No | R7y | |
| city/state/zip | strings | | No | R7y | |
| timezone | string | | No | R7y | |
| parking_notes | text | | No | R7y | |
| accessibility_notes | text | | No | R7y | |
| geo | json | `{lat,lng}` | No | R7y | for routing/radius |
| modalities_supported | json | `["on-site","VRI"]` | No | R7y | |

### `Jobs` (the lifecycle heart)

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| job_id | ULID | `j_01HXY...` | No | R7y | |
| tenant_id | string | | No | R7y | |
| requestor_id | fk | | No | R7y | |
| requestor_contact_id | fk | | No | R7y | |
| payer_id | fk | | No | R7y | |
| location_id | fk | nullable for VRI/OPI | No | R7y | |
| consumer_id | fk | nullable until known | **PHI** (link) | R7y | |
| modality | enum | `on-site`,`VRI`,`OPI` | No | R7y | |
| service_type | enum | `medical`,`mental-health`,`legal`,`education`,`gov`,`corporate`,`community`,`translation` | No | R7y | |
| source_language_id | fk | | No | R7y | |
| target_language_id | fk | | No | R7y | |
| team_config | enum | `solo`,`team-of-2`,`cdi+hearing`,`voicer+signer`,`cart-solo` | No | R7y | |
| scheduled_start | ts | | No | R7y | |
| scheduled_end | ts | | No | R7y | |
| actual_start | ts | | No | R7y | |
| actual_end | ts | | No | R7y | |
| status | enum | see lifecycle | No | R7y | |
| on_demand | bool | | No | R7y | |
| reference_no | string | requestor's PO/case# | No | R7y | |
| notes_to_interpreter | text | | possibly PHI | R7y | redactor runs before model |
| consent_recording | bool | | No | R7y | |
| recording_r2_key | string | nullable | **PHI** if linked to consumer | R30d audio / R1y transcript | |
| transcript_r2_key | string | nullable | **PHI** | R1y | |
| created_via | enum | `portal`,`email-intake`,`phone`,`api`,`recurrence` | No | R7y | |
| ai_intake_id | fk Communications | nullable | No | R7y | |
| rate_applied | json | snapshot of rate card at create | No | R7y | |
| cancellation_reason | string | | No | R7y | |
| cancellation_at | ts | | No | R7y | |

**Job status lifecycle:** `DRAFT → PENDING_REVIEW → OPEN → OFFERED → CLAIMED → CONFIRMED → EN_ROUTE → IN_PROGRESS → COMPLETED → BILLED → PAID` with side-branches `CANCELLED_BY_REQUESTOR`, `CANCELLED_BY_AGENCY`, `NO_SHOW_CONSUMER`, `NO_SHOW_INTERPRETER`, `RESCHEDULED`.

### `Job_Assignments`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| assignment_id | ULID | | No | R7y | |
| job_id | fk | | No | R7y | |
| interpreter_id | fk | | No | R7y | |
| role_on_job | enum | `primary`,`team`,`cdi`,`hearing-voicer`,`cart-captioner`,`translator-of-record`,`reviewer` | No | R7y | |
| offered_at | ts | | No | R7y | |
| responded_at | ts | | No | R7y | |
| response | enum | `claim`,`decline`,`tentative` | No | R7y | |
| pay_rate_snapshot | json | | No | R7y | |
| billable_minutes | int | | No | R7y | computed |
| status | enum | mirrors Jobs sub-status | No | R7y | |

### `Job_Events` (state-change audit, separate from `Audit_Log`)

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| event_id | ULID | | No | R7y | |
| job_id | fk | | No | R7y | |
| actor_user_id | fk Users | system events = `system` | No | R7y | |
| event_type | enum | `status_change`,`assignment_offered`,`note_added`,`recording_started`,`recording_paused` | No | R7y | |
| from_state | string | | No | R7y | |
| to_state | string | | No | R7y | |
| payload | json | | possibly PHI | R7y | redactor before any LLM call |
| ts | ts | | No | R7y | |

### `Communications`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| comm_id | ULID | | No | R7y | |
| channel | enum | `email`,`sms`,`push`,`portal` | No | R7y | |
| direction | enum | `out`,`in` | No | R7y | |
| template_id | string | `job_offer_v3` | No | R7y | |
| to_user_id | fk | | No | R7y | |
| to_address | string | redacted in display | **PII** | R7y | |
| body_redacted_r2_key | string | | possibly PHI | R7y | original stored in R2 SSE |
| status | enum | `queued`,`sent`,`delivered`,`bounced`,`failed` | No | R7y | |
| provider | string | `postmark`,`twilio` | No | R7y | |
| provider_msg_id | string | | No | R7y | |
| job_id | fk | nullable | No | R7y | |

### `Invoices`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| invoice_id | string | `INV-2026-000412` | No | R7y | |
| payer_id | fk | | No | R7y | |
| period_start | date | | No | R7y | |
| period_end | date | | No | R7y | |
| issued_at | ts | | No | R7y | |
| due_at | ts | | No | R7y | |
| subtotal_cents | int | | No | R7y | |
| tax_cents | int | | No | R7y | |
| total_cents | int | | No | R7y | |
| status | enum | `draft`,`issued`,`paid`,`overdue`,`void` | No | R7y | |
| stripe_invoice_id | string | nullable | No | R7y | |
| pdf_r2_key | string | | No | R7y | |

### `Invoice_Lines`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| line_id | ULID | | No | R7y | |
| invoice_id | fk | | No | R7y | |
| job_id | fk | | No | R7y | |
| description | string | requestor-facing, no PHI | No | R7y | system-generated from job |
| quantity | decimal | | No | R7y | |
| unit | enum | `hour`,`minute`,`day`,`word`,`page` | No | R7y | |
| rate_cents | int | | No | R7y | |
| amount_cents | int | | No | R7y | |

### `Payouts`

Same structure as Invoices but per interpreter; `lines` reference `Job_Assignments` not `Jobs` directly.

### `Documents`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| document_id | ULID | | No | R7y / OBO if consumer-linked | |
| tenant_id | string | | No | | |
| kind | enum | `translation-source`,`translation-target`,`coi`,`w9`,`certification`,`signed-minutes`,`contract`,`transcript`,`recording` | No | | |
| r2_key | string | `{tenant_id}/docs/{document_id}/{filename}` | No | | actual bytes |
| mime | string | | No | | |
| sha256 | string | | No | | for integrity |
| size_bytes | int | | No | | |
| linked_job_id | fk | nullable | No | | |
| linked_interpreter_id | fk | nullable | No | | |
| linked_consumer_id | fk | nullable | **PHI link** | | |
| uploaded_by_user_id | fk | | No | | |
| signed_url_expiry_default | int | seconds, default `300` | No | | |
| retention_class | enum | overrides default | No | | |

### `Audit_Log`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| audit_id | ULID | | No | R7y | append-only |
| tenant_id | string | | No | R7y | |
| ts | ts | | No | R7y | |
| user_id | fk | nullable for system | No | R7y | |
| ip | string | | No | R7y | |
| user_agent | string | | No | R7y | |
| action | string | `consumer.read`,`consumer.read.break_glass`,`role.change`,`auth.login`,`export.csv` | No | R7y | |
| record_type | string | `Consumers`,`Jobs`,... | No | R7y | |
| record_id | string | | No | R7y | |
| purpose_of_use | enum | `treatment`,`payment`,`operations`,`legal`,`audit`,`emergency` | No | R7y | required for any PHI read |
| result | enum | `allow`,`deny` | No | R7y | |
| jti | string | JWT id | No | R7y | dedupe |

### `Settings`

| column_name | type | example | PHI? | retention | notes |
| --- | --- | --- | --- | --- | --- |
| key | string | `rate_card.medical.on-site.solo` | No | PERM | |
| value | json | | No | PERM | |
| category | enum | `rate-card`,`cancellation-policy`,`terminology`,`branding`,`notify-template`,`integration` | No | PERM | |
| updated_by_user_id | fk | | No | PERM | |
| updated_at | ts | | No | PERM | |

---

## A4. Cloudflare Worker design

All Workers share `lib/jwt.ts`, `lib/tenant.ts`, `lib/sheet-rpc.ts`, `lib/redact.ts`, `lib/audit.ts`. Each Worker is a separate service with its own route binding under `*.1891interpreter.com`.

### `workers/api`

Public REST. JWT-gated (`Authorization: Bearer <jwt>`). Read paths hit KV first, fall through to `workers/sync`. Write paths go through `workers/sync` (write-through). Rate limit: 60 req/min/user for reads, 20/min/user for writes, 300/min/tenant aggregate. Bound: `KV_CACHE`, `R2_DOCS`, `DO_AGENCY_HUB`, `SYNC_FETCHER` (service binding), Secrets: `JWT_PUBLIC_KEY`, `KMS_DATA_KEY_REF`.

Resource endpoints:

```
GET    /v1/me
GET    /v1/agency
GET    /v1/jobs?status=&from=&to=&interpreter_id=&page=
POST   /v1/jobs                           # create (DRAFT|PENDING_REVIEW)
GET    /v1/jobs/:id
PATCH  /v1/jobs/:id                       # status transitions, notes
POST   /v1/jobs/:id/offer                 # broadcast to qualified interpreters
POST   /v1/jobs/:id/assign                # explicit assignment
POST   /v1/jobs/:id/cancel
POST   /v1/jobs/:id/recording/start
POST   /v1/jobs/:id/recording/pause
POST   /v1/jobs/:id/recording/stop
GET    /v1/interpreters?lang=&cert=&modality=&radius_zip=
GET    /v1/interpreters/:id
PATCH  /v1/interpreters/:id/availability  # writes through to DO + Sheet
GET    /v1/consumers/:id                  # step-up required
POST   /v1/consumers/:id/break-glass      # records purpose, returns short-lived token
GET    /v1/requestors, /v1/payers, /v1/locations, /v1/documents
POST   /v1/documents/upload-url           # presigns R2 PUT, returns key
GET    /v1/documents/:id/download-url     # presigns R2 GET, 5min default
GET    /v1/invoices, POST /v1/invoices/run
GET    /v1/payouts, POST /v1/payouts/run
GET    /v1/audit?from=&to=&user_id=       # auditor role only
POST   /v1/admin/tenants                  # control-plane only
```

### `workers/sync`

The only Worker that talks to Apps Script. Service-bound from `api` and `notify` only (not public). Holds the write coalescing buffer (5s window) to avoid SpreadsheetApp lock storms. Bidirectional: Apps Script posts back to `POST /sync/inbound` (HMAC-signed by the script's secret) when a Sheet row is edited by a human directly (which still happens — agency owners edit Settings by hand).

Data flow: `api` calls `sync.upsert(tenant_id, tab, row)` → sync buffers → flushes via `fetch(APPS_SCRIPT_WEBAPP_URL, {method:'POST', body:...})` with HMAC → Apps Script writes row, returns `{row_id, _rev}` → sync invalidates KV → emits `RowChanged` event on the agency DO.

Secrets: `APPS_SCRIPT_WEBAPP_URL`, `APPS_SCRIPT_SHARED_SECRET`.

### `workers/realtime`

WebSocket Worker. Two DO classes:

- **`AgencyHub`** — one per tenant. State: open jobs index, interpreter presence map (`interpreter_id → {online, last_ping, current_status}`), scheduler subscriptions. Receives `RowChanged` events from sync, fans out to subscribers. Endpoints: `GET /rt/agency/:tenant_id` (WS upgrade); messages: `subscribe`, `presence.ping`, `job.subscribe`. Survives indefinitely while any client connected.
- **`JobRoom`** — created lazily when a job goes `OFFERED`. Holds the live offer fan-out, claim race resolution (first-claim-wins, DO single-threaded), and the in-progress recording state if applicable. Auto-destruct 60s after the last client disconnects and job is `COMPLETED` or `CANCELLED`.

Auth: short-lived `rt_token` (5 min) minted by `workers/api` containing `tenant_id`, `user_id`, `role`. Validated on WS upgrade. Rate limit: 10 messages/sec/connection.

### `workers/notify`

Queue-bound fan-out. Reads from `Q_NOTIFY` (Cloudflare Queues). Each message: `{tenant_id, channel, template_id, to_user_id, payload}`. Resolves to user via sync, picks provider, sends, writes `Communications` row. Providers: Postmark for email (BAA-able), Twilio for SMS (BAA-able), Web Push for in-browser. Secrets per tenant where possible — enterprise tier brings their own keys via Settings.

### `workers/translate`

Document translation pipeline.

```
POST /v1/translate/jobs           # body: {requestor_id, source_lang, target_lang, doc_keys[]}
GET  /v1/translate/jobs/:id
POST /v1/translate/jobs/:id/assign-translator
POST /v1/translate/jobs/:id/upload-target
POST /v1/translate/jobs/:id/approve
```

The pipeline:
1. Source doc lands in R2 under `{tenant_id}/translation/{job_id}/source/`.
2. Worker extracts text (Mammoth for .docx, pdf-parse equivalent for PDF, plaintext otherwise) — all server-side, no third-party doc parser.
3. Optional machine-translation pre-fill: **DeepL API for spoken-language pairs DeepL supports** (better quality than general LLMs for translation, BAA available on DeepL Pro), Claude for everything DeepL doesn't cover and for terminology-sensitive editing passes. Default is "translator-of-record only" — no MT pre-fill — for legal and medical jobs unless the requestor opts in.
4. Assigned translator gets a job in their dashboard, downloads source via signed URL, uploads target.
5. Reviewer (optional second-pass role) approves; final file moves to `{tenant_id}/translation/{job_id}/final/`.
6. Requestor gets a signed download URL valid for 7 days.

Secrets: `DEEPL_API_KEY`, `ANTHROPIC_API_KEY` (only invoked with redacted text — see A6).

### `workers/auth`

Magic-link issuance, JWT mint, WebAuthn enrollment + assertion, SSO callbacks.

```
POST /auth/magic-link                # body: {email, tenant_slug}
GET  /auth/callback?token=           # verifies, mints JWT, sets cookie
POST /auth/webauthn/begin-register
POST /auth/webauthn/finish-register
POST /auth/webauthn/begin-login
POST /auth/webauthn/finish-login
GET  /auth/sso/saml/:tenant/init
POST /auth/sso/saml/:tenant/acs
POST /auth/step-up                   # for PHI re-prompt
POST /auth/logout
```

Magic-link tokens: 32-byte random, hashed with SHA-256, stored in KV with 15-min TTL, single-use. Email send via Postmark `magic-link-v1`. SMS option via Twilio Verify (recommended over hand-rolled OTP — see A9). Step-up returns a `pii_scope` upgrade for 5 minutes only, then reverts.

JWT signed with EdDSA (Ed25519), keys in Cloudflare Secrets Store. Rotation quarterly with `kid` claim and dual-key acceptance window.

---

## A5. Auth and session model

**Default flow:** user enters email at `app.<slug>.1891interpreter.com/auth` → `POST /auth/magic-link` → email arrives → click → `GET /auth/callback` mints JWT, sets `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=900` cookie + a separate refresh cookie with 12h TTL.

**SMS option** added behind feature flag `allow_sms_magic_link` (some agencies want it, some IT departments will hard-reject it). When enabled, Twilio Verify is used — we do not roll our own SMS OTP.

**WebAuthn / passkey** enrollment offered after first successful magic-link login. Stored credential IDs in `Users.webauthn_credential_ids`. Once enrolled, passkey is the primary path; magic-link remains as recovery. Required for `role_admin` and `role_owner` on `pro` and `enterprise` tiers.

**SSO (SAML 2.0 + OIDC)** available on `enterprise` only. Per-tenant IdP config in `Settings` under `integration.sso.*`. JIT user provisioning maps the IdP's group claim to a role via `Settings.integration.sso.role_map`. SAML for the hospitals, OIDC for the law firms — both supported because we don't get to pick.

**JWT claim shape:**

```json
{
  "iss": "auth.1891interpreter.com",
  "sub": "u_01HXY...",
  "tenant_id": "acme-interp",
  "tenant_slug": "acme",
  "role": "role_scheduler",
  "interpreter_id": null,
  "pii_scope": "masked",
  "phi_mode": "full",
  "amr": ["mlink"],
  "exp": 1747443600,
  "iat": 1747442700,
  "jti": "01HXY..."
}
```

`pii_scope` values: `none | masked | full`. Default for `role_scheduler` is `masked`. Step-up auth issues a new JWT with `pii_scope: "full"` and `exp` set to now+300s — written to a separate cookie `__phi_session` that the browser sends only on PHI endpoints (`Path=/v1/consumers`).

**Session timeout matrix:**

| Surface | Idle timeout | Hard cap | Notes |
| --- | --- | --- | --- |
| Agency portal (`/app/*`) | 15 min | 12 h | any PHI view |
| Interpreter portal (`/me/*`) | 30 min | 12 h | no PHI by default |
| Requestor portal (`/req/*`) | 15 min | 12 h | may show consumer |
| Payer portal (`/pay/*`) | 30 min | 12 h | money only |
| Consumer booking (`/book/<slug>`) | none | session | no auth, no PHI |
| Step-up PHI window | 5 min | 5 min | non-renewable; new prompt each time |

Idle is enforced both client-side (a heartbeat tab listens for activity, calls `POST /v1/heartbeat` every 60s; on no-activity for the threshold the JWT is intentionally not refreshed) and server-side (refresh endpoint refuses when `last_activity` exceeds the timeout).

**Step-up for consumer read:** clicking "Show full name" on a consumer row triggers a modal that requires either passkey assertion or a freshly-issued 6-digit OTP to the user's verified channel. Successful step-up writes an `Audit_Log` row with `action: consumer.read.step_up`, `purpose_of_use` selected from a dropdown by the user before continuing.

---

## A6. HIPAA + PII compliance posture

**Stack-side BAA inventory:**

| Subprocessor | What it processes | BAA available | Notes |
| --- | --- | --- | --- |
| Google Workspace (Sheets, Apps Script, Drive when used) | Source-of-truth row data, blobs we keep in Drive (none planned) | Yes, on Business+ / Enterprise | Requires the agency's own Workspace tenant for full coverage. Host-tenant Sheets sit under `anthonymowl@gmail.com` Workspace which has BAA. |
| Cloudflare (Workers, R2, KV, DO, Queues) | Application traffic, blob storage, hot state | Yes, on Enterprise | Free/Pro tier explicitly **does not** carry a BAA. The `enterprise` tier of 1891 Interpreter requires Cloudflare Enterprise — we'll resell or piggyback. Free/Deaf-owned tier is `phi_mode != full` to stay off the BAA-required path. |
| Postmark | Transactional email | Yes (paid) | Requires HIPAA add-on; templates must omit PHI body |
| Twilio | SMS, Verify | Yes | HIPAA-eligible products only; messaging body templates must omit PHI |
| Stripe | Payment | Yes (limited) | Stripe BAA is narrow; we keep diagnosis codes etc out of metadata |
| Deepgram | Live STT | Yes | Audio is PHI; per-tenant API keys; no audio retention on vendor side |
| Anthropic | Claude API for intake parsing, summaries | Yes (Claude for Work / API BAA via enterprise) | We bind to BAA-eligible model endpoints and never send raw PHI — see redaction contract below |
| DeepL Pro | Document translation MT | Yes (DeepL Pro Advanced has DPA + BAA on EU enterprise) | Translation source is PHI; opt-in per tenant |

**Encryption:**

- In transit: TLS 1.3 enforced via Cloudflare. HSTS preload. mTLS between Worker and Apps Script via cf-access service token + HMAC on body.
- At rest in Sheets: Google's at-rest encryption. Sensitive fields (`payment_details`, `consumer.legal_*`, `consumer.mrn`, `consumer.notes_sealed`) additionally **envelope-encrypted** at the app layer: a per-tenant data encryption key (DEK) is wrapped by a master KMS key (Cloudflare's KMS or Google KMS — recommend Google to keep BAA boundary tight); ciphertext stored in the cell, DEK ID in a sibling column.
- At rest in R2: SSE-C with per-tenant data keys derived from the tenant DEK.
- At rest in KV: any value containing a PHI-flagged column is encrypted at app layer before write; KV holds ciphertext only. Lookups by id, not by PHI.

**Audit logging contract:** every PHI read or write — every row pulled from `Consumers`, every cell of a `notes_sealed`, every signed URL minted for a `Documents` row linked to a consumer, every break-glass action, every `pii_scope` step-up, every role change, every export — writes a row to `Audit_Log` via a single `lib/audit.ts` helper. The helper is called from inside `assertTenantAccess()` so it's not skippable. `Audit_Log` retention: 7 years, append-only (Apps Script enforces no-edit by checking the tab's editor protection range; an integrity hash chain links rows for tamper evidence).

**Break-glass:** roles with `can_break_glass = true` (agency owner, on-call scheduler, audit-mode user) can read `consumer.notes_sealed` after `POST /v1/consumers/:id/break-glass` with required body `{purpose_of_use, justification}`. Returns a 5-minute scoped token. Every such read writes `action: consumer.notes_sealed.read.break_glass` plus the justification text into `Audit_Log`. Anthony's `host` tenant gets a weekly digest email of every break-glass event across all tenants (system-level oversight role).

**Retention defaults (per root CLAUDE.md, applied here):**

| Class | Default | Override path |
| --- | --- | --- |
| Raw audio of sessions | 30 days | Cannot be extended without legal review; can be shortened by tenant |
| Live transcripts | 1 year | Per-tenant in Settings |
| Approved minutes / signed summaries | Permanent | This is the legal record |
| Job records | 7 years | HIPAA minimum |
| `Audit_Log` | 7 years | Non-editable |
| Consumer demographics | OBO (until consumer requests deletion) | 30-day fulfillment SLA via `consumer.deletion_requested_at` sweeper |
| Executive-session / paused-mic content | Never recorded | N/A |

Deletion fulfillment: a daily Apps Script sweeper finds rows with `deletion_requested_at < now - 30d`, redacts PHI fields to NULL, replaces with a tombstone (`{deleted_at, deletion_request_id}`), keeps the row for referential integrity in `Jobs`. R2 blobs linked to the consumer are tombstoned (object deleted, manifest kept).

**AI-feature contract (the precise rule the AI-features section follows):**

Before any call to Anthropic/Claude (or DeepL, or any external model):

1. **The payload must not contain `legal_first`, `legal_last`, `dob`, `mrn`, full street address, phone, email, or `notes_sealed`.** A central `lib/redact.ts` `redactForModel(jobOrContext)` function returns a "model-safe" projection: `{job_id, modality, service_type, source_language, target_language, requestor_type, location_city_state, scheduled_start, team_config, consumer_initials, consumer_communication_prefs}`.
2. Free-text fields (`notes_to_interpreter`, email-intake body) are run through a PHI scrubber (regex + named-entity replacement: names → `[PERSON]`, MRN-shaped strings → `[MRN]`, DOB → `[DOB]`, phone → `[PHONE]`, address → `[ADDRESS]`).
3. The model is given the redacted text plus the surrounding structured context. The model returns structured JSON; the orchestrator joins back to the real PHI on our side.
4. Every model call writes an `Audit_Log` row with `action: ai.model.invoke`, `record_type: <thing>`, `record_id`, plus a SHA-256 hash of the redacted prompt (so we can prove what we sent without storing it).
5. Free-tier (`phi_mode: initials-only`) tenants get AI features. `pro` and `enterprise` tenants can choose to opt out per-feature.

**Maryland-specific:** two-party consent. Any session that records audio requires a captured consent (recorded in `Job_Events` with `event_type: consent_captured` per attendee) plus a visible RECORDING indicator throughout. Aligns with the audio contract in root CLAUDE.md.

**SOC 2-light controls (year 1, not certified):**

- Change management: every prod deploy commits a tagged release; `deploy.sh` writes a row to `_Sys_Log` with sha, actor, timestamp.
- Access reviews: quarterly. A script enumerates `Users` with `status=active` per tenant; the agency owner certifies via a one-click portal action.
- Backups: nightly Sheet export to R2 (encrypted) with 35-day retention; quarterly restore drill on `host` tenant.
- Vulnerability management: Dependabot on Worker repos; weekly `npm audit` summary mailed to `security@`.
- Incident response: `RUNBOOK_INCIDENT.md` in repo root; sev-1 paging via PagerDuty or fallback to a Twilio SMS list.

---

## A7. Data flow examples

### Flow 1: Booking via requestor portal → claim by interpreter

```
Front desk (Maria) ─── HTTPS ───► app.acme.1891interpreter.com/req/new
   POST /v1/jobs (body: requestor_contact_id, location_id, lang, start, duration, modality, consumer_initials)
       │
       ▼
   workers/api
       │ 1. validate JWT (tenant=acme, role=requestor_contact)
       │ 2. redact-check (no raw PHI in body unless phi_mode=full)
       │ 3. workers/sync.upsert("Jobs", row)
       │
       ▼
   workers/sync ── HMAC POST ──► Apps Script doPost("jobs.create", payload)
                                       │
                                       │ writes to Jobs tab, returns {job_id, _rev}
                                       ▼
                                Google Sheet (acme workbook)
       │ 4. workers/sync invalidates KV "acme:jobs:open"
       │ 5. fires DO event ─► AgencyHub:acme {type:"job.created", job_id}
       │
       ▼
   AgencyHub:acme
       │ 6. computes qualified interpreters (language, cert, modality, radius, availability)
       │ 7. creates JobRoom:job_id, broadcasts "offer" to each via their WS
       │
       ▼
   Each qualified interpreter (Fallon, Jordan, Priya)
       │ 8. browser tab receives WS msg, renders job card with "Claim" button
       │ 9. notify Worker also sends push + SMS to those who set push/SMS prefs
       │
       ▼
   Fallon clicks Claim ─── WSS ───► JobRoom:job_id {type:"claim"}
       │ 10. JobRoom (single-threaded DO) accepts first claim only
       │ 11. broadcasts {type:"claimed_by", interpreter_id} to other subscribers
       │ 12. workers/sync.upsert("Job_Assignments", row) + Jobs.status=CLAIMED
       │
       ▼
   Apps Script writes both rows, returns OK
   workers/notify queues:
       - email to Maria: "Confirmed: Fallon B."
       - email to Fallon: ICS attached, location, prep notes
       - audit_log row: job.claim
```

### Flow 2: Email intake with AI

```
maria@frederickhealth.example ──► intake@acme.1891interpreter.com
                                          │
                              Cloudflare Email Routing
                                          │ (raw RFC822)
                                          ▼
                          workers/api  POST /v1/intake/email (internal)
                              │ 1. resolve recipient → tenant=acme
                              │ 2. parse MIME, extract text, store raw in R2
                              │    key: acme/intake/{comm_id}/raw.eml (encrypted)
                              │ 3. write Communications row (direction=in)
                              │ 4. lib/redact.redactForModel(body) → scrubbed text
                              │
                              ▼
                          Anthropic Claude API (BAA endpoint)
                              prompt: "Extract booking fields from below. Return JSON.
                                       Available fields: source_lang, target_lang, modality,
                                       service_type, location_hint, start, duration,
                                       requestor_contact_email, consumer_initials_only,
                                       notes_for_interpreter."
                              input: scrubbed body, no names
                                          │
                                          ▼
                          structured JSON
                              │ 5. orchestrator joins back: looks up requestor_contact by sender email,
                              │    resolves location_hint against Locations,
                              │    leaves consumer_id null (scheduler approves)
                              │ 6. writes Jobs row, status=PENDING_REVIEW, created_via=email-intake,
                              │    ai_intake_id=comm_id
                              │
                              ▼
                          AgencyHub:acme broadcasts "job.pending_review" to schedulers
                              │
                              ▼
                          Scheduler opens /app/intake, sees draft, hits Approve
                              ── PATCH /v1/jobs/:id {status:OPEN}
                              │ from here flow merges with Flow 1
```

### Flow 3: Document translation

```
Requestor uploads via /req/translate/new
   POST /v1/documents/upload-url body:{filename, mime, size, kind:"translation-source"}
       │
       ▼
   workers/api mints presigned R2 PUT to acme/translation/{job_id}/source/{filename}
       │
   Browser PUTs file directly to R2 (no Worker bandwidth)
       │
   Browser POSTs /v1/translate/jobs {requestor_id, source_lang, target_lang, doc_keys:[...]}
       │
       ▼
   workers/translate
       │ 1. write Jobs row service_type=translation, modality=null
       │ 2. write Documents rows for each upload
       │ 3. compute qualified translators-of-record (language, ATA cert if legal, etc.)
       │ 4. AgencyHub broadcasts translation_offer
       │
       ▼
   Translator (Jordan) accepts
       │ 5. dashboard shows source files with 5-min signed GET URLs
       │ 6. (optional, tenant-opted-in) Worker calls DeepL on extracted text;
       │    returns pre-fill stored as Documents kind=translation-target-draft
       │ 7. Jordan downloads, edits in Word, uploads target via /v1/translate/.../upload-target
       │
       ▼
   workers/translate
       │ 8. Documents row kind=translation-target
       │ 9. (if requested) reviewer assigned for second-pass; otherwise auto-approve
       │ 10. Jobs.status=COMPLETED
       │ 11. workers/notify emails requestor with 7-day signed GET URL
       │
       ▼
   Maria downloads target, invoice line accrues to Payer's next monthly Invoice
```

---

## A8. Migration and onboarding

**Onboarding wizard** lives at `app.<slug>.1891interpreter.com/onboard` after first owner login. Five steps:

1. **Tenant basics:** legal name, timezone, brand color, logo upload (R2).
2. **Tier + BAA:** owner picks tier; if `pro` or `enterprise`, the BAA template generates as a PDF (filled from Settings), DocuSign-equivalent signature, signed copy stored in Documents.
3. **Import:** CSV upload zone with templates for each tab. `migrate.py` (lives in `~/Desktop/1891/projects/interpreter/scripts/`) runs locally for big imports, or browser-side for small ones. Drop-in templates for Boostlingo CSV export, Excel scheduling sheets, FileMaker exports. Each row is **dry-run validated first** (writes to a hidden `_Staging_*` tab) — owner reviews counts and sample rows, then promotes.
4. **Rate cards:** preset rate-card templates per market (medical, legal, education, court) seeded into Settings; owner edits.
5. **First job seed:** create a sample job to walk through the lifecycle once.

**The CSV-import script** speaks each Sheet tab's column contract and provides:

```
python migrate.py --tenant acme --source boostlingo --csv path/to/export.csv --dry-run
python migrate.py --tenant acme --source boostlingo --csv path/to/export.csv --commit
```

Dry-run prints: column mapping diff, row counts, validation errors per row, duplicate detection, PHI fields detected. `--commit` is gated behind an interactive confirmation that prints a SHA-256 of the validation report and asks the admin to retype the tenant id.

**Existing-data hygiene:** the importer normalizes language codes to our BCP-47-ish convention, snaps cert codes to the `Certifications` reference list (warning on unmatched), and refuses to import any column flagged PHI when `phi_mode != full`.

---

## A9. Open architectural questions

1. **Sheet-per-agency vs master Sheet.** Recommend **per-agency** for the reasons in A2. The only counter is "harder cross-tenant analytics" — recommend solving that via a separate analytics pipeline (nightly export to BigQuery via Apps Script trigger) rather than collapsing the data plane.

2. **Cloudflare BAA / enterprise tier requirement.** The free Deaf-owned tier can't ride Cloudflare Enterprise economics. Recommend **two-mode**: `phi_mode: initials-only` for free tier (no BAA-required surface), `phi_mode: full` requires the agency to be on `pro` or `enterprise` priced with the Cloudflare cost baked in. Worth confirming with Anthony before architecting around it.

3. **SMS vendor + Twilio Verify.** Recommend **Twilio Verify** for the SMS magic-link option rather than hand-rolling OTP delivery via Twilio Messaging. Better deliverability, native rate limiting, and the BAA scope is cleaner.

4. **Email vendor.** Recommend **Postmark** for transactional (BAA, great deliverability, simple template engine). Alternates: Resend (newer, no BAA last I checked — verify), AWS SES (BAA available but more ops overhead).

5. **Translation MT default.** Recommend **DeepL Pro for spoken-language pairs DeepL supports; Claude for everything else; no MT pre-fill for legal/medical unless requestor opts in.** This keeps the translator-of-record liability clean.

6. **Live STT vendor.** Recommend **Deepgram Nova-3** per the workspace audio contract, with the `StreamingStt` interface from `shared/specs/SPEECH_PROCESSING.md`. Don't break the abstraction.

7. **SAML for enterprise tier.** Recommend **required for enterprise** but optional for pro. Hospitals will demand it; small agencies will hate the setup. Consider WorkOS as the SSO broker if rolling our own SAML proves heavy — note it's a subprocessor we'd need on the BAA.

8. **Payment vendor.** Recommend **Stripe** for card + ACH on the invoice side. For interpreter payouts, recommend **Stripe Connect Express** with 1099 generation built-in. Alternate: Gusto for full W-2 payroll if any agency needs us to run payroll — recommend we punt on payroll year-one and integrate read-only with the agency's payroll provider.

9. **Where the `host` tenant's Sheet lives.** Recommend **Anthony's `anthonymowl@gmail.com` Workspace** for now since BAA is in place there, with a documented migration to a `1891interpreter.com` Workspace once tenant count > 5. Worth getting Anthony's call before we commit.

10. **WebAuthn requirement for owners/admins.** Recommend **required on pro+ tiers, optional on free**. Magic-link alone is fine for free-tier with no PHI; admins touching PHI should have phishing-resistant auth.

11. **Recurring jobs.** The schema supports `created_via: recurrence` but the recurrence engine isn't designed yet. Recommend **Apps Script time-driven trigger** materializing the next 30 days of recurrence instances nightly into `Jobs`, with a `recurrence_template_id` column added to `Jobs`. Worth confirming the schema addition now.

12. **Telephony for OPI.** Open question: do we provide the phone bridge ourselves (Twilio Programmable Voice + per-job conference room) or hand off to the agency's existing OPI line? Recommend **build the bridge** because it gives us the recording boundary, but defer to a later phase; document the integration point now.
