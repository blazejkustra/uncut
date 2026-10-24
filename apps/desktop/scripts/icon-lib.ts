// Shared by make-icon.ts (the app icon) and make-project-icon.ts (the .uncut project icon, D252):
// shape distances, Uncut's "U with a cut", a supersampled rasteriser, a PNG writer and the iconset
// to .icns step (sips + iconutil).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

export const SIZE = 1024;
const SS = 3; // supersampling per axis, for smooth edges

export type Rgb = readonly [number, number, number];

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
// Signed distance to a rounded rectangle centred at (cx, cy).
export const roundRect = (x: number, y: number, cx: number, cy: number, hw: number, hh: number, r: number) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
export const segment = (x: number, y: number, ax: number, ay: number, bx: number, by: number) => {
  const t = clamp(((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2), 0, 1);
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
};

// The U on the app icon's 1024 grid: two arms and a half circle, as a centre line with a thick
// stroke and round caps; the cut is a thin diagonal band through the left arm.
const L = 368,
  R = 656,
  TOP = 318,
  BEND = 560,
  STROKE = 64;
const CX = (L + R) / 2,
  RAD = (R - L) / 2;
const cutAngle = (-28 * Math.PI) / 180;
/** Whether (x, y), in app-icon grid units, is on the white U (not in its cut). */
export const onU = (x: number, y: number) => {
  let d = Math.min(segment(x, y, L, TOP, L, BEND), segment(x, y, R, TOP, R, BEND));
  if (y >= BEND) d = Math.min(d, Math.abs(Math.hypot(x - CX, y - BEND) - RAD));
  const cut = Math.abs((x - L) * Math.sin(cutAngle) - (y - 455) * Math.cos(cutAngle)) < 13 && x < CX;
  return d - STROKE <= 0 && !cut;
};
export const U_WHITE: Rgb = [242, 241, 238];

/**
 * Rasterises a width×height (default SIZE×SIZE) RGBA image: `colour(x, y)` gives the colour at a point, or undefined where
 * the icon is transparent. Colours are averaged over covered samples only; alpha carries the edge.
 */
export function rasterize(colour: (x: number, y: number) => Rgb | undefined, width = SIZE, height = SIZE): Buffer {
  const px = Buffer.alloc(width * height * 4);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colour(i + (sx + 0.5) / SS, j + (sy + 0.5) / SS);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }
      const n = SS * SS;
      const o = (j * width + i) * 4;
      const k = a ? n / (a / 255) : 0;
      px[o] = Math.round((r / n) * k);
      px[o + 1] = Math.round((g / n) * k);
      px[o + 2] = Math.round((b / n) * k);
      px[o + 3] = Math.round(a / n);
    }
  }
  return px;
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
export function encodePng(px: Buffer, width = SIZE, height = SIZE): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const row = width * 4;
  const raw = Buffer.alloc(height * (row + 1));
  for (let j = 0; j < height; j++) px.copy(raw, j * (row + 1) + 1, j * row, (j + 1) * row);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Writes <dir><name>.png and <dir><name>.icns (every size macOS asks for, made with sips + iconutil). */
export function writeIcon(dir: string, name: string, png: Buffer) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${name}.png`, png);
  const set = `${dir}${name}.iconset`;
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    execFileSync("sips", ["-z", String(s), String(s), `${dir}${name}.png`, "--out", `${set}/icon_${s}x${s}.png`], { stdio: "ignore" });
    execFileSync("sips", ["-z", String(s * 2), String(s * 2), `${dir}${name}.png`, "--out", `${set}/icon_${s}x${s}@2x.png`], { stdio: "ignore" });
  }
  execFileSync("iconutil", ["-c", "icns", set, "-o", `${dir}${name}.icns`]);
  rmSync(set, { recursive: true, force: true });
  console.log(`wrote ${dir}${name}.png and ${dir}${name}.icns`);
}
