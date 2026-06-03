// ============================================================================
// Code_Closeout.gs — Interpreter job close-out (actuals + expenses)
// v18.2 — May 2026
//
// When an interpreter finishes a job they "close it out" from /app/me/:
//   - confirm/edit actual start + actual end (may differ from scheduled)
//   - add expense lines (mileage, parking, tolls, supplies, meal, other)
//   - optionally upload a receipt per expense (stored on Drive)
//   - optional notes from the interpreter
//
// Auto-billing model (per admin pref): close-out posts immediately.
//   - Jobs.actual_start / actual_end set
//   - Jobs.status -> COMPLETED
//   - Job_Assignments.billable_minutes recomputed
//   - Jobs.closeout_divergence_pct = abs(actual_minutes - scheduled_minutes) / scheduled_minutes
//     (the scheduler /app/job/ UI flags anything >= 0.25 for review)
//   - Job_Expenses rows inserted with status='submitted' (paid out on next Payout)
//
// Pay-side only: expenses are NEVER billed to the client. They flow into the
// interpreter's Payout as separate "expense reimbursement" lines.
// ============================================================================

var CLOSEOUT_DIVERGENCE_FLAG_THRESHOLD = 0.25; // 25%
var CLOSEOUT_DRIVE_FOLDER_NAME = '1891 Interpreter — Receipts';
var CLOSEOUT_MAX_RECEIPT_BYTES = 8 * 1024 * 1024; // 8 MB

var CLOSEOUT_EXPENSE_TYPES = {
  mileage:  { unit: 'mile',  description: 'Mileage' },
  parking:  { unit: 'fixed', description: 'Parking' },
  tolls:    { unit: 'fixed', description: 'Tolls' },
  supplies: { unit: 'fixed', description: 'Supplies' },
  meal:     { unit: 'fixed', description: 'Meal (per-diem only with prior approval)' },
  other:    { unit: 'fixed', description: 'Other (description required)' }
};

