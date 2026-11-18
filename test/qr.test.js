// Dumps QR matrices for many payloads to JSON; test/qr_verify.py decodes them with OpenCV.
const QR = require('../public/qr.js');
const cases = [];
const urls = [
  'https://a.co/phone?code=482913',
  'https://living-garden-demo.onrender.com/phone?code=000123',
  'https://random-words-here-1234.trycloudflare.com/phone?code=999999',
  'http://192.168.1.23:3000/phone?code=482913',
];
urls.forEach((u) => cases.push(u));
for (const n of [1, 5, 14, 26, 42, 62, 84, 106, 122, 154, 178, 213]) {
  cases.push(Array.from({ length: n }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789/:?=.-'[(i * 7 + n) % 41]).join(''));
}
cases.push('Garden 🌸 café — ünïcode');
const out = cases.map((t) => { const q = QR.encode(t); return { text: t, version: q.version, mask: q.mask, size: q.size, rows: q.modules.map((r) => r.map((c) => (c ? 1 : 0)).join('')) }; });
let threw = false;
try { QR.encode('x'.repeat(214)); } catch (e) { threw = true; }
if (!threw) { console.error('expected overflow error'); process.exit(1); }
require('fs').writeFileSync('/tmp/qr_cases.json', JSON.stringify(out));
console.log('encoded', out.length, 'cases; versions used:', [...new Set(out.map((o) => o.version))].sort((a, b) => a - b).join(','));
