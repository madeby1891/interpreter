/**
 * interpreter-data — typed D1 helpers (ADR-001). D1 is the system of record once
 * cutover completes; during the strangler phases it is the dual-write parity copy
 * (ADR §6). Tables mirror apps-script/Code.gs `_tenantSchema()` 1:1 (multi-tenant).
 *
 * PHI: the *_encrypted / *_sealed columns hold opaque AES-GCM ciphertext
 * (`v1:iv:ct`) produced by workers/api/src/phi.ts. This layer NEVER decrypts and
 * NEVER logs the contents of a PHI_BLOB_COLUMNS column. `safeRowForLog()` redacts
 * them before anything is written to console or Sys_Log.
 */

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  JOBS: Queue;
  PRODUCT: string;          // "interpreter"
  DEFAULT_TENANT: string;   // "host" (the legacy host tenant)
  HMAC_SECRET: string;      // secret — matches Apps Script HMAC_SECRET / Worker JWT_SECRET
  MIRROR_SHEET_EXEC?: string; // secret — read-only D1->Sheets mirror target (ADR §5)
  MIRROR_ENABLED?: string;    // "true" only AFTER cutover (phase 4); off during dual-write
}

export const now = (): number => Math.floor(Date.now() / 1000);

/**
 * Columns whose values are PHI ciphertext and must NEVER be logged or echoed.
 * Keyed "Table.column". The data layer redacts these everywhere.
 */
export const PHI_BLOB_COLUMNS: ReadonlySet<string> = new Set([
  'Consumers.legal_first_encrypted',
  'Consumers.legal_last_encrypted',
  'Consumers.dob_encrypted',
  'Consumers.mrn_encrypted',
  'Consumers.notes_sealed',
  'Interpreters.payment_details_encrypted',
]);

type WriteMode = 'upsert' | 'append';
interface TableDef {
  pk: string[] | null;     // null => server-assigned AUTOINCREMENT id (append-only)
  columns: string[];       // exact column order; matches the Sheet header row
  mode: WriteMode;
  tenantScoped: boolean;   // has a tenant_id column the writer must pin
}

/**
 * Table registry = the column allowlist that makes the generic writer safe.
 * Column lists are verbatim from Code.gs `_tenantSchema()` + Code_Multitenant.gs
 * CONTROL_SCHEMA + the three out-of-schema tabs. Order matches the Sheet so the
 * parity check and the nightly mirror line up column-for-column.
 */
