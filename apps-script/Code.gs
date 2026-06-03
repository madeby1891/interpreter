/**
 * 1891 Interpreter — backend (Apps Script).
 *
 * One script, three responsibilities:
 *   1. Inbound forms from the marketing site (existing).
 *   2. Magic-link auth: issue + verify, session JWT.
 *   3. Tenant operations: bootstrap schema, jobs CRUD, smart-fill.
 *
 * Deployed as a Web app to:
 *   https://script.google.com/macros/s/AKfycbw.../exec
 *
 * URL routing:
 *   GET  ?action=service        → service info JSON (default)
 *   GET  ?action=list_jobs      → list jobs for the authed tenant
 *   GET  ?action=get_job&id=... → single job
 *   POST form_id=...            → inbound marketing form
 *   POST action=auth_request    → email a magic link
 *   POST action=auth_verify     → exchange token for session JWT
 *   POST action=create_job      → create a draft Job
 *   POST action=claim_job       → interpreter claims an offered job
 *   POST action=smart_fill      → return ranked interpreter candidates
 *   POST action=bootstrap       → one-shot tenant Sheet schema bootstrap
 *
 * Re-deploy after edits: Deploy → Manage deployments → ✏️ → New version → Deploy
 * (the four manual clicks per workspace CLAUDE.md).
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

var SHEET_ID = '1RKY0n-dStOoyLtayppvQ0prGVFXMiR0aHg0C_u7eigE'; // "1891 Interpreter" (host tenant)
var SITE_BASE = 'https://madeby1891.com/interpreter';

var NOTIFY_EMAIL         = 'hello@madeby1891.com';
var ACCESSIBILITY_NOTIFY = 'accessibility@madeby1891.com';
var SECURITY_NOTIFY      = 'security@madeby1891.com';

// Brand identity for customer-facing email. Mirrors the FDT pattern
// (BRAND_NAME / BRAND_FROM_EMAIL / BRAND_REPLY_TO). Every MailApp.sendEmail
// that goes to a paying customer should pass `name: BRAND_NAME` and
// `replyTo: BRAND_REPLY_TO` so receipts/welcomes look like they came from
// "1891 Interpreter" — not "Anthony Mowl" (the Apps Script owner).
var BRAND_NAME       = '1891 Interpreter';
var BRAND_FROM_EMAIL = 'contact@madeby1891.com';
var BRAND_REPLY_TO   = 'contact@madeby1891.com';
var BRAND_DOMAIN     = 'madeby1891.com/interpreter';

// Sheet tabs (canonical names per PRD A3)
var T = {
  Agencies: 'Agencies',
  Users: 'Users',
  Roles: 'Roles',
  Interpreters: 'Interpreters',
  Languages: 'Languages',
  Certifications: 'Certifications',
  Requestors: 'Requestors',
  RequestorContacts: 'Requestor_Contacts',
  Payers: 'Payers',
  Consumers: 'Consumers',
  Locations: 'Locations',
  Jobs: 'Jobs',
  JobAssignments: 'Job_Assignments',
  JobEvents: 'Job_Events',
  Communications: 'Communications',
  Invoices: 'Invoices',
  InvoiceLines: 'Invoice_Lines',
  Payouts: 'Payouts',
  Documents: 'Documents',
  Settings: 'Settings',
  Audit_Log: 'Audit_Log',
  // 1891-specific tabs (not in A3 but needed)
  Inbound: 'Inbound',
  DeafOwnedApplications: 'Deaf_Owned_Applications',
  AuthTokens: 'Auth_Tokens',  // magic-link issuance log
  // Rate engine + onboarding
  InterpreterDocuments: 'Interpreter_Documents',
  TenantRequirements: 'Tenant_Requirements',
  RateModifiers: 'Rate_Modifiers',
  RateCards: 'Rate_Cards',
  // Comms + team coordination
  NotificationPrefs: 'Notification_Prefs',
  AssignmentNotes: 'Assignment_Notes',
  // v18 — Client hierarchy + billing
  Clients: 'Clients',
  ClientContacts: 'Client_Contacts',
  Specialists: 'Specialists',
  ClientBillingRules: 'Client_Billing_Rules',
  // v18.2 — Interpreter close-out (actuals + expenses)
  JobExpenses: 'Job_Expenses',
  // v18.3 — Per-client document library (contracts, BAAs, COIs, W-9s, …)
  ClientDocuments: 'Client_Documents'
};

var AUTH_TOKEN_TTL_MS = 15 * 60 * 1000;        // magic link valid for 15 min
var SESSION_TTL_MS    = 14 * 24 * 60 * 60 * 1000; // session JWT valid 14 days

// ============================================================================
// ROUTING — doGet / doPost
// ============================================================================

function doGet(e) {
  if (e && e.parameter && e.parameter.godview) return handleGodviewStats(e);
  if (e && e.parameter && e.parameter.d1op) return handleD1Op_(e); // D1 dual-write sync (Code_D1Sync.gs)
  try {
    var params = (e && e.parameter) || {};
    _setCallback(_safeCb(params.callback));
    var action = params.action || 'service';
    // Read-only ops served via GET so JSONP works.
    switch (action) {
      case 'service':            return _serviceInfo();
      case 'list_jobs':          return apiListJobs(e);
      case 'get_job':            return apiGetJob(e);
      case 'whoami':             return apiWhoami(e);
      case 'auth_verify':        return apiAuthVerify(e);   // JSONP-friendly
      // SSO (OIDC) — alongside magic-link
      case 'sso_start':          return _safeCall('apiSsoStart', e);
      case 'sso_config_get':     return _safeCall('apiSsoConfigGet', e);
      case 'smart_fill':         return apiSmartFill(e);
      case 'list_interpreters':  return apiListInterpreters(e);
      case 'list_requestors':    return apiListRequestors(e);
      case 'list_settings':      return apiListSettings(e);
      case 'list_assignments':   return apiListAssignments(e);
      case 'list_job_events':    return apiListJobEvents(e);
      case 'list_communications':return apiListCommunications(e);
      case 'test_anthropic':     return apiTestAnthropic(e);
      case 'ai_intake':          return apiAiIntake(e);       // also POST-able; GET path enables JSONP read
      // Invoicing & payouts (impl in Code_Invoicing.gs)
      case 'list_invoices':      return _safeCall('apiListInvoices', e);
      case 'get_invoice':        return _safeCall('apiGetInvoice', e);
      case 'invoice_pdf':        return _safeCall('apiInvoicePdf', e);
      case 'payout_pdf':         return _safeCall('apiPayoutPdf', e);
      case 'list_payouts':       return _safeCall('apiListPayouts', e);
      case 'get_payout':         return _safeCall('apiGetPayout', e);
      // Multi-tenant admin (impl in Code_Multitenant.gs)
      case 'list_tenants':       return _safeCall('apiListTenants', e);
      case 'get_tenant':         return _safeCall('apiGetTenant', e);
      case 'list_tenant_owners': return _safeCall('apiListTenantOwners', e);
      // Translation
      case 'list_documents':     return _safeCall('apiListDocuments', e);
      case 'get_document':       return _safeCall('apiGetDocument', e);
      case 'download_translation': return _safeCall('apiDownloadTranslation', e);
      case 'get_translation_source': return _safeCall('apiGetTranslationSource', e);
      // Payments
      case 'list_stripe_accounts': return _safeCall('apiListStripeAccounts', e);
      case 'list_1099_forms':    return _safeCall('apiList1099Forms', e);
      case 'payment_setup_status': return _safeCall('apiPaymentSetupStatus', e);
      case 'subscription_status':   return _safeCall('apiSubscriptionStatus', e);
      // Public — marketing-page hop to Worker for Stripe Checkout (no session).
      case 'subscription_intent_url': return _safeCall('apiSubscriptionIntentUrl', e);
      // Rate engine + docs + qualifications
      case 'compute_rate_quote': return _safeCall('apiComputeRateQuote', e);
      case 'compute_cancel_quote': return _safeCall('apiComputeCancellationQuote', e);
      case 'cancel_job_quote':   return apiCancelJobQuote(e);
      case 'list_rate_modifiers':return _safeCall('apiListRateModifiers', e);
      case 'list_rate_cards':    return _safeCall('apiListRateCards', e);
      case 'list_requirements':  return _safeCall('apiListRequirements', e);
      case 'list_interpreter_docs': return _safeCall('apiListInterpreterDocs', e);
      case 'qualification_check': return _safeCall('apiQualificationCheck', e);
      case 'smart_fill_qualified': return _safeCall('apiSmartFillQualified', e);
      // Offer / PII reveal
      case 'list_my_offers':     return _safeCall('apiListMyOffers', e);
      case 'offer_details':      return _safeCall('apiOfferDetails', e);
      // Notification prefs
      case 'list_notification_prefs': return _safeCall('apiListNotificationPrefs', e);
      // Metrics
      case 'agency_health':      return _safeCall('apiAgencyHealth', e);
      // Admin — audit log read-back + tamper-evident chain check
      case 'list_audit_log':     return _safeCall('apiListAuditLog', e);
      case 'verify_audit_chain': return _safeCall('apiVerifyAuditChain', e);
      // Tenant data export (CSV/JSON of everything)
      case 'export_tenant':      return _safeCall('apiExportTenant', e);
      // Clients
      case 'list_clients':       return _safeCall('apiListClients', e);
      case 'get_client':         return _safeCall('apiGetClient', e);
      // Team / invitations
      case 'list_users':         return _safeCall('apiListUsers', e);
      case 'list_invitations':   return _safeCall('apiListInvitations', e);
      case 'invite_allowlist':   return _safeCall('apiInviteAllowlist', e);
      // Close-out (v18.2)
      case 'list_job_expenses':  return _safeCall('apiListJobExpenses', e);
      case 'get_receipt':        return _safeCall('apiGetReceipt', e);
      // Consumers / PHI (v18.4) — list is masked; reveal is heavy-audited break-glass
      case 'list_consumers':     return _safeCall('apiListConsumers', e);
      case 'reveal_consumer':    return _safeCall('apiRevealConsumer', e);
      // Client documents (v18.3)
      case 'list_client_documents': return _safeCall('apiListClientDocuments', e);
      case 'get_client_document':   return _safeCall('apiGetClientDocument', e);
      // Calendar feed (v18.4) — raw text/calendar, NOT JSON-wrapped.
      case 'interpreter_ics':    return apiInterpreterIcs(e);
      case 'switch_tenant':      return _safeCall('apiSwitchTenant', e);  // GET-path enables JSONP response read
      case '_rotate_hmac':       return apiRotateHmac(e);                  // one-shot Worker-secret sync
      case '_mail_debug':        return apiMailDebug(e);                   // diagnostic
      case '_seed_host_data':    return _safeCall('apiSeedHostData', e);   // demo seed
      case '_wipe_seed':         return _safeCall('apiWipeSeed', e);
      default:                   return _json({ ok:false, error:'Unknown action: ' + action }, 404);
    }
  } catch (err) {
    return _json({ ok:false, error:String(err) }, 500);
  } finally {
    _setCallback(null);
  }
}

function doPost(e) {
  try {
    var params = (e && e.parameter) || {};
    if (params.d1op) return handleD1Op_(e); // D1 dual-write sync (Code_D1Sync.gs)
    _setCallback(_safeCb(params.callback));
    if (params.form_id) return handleInboundForm(e);

    var action = params.action || '';
    switch (action) {
      case 'auth_request':       return apiAuthRequest(e);
      case 'auth_verify':        return apiAuthVerify(e);
      // SSO (OIDC)
      case 'sso_config_set':     return _safeCall('apiSsoConfigSet', e);
      case 'sso_callback':       return _safeCall('apiSsoCallback', e);
      // Inbound email → draft request (Code_EmailIntake.gs)
      case '_install_inbound_email': return _safeCall('apiInstallInboundEmailTrigger', e);
      // Job state mutations route through the live-board dispatcher so the
      // Cloudflare Worker fan-outs to every connected subscriber on success.
      // The wrapper never blocks the response — notify failures are swallowed.
      case 'create_job':         return _dispatchWithLiveBoard_('create_job', 'apiCreateJob', e);
      case 'claim_job':          return _dispatchWithLiveBoard_('claim_job', 'apiClaimJob', e);
      case 'cancel_job':         return _dispatchWithLiveBoard_('cancel_job', 'apiCancelJob', e);
      case 'smart_fill':         return apiSmartFill(e);
      case 'bootstrap':          return apiBootstrap(e);
      // Routed through _safeCall so the D1 freshness nudge fires (phase-3 prereq);
      // behavior is identical — _safeCall just invokes the same apiX(e).
      case 'create_interpreter': return _safeCall('apiCreateInterpreter', e);
      case 'update_interpreter': return _safeCall('apiUpdateInterpreter', e);
      case 'create_requestor':   return _safeCall('apiCreateRequestor', e);
      case 'update_agency':      return _safeCall('apiUpdateAgency', e);
      case 'update_setting':     return _safeCall('apiUpdateSetting', e);
      case 'offer_job':          return _dispatchWithLiveBoard_('offer_job', 'apiOfferJob', e);
      case 'confirm_job':        return _dispatchWithLiveBoard_('confirm_job', 'apiConfirmJob', e);
      case 'start_job':          return _dispatchWithLiveBoard_('start_job', 'apiStartJob', e);
      case 'complete_job':       return _dispatchWithLiveBoard_('complete_job', 'apiCompleteJob', e);
      case 'ai_intake':          return apiAiIntake(e);
      // Invoicing & payouts
      case 'create_invoice':     return _safeCall('apiCreateInvoice', e);
      case 'update_invoice':     return _safeCall('apiUpdateInvoice', e);
      case 'mark_invoice_paid':  return _safeCall('apiMarkInvoicePaid', e);
      case 'void_invoice':       return _safeCall('apiVoidInvoice', e);
      case 'create_payout':      return _safeCall('apiCreatePayout', e);
      case 'mark_payout_paid':   return _safeCall('apiMarkPayoutPaid', e);
      // Multi-tenant admin
      case 'provision_tenant':   return _safeCall('apiProvisionTenant', e);
      case 'switch_tenant':      return _safeCall('apiSwitchTenant', e);
      case 'add_tenant_owner':   return _safeCall('apiAddTenantOwner', e);
      // Translation
      case 'create_translation_job':    return _safeCall('apiCreateTranslationJob', e);
      case 'upload_translation_source': return _safeCall('apiUploadTranslationSource', e);
      case 'start_translation':         return _safeCall('apiStartTranslation', e);
      case 'submit_translation_review': return _safeCall('apiSubmitTranslationReview', e);
      case 'approve_translation':       return _safeCall('apiApproveTranslation', e);
      case 'reject_translation':        return _safeCall('apiRejectTranslation', e);
      case 'cancel_translation':        return _safeCall('apiCancelTranslation', e);
      // Payments
      case 'connect_account_link':      return _safeCall('apiConnectAccountLink', e);
      case 'connect_account_refresh':   return _safeCall('apiConnectAccountRefresh', e);
      case 'payout_send':               return _safeCall('apiPayoutSend', e);
      case 'invoice_send':              return _safeCall('apiInvoiceSend', e);
      case 'issue_1099_nec':            return _safeCall('apiIssue1099Nec', e);
      case 'setup_stripe_credentials':  return _safeCall('apiSetupStripeCredentials', e);
      case 'setup_track1099_credentials': return _safeCall('apiSetupTrack1099Credentials', e);
      case 'setup_plaid_credentials':   return _safeCall('apiSetupPlaidCredentials', e);
      // Stripe webhook bridge — Worker forwards verified events here.
      case 'payments_webhook_event':    return _safeCall('apiPaymentsWebhookEvent', e);
      // Pattern G — agency Stripe Connect OAuth (read-only reporting, Mode A).
      case 'agency_connect_start':      return _safeCall('apiAgencyConnectStart', e);
      case 'agency_connect_callback':   return _safeCall('apiAgencyConnectCallback', e);
      case 'agency_connect_report':     return _safeCall('apiAgencyConnectReport', e);
      case 'agency_connect_disconnect': return _safeCall('apiAgencyConnectDisconnect', e);
      // Public marketing-page hop (no session). Also exposed via doGet for
      // JSONP-friendly callers; registered here so a regular POST also works.
      case 'subscription_intent_url':   return _safeCall('apiSubscriptionIntentUrl', e);
      // Rate engine + docs + requirements
      case 'upsert_rate_modifier':      return _safeCall('apiUpsertRateModifier', e);
      case 'delete_rate_modifier':      return _safeCall('apiDeleteRateModifier', e);
      case 'upsert_rate_card':          return _safeCall('apiUpsertRateCard', e);
      case 'upsert_interpreter_doc':    return _safeCall('apiUpsertInterpreterDoc', e);
      case 'upsert_requirement':        return _safeCall('apiUpsertRequirement', e);
      case 'delete_requirement':        return _safeCall('apiDeleteRequirement', e);
      case 'update_interpreter_rates':  return _safeCall('apiUpdateInterpreterRates', e);
      // Offer / PII reveal
      case 'accept_offer':              return _dispatchWithLiveBoard_('accept_offer', 'apiAcceptOffer', e);
      case 'decline_offer':             return _dispatchWithLiveBoard_('decline_offer', 'apiDeclineOffer', e);
      case 'add_assignment_note':       return _safeCall('apiAddAssignmentNote', e);
      // Notifications
      case 'update_notification_pref':  return _safeCall('apiUpdateNotificationPref', e);
      case 'update_notification_settings': return _safeCall('apiUpdateNotificationSettings', e);
      case '_install_digest_triggers':  return _safeCall('apiInstallDigestTriggers', e);
      // Inbound SMS (Twilio → Worker → here, worker-JWT auth, purpose='twilio_inbound')
      case 'sms_inbound':               return _safeCall('apiSmsInbound', e);
      // Clients + billing
      case 'create_client':             return _safeCall('apiCreateClient', e);
      case 'update_client':             return _safeCall('apiUpdateClient', e);
      case 'upsert_client_contact':     return _safeCall('apiUpsertClientContact', e);
      case 'upsert_specialist':         return _safeCall('apiUpsertSpecialist', e);
      case 'update_client_billing_rules': return _safeCall('apiUpdateClientBillingRules', e);
      // Close-out (v18.2)
      case 'closeout_job':              return _dispatchWithLiveBoard_('closeout_job', 'apiCloseOutJob', e);
      case 'upload_receipt':            return _safeCall('apiUploadReceipt', e);
      case 'dispute_closeout':          return _dispatchWithLiveBoard_('dispute_closeout', 'apiDisputeCloseout', e);
      case 'update_expense_status':     return _safeCall('apiUpdateExpenseStatus', e);
      // Consumers / PHI (v18.4)
      case 'create_consumer':           return _safeCall('apiCreateConsumer', e);
      case 'update_consumer':           return _safeCall('apiUpdateConsumer', e);
      // Client documents (v18.3)
      case 'upload_client_document':    return _safeCall('apiUploadClientDocument', e);
      case 'archive_client_document':   return _safeCall('apiArchiveClientDocument', e);
      // Team / invitations (v18.3)
      case 'invite_user':               return _safeCall('apiInviteUser', e);
      case 'cancel_invitation':         return _safeCall('apiCancelInvitation', e);
      case 'resend_invitation':         return _safeCall('apiResendInvitation', e);
      // Calendar feed token management (v18.4)
      case 'rotate_calendar_token':     return _safeCall('apiRotateCalendarToken', e);
      case 'clear_calendar_token':      return _safeCall('apiClearCalendarToken', e);
      default:                   return _json({ ok:false, error:'Unknown action: ' + action }, 404);
    }
  } catch (err) {
    _logAudit('system_error', '', '', String(err));
    return _json({ ok:false, error:String(err) }, 500);
  } finally {
    _setCallback(null);
  }
}

function _safeCb(name) {
  // Only allow safe JS identifiers; prevents XSS via callback param.
  if (!name) return null;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(String(name))) return null;
  return String(name);
}

// Convention-based dispatcher: looks up the function by name on the global
// object and calls it. Returns 501 if the function isn't yet defined (e.g.,
// the corresponding .gs file hasn't been pushed). Lets us declare router
// routes for endpoints whose implementations live in separate .gs files
// without breaking when those files aren't yet present.
function _safeCall(fnName, e) {
  var fn = (typeof globalThis !== 'undefined' && globalThis[fnName]) ||
           (this && this[fnName]);
  if (typeof fn !== 'function') {
    return _json({ ok:false, error:'Not implemented yet: ' + fnName }, 501);
  }
  var out = fn(e);
  // Freshness nudge: keep D1 read-fresh after a write (phase-3 prereq). Fully
  // guarded + flag-gated in _d1NudgeAfterWrite_; a no-op for read actions and
  // when dual-write is off. Never blocks/throws into the response.
  try {
    var action = (e && e.parameter && e.parameter.action) || '';
    if (action && typeof _d1NudgeAfterWrite_ === 'function') _d1NudgeAfterWrite_(action, e, out);
  } catch (_) {}
  return out;
}

function _serviceInfo() {
  return _json({
    ok: true,
    service: '1891 Interpreter — Backend',
    version: '2026-05-17-v2',
    routes: {
      get: ['service','list_jobs','get_job','whoami'],
      post: ['<form_id>','auth_request','auth_verify','create_job','claim_job','cancel_job','smart_fill','bootstrap']
    }
  });
}

// ============================================================================
// INBOUND MARKETING FORMS (existing behavior, preserved)
// ============================================================================

function handleInboundForm(e) {
  var params = e.parameter || {};
  var formId = String(params.form_id || 'unknown');
  var timestamp = new Date();
  var iso = timestamp.toISOString();

  var phiCheck = _scanForLikelyPHI(params);
  if (phiCheck.blocked) {
    _logAudit('inbound_form_rejected_phi', formId, '', phiCheck.reason);
    return _json({ ok:false, error:'Submission rejected by PII filter. Please remove medical or personal-identifier detail and retry.' });
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);

  if (formId === 'deaf_owned_application') {
    _appendDeafOwnedApplication(ss, iso, params);
  }

  _appendInbound(ss, iso, formId, params);
  _notifyOwner(formId, params);
  _logAudit('inbound_form_submit', formId, '', '');
  return _json({ ok:true, received:iso });
}

function _appendInbound(ss, iso, formId, params) {
  var headers = [
    'timestamp','form_id','name','email','organization','agency_size',
    'modality','current_platform','helps','topic','message',
    'language','when','setting','notes',
    'agency_legal_name','state_of_formation','owner_name','documentation_type',
    'page','raw_params'
  ];
  var sheet = _getOrCreateSheet(ss, T.Inbound, headers);
  var name = params.name || params.full_name || params.requestor_name || params.owner_name || '';
  var email = params.email || params.work_email || params.contact_email || '';
  var modality = '';
  if (params.modality) {
    modality = Array.isArray(params.modality) ? params.modality.join(',') : String(params.modality);
  }
  sheet.appendRow([
    iso, formId, name, email,
    params.organization || params.agency_name || '',
    params.agency_size || '',
    modality,
    params.current_platform || '',
    params.helps || '',
    params.topic || '',
    params.message || '',
    params.language || '',
    params.when || '',
    params.setting || '',
    params.notes || '',
    params.agency_legal_name || '',
    params.state_of_formation || '',
    params.owner_name || '',
    params.documentation_type || '',
    params.page || '',
    JSON.stringify(params)
  ]);
}

function _appendDeafOwnedApplication(ss, iso, params) {
  var headers = [
    'submitted_at','agency_legal_name','state_of_formation','owner_name',
    'contact_email','documentation_type','notes','review_status',
    'reviewed_at','reviewer','decision_notes'
  ];
  var sheet = _getOrCreateSheet(ss, T.DeafOwnedApplications, headers);
  sheet.appendRow([
    iso,
    params.agency_legal_name || '',
    params.state_of_formation || '',
    params.owner_name || '',
    params.contact_email || '',
    params.documentation_type || '',
    params.notes || '',
    'pending','','',''
  ]);
}

function _scanForLikelyPHI(params) {
  var blob = '';
  for (var k in params) {
    if (Object.prototype.hasOwnProperty.call(params, k)) blob += ' ' + String(params[k]);
  }
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(blob)) return { blocked:true, reason:'SSN-shape detected' };
  var formId = String(params.form_id || '');
  if (formId === 'requestor_sample') {
    var red = /\b(diagnosis|MRN|medical record number|chart number|patient name|DOB|SSN|HIV|cancer|psychiatric|chemotherapy)\b/i;
    if (red.test(blob)) return { blocked:true, reason:'Clinical detail in requestor form notes' };
  }
  return { blocked:false };
}

function _notifyOwner(formId, params) {
  var to = NOTIFY_EMAIL;
  if (formId === 'a11y' || formId === 'accessibility_feedback') to = ACCESSIBILITY_NOTIFY;
  if (formId === 'security_disclosure') to = SECURITY_NOTIFY;

  var subject = '[1891 Interpreter] ' + formId + ' — new inbound';
  var lines = [];
  var keys = Object.keys(params).sort();
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (k === 'raw_params') continue;
    lines.push(k + ': ' + params[k]);
  }
  var body = 'New inbound form submission on madeby1891.com/interpreter\n\n' +
             lines.join('\n') +
             '\n\n— 1891 Interpreter inbound forms backend';
  try { MailApp.sendEmail({ to: to, subject: subject, body: body }); }
  catch (err) { _logAudit('inbound_form_notify_failed', formId, '', String(err)); }
}

// ============================================================================
// AUTH — magic link
// ============================================================================
//
// Flow:
//   1. Site posts { action: 'auth_request', email: '<email>' }
//   2. We generate a token, store hash in Auth_Tokens, email the link.
//   3. User clicks link → site loads /app/callback.html?token=...
//   4. Page posts { action: 'auth_verify', token: '<token>' }
//   5. We verify, mint a session JWT (HS256), return it.
//   6. Site stores session in localStorage; passes as `session` on every call.
//
// Session JWT format (compact, not RFC):
//   payload = base64url(JSON({uid,tid,role,exp}))
//   signature = base64url(HMAC-SHA256(secret, payload))
//   token = payload + '.' + signature

function apiAuthRequest(e) {
  var email = String((e.parameter.email || '')).trim().toLowerCase();
  if (!_isValidEmail(email)) return _json({ ok:false, error:'Valid email required.' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  // Resolve user → tenant. For v1 we accept any email that already has a Users row,
  // and fall back to provisioning the host tenant for anthony's master Gmail.
  var user = _lookupUserByEmail(ss, email);
  if (!user) {
    // Soft bootstrap: anthony's master Gmail auto-becomes the host owner.
    if (email === 'anthonymowl@gmail.com') {
      user = _ensureHostOwner(ss);
    } else {
      // For unknown emails we still issue a link — the auth_verify step will fail
      // gracefully. Avoids leaking "is this address registered" to anonymous probes.
      user = { user_id:'unknown', tenant_id:'unknown', email:email, role_id:'unknown' };
    }
  }

  var token = _newToken();
  var hash = _sha256Hex(token);
  var now = new Date();
  var expIso = new Date(now.getTime() + AUTH_TOKEN_TTL_MS).toISOString();
  var sheet = _getOrCreateSheet(ss, T.AuthTokens,
    ['issued_at','email','token_hash','user_id','tenant_id','expires_at','consumed_at','ip','user_agent']);
  sheet.appendRow([now.toISOString(), email, hash, user.user_id, user.tenant_id, expIso, '', '', '']);

  var link = SITE_BASE + '/app/callback.html?token=' + encodeURIComponent(token);
  var body =
    'Welcome back to 1891 Interpreter.\n\n' +
    'Click this one-time link within the next 15 minutes to sign in:\n\n' +
    link + '\n\n' +
    "If you didn't request this, you can ignore this email — the link won't work without being clicked.\n\n" +
    '— 1891 Interpreter';
  try {
    MailApp.sendEmail({ to: email, subject: 'Your 1891 Interpreter sign-in link', body: body });
  } catch (err) {
    _logAudit('auth_email_failed', '', user.user_id, String(err));
    return _json({ ok:false, error:'We couldn’t send the email right now. Please try again in a minute.' });
  }
  _logAudit('auth_link_issued', '', user.user_id, '');
  return _json({ ok:true, message:'Check your inbox for a sign-in link.' });
}

function apiAuthVerify(e) {
  var token = String(e.parameter.token || '');
  if (!token) return _json({ ok:false, error:'Token required.' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(T.AuthTokens);
  if (!sheet) return _json({ ok:false, error:'No tokens issued yet.' });

  var hash = _sha256Hex(token);
  var data = sheet.getDataRange().getValues();
  // headers in row 0
  var hdr = data[0]; var idxHash = hdr.indexOf('token_hash');
  var idxExpires = hdr.indexOf('expires_at');
  var idxConsumed = hdr.indexOf('consumed_at');
  var idxUser = hdr.indexOf('user_id');
  var idxTenant = hdr.indexOf('tenant_id');
  var idxEmail = hdr.indexOf('email');
  var found = -1;
  for (var i = data.length - 1; i >= 1; i--) {  // search latest first
    if (String(data[i][idxHash]) === hash) { found = i; break; }
  }
  if (found < 0) return _json({ ok:false, error:'Invalid token.' });
  var row = data[found];
  if (row[idxConsumed]) return _json({ ok:false, error:'This sign-in link has already been used.' });
  if (new Date(row[idxExpires]).getTime() < Date.now()) return _json({ ok:false, error:'This sign-in link has expired. Request a new one.' });

  var userId = String(row[idxUser]);
  var tenantId = String(row[idxTenant]);
  if (userId === 'unknown' || tenantId === 'unknown') {
    // Token was issued for an email we don't recognize. Treat as failure.
    sheet.getRange(found + 1, idxConsumed + 1).setValue(new Date().toISOString());
    return _json({ ok:false, error:'Sign-in link invalid for this account.' });
  }

  // Re-verify user still exists. Accept 'active' AND 'invited' — invitation
  // tokens are redeemed via this same endpoint, and we flip the user to
  // 'active' on first successful redemption (see _activateInvitedUser_).
  var user = _lookupUserById(ss, userId);
  if (!user) return _json({ ok:false, error:'Account no longer exists.' });
  if (user.status !== 'active' && user.status !== 'invited') {
    return _json({ ok:false, error:'Account not active (status=' + user.status + ').' });
  }

  var nowIso = new Date().toISOString();
  sheet.getRange(found + 1, idxConsumed + 1).setValue(nowIso);

  // Invitation acceptance: flip 'invited' → 'active' and stamp last_login_at.
  // Magic-link sign-ins (status='active') just stamp last_login_at.
  var firstLogin = (user.status === 'invited');
  _stampUserLogin_(ss, userId, nowIso, firstLogin);
  if (firstLogin) {
    user.status = 'active';  // reflect in returned payload
    _logAudit('invite.accept', tenantId, userId, user.email);
  }

  var session = _mintSession({ uid:userId, tid:tenantId, role:user.role_id, email:user.email });
  _logAudit('auth_login', tenantId, userId, firstLogin ? 'first_login_via_invitation' : '');
  return _json({
    ok: true,
    session: session,
    user: {
      user_id: userId,
      tenant_id: tenantId,
      email: user.email,
      display_name: user.display_name,
      role_id: user.role_id,
      first_login: firstLogin
    }
  });
}

// Stamp last_login_at and (optionally) flip status='invited' → 'active'.
// Lives in Code.gs so it can be called from apiAuthVerify above without
// depending on Code_Invitations.gs being present.
function _stampUserLogin_(ss, userId, iso, activateIfInvited) {
  var sh = ss.getSheetByName(T.Users);
  if (!sh || sh.getLastRow() < 2) return;
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iUser = hdr.indexOf('user_id');
  var iLast = hdr.indexOf('last_login_at');
  var iStatus = hdr.indexOf('status');
  var iUpdated = hdr.indexOf('_updated_at');
  if (iUser < 0) return;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iUser]) !== userId) continue;
    if (iLast >= 0) sh.getRange(r + 1, iLast + 1).setValue(iso);
    if (iUpdated >= 0) sh.getRange(r + 1, iUpdated + 1).setValue(iso);
    if (activateIfInvited && iStatus >= 0 && String(data[r][iStatus]) === 'invited') {
      sh.getRange(r + 1, iStatus + 1).setValue('active');
    }
    return;
  }
}

function apiWhoami(e) {
  var session = _requireSession(e);
  if (!session.ok) return _json({ ok:false, error:session.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var user = _lookupUserById(ss, session.payload.uid);
  if (!user) return _json({ ok:false, error:'User no longer exists.' }, 401);
  // Pull tenant agency row for white-label theme application client-side
  var agency = _findAgencyRow(ss, session.payload.tid);

  // Multi-tenant: list every tenant the signed-in user can switch into.
  // Platform staff (and the legacy host-owner) see everything; everyone else
  // sees the tenants they own via Tenant_Owners plus their current tenant.
  // Soft-fail if the control Sheet isn't bootstrapped yet — single-tenant
  // callers should still get a valid whoami response.
  var availableTenants = [];
  try {
    availableTenants = _whoamiAvailableTenants(session, ss);
  } catch (_) { availableTenants = []; }

  return _json({
    ok: true,
    user: user,
    agency: agency ? {
      tenant_id: agency.tenant_id,
      legal_name: agency.legal_name,
      tier: agency.tier,
      brand_color: agency.brand_color,
      timezone: agency.timezone,
      phi_mode: agency.phi_mode
    } : null,
    available_tenants: availableTenants,
    session_exp: new Date(session.payload.exp).toISOString()
  });
}

/**
 * Returns the list of tenants the signed-in user can switch into:
 *   [{ tenant_id, legal_name, role_in_tenant, current }]
 * Always includes the current session.tid (so the UI can highlight it as
 * "you are here"). Platform staff get every active tenant in the control
 * Sheet. Lives in Code.gs so apiWhoami can call it directly; the underlying
 * tables live in Code_Multitenant.gs.
 */
