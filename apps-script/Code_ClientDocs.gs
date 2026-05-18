// ============================================================================
// Code_ClientDocs.gs — Per-client document library
// v18.3 — May 2026
//
// Stores the legal scaffolding for an agency<>client relationship: contracts
// (MSAs), BAAs, certificates of insurance, W-9s, NDAs, agreed rate sheets.
// One row per document, tenant_id scoped, with sha256 for tamper detection
// and expires_at for auto-flagging renewal windows.
//
// The actual file bytes live in Drive under:
//   /1891 Interpreter — Client Documents/<tenant_id>/<client_id>/<doc_type>/
// (private to the Apps Script account — never shared).
//
// Audit + retention notes:
//   - status='archived' preserves the Drive file (legal docs need a paper
//     trail). Hard-delete is intentionally NOT exposed via the API.
//   - sha256 is computed at upload time so a downstream auditor can re-hash
//     the Drive blob and confirm it hasn't been tampered with.
// ============================================================================

var CD_DRIVE_FOLDER_NAME = '1891 Interpreter — Client Documents';
var CD_MAX_BYTES = 25 * 1024 * 1024; // 25 MB — legal contracts can be big
var CD_MIME_ALLOWLIST = /^(image\/(jpeg|png|gif|webp|heic|heif|tiff)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/plain)$/i;

var CD_DOC_TYPES = {
  contract:   { label: 'Contract',              description: 'Master Services Agreement / signed contract' },
  baa:        { label: 'BAA',                   description: 'Business Associate Agreement (HIPAA)' },
  msa:        { label: 'MSA',                   description: 'Master Services Agreement (alt label)' },
  insurance:  { label: 'Insurance certificate', description: 'Certificate of Insurance / COI' },
  w9:         { label: 'W-9',                   description: 'Tax W-9 form' },
  '1099':     { label: '1099',                  description: 'Issued 1099 form (kept for reference)' },
  nda:        { label: 'NDA',                   description: 'Non-disclosure agreement' },
  rate_sheet: { label: 'Rate sheet',            description: 'Agreed rate schedule' },
  other:      { label: 'Other',                 description: 'Free-form (description required)' }
};

var CD_WRITE_ROLES = ['role_owner','role_manager','role_admin','role_scheduler','role_platform_staff'];
var CD_ARCHIVE_ROLES = ['role_owner','role_manager','role_platform_staff'];

// ---------------------------------------------------------------------------
// API: upload a client document
// ---------------------------------------------------------------------------
// POST body (JSON or form):
//   client_id        (required)
//   doc_type         (required, one of CD_DOC_TYPES)
//   title            (required, ≤200 chars)
//   filename         (required)
//   mime             (required, must match CD_MIME_ALLOWLIST)
//   bytes_b64        (required, base64-encoded file contents)
//   effective_date   (optional ISO date YYYY-MM-DD)
//   expires_at       (optional ISO date YYYY-MM-DD)
//   notes            (optional, ≤1000 chars; required for doc_type='other')
// ---------------------------------------------------------------------------
function apiUploadClientDocument(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (CD_WRITE_ROLES.indexOf(s.payload.role) < 0) {
    return _json({ ok:false, error:'Scheduler / manager / owner role required to upload client documents.' }, 403);
  }
  var p = _coParams(e);

  if (!p.client_id) return _json({ ok:false, error:'client_id required' });
  if (!p.doc_type)  return _json({ ok:false, error:'doc_type required' });
  if (!p.title)     return _json({ ok:false, error:'title required' });
  if (!p.filename || !p.bytes_b64 || !p.mime) {
    return _json({ ok:false, error:'filename, mime, bytes_b64 required' });
  }

  var docType = String(p.doc_type).toLowerCase();
  if (!CD_DOC_TYPES[docType]) {
    return _json({ ok:false, error:'Unknown doc_type. Must be one of: ' + Object.keys(CD_DOC_TYPES).join(', ') });
  }
  if (!CD_MIME_ALLOWLIST.test(p.mime)) {
    return _json({ ok:false, error:'Unsupported file type. Use PDF, Word, plain text, or image.' });
  }

  var title = String(p.title).slice(0, 200);
  var notes = String(p.notes || '').slice(0, 1000);
  if (docType === 'other' && notes.trim().length < 3) {
    return _json({ ok:false, error:'doc_type=other requires a description in notes.' });
  }

  var effectiveDate = _cdValidateDate_(p.effective_date);
  if (p.effective_date && !effectiveDate) return _json({ ok:false, error:'effective_date must be ISO YYYY-MM-DD' });
  var expiresAt = _cdValidateDate_(p.expires_at);
  if (p.expires_at && !expiresAt) return _json({ ok:false, error:'expires_at must be ISO YYYY-MM-DD' });

  // Decode + size check
  var bytes;
  try {
    bytes = Utilities.base64Decode(p.bytes_b64);
  } catch (err) {
    return _json({ ok:false, error:'Invalid base64 payload' });
  }
  if (bytes.length > CD_MAX_BYTES) {
    return _json({ ok:false, error:'File too large (max 25MB)' });
  }

  // Verify the client exists in this tenant
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.Clients, _tenantSchema().Clients);
  _ensureTab(ss, T.ClientDocuments, _tenantSchema().Client_Documents);
  var client = _findRowById_(ss, T.Clients, 'client_id', p.client_id, s.payload.tid);
  if (!client) return _json({ ok:false, error:'Client not found in this tenant.' }, 404);

  // Compute sha256 for tamper detection
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  var sha256 = Utilities.base64Encode(digest);

  // Write to Drive
  var safeName = String(p.filename).replace(/[^A-Za-z0-9._\-]/g, '_').slice(0, 160);
  var blob = Utilities.newBlob(bytes, p.mime, safeName);
  var folder = _cdOrCreateFolder_(s.payload.tid, p.client_id, docType);
  var file = folder.createFile(blob);
  var driveId = file.getId();
  // Belt-and-suspenders: ensure the file is not link-shared.
  try { file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); } catch (_) {}

  // Insert the row
  var docId = _ulid('cdoc');
  var now = new Date().toISOString();
  var hdr = _tenantSchema().Client_Documents;
  var row = {
    doc_id: docId,
    client_id: p.client_id,
    tenant_id: s.payload.tid,
    doc_type: docType,
    title: title,
    filename: safeName,
    mime: p.mime,
    size_bytes: bytes.length,
    drive_file_id: driveId,
    uploaded_by_user_id: s.payload.uid || '',
    uploaded_at: now,
    effective_date: effectiveDate || '',
    expires_at: expiresAt || '',
    status: 'active',
    notes: notes,
    sha256: sha256,
    _created_at: now,
    _updated_at: now,
    _rev: 1
  };
  var sheet = ss.getSheetByName(T.ClientDocuments);
  sheet.appendRow(hdr.map(function (h) { return row[h] !== undefined ? row[h] : ''; }));

  _logAudit('client_document.upload', s.payload.tid, s.payload.uid,
    docId + ' client=' + p.client_id + ' type=' + docType + ' bytes=' + bytes.length);

  return _json({
    ok: true,
    doc_id: docId,
    drive_file_id: driveId,
    sha256: sha256,
    filename: safeName,
    size_bytes: bytes.length
  });
}

