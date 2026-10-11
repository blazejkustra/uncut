// Draws Uncut's app icon (1024×1024 PNG) and builds build/icon.icns with sips + iconutil.
// A dark rounded tile with a white "U" whose left arm has a clean diagonal cut: an edit.
// Run: node apps/desktop/scripts/make-icon.ts (the outputs are committed; rerun to change).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const out = new URL("../build/", import.meta.url).pathname;
const SIZE = 1024;
const SS = 3; // supersampling per axis, for smooth edges

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
// Signed distance to a rounded rectangle centred at (cx, cy).
const roundRect = (x: number, y: number, cx: number, cy: number, hw: number, hh: number, r: number) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const segment = (x: number, y: number, ax: number, ay: number, bx: number, by: number) => {
  const t = clamp(((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2), 0, 1);
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
};

// The U: two arms and a half circle, as a centre line with a thick stroke and round caps.
const L = 368, R = 656, TOP = 318, BEND = 560, STROKE = 64;
const CX = (L + R) / 2, RAD = (R - L) / 2;
const uDistance = (x: number, y: number) => {
  let d = Math.min(segment(x, y, L, TOP, L, BEND), segment(x, y, R, TOP, R, BEND));
  if (y >= BEND) d = Math.min(d, Math.abs(Math.hypot(x - CX, y - BEND) - RAD));
  return d - STROKE;
};
// The cut: a thin diagonal band through the left arm.
const cutAngle = (-28 * Math.PI) / 180;
const cut = (x: number, y: number) => Math.abs((x - L) * Math.sin(cutAngle) - (y - 455) * Math.cos(cutAngle)) < 13 && x < CX;

const px = Buffer.alloc(SIZE * SIZE * 4);
for (let j = 0; j < SIZE; j++) {
  for (let i = 0; i < SIZE; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = i + (sx + 0.5) / SS;
        const y = j + (sy + 0.5) / SS;
        // macOS icon grid: an 824 px tile with ~185 px corners, centred.
        if (roundRect(x, y, 512, 512, 412, 412, 185) > 0) continue;
        const shade = 30 - (y - 100) / 824 * 16; // #1e → #0e, top to bottom
        let cr = shade, cg = shade, cb = shade + 1;
        if (uDistance(x, y) <= 0 && !cut(x, y)) [cr, cg, cb] = [242, 241, 238];
        r += cr; g += cg; b += cb; a += 255;
      }
    }
    const n = SS * SS;
    const o = (j * SIZE + i) * 4;
    const cover = a / n;
    // Colours are averaged over covered samples only, alpha carries the edge.
    const k = a ? n / (a / 255) : 0;
    px[o] = Math.round((r / n) * k);
    px[o + 1] = Math.round((g / n) * k);
    px[o + 2] = Math.round((b / n) * k);
    px[o + 3] = Math.round(cover);
  }
}

// Minimal PNG writer: RGBA, filter 0 per row.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr.set([8, 6, 0, 0, 0], 8);
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let j = 0; j < SIZE; j++) px.copy(raw, j * (SIZE * 4 + 1) + 1, j * SIZE * 4, (j + 1) * SIZE * 4);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);

mkdirSync(out, { recursive: true });
writeFileSync(`${out}icon.png`, png);
const set = `${out}icon.iconset`;
rmSync(set, { recursive: true, force: true });
mkdirSync(set);
for (const s of [16, 32, 128, 256, 512]) {
  execFileSync("sips", ["-z", String(s), String(s), `${out}icon.png`, "--out", `${set}/icon_${s}x${s}.png`], { stdio: "ignore" });
  execFileSync("sips", ["-z", String(s * 2), String(s * 2), `${out}icon.png`, "--out", `${set}/icon_${s}x${s}@2x.png`], { stdio: "ignore" });
}
execFileSync("iconutil", ["-c", "icns", set, "-o", `${out}icon.icns`]);
rmSync(set, { recursive: true, force: true });
console.log(`wrote ${out}icon.png and ${out}icon.icns`);
