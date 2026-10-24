// Clip looks and effects in the export (D136): exportCommand's graph through ffmpeg, frame by frame
// against core's maths on the same decoded source frame. Colours.mp4 (test/helpers/fx-fixture.ts,
// 640×360, static, colour blocks and hard edges) is one
// clip on a 640×360 canvas; the graph's last step is made 4:4:4 (the export's own 4:2:0 would
// blur colour edges here, the same for both), its frame 10 read back as RGB.
// Measured (mean |Δ| in 0–255 over every channel and pixel / its 99th percentile; 2026-10-14):
// the source with no effects through the export's plain path 1.38/8.5 (the 8-bit YUV round trip
// and chroma upsampling: the floor for everything below); the 16 looks 1.10–1.51/3.0–8.3, Adjust
// with a look and invert 1.53/6.6 (core's table read by lut3d trilinear); mirror 1.45/8.5, RGB
// split 1.46/8.5, pixelate ≈ the floor; sharpen 2.13/14.9 (it multiplies the floor's noise by
// 1 + 4a); glow against a true Gaussian 1.58/7.0; shake against a bilinear resample of the moved
// window 1.41/7.4; posterize 1.9 % of values a band off (a band edge moves with a level of input).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clipFx, colourLut, cubeText, lutAt, LOOKS, posterize, shakeWindow, shakeZoom, type Item, type Project } from "../../packages/core/src/index.ts";
import { exportCommand, planExport, planLuts, silentFailure } from "../../apps/server/src/export/exportPlan.ts";
import { makeColours } from "../helpers/fx-fixture.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = hasFfmpeg ? false : "needs ffmpeg";
const W = 640;
const H = 360;
const FRAME = 10;
let dir = "";
let source: Float64Array;

before(() => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "uncut-fx-export-"));
  makeColours(join(dir, "Colours.mp4"));
  source = readRgb(join(dir, "Colours.mp4"), FRAME, "scale=out_range=pc:in_color_matrix=bt709:in_range=tv,format=rgb48le");
});
after(() => dir && rmSync(dir, { recursive: true, force: true }));

/** Frame n of a file as RGB 0–1 floats (W × H × 3). */
function readRgb(file: string, n: number, vf: string): Float64Array {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n}),${vf}`, "-frames:v", "1", "-f", "rawvideo", "-"], {
    maxBuffer: 64 << 20,
  });
  const out = new Float64Array(W * H * 3);
  for (let i = 0; i < out.length; i++) out[i] = raw.readUInt16LE(i * 2) / 65535;
  return out;
}

function project(effects: Item["effects"], still?: string): Project {
  if (still) {
    const p = project(effects);
    return {
      ...p,
      media: [{ id: "m-c", kind: "image", name: still, path: join(dir, still), probe: { width: W, height: H } }],
      tracks: [{ ...p.tracks[0]!, items: [{ id: "c1", type: "clip", media: "m-c", duration: 30, ...(effects ? { effects } : {}) }] }],
    };
  }
  return {
    format: "uncut/0",
    name: "Fx",
    canvas: { width: W, height: H, fps: 30, background: "#808080" },
    media: [
      { id: "m-c", kind: "video", name: "Colours.mp4", path: join(dir, "Colours.mp4"), probe: { frames: 60, fps: 30, width: W, height: H, hasAudio: false } },
    ],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [{ id: "c1", type: "clip", media: "m-c", in: 0, duration: 30, ...(effects ? { effects } : {}) }],
      },
    ],
  };
}

/** The export's frame for `effects`, as RGB 0–1 (the graph's last 4:2:0 step made 4:4:4). */
function exported(name: string, effects: Item["effects"], still?: string): Float64Array {
  const plan = planExport(project(effects, still), { mediaPath: (m) => m.path, width: W, height: H });
  if ("problem" in plan) throw new Error(plan.problem);
  const luts = new Map<string, string>();
  for (const lut of planLuts(plan)) {
    const file = join(dir, `lut-${lut.key}.cube`);
    writeFileSync(file, cubeText(lut));
    luts.set(lut.key, file);
  }
  const bg = join(dir, "bg.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x808080:s=${W}x${H}`, "-frames:v", "1", bg]);
  const cmd = exportCommand(plan, {
    background: bg,
    rasters: new Map(),
    caps: { encoders: new Set(["libx264"]), videotoolboxDecode: false, major: 8 },
    quality: "high",
    output: join(dir, `${name}.mp4`),
    luts,
  });
  const graph = cmd.graph.replace(/format=yuv420p,fps=30,trim=end_frame=(\d+)\[vout\]/, "format=yuv444p,fps=30,trim=end_frame=$1[vout]");
  writeFileSync(join(dir, `${name}.txt`), graph);
  const png = join(dir, `${name}.mkv`);
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      ...cmd.inputs,
      "-/filter_complex",
      join(dir, `${name}.txt`),
      "-map",
      "[vout]",
      "-c:v",
      "ffv1",
      "-pix_fmt",
      "yuv444p",
      "-frames:v",
      String(FRAME + 1),
      png,
      "-map",
      "[aout]",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, `${name}: ${r.stderr.slice(-1200)}`);
  assert.equal(silentFailure(r.stderr), undefined);
  return readRgb(png, FRAME, "scale=out_range=pc:in_color_matrix=bt709:in_range=tv,format=rgb48le");
}

