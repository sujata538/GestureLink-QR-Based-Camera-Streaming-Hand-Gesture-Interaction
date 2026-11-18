/* ===========================================================
   Minimal QR Code generator (byte mode, error correction M,
   versions 1-10 => up to 213 bytes). No dependencies.
   API:
     QR.encode(text)            -> { size, modules: boolean[][] }
     QR.draw(canvas, text, opt) -> draws onto a <canvas>
   =========================================================== */
(function (root) {
  'use strict';

  // ECC level M tables, indexed by version (1..10)
  const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const MAX_VERSION = 10;

  // ---- GF(256) arithmetic (poly 0x11D) ----
  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }
  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let r = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], r);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      r = gfMul(r, 2);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
    }
    return result;
  }

  function rawDataModules(ver) {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const n = Math.floor(ver / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  const dataCodewords = (ver) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

  function utf8Bytes(str) {
    return Array.from(new TextEncoder().encode(str));
  }

  function alignPositions(ver) {
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2;
    const size = ver * 4 + 17;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const res = [6];
    for (let pos = size - 7; res.length < n; pos -= step) res.splice(1, 0, pos);
    return res;
  }

  const bit = (x, i) => ((x >>> i) & 1) !== 0;

  function encode(text) {
    const bytes = utf8Bytes(String(text));
    // pick the smallest version that fits
    let ver = 1;
    for (; ver <= MAX_VERSION; ver++) {
      const ccBits = ver < 10 ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
    }
    if (ver > MAX_VERSION) throw new Error('QR: text too long (max 213 bytes)');

    // ---- bit stream ----
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(0x4, 4);
    push(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach((b) => push(b, 8));
    const capBits = dataCodewords(ver) * 8;
    push(0, Math.min(4, capBits - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) push(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      data.push(v);
    }

    // ---- error correction + interleave ----
    const nb = NUM_BLOCKS[ver];
    const eccLen = ECC_PER_BLOCK[ver];
    const raw = Math.floor(rawDataModules(ver) / 8);
    const numShort = nb - (raw % nb);
    const shortLen = Math.floor(raw / nb);
    const div = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const codewords = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((blk, j) => {
        if (i !== shortLen - eccLen || j >= numShort) codewords.push(blk[i]);
      });
    }

    // ---- draw function patterns ----
    const size = ver * 4 + 17;
    const mods = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (x, y, dark) => { mods[y][x] = dark; isFn[y][x] = true; };

    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
        }
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const ap = alignPositions(ver);
    for (let i = 0; i < ap.length; i++) {
      for (let j = 0; j < ap.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) setFn(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    const drawFormat = (mask) => {
      const d = (0 << 3) | mask; // ECC level M = 0b00
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((d << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) setFn(8, i, bit(b, i));
      setFn(8, 7, bit(b, 6)); setFn(8, 8, bit(b, 7)); setFn(7, 8, bit(b, 8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(b, i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(b, i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(b, i));
      setFn(8, size - 8, true);
    };
    drawFormat(0); // reserve areas
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3), c = Math.floor(i / 3);
        setFn(a, c, bit(b, i)); setFn(c, a, bit(b, i));
      }
    }

    // ---- place data bits in zig-zag ----
    let idx = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && idx < codewords.length * 8) {
            mods[y][x] = bit(codewords[idx >>> 3], 7 - (idx & 7));
            idx++;
          }
        }
      }
    }

    // ---- pick best mask ----
    const maskFn = [
      (x, y) => (x + y) % 2 === 0,
      (x, y) => y % 2 === 0,
      (x, y) => x % 3 === 0,
      (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
      (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    const applyMask = (m) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && maskFn[m](x, y)) mods[y][x] = !mods[y][x];
    };
    let best = 0, bestPen = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const pen = penalty(mods, size);
      if (pen < bestPen) { bestPen = pen; best = m; }
      applyMask(m); // undo (XOR)
    }
    applyMask(best);
    drawFormat(best);
    return { size, version: ver, mask: best, modules: mods };
  }

  function penalty(m, size) {
    let result = 0;
    // N1: runs of 5+ (rows and columns)
    for (let a = 0; a < size; a++) {
      for (const horiz of [true, false]) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          const cur = horiz ? m[a][b] : m[b][a];
          const prev = horiz ? m[a][b - 1] : m[b - 1][a];
          if (cur === prev) { run++; if (run === 5) result += 3; else if (run > 5) result += 1; } else run = 1;
        }
      }
    }
    // N2: 2x2 blocks
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
    }
    // N3: finder-like patterns
    const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let a = 0; a < size; a++) {
      for (let b = 0; b <= size - 11; b++) {
        for (const horiz of [true, false]) {
          let ok1 = true, ok2 = true;
          for (let k = 0; k < 11 && (ok1 || ok2); k++) {
            const v = (horiz ? m[a][b + k] : m[b + k][a]) ? 1 : 0;
            if (v !== p1[k]) ok1 = false;
            if (v !== p2[k]) ok2 = false;
          }
          if (ok1) result += 40;
          if (ok2) result += 40;
        }
      }
    }
    // N4: dark/light balance
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  }

  function draw(canvas, text, opt) {
    const o = Object.assign({ scale: 6, margin: 4, dark: '#000000', light: '#ffffff' }, opt || {});
    const qr = encode(text);
    const px = (qr.size + o.margin * 2) * o.scale;
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = o.light;
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = o.dark;
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) ctx.fillRect((x + o.margin) * o.scale, (y + o.margin) * o.scale, o.scale, o.scale);
      }
    }
    return qr;
  }

  const api = { encode, draw };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QR = api;
})(typeof window !== 'undefined' ? window : globalThis);