// ---------------------------------------------------------------------------
// API: close out a job
// ---------------------------------------------------------------------------
// POST body (JSON or form):
//   job_id            (required)
//   actual_start_iso  (required ISO)
//   actual_end_iso    (required ISO, must be > actual_start_iso)
//   notes             (optional, free text up to 2000 chars)
//   expenses          (JSON-stringified array of {type, quantity, amount_cents, description, receipt_drive_id})
// ---------------------------------------------------------------------------
function apiCloseOutJob(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);
  var p = _coParams(e);
  if (!p.job_id) return _json({ ok: false, error: 'job_id required' });
  if (!p.actual_start_iso || !p.actual_end_iso) {
    return _json({ ok: false, error: 'actual_start_iso + actual_end_iso required' });
  }
  var actualStart = new Date(p.actual_start_iso);
  var actualEnd   = new Date(p.actual_end_iso);
  if (isNaN(actualStart) || isNaN(actualEnd) || actualEnd <= actualStart) {
    return _json({ ok: false, error: 'actual_end must be after actual_start' });
  }
  var actualMin = Math.round((actualEnd - actualStart) / 60000);
  if (actualMin > 24 * 60) {
    return _json({ ok: false, error: 'Sanity check: actual duration > 24h. Re-enter or contact scheduler.' });
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var schema = _tenantSchema();
  _ensureTab(ss, T.JobExpenses, schema.Job_Expenses);
  _ensureTab(ss, T.Jobs, schema.Jobs);

  // Find the job and verify the interpreter is on it
  var job = _findJob(ss, s.payload.tid, p.job_id);
  if (!job) return _json({ ok: false, error: 'Job not found' }, 404);

  // Block close-out if job is already past it
  var TERMINAL = ['CANCELLED','CANCELLED_BY_AGENCY','CANCELLED_BY_REQUESTOR','NO_SHOW_CONSUMER','VOIDED'];
  if (TERMINAL.indexOf(job.status) >= 0) {
    return _json({ ok: false, error: 'Job is ' + job.status + ', cannot close out.' });
  }
  if (job.interpreter_signoff_at) {
    return _json({ ok: false, error: 'Job already closed out at ' + job.interpreter_signoff_at });
  }

  // Find the interpreter's assignment on this job
  var assignment = _coFindMyAssignment_(ss, s, job.job_id);
  if (!assignment) {
    return _json({ ok: false, error: 'You are not assigned to this job.' }, 403);
  }

  // Parse expenses
  var expenses = [];
  if (p.expenses) {
    try {
      var raw = (typeof p.expenses === 'string') ? JSON.parse(p.expenses) : p.expenses;
      if (!Array.isArray(raw)) throw new Error('expenses must be an array');
      raw.forEach(function (ex, idx) {
        var v = _coValidateExpense_(ex, idx);
        if (v.error) throw new Error(v.error);
        expenses.push(v.expense);
      });
    } catch (err) {
      return _json({ ok: false, error: 'Invalid expenses: ' + String(err.message || err) });
    }
  }

  var schedStart = new Date(job.scheduled_start);
  var schedEnd   = new Date(job.scheduled_end);
  var schedMin   = Math.max(1, Math.round((schedEnd - schedStart) / 60000));
  var divergence = Math.abs(actualMin - schedMin) / schedMin;
  var divPct = Math.round(divergence * 1000) / 10; // 1 decimal

  var now = new Date().toISOString();

  // Persist Jobs row updates
  _coUpdateJobRow_(ss, schema.Jobs, job.job_id, s.payload.tid, function (row) {
    row.actual_start = actualStart.toISOString();
    row.actual_end   = actualEnd.toISOString();
    row.status       = 'COMPLETED';
    row.interpreter_signoff_at    = now;
    row.interpreter_signoff_notes = String(p.notes || '').slice(0, 2000);
    row.closeout_divergence_pct   = divPct;
    row._updated_at  = now;
    row._rev = (Number(row._rev) || 1) + 1;
    return row;
  });

  // Update Job_Assignments.billable_minutes for the interpreter who closed out
  _coUpdateAssignmentRow_(ss, assignment.assignment_id, function (row) {
    row.billable_minutes = actualMin;
    row.status = 'COMPLETED';
    row._updated_at = now;
    row._rev = (Number(row._rev) || 1) + 1;
    return row;
  });

  // Append a Job_Events row for audit
  _appendJobEvent(ss, job.job_id, s.payload.uid || '', 'closeout_submitted',
    job.status, 'COMPLETED',
    JSON.stringify({ actual_minutes: actualMin, scheduled_minutes: schedMin, divergence_pct: divPct, expense_count: expenses.length }));

  // Persist Job_Expenses rows
  var expenseSheet = ss.getSheetByName(T.JobExpenses);
  var exHdr = schema.Job_Expenses;
  var insertedExpenses = expenses.map(function (ex) {
    var expenseId = _ulid('jex');
    var row = {
      expense_id: expenseId,
      tenant_id: s.payload.tid,
      job_id: job.job_id,
      assignment_id: assignment.assignment_id,
      interpreter_id: assignment.interpreter_id,
      expense_type: ex.type,
      quantity: ex.quantity,
      unit: ex.unit,
      rate_cents: ex.rate_cents,
      amount_cents: ex.amount_cents,
      description: ex.description,
      receipt_r2_key: ex.receipt_drive_id || '',
      receipt_filename: ex.receipt_filename || '',
      receipt_mime: ex.receipt_mime || '',
      submitted_at: now,
      status: 'submitted', // submitted -> approved -> reimbursed | rejected
      approved_by_user_id: '',
      approved_at: '',
      rejected_reason: '',
      payout_id: '',
      _created_at: now,
      _updated_at: now,
      _rev: 1
    };
    expenseSheet.appendRow(exHdr.map(function (h) { return row[h] !== undefined ? row[h] : ''; }));
    return { expense_id: expenseId, type: ex.type, amount_cents: ex.amount_cents };
  });

  // Notify the scheduler / requestor contact via event so the day-of board updates
  try {
    if (typeof notifyEvent_ === 'function') {
      notifyEvent_(s.payload.tid, 'job_complete', {
        job_id: job.job_id,
        actor_user_id: s.payload.uid,
        scheduled_start: job.scheduled_start,
        divergence_pct: divPct,
        expense_count: insertedExpenses.length
      });
    }
  } catch (_) { /* non-fatal */ }

  _logAudit('job.closeout', s.payload.tid, s.payload.uid,
    job.job_id + ' actual=' + actualMin + 'm scheduled=' + schedMin + 'm divergence=' + divPct + '% expenses=' + insertedExpenses.length);

  return _json({
    ok: true,
    job_id: job.job_id,
    status: 'COMPLETED',
    actual_minutes: actualMin,
    scheduled_minutes: schedMin,
    divergence_pct: divPct,
    flagged_for_dispute: divergence >= CLOSEOUT_DIVERGENCE_FLAG_THRESHOLD,
    expenses: insertedExpenses
  });
}