const px = (img: Float64Array, x: number, y: number, c: number) => img[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 3 + c]!;
/** A reference made pixel by pixel. */
const make = (f: (x: number, y: number, c: number) => number) => {
  const out = new Float64Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) out[(y * W + x) * 3 + c] = f(x, y, c);
  return out;
};
const mapRgb = (img: Float64Array, f: (r: number, g: number, b: number) => readonly [number, number, number]) => {
  const out = new Float64Array(img.length);
  for (let i = 0; i < img.length; i += 3) {
    const v = f(img[i]!, img[i + 1]!, img[i + 2]!);
    out[i] = v[0];
    out[i + 1] = v[1];
    out[i + 2] = v[2];
  }
  return out;
};
/** Mean and 99th percentile of |a − b| in 0–255 (a 4 px border left out: edge handling differs by design). */
function diff(a: Float64Array, b: Float64Array) {
  const d: Array<number> = [];
  for (let y = 4; y < H - 4; y++)
    for (let x = 4; x < W - 4; x++) for (let c = 0; c < 3; c++) d.push(Math.abs(a[(y * W + x) * 3 + c]! - b[(y * W + x) * 3 + c]!) * 255);
  d.sort((p, q) => p - q);
  return { mean: d.reduce((s, v) => s + v, 0) / d.length, p99: d[Math.floor(d.length * 0.99)]!, over10: d.filter((v) => v > 10).length / d.length };
}
const report: Array<string> = [];
const check = (name: string, got: Float64Array, want: Float64Array, mean: number, p99: number) => {
  const r = diff(got, want);
  report.push(`${name} ${r.mean.toFixed(2)}/${r.p99.toFixed(1)}`);
  assert.ok(r.mean <= mean && r.p99 <= p99, `${name}: mean ${r.mean.toFixed(2)} (≤ ${mean}), p99 ${r.p99.toFixed(1)} (≤ ${p99})`);
};
/** Posterize: band edges move with a level of input difference, so it's the share of values a band off (> 10) that's checked. */
const checkBands = (name: string, got: Float64Array, want: Float64Array, share: number) => {
  const r = diff(got, want);
  report.push(`${name} ${r.mean.toFixed(2)}/${(r.over10 * 100).toFixed(2)}% a band off`);
  assert.ok(r.over10 <= share, `${name}: ${(r.over10 * 100).toFixed(2)}% of values a band off (≤ ${share * 100}%)`);
};
after(() => report.length && console.log(`  export vs core (mean/p99, 0–255): ${report.join(", ")}`));

test("D136: no effects draws the source (the reference path is honest)", { skip }, () => {
  check("none", exported("none", undefined), source, 1.5, 9);
});

test("D136: every look, and Adjust, export as core's colour table (lut3d trilinear on the decoded picture)", { skip, timeout: 300000 }, () => {
  for (const l of LOOKS) {
    const effects: Item["effects"] = [{ module: "effect.look", params: { look: l.id, intensity: 1 } }];
    const lut = colourLut(clipFx({ type: "clip", effects })!.colour!);
    check(
      `look ${l.id}`,
      exported(`look-${l.id}`, effects),
      mapRgb(source, (r, g, b) => lutAt(lut, r, g, b)),
      2,
      9,
    );
  }
  const adjust: Item["effects"] = [
    { module: "effect.look", params: { look: "film", intensity: 0.6 } },
    {
      module: "effect.color",
      params: { exposure: 0.4, contrast: 0.2, saturation: -0.3, temperature: 0.5, tint: -0.2, highlights: -0.4, shadows: 0.5, vibrance: 0.6 },
    },
    { module: "effect.invert" },
  ];
  const lut = colourLut(clipFx({ type: "clip", effects: adjust })!.colour!);
  check(
    "adjust+invert",
    exported("adjust", adjust),
    mapRgb(source, (r, g, b) => lutAt(lut, r, g, b)),
    2,
    9,
  );
});

