// Generates build/icon.png (512x512): the board glyph on the app's dark tile. No dependencies.
// usage: node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const N = 512;
const px = Buffer.alloc(N * N * 4);
const inRound = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r - 1);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r - 1);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
// Three kanban columns of different heights on the dark tile.
const cols = [
  [112, 150, 200, 400],
  [212, 150, 300, 330],
  [312, 150, 400, 250],
];
for (let y = 0; y < N; y++)
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    let c = null;
    if (inRound(x, y, 0, 0, N, N, 96)) c = [10, 10, 16, 255];
    if (c && cols.some(([a, b, cc, d]) => inRound(x, y, a, b, cc, d, 18))) c = [130, 134, 255, 255];
    if (c) px.set(c, i);
  }

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => {
  let c = 0xffffffff;
  for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const t = Buffer.from(type);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  t.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc(Buffer.concat([t, data])), 8 + data.length);
  return out;
};
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr.set([8, 6, 0, 0, 0], 8);
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
