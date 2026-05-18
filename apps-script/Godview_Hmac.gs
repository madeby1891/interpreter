/**
 * hmac.gs — Godview HMAC-SHA256 verifier for Apps Script-backed projects.
 *
 * This is the READ-PATH auth: the godview Worker (server-side fan-out) calls
 * each project's metrics endpoint with three headers per spec 01 §3:
 *
 *   X-Godview-Ts    unix seconds
 *   X-Godview-Nonce UUIDv4
 *   X-Godview-Sig   hex(HMAC-SHA256(secret, signing_string))
 *
 * CANONICAL SIGNING STRING (LF line endings, no trailing newline):
 *
 *   METHOD\nPATH\nTS\nNONCE
 *
 * where PATH is the request path WITHOUT query string. Example:
 *
 *   GET\n/godview-stats\n1716840000\n9f3c7b1a-1c2d-4e5f-9a0b-1c2d3e4f5a6b
 *
 * Verifier rules (must all pass):
 *   1. abs(now - ts) <= 60 seconds
 *   2. nonce not seen in the last 5 minutes (we use a `_godview_nonces` Sheet
 *      tab on the host spreadsheet; auto-trimmed every call)
 *   3. constant-time hex compare of recomputed sig vs. X-Godview-Sig
 *
 * SECURITY
 *   - Secret is loaded from PropertiesService.getScriptProperties().getProperty(
 *     'GODVIEW_SHARED_SECRET'). It is NEVER reused with AGENT_SECRET — godview
 *     is its own trust domain (spec 01 §3). Leaking it must not give the
 *     attacker CRM write access.
 *   - No secret material on disk in this file. This file is safe to commit.
 *   - Constant-time compare prevents timing-side-channel sig forgery.
 *
 * USAGE
 *   function doGet(e) {
 *     if (e.parameter.godview === '1') {
 *       if (!Godview_verifyHmac_(e)) {
 *         return ContentService
 *           .createTextOutput(JSON.stringify({error: 'unauthorized'}))
 *           .setMimeType(ContentService.MimeType.JSON);
 *       }
 *       return handleGodview(e);
 *     }
 *     // ...rest of doGet
 *   }
 *
 * Godview_signHmac_(...) is exposed for unit tests and for the godview-side
 * client; production verifiers should never need to sign.
 */

/**
 * Godview_verifyHmac_ — verifies X-Godview-Ts, X-Godview-Nonce, X-Godview-Sig
 * headers on an Apps Script doGet/doPost event.
 *
 * Apps Script's `e` event object doesn't always expose headers cleanly. For
 * doGet, you can pass headers via the event in two ways:
 *   - newer projects forward `e.parameter.gv_ts`, `e.parameter.gv_nonce`,
 *     `e.parameter.gv_sig` as query string (the godview Worker mirrors the
 *     headers into the query string for Apps Script's benefit)
 *   - or callers wrap and pass `e.headers` explicitly.
 *
 * We accept either. PATH defaults to `/godview-stats` if not supplied — the
 * Apps Script /exec endpoint hides the path, so the godview Worker MUST agree
 * on a canonical path string per project; that string is passed in `e.parameter.gv_path`
 * (mirrors the documented canonical signing string).
 *
 * @param {Object} e Apps Script event object.
 * @return {boolean} true if all three checks pass.
 */
function Godview_verifyHmac_(e) {
  try {
    var headers = (e && e.headers) || {};
    var params = (e && e.parameter) || {};

    var ts = headers['X-Godview-Ts'] || headers['x-godview-ts'] || params.gv_ts;
    var nonce = headers['X-Godview-Nonce'] || headers['x-godview-nonce'] || params.gv_nonce;
    var sig = headers['X-Godview-Sig'] || headers['x-godview-sig'] || params.gv_sig;
    var method = (e && e.method) || params.gv_method || 'GET';
    var path = params.gv_path || '/godview-stats';

    if (!ts || !nonce || !sig) return false;

    var nowS = Math.floor(Date.now() / 1000);
    var tsNum = parseInt(ts, 10);
    if (!isFinite(tsNum)) return false;
    if (Math.abs(nowS - tsNum) > 60) return false;

    var secret = PropertiesService.getScriptProperties()
      .getProperty('GODVIEW_SHARED_SECRET');
    if (!secret) return false;

    var expected = Godview_signHmac_(method, path, ts, nonce, secret);
    if (!Godview_constantTimeEqualHex_(expected, String(sig))) return false;

    // Replay protection — CacheService variant (works for standalone scripts
    // that aren't bound to a spreadsheet). The canonical shared impl uses a
    // `_godview_nonces` sheet on the active spreadsheet; interpreter is a
    // standalone backend so we use the script cache instead (300s TTL).
    try {
      var cache = CacheService.getScriptCache();
      var seenKey = 'gv_nonce:' + String(nonce);
      if (cache.get(seenKey)) return false;
      cache.put(seenKey, '1', 300);
    } catch (cacheErr) {
      return false;
    }
    return true;
  } catch (err) {
    // Fail closed.
    return false;
  }
}

/**
 * Godview_signHmac_ — compute the hex HMAC-SHA256 over the canonical signing
 * string. Used by tests and (rarely) by Apps-Script-side godview callers.
 *
 * @param {string} method  HTTP method (uppercase).
 * @param {string} path    Request path WITHOUT query string.
 * @param {string|number} ts  Unix seconds (string or number).
 * @param {string} nonce   UUIDv4.
 * @param {string} secret  GODVIEW_SHARED_SECRET.
 * @return {string} lowercase hex HMAC-SHA256.
 */
function Godview_signHmac_(method, path, ts, nonce, secret) {
  var signing = String(method) + '\n' + String(path) + '\n' + String(ts) + '\n' + String(nonce);
  var bytes = Utilities.computeHmacSha256Signature(signing, secret);
  return Godview_bytesToHex_(bytes);
}

/** Constant-time hex string equality. XOR-folded; no early return. */
function Godview_constantTimeEqualHex_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var mismatch = 0;
  for (var i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Godview_bytesToHex_ — Apps Script byte[] (signed -128..127) to lowercase hex.
 */
function Godview_bytesToHex_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}