function _whoamiAvailableTenants(session, hostSs) {
  var sid = session.payload.tid;
  var role = session.payload.role;
  var out = [];
  var seen = {};

  function push(t) {
    if (!t || !t.tenant_id || seen[t.tenant_id]) return;
    seen[t.tenant_id] = true;
    out.push(t);
  }

  // Always include the current tenant first so the UI can render it as
  // selected even when the control Sheet is empty.
  var curAgency = _findAgencyRow(hostSs, sid);
  push({
    tenant_id: sid,
    legal_name: (curAgency && curAgency.legal_name) ||
                (sid === 'host' ? '1891 Interpreter (host)' : sid),
    role_in_tenant: role,
    current: true
  });

  var crossTenant = (role === 'role_platform_staff') ||
                    (sid === 'host' && role === 'role_owner');

  if (crossTenant) {
    try {
      var ctrlRows = _readTenantsTable();
      ctrlRows.forEach(function (t) {
        if (t.status === 'suspended') return;
        push({
          tenant_id: t.tenant_id,
          legal_name: t.legal_name || t.tenant_id,
          role_in_tenant: role,
          current: t.tenant_id === sid
        });
      });
    } catch (_) { /* control sheet missing — fine */ }
  } else {
    try {
      var owned = _tenantsForUser(session.payload.uid, session.payload.email);
      if (owned.length) {
        var ctrlRows2 = _readTenantsTable();
        var byId = {};
        ctrlRows2.forEach(function (t) { byId[t.tenant_id] = t; });
        owned.forEach(function (o) {
          var t = byId[o.tenant_id];
          if (t && t.status === 'suspended') return;
          push({
            tenant_id: o.tenant_id,
            legal_name: (t && t.legal_name) || o.tenant_id,
            role_in_tenant: o.role === 'owner' ? 'role_owner' : (o.role || role),
            current: o.tenant_id === sid
          });
        });
      }
    } catch (_) { /* fine */ }
  }

  return out;
}

