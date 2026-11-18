// SHA-256 for backups. Small inputs use the browser's crypto.subtle; big ones (a library.json of tens of
// megabytes) are hashed here in slices, awaiting `pause()` between them, because crypto.subtle.digest()
// copies its whole input on the page's thread in one go (a 60 MB input blocked the page for ~90 ms).
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function blocks(H, W, b, off, end) {
  let a0 = H[0], a1 = H[1], a2 = H[2], a3 = H[3], a4 = H[4], a5 = H[5], a6 = H[6], a7 = H[7];
  for (let p = off; p < end; p += 64) {
    for (let i = 0; i < 16; i++) { const j = p + i * 4; W[i] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3]; }
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15], y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = a0, bb = a1, c = a2, d = a3, e = a4, f = a5, g = a6, h = a7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    a0 = (a0 + a) | 0; a1 = (a1 + bb) | 0; a2 = (a2 + c) | 0; a3 = (a3 + d) | 0;
    a4 = (a4 + e) | 0; a5 = (a5 + f) | 0; a6 = (a6 + g) | 0; a7 = (a7 + h) | 0;
  }
  H[0] = a0; H[1] = a1; H[2] = a2; H[3] = a3; H[4] = a4; H[5] = a5; H[6] = a6; H[7] = a7;
}

const hex = H => Array.from(H, v => (v >>> 0).toString(16).padStart(8, '0')).join('');
const SLICE = 128 * 1024;          // a multiple of 64
const SMALL = 1024 * 1024;

/** SHA-256 of bytes as hex, in slices (pure JS). */
export async function sha256Js(bytes, pause) {
  const H = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Int32Array(64);
  const full = bytes.length - (bytes.length % 64);
  for (let off = 0; off < full; off += SLICE) {
    blocks(H, W, bytes, off, Math.min(full, off + SLICE));
    if (pause && off + SLICE < full) await pause();
  }
  const rest = bytes.length - full;
  const tail = new Uint8Array(rest < 56 ? 64 : 128);
  tail.set(bytes.subarray(full));
  tail[rest] = 0x80;
  const bits = bytes.length * 8;
  const dv = new DataView(tail.buffer);
  dv.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(tail.length - 4, bits >>> 0);
  blocks(H, W, tail, 0, tail.length);
  return hex(H);
}

/** SHA-256 hex: crypto.subtle for small inputs, sliced JS for big ones. */
export async function sha256(bytes, pause) {
  if (bytes.length <= SMALL && typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256Js(bytes, pause);
}
