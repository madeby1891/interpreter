-- 0001_init.sql — interpreter-data D1, schema version 1.
-- This init migration is the full schema at v1; it mirrors ../schema.sql exactly.
-- The db.ts migration runner applies files in this directory in numeric order and
-- bumps schema_version. Keep this file and schema.sql in lockstep for v1; add a
-- 0002_*.sql (and bump schema_version) for any later change.
--
-- See ../schema.sql for the full annotated header (conventions, PHI handling,
-- the documented Settings tenant_id deviation, FK policy). DDL is identical.

-- ── control plane ────────────────────────────────────────────────────
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
  payload       TEXT
);
CREATE INDEX IF NOT EXISTS idx_syslog_tenant_ts ON Sys_Log (tenant_id, ts DESC);

-- ── tenant tables ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Agencies (
  tenant_id            TEXT PRIMARY KEY,
  legal_name           TEXT,
  tax_id_last4         TEXT,
  tier                 TEXT,
  phi_mode             TEXT,
  timezone             TEXT,
  primary_owner_user_id TEXT,
  logo_r2_key          TEXT,
  brand_color          TEXT,
  billing_email        TEXT,
  _created_at          INTEGER,
  _updated_at          INTEGER
);

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
  webauthn_credential_ids TEXT,
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

CREATE TABLE IF NOT EXISTS Roles (
  role_id         TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  display_name    TEXT,
  permissions     TEXT,
  can_break_glass INTEGER DEFAULT 0,
  max_pii_scope   TEXT,
  _created_at     INTEGER,
  _updated_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_roles_tenant ON Roles (tenant_id);

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
  modalities                TEXT,
  languages                 TEXT,
  certifications            TEXT,
  skills                    TEXT,
  rate_card_id              TEXT,
  min_call_hours            REAL,
  availability_prefs        TEXT,
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
  other_member_numbers      TEXT,
  pay_rate_floors           TEXT,
  cancellation_floors       TEXT,
  evening_premium_pct       REAL,
  weekend_premium_pct       REAL,
  last_minute_premium_pct   REAL,
  holiday_premium_pct       REAL,
  mileage_rate_cents        INTEGER,
  travel_time_rate_cents    INTEGER,
  specialty_endorsements    TEXT,
  availability_windows      TEXT,
  onboarding_completed_at   INTEGER,
  _created_at               INTEGER,
  _updated_at               INTEGER,
  _rev                      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_interpreters_tenant ON Interpreters (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_interpreters_user ON Interpreters (user_id);

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

CREATE TABLE IF NOT EXISTS Languages (
  language_id      TEXT PRIMARY KEY,
  display_name     TEXT,
  family           TEXT,
  directionalities TEXT,
  dialects         TEXT,
  script           TEXT,
  rtl              INTEGER DEFAULT 0,
  _created_at      INTEGER,
  _updated_at      INTEGER
);

CREATE TABLE IF NOT EXISTS Certifications (
  certification_id     TEXT PRIMARY KEY,
  body                 TEXT,
  display_name         TEXT,
  applies_to_languages TEXT,
  renewable            INTEGER DEFAULT 0,
  ceu_required         INTEGER DEFAULT 0,
  _created_at          INTEGER,
  _updated_at          INTEGER
);

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

CREATE TABLE IF NOT EXISTS Consumers (
  consumer_id               TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  display_initials          TEXT,
  legal_first_encrypted     TEXT,        -- ENCRYPTED BLOB — never logged
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
  geo                 TEXT,
  modalities_supported TEXT,
  _created_at         INTEGER,
  _updated_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_locations_tenant ON Locations (tenant_id);

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
  rate_applied            TEXT,
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

CREATE TABLE IF NOT EXISTS Job_Assignments (
  assignment_id     TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL,
  interpreter_id    TEXT,
  role_on_job       TEXT,
  offered_at        INTEGER,
  responded_at      INTEGER,
  response          TEXT,
  pay_rate_snapshot TEXT,
  billable_minutes  INTEGER,
  status            TEXT,
  _created_at       INTEGER,
  _updated_at       INTEGER,
  _rev              INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_asn_job ON Job_Assignments (job_id);
CREATE INDEX IF NOT EXISTS idx_asn_interpreter ON Job_Assignments (interpreter_id, status);

CREATE TABLE IF NOT EXISTS Job_Events (
  event_id      TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL,
  actor_user_id TEXT,
  event_type    TEXT,
  from_state    TEXT,
  to_state      TEXT,
  payload       TEXT,
  ts            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobevents_job_ts ON Job_Events (job_id, ts);

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

-- Settings: tenant_id added for multi-tenant correctness (documented in schema.sql).
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
  jti            TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts ON Audit_Log (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON Audit_Log (tenant_id, action, ts DESC);

-- ── sheet tabs outside _tenantSchema() ───────────────────────────────
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
  raw_params       TEXT
);
CREATE INDEX IF NOT EXISTS idx_inbound_form_ts ON Inbound (form_id, "timestamp" DESC);

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

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);
INSERT INTO schema_version (version, applied_at) VALUES (1, 0);
