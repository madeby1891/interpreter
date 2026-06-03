-- 1891 Interpreter — D1 system of record. ADR-001 (shared/specs/PERSISTENCE_ARCHITECTURE.md).
-- Highest-VALUE / highest-LIABILITY migration in the workspace: this is the only
-- product holding PHI + payment records, which today live in a Google Sheet.
--
-- Translated 1:1 from apps-script/Code.gs `_tenantSchema()` (the single source of
-- truth for tabs + column order), plus the control-plane schema in
-- Code_Multitenant.gs (`CONTROL_SCHEMA`) and the three form/auth tabs that live
-- in the Sheet but outside `_tenantSchema()` (Inbound, Deaf_Owned_Applications,
-- Auth_Tokens). Column NAMES and ORDER match the Sheet exactly so the Apps Script
-- path and D1 stay parity-checkable during the strangler cutover (ADR §6 phase 2).
--
-- Conventions (ADR §9):
--   * MULTI-tenant: every per-agency table carries `tenant_id`. One D1 database;
--     split a tenant into its own DB only when it gets large (ADR §9).
--   * Money: INTEGER cents (never float). Source columns are already *_cents.
--   * Time: INTEGER unix-epoch SECONDS. The Sheet stored ISO-8601 strings; D1
--     standardizes on epoch and the nightly mirror (src/mirror.ts) converts back
--     to ISO for the human-readable Sheet (ADR §5). Applies to every *_at,
--     *_start, *_end, ts, issued_at, due_at, sent_at, paid_at, voided_at,
--     expires_at, consumed_at, *_date, period_*, etc.
--   * Booleans: INTEGER 0/1.
--   * List/JSON columns (permissions, modalities, languages, certifications,
--     skills, availability_*, webauthn_credential_ids, *_floors, geo,
--     rate_applied, pay_rate_snapshot, payload, raw_params, …): TEXT holding JSON.
--
-- PHI handling (Code_PHI.gs + workers/api/src/phi.ts) — NON-NEGOTIABLE:
--   The PHI columns on Consumers (legal_first_encrypted, legal_last_encrypted,
--   dob_encrypted, mrn_encrypted, notes_sealed) and Interpreters
--   (payment_details_encrypted) are stored as OPAQUE ciphertext blobs in the
--   `v1:<iv_b64>:<ct_b64>` AES-GCM format. The encryption boundary does NOT move
--   in this migration: Apps Script still calls the Worker's /v1/phi/{encrypt,
--   decrypt} (PHI_MASTER_KEY never leaves Cloudflare). D1 sees the SAME opaque
--   blob the Sheet saw. D1 never decrypts, and the data layer NEVER logs the
--   contents of any *_encrypted / *_sealed column. See db.ts `PHI_BLOB_COLUMNS`.
--
-- Foreign keys: declared as REFERENCES for documentation only. Unlike the
-- single-tenant kgh-data reference impl, this schema does NOT set
-- `PRAGMA foreign_keys = ON`, because the historical backfill (ADR §6 phase 2)
-- inserts rows across tables in bulk and arrival order is not dependency-sorted;
-- enforcing FKs mid-backfill would reject otherwise-valid rows. D1 runtime
-- connections default foreign_keys OFF anyway. Re-enable per-connection only for
-- targeted transactional writes that want the guarantee (e.g. invoice fan-out).

-- ====================================================================
-- CONTROL PLANE (was the separate 1891-interpreter-control Sheet) — Code_Multitenant.gs CONTROL_SCHEMA
-- In Sheets, tenant isolation came from one Sheet per agency; the control Sheet
-- mapped tenant_id -> spreadsheet_id. In D1 it's one DB keyed by tenant_id, but
-- we keep the registry rows here so the mirror knows which Sheet to write back to
-- and so dual-write parity can be checked per tenant.
-- ====================================================================