// ---------------------------------------------------------------------------
// API: receipt upload (called BEFORE close-out; client uploads each file as
// the user picks it, gets back a Drive file ID, then includes that ID in
// the expenses[] payload of apiCloseOutJob).
// ---------------------------------------------------------------------------
// POST body (JSON):
//   filename     (string)
//   mime         (string — image/* or application/pdf)
//   bytes_b64    (string — base64-encoded file contents)
//   job_id       (string — for the folder name; can be 'pending' if pre-close-out)
// ---------------------------------------------------------------------------
function apiUploadReceipt(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);
  var p = _coParams(e);
  if (!p.filename || !p.bytes_b64 || !p.mime) {
    return _json({ ok: false, error: 'filename, mime, bytes_b64 required' });
  }
  // Whitelist mimes
  if (!/^(image\/(jpeg|png|gif|webp|heic|heif)|application\/pdf)$/i.test(p.mime)) {
    return _json({ ok: false, error: 'Unsupported file type. Use JPEG, PNG, HEIC, or PDF.' });
  }
  var bytes;
  try {
    bytes = Utilities.base64Decode(p.bytes_b64);
  } catch (err) {
    return _json({ ok: false, error: 'Invalid base64' });
  }
  if (bytes.length > CLOSEOUT_MAX_RECEIPT_BYTES) {
    return _json({ ok: false, error: 'File too large (max 8MB)' });
  }

  var safeName = String(p.filename).replace(/[^A-Za-z0-9._\-]/g, '_').slice(0, 80);
  var blob = Utilities.newBlob(bytes, p.mime, safeName);

  // Drive folder structure: /<root>/<tenant_id>/<YYYY-MM>/<filename>
  var folder = _coReceiptsFolder_(s.payload.tid);
  var file = folder.createFile(blob);
  var driveId = file.getId();

  // Owner-only by default — Drive file inherits folder perms (private)
  _logAudit('receipt.upload', s.payload.tid, s.payload.uid, driveId + ' bytes=' + bytes.length);
  return _json({
    ok: true,
    drive_id: driveId,
    filename: safeName,
    mime: p.mime,
    size_bytes: bytes.length
  });
}