function _findAgencyRow(ss, tenantId) {
  var sh = ss.getSheetByName(T.Agencies);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id === tenantId) return o;
  }
  return null;
}

function _mintSession(payloadObj) {
  var now = Date.now();
  payloadObj.iat = now;
  payloadObj.exp = now + SESSION_TTL_MS;
  var payload = _b64urlEncode(Utilities.newBlob(JSON.stringify(payloadObj)).getBytes());
  var sig = _hmacB64Url(payload);
  return payload + '.' + sig;
}

function _verifySession(token) {
  if (!token || token.indexOf('.') < 0) return { ok:false, error:'Malformed token.' };
  var parts = token.split('.');
  if (parts.length !== 2) return { ok:false, error:'Malformed token.' };
  var expected = _hmacB64Url(parts[0]);
  if (expected !== parts[1]) return { ok:false, error:'Bad signature.' };
  try {
    var payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
    if (!payload.exp || payload.exp < Date.now()) return { ok:false, error:'Session expired.' };
    return { ok:true, payload:payload };
  } catch (err) {
    return { ok:false, error:'Bad payload.' };
  }
}

function _requireSession(e) {
  var token = (e.parameter && e.parameter.session) || '';
  return _verifySession(token);
}

// ----------------------------------------------------------------------------
// Worker-issued machine-to-machine session (Stripe / Track1099 / Twilio
// webhooks). The Worker has no user context for these inbound webhooks, so
// after verifying the upstream signature it mints a short-lived JWT with the
// same HMAC secret. We accept it ONLY for the explicit purposes listed below.
//
// Wire format is identical to a user session JWT; the differentiating claims
// are `iss === 'worker'` and `purpose === <action-class>`. Worker tokens have
// `tid === '*'` and carry no user identity — handlers that need to scope the
// write should look up the record's own tenant_id (e.g., via invoice_id) and
// rely on the audit log to record the action.
//
// Allowed purposes — keep this list narrow:
//   - 'stripe_webhook'     → mark_invoice_paid, mark_payout_paid,
//                            update_interpreter (account.updated)
//   - 'track1099_webhook'  → reserved for future Track1099 callbacks
//   - 'twilio_inbound'     → reserved for future Twilio inbound SMS callback
// ----------------------------------------------------------------------------

var _WORKER_PURPOSES = {
  'stripe_webhook': true,
  'track1099_webhook': true,
  'twilio_inbound': true
};

function _verifyWorkerJwt(token, expectedPurpose) {
  var v = _verifySession(token);
  if (!v.ok) return v;
  var p = v.payload || {};
  if (p.iss !== 'worker') return { ok:false, error:'Not a worker token.' };
  if (!p.purpose || typeof p.purpose !== 'string') return { ok:false, error:'Missing purpose claim.' };
  if (!_WORKER_PURPOSES[p.purpose]) return { ok:false, error:'Unknown worker purpose: ' + p.purpose };
  if (expectedPurpose && p.purpose !== expectedPurpose) {
    return { ok:false, error:'Worker purpose mismatch: expected ' + expectedPurpose + ', got ' + p.purpose };
  }
  // Worker tokens get an artificial uid for audit logs and a '*' tenant.
  return {
    ok: true,
    payload: {
      uid: 'worker:' + p.purpose,
      tid: '*',
      role: 'role_worker',
      iss: 'worker',
      purpose: p.purpose,
      iat: p.iat,
      exp: p.exp
    },
    is_worker: true
  };
}

/**
 * Accept either a user session OR a worker-issued JWT with the named purpose.
 * Returns the same shape as `_requireSession` plus an `is_worker` flag when
 * the caller is a Worker, so handlers can branch on tenant-scope behavior.
 *
 * Use this in webhook-callback handlers (apiMarkInvoicePaid, apiMarkPayoutPaid,
 * apiUpdateInterpreter) instead of `_requireSession(e)`.
 */
function _requireSessionOrWorker(e, expectedPurpose) {
  var token = (e.parameter && e.parameter.session) || '';
  if (!token) return { ok:false, error:'Missing session.' };
  var v = _verifySession(token);
  if (!v.ok) return v;
  if (v.payload && v.payload.iss === 'worker') {
    return _verifyWorkerJwt(token, expectedPurpose);
  }
  return v;
}

function _hmacB64Url(text) {
  var key = _hmacSecret();
  var raw = Utilities.computeHmacSha256Signature(text, key);
  return _b64urlEncode(raw);
}

function _hmacSecret() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('HMAC_SECRET');
  if (!s) {
    s = Utilities.getUuid() + '.' + Utilities.getUuid();
    props.setProperty('HMAC_SECRET', s);
  }
  return s;
}

function _b64urlEncode(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function _newToken() {
  // 256-bit token, hex-encoded
  var u1 = Utilities.getUuid().replace(/-/g, '');
  var u2 = Utilities.getUuid().replace(/-/g, '');
  return u1 + u2;
}

function _sha256Hex(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text);
  return bytes.map(function (b) {
    return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
  }).join('');
}

function _isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ============================================================================
// USERS
// ============================================================================

function _lookupUserByEmail(ss, email) {
  var sh = ss.getSheetByName(T.Users);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iEmail = hdr.indexOf('email');
  if (iEmail < 0) return null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iEmail]).toLowerCase() === email) {
      return _rowToObj(hdr, data[i]);
    }
  }
  return null;
}

function _lookupUserById(ss, userId) {
  var sh = ss.getSheetByName(T.Users);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iId = hdr.indexOf('user_id');
  if (iId < 0) return null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iId]) === userId) return _rowToObj(hdr, data[i]);
  }
  return null;
}

function _ensureHostOwner(ss) {
  // Make sure the host agency exists and anthonymowl@gmail.com is its owner.
  var schema = _tenantSchema();
  _ensureTab(ss, T.Agencies, schema.Agencies);
  _ensureTab(ss, T.Users, schema.Users);
  _ensureTab(ss, T.Roles, schema.Roles);

  var agencies = ss.getSheetByName(T.Agencies);
  if (agencies.getLastRow() < 2) {
    agencies.appendRow([
      'host',                          // tenant_id
      '1891 Interpreter (host)',       // legal_name
      '',                              // tax_id_last4
      'deaf-owned-free',               // tier
      'initials-only',                 // phi_mode
      'America/New_York',              // timezone
      '',                              // primary_owner_user_id (set after user row)
      '',                              // logo_r2_key
      '#C8553D',                       // brand_color
      'hello@madeby1891.com',          // billing_email
      new Date().toISOString(),        // _created_at
      new Date().toISOString()         // _updated_at
    ]);
  }

  // Seed system roles if missing
  _seedRoles(ss);

  var owner = _lookupUserByEmail(ss, 'anthonymowl@gmail.com');
  if (owner) return owner;

  var userId = _ulid('u');
  ss.getSheetByName(T.Users).appendRow([
    userId,
    'host',                                // tenant_id
    'anthonymowl@gmail.com',
    '',                                    // phone
    'Anthony Mowl',
    'role_owner',
    '',                                    // interpreter_id
    'active',
    false,                                 // mfa_enabled
    '[]',                                  // webauthn
    '',                                    // last_login_at
    JSON.stringify({ consumer:'masked' }), // pii_scope
    0, '',                                 // failed_login, sso
    '',                                    // calendar_token
    new Date().toISOString(),
    new Date().toISOString()
  ]);

  // Update agency owner pointer
  var aData = agencies.getDataRange().getValues();
  var aHdr = aData[0]; var iOwner = aHdr.indexOf('primary_owner_user_id');
  for (var r = 1; r < aData.length; r++) {
    if (String(aData[r][aHdr.indexOf('tenant_id')]) === 'host') {
      agencies.getRange(r + 1, iOwner + 1).setValue(userId);
      break;
    }
  }

  return _lookupUserByEmail(ss, 'anthonymowl@gmail.com');
}