export const TABLES: Record<string, TableDef> = {
  // control plane
  Tenants:       { pk: ['tenant_id'], mode: 'upsert', tenantScoped: false,
    columns: ['tenant_id','spreadsheet_id','legal_name','tier','status','created_at','created_by','notes'] },
  Tenant_Owners: { pk: ['tenant_id','user_id'], mode: 'upsert', tenantScoped: true,
    columns: ['tenant_id','user_id','user_email','role','added_at','added_by'] },
  Sys_Log:       { pk: null, mode: 'append', tenantScoped: false,
    columns: ['ts','event','actor_user_id','tenant_id','payload'] },

  // tenant tables (verbatim from _tenantSchema)
  Agencies:      { pk: ['tenant_id'], mode: 'upsert', tenantScoped: true,
    columns: ['tenant_id','legal_name','tax_id_last4','tier','phi_mode','timezone','primary_owner_user_id','logo_r2_key','brand_color','billing_email','_created_at','_updated_at','qbo_realm_id'] },
  Users:         { pk: ['user_id'], mode: 'upsert', tenantScoped: true,
    columns: ['user_id','tenant_id','email','phone_e164','display_name','role_id','interpreter_id','status','mfa_enabled','webauthn_credential_ids','last_login_at','pii_scope','failed_login_count','sso_subject','calendar_token','_created_at','_updated_at'] },
  Roles:         { pk: ['role_id'], mode: 'upsert', tenantScoped: true,
    columns: ['role_id','tenant_id','display_name','permissions','can_break_glass','max_pii_scope','_created_at','_updated_at'] },
  Interpreters:  { pk: ['interpreter_id'], mode: 'upsert', tenantScoped: true,
    columns: ['interpreter_id','tenant_id','user_id','classification','legal_first','legal_last','pronouns','home_city','home_state','home_zip','service_radius_mi','has_vehicle','modalities','languages','certifications','skills','rate_card_id','min_call_hours','availability_prefs','availability_doc_id','payment_method','payment_details_encrypted','w9_doc_id','coi_doc_id','background_check_at','deaf','notes_internal','status','rid_member_number','bei_member_number','other_member_numbers','pay_rate_floors','cancellation_floors','evening_premium_pct','weekend_premium_pct','last_minute_premium_pct','holiday_premium_pct','mileage_rate_cents','travel_time_rate_cents','specialty_endorsements','availability_windows','onboarding_completed_at','_created_at','_updated_at','_rev'] },
  Interpreter_Documents: { pk: ['doc_id'], mode: 'upsert', tenantScoped: true,
    columns: ['doc_id','tenant_id','interpreter_id','doc_type','doc_name','status','required','issued_at','expires_at','reviewer_user_id','reviewed_at','file_r2_key','sha256','notes','_created_at','_updated_at'] },
  Tenant_Requirements: { pk: ['req_id'], mode: 'upsert', tenantScoped: true,
    columns: ['req_id','tenant_id','applies_to_service_type','applies_to_modality','doc_type','display_name','required','reminder_days','renewal_period_months','notes','_created_at','_updated_at'] },
  Rate_Modifiers: { pk: ['modifier_id'], mode: 'upsert', tenantScoped: true,
    columns: ['modifier_id','tenant_id','side','kind','name','trigger','modifier_pct','modifier_cents','applies_to_service_type','applies_to_modality','priority','status','notes','_created_at','_updated_at'] },
  Rate_Cards:    { pk: ['rate_card_id'], mode: 'upsert', tenantScoped: true,
    columns: ['rate_card_id','tenant_id','side','service_type','modality','team_config','base_hourly_cents','minimum_hours','rounding_minutes','notes','_created_at','_updated_at'] },
  Notification_Prefs: { pk: ['pref_id'], mode: 'upsert', tenantScoped: true,
    columns: ['pref_id','tenant_id','user_id','event_type','channel','mode','phone_e164','daily_digest_hour','weekly_digest_day','quiet_hours','_created_at','_updated_at'] },
  Assignment_Notes: { pk: ['note_id'], mode: 'upsert', tenantScoped: true,
    columns: ['note_id','tenant_id','assignment_id','job_id','author_user_id','author_role','body','visibility','_created_at'] },
  Languages:     { pk: ['language_id'], mode: 'upsert', tenantScoped: false,
    columns: ['language_id','display_name','family','directionalities','dialects','script','rtl','_created_at','_updated_at'] },
  Certifications: { pk: ['certification_id'], mode: 'upsert', tenantScoped: false,
    columns: ['certification_id','body','display_name','applies_to_languages','renewable','ceu_required','_created_at','_updated_at'] },
  Requestors:    { pk: ['requestor_id'], mode: 'upsert', tenantScoped: true,
    columns: ['requestor_id','tenant_id','client_id','display_name','type','parent_org_id','billing_payer_id','default_location_id','default_specialist_id','contract_doc_id','po_required','notes','status','_created_at','_updated_at','_rev'] },
  Requestor_Contacts: { pk: ['contact_id'], mode: 'upsert', tenantScoped: true,
    columns: ['contact_id','requestor_id','tenant_id','user_id','first','last','email','phone_e164','title','preferred_channel','status','_created_at','_updated_at'] },
  Clients:       { pk: ['client_id'], mode: 'upsert', tenantScoped: true,
    columns: ['client_id','tenant_id','legal_name','display_name','client_type','industry','primary_owner_contact_id','primary_payer_id','billing_address','billing_email','billing_phone','tax_exempt','tax_id_last4','net_terms','contract_doc_id','notes','status','_created_at','_updated_at','_rev'] },
  Client_Contacts: { pk: ['contact_id'], mode: 'upsert', tenantScoped: true,
    columns: ['contact_id','client_id','tenant_id','user_id','role_on_client','first','last','email','phone_e164','title','department','preferred_channel','status','_created_at','_updated_at'] },
  Specialists:   { pk: ['specialist_id'], mode: 'upsert', tenantScoped: true,
    columns: ['specialist_id','client_id','tenant_id','display_name','department','specialty_code','npi','default_location_id','default_modality_pref','notes','status','_created_at','_updated_at'] },
  Client_Billing_Rules: { pk: ['rule_id'], mode: 'upsert', tenantScoped: true,
    columns: ['rule_id','client_id','tenant_id','consolidation_mode','billing_cycle','statement_day_of_month','requires_po','po_format_regex','gl_template','invoice_format','split_by_location','split_by_specialist','show_consumer_initials_on_invoice','show_specialist_on_invoice','show_interpreter_name_on_invoice','rounding_minutes','minimum_invoice_cents','late_fee_pct','notes','status','_created_at','_updated_at'] },
  Job_Expenses:  { pk: ['expense_id'], mode: 'upsert', tenantScoped: true,
    columns: ['expense_id','tenant_id','job_id','assignment_id','interpreter_id','expense_type','quantity','unit','rate_cents','amount_cents','description','receipt_r2_key','receipt_filename','receipt_mime','submitted_at','status','approved_by_user_id','approved_at','rejected_reason','payout_id','_created_at','_updated_at','_rev'] },
  Client_Documents: { pk: ['doc_id'], mode: 'upsert', tenantScoped: true,
    columns: ['doc_id','client_id','tenant_id','doc_type','title','filename','mime','size_bytes','drive_file_id','uploaded_by_user_id','uploaded_at','effective_date','expires_at','status','notes','sha256','_created_at','_updated_at','_rev'] },
  Payers:        { pk: ['payer_id'], mode: 'upsert', tenantScoped: true,
    columns: ['payer_id','tenant_id','display_name','billing_email','billing_address','net_terms','tax_exempt','stripe_customer_id','qb_customer_id','status','_created_at','_updated_at'] },
  Consumers:     { pk: ['consumer_id'], mode: 'upsert', tenantScoped: true,
    columns: ['consumer_id','tenant_id','display_initials','legal_first_encrypted','legal_last_encrypted','dob_encrypted','mrn_encrypted','primary_language_id','dialect','communication_prefs','notes_sealed','do_not_contact','consent_recording_default','created_by_user_id','deletion_requested_at','_created_at','_updated_at'] },
  Locations:     { pk: ['location_id'], mode: 'upsert', tenantScoped: true,
    columns: ['location_id','tenant_id','requestor_id','display_name','street','city','state','zip','timezone','parking_notes','accessibility_notes','geo','modalities_supported','_created_at','_updated_at'] },
  Jobs:          { pk: ['job_id'], mode: 'upsert', tenantScoped: true,
    columns: ['job_id','tenant_id','client_id','requestor_id','requestor_contact_id','payer_id','location_id','specialist_id','consumer_id','modality','service_type','source_language_id','target_language_id','team_config','scheduled_start','scheduled_end','actual_start','actual_end','status','on_demand','reference_no','po_number','notes_to_interpreter','consent_recording','recording_r2_key','transcript_r2_key','created_via','ai_intake_id','rate_applied','cancellation_reason','cancellation_at','cancellation_bill_cents','cancellation_pay_cents','invoice_id','interpreter_signoff_at','interpreter_signoff_notes','closeout_divergence_pct','closeout_disputed_at','closeout_disputed_by','closeout_dispute_reason','_created_at','_updated_at','_rev'] },
  Job_Assignments: { pk: ['assignment_id'], mode: 'upsert', tenantScoped: false,
    columns: ['assignment_id','job_id','interpreter_id','role_on_job','offered_at','responded_at','response','pay_rate_snapshot','billable_minutes','status','_created_at','_updated_at','_rev'] },
  Job_Events:    { pk: ['event_id'], mode: 'upsert', tenantScoped: false,
    columns: ['event_id','job_id','actor_user_id','event_type','from_state','to_state','payload','ts'] },
  Communications: { pk: ['comm_id'], mode: 'upsert', tenantScoped: true,
    columns: ['comm_id','tenant_id','channel','direction','template_id','to_user_id','to_address','body_redacted_r2_key','status','provider','provider_msg_id','job_id','_created_at','_updated_at'] },
  Invoices:      { pk: ['invoice_id'], mode: 'upsert', tenantScoped: true,
    columns: ['invoice_id','tenant_id','client_id','payer_id','invoice_number','period_start','period_end','issued_at','due_at','net_terms','subtotal_cents','tax_cents','total_cents','status','po_number','consolidation_mode','split_group_key','statement_descriptor','stripe_invoice_id','pdf_r2_key','sent_at','paid_at','voided_at','notes','_created_at','_updated_at'] },
  Invoice_Lines: { pk: ['line_id'], mode: 'upsert', tenantScoped: false,
    columns: ['line_id','invoice_id','job_id','line_kind','client_id','requestor_id','location_id','specialist_id','consumer_initials','interpreter_id','interpreter_name','service_type','modality','scheduled_start','scheduled_end','description','quantity','unit','rate_cents','amount_cents','sort_order','_created_at','_updated_at'] },
  Payouts:       { pk: ['payout_id'], mode: 'upsert', tenantScoped: true,
    columns: ['payout_id','tenant_id','interpreter_id','period_start','period_end','issued_at','total_cents','status','stripe_transfer_id','_created_at','_updated_at'] },
  Documents:     { pk: ['document_id'], mode: 'upsert', tenantScoped: true,
    columns: ['document_id','tenant_id','kind','r2_key','mime','sha256','size_bytes','linked_job_id','linked_interpreter_id','linked_consumer_id','uploaded_by_user_id','signed_url_expiry_default','retention_class','_created_at','_updated_at'] },
  // Settings: tenant_id added for multi-tenant correctness (documented in schema.sql).
  Settings:      { pk: ['tenant_id','key'], mode: 'upsert', tenantScoped: true,
    columns: ['tenant_id','key','value','category','updated_by_user_id','updated_at','_created_at','_updated_at'] },
  Audit_Log:     { pk: ['audit_id'], mode: 'upsert', tenantScoped: true,
    columns: ['audit_id','tenant_id','ts','user_id','ip','user_agent','action','record_type','record_id','purpose_of_use','result','jti','prev_seal','seal'] },

  // out-of-_tenantSchema tabs
  Auth_Tokens:   { pk: ['token_hash'], mode: 'upsert', tenantScoped: true,
    columns: ['token_hash','issued_at','email','user_id','tenant_id','expires_at','consumed_at','ip','user_agent','purpose'] },
  Inbound:       { pk: null, mode: 'append', tenantScoped: false,
    columns: ['timestamp','form_id','name','email','organization','agency_size','modality','current_platform','helps','topic','message','language','when','setting','notes','agency_legal_name','state_of_formation','owner_name','documentation_type','page','raw_params'] },
  Deaf_Owned_Applications: { pk: null, mode: 'append', tenantScoped: false,
    columns: ['submitted_at','agency_legal_name','state_of_formation','owner_name','contact_email','documentation_type','notes','review_status','reviewed_at','reviewer','decision_notes'] },
};