// ---------------------------------------------------------------------------
// API: list client documents
// ---------------------------------------------------------------------------
// GET ?client_id=...
//   Auth: scheduler/manager/owner/platform_staff (any client in the tenant)
//         OR role_client_contact whose Client_Contacts row matches client_id.
// Returns each row with computed is_expired + expires_in_days for any row
// that has expires_at set. Sorted newest-first by uploaded_at.
// ---------------------------------------------------------------------------
function apiListClientDocuments(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  var clientId = (e.parameter && e.parameter.client_id) || '';
  if (!clientId) return _json({ ok:false, error:'client_id required' });

  var role = s.payload.role || '';
  var allowed = CD_WRITE_ROLES.indexOf(role) >= 0;
  if (!allowed && role === 'role_client_contact') {
    allowed = _cdIsContactForClient_(s.payload.uid, s.payload.tid, clientId);
  }
  if (!allowed) {
    return _json({ ok:false, error:'Not authorized to view documents for this client.' }, 403);
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.ClientDocuments, _tenantSchema().Client_Documents);
  var rows = _filterRows_(ss, T.ClientDocuments, function (r) {
    return r.client_id === clientId && r.tenant_id === s.payload.tid;
  });

  var nowMs = Date.now();
  var DAY_MS = 24 * 60 * 60 * 1000;
  rows.forEach(function (r) {
    if (r.expires_at) {
      var expMs = new Date(r.expires_at).getTime();
      if (!isNaN(expMs)) {
        var diffDays = Math.floor((expMs - nowMs) / DAY_MS);
        r.expires_in_days = diffDays;
        r.is_expired = diffDays < 0;
      } else {
        r.expires_in_days = null;
        r.is_expired = false;
      }
    } else {
      r.expires_in_days = null;
      r.is_expired = false;
    }
  });

  rows.sort(function (a, b) {
    return String(b.uploaded_at).localeCompare(String(a.uploaded_at));
  });

  return _json({ ok:true, documents: rows, doc_types: CD_DOC_TYPES });
}