function _seedRoles(ss) {
  var sheet = ss.getSheetByName(T.Roles);
  if (!sheet) return;
  // Idempotent: re-seed only the role_ids that aren't there yet
  var existing = {};
  if (sheet.getLastRow() >= 2) {
    var existingRows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    existingRows.forEach(function (r) { if (r[0]) existing[r[0]] = true; });
  }
  // Role hierarchy (top -> bottom):
  //   role_platform_staff (1891 employees, cross-tenant)
  //   └─ role_owner        (agency owner, all permissions in their tenant)
  //       └─ role_manager  (operations manager, all except billing & user mgmt)
  //           ├─ role_scheduler
  //           ├─ role_interpreter
  //           ├─ role_client_contact      (top contact at a client org — sees all its requestors)
  //           ├─ role_requestor_contact   (single requestor — its own jobs only)
  //           └─ role_billing_contact     (sees invoices for the client they're tied to)
  //   role_admin (deprecated alias of role_manager; kept for back-compat)
  //   role_payer_contact, role_consumer_self, role_auditor — unchanged
  var roles = [
    ['role_platform_staff',   '*', '1891 platform staff', JSON.stringify(['platform.*','tenant.*','*']),                                                                                                                                                              true,  'full'],
    ['role_owner',            '*', 'Agency owner',        JSON.stringify(['*']),                                                                                                                                                                                       true,  'full'],
    ['role_manager',          '*', 'Manager',             JSON.stringify(['agency.read','job.*','interpreter.*','requestor.*','client.*','specialist.*','consumer.read.masked','payer.read','invoice.read','payout.read','document.*','user.read','setting.read']),    false, 'masked'],
    ['role_admin',            '*', 'Admin (legacy)',      JSON.stringify(['agency.*','job.*','interpreter.*','requestor.*','client.*','specialist.*','consumer.read.masked','payer.*','invoice.*','payout.*','document.*','user.*','setting.*']),                       false, 'masked'],
    ['role_scheduler',        '*', 'Scheduler',           JSON.stringify(['job.read','job.write','job.assign','interpreter.read','requestor.read','requestor.write','client.read','specialist.read','consumer.read.masked','communication.send']),                      false, 'masked'],
    ['role_interpreter',      '*', 'Interpreter',         JSON.stringify(['job.read.assigned','job.claim','job.decline','availability.write','self.profile','consumer.read.masked.on_assigned_job']),                                                                   false, 'masked'],
    ['role_client_contact',   '*', 'Client contact',      JSON.stringify(['job.read.client','job.create.client','client.read.own','requestor.read.client','specialist.read.client','invoice.read.client']),                                                             false, 'none'],
    ['role_requestor_contact','*', 'Requestor contact',   JSON.stringify(['job.read.own','job.create','requestor.read.own']),                                                                                                                                          false, 'none'],
    ['role_billing_contact',  '*', 'Billing contact',     JSON.stringify(['invoice.read.client','invoice.pay','payer.read.client','client.read.own']),                                                                                                                  false, 'none'],
    ['role_payer_contact',    '*', 'Payer contact',       JSON.stringify(['invoice.read.own','invoice.pay']),                                                                                                                                                          false, 'none'],
    ['role_consumer_self',    '*', 'Consumer (self-service)', JSON.stringify(['self.profile','self.history']),                                                                                                                                                         false, 'none'],
    ['role_auditor',          '*', 'Auditor',             JSON.stringify(['audit.read','consumer.read.masked','job.read','invoice.read']),                                                                                                                              false, 'masked']
  ];
  var ts = new Date().toISOString();
  roles.forEach(function (r) {
    if (existing[r[0]]) return;
    sheet.appendRow([r[0], r[1], r[2], r[3], r[4], r[5], ts, ts]);
  });
}

// ============================================================================
// JOBS — CRUD + state machine
// ============================================================================

function apiListJobs(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Jobs, _tenantSchema().Jobs);

  var sheet = ss.getSheetByName(T.Jobs);
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, jobs:[] });
  var hdr = data[0];
  var jobs = [];
  for (var i = 1; i < data.length; i++) {
    var obj = _rowToObj(hdr, data[i]);
    if (obj.tenant_id !== s.payload.tid) continue;
    jobs.push(obj);
  }
  // optional filter by status
  var status = e.parameter.status;
  if (status) jobs = jobs.filter(function (j) { return j.status === status; });
  // sort by scheduled_start asc
  jobs.sort(function (a, b) { return String(a.scheduled_start).localeCompare(String(b.scheduled_start)); });
  return _json({ ok:true, jobs:jobs });
}

function apiGetJob(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.id;
  if (!jobId) return _json({ ok:false, error:'id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _findJob(ss, s.payload.tid, jobId);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);
  return _json({ ok:true, job:job });
}

function apiCreateJob(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);

  var p = e.parameter || {};
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Jobs, _tenantSchema().Jobs);
  _ensureTab(ss, T.JobEvents, _tenantSchema().Job_Events);

  var jobId = _ulid('j');
  var now = new Date().toISOString();
  var row = {
    job_id: jobId,
    tenant_id: s.payload.tid,
    requestor_id: p.requestor_id || '',
    requestor_contact_id: p.requestor_contact_id || '',
    payer_id: p.payer_id || '',
    location_id: p.location_id || '',
    consumer_id: '',  // initials-only mode never sets consumer_id
    modality: p.modality || 'on-site',
    service_type: p.service_type || 'medical',
    source_language_id: p.source_language_id || 'en-US',
    target_language_id: p.target_language_id || 'ASL',
    team_config: p.team_config || 'solo',
    scheduled_start: p.scheduled_start || '',
    scheduled_end: p.scheduled_end || '',
    actual_start: '',
    actual_end: '',
    status: 'OPEN',
    on_demand: p.on_demand === 'true',
    reference_no: p.reference_no || '',
    notes_to_interpreter: p.notes_to_interpreter || '',
    consent_recording: p.consent_recording === 'true',
    recording_r2_key: '',
    transcript_r2_key: '',
    created_via: p.created_via || 'portal',
    ai_intake_id: '',
    rate_applied: '{}',
    cancellation_reason: '',
    cancellation_at: '',
    _created_at: now,
    _updated_at: now,
    _rev: 1
  };

  var hdr = _tenantSchema().Jobs;
  var rowArr = hdr.map(function (col) { return row[col] !== undefined ? row[col] : ''; });
  ss.getSheetByName(T.Jobs).appendRow(rowArr);

  _appendJobEvent(ss, jobId, s.payload.uid, 'status_change', 'DRAFT', 'OPEN', '{}');
  _logAudit('job.create', s.payload.tid, s.payload.uid, jobId);

  return _json({ ok:true, job:row });
}

function apiClaimJob(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  if (!jobId) return _json({ ok:false, error:'job_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Jobs);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iJob = hdr.indexOf('job_id'); var iStatus = hdr.indexOf('status');
  var iTenant = hdr.indexOf('tenant_id'); var iUpdated = hdr.indexOf('_updated_at');
  var iRev = hdr.indexOf('_rev');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iJob]) === jobId && String(data[r][iTenant]) === s.payload.tid) {
      var cur = String(data[r][iStatus]);
      if (cur !== 'OPEN' && cur !== 'OFFERED') {
        return _json({ ok:false, error:'Job is not claimable (status=' + cur + ')' });
      }
      sh.getRange(r + 1, iStatus + 1).setValue('CLAIMED');
      sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
      sh.getRange(r + 1, iRev + 1).setValue(Number(data[r][iRev] || 0) + 1);

      // Add Job_Assignments row
      var asch = _tenantSchema().Job_Assignments;
      _ensureTab(ss, T.JobAssignments, asch);
      var assignmentId = _ulid('a');
      var now = new Date().toISOString();
      var aRow = {
        assignment_id: assignmentId,
        job_id: jobId,
        interpreter_id: e.parameter.interpreter_id || s.payload.uid,
        role_on_job: 'primary',
        offered_at: now,
        responded_at: now,
        response: 'claim',
        pay_rate_snapshot: '{}',
        billable_minutes: 0,
        status: 'CLAIMED',
        _created_at: now,
        _updated_at: now,
        _rev: 1
      };
      var aArr = asch.map(function (c) { return aRow[c] !== undefined ? aRow[c] : ''; });
      ss.getSheetByName(T.JobAssignments).appendRow(aArr);

      _appendJobEvent(ss, jobId, s.payload.uid, 'assignment_claimed', cur, 'CLAIMED', JSON.stringify({ assignment_id:assignmentId }));
      _logAudit('job.claim', s.payload.tid, s.payload.uid, jobId);
      return _json({ ok:true, job_id:jobId, assignment_id:assignmentId });
    }
  }
  return _json({ ok:false, error:'Job not found' }, 404);
}

function apiCancelJob(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  var reason = e.parameter.reason || '';
  if (!jobId) return _json({ ok:false, error:'job_id required' });
  if (reason && reason.length < 10) {
    return _json({ ok:false, error:'cancellation_reason must be at least 10 characters' });
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Jobs);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iJob = hdr.indexOf('job_id'); var iStatus = hdr.indexOf('status');
  var iTenant = hdr.indexOf('tenant_id'); var iCanc = hdr.indexOf('cancellation_reason');
  var iCancTs = hdr.indexOf('cancellation_at'); var iUpdated = hdr.indexOf('_updated_at');
  var iRev = hdr.indexOf('_rev');
  var iCancBill = hdr.indexOf('cancellation_bill_cents');
  var iCancPay  = hdr.indexOf('cancellation_pay_cents');
  var iCancTier = hdr.indexOf('cancellation_tier'); // optional

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iJob]) !== jobId || String(data[r][iTenant]) !== s.payload.tid) continue;
    var prev = String(data[r][iStatus]);
    if (!/^(OPEN|OFFERED|CLAIMED|CONFIRMED|EN_ROUTE|IN_PROGRESS|DRAFT)$/.test(prev)) {
      return _json({ ok:false, error:'Job is not cancellable (status=' + prev + ')' });
    }
    var nowIso = new Date().toISOString();
    var jobObj = _rowToObj(hdr, data[r]);

    // Compute cancellation quote snapshot (best-effort; don't block cancel on rate-engine errors)
    var snapshot = null;
    try { snapshot = _computeCancelSnapshot_(ss, s.payload.tid, jobObj); } catch (_) { snapshot = null; }

    sh.getRange(r + 1, iStatus + 1).setValue('CANCELLED_BY_AGENCY');
    if (iCanc >= 0)    sh.getRange(r + 1, iCanc + 1).setValue(reason);
    if (iCancTs >= 0)  sh.getRange(r + 1, iCancTs + 1).setValue(nowIso);
    if (iCancBill >= 0 && snapshot) sh.getRange(r + 1, iCancBill + 1).setValue(snapshot.bill_cents);
    if (iCancPay  >= 0 && snapshot) sh.getRange(r + 1, iCancPay  + 1).setValue(snapshot.total_pay_cents);
    if (iCancTier >= 0 && snapshot) sh.getRange(r + 1, iCancTier + 1).setValue(snapshot.tier);
    sh.getRange(r + 1, iUpdated + 1).setValue(nowIso);
    sh.getRange(r + 1, iRev + 1).setValue(Number(data[r][iRev] || 0) + 1);

    var payload = { reason: reason };
    if (snapshot) {
      payload.cancellation_tier = snapshot.tier;
      payload.cancellation_bill_cents = snapshot.bill_cents;
      payload.cancellation_pay_cents = snapshot.total_pay_cents;
      payload.hours_until_start = snapshot.hours_until_start;
    }
    _appendJobEvent(ss, jobId, s.payload.uid, 'cancelled', prev, 'CANCELLED_BY_AGENCY', JSON.stringify(payload));
    _logAudit('job.cancel', s.payload.tid, s.payload.uid, jobId + ' reason=' + reason);

    // Notify all assigned interpreters (best-effort)
    try { _notifyAssignedOfCancellation_(ss, s.payload.tid, jobObj, reason, snapshot); } catch (err) { /* swallow */ }

    return _json({
      ok: true,
      job_id: jobId,
      status: 'CANCELLED_BY_AGENCY',
      cancellation: snapshot || null
    });
  }
  return _json({ ok:false, error:'Job not found' }, 404);
}

// JSONP-friendly cancellation quote preview (no write).
// Returns { ok, tier, hours_until_start, bill_cents, pay_cents_per_interpreter, total_pay_cents, ... }.
function apiCancelJobQuote(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter && e.parameter.job_id;
  if (!jobId) return _json({ ok:false, error:'job_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _findJob(ss, s.payload.tid, jobId);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);
  var snap = _computeCancelSnapshot_(ss, s.payload.tid, job);
  return _json({
    ok: true,
    tier: snap.tier,
    hours_until_start: snap.hours_until_start,
    bill_cents: snap.bill_cents,
    pay_cents_per_interpreter: snap.pay_cents_per_interpreter,
    total_pay_cents: snap.total_pay_cents,
    assigned_count: snap.assigned_count,
    bill_pct: snap.bill_pct,
    pay_pct: snap.pay_pct
  });
}

// Shared helper: produce a single cancellation snapshot for the given job.
// Aggregates pay across currently-assigned interpreters (excluding declined offers).
function _computeCancelSnapshot_(ss, tenantId, job) {
  var hoursUntilStart = 0;
  if (job.scheduled_start) {
    var ms = new Date(job.scheduled_start).getTime() - Date.now();
    hoursUntilStart = ms / 3600000;
  }
  // Tier — mirrors apiComputeCancellationQuote's structure
  var billPct = 0, payPct = 0, tier = '';
  if (hoursUntilStart < 12) {
    billPct = 100; payPct = 100; tier = '<12h';
  } else if (hoursUntilStart < 24) {
    billPct = 100; payPct = 50;  tier = '12-24h';
  } else if (hoursUntilStart < 48) {
    billPct = 50;  payPct = 25;  tier = '24-48h';
  } else {
    billPct = 0;   payPct = 0;   tier = '>=48h';
  }
  // Tenant override via Settings.cancellation_policy.tiers
  var override = _getSetting(ss, 'cancellation_policy.tiers');
  if (override) {
    try {
      var t = JSON.parse(override);
      if (t[tier]) {
        if (typeof t[tier].bill_pct === 'number') billPct = t[tier].bill_pct;
        if (typeof t[tier].pay_pct  === 'number') payPct  = t[tier].pay_pct;
      }
    } catch (_) {}
  }

  var assigned = _findActiveAssignmentsForJob_(ss, job.job_id);
  var assignedCount = assigned.length;

  var baseQuote = null;
  try {
    if (typeof computeRateQuote_ === 'function') {
      baseQuote = computeRateQuote_(ss, tenantId, job, assigned[0] && assigned[0].interpreter_id || null);
    }
  } catch (err) { baseQuote = null; }
  var billTotal = baseQuote ? Number(baseQuote.bill.total_cents || 0) : 0;
  var payTotal  = baseQuote ? Number(baseQuote.pay.total_cents  || 0) : 0;

  var billCharge   = Math.round(billTotal * billPct / 100);
  var payPerInterp = Math.round(payTotal  * payPct  / 100);
  var totalPay     = payPerInterp * assignedCount;

  return {
    tier: tier,
    hours_until_start: Math.round(hoursUntilStart * 10) / 10,
    bill_pct: billPct,
    pay_pct: payPct,
    bill_cents: billCharge,
    pay_cents_per_interpreter: payPerInterp,
    total_pay_cents: totalPay,
    assigned_count: assignedCount
  };
}

function _findActiveAssignmentsForJob_(ss, jobId) {
  var sh = ss.getSheetByName(T.JobAssignments);
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.job_id !== jobId) continue;
    if (String(o.response).toLowerCase() === 'decline') continue;
    if (String(o.status).toUpperCase().indexOf('CANCELLED') === 0) continue;
    out.push(o);
  }
  return out;
}