export function tableNames(): string[] {
  return Object.keys(TABLES);
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

// Secret-shaped value detection — defense in depth so the read/echo surface can
// NEVER serve a credential, even one that legacy data stuffed into a plain column
// (e.g. Settings row key='anthropic.api_key', value='sk-ant-…'). Matches common
// provider prefixes + obvious "looks like a long opaque token" shapes.
const SECRET_VALUE_RE = /(sk-ant-|sk_live_|sk_test_|rk_live_|xox[bap]-|ghp_|AKIA[0-9A-Z]{12}|AIza[0-9A-Za-z_-]{20}|-----BEGIN)/;
const SECRET_KEY_RE = /(api[_.]?key|secret|password|passwd|private[_.]?key|bearer|access[_.]?token|refresh[_.]?token)/i;

/** True if this row looks like it carries a credential (by key name or value shape). */
function rowLooksSecret(row: Record<string, unknown>): boolean {
  const k = String(row['key'] ?? '');
  if (SECRET_KEY_RE.test(k)) return true;
  for (const v of Object.values(row)) {
    if (typeof v === 'string' && SECRET_VALUE_RE.test(v)) return true;
  }
  return false;
}

/** Redact PHI ciphertext columns + any secret-shaped value before returning/logging. */
export function safeRowForLog(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // For key/value config tables, redact the `value` of any secret-shaped row.
  const redactValue = ('key' in row && 'value' in row) && rowLooksSecret(row);
  for (const k of Object.keys(row)) {
    if (PHI_BLOB_COLUMNS.has(`${table}.${k}`)) { out[k] = '[redacted-phi]'; continue; }
    if (redactValue && k === 'value') { out[k] = '[redacted-secret]'; continue; }
    // Belt-and-suspenders: redact any individual cell whose value looks like a secret.
    if (typeof row[k] === 'string' && SECRET_VALUE_RE.test(row[k] as string)) { out[k] = '[redacted-secret]'; continue; }
    out[k] = row[k];
  }
  return out;
}

export interface WriteResult { ok: true; table: string; pk: Record<string, unknown> | { rowid: true } }

/**
 * Generic, tenant-scoped, allowlisted write. The ONLY mutation path for the
 * dual-write phase. Validates the table + columns against TABLES (no arbitrary
 * SQL), pins tenant_id from the verified envelope for tenant-scoped tables, and
 * upserts (or appends, for autoincrement/log tables). Unknown columns are
 * dropped silently — the Apps Script side may send extra computed fields.
 */
export async function writeRow(
  env: Env,
  tenantId: string,
  table: string,
  rawRow: Record<string, unknown>,
): Promise<WriteResult> {
  const def = TABLES[table];
  if (!def) throw new Error(`unknown table: ${table}`);

  // Keep only allowlisted columns, in declared order.
  const row: Record<string, unknown> = {};
  for (const col of def.columns) {
    if (col in rawRow) row[col] = normalize(rawRow[col]);
  }
  // Pin tenant for tenant-scoped tables — a caller can never write cross-tenant.
  if (def.tenantScoped && def.columns.includes('tenant_id')) {
    row['tenant_id'] = tenantId;
  }

  const cols = def.columns.filter((c) => c in row);
  if (cols.length === 0) throw new Error(`no writable columns for ${table}`);
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map((c) => row[c]);

  if (def.mode === 'append' || def.pk === null) {
    await env.DB.prepare(
      `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${placeholders})`,
    ).bind(...values).run();
    return { ok: true, table, pk: { rowid: true } };
  }

  // Upsert on the table's primary key.
  const pkCols = def.pk;
  const updateCols = cols.filter((c) => !pkCols.includes(c));
  const setClause = updateCols.length
    ? updateCols.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')
    : null;
  const conflict = pkCols.map(q).join(', ');
  const sql = setClause
    ? `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${placeholders}) ` +
      `ON CONFLICT(${conflict}) DO UPDATE SET ${setClause}`
    : `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${placeholders}) ` +
      `ON CONFLICT(${conflict}) DO NOTHING`;
  await env.DB.prepare(sql).bind(...values).run();

  const pk: Record<string, unknown> = {};
  for (const c of pkCols) pk[c] = row[c];
  return { ok: true, table, pk };
}

/** Delete by primary key (tenant-pinned). Rare — Sheets updates in place. */
export async function deleteRow(
  env: Env, tenantId: string, table: string, pkValues: Record<string, unknown>,
): Promise<{ ok: true; deleted: number }> {
  const def = TABLES[table];
  if (!def) throw new Error(`unknown table: ${table}`);
  if (!def.pk) throw new Error(`cannot delete from append-only table ${table}`);
  const where: string[] = [];
  const binds: unknown[] = [];
  for (const c of def.pk) {
    where.push(`${q(c)} = ?`);
    binds.push(c === 'tenant_id' ? tenantId : pkValues[c]);
  }
  if (def.tenantScoped && def.columns.includes('tenant_id') && !def.pk.includes('tenant_id')) {
    where.push(`${q('tenant_id')} = ?`);
    binds.push(tenantId);
  }
  const res = await env.DB.prepare(
    `DELETE FROM ${q(table)} WHERE ${where.join(' AND ')}`,
  ).bind(...binds).run();
  return { ok: true, deleted: res.meta?.changes ?? 0 };
}

/** Row count for parity checks (optionally scoped to a tenant). */
export async function countRows(env: Env, table: string, tenantId?: string): Promise<number> {
  const def = TABLES[table];
  if (!def) throw new Error(`unknown table: ${table}`);
  let sql = `SELECT COUNT(*) AS n FROM ${q(table)}`;
  const binds: unknown[] = [];
  if (tenantId && def.columns.includes('tenant_id')) {
    sql += ` WHERE ${q('tenant_id')} = ?`;
    binds.push(tenantId);
  }
  const r = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Append a Sys_Log row (never logs PHI — Sys_Log carries no PHI columns). */
export async function logSys(
  env: Env, event: string, opts: { actorUserId?: string; tenantId?: string; payload?: unknown } = {},
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO Sys_Log (ts, event, actor_user_id, tenant_id, payload) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      now(), event, opts.actorUserId ?? null, opts.tenantId ?? null,
      opts.payload == null ? null : JSON.stringify(opts.payload),
    ).run();
  } catch { /* logging is best-effort */ }
}

export async function getSchemaVersion(env: Env): Promise<number | null> {
  try {
    const v = await env.DB.prepare(`SELECT MAX(version) AS v FROM schema_version`).first<{ v: number }>();
    return v?.v ?? null;
  } catch { return null; }
}

/**
 * Coerce a Sheet value to a D1-friendly scalar. Apps Script may send ISO date
 * strings, JS booleans, arrays/objects (for JSON columns), or null. D1 accepts
 * string | number | null | ArrayBuffer. We keep ISO strings as-is here (the
 * Apps Script side is expected to send epoch ints for *_at per the contract);
 * objects/arrays are JSON-stringified; booleans become 0/1.
 */
function normalize(v: unknown): string | number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  // arrays / objects -> JSON text (for the *_json / list columns)
  try { return JSON.stringify(v); } catch { return String(v); }
}