// ---------------------------------------------------------------------------
// API: archive a client document (flip status -> 'archived'; preserves the
// Drive file for legal retention).
// ---------------------------------------------------------------------------
function apiArchiveClientDocument(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok:false, error:s.error }, 401);
  if (CD_ARCHIVE_ROLES.indexOf(s.payload.role) < 0) {
    return _json({ ok:false, error:'Owner / manager / platform_staff role required.' }, 403);
  }
  var p = _coParams(e);
  if (!p.doc_id) return _json({ ok:false, error:'doc_id required' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.ClientDocuments, _tenantSchema().Client_Documents);
  var now = new Date().toISOString();
  var ok = _updateRowById_(ss, T.ClientDocuments, 'doc_id', p.doc_id, s.payload.tid, function (row) {
    row.status = 'archived';
    row._updated_at = now;
    row._rev = (Number(row._rev) || 1) + 1;
    return row;
  });
  if (!ok) return _json({ ok:false, error:'Document not found' }, 404);
  _logAudit('client_document.archive', s.payload.tid, s.payload.uid, p.doc_id);
  return _json({ ok:true, doc_id: p.doc_id, status: 'archived' });
}

// ---------------------------------------------------------------------------
// API: stream a client document back. Wraps the Drive blob in an HTML <embed>
// (or <img> for images) the same way apiGetReceipt does. Auth checks happen
// against the document's row, not the Drive ACL.
// ---------------------------------------------------------------------------
function apiGetClientDocument(e) {
  var s = _requireSession(e);
  if (!s.ok) return _serveText('Forbidden', 401);
  var docId = e.parameter && e.parameter.id;
  if (!docId) return _serveText('id required', 400);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.ClientDocuments, _tenantSchema().Client_Documents);
  var doc = _findRowById_(ss, T.ClientDocuments, 'doc_id', docId, s.payload.tid);
  if (!doc) return _serveText('Not found', 404);

  var role = s.payload.role || '';
  var canView = CD_WRITE_ROLES.indexOf(role) >= 0;
  if (!canView && role === 'role_client_contact') {
    canView = _cdIsContactForClient_(s.payload.uid, s.payload.tid, doc.client_id);
  }
  if (!canView) return _serveText('Forbidden', 403);

  var file;
  try { file = DriveApp.getFileById(doc.drive_file_id); } catch (_) { return _serveText('Document file not found', 404); }
  var blob = file.getBlob();
  var mime = blob.getContentType() || doc.mime || 'application/octet-stream';
  var b64  = Utilities.base64Encode(blob.getBytes());
  var dataUrl = 'data:' + mime + ';base64,' + b64;
  var safeTitle = String(doc.title || doc.filename || docId).replace(/[<>"&']/g, '');
  var wrapper =
    '<!doctype html><html><head><meta charset="utf-8"><title>' + safeTitle + '</title>' +
    '<style>html,body{margin:0;padding:0;height:100%;font-family:system-ui}embed,img{display:block;max-width:100%;max-height:100vh;margin:0 auto}</style>' +
    '</head><body>' +
    (/^image\//.test(mime)
      ? '<img src="' + dataUrl + '" alt="' + safeTitle + '">'
      : '<embed src="' + dataUrl + '" type="' + mime + '" style="width:100%;height:100vh;border:0">'
    ) +
    '</body></html>';
  _logAudit('client_document.view', s.payload.tid, s.payload.uid, docId);
  return HtmlService.createHtmlOutput(wrapper).setTitle(safeTitle).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Folder hierarchy: /<root>/<tenant_id>/<client_id>/<doc_type>/
// Kept separate from the receipts root so the two concerns don't mingle.
function _cdOrCreateFolder_(tenantId, clientId, docType) {
  var root = _cdFolder_(DriveApp.getRootFolder(), CD_DRIVE_FOLDER_NAME);
  var tenant = _cdFolder_(root, String(tenantId || 'unspecified'));
  var client = _cdFolder_(tenant, String(clientId || 'unspecified'));
  return _cdFolder_(client, String(docType || 'other'));
}

function _cdFolder_(parent, name) {
  var iter = parent.getFoldersByName(name);
  if (iter.hasNext()) return iter.next();
  return parent.createFolder(name);
}

// Accepts YYYY-MM-DD; rejects anything else.
function _cdValidateDate_(v) {
  if (v === undefined || v === null || v === '') return '';
  var s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  var d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  return s;
}

// True if the given user_id is on a Client_Contacts row for this client+tenant.
function _cdIsContactForClient_(userId, tenantId, clientId) {
  if (!userId || !clientId) return false;
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(T.ClientContacts);
  if (!sh) return false;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return false;
  var hdr = data[0];
  var iUser = hdr.indexOf('user_id');
  var iClient = hdr.indexOf('client_id');
  var iTenant = hdr.indexOf('tenant_id');
  var iStatus = hdr.indexOf('status');
  if (iUser < 0 || iClient < 0 || iTenant < 0) return false;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iUser]) !== String(userId)) continue;
    if (String(data[i][iClient]) !== String(clientId)) continue;
    if (tenantId && String(data[i][iTenant]) !== String(tenantId)) continue;
    if (iStatus >= 0 && String(data[i][iStatus]) === 'inactive') continue;
    return true;
  }
  return false;
}