function _notifyAssignedOfCancellation_(ss, tenantId, job, reason, snapshot) {
  if (typeof notifyEvent_ !== 'function') return;
  var assigned = _findActiveAssignmentsForJob_(ss, job.job_id);
  if (!assigned.length) return;
  var when = job.scheduled_start ? new Date(job.scheduled_start).toLocaleString('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  }) : 'TBD';
  var subject = 'Job cancelled — ' + (job.service_type || 'job') + ' on ' + when;
  var payLine = '';
  if (snapshot && snapshot.pay_cents_per_interpreter > 0) {
    payLine = '\n\nCancellation pay (' + snapshot.tier + ' tier): $' +
              (snapshot.pay_cents_per_interpreter / 100).toFixed(2);
  }
  var body = 'A job you were assigned to has been cancelled by the scheduling agency.\n\n' +
             'Job: ' + (job.service_type || '—') + '\n' +
             'When: ' + when + '\n' +
             'Reason: ' + (reason || '—') + payLine + '\n\n' +
             'Sign in to the interpreter app for details.';
  var smsBody = 'Job cancelled — ' + when + (snapshot && snapshot.pay_cents_per_interpreter > 0 ?
                ' (cancel pay $' + (snapshot.pay_cents_per_interpreter / 100).toFixed(2) + ')' : '');
  for (var i = 0; i < assigned.length; i++) {
    var a = assigned[i];
    var interp = (typeof _findInterpreterById === 'function') ? _findInterpreterById(ss, a.interpreter_id) : null;
    if (!interp || !interp.user_id) continue;
    try {
      notifyEvent_(ss, tenantId, 'job_cancelled', interp.user_id, subject, body, smsBody, { job_id: job.job_id });
    } catch (err) { /* per-interpreter failure should not abort */ }
  }
}

function _findJob(ss, tenantId, jobId) {
  var sh = ss.getSheetByName(T.Jobs);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id === tenantId && o.job_id === jobId) return o;
  }
  return null;
}

function _appendJobEvent(ss, jobId, actorUserId, eventType, fromState, toState, payloadJson) {
  _ensureTab(ss, T.JobEvents, _tenantSchema().Job_Events);
  ss.getSheetByName(T.JobEvents).appendRow([
    _ulid('e'), jobId, actorUserId, eventType, fromState, toState, payloadJson, new Date().toISOString()
  ]);
}

// ============================================================================
// SMART-FILL — transparent deterministic ranking
// ============================================================================
//
// Returns ranked interpreter candidates with per-factor scores. AI ranking
// belongs in a Worker later; this is the deterministic v1 baseline.

function apiSmartFill(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  if (!jobId) return _json({ ok:false, error:'job_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _findJob(ss, s.payload.tid, jobId);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);

  var interpreters = _listInterpreters(ss, s.payload.tid);
  var ranked = interpreters.map(function (i) {
    return _scoreInterpreter(i, job);
  });
  ranked.sort(function (a, b) { return b.score.total - a.score.total; });
  return _json({ ok:true, job_id:jobId, candidates: ranked.slice(0, 10) });
}

function _listInterpreters(ss, tenantId) {
  var sh = ss.getSheetByName(T.Interpreters);
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id === tenantId && o.status === 'active') out.push(o);
  }
  return out;
}

function _scoreInterpreter(interp, job) {
  // Weights are public per PRD: certification fit 30, location 20, requestor pref 20,
  // workload balance 15, prior performance 15. Total 100.
  var s = { certification:0, location:0, preference:0, workload:0, performance:0 };

  // Certification + language fit (30 pts)
  var iLangs = []; try { iLangs = JSON.parse(interp.languages || '[]'); } catch (_) { iLangs = []; }
  var hasLang = iLangs.some(function (l) {
    return l.lang === job.target_language_id || l.lang === job.source_language_id;
  });
  s.certification = hasLang ? 30 : 0;

  // Location proximity (20 pts). On-site only; remote modalities get full.
  if (job.modality !== 'on-site') {
    s.location = 20;
  } else {
    s.location = 12;  // placeholder until we have geo math
  }

  // Requestor preference (20 pts). Placeholder until history is wired.
  s.preference = 10;

  // Workload balance (15 pts). Placeholder.
  s.workload = 12;

  // Prior performance (15 pts). Placeholder.
  s.performance = 11;

  var total = s.certification + s.location + s.preference + s.workload + s.performance;
  return {
    interpreter_id: interp.interpreter_id,
    display_name: interp.legal_first + ' ' + interp.legal_last,
    deaf: interp.deaf === true || interp.deaf === 'true',
    languages: interp.languages,
    modalities: interp.modalities,
    score: { total: total, breakdown: s, max: 100 }
  };
}

// ============================================================================
// INTERPRETERS — roster CRUD
// ============================================================================

function apiListInterpreters(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Interpreters, _tenantSchema().Interpreters);
  var sh = ss.getSheetByName(T.Interpreters);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, interpreters:[] });
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id !== s.payload.tid) continue;
    out.push(o);
  }
  out.sort(function (a, b) {
    return String(a.legal_last || '').localeCompare(String(b.legal_last || ''));
  });
  return _json({ ok:true, interpreters: out });
}

function apiCreateInterpreter(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  if (!p.legal_first || !p.legal_last) return _json({ ok:false, error:'legal_first and legal_last required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Interpreters, _tenantSchema().Interpreters);

  var interpreterId = _ulid('i');
  var now = new Date().toISOString();
  var row = {
    interpreter_id: interpreterId,
    tenant_id: s.payload.tid,
    user_id: '',
    classification: p.classification || '1099',
    legal_first: p.legal_first,
    legal_last: p.legal_last,
    pronouns: p.pronouns || '',
    home_city: p.home_city || '',
    home_state: p.home_state || '',
    home_zip: p.home_zip || '',
    service_radius_mi: Number(p.service_radius_mi || 60),
    has_vehicle: p.has_vehicle === 'true',
    modalities: p.modalities || '["on-site","VRI","OPI"]',
    languages: p.languages || '[]',  // expected JSON
    certifications: p.certifications || '[]',
    skills: p.skills || '[]',
    rate_card_id: '',
    min_call_hours: Number(p.min_call_hours || 2),
    availability_prefs: '{}',
    availability_doc_id: '',
    payment_method: p.payment_method || 'ach',
    payment_details_encrypted: '',
    w9_doc_id: '',
    coi_doc_id: '',
    background_check_at: '',
    deaf: p.deaf === 'true',
    notes_internal: p.notes_internal || '',
    status: 'active',
    _created_at: now,
    _updated_at: now,
    _rev: 1
  };
  var hdr = _tenantSchema().Interpreters;
  var rowArr = hdr.map(function (col) { return row[col] !== undefined ? row[col] : ''; });
  ss.getSheetByName(T.Interpreters).appendRow(rowArr);
  _logAudit('interpreter.create', s.payload.tid, s.payload.uid, interpreterId);
  return _json({ ok:true, interpreter: row });
}

function apiUpdateInterpreter(e) {
  // Accept either a user session or a worker JWT minted by the Stripe webhook
  // handler. Worker calls bypass the tenant-scope match (they have tid='*')
  // and are limited to a whitelist of safe-to-write columns.
  var s = _requireSessionOrWorker(e, 'stripe_webhook');
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  var id = p.interpreter_id;
  if (!id) return _json({ ok:false, error:'interpreter_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Interpreters);
  if (!sh) return _json({ ok:false, error:'No interpreters tab yet' }, 404);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('interpreter_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iUpdated = hdr.indexOf('_updated_at');
  var iRev = hdr.indexOf('_rev');
  // User-session writes are scoped to their own tenant. Worker-issued writes
  // (from the Stripe webhook) match purely on interpreter_id since the inbound
  // event carries no tenant context — Stripe's `metadata.interpreter_id` is
  // unique across all tenants.
  var userAllowed = ['classification','legal_first','legal_last','pronouns','home_city','home_state','home_zip','service_radius_mi','has_vehicle','modalities','languages','certifications','skills','min_call_hours','payment_method','deaf','notes_internal','status'];
  // Webhook-only columns — never writable from a user session, to keep the
  // surface tight. Adding a column here means the Worker can flip that field
  // without UI scope, so think carefully before extending.
  var workerAllowed = ['stripe_account_id','stripe_charges_enabled','stripe_payouts_enabled','stripe_details_submitted'];
  var allowed = s.is_worker ? workerAllowed : userAllowed;
  for (var r = 1; r < data.length; r++) {
    var sameId = String(data[r][iId]) === id;
    var sameTenant = String(data[r][iTenant]) === s.payload.tid;
    var match = sameId && (s.is_worker ? true : sameTenant);
    if (match) {
      allowed.forEach(function (field) {
        if (p[field] === undefined || p[field] === null) return;
        var col = hdr.indexOf(field);
        if (col < 0) return;
        var v = p[field];
        if (field === 'has_vehicle' || field === 'deaf') v = (v === 'true');
        if (field === 'service_radius_mi' || field === 'min_call_hours') v = Number(v);
        if (field === 'stripe_charges_enabled' || field === 'stripe_payouts_enabled' || field === 'stripe_details_submitted') {
          v = (v === 'true' || v === true);
        }
        sh.getRange(r + 1, col + 1).setValue(v);
      });
      sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
      sh.getRange(r + 1, iRev + 1).setValue(Number(data[r][iRev] || 0) + 1);
      var auditTid = s.is_worker ? String(data[r][iTenant] || '*') : s.payload.tid;
      _logAudit('interpreter.update', auditTid, s.payload.uid, id);
      return _json({ ok:true, interpreter_id:id });
    }
  }
  return _json({ ok:false, error:'Interpreter not found' }, 404);
}

// ============================================================================
// REQUESTORS — booking parties CRUD
// ============================================================================

function apiListRequestors(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Requestors, _tenantSchema().Requestors);
  var sh = ss.getSheetByName(T.Requestors);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, requestors:[] });
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id !== s.payload.tid) continue;
    out.push(o);
  }
  out.sort(function (a, b) { return String(a.display_name || '').localeCompare(String(b.display_name || '')); });
  return _json({ ok:true, requestors: out });
}

function apiCreateRequestor(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  if (!p.display_name) return _json({ ok:false, error:'display_name required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Requestors, _tenantSchema().Requestors);

  var requestorId = _ulid('r');
  var now = new Date().toISOString();
  var row = {
    requestor_id: requestorId,
    tenant_id: s.payload.tid,
    display_name: p.display_name,
    type: p.type || 'medical',
    parent_org_id: '',
    billing_payer_id: '',
    default_location_id: '',
    contract_doc_id: '',
    po_required: p.po_required === 'true',
    notes: p.notes || '',
    status: 'active',
    _created_at: now,
    _updated_at: now,
    _rev: 1
  };
  var hdr = _tenantSchema().Requestors;
  var rowArr = hdr.map(function (col) { return row[col] !== undefined ? row[col] : ''; });
  ss.getSheetByName(T.Requestors).appendRow(rowArr);
  _logAudit('requestor.create', s.payload.tid, s.payload.uid, requestorId);
  return _json({ ok:true, requestor: row });
}

// ============================================================================
// AGENCY + SETTINGS — owner can update agency + rate cards
// ============================================================================

function apiUpdateAgency(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var p = e.parameter || {};
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Agencies);
  if (!sh) return _json({ ok:false, error:'No agencies tab' }, 404);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iId = hdr.indexOf('tenant_id');
  var iUpdated = hdr.indexOf('_updated_at');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) === s.payload.tid) {
      var allowed = ['legal_name','tax_id_last4','phi_mode','timezone','brand_color','billing_email'];
      allowed.forEach(function (field) {
        if (p[field] === undefined || p[field] === null) return;
        var col = hdr.indexOf(field);
        if (col < 0) return;
        sh.getRange(r + 1, col + 1).setValue(p[field]);
      });
      sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
      _logAudit('agency.update', s.payload.tid, s.payload.uid, '');
      return _json({ ok:true });
    }
  }
  return _json({ ok:false, error:'Agency not found' }, 404);
}

function apiListSettings(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Settings, _tenantSchema().Settings);
  var sh = ss.getSheetByName(T.Settings);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, settings:{} });
  var hdr = data[0];
  var settings = {};
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    settings[o.key] = { value: o.value, category: o.category };
  }
  return _json({ ok:true, settings:settings });
}

function apiUpdateSetting(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (s.payload.role !== 'role_owner' && s.payload.role !== 'role_admin') {
    return _json({ ok:false, error:'Owner or admin role required' }, 403);
  }
  var p = e.parameter || {};
  if (!p.key) return _json({ ok:false, error:'key required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Settings, _tenantSchema().Settings);
  var sh = ss.getSheetByName(T.Settings);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iKey = hdr.indexOf('key');
  var iValue = hdr.indexOf('value');
  var iCategory = hdr.indexOf('category');
  var iUpdated = hdr.indexOf('updated_at');
  var iUpdatedBy = hdr.indexOf('updated_by_user_id');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iKey]) === p.key) {
      sh.getRange(r + 1, iValue + 1).setValue(p.value || '');
      if (iUpdated >= 0) sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
      if (iUpdatedBy >= 0) sh.getRange(r + 1, iUpdatedBy + 1).setValue(s.payload.uid);
      _logAudit('setting.update', s.payload.tid, s.payload.uid, p.key);
      return _json({ ok:true });
    }
  }
  // Not found — append new
  var now = new Date().toISOString();
  sh.appendRow([p.key, p.value || '', p.category || 'misc', s.payload.uid, now, now, now]);
  _logAudit('setting.create', s.payload.tid, s.payload.uid, p.key);
  return _json({ ok:true });
}

// ============================================================================
// JOB STATE MACHINE — offer / confirm / start / complete
// ============================================================================