// Stream a receipt back (admins / interpreters who own it can view)
function apiGetReceipt(e) {
  var s = _requireSession(e);
  if (!s.ok) return _serveText('Forbidden', 401);
  var driveId = e.parameter.id;
  if (!driveId) return _serveText('id required', 400);
  // Verify the requester has access: the receipt must belong to a Job_Expense
  // in their tenant, AND either they're the interpreter who uploaded it
  // OR they're owner/manager/scheduler in that tenant.
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var rows = _filterRows_(ss, T.JobExpenses, function (r) {
    return r.receipt_r2_key === driveId && r.tenant_id === s.payload.tid;
  });
  if (!rows.length) return _serveText('Not found', 404);
  var canView = ['role_owner','role_manager','role_admin','role_scheduler','role_platform_staff'].indexOf(s.payload.role) >= 0;
  if (!canView) {
    // Interpreter — must own
    var myInterpId = _coLookupMyInterpreterId_(ss, s);
    if (!rows.some(function (r) { return r.interpreter_id === myInterpId; })) {
      return _serveText('Forbidden', 403);
    }
  }
  var file;
  try { file = DriveApp.getFileById(driveId); } catch (_) { return _serveText('Receipt not found', 404); }
  var blob = file.getBlob();
  // Apps Script can't return arbitrary binary with custom Content-Type without
  // an embed wrapper, so we wrap in an HTML <embed> for inline view.
  var b64 = Utilities.base64Encode(blob.getBytes());
  var dataUrl = 'data:' + (blob.getContentType() || 'application/octet-stream') + ';base64,' + b64;
  var wrapper =
    '<!doctype html><html><head><meta charset="utf-8"><title>Receipt ' + driveId + '</title>' +
    '<style>html,body{margin:0;padding:0;height:100%;font-family:system-ui}embed,img{display:block;max-width:100%;max-height:100vh;margin:0 auto}</style>' +
    '</head><body>' +
    (/^image\//.test(blob.getContentType() || '')
      ? '<img src="' + dataUrl + '" alt="Receipt">'
      : '<embed src="' + dataUrl + '" type="' + (blob.getContentType() || 'application/octet-stream') + '" style="width:100%;height:100vh;border:0">'
    ) +
    '</body></html>';
  _logAudit('receipt.view', s.payload.tid, s.payload.uid, driveId);
  return HtmlService.createHtmlOutput(wrapper).setTitle('Receipt').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---------------------------------------------------------------------------
// API: list expenses for a job (scheduler view + interpreter view)
// ---------------------------------------------------------------------------
function apiListJobExpenses(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);
  var jobId = e.parameter.job_id;
  if (!jobId) return _json({ ok: false, error: 'job_id required' });
  var ss = SpreadsheetApp.openById(SHEET_ID);
  _ensureTab(ss, T.JobExpenses, _tenantSchema().Job_Expenses);
  var rows = _filterRows_(ss, T.JobExpenses, function (r) {
    return r.job_id === jobId && r.tenant_id === s.payload.tid;
  });
  rows.sort(function (a, b) { return String(a.submitted_at).localeCompare(String(b.submitted_at)); });
  // Compute totals
  var totals = { count: rows.length, amount_cents: 0, approved_cents: 0, submitted_cents: 0, rejected_cents: 0 };
  rows.forEach(function (r) {
    var c = Number(r.amount_cents || 0);
    totals.amount_cents += c;
    if (r.status === 'approved' || r.status === 'reimbursed') totals.approved_cents += c;
    else if (r.status === 'rejected') totals.rejected_cents += c;
    else totals.submitted_cents += c;
  });
  return _json({ ok: true, expenses: rows, totals: totals });
}

// ---------------------------------------------------------------------------
// API: scheduler-side — dispute a close-out (rolls back to CONFIRMED, opens
// review). For when the interpreter logged wildly different actuals.
// ---------------------------------------------------------------------------
function apiDisputeCloseout(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);
  if (['role_owner','role_admin','role_manager','role_scheduler','role_platform_staff'].indexOf(s.payload.role) < 0) {
    return _json({ ok: false, error: 'Scheduler / manager / owner role required' }, 403);
  }
  var p = _coParams(e);
  if (!p.job_id || !p.reason || String(p.reason).trim().length < 10) {
    return _json({ ok: false, error: 'job_id + reason (10+ chars) required' });
  }
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var job = _findJob(ss, s.payload.tid, p.job_id);
  if (!job) return _json({ ok: false, error: 'Job not found' }, 404);
  if (!job.interpreter_signoff_at) {
    return _json({ ok: false, error: 'Job has not been closed out yet — nothing to dispute.' });
  }

  var now = new Date().toISOString();
  _coUpdateJobRow_(ss, _tenantSchema().Jobs, job.job_id, s.payload.tid, function (row) {
    row.status = 'CONFIRMED'; // pull back so the interpreter can re-submit
    row.closeout_disputed_at  = now;
    row.closeout_disputed_by  = s.payload.uid || '';
    row.closeout_dispute_reason = String(p.reason).slice(0, 1000);
    row._updated_at = now;
    row._rev = (Number(row._rev) || 1) + 1;
    return row;
  });

  _appendJobEvent(ss, job.job_id, s.payload.uid || '', 'closeout_disputed',
    'COMPLETED', 'CONFIRMED', JSON.stringify({ reason: String(p.reason).slice(0, 200) }));
  _logAudit('job.closeout_disputed', s.payload.tid, s.payload.uid, job.job_id);
  return _json({ ok: true, job_id: job.job_id, status: 'CONFIRMED' });
}