test("D136: posterize, mirror, RGB split, sharpen and pixelate export as core defines them", { skip, timeout: 300000 }, () => {
  checkBands(
    "posterize",
    exported("posterize", [{ module: "effect.posterize", params: { levels: 4 } }]),
    mapRgb(source, (r, g, b) => [posterize(r, 4), posterize(g, 4), posterize(b, 4)]),
    0.03,
  );
  check(
    "mirror",
    exported("mirror", [{ module: "effect.mirror" }]),
    make((x, y, c) => px(source, W - 1 - x, y, c)),
    1.5,
    9,
  );
  check(
    "rgb-split",
    exported("rgb-split", [{ module: "effect.rgb-split", params: { amount: 7 } }]),
    make((x, y, c) => px(source, c === 0 ? x - 7 : c === 2 ? x + 7 : x, y, c)),
    1.5,
    9,
  );
  // Sharpen: 1 + 4a in the middle, −a on four sides (a in 16ths), mirrored edges.
  const a = 10 / 16;
  check(
    "sharpen",
    exported("sharpen", [{ module: "effect.sharpen", params: { amount: 0.6 } }]),
    make((x, y, c) =>
      Math.min(
        1,
        Math.max(
          0,
          (1 + 4 * a) * px(source, x, y, c) - a * (px(source, x - 1, y, c) + px(source, x + 1, y, c) + px(source, x, y - 1, c) + px(source, x, y + 1, c)),
        ),
      ),
    ),
    2.5,
    18,
  );
  const B = 12;
  check(
    "pixelate",
    exported("pixelate", [{ module: "effect.pixelate", params: { size: B } }]),
    make((x, y, c) => {
      const x0 = Math.floor(x / B) * B;
      const y0 = Math.floor(y / B) * B;
      let s = 0;
      let k = 0;
      for (let j = y0; j < Math.min(H, y0 + B); j++) for (let i = x0; i < Math.min(W, x0 + B); i++) ((s += px(source, i, j, c)), k++);
      return s / k;
    }),
    1.5,
    9,
  );
});

test(
  "D136: glow (a thresholded copy, Gaussian-blurred, screened) and shake (a moved window of the zoomed picture) export close to core's maths",
  { skip, timeout: 300000 },
  () => {
    const g = { amount: 0.8, threshold: 0.5, radius: 6 };
    const thr = make((x, y, c) => Math.min(1, Math.max(0, (px(source, x, y, c) - g.threshold) / (1 - g.threshold))) * g.amount);
    const r = Math.ceil(3 * g.radius);
    const w = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-0.5 * ((i - r) / g.radius) ** 2));
    const ws = w.reduce((s, v) => s + v, 0);
    const blurH = make((x, y, c) => w.reduce((s, v, i) => s + v * px(thr, x + i - r, y, c), 0) / ws);
    const blurred = make((x, y, c) => w.reduce((s, v, i) => s + v * px(blurH, x, y + i - r, c), 0) / ws);
    check(
      "glow",
      exported("glow", [{ module: "effect.glow", params: g }]),
      make((x, y, c) => 1 - (1 - px(source, x, y, c)) * (1 - px(blurred, x, y, c))),
      3,
      14,
    );
    const shake = { amount: 10, speed: 2 };
    const z = shakeZoom(shake.amount, W, H);
    const zw = Math.round(W * z);
    const zh = Math.round(H * z);
    const o = shakeWindow(shake, FRAME / 30, W, H, zw, zh);
    const bilinear = (u: number, v: number, c: number) => {
      const x = u - 0.5;
      const y = v - 0.5;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      return (
        (px(source, x0, y0, c) * (1 - fx) + px(source, x0 + 1, y0, c) * fx) * (1 - fy) +
        (px(source, x0, y0 + 1, c) * (1 - fx) + px(source, x0 + 1, y0 + 1, c) * fx) * fy
      );
    };
    check(
      "shake",
      exported("shake", [{ module: "effect.shake", params: shake }]),
      make((x, y, c) => bilinear(((x + o.x + 0.5) * W) / zw, ((y + o.y + 0.5) * H) / zh, c)),
      4,
      40,
    );
  },
);

test("D136 review: a half-transparent still keeps its alpha through the effects (16-bit RGB with alpha)", { skip, timeout: 120000 }, () => {
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    join(dir, "Colours.mp4"),
    "-vf",
    "select=eq(n\\,10),scale=in_color_matrix=bt709:in_range=tv,format=rgba,colorchannelmixer=aa=0.5",
    "-frames:v",
    "1",
    join(dir, "Half.png"),
  ]);
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", join(dir, "Half.png"), "-vf", "format=rgba64le", "-f", "rawvideo", "-"], { maxBuffer: 64 << 20 });
  const effects: Item["effects"] = [
    { module: "effect.look", params: { look: "teal-orange", intensity: 1 } },
    { module: "effect.sharpen", params: { amount: 0.4 } },
    { module: "effect.glow" },
  ];
  const lut = colourLut(clipFx({ type: "clip", effects })!.colour!);
  const got = exported("half", [{ module: "effect.look", params: { look: "teal-orange", intensity: 1 } }], "Half.png");
  // Over the grey canvas: half the look's colour, half grey (and nowhere near the opaque colour).
  const grey = 128 / 255;
  const want = make((x, y, c) => {
    const i = (y * W + x) * 4;
    const a = raw.readUInt16LE((i + 3) * 2) / 65535;
    const v = lutAt(lut, raw.readUInt16LE(i * 2) / 65535, raw.readUInt16LE((i + 1) * 2) / 65535, raw.readUInt16LE((i + 2) * 2) / 65535)[c]!;
    return v * a + grey * (1 - a);
  });
  check("half-transparent look", got, want, 2, 9);
  // With sharpen and glow too, the alpha still holds: the picture stays half grey.
  const all = exported("half-all", effects, "Half.png");
  let mean = 0;
  for (let i = 0; i < all.length; i++) mean += Math.abs(all[i]! - grey);
  assert.ok(mean / all.length < 0.3, "half grey, not opaque");
});