function apiOfferJob(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  if (!p.job_id || !p.interpreter_id) return _json({ ok:false, error:'job_id and interpreter_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _findJob(ss, s.payload.tid, p.job_id);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);
  if (job.status !== 'OPEN' && job.status !== 'OFFERED') {
    return _json({ ok:false, error:'Job not offerable (status=' + job.status + ')' });
  }

  // Look up the interpreter (we want the email for notification)
  var interp = _findInterpreter(ss, s.payload.tid, p.interpreter_id);
  if (!interp) return _json({ ok:false, error:'Interpreter not found' }, 404);

  // Write the offered Job_Assignments row
  var asch = _tenantSchema().Job_Assignments;
  _ensureTab(ss, T.JobAssignments, asch);
  var assignmentId = _ulid('a');
  var now = new Date().toISOString();
  var aRow = {
    assignment_id: assignmentId,
    job_id: p.job_id,
    interpreter_id: p.interpreter_id,
    role_on_job: p.role_on_job || 'primary',
    offered_at: now,
    responded_at: '',
    response: 'offered',
    pay_rate_snapshot: '{}',
    billable_minutes: 0,
    status: 'OFFERED',
    _created_at: now,
    _updated_at: now,
    _rev: 1
  };
  var aArr = asch.map(function (c) { return aRow[c] !== undefined ? aRow[c] : ''; });
  ss.getSheetByName(T.JobAssignments).appendRow(aArr);

  // Flip job to OFFERED
  _setJobField(ss, s.payload.tid, p.job_id, 'status', 'OFFERED');
  _appendJobEvent(ss, p.job_id, s.payload.uid, 'assignment_offered', job.status, 'OFFERED',
                  JSON.stringify({ interpreter_id: p.interpreter_id, assignment_id: assignmentId }));

  // Email the interpreter (best-effort)
  var subj = '1891 Interpreter — new job offer · ' + (job.service_type || 'medical') + ' · ' + (job.target_language_id || '');
  var when = _formatLocalTime(job.scheduled_start, 'America/New_York');
  var rate = _ratePerHour(ss, job.service_type || 'medical') / 100;
  var body =
    'Hi ' + (interp.legal_first || 'there') + ',\n\n' +
    'You have a new job offer:\n\n' +
    '  When:     ' + when + '\n' +
    '  Setting:  ' + (job.service_type || 'medical').replace(/-/g, ' ') + '\n' +
    '  Modality: ' + (job.modality || 'on-site') + '\n' +
    '  Language: ' + (job.source_language_id || '') + ' → ' + (job.target_language_id || '') + '\n' +
    '  Team:     ' + (job.team_config || 'solo') + '\n' +
    '  Rate:     $' + rate.toFixed(2) + '/hr (2-hr minimum applies)\n\n' +
    (job.notes_to_interpreter ? 'Notes: ' + job.notes_to_interpreter + '\n\n' : '') +
    'Open the app to claim: ' + SITE_BASE + '/app/claim/\n\n' +
    'The first qualified interpreter to claim locks the job. Reply (or claim in the app) in the next 15 minutes for best chance.\n\n' +
    '— 1891 Interpreter';
  // A PHI-free SMS — kind of work, time, modality, language, rate. Never the
  // consumer or any clinical detail. The interpreter replies YES to claim / NO
  // to pass; Code_Sms resolves the reply to this offer.
  var smsBody =
    '1891 offer: ' + (job.service_type || 'job').replace(/-/g, ' ') +
    ' · ' + when +
    ' · ' + (job.modality || 'on-site') +
    ' · ' + (job.target_language_id || '') +
    ' · $' + rate.toFixed(0) + '/hr. Reply YES to claim, NO to pass.';

  // Route through the notification rail: SMS (if the interpreter opted in / has a
  // phone) + email, each respecting their per-event preferences and all logged.
  var notif = { email: 'none', sms: 'none', push: 'none' };
  var interpUser = interp.user_id ? _lookupUserById(ss, interp.user_id) : null;
  if (interp.user_id) {
    notif = notifyEvent_(ss, s.payload.tid, 'job_offer', interp.user_id, subj, body, smsBody, {
      job_id: p.job_id,
      fallback_phone: (interpUser && interpUser.phone_e164) || ''
    });
  }

  // Email fallback for interpreters without a linked user account (or if the
  // rail didn't send/queue an email above).
  var emailedDirect = false;
  if (notif.email === 'none' || notif.email === 'failed') {
    var interpEmail = _resolveInterpreterEmail(ss, interp);
    if (interpEmail) {
      try {
        MailApp.sendEmail({ to: interpEmail, subject: subj, body: body });
        _logCommunication(ss, s.payload.tid, 'email', 'out', 'job_offer_v1', interp.user_id || '', interpEmail, 'sent', 'mailapp', p.job_id);
        emailedDirect = true;
      } catch (err) {
        _logCommunication(ss, s.payload.tid, 'email', 'out', 'job_offer_v1', interp.user_id || '', interpEmail, 'failed', 'mailapp', p.job_id);
      }
    }
  }

  _logAudit('job.offer', s.payload.tid, s.payload.uid, p.job_id + ' → ' + p.interpreter_id);
  return _json({
    ok: true,
    assignment_id: assignmentId,
    notified: { email: emailedDirect ? 'sent' : notif.email, sms: notif.sms }
  });
}

function apiConfirmJob(e) {
  return _transitionJob(e, ['CLAIMED'], 'CONFIRMED', 'status_change');
}
function apiStartJob(e) {
  // CONFIRMED → EN_ROUTE if no actual_start provided, IN_PROGRESS if start time given
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  if (!jobId) return _json({ ok:false, error:'job_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _findJob(ss, s.payload.tid, jobId);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);
  if (job.status !== 'CONFIRMED' && job.status !== 'EN_ROUTE') {
    return _json({ ok:false, error:'Job not in CONFIRMED/EN_ROUTE (status=' + job.status + ')' });
  }
  var newStatus = (job.status === 'CONFIRMED') ? 'EN_ROUTE' : 'IN_PROGRESS';
  var actualStart = e.parameter.actual_start || new Date().toISOString();
  if (newStatus === 'IN_PROGRESS') _setJobField(ss, s.payload.tid, jobId, 'actual_start', actualStart);
  _setJobField(ss, s.payload.tid, jobId, 'status', newStatus);
  _appendJobEvent(ss, jobId, s.payload.uid, 'status_change', job.status, newStatus, '{}');
  _logAudit('job.' + newStatus.toLowerCase(), s.payload.tid, s.payload.uid, jobId);
  return _json({ ok:true, status:newStatus });
}
function apiCompleteJob(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var p = e.parameter || {};
  if (!p.job_id) return _json({ ok:false, error:'job_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _findJob(ss, s.payload.tid, p.job_id);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);
  if (job.status !== 'IN_PROGRESS' && job.status !== 'EN_ROUTE') {
    return _json({ ok:false, error:'Job not in IN_PROGRESS/EN_ROUTE (status=' + job.status + ')' });
  }
  var actualEnd = p.actual_end || new Date().toISOString();
  _setJobField(ss, s.payload.tid, p.job_id, 'actual_end', actualEnd);
  // Compute billable_minutes if actual_start exists
  var startStr = job.actual_start || job.scheduled_start;
  if (startStr) {
    var mins = Math.max(0, Math.round((new Date(actualEnd).getTime() - new Date(startStr).getTime()) / 60000));
    // Apply 2-hr minimum from Settings if present
    var minHours = Number(_getSetting(ss, 'rate_card.minimum.medical.hours') || 2);
    mins = Math.max(mins, minHours * 60);
    // Update billable_minutes on the assignment row if there's a claimed one
    _setAssignmentField(ss, p.job_id, 'billable_minutes', mins);
  }
  _setJobField(ss, s.payload.tid, p.job_id, 'status', 'COMPLETED');
  _appendJobEvent(ss, p.job_id, s.payload.uid, 'status_change', job.status, 'COMPLETED', JSON.stringify({ actual_end:actualEnd }));
  _logAudit('job.complete', s.payload.tid, s.payload.uid, p.job_id);
  return _json({ ok:true, status:'COMPLETED' });
}

function _transitionJob(e, allowedFrom, toStatus, eventType) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  if (!jobId) return _json({ ok:false, error:'job_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _findJob(ss, s.payload.tid, jobId);
  if (!job) return _json({ ok:false, error:'Job not found' }, 404);
  if (allowedFrom.indexOf(job.status) < 0) {
    return _json({ ok:false, error:'Cannot transition from ' + job.status + ' to ' + toStatus });
  }
  _setJobField(ss, s.payload.tid, jobId, 'status', toStatus);
  _appendJobEvent(ss, jobId, s.payload.uid, eventType || 'status_change', job.status, toStatus, '{}');
  _logAudit('job.' + toStatus.toLowerCase(), s.payload.tid, s.payload.uid, jobId);
  return _json({ ok:true, status:toStatus });
}

function _setJobField(ss, tenantId, jobId, field, value) {
  var sh = ss.getSheetByName(T.Jobs);
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iJob = hdr.indexOf('job_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iField = hdr.indexOf(field);
  var iUpdated = hdr.indexOf('_updated_at');
  var iRev = hdr.indexOf('_rev');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iJob]) === jobId && String(data[r][iTenant]) === tenantId) {
      if (iField >= 0) sh.getRange(r + 1, iField + 1).setValue(value);
      if (iUpdated >= 0) sh.getRange(r + 1, iUpdated + 1).setValue(new Date().toISOString());
      if (iRev >= 0) sh.getRange(r + 1, iRev + 1).setValue(Number(data[r][iRev] || 0) + 1);
      return true;
    }
  }
  return false;
}

function _setAssignmentField(ss, jobId, field, value) {
  var sh = ss.getSheetByName(T.JobAssignments);
  if (!sh) return false;
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iJob = hdr.indexOf('job_id');
  var iField = hdr.indexOf(field);
  var iResp = hdr.indexOf('response');
  if (iField < 0) return false;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iJob]) === jobId && String(data[r][iResp]) === 'claim') {
      sh.getRange(r + 1, iField + 1).setValue(value);
      return true;
    }
  }
  return false;
}

function _findInterpreter(ss, tenantId, interpreterId) {
  var sh = ss.getSheetByName(T.Interpreters);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id === tenantId && o.interpreter_id === interpreterId) return o;
  }
  return null;
}

function _resolveInterpreterEmail(ss, interp) {
  // Look up the linked User row by user_id; fall back to a notes_internal email if present.
  if (interp.user_id) {
    var user = _lookupUserById(ss, interp.user_id);
    if (user && user.email) return user.email;
  }
  return '';
}

function _getSetting(ss, key) {
  var sh = ss.getSheetByName(T.Settings);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var iKey = hdr.indexOf('key');
  var iValue = hdr.indexOf('value');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iKey]) === key) return data[i][iValue];
  }
  return null;
}

function _ratePerHour(ss, serviceType) {
  var key = 'rate_card.' + serviceType + '.on-site.solo.hourly_cents';
  var v = _getSetting(ss, key);
  if (v) return Number(v);
  return 9500;
}

function _formatLocalTime(iso, tz) {
  if (!iso) return '—';
  try {
    return Utilities.formatDate(new Date(iso), tz, 'EEE MMM d · h:mm a zzz');
  } catch (_) { return iso; }
}

// ============================================================================
// LISTING HELPERS — assignments / job_events / communications
// ============================================================================

function apiListAssignments(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.JobAssignments);
  if (!sh) return _json({ ok:true, assignments:[] });
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, assignments:[] });
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (jobId && o.job_id !== jobId) continue;
    out.push(o);
  }
  return _json({ ok:true, assignments: out });
}

function apiListJobEvents(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  if (!jobId) return _json({ ok:false, error:'job_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.JobEvents);
  if (!sh) return _json({ ok:true, events:[] });
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, events:[] });
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.job_id !== jobId) continue;
    out.push(o);
  }
  return _json({ ok:true, events: out });
}

function apiListCommunications(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var jobId = e.parameter.job_id;
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.Communications);
  if (!sh) return _json({ ok:true, comms:[] });
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return _json({ ok:true, comms:[] });
  var hdr = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.tenant_id !== s.payload.tid) continue;
    if (jobId && o.job_id !== jobId) continue;
    out.push(o);
  }
  return _json({ ok:true, comms: out });
}

function _logCommunication(ss, tenantId, channel, direction, templateId, toUserId, toAddr, status, provider, jobId) {
  _ensureTab(ss, T.Communications, _tenantSchema().Communications);
  var sh = ss.getSheetByName(T.Communications);
  var now = new Date().toISOString();
  sh.appendRow([
    _ulid('c'), tenantId, channel, direction, templateId, toUserId, toAddr, '',
    status, provider, '', jobId, now, now
  ]);
}

// ============================================================================
// AI INTAKE — natural-language email → structured Job draft via Claude API
// ============================================================================
//
// Reads the Anthropic API key from Script Properties (key: ANTHROPIC_API_KEY)
// or the gitignored anthropic-secret.gs runtime constant — NEVER from the Sheet
// (a plaintext key in Settings 'anthropic.api_key' was a credential leak, removed
// 2026-06-01). Returns parsed fields ready for apiCreateJob. PHI redaction runs
// BEFORE the model call.

function apiTestAnthropic(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var key = _anthropicKey();
  if (!key) return _json({ ok:false, configured:false, message:'No Anthropic API key configured. Set it under Settings.' });
  // Test with a tiny call — minimum tokens
  try {
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Say "ok".' }]
      })
    });
    var code = res.getResponseCode();
    var body = res.getContentText();
    return _json({ ok:true, configured:true, status_code:code, sample: body.slice(0, 200) });
  } catch (err) {
    return _json({ ok:false, configured:true, error:String(err) });
  }
}

// Rate-limit ceilings for AI intake (sliding 1-hour window via CacheService).
var AI_INTAKE_PER_USER_PER_HOUR   = 30;
var AI_INTAKE_PER_TENANT_PER_HOUR = 200;
var AI_INTAKE_MAX_INPUT_BYTES     = 8192; // ~8KB of free-text intake

function apiAiIntake(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var raw = e.parameter.text || '';
  if (!raw) return _json({ ok:false, error:'text required' });

  // Input cap — defense against accidental large pastes / abuse
  var inputBytes = Utilities.newBlob(raw).getBytes().length;
  if (inputBytes > AI_INTAKE_MAX_INPUT_BYTES) {
    return _json({ ok:false, error:'Intake text exceeds ' + AI_INTAKE_MAX_INPUT_BYTES + ' bytes; trim and resubmit.' });
  }

  // Rate-limit (sliding 1-hour window) — per user and per tenant
  var rl = _aiIntakeRateCheck_(s.payload.tid, s.payload.uid);
  if (!rl.ok) {
    _logAudit('ai_intake_rate_limit', s.payload.tid, s.payload.uid, rl.scope + ' usage=' + rl.usage + '/' + rl.cap);
    return _json({
      ok:false,
      error:'Rate limit hit (' + rl.scope + '): ' + rl.usage + '/' + rl.cap + ' this hour. Try again later.',
      rate_limit: rl
    }, 429);
  }

  var r = _aiIntakeParse_(s.payload.tid, raw);
  if (!r.ok) {
    _logAudit('ai_intake_error', s.payload.tid, s.payload.uid, r.status ? ('status=' + r.status) : String(r.error));
    return _json({ ok:false, error: r.error, raw: r.raw, body: r.body }, r.status === 429 ? 429 : 200);
  }
  // Audit (hashes only — no PHI in the audit body)
  _logAudit('ai_intake', s.payload.tid, s.payload.uid, 'in=' + r.inHash + ' out=' + r.outHash + ' redacted=' + r.redaction.replacements);
  return _json({
    ok: true,
    parsed: r.parsed,
    redaction_summary: r.redaction,
    input_hash: r.inHash,
    output_hash: r.outHash
  });
}