// ---------------------------------------------------------------------------
// API: scheduler-side — approve / reject a single expense
// ---------------------------------------------------------------------------
function apiUpdateExpenseStatus(e) {
  var s = _requireSession(e);
  if (!s.ok) return _json({ ok: false, error: s.error }, 401);
  if (['role_owner','role_admin','role_manager','role_scheduler','role_platform_staff'].indexOf(s.payload.role) < 0) {
    return _json({ ok: false, error: 'Scheduler / manager / owner role required' }, 403);
  }
  var p = _coParams(e);
  if (!p.expense_id || !p.status) return _json({ ok: false, error: 'expense_id + status required' });
  if (['approved','rejected','submitted'].indexOf(p.status) < 0) {
    return _json({ ok: false, error: 'status must be approved | rejected | submitted' });
  }
  if (p.status === 'rejected' && (!p.reason || String(p.reason).trim().length < 5)) {
    return _json({ ok: false, error: 'rejected status needs reason (5+ chars)' });
  }
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var now = new Date().toISOString();
  var ok = _updateRowById_(ss, T.JobExpenses, 'expense_id', p.expense_id, s.payload.tid, function (row) {
    row.status = p.status;
    if (p.status === 'approved') {
      row.approved_by_user_id = s.payload.uid || '';
      row.approved_at = now;
      row.rejected_reason = '';
    } else if (p.status === 'rejected') {
      row.rejected_reason = String(p.reason || '').slice(0, 500);
      row.approved_by_user_id = '';
      row.approved_at = '';
    } else {
      row.approved_by_user_id = '';
      row.approved_at = '';
      row.rejected_reason = '';
    }
    row._updated_at = now;
    row._rev = (Number(row._rev) || 1) + 1;
    return row;
  });
  if (!ok) return _json({ ok: false, error: 'Expense not found' }, 404);
  _logAudit('expense.status', s.payload.tid, s.payload.uid, p.expense_id + ' -> ' + p.status);
  return _json({ ok: true, expense_id: p.expense_id, status: p.status });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _coValidateExpense_(ex, idx) {
  if (!ex || typeof ex !== 'object') return { error: 'expense[' + idx + '] must be an object' };
  var type = String(ex.type || '').toLowerCase();
  if (!CLOSEOUT_EXPENSE_TYPES[type]) return { error: 'expense[' + idx + '].type must be one of ' + Object.keys(CLOSEOUT_EXPENSE_TYPES).join('/') };
  var typeDef = CLOSEOUT_EXPENSE_TYPES[type];

  var quantity, rateCents, amountCents;
  if (type === 'mileage') {
    quantity = Number(ex.quantity || 0);
    if (!isFinite(quantity) || quantity < 0 || quantity > 1000) return { error: 'expense[' + idx + ']: mileage 0-1000 miles' };
    rateCents = Number(ex.rate_cents || 0);
    if (!isFinite(rateCents) || rateCents < 0 || rateCents > 200) return { error: 'expense[' + idx + ']: rate_cents 0-200 (cents per mile)' };
    amountCents = Math.round(quantity * rateCents);
  } else {
    quantity = 1;
    rateCents = 0;
    amountCents = Number(ex.amount_cents || 0);
    if (!isFinite(amountCents) || amountCents < 0 || amountCents > 100000) return { error: 'expense[' + idx + ']: amount_cents 0-100000 ($0-$1000)' };
  }
  var description = String(ex.description || '').slice(0, 500);
  if (type === 'other' && description.trim().length < 3) return { error: 'expense[' + idx + ']: "other" requires description' };

  return {
    expense: {
      type: type,
      unit: typeDef.unit,
      quantity: quantity,
      rate_cents: rateCents,
      amount_cents: amountCents,
      description: description,
      receipt_drive_id: ex.receipt_drive_id || '',
      receipt_filename: ex.receipt_filename || '',
      receipt_mime: ex.receipt_mime || ''
    }
  };
}

function _coFindMyAssignment_(ss, s, jobId) {
  var sh = ss.getSheetByName(T.JobAssignments);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  // Find the interpreter_id for the signed-in user
  var myInterpId = _coLookupMyInterpreterId_(ss, s);
  if (!myInterpId) return null;
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.job_id !== jobId) continue;
    if (o.interpreter_id !== myInterpId) continue;
    if (o.response !== 'claim') continue;
    return o;
  }
  return null;
}

