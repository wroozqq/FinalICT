'use strict';
// Minimal QR Code generator (ISO/IEC 18004), byte mode, error correction level M,
// versions 1-6 (up to 106 bytes - enough for a check-in URL). Output: SVG text.
// Written for this project so the app needs no external packages.
// Algorithm follows the public QR specification (finder/timing/alignment patterns,
// Reed-Solomon error correction over GF(256), zig-zag data placement, mask 0).

// Per version (index = version): total codewords, EC codewords per block, number of blocks (level M)
const TABLE = [null,
  { total: 26, ec: 10, blocks: 1, align: [] },
  { total: 44, ec: 16, blocks: 1, align: [6, 18] },
  { total: 70, ec: 26, blocks: 1, align: [6, 22] },
  { total: 100, ec: 18, blocks: 2, align: [6, 26] },
  { total: 134, ec: 24, blocks: 2, align: [6, 30] },
  { total: 172, ec: 16, blocks: 4, align: [6, 34] },
];

function gfMul(x, y) { // multiplication in GF(2^8) with polynomial 0x11D
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
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
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

function encode(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  let version = 0;
  for (let v = 1; v <= 6; v++) {
    const dataCodewords = TABLE[v].total - TABLE[v].ec * TABLE[v].blocks;
    if (4 + 8 + bytes.length * 8 <= dataCodewords * 8) { version = v; break; }
  }
  if (!version) throw new Error('Text too long for QR versions 1-6');
  const info = TABLE[version];
  const dataLen = info.total - info.ec * info.blocks;

  // 1. Bit stream: mode (0100 = byte), length (8 bits), data, terminator, padding
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  bytes.forEach((b) => push(b, 8));
  push(0, Math.min(4, dataLen * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < dataLen; pad ^= 0xec ^ 0x11) data.push(pad);

  // 2. Split into blocks, add Reed-Solomon codewords, interleave
  const blockLen = dataLen / info.blocks;
  const divisor = rsDivisor(info.ec);
  const blocks = [];
  for (let b = 0; b < info.blocks; b++) {
    const d = data.slice(b * blockLen, (b + 1) * blockLen);
    blocks.push({ d, e: rsRemainder(d, divisor) });
  }
  const codewords = [];
  for (let i = 0; i < blockLen; i++) blocks.forEach((bl) => codewords.push(bl.d[i]));
  for (let i = 0; i < info.ec; i++) blocks.forEach((bl) => codewords.push(bl.e[i]));

  // 3. Matrix with function patterns
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // timing
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {                // finders
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, dist !== 2 && dist !== 4);
    }
  }
  const al = info.align;                                                            // alignment
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const MASK = 0;
  const drawFormat = () => {
    const d = (0b00 << 3) | MASK; // level M = 00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412;
    const bit = (i) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true); // dark module
  };
  drawFormat();

  // 4. Zig-zag data placement
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && k < codewords.length * 8) {
          m[y][x] = ((codewords[k >>> 3] >>> (7 - (k & 7))) & 1) === 1;
          k++;
        }
      }
    }
  }
  // 5. Mask 0: invert data modules where (x + y) is even
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!fn[y][x] && (x + y) % 2 === 0) m[y][x] = !m[y][x];
  }
  return m;
}

function toSvg(text, scale = 8) {
  const m = encode(text);
  const q = 4; // quiet zone
  const n = m.length + q * 2;
  let path = '';
  m.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x + q},${y + q}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * scale}" height="${n * scale}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

module.exports = { encode, toSvg };