// Shared intake parse core — used by apiAiIntake (the app's paste box) AND the
// inbound-email processor (Code_EmailIntake.gs). Redacts PHI, calls the model,
// returns the structured draft. No session / audit / rate-limit here — callers
// own those (the email processor has no session).
function _aiIntakeParse_(tenantId, raw) {
  var key = _anthropicKey();
  if (!key) return { ok:false, error:'No Anthropic API key configured.' };

  var redacted = _redactForModel(raw);
  var sys = [
    'You are a structured-data extractor for an interpreting agency.',
    'Given a free-text request from a requestor (front-desk staff, 504 coordinator, court clerk, etc.),',
    'extract job-intake fields as JSON. Return ONLY valid JSON, no prose.',
    '',
    'Output shape:',
    '{',
    '  "service_type": "medical|mental-health|legal|education|gov|corporate|community|translation",',
    '  "modality": "on-site|VRI|OPI",',
    '  "source_language_id": "en-US|ASL|es-419|cmn-CN|ar-MSA|ht|fr|ko|ru|vi|so|am|fa|ps|pt-BR|yue-HK",',
    '  "target_language_id": "(same set)",',
    '  "scheduled_start_iso": "YYYY-MM-DDTHH:MM:SS (or empty if unclear)",',
    '  "scheduled_end_iso":   "YYYY-MM-DDTHH:MM:SS (or empty)",',
    '  "team_config": "solo|team-of-2|cdi+hearing|voicer+signer|cart-solo",',
    '  "notes_to_interpreter": "(brief; no PHI; if the source includes patient names, diagnoses, or MRN, replace with [REDACTED])",',
    '  "confidence_per_field": { "service_type": 0.0-1.0, ... },',
    '  "ambiguities": ["string"]',
    '}',
    'Tenant timezone: America/New_York. If the source says "Thursday 2pm" without a date, return empty start/end and add a string to ambiguities.',
    'For signed-language requests use ASL as the target language and the relevant spoken language as the source.',
    'Never invent dates or facts.'
  ].join('\n');

  try {
    // One retry on 5xx with 500ms pause — defensive against transient upstream issues.
    var fetchOpts = {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: 'tenant_id: ' + tenantId + '\n\n' + sys,
        messages: [{ role: 'user', content: redacted.text }]
      })
    };
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', fetchOpts);
    var code = res.getResponseCode();
    if (code >= 500 && code < 600) {
      Utilities.sleep(500);
      res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', fetchOpts);
      code = res.getResponseCode();
    }
    var bodyTxt = res.getContentText();
    if (code !== 200) return { ok:false, error:'Anthropic returned ' + code, status: code, body: bodyTxt.slice(0, 400) };

    var resp = JSON.parse(bodyTxt);
    var content = (resp.content && resp.content[0] && resp.content[0].text) || '{}';
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    var parsed;
    try { parsed = JSON.parse(content); }
    catch (_) { return { ok:false, error:'Model returned unparseable JSON', raw: content.slice(0, 600) }; }

    return {
      ok: true,
      parsed: parsed,
      redaction: { replacements: redacted.replacements, kinds: redacted.kinds },
      inHash: _sha256Hex(raw).slice(0, 16),
      outHash: _sha256Hex(content).slice(0, 16)
    };
  } catch (err) {
    return { ok:false, error:String(err) };
  }
}

function _anthropicKey() {
  // 1) Script Property override (ops-managed); 2) the gitignored runtime constant
  // in anthropic-secret.gs (_anthropicKeyValue_, mirrors the d1-secret.gs pattern —
  // pushed to the editor by clasp, never committed). The legacy Settings-tab
  // fallback (_getSetting 'anthropic.api_key') was REMOVED 2026-06-01: storing a
  // live key in the Sheet exposed it to anyone with Sheet access and leaked it into
  // D1 via the ADR-001 dual-write. The key now lives only in a Worker secret +
  // this constant — never in the Sheet, never in git.
  var k = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (k) return k;
  if (typeof _anthropicKeyValue_ === 'function') {
    try { return _anthropicKeyValue_() || ''; } catch (_) {}
  }
  return '';
}

// Sliding 1-hour rate-limit check for AI intake. CacheService TTL is 1 hour;
// we store per-(user|tenant) counters and treat any cache miss as zero. Returns
// { ok:true } on pass; { ok:false, scope:'user'|'tenant', usage, cap } on hit.
function _aiIntakeRateCheck_(tenantId, userId) {
  try {
    var cache = CacheService.getScriptCache();
    var userKey   = 'ai_intake:u:' + (userId || 'anon');
    var tenantKey = 'ai_intake:t:' + (tenantId || 'unknown');
    var userN   = Number(cache.get(userKey)   || 0);
    var tenantN = Number(cache.get(tenantKey) || 0);
    if (userN >= AI_INTAKE_PER_USER_PER_HOUR) {
      return { ok:false, scope:'user', usage:userN, cap:AI_INTAKE_PER_USER_PER_HOUR };
    }
    if (tenantN >= AI_INTAKE_PER_TENANT_PER_HOUR) {
      return { ok:false, scope:'tenant', usage:tenantN, cap:AI_INTAKE_PER_TENANT_PER_HOUR };
    }
    cache.put(userKey,   String(userN + 1),   3600);
    cache.put(tenantKey, String(tenantN + 1), 3600);
    return { ok:true, user_usage:userN + 1, tenant_usage:tenantN + 1 };
  } catch (_) {
    // Cache failure → fail open (don't block the user on Apps Script Cache issues)
    return { ok:true, user_usage:-1, tenant_usage:-1 };
  }
}

function _redactForModel(text) {
  // PHI scrubber. Returns { text, replacements, kinds }.
  // We intentionally over-redact; the model only needs structural intent.
  var kinds = {};
  var n = 0;
  function rep(re, token, kind) {
    var m;
    var out = text;
    while ((m = re.exec(text)) !== null) { kinds[kind] = (kinds[kind] || 0) + 1; n++; }
    out = text.replace(re, token);
    return out;
  }
  // SSN
  text = text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, function () { kinds.ssn = (kinds.ssn || 0) + 1; n++; return '[SSN]'; });
  // MRN-like long digit runs
  text = text.replace(/\b\d{8,12}\b/g, function () { kinds.mrn = (kinds.mrn || 0) + 1; n++; return '[ID]'; });
  // Phone (US-ish)
  text = text.replace(/(\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, function () { kinds.phone = (kinds.phone || 0) + 1; n++; return '[PHONE]'; });
  // DOB-like dates
  text = text.replace(/\b(0?[1-9]|1[0-2])[\/\-](0?[1-9]|[12]\d|3[01])[\/\-](19|20)\d{2}\b/g, function () { kinds.dob = (kinds.dob || 0) + 1; n++; return '[DATE]'; });
  // Email
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, function () { kinds.email = (kinds.email || 0) + 1; n++; return '[EMAIL]'; });
  // Names heuristic (capitalized two-word sequences preceded by patient/Mr/Mrs/Ms/Dr)
  text = text.replace(/\b(patient|Mr\.?|Mrs\.?|Ms\.?|Dr\.?)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g,
    function (match) { kinds.name_pattern = (kinds.name_pattern || 0) + 1; n++; return match.split(/\s+/)[0] + ' [NAME]'; });
  // Clinical red-flags — keep the term but flag in audit
  if (/\b(diagnosis|HIV|cancer|chemotherapy|psychiatric|MRN)\b/i.test(text)) {
    kinds.clinical_term_flagged = (kinds.clinical_term_flagged || 0) + 1;
  }
  return { text: text, replacements: n, kinds: kinds };
}

// ============================================================================
// BOOTSTRAP — one-shot tenant schema build
// ============================================================================

function apiBootstrap(e) {
  // Admin-gated. For v1: token must equal HMAC secret prefix or session role=role_owner.
  var s = _requireSession(e);
  var canBootstrap = false;
  if (s.ok && s.payload.role === 'role_owner') canBootstrap = true;
  // Allow bootstrap when there are no users yet (initial setup)
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var userSheet = ss.getSheetByName(T.Users);
  if (!userSheet || userSheet.getLastRow() < 2) canBootstrap = true;
  if (!canBootstrap) return _json({ ok:false, error:'Not authorized.' }, 403);

  var report = bootstrapHostTenant();
  return _json({ ok:true, report:report });
}

function bootstrapHostTenant() {
  // Idempotent: builds the canonical 21-tab schema, seeds Roles, Languages,
  // Certifications, and ensures the host Agency + Anthony's owner User row.
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var schema = _tenantSchema();
  var report = { created: [], existed: [], seeded: {} };

  Object.keys(schema).forEach(function (tabName) {
    var sh = ss.getSheetByName(tabName);
    if (!sh) {
      sh = ss.insertSheet(tabName);
      sh.appendRow(schema[tabName]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, schema[tabName].length).setFontWeight('bold');
      report.created.push(tabName);
    } else {
      report.existed.push(tabName);
    }
  });

  // Seed Roles
  _seedRoles(ss);
  report.seeded.Roles = ss.getSheetByName(T.Roles).getLastRow() - 1;

  // Seed Languages
  var langSheet = ss.getSheetByName(T.Languages);
  if (langSheet.getLastRow() < 2) {
    var langs = [
      ['ASL','American Sign Language','signed','["bi","voice-only","sign-only"]','["Black ASL","PSE","Contact"]','Sgnw',false],
      ['PSE','Pidgin Signed English','signed','["bi"]','[]','Sgnw',false],
      ['en-US','English (US)','spoken','["bi","voice-only"]','[]','Latn',false],
      ['es-419','Spanish (Latin American)','spoken','["bi","voice-only"]','["es-MX","es-PR","es-DR","es-CL"]','Latn',false],
      ['es-ES','Spanish (Spain)','spoken','["bi"]','[]','Latn',false],
      ['cmn-CN','Mandarin (Simplified)','spoken','["bi","voice-only"]','[]','Hans',false],
      ['yue-HK','Cantonese','spoken','["bi","voice-only"]','[]','Hant',false],
      ['ar-MSA','Arabic (Modern Standard)','spoken','["bi","voice-only"]','["ar-EG","ar-LV","ar-MR"]','Arab',true],
      ['ht','Haitian Creole','spoken','["bi"]','[]','Latn',false],
      ['vi','Vietnamese','spoken','["bi"]','[]','Latn',false],
      ['ko','Korean','spoken','["bi"]','[]','Kore',false],
      ['ru','Russian','spoken','["bi"]','[]','Cyrl',false],
      ['fr','French','spoken','["bi"]','["fr-CA","fr-HT"]','Latn',false],
      ['so','Somali','spoken','["bi"]','[]','Latn',false],
      ['am','Amharic','spoken','["bi"]','[]','Ethi',false],
      ['fa','Farsi (Persian)','spoken','["bi"]','["fa-AF (Dari)"]','Arab',true],
      ['ps','Pashto','spoken','["bi"]','[]','Arab',true],
      ['pt-BR','Portuguese (Brazil)','spoken','["bi"]','[]','Latn',false],
      ['ProTactile','ProTactile ASL','signed','["bi"]','[]','Sgnw',false],
      ['CDI','Certified Deaf Interpreter (relay role)','signed','["bi"]','[]','Sgnw',false]
    ];
    var ts = new Date().toISOString();
    langs.forEach(function (l) { langSheet.appendRow(l.concat([ts, ts])); });
  }
  report.seeded.Languages = langSheet.getLastRow() - 1;

  // Seed Certifications
  var certSheet = ss.getSheetByName(T.Certifications);
  if (certSheet.getLastRow() < 2) {
    var certs = [
      ['NIC','RID','National Interpreter Certification','["ASL"]',true,true],
      ['CDI','RID','Certified Deaf Interpreter','["ASL","ProTactile"]',true,true],
      ['NIC-Advanced','RID','NIC Advanced','["ASL"]',true,true],
      ['NIC-Master','RID','NIC Master','["ASL"]',true,true],
      ['BEI-Basic','BEI','BEI Basic','["ASL"]',true,true],
      ['BEI-Advanced','BEI','BEI Advanced','["ASL"]',true,true],
      ['BEI-Master','BEI','BEI Master','["ASL"]',true,true],
      ['SC:L','RID','Specialist Certificate: Legal','["ASL"]',true,true],
      ['EIPA-3.5','EIPA','EIPA Level 3.5','["ASL"]',true,true],
      ['EIPA-4.0','EIPA','EIPA Level 4.0','["ASL"]',true,true],
      ['CCHI-CHI','CCHI','Certified Healthcare Interpreter','["*"]',true,true],
      ['NBCMI','NBCMI','National Board Certified Medical Interpreter','["*"]',true,true],
      ['CMI-Spanish','NBCMI','Certified Medical Interpreter — Spanish','["es-419","es-ES"]',true,true],
      ['ATA','ATA','American Translators Association certified','["*"]',true,true],
      ['FCICE','FCICE','Federal Court Interpreter Certification','["*"]',true,true],
      ['CRC-NCRA','NCRA','Certified Realtime Captioner','["en-US"]',true,true],
      ['MD-Court-Cert','State of MD','Maryland Court Interpreter','["*"]',true,true]
    ];
    var ts2 = new Date().toISOString();
    certs.forEach(function (c) { certSheet.appendRow(c.concat([ts2, ts2])); });
  }
  report.seeded.Certifications = certSheet.getLastRow() - 1;

  // Ensure host Agencies row + owner User
  _ensureHostOwner(ss);
  report.host_owner = 'anthonymowl@gmail.com';

  // Seed Settings defaults
  var settingsSheet = ss.getSheetByName(T.Settings);
  if (settingsSheet.getLastRow() < 2) {
    var ts3 = new Date().toISOString();
    var defaults = [
      ['cancellation_policy.late_window_hours', '24', 'cancellation-policy'],
      ['cancellation_policy.no_show_minutes', '15', 'cancellation-policy'],
      ['rate_card.medical.on-site.solo.hourly_cents', '9500', 'rate-card'],
      ['rate_card.legal.on-site.solo.hourly_cents', '12500', 'rate-card'],
      ['rate_card.education.on-site.solo.hourly_cents', '8500', 'rate-card'],
      ['rate_card.translation.per_word_cents', '20', 'rate-card'],
      ['rate_card.minimum.medical.hours', '2.0', 'rate-card'],
      ['terminology.consumer', 'consumer', 'terminology'],
      ['terminology.requestor', 'requestor', 'terminology']
    ];
    defaults.forEach(function (d) {
      settingsSheet.appendRow([d[0], d[1], d[2], '', ts3, ts3, ts3]);
    });
  }
  report.seeded.Settings = settingsSheet.getLastRow() - 1;

  _logAudit('tenant.bootstrap', 'host', 'system', JSON.stringify(report));
  return report;
}

// ============================================================================
// SCHEMA DEFINITIONS — column lists for every tab
// ============================================================================