function _coLookupMyInterpreterId_(ss, s) {
  // Users.user_id -> Users.interpreter_id
  var sh = ss.getSheetByName(T.Users);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var hdr = data[0];
  var iUid = hdr.indexOf('user_id');
  var iInt = hdr.indexOf('interpreter_id');
  if (iUid < 0 || iInt < 0) return null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iUid]) === String(s.payload.uid)) return String(data[i][iInt] || '');
  }
  return null;
}

function _coUpdateJobRow_(ss, hdr, jobId, tenantId, mutator) {
  var sh = ss.getSheetByName(T.Jobs);
  if (!sh) return false;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return false;
  // Use the *sheet's* current header order (in case schema has been extended
  // in the live sheet beyond the canonical _tenantSchema().Jobs definition).
  var sheetHdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(sheetHdr, data[i]);
    if (o.job_id !== jobId) continue;
    if (tenantId && o.tenant_id !== tenantId) continue;
    var updated = mutator(o);
    var row = sheetHdr.map(function (h) { return updated[h] !== undefined ? updated[h] : ''; });
    sh.getRange(i + 1, 1, 1, sheetHdr.length).setValues([row]);
    return true;
  }
  return false;
}

function _coUpdateAssignmentRow_(ss, assignmentId, mutator) {
  var sh = ss.getSheetByName(T.JobAssignments);
  if (!sh) return false;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return false;
  var hdr = data[0];
  for (var i = 1; i < data.length; i++) {
    var o = _rowToObj(hdr, data[i]);
    if (o.assignment_id !== assignmentId) continue;
    var updated = mutator(o);
    var row = hdr.map(function (h) { return updated[h] !== undefined ? updated[h] : ''; });
    sh.getRange(i + 1, 1, 1, hdr.length).setValues([row]);
    return true;
  }
  return false;
}

function _coReceiptsFolder_(tenantId) {
  // /<root>/<tenant_id>/<YYYY-MM>
  var root = _coOrCreateFolder_(DriveApp.getRootFolder(), CLOSEOUT_DRIVE_FOLDER_NAME);
  var tenant = _coOrCreateFolder_(root, String(tenantId || 'unspecified'));
  var now = new Date();
  var ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  return _coOrCreateFolder_(tenant, ym);
}

function _coOrCreateFolder_(parent, name) {
  var iter = parent.getFoldersByName(name);
  if (iter.hasNext()) return iter.next();
  return parent.createFolder(name);
}

// Param picker (POST JSON or GET query)
function _coParams(e) {
  if (e && e.postData && e.postData.type === 'application/json') {
    try { return JSON.parse(e.postData.contents); } catch (_) {}
  }
  return (e && e.parameter) || {};
}
