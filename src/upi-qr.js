// ============================================================================
// upi-qr.js — the shop's UPI payment QR code (same rules as the Android app).
//
// What is stored and shared is the TEXT inside the QR (a `upi://pay?…` link) in
// mh_config.data.upiQrText, not a picture. An uploaded picture is read once to get that
// text. For printing, the code is drawn again from the text: every module a whole number
// of pixels / printer dots, pure black on white, with the 4-module white border the QR
// standard requires. A shrunk photo of a QR printed on a thermal head is what UPI apps
// failed to scan; a code drawn dot-for-dot scans.
// ============================================================================
import QRCode from 'qrcode';
import jsQR from 'jsqr';

/** Modules of white around the code (QR standard: 4). */
export const QUIET = 4;

/** Only a UPI payment link is ever stored, shown or printed. Anything else → ''. */
export function validUpiQr(v) {
  var t = String(v == null ? '' : v).trim();
  if (t.length < 12 || t.length > 1500) return '';
  if (!/^upi:\/\/pay/i.test(t)) return '';
  if (/[\s\u0000-\u001f\u007f]/.test(t)) return '';
  return t;
}

/** The payee (pa=…) inside a payment link, to show which account a code pays. */
export function payeeOf(link) {
  var m = /[?&]pa=([^&]+)/i.exec(link || '');
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

/** A payment link for a UPI ID with the bill amount filled in (used when no QR was uploaded). */
export function upiLinkFor(upiId, amount, payeeName) {
  return 'upi://pay?pa=' + encodeURIComponent(upiId)
    + '&pn=' + encodeURIComponent(payeeName || 'Gavthan')
    + '&am=' + Math.round(Number(amount) || 0)
    + '&cu=INR'
    + '&tn=' + encodeURIComponent((payeeName || 'Gavthan') + ' bill');
}

var lastText = null, lastModules = null;

/** The code's black/white grid for [text] as an array of rows of booleans (no border), or null. */
export function qrModules(text) {
  if (text === lastText) return lastModules;
  var m = null;
  try {
    var q = QRCode.create(text, { errorCorrectionLevel: 'M' });
    var n = q.modules.size;
    m = [];
    for (var y = 0; y < n; y++) {
      var row = [];
      for (var x = 0; x < n; x++) row.push(!!q.modules.get(y, x));
      m.push(row);
    }
  } catch (e) { m = null; }
  lastText = text; lastModules = m;
  return m;
}

/**
 * A PNG data URL of the code at most [maxPx] wide, border included, every module a whole
 * number of pixels (at least 3). Null if it cannot be drawn that large.
 */
export function qrPngDataUrl(text, maxPx) {
  var m = qrModules(text);
  if (!m) return null;
  var n = m.length + 2 * QUIET;
  var dot = Math.min(Math.floor(maxPx / n), 8);
  if (dot < 3) return null;
  var side = n * dot;
  var c = document.createElement('canvas');
  c.width = side; c.height = side;
  var g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#fff'; g.fillRect(0, 0, side, side);
  g.fillStyle = '#000';
  for (var y = 0; y < m.length; y++)
    for (var x = 0; x < m.length; x++)
      if (m[y][x]) g.fillRect((x + QUIET) * dot, (y + QUIET) * dot, dot, dot);
  return { url: c.toDataURL('image/png'), side: side };
}

/** Read the text of the QR code in a picked image File. Resolves to the text, or null if none was found. */
export function readQrFromFile(file) {
  return new Promise(function (resolve) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      try {
        // A few sizes: a huge screenshot and a small crop each lock on at a different scale.
        var sizes = [0, 1000, 600, 400];
        for (var i = 0; i < sizes.length; i++) {
          var s = sizes[i], w = img.naturalWidth, h = img.naturalHeight;
          if (s && Math.max(w, h) > s) { var k = s / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
          else if (s) continue;
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          var g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); // transparent = white paper
          g.drawImage(img, 0, 0, w, h);
          var data = g.getImageData(0, 0, w, h);
          var r = jsQR(data.data, w, h, { inversionAttempts: 'attemptBoth' });
          if (r && r.data) { URL.revokeObjectURL(url); resolve(r.data); return; }
        }
      } catch (e) { /* fall through */ }
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
