// Converted from inlined IIFE to ES module. Runs the original IIFE against a local
// namespace object, then re-exports ESCPOS + ThermalPrinter.
const __thermalGlobal = {};


/* === ESC/POS thermal printing module (inlined) === */
// ─────────────────────────────────────────────────────────────────────
// thermal-print.js — ESC/POS encoder + multi-transport printer for Gavthan
// Hardware: Xprinter XP-F600 (80mm / 576 dots) and any ESC/POS-compatible printer
//
// Usage:
//   var enc = ESCPOS.encodeBill(cust, { hotel: 'Gavthan', upi: '9876@upi' });
//   await ThermalPrinter.print(enc); // shows transport picker if none configured
//
// Transports:
//   1. Bluetooth (Chrome Android/Desktop)      — direct, no extra software
//   2. WebSocket relay (iOS Safari fallback)   — needs a tiny LAN helper, see README
//   3. Network (LAN IP + port 9100)            — printer in network mode (USB-Ethernet)
// ─────────────────────────────────────────────────────────────────────
(function (global) {
  'use strict';

  // ─── ESC/POS command bytes ────────────────────────────────────────
  var ESC = 0x1B, GS = 0x1D, LF = 0x0A;
  var CMD = {
    INIT:       [ESC, 0x40],
    ALIGN_L:    [ESC, 0x61, 0],
    ALIGN_C:    [ESC, 0x61, 1],
    ALIGN_R:    [ESC, 0x61, 2],
    BOLD_ON:    [ESC, 0x45, 1],
    BOLD_OFF:   [ESC, 0x45, 0],
    UNDERLINE_ON:  [ESC, 0x2D, 1],
    UNDERLINE_OFF: [ESC, 0x2D, 0],
    DOUBLE_H:   [GS,  0x21, 0x10],   // double height
    DOUBLE_W:   [GS,  0x21, 0x20],   // double width
    DOUBLE_HW:  [GS,  0x21, 0x30],   // both
    NORMAL_SIZE:[GS,  0x21, 0x00],
    LF:         [LF],
    FEED3:      [ESC, 0x64, 3],
    FEED5:      [ESC, 0x64, 5],
    CUT_FULL:   [GS,  0x56, 0x00],
    CUT_PART:   [GS,  0x56, 0x01],
    CHARSET_CP437: [ESC, 0x74, 0]    // default code page
  };

  // ─── Builder: accumulate bytes into a Uint8Array ──────────────────
  function Builder() {
    var chunks = [];
    return {
      raw: function (bytes) { chunks.push(Uint8Array.from(bytes)); return this; },
      text: function (s) {
        // CP437/ASCII encoding (printer's default). Strip Unicode that won't render.
        var str = String(s == null ? '' : s).replace(/₹/g, 'Rs');
        var enc = new TextEncoder();
        // Strip non-printable except newlines/tabs
        var clean = str.replace(/[^\x20-\x7E\n\r\t]/g, '?');
        chunks.push(enc.encode(clean));
        return this;
      },
      line: function (s) { return this.text(s == null ? '' : s).raw(CMD.LF); },
      ruler: function (ch, count) {
        var s = ''; ch = ch || '-'; count = count || 48;
        for (var i = 0; i < count; i++) s += ch;
        return this.line(s);
      },
      // Format a 2-column row with right-aligned value padded to total width
      kv: function (label, value, width) {
        width = width || 48;
        var v = String(value);
        var pad = Math.max(1, width - label.length - v.length);
        return this.line(label + new Array(pad + 1).join(' ') + v);
      },
      // Item table row: name (truncated) | qty | rate | amt
      itemRow: function (name, qty, rate, amt, width) {
        width = width || 48;
        // columns: name(22) qty(4) rate(10) amt(12)  → 48 chars
        var n = String(name).slice(0, 22);
        while (n.length < 22) n += ' ';
        var q = String(qty); while (q.length < 4) q = ' ' + q;
        var r = 'Rs' + String(rate); while (r.length < 10) r = ' ' + r;
        var a = 'Rs' + String(amt);  while (a.length < 12) a = ' ' + a;
        return this.line(n + q + r + a);
      },
      build: function () {
        var total = 0;
        for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
        var out = new Uint8Array(total), off = 0;
        for (var j = 0; j < chunks.length; j++) {
          out.set(chunks[j], off); off += chunks[j].length;
        }
        return out;
      }
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────
  function tot(items) {
    var s = 0; for (var i = 0; i < (items||[]).length; i++) s += items[i].price * items[i].qty;
    return s;
  }
  function fmtBill(n) { return n ? 'INV-' + String(n).padStart(5, '0') : ''; }
  function dateOf(iso) { try { return new Date(iso).toLocaleString('en-IN'); } catch (e) { return ''; } }

  // ─── Encode a complete bill into ESC/POS bytes ───────────────────
  function encodeBill(cust, opts) {
    opts = opts || {};
    var hotel = opts.hotel || 'Gavthan';
    var upi   = opts.upi || '';
    var billNo = cust.bill_no || opts.previewBillNo;
    // Immutable official Bill Date & Time — settled_at is the single source of truth
    // (see billDateTime in app.js); falls back to the order date for unsettled previews.
    var billTs = cust.settled_at || cust.date || new Date().toISOString();

    var items = cust.items || [];
    var raw = tot(items);
    var dPct = Number(cust.discount_pct) || 0;
    var dAmt = (cust.discount_on && dPct > 0) ? Math.round(raw * dPct / 100) : 0;
    var aAmt = cust.adjustment_on ? (Number(cust.adjustment) || 0) : 0;
    var grand = raw - dAmt + aAmt;

    var b = Builder();
    b.raw(CMD.INIT).raw(CMD.CHARSET_CP437);

    // Header
    b.raw(CMD.ALIGN_C).raw(CMD.DOUBLE_HW).raw(CMD.BOLD_ON)
     .line(hotel.toUpperCase())
     .raw(CMD.NORMAL_SIZE).raw(CMD.BOLD_OFF)
     .line('Receipt / Bill' + (billNo ? '  ' + fmtBill(billNo) : ''))
     .raw(CMD.LF);

    // Customer info — left-aligned
    b.raw(CMD.ALIGN_L)
     .ruler('-')
     .line('Customer : ' + (cust.name || '-'))
     .line('Room/Tbl : ' + (cust.room || '-'));
    if (cust.phone) b.line('Phone    : ' + cust.phone);
    b.line('Date/Time: ' + dateOf(billTs))
     .ruler('-');

    // Items table header
    b.raw(CMD.BOLD_ON)
     .itemRow('Item', 'Qty', 'Rate', 'Amt')
     .raw(CMD.BOLD_OFF)
     .ruler('-');
    items.forEach(function (i) {
      b.itemRow(i.name, i.qty, i.price, i.price * i.qty);
    });
    b.ruler('-');

    // Breakdown (only if discount/adjustment applied)
    if (dAmt > 0 || (cust.adjustment_on && aAmt !== 0)) {
      b.kv('Subtotal',           'Rs' + raw);
      if (dAmt > 0) b.kv('Discount (' + dPct + '%)', '-Rs' + dAmt);
      if (cust.adjustment_on && aAmt !== 0) b.kv('Adjustment', (aAmt > 0 ? '+' : '') + 'Rs' + aAmt);
      if (cust.reason) b.line('Reason: ' + cust.reason);
      b.ruler('-');
    }

    // Total — emphasized
    b.raw(CMD.BOLD_ON).raw(CMD.DOUBLE_H)
     .kv('TOTAL', 'Rs' + grand)
     .raw(CMD.NORMAL_SIZE).raw(CMD.BOLD_OFF)
     .ruler('=');

    // UPI footer
    if (upi) {
      b.raw(CMD.ALIGN_C).raw(CMD.LF)
       .line('Pay via UPI')
       .line(upi)
       .line('Amount: Rs' + grand)
       .raw(CMD.LF);
    }

    // Footer
    b.raw(CMD.ALIGN_C)
     .line('Thank you for visiting ' + hotel + '!')
     .line('Please come again.');

    b.raw(CMD.FEED5).raw(CMD.CUT_PART);
    return b.build();
  }

  // ─── Transport 1: Web Bluetooth ───────────────────────────────────
  // ESC/POS thermal printers expose a vendor-specific GATT service.
  // Common UUID: 18f0 (16-bit) / 000018f0-0000-1000-8000-00805f9b34fb (128-bit)
  // Characteristic: 2af1
  var BT_SERVICES = [
    0x18f0, 0xff00, 0xfff0, 0xae80,
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2'  // Xprinter-observed
  ];
  var BT_CHAR_HINT = [0x2af1, 0xff01, 0xfff1];

  async function btConnect() {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available on this browser. Switch to "WebSocket relay" mode in Users → Thermal Printer Settings, or use Chrome/Edge on Android.');
    }
    // Some Android Chrome builds expose navigator.bluetooth but throw on requestDevice if globally disabled
    try {
      var available = true;
      if (typeof navigator.bluetooth.getAvailability === 'function') {
        available = await navigator.bluetooth.getAvailability();
      }
      if (!available) {
        throw new Error('Bluetooth is turned off on this device. Turn on Bluetooth in system settings and try again.');
      }
    } catch (e) { if (e && e.message && /turned off/.test(e.message)) throw e; /* getAvailability not supported — proceed */ }
    var device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'XP' }, { namePrefix: 'Xprinter' }, { namePrefix: 'Printer' }, { namePrefix: 'POS' }],
        optionalServices: BT_SERVICES
      });
    } catch (e) {
      var msg = (e && e.message) || '';
      // "Web Bluetooth API globally disabled" comes from Chrome when the flag is off / policy blocks it
      if (/globally disabled|user denied|not allowed|SecurityError/i.test(msg)) {
        throw new Error(
          'Web Bluetooth is disabled on this browser.\n\n' +
          'TO FIX (Android Chrome):\n' +
          '  1. Open Chrome → tap address bar → type:  chrome://flags\n' +
          '  2. Search "Web Bluetooth" → set to Enabled\n' +
          '  3. Relaunch Chrome\n\n' +
          'OR use the WebSocket relay option in Users → Thermal Printer Settings (works without Bluetooth).'
        );
      }
      if (/cancelled|User cancelled/i.test(msg)) {
        throw new Error('You cancelled the printer picker. Try again and pick your printer.');
      }
      throw e;
    }
    var server = await device.gatt.connect();
    var services = await server.getPrimaryServices();
    for (var i = 0; i < services.length; i++) {
      var chars = await services[i].getCharacteristics();
      for (var j = 0; j < chars.length; j++) {
        if (chars[j].properties.writeWithoutResponse || chars[j].properties.write) {
          return { device: device, char: chars[j] };
        }
      }
    }
    throw new Error('No writable characteristic on printer. Is this an ESC/POS Bluetooth printer?');
  }

  async function btPrint(bytes) {
    var conn = await btConnect();
    // Bluetooth Low Energy has a small MTU (~20 bytes commonly, up to 512 negotiated)
    var CHUNK = 180;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      var slice = bytes.slice(i, i + CHUNK);
      if (conn.char.writeValueWithoutResponse) await conn.char.writeValueWithoutResponse(slice);
      else                                     await conn.char.writeValue(slice);
      // small delay so the printer can buffer
      await new Promise(function (r) { setTimeout(r, 15); });
    }
    try { conn.device.gatt.disconnect(); } catch (e) {}
  }

  // ─── Transport 2: WebSocket relay (for iOS Safari & easy network) ─
  // Run a tiny relay (Node.js or PowerShell) on a LAN device that listens
  // for binary frames on a WebSocket and forwards them to the printer
  // (Bluetooth or TCP:9100). See the README at end of this file.
  async function wsPrint(bytes, wsUrl) {
    if (!wsUrl) throw new Error('WebSocket relay URL not configured.');
    return new Promise(function (resolve, reject) {
      var ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      var done = false;
      ws.onopen = function () { ws.send(bytes.buffer); setTimeout(function () { ws.close(); done = true; resolve(); }, 800); };
      ws.onerror = function () { if (!done) reject(new Error('WebSocket relay connection failed.')); };
      ws.onclose = function () { if (!done) reject(new Error('Relay closed before print confirmed.')); };
      setTimeout(function () { if (!done) { try { ws.close(); } catch (e) {} reject(new Error('WebSocket relay timed out.')); } }, 8000);
    });
  }

  // ─── Transport 3: Direct TCP via WebSocket-to-TCP relay ───────────
  // Some routers run a TCP→WS bridge. Same as wsPrint, different URL.

  // ─── High-level entry point with auto-fallback ────────────────────
  var SETTINGS_KEY = 'gh_thermal_settings';
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s || {})); }

  async function printBytes(bytes, settings) {
    settings = settings || loadSettings();
    if (settings.transport === 'ws' && settings.wsUrl) {
      return wsPrint(bytes, settings.wsUrl);
    }
    if (settings.transport === 'bt' || navigator.bluetooth) {
      return btPrint(bytes);
    }
    if (settings.wsUrl) return wsPrint(bytes, settings.wsUrl);
    throw new Error('No print transport configured. Set up Bluetooth (Chrome) or WebSocket relay (iOS).');
  }

  // ─── Public API ───────────────────────────────────────────────────
  global.ESCPOS = {
    encodeBill: encodeBill,
    builder:    Builder,
    cmd:        CMD
  };
  global.ThermalPrinter = {
    print:       printBytes,
    settings:    loadSettings,
    saveSettings: saveSettings,
    isBTSupported: function () { return !!navigator.bluetooth; }
  };
})(__thermalGlobal);

/*
─── WebSocket relay README (for iOS Safari support) ────────────────

iOS Safari blocks Web Bluetooth and most native USB/Serial APIs.
To print from iPhone/iPad, run a tiny WebSocket → printer relay on
any device on the same Wi-Fi (a laptop, a Raspberry Pi, an old Android).

Minimal Node.js relay (printer on TCP:9100, network mode):

  // npm install ws net
  const WS = require('ws'), net = require('net');
  const PRINTER_HOST = '192.168.1.50', PRINTER_PORT = 9100;
  const wss = new WS.Server({ port: 8088 });
  wss.on('connection', ws => {
    ws.on('message', data => {
      const sock = net.connect(PRINTER_PORT, PRINTER_HOST, () => {
        sock.write(data);
        sock.end();
      });
    });
  });
  console.log('Relay listening on ws://0.0.0.0:8088');

Then in the app's Print Settings, set the WebSocket URL to:
  ws://192.168.1.10:8088
(replace with the IP of the device running the relay).

The relay forwards raw bytes to the printer — no transcoding.
*/



export const ESCPOS = __thermalGlobal.ESCPOS;
export const ThermalPrinter = __thermalGlobal.ThermalPrinter;