function _tenantSchema() {
  return {
    Agencies: ['tenant_id','legal_name','tax_id_last4','tier','phi_mode','timezone','primary_owner_user_id','logo_r2_key','brand_color','billing_email','_created_at','_updated_at'],
    Users: ['user_id','tenant_id','email','phone_e164','display_name','role_id','interpreter_id','status','mfa_enabled','webauthn_credential_ids','last_login_at','pii_scope','failed_login_count','sso_subject','calendar_token','_created_at','_updated_at'],
    Roles: ['role_id','tenant_id','display_name','permissions','can_break_glass','max_pii_scope','_created_at','_updated_at'],
    Interpreters: ['interpreter_id','tenant_id','user_id','classification','legal_first','legal_last','pronouns','home_city','home_state','home_zip','service_radius_mi','has_vehicle','modalities','languages','certifications','skills','rate_card_id','min_call_hours','availability_prefs','availability_doc_id','payment_method','payment_details_encrypted','w9_doc_id','coi_doc_id','background_check_at','deaf','notes_internal','status','rid_member_number','bei_member_number','other_member_numbers','pay_rate_floors','cancellation_floors','evening_premium_pct','weekend_premium_pct','last_minute_premium_pct','holiday_premium_pct','mileage_rate_cents','travel_time_rate_cents','specialty_endorsements','availability_windows','onboarding_completed_at','_created_at','_updated_at','_rev'],
    Interpreter_Documents: ['doc_id','tenant_id','interpreter_id','doc_type','doc_name','status','required','issued_at','expires_at','reviewer_user_id','reviewed_at','file_r2_key','sha256','notes','_created_at','_updated_at'],
    Tenant_Requirements: ['req_id','tenant_id','applies_to_service_type','applies_to_modality','doc_type','display_name','required','reminder_days','renewal_period_months','notes','_created_at','_updated_at'],
    Rate_Modifiers: ['modifier_id','tenant_id','side','kind','name','trigger','modifier_pct','modifier_cents','applies_to_service_type','applies_to_modality','priority','status','notes','_created_at','_updated_at'],
    Rate_Cards: ['rate_card_id','tenant_id','side','service_type','modality','team_config','base_hourly_cents','minimum_hours','rounding_minutes','notes','_created_at','_updated_at'],
    Notification_Prefs: ['pref_id','tenant_id','user_id','event_type','channel','mode','phone_e164','daily_digest_hour','weekly_digest_day','quiet_hours','_created_at','_updated_at'],
    Assignment_Notes: ['note_id','tenant_id','assignment_id','job_id','author_user_id','author_role','body','visibility','_created_at'],
    Languages: ['language_id','display_name','family','directionalities','dialects','script','rtl','_created_at','_updated_at'],
    Certifications: ['certification_id','body','display_name','applies_to_languages','renewable','ceu_required','_created_at','_updated_at'],
    Requestors: ['requestor_id','tenant_id','client_id','display_name','type','parent_org_id','billing_payer_id','default_location_id','default_specialist_id','contract_doc_id','po_required','notes','status','_created_at','_updated_at','_rev'],
    Requestor_Contacts: ['contact_id','requestor_id','tenant_id','user_id','first','last','email','phone_e164','title','preferred_channel','status','_created_at','_updated_at'],
    Clients: ['client_id','tenant_id','legal_name','display_name','client_type','industry','primary_owner_contact_id','primary_payer_id','billing_address','billing_email','billing_phone','tax_exempt','tax_id_last4','net_terms','contract_doc_id','notes','status','_created_at','_updated_at','_rev'],
    Client_Contacts: ['contact_id','client_id','tenant_id','user_id','role_on_client','first','last','email','phone_e164','title','department','preferred_channel','status','_created_at','_updated_at'],
    Specialists: ['specialist_id','client_id','tenant_id','display_name','department','specialty_code','npi','default_location_id','default_modality_pref','notes','status','_created_at','_updated_at'],
    Client_Billing_Rules: ['rule_id','client_id','tenant_id','consolidation_mode','billing_cycle','statement_day_of_month','requires_po','po_format_regex','gl_template','invoice_format','split_by_location','split_by_specialist','show_consumer_initials_on_invoice','show_specialist_on_invoice','show_interpreter_name_on_invoice','rounding_minutes','minimum_invoice_cents','late_fee_pct','notes','status','_created_at','_updated_at'],
    Job_Expenses: ['expense_id','tenant_id','job_id','assignment_id','interpreter_id','expense_type','quantity','unit','rate_cents','amount_cents','description','receipt_r2_key','receipt_filename','receipt_mime','submitted_at','status','approved_by_user_id','approved_at','rejected_reason','payout_id','_created_at','_updated_at','_rev'],
    Client_Documents: ['doc_id','client_id','tenant_id','doc_type','title','filename','mime','size_bytes','drive_file_id','uploaded_by_user_id','uploaded_at','effective_date','expires_at','status','notes','sha256','_created_at','_updated_at','_rev'],
    Payers: ['payer_id','tenant_id','display_name','billing_email','billing_address','net_terms','tax_exempt','stripe_customer_id','qb_customer_id','status','_created_at','_updated_at'],
    Consumers: ['consumer_id','tenant_id','display_initials','legal_first_encrypted','legal_last_encrypted','dob_encrypted','mrn_encrypted','primary_language_id','dialect','communication_prefs','notes_sealed','do_not_contact','consent_recording_default','created_by_user_id','deletion_requested_at','_created_at','_updated_at'],
    Locations: ['location_id','tenant_id','requestor_id','display_name','street','city','state','zip','timezone','parking_notes','accessibility_notes','geo','modalities_supported','_created_at','_updated_at'],
    Jobs: ['job_id','tenant_id','client_id','requestor_id','requestor_contact_id','payer_id','location_id','specialist_id','consumer_id','modality','service_type','source_language_id','target_language_id','team_config','scheduled_start','scheduled_end','actual_start','actual_end','status','on_demand','reference_no','po_number','notes_to_interpreter','consent_recording','recording_r2_key','transcript_r2_key','created_via','ai_intake_id','rate_applied','cancellation_reason','cancellation_at','cancellation_bill_cents','cancellation_pay_cents','invoice_id','interpreter_signoff_at','interpreter_signoff_notes','closeout_divergence_pct','closeout_disputed_at','closeout_disputed_by','closeout_dispute_reason','_created_at','_updated_at','_rev'],
    Job_Assignments: ['assignment_id','job_id','interpreter_id','role_on_job','offered_at','responded_at','response','pay_rate_snapshot','billable_minutes','status','_created_at','_updated_at','_rev'],
    Job_Events: ['event_id','job_id','actor_user_id','event_type','from_state','to_state','payload','ts'],
    Communications: ['comm_id','tenant_id','channel','direction','template_id','to_user_id','to_address','body_redacted_r2_key','status','provider','provider_msg_id','job_id','_created_at','_updated_at'],
    Invoices: ['invoice_id','tenant_id','client_id','payer_id','invoice_number','period_start','period_end','issued_at','due_at','net_terms','subtotal_cents','tax_cents','total_cents','status','po_number','consolidation_mode','split_group_key','statement_descriptor','stripe_invoice_id','pdf_r2_key','sent_at','paid_at','voided_at','notes','_created_at','_updated_at'],
    Invoice_Lines: ['line_id','invoice_id','job_id','line_kind','client_id','requestor_id','location_id','specialist_id','consumer_initials','interpreter_id','interpreter_name','service_type','modality','scheduled_start','scheduled_end','description','quantity','unit','rate_cents','amount_cents','sort_order','_created_at','_updated_at'],
    Payouts: ['payout_id','tenant_id','interpreter_id','period_start','period_end','issued_at','total_cents','status','stripe_transfer_id','_created_at','_updated_at'],
    Documents: ['document_id','tenant_id','kind','r2_key','mime','sha256','size_bytes','linked_job_id','linked_interpreter_id','linked_consumer_id','uploaded_by_user_id','signed_url_expiry_default','retention_class','_created_at','_updated_at'],
    Settings: ['key','value','category','updated_by_user_id','updated_at','_created_at','_updated_at'],
    Audit_Log: ['audit_id','tenant_id','ts','user_id','ip','user_agent','action','record_type','record_id','purpose_of_use','result','jti','prev_seal','seal']
  };
}

// ============================================================================
// UTILITIES
// ============================================================================

function _ensureTab(ss, name, headers) {
  return _getOrCreateSheet(ss, name, headers);
}

function _getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

function _rowToObj(hdr, row) {
  var o = {};
  for (var i = 0; i < hdr.length; i++) o[hdr[i]] = row[i];
  return o;
}

function _ulid(prefix) {
  // Not RFC-strict ULID but functionally similar: ms timestamp (base32) + 8 random base32.
  var ts = Date.now().toString(32);
  var rand = '';
  var alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  for (var i = 0; i < 10; i++) rand += alphabet.charAt(Math.floor(Math.random() * 32));
  return (prefix || '') + '_' + ts.toUpperCase() + rand;
}

// ----------------------------------------------------------------------------
// Tamper-evident audit chain.
//
// Each Audit_Log row is sealed to the one physically before it: its `seal` is a
// keyed HMAC over (the prior row's seal) + (this row's content columns). Edit,
// delete, or reorder any sealed row and every recomputed seal from that point
// on diverges — apiVerifyAuditChain catches the first break. The seal key is the
// server-held HMAC_SECRET, so a seal can't be forged without script access. This
// is what backs the security-page "sealed to the one before it" claim; the chain
// is global over the physical append order (strongest deletion-detection), and
// verification runs server-side with full-sheet access.
//
// `ts` and the two seal columns are forced to plain-text number-format so the
// Sheet never coerces the ISO string into a Date (which would lose sub-second
// precision and silently break the chain on read-back).
// ----------------------------------------------------------------------------

var _AUDIT_SEAL_SEP = '';  // unit separator — can't appear in our values

function _auditTs_(v) {
  // Normalize a ts cell to the exact ISO string that was sealed, whether the
  // Sheet handed it back as a String or coerced it to a Date.
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  return v == null ? '' : String(v);
}

function _auditCanonical_(row) {
  // The 12 content columns, in schema order. Excludes prev_seal/seal.
  return [
    row.audit_id, row.tenant_id, _auditTs_(row.ts), row.user_id,
    row.ip, row.user_agent, row.action, row.record_type,
    row.record_id, row.purpose_of_use, row.result, row.jti
  ].map(function (x) { return x == null ? '' : String(x); }).join(_AUDIT_SEAL_SEP);
}

function _auditSeal_(prevSeal, row) {
  return _hmacB64Url(String(prevSeal || '') + _AUDIT_SEAL_SEP + _auditCanonical_(row));
}

function _ensureAuditColumns_(sheet, headers) {
  // Add any newly-introduced header cells (e.g. prev_seal/seal) to an existing
  // tab, and pin ts + seal columns to plain text so values round-trip exactly.
  var lastCol = sheet.getLastColumn();
  if (lastCol < headers.length) {
    sheet.getRange(1, lastCol + 1, 1, headers.length - lastCol)
         .setValues([headers.slice(lastCol)])
         .setFontWeight('bold');
  }
  var maxRows = sheet.getMaxRows();
  ['ts', 'prev_seal', 'seal'].forEach(function (name) {
    var c = headers.indexOf(name);
    if (c >= 0) sheet.getRange(1, c + 1, maxRows, 1).setNumberFormat('@');
  });
}

function _lastAuditSeal_(sheet, headers) {
  var last = sheet.getLastRow();
  if (last < 2) return '';  // header only
  var sealCol = headers.indexOf('seal') + 1;
  if (sealCol < 1) return '';
  var v = sheet.getRange(last, sealCol).getValue();
  return v ? String(v) : '';
}

function _logAudit(action, tenantId, userId, detail) {
  var lock = LockService.getScriptLock();
  var haveLock = false;
  try { haveLock = lock.tryLock(8000); } catch (_) { /* proceed best-effort */ }
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var headers = _tenantSchema().Audit_Log;
    var sheet = _getOrCreateSheet(ss, T.Audit_Log, headers);
    _ensureAuditColumns_(sheet, headers);
    var prevSeal = _lastAuditSeal_(sheet, headers);
    var row = {
      audit_id: _ulid('au'),
      tenant_id: tenantId || '',
      ts: new Date().toISOString(),
      user_id: userId || '',
      ip: '',
      user_agent: '',
      action: action,
      record_type: '',
      record_id: detail || '',
      purpose_of_use: '',
      result: 'allow',
      jti: ''
    };
    var seal = _auditSeal_(prevSeal, row);
    sheet.appendRow([
      row.audit_id, row.tenant_id, row.ts, row.user_id,
      row.ip, row.user_agent, row.action, row.record_type,
      row.record_id, row.purpose_of_use, row.result, row.jti,
      prevSeal, seal
    ]);
  } catch (_) { /* non-fatal */ }
  finally { if (haveLock) { try { lock.releaseLock(); } catch (_) {} } }
}

function _json(obj, status) {
  // Apps Script web apps can't set HTTP status codes; we encode it in the body.
  if (status && status !== 200) obj._status = status;
  // JSONP support — if a `callback` query param is set on the current request,
  // wrap the JSON in callback(...). Browsers reading our response via <script> tag
  // (the only cross-origin readable way out of Apps Script without CORS headers)
  // need this. We stash the callback in a script-property at the start of doGet.
  var cb = _currentCallback();
  if (cb) {
    return ContentService
      .createTextOutput(cb + '(' + JSON.stringify(obj) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Per-request callback name, threaded through globals because Apps Script's
// ContentService doesn't expose request context to helpers. Cleared at end.
var _CB_HOLDER = { name: null };
function _setCallback(name) { _CB_HOLDER.name = name || null; }
function _currentCallback() { return _CB_HOLDER.name; }

// ============================================================================
// MANUAL TEST HELPERS (run from the Apps Script editor)
// ============================================================================

function _smokeTest() {
  Logger.log(_serviceInfo().getContent());
}

function runBootstrap() {
  // Editor-runnable wrapper for the bootstrap.
  var report = bootstrapHostTenant();
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

// One-shot HMAC rotation endpoint — call once to sync secret with the Cloudflare Worker.
// Gated by knowledge of the Sheet ID (Anthony has it; nobody else does).
// This route is intentionally session-less for the bootstrap case.
function apiRotateHmac(e) {
  var setup = e.parameter.setup;
  if (setup !== SHEET_ID) return _json({ ok:false, error:'Forbidden' }, 403);
  var newSecret = e.parameter.new;
  if (!newSecret || newSecret.length < 32) return _json({ ok:false, error:'new param required (>=32 chars)' });
  PropertiesService.getScriptProperties().setProperty('HMAC_SECRET', newSecret);
  _logAudit('hmac.rotate', 'host', 'system', '');
  return _json({ ok:true, message:'Rotated. All existing sessions invalidated; sign in again.' });
}

// Debug: report mail quota + recent auth-related audit log entries.
// Owner-only via session, but we also allow setup= for bootstrap parity.
function apiMailDebug(e) {
  var setup = e.parameter.setup;
  var s = _requireSession(e);
  var authed = (s.ok && s.payload.role === 'role_owner') || (setup === SHEET_ID);
  if (!authed) return _json({ ok:false, error:'Forbidden' }, 403);

  var remaining = MailApp.getRemainingDailyQuota();
  var ss = SpreadsheetApp.openById(SHEET_ID);

  // Recent auth audit entries
  var auditSh = ss.getSheetByName(T.Audit_Log);
  var recent = [];
  if (auditSh && auditSh.getLastRow() >= 2) {
    var data = auditSh.getDataRange().getValues();
    var hdr = data[0];
    for (var i = Math.max(1, data.length - 50); i < data.length; i++) {
      var o = _rowToObj(hdr, data[i]);
      if (String(o.action || '').indexOf('auth') >= 0) recent.push(o);
    }
  }

  // Recent Auth_Tokens entries
  var tokensSh = ss.getSheetByName(T.AuthTokens);
  var tokens = [];
  if (tokensSh && tokensSh.getLastRow() >= 2) {
    var tData = tokensSh.getDataRange().getValues();
    var tHdr = tData[0];
    for (var j = Math.max(1, tData.length - 10); j < tData.length; j++) {
      var t = _rowToObj(tHdr, tData[j]);
      tokens.push({
        issued_at: t.issued_at,
        email: t.email,
        user_id: t.user_id,
        tenant_id: t.tenant_id,
        expires_at: t.expires_at,
        consumed_at: t.consumed_at,
        token_hash_prefix: String(t.token_hash || '').slice(0, 12)
      });
    }
  }

  return _json({
    ok: true,
    mail_quota_remaining: remaining,
    recent_auth_audit: recent.slice(-15),
    recent_tokens: tokens
  });
}