CREATE TABLE IF NOT EXISTS Tenants (
  tenant_id      TEXT PRIMARY KEY,
  spreadsheet_id TEXT,
  legal_name     TEXT,
  tier           TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     INTEGER,
  created_by     TEXT,
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS Tenant_Owners (
  tenant_id  TEXT NOT NULL REFERENCES Tenants(tenant_id),
  user_id    TEXT NOT NULL,
  user_email TEXT,
  role       TEXT,
  added_at   INTEGER,
  added_by   TEXT,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS Sys_Log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  event         TEXT,
  actor_user_id TEXT,
  tenant_id     TEXT,
  payload       TEXT            -- JSON
);
CREATE INDEX IF NOT EXISTS idx_syslog_tenant_ts ON Sys_Log (tenant_id, ts DESC);

-- ====================================================================
-- TENANT TABLES — verbatim from Code.gs _tenantSchema(), in declared order
-- ====================================================================

-- ── Agencies (one row per tenant; tenant_id is the PK) ───────────────
CREATE TABLE IF NOT EXISTS Agencies (
  tenant_id            TEXT PRIMARY KEY,
  legal_name           TEXT,
  tax_id_last4         TEXT,
  tier                 TEXT,
  phi_mode             TEXT,            -- 'initials-only' (free, off-BAA) | 'pro' | 'enterprise'
  timezone             TEXT,
  primary_owner_user_id TEXT,
  logo_r2_key          TEXT,
  brand_color          TEXT,
  billing_email        TEXT,
  _created_at          INTEGER,
  _updated_at          INTEGER,
  qbo_realm_id         TEXT             -- QuickBooks Online company id when linked; blank otherwise
);
-- qbo_realm_id was appended after the live DB was provisioned, so ALTER it onto
-- the already-deployed table (no-op on a fresh provision):
--   ALTER TABLE Agencies ADD COLUMN qbo_realm_id TEXT;

-- ── Users ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Users (
  user_id                 TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  email                   TEXT,
  phone_e164              TEXT,
  display_name            TEXT,
  role_id                 TEXT,
  interpreter_id          TEXT,
  status                  TEXT NOT NULL DEFAULT 'active',
  mfa_enabled             INTEGER DEFAULT 0,
  webauthn_credential_ids TEXT,         -- JSON array
  last_login_at           INTEGER,
  pii_scope               TEXT,
  failed_login_count      INTEGER DEFAULT 0,
  sso_subject             TEXT,
  calendar_token          TEXT,
  _created_at             INTEGER,
  _updated_at             INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON Users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON Users (email);

-- ── Roles ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Roles (
  role_id         TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  display_name    TEXT,
  permissions     TEXT,                 -- JSON array
  can_break_glass INTEGER DEFAULT 0,
  max_pii_scope   TEXT,
  _created_at     INTEGER,
  _updated_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_roles_tenant ON Roles (tenant_id);

-- ── Interpreters (legal_first/last are staff identity, NOT PHI; payment_details is an encrypted blob) ──
CREATE TABLE IF NOT EXISTS Interpreters (
  interpreter_id            TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  user_id                   TEXT,
  classification            TEXT,
  legal_first               TEXT,
  legal_last                TEXT,
  pronouns                  TEXT,
  home_city                 TEXT,
  home_state                TEXT,
  home_zip                  TEXT,
  service_radius_mi         INTEGER,
  has_vehicle               INTEGER DEFAULT 0,
  modalities                TEXT,        -- JSON array
  languages                 TEXT,        -- JSON array
  certifications            TEXT,        -- JSON array
  skills                    TEXT,        -- JSON array
  rate_card_id              TEXT,
  min_call_hours            REAL,
  availability_prefs        TEXT,        -- JSON
  availability_doc_id       TEXT,
  payment_method            TEXT,
  payment_details_encrypted TEXT,        -- ENCRYPTED BLOB (v1:iv:ct) — never logged
  w9_doc_id                 TEXT,
  coi_doc_id                TEXT,
  background_check_at       INTEGER,
  deaf                      INTEGER DEFAULT 0,
  notes_internal            TEXT,
  status                    TEXT NOT NULL DEFAULT 'active',
  rid_member_number         TEXT,
  bei_member_number         TEXT,
  other_member_numbers      TEXT,        -- JSON
  pay_rate_floors           TEXT,        -- JSON
  cancellation_floors       TEXT,        -- JSON
  evening_premium_pct       REAL,
  weekend_premium_pct       REAL,
  last_minute_premium_pct   REAL,
  holiday_premium_pct       REAL,
  mileage_rate_cents        INTEGER,
  travel_time_rate_cents    INTEGER,
  specialty_endorsements    TEXT,        -- JSON
  availability_windows      TEXT,        -- JSON
  onboarding_completed_at   INTEGER,
  _created_at               INTEGER,
  _updated_at               INTEGER,
  _rev                      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_interpreters_tenant ON Interpreters (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_interpreters_user ON Interpreters (user_id);

-- ── Interpreter_Documents ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Interpreter_Documents (
  doc_id           TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  interpreter_id   TEXT,
  doc_type         TEXT,
  doc_name         TEXT,
  status           TEXT,
  required         INTEGER DEFAULT 0,
  issued_at        INTEGER,
  expires_at       INTEGER,
  reviewer_user_id TEXT,
  reviewed_at      INTEGER,
  file_r2_key      TEXT,
  sha256           TEXT,
  notes            TEXT,
  _created_at      INTEGER,
  _updated_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_interpdocs_tenant_interp ON Interpreter_Documents (tenant_id, interpreter_id);

-- ── Tenant_Requirements ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Tenant_Requirements (
  req_id                   TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  applies_to_service_type  TEXT,
  applies_to_modality      TEXT,
  doc_type                 TEXT,
  display_name             TEXT,
  required                 INTEGER DEFAULT 0,
  reminder_days            INTEGER,
  renewal_period_months    INTEGER,
  notes                    TEXT,
  _created_at              INTEGER,
  _updated_at              INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tenantreq_tenant ON Tenant_Requirements (tenant_id);

-- ── Rate_Modifiers ("trigger" is a SQLite keyword — quoted) ──────────
CREATE TABLE IF NOT EXISTS Rate_Modifiers (
  modifier_id             TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  side                    TEXT,
  kind                    TEXT,
  name                    TEXT,
  "trigger"               TEXT,
  modifier_pct            REAL,
  modifier_cents          INTEGER,
  applies_to_service_type TEXT,
  applies_to_modality     TEXT,
  priority                INTEGER,
  status                  TEXT,
  notes                   TEXT,
  _created_at             INTEGER,
  _updated_at             INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ratemod_tenant ON Rate_Modifiers (tenant_id, status);

-- ── Rate_Cards ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Rate_Cards (
  rate_card_id      TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  side              TEXT,
  service_type      TEXT,
  modality          TEXT,
  team_config       TEXT,
  base_hourly_cents INTEGER,
  minimum_hours     REAL,
  rounding_minutes  INTEGER,
  notes             TEXT,
  _created_at       INTEGER,
  _updated_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ratecards_tenant ON Rate_Cards (tenant_id);

-- ── Notification_Prefs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Notification_Prefs (
  pref_id           TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  user_id           TEXT,
  event_type        TEXT,
  channel           TEXT,
  mode              TEXT,
  phone_e164        TEXT,
  daily_digest_hour INTEGER,
  weekly_digest_day INTEGER,
  quiet_hours       TEXT,
  _created_at       INTEGER,
  _updated_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notifprefs_tenant_user ON Notification_Prefs (tenant_id, user_id);

-- ── Assignment_Notes ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Assignment_Notes (
  note_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  assignment_id  TEXT,
  job_id         TEXT,
  author_user_id TEXT,
  author_role    TEXT,
  body           TEXT,
  visibility     TEXT,
  _created_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_asnnotes_job ON Assignment_Notes (tenant_id, job_id);

-- ── Languages (GLOBAL reference data — no tenant_id, faithful to schema) ──
CREATE TABLE IF NOT EXISTS Languages (
  language_id      TEXT PRIMARY KEY,
  display_name     TEXT,
  family           TEXT,
  directionalities TEXT,                 -- JSON
  dialects         TEXT,                 -- JSON
  script           TEXT,
  rtl              INTEGER DEFAULT 0,
  _created_at      INTEGER,
  _updated_at      INTEGER
);

-- ── Certifications (GLOBAL reference data — no tenant_id) ─────────────
CREATE TABLE IF NOT EXISTS Certifications (
  certification_id     TEXT PRIMARY KEY,
  body                 TEXT,
  display_name         TEXT,
  applies_to_languages TEXT,             -- JSON
  renewable            INTEGER DEFAULT 0,
  ceu_required         INTEGER DEFAULT 0,
  _created_at          INTEGER,
  _updated_at          INTEGER
);

-- ── Requestors ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Requestors (
  requestor_id         TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  client_id            TEXT,
  display_name         TEXT,
  type                 TEXT,
  parent_org_id        TEXT,
  billing_payer_id     TEXT,
  default_location_id  TEXT,
  default_specialist_id TEXT,
  contract_doc_id      TEXT,
  po_required          INTEGER DEFAULT 0,
  notes                TEXT,
  status               TEXT NOT NULL DEFAULT 'active',
  _created_at          INTEGER,
  _updated_at          INTEGER,
  _rev                 INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_requestors_tenant ON Requestors (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_requestors_client ON Requestors (client_id);

-- ── Requestor_Contacts ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Requestor_Contacts (
  contact_id        TEXT PRIMARY KEY,
  requestor_id      TEXT,
  tenant_id         TEXT NOT NULL,
  user_id           TEXT,
  "first"           TEXT,
  "last"            TEXT,
  email             TEXT,
  phone_e164        TEXT,
  title             TEXT,
  preferred_channel TEXT,
  status            TEXT,
  _created_at       INTEGER,
  _updated_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reqcontacts_requestor ON Requestor_Contacts (tenant_id, requestor_id);

-- ── Clients ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Clients (
  client_id                TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  legal_name               TEXT,
  display_name             TEXT,
  client_type              TEXT,
  industry                 TEXT,
  primary_owner_contact_id TEXT,
  primary_payer_id         TEXT,
  billing_address          TEXT,
  billing_email            TEXT,
  billing_phone            TEXT,
  tax_exempt               INTEGER DEFAULT 0,
  tax_id_last4             TEXT,
  net_terms                TEXT,
  contract_doc_id          TEXT,
  notes                    TEXT,
  status                   TEXT NOT NULL DEFAULT 'active',
  _created_at              INTEGER,
  _updated_at              INTEGER,
  _rev                     INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_clients_tenant ON Clients (tenant_id, status);

-- ── Client_Contacts ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Client_Contacts (
  contact_id        TEXT PRIMARY KEY,
  client_id         TEXT,
  tenant_id         TEXT NOT NULL,
  user_id           TEXT,
  role_on_client    TEXT,
  "first"           TEXT,
  "last"            TEXT,
  email             TEXT,
  phone_e164        TEXT,
  title             TEXT,
  department        TEXT,
  preferred_channel TEXT,
  status            TEXT,
  _created_at       INTEGER,
  _updated_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_clientcontacts_client ON Client_Contacts (tenant_id, client_id);

-- ── Specialists ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Specialists (
  specialist_id         TEXT PRIMARY KEY,
  client_id             TEXT,
  tenant_id             TEXT NOT NULL,
  display_name          TEXT,
  department            TEXT,
  specialty_code        TEXT,
  npi                   TEXT,
  default_location_id   TEXT,
  default_modality_pref TEXT,
  notes                 TEXT,
  status                TEXT,
  _created_at           INTEGER,
  _updated_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_specialists_client ON Specialists (tenant_id, client_id);

-- ── Client_Billing_Rules ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Client_Billing_Rules (
  rule_id                         TEXT PRIMARY KEY,
  client_id                       TEXT,
  tenant_id                       TEXT NOT NULL,
  consolidation_mode              TEXT,
  billing_cycle                   TEXT,
  statement_day_of_month          INTEGER,
  requires_po                     INTEGER DEFAULT 0,
  po_format_regex                 TEXT,
  gl_template                     TEXT,
  invoice_format                  TEXT,
  split_by_location               INTEGER DEFAULT 0,
  split_by_specialist             INTEGER DEFAULT 0,
  show_consumer_initials_on_invoice INTEGER DEFAULT 0,
  show_specialist_on_invoice      INTEGER DEFAULT 0,
  show_interpreter_name_on_invoice INTEGER DEFAULT 0,
  rounding_minutes                INTEGER,
  minimum_invoice_cents           INTEGER,
  late_fee_pct                    REAL,
  notes                           TEXT,
  status                          TEXT,
  _created_at                     INTEGER,
  _updated_at                     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_billingrules_client ON Client_Billing_Rules (tenant_id, client_id);

-- ── Job_Expenses ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Job_Expenses (
  expense_id          TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  job_id              TEXT,
  assignment_id       TEXT,
  interpreter_id      TEXT,
  expense_type        TEXT,
  quantity            REAL,
  unit                TEXT,
  rate_cents          INTEGER,
  amount_cents        INTEGER,
  description         TEXT,
  receipt_r2_key      TEXT,
  receipt_filename    TEXT,
  receipt_mime        TEXT,
  submitted_at        INTEGER,
  status              TEXT,
  approved_by_user_id TEXT,
  approved_at         INTEGER,
  rejected_reason     TEXT,
  payout_id           TEXT,
  _created_at         INTEGER,
  _updated_at         INTEGER,
  _rev                INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobexpenses_job ON Job_Expenses (tenant_id, job_id);

-- ── Client_Documents ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Client_Documents (
  doc_id              TEXT PRIMARY KEY,
  client_id           TEXT,
  tenant_id           TEXT NOT NULL,
  doc_type            TEXT,
  title               TEXT,
  filename            TEXT,
  mime                TEXT,
  size_bytes          INTEGER,
  drive_file_id       TEXT,
  uploaded_by_user_id TEXT,
  uploaded_at         INTEGER,
  effective_date      INTEGER,
  expires_at          INTEGER,
  status              TEXT,
  notes               TEXT,
  sha256              TEXT,
  _created_at         INTEGER,
  _updated_at         INTEGER,
  _rev                INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_clientdocs_client ON Client_Documents (tenant_id, client_id);

-- ── Payers ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Payers (
  payer_id           TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  display_name       TEXT,
  billing_email      TEXT,
  billing_address    TEXT,
  net_terms          TEXT,
  tax_exempt         INTEGER DEFAULT 0,
  stripe_customer_id TEXT,
  qb_customer_id     TEXT,
  status             TEXT,
  _created_at        INTEGER,
  _updated_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payers_tenant ON Payers (tenant_id);

-- ── Consumers (PHI — *_encrypted + notes_sealed are OPAQUE v1:iv:ct blobs) ──
CREATE TABLE IF NOT EXISTS Consumers (
  consumer_id               TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  display_initials          TEXT,        -- plaintext, max 12 chars (e.g. "J.M.")
  legal_first_encrypted     TEXT,        -- ENCRYPTED BLOB — never logged, never decrypted in D1
  legal_last_encrypted      TEXT,        -- ENCRYPTED BLOB
  dob_encrypted             TEXT,        -- ENCRYPTED BLOB
  mrn_encrypted             TEXT,        -- ENCRYPTED BLOB
  primary_language_id       TEXT,
  dialect                   TEXT,
  communication_prefs       TEXT,
  notes_sealed              TEXT,        -- ENCRYPTED BLOB
  do_not_contact            INTEGER DEFAULT 0,
  consent_recording_default INTEGER DEFAULT 0,
  created_by_user_id        TEXT,
  deletion_requested_at     INTEGER,
  _created_at               INTEGER,
  _updated_at               INTEGER
);
CREATE INDEX IF NOT EXISTS idx_consumers_tenant ON Consumers (tenant_id);

-- ── Locations ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Locations (
  location_id         TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  requestor_id        TEXT,
  display_name        TEXT,
  street              TEXT,
  city                TEXT,
  state               TEXT,
  zip                 TEXT,
  timezone            TEXT,
  parking_notes       TEXT,
  accessibility_notes TEXT,
  geo                 TEXT,              -- "lat,lng" or JSON
  modalities_supported TEXT,            -- JSON
  _created_at         INTEGER,
  _updated_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_locations_tenant ON Locations (tenant_id);

-- ── Jobs (the scheduling spine) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS Jobs (
  job_id                  TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  client_id               TEXT,
  requestor_id            TEXT,
  requestor_contact_id    TEXT,
  payer_id                TEXT,
  location_id             TEXT,
  specialist_id           TEXT,
  consumer_id             TEXT,
  modality                TEXT,
  service_type            TEXT,
  source_language_id      TEXT,
  target_language_id      TEXT,
  team_config             TEXT,
  scheduled_start         INTEGER,
  scheduled_end           INTEGER,
  actual_start            INTEGER,
  actual_end              INTEGER,
  status                  TEXT NOT NULL DEFAULT 'draft',
  on_demand               INTEGER DEFAULT 0,
  reference_no            TEXT,
  po_number               TEXT,
  notes_to_interpreter    TEXT,
  consent_recording       INTEGER DEFAULT 0,
  recording_r2_key        TEXT,
  transcript_r2_key       TEXT,
  created_via             TEXT,
  ai_intake_id            TEXT,
  rate_applied            TEXT,          -- JSON snapshot
  cancellation_reason     TEXT,
  cancellation_at         INTEGER,
  cancellation_bill_cents INTEGER,
  cancellation_pay_cents  INTEGER,
  invoice_id              TEXT,
  interpreter_signoff_at  INTEGER,
  interpreter_signoff_notes TEXT,
  closeout_divergence_pct REAL,
  closeout_disputed_at    INTEGER,
  closeout_disputed_by    TEXT,
  closeout_dispute_reason TEXT,
  _created_at             INTEGER,
  _updated_at             INTEGER,
  _rev                    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_status ON Jobs (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_start ON Jobs (tenant_id, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_jobs_consumer ON Jobs (tenant_id, consumer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_invoice ON Jobs (invoice_id);

-- ── Job_Assignments (no tenant_id in source — linked via job_id) ─────
CREATE TABLE IF NOT EXISTS Job_Assignments (
  assignment_id     TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL,
  interpreter_id    TEXT,
  role_on_job       TEXT,
  offered_at        INTEGER,
  responded_at      INTEGER,
  response          TEXT,
  pay_rate_snapshot TEXT,               -- JSON
  billable_minutes  INTEGER,
  status            TEXT,
  _created_at       INTEGER,
  _updated_at       INTEGER,
  _rev              INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_asn_job ON Job_Assignments (job_id);
CREATE INDEX IF NOT EXISTS idx_asn_interpreter ON Job_Assignments (interpreter_id, status);

-- ── Job_Events (append-only state-machine log; no tenant_id in source) ──
CREATE TABLE IF NOT EXISTS Job_Events (
  event_id      TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL,
  actor_user_id TEXT,
  event_type    TEXT,
  from_state    TEXT,
  to_state      TEXT,
  payload       TEXT,                    -- JSON
  ts            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobevents_job_ts ON Job_Events (job_id, ts);

-- ── Communications ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Communications (
  comm_id             TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  channel             TEXT,
  direction           TEXT,
  template_id         TEXT,
  to_user_id          TEXT,
  to_address          TEXT,
  body_redacted_r2_key TEXT,
  status              TEXT,
  provider            TEXT,
  provider_msg_id     TEXT,
  job_id              TEXT,
  _created_at         INTEGER,
  _updated_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_comms_tenant ON Communications (tenant_id, _created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comms_job ON Communications (job_id);

-- ── Invoices ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Invoices (
  invoice_id          TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  client_id           TEXT,
  payer_id            TEXT,
  invoice_number      TEXT,
  period_start        INTEGER,
  period_end          INTEGER,
  issued_at           INTEGER,
  due_at              INTEGER,
  net_terms           TEXT,
  subtotal_cents      INTEGER NOT NULL DEFAULT 0,
  tax_cents           INTEGER NOT NULL DEFAULT 0,
  total_cents         INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'draft',
  po_number           TEXT,
  consolidation_mode  TEXT,
  split_group_key     TEXT,
  statement_descriptor TEXT,
  stripe_invoice_id   TEXT,
  pdf_r2_key          TEXT,
  sent_at             INTEGER,
  paid_at             INTEGER,
  voided_at           INTEGER,
  notes               TEXT,
  _created_at         INTEGER,
  _updated_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_status ON Invoices (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_client ON Invoices (tenant_id, client_id);

-- ── Invoice_Lines (no tenant_id in source — linked via invoice_id) ───
CREATE TABLE IF NOT EXISTS Invoice_Lines (
  line_id           TEXT PRIMARY KEY,
  invoice_id        TEXT NOT NULL,
  job_id            TEXT,
  line_kind         TEXT,
  client_id         TEXT,
  requestor_id      TEXT,
  location_id       TEXT,
  specialist_id     TEXT,
  consumer_initials TEXT,
  interpreter_id    TEXT,
  interpreter_name  TEXT,
  service_type      TEXT,
  modality          TEXT,
  scheduled_start   INTEGER,
  scheduled_end     INTEGER,
  description       TEXT,
  quantity          REAL,
  unit              TEXT,
  rate_cents        INTEGER,
  amount_cents      INTEGER,
  sort_order        INTEGER,
  _created_at       INTEGER,
  _updated_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invlines_invoice ON Invoice_Lines (invoice_id, sort_order);

-- ── Payouts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Payouts (
  payout_id         TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  interpreter_id    TEXT,
  period_start      INTEGER,
  period_end        INTEGER,
  issued_at         INTEGER,
  total_cents       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'draft',
  stripe_transfer_id TEXT,
  _created_at       INTEGER,
  _updated_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payouts_tenant ON Payouts (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_payouts_interpreter ON Payouts (interpreter_id);

-- ── Documents (blob registry; the bytes live in R2) ──────────────────
CREATE TABLE IF NOT EXISTS Documents (
  document_id              TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  kind                     TEXT,
  r2_key                   TEXT,
  mime                     TEXT,
  sha256                   TEXT,
  size_bytes               INTEGER,
  linked_job_id            TEXT,
  linked_interpreter_id    TEXT,
  linked_consumer_id       TEXT,
  uploaded_by_user_id      TEXT,
  signed_url_expiry_default INTEGER,
  retention_class          TEXT,
  _created_at              INTEGER,
  _updated_at              INTEGER
);
CREATE INDEX IF NOT EXISTS idx_documents_tenant ON Documents (tenant_id, kind);

-- ── Settings (key/value config; "key"/"value" are SQLite keywords — quoted) ──
-- DEVIATION (documented): the Sheet's Settings tab has NO tenant_id (tenant was
-- implicit per-Sheet). In one multi-tenant D1, "key" alone is not unique, so we
-- ADD tenant_id as the first column and use a composite PK (tenant_id, key). The
-- mirror drops tenant_id when writing each tenant's Sheet; parity is checked on
-- "key" within a tenant. This is the only column-set deviation from the verbatim
-- Sheet schema, and it exists for multi-tenant correctness.
CREATE TABLE IF NOT EXISTS Settings (
  tenant_id           TEXT NOT NULL,
  "key"               TEXT NOT NULL,
  "value"             TEXT,
  category            TEXT,
  updated_by_user_id  TEXT,
  updated_at          INTEGER,
  _created_at         INTEGER,
  _updated_at         INTEGER,
  PRIMARY KEY (tenant_id, "key")
);

-- ── Audit_Log (7-year append-only; INSERT-only enforced by the data layer) ──
CREATE TABLE IF NOT EXISTS Audit_Log (
  audit_id       TEXT PRIMARY KEY,
  tenant_id      TEXT,
  ts             INTEGER,
  user_id        TEXT,
  ip             TEXT,
  user_agent     TEXT,
  action         TEXT,
  record_type    TEXT,
  record_id      TEXT,
  purpose_of_use TEXT,
  result         TEXT,
  jti            TEXT,
  prev_seal      TEXT,   -- tamper-evident chain: seal of the physically prior row
  seal           TEXT    -- HMAC(prev_seal + this row's content); see Code.gs _logAudit
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts ON Audit_Log (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON Audit_Log (tenant_id, action, ts DESC);
-- The live DB was provisioned out-of-band (see MIGRATION.md), so the chain columns
-- must be ALTERed onto the already-deployed table (no-op on a fresh provision):
--   ALTER TABLE Audit_Log ADD COLUMN prev_seal TEXT;
--   ALTER TABLE Audit_Log ADD COLUMN seal TEXT;

-- ====================================================================
-- SHEET TABS OUTSIDE _tenantSchema() (live in the Sheet, in the T map)
-- ====================================================================

-- ── Auth_Tokens (magic-link issuance log; token_hash is the natural key) ──
-- Code.gs uses 9 columns; Code_Invitations.gs adds a trailing `purpose`. We keep
-- all 10 (purpose nullable) so both issuance paths round-trip.
CREATE TABLE IF NOT EXISTS Auth_Tokens (
  token_hash  TEXT PRIMARY KEY,
  issued_at   INTEGER,
  email       TEXT,
  user_id     TEXT,
  tenant_id   TEXT,
  expires_at  INTEGER,
  consumed_at INTEGER,
  ip          TEXT,
  user_agent  TEXT,
  purpose     TEXT
);
CREATE INDEX IF NOT EXISTS idx_authtokens_email ON Auth_Tokens (email);
CREATE INDEX IF NOT EXISTS idx_authtokens_expires ON Auth_Tokens (expires_at);

-- ── Inbound (marketing-form capture; "when" is a SQLite keyword — quoted) ──
-- Per ADR §4 this is allowlist-eligible to stay on Sheets, but it shares the
-- Sheet so we mirror it into D1 for a clean single-store cutover.
CREATE TABLE IF NOT EXISTS Inbound (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  "timestamp"      INTEGER,
  form_id          TEXT,
  name             TEXT,
  email            TEXT,
  organization     TEXT,
  agency_size      TEXT,
  modality         TEXT,
  current_platform TEXT,
  helps            TEXT,
  topic            TEXT,
  message          TEXT,
  language         TEXT,
  "when"           TEXT,
  setting          TEXT,
  notes            TEXT,
  agency_legal_name TEXT,
  state_of_formation TEXT,
  owner_name       TEXT,
  documentation_type TEXT,
  page             TEXT,
  raw_params       TEXT                 -- JSON
);
CREATE INDEX IF NOT EXISTS idx_inbound_form_ts ON Inbound (form_id, "timestamp" DESC);

-- ── Deaf_Owned_Applications (verification-board queue) ───────────────
CREATE TABLE IF NOT EXISTS Deaf_Owned_Applications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  submitted_at       INTEGER,
  agency_legal_name  TEXT,
  state_of_formation TEXT,
  owner_name         TEXT,
  contact_email      TEXT,
  documentation_type TEXT,
  notes              TEXT,
  review_status      TEXT DEFAULT 'pending',
  reviewed_at        INTEGER,
  reviewer           TEXT,
  decision_notes     TEXT
);
CREATE INDEX IF NOT EXISTS idx_deafowned_status ON Deaf_Owned_Applications (review_status, submitted_at DESC);

-- ====================================================================
-- schema_version (the db.ts migration runner checks this)
-- ====================================================================
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);
INSERT INTO schema_version (version, applied_at) VALUES (1, 0);
