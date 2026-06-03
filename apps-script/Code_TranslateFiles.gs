/**
 * 1891 Interpreter — translation source file upload + serve.
 *
 * Kills the "file upload is coming soon" placeholder. A requestor or scheduler
 * uploads the actual document (PDF, Word, RTF, image, or plain text) for a
 * translation job:
 *
 *   POST ?action=upload_translation_source   { filename, mime, bytes_b64 }
 *     → { ok, drive_id, filename, mime, size_bytes, sha256, extracted_text }
 *   GET  ?action=get_translation_source&id=<drive_id>   → inline viewer
 *
 * Plain-text uploads are decoded to `extracted_text` so the existing paste-text
 * pipeline (preview + MT pre-fill on non-gated categories) keeps working
 * untouched. Binary documents are stored for the human translator to open.
 * Files live in Drive, walled off per tenant, served back through an
 * access-checked inline viewer (tenant staff, or an interpreter assigned to the
 * linked job). apiCreateTranslationJob accepts the returned drive_id and records
 * it on the Documents row (r2_key = "drive:<id>").
 */

var TR_UPLOAD_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
var TR_UPLOAD_MIME = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/plain|text\/rtf|application\/rtf|image\/(jpeg|png|webp|heic|heif|tiff))$/i;
var TR_STAFF_ROLES = ['role_owner', 'role_manager', 'role_admin', 'role_scheduler', 'role_platform_staff'];

function _trGetOrMakeFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function _trSourceFolder_(tenantId) {
  var root = _trGetOrMakeFolder_(DriveApp.getRootFolder(), '1891 Interpreter — Translation Sources');
  var t = _trGetOrMakeFolder_(root, tenantId || 'host');
  var ym = Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM');
  return _trGetOrMakeFolder_(t, ym);
}

function _sha256HexBytes_(bytes) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  return d.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function apiUploadTranslationSource(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);

  var p = e.parameter || {};
  if ((!p.bytes_b64 || !p.filename) && e.postData && e.postData.type === 'application/json') {
    try {
      var b = JSON.parse(e.postData.contents);
      for (var k in b) if (p[k] === undefined) p[k] = b[k];
    } catch (_) {}
  }
  if (!p.filename || !p.bytes_b64 || !p.mime) {
    return _json({ ok: false, error: 'filename, mime, bytes_b64 required' });
  }
  if (!TR_UPLOAD_MIME.test(p.mime)) {
    return _json({ ok: false, error: 'Unsupported file type. Use PDF, Word, RTF, plain text, or an image.' });
  }

  var bytes;
  try { bytes = Utilities.base64Decode(p.bytes_b64); }
  catch (err) { return _json({ ok: false, error: 'Invalid base64' }); }
  if (bytes.length > TR_UPLOAD_MAX_BYTES) {
    return _json({ ok: false, error: 'File too large (max 20MB)' });
  }

  var safeName = String(p.filename).replace(/[^A-Za-z0-9._\-]/g, '_').slice(0, 120);
  var blob = Utilities.newBlob(bytes, p.mime, safeName);
  var folder = _trSourceFolder_(s.payload.tid);
  var driveId = folder.createFile(blob).getId();

  var extracted = '';
  if (/^text\/plain/i.test(p.mime)) {
    try { extracted = blob.getDataAsString(); } catch (_) {}
    if (extracted.length > 200000) extracted = extracted.slice(0, 200000);
  }

  _logAudit('translation.source_upload', s.payload.tid, s.payload.uid, driveId + ' bytes=' + bytes.length);
  return _json({
    ok: true,
    drive_id: driveId,
    filename: safeName,
    mime: p.mime,
    size_bytes: bytes.length,
    sha256: _sha256HexBytes_(bytes),
    extracted_text: extracted
  });
}

function apiGetTranslationSource(e) {
  var s = _requireSession(e);
  if (!s.ok) return _serveText('Forbidden', 401);
  var driveId = e.parameter.id;
  if (!driveId) return _serveText('id required', 400);

  // The Drive file must be referenced by a Documents row in the caller's tenant.
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var docs = _filterRows_(ss, T.Documents, function (r) {
    return r.tenant_id === s.payload.tid &&
           (r.r2_key === 'drive:' + driveId || r.r2_key === driveId) &&
           r.kind === 'translation-source';
  });
  if (!docs.length) return _serveText('Not found', 404);

  var canView = TR_STAFF_ROLES.indexOf(s.payload.role) >= 0;
  if (!canView) {
    // An interpreter may view only if assigned to the linked job.
    var jobIds = {};
    docs.forEach(function (d) { if (d.linked_job_id) jobIds[d.linked_job_id] = true; });
    var myInterpId = _coLookupMyInterpreterId_(ss, s);
    var assigned = _filterRows_(ss, T.JobAssignments, function (r) {
      return jobIds[r.job_id] && r.interpreter_id === myInterpId;
    });
    if (!assigned.length) return _serveText('Forbidden', 403);
  }

  var file;
  try { file = DriveApp.getFileById(driveId); } catch (_) { return _serveText('File not found', 404); }
  var blob = file.getBlob();
  var ct = blob.getContentType() || 'application/octet-stream';
  var dataUrl = 'data:' + ct + ';base64,' + Utilities.base64Encode(blob.getBytes());
  var wrapper =
    '<!doctype html><html><head><meta charset="utf-8"><title>Source document</title>' +
    '<style>html,body{margin:0;padding:0;height:100%;font-family:system-ui}embed,img{display:block;max-width:100%;max-height:100vh;margin:0 auto}</style>' +
    '</head><body>' +
    (/^image\//.test(ct)
      ? '<img src="' + dataUrl + '" alt="Source document">'
      : '<embed src="' + dataUrl + '" type="' + ct + '" style="width:100%;height:100vh;border:0">') +
    '</body></html>';
  _logAudit('translation.source_view', s.payload.tid, s.payload.uid, driveId);
  return HtmlService.createHtmlOutput(wrapper).setTitle('Source document').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
