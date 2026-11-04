// Chroma key, blend modes and shape masks in the export (D326): exportCommand's graph through
// ffmpeg, pixel by pixel against core's maths (keyAlpha, despill, blendChannel, maskCoverage) on the
// same decoded source frames. Small synthetic clips (320×180, 1 s, lossless 4:4:4), ffmpeg capped
// at two threads.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  blendChannel,
  clipFx,
  despill,
  keyAlpha,
  maskAt,
  maskCoverage,
  type BlendMode,
  type Item,
  type Project,
  type Track,
} from "../../packages/core/src/index.ts";
import { exportCommand, planExport, silentFailure } from "../../apps/server/src/export/exportPlan.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = hasFfmpeg ? false : "needs ffmpeg";
const W = 320;
const H = 180;
const FRAME = 10;
const CAP = ["-threads", "2", "-filter_threads", "2", "-filter_complex_threads", "2"];
let dir = "";

/** A lossless BT.709 clip from a lavfi source (rgb24 drawing). */
function clip(name: string, draw: string) {
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    ...CAP,
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${W}x${H}:r=30:d=1,format=rgb24,${draw}`,
    "-vf",
    "scale=out_color_matrix=bt709:out_range=tv,format=yuv444p",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-c:v",
    "ffv1",
    join(dir, name),
  ]);
}

/** Frame n of a file as RGB 0–1 floats (W × H × 3). */
function readRgb(file: string, n = FRAME): Float64Array {
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      ...CAP,
      "-i",
      file,
      "-vf",
      `select=eq(n\\,${n}),scale=out_range=pc:in_color_matrix=bt709:in_range=tv,format=rgb48le`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: 16 << 20 },
  );
  const out = new Float64Array(W * H * 3);
  for (let i = 0; i < out.length; i++) out[i] = raw.readUInt16LE(i * 2) / 65535;
  return out;
}

before(() => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "uncut-matte-export-"));
  // A red subject and a pale green one (spill to pull off) on a green screen, softened edges between.
  clip(
    "screen.mkv",
    "geq=r='if(between(X,40,119)*between(Y,40,139),240,if(between(X,180,279)*between(Y,40,139),128,0))':g='if(between(X,40,119)*between(Y,40,139),32,if(between(X,180,279)*between(Y,40,139),204,255))':b='if(between(X,40,119)*between(Y,40,139),32,if(between(X,180,279)*between(Y,40,139),128,0))',gblur=sigma=1.5",
  );
  // A colourful backdrop: a hue sweep left to right, dark to light top to bottom.
  clip(
    "back.mkv",
    "geq=r='255*clip(abs(6*X/W-3)-1,0,1)*(0.2+0.8*Y/H)':g='255*clip(2-abs(6*X/W-2),0,1)*(0.2+0.8*Y/H)':b='255*clip(2-abs(6*X/W-4),0,1)*(0.2+0.8*Y/H)'",
  );
  // A light-leak-like layer: a warm diagonal ramp.
  clip("leak.mkv", "geq=r='255*(0.3+0.7*X/W)':g='255*(0.2+0.6*Y/H)':b='255*0.35*(1-X/W)'");
  clip("red.mkv", "geq=r=230:g=40:b=40");
});
after(() => dir && rmSync(dir, { recursive: true, force: true }));

const media = (id: string, file: string) => ({
  id,
  kind: "video" as const,
  name: file,
  path: join(dir, file),
  probe: { frames: 30, fps: 30, width: W, height: H, hasAudio: false },
});

/** `top` (its effects and keys) over `under` on the main track. */
function project(top: string, under: string, effects: Item["effects"], keys?: Item["keys"]): Project {
  const tracks: Array<Track> = [
    {
      id: "top",
      kind: "video",
      name: "Top",
      items: [{ id: "t1", type: "clip", media: "m-top", start: 0, in: 0, duration: 30, effects, ...(keys ? { keys } : {}) }],
    },
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "u1", type: "clip", media: "m-under", in: 0, duration: 30 }] },
  ];
  return {
    format: "uncut/0",
    name: "Matte",
    canvas: { width: W, height: H, fps: 30, background: "#000000" },
    media: [media("m-top", top), media("m-under", under)],
    tracks,
  };
}

/** The export's frame, as RGB 0–1 (the graph's last 4:2:0 step made 4:4:4). */
function exported(name: string, p: Project): Float64Array {
  const plan = planExport(p, { mediaPath: (m) => m.path, width: W, height: H });
  if ("problem" in plan) throw new Error(plan.problem);
  const bg = join(dir, "bg.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}`, "-frames:v", "1", bg]);
  const cmd = exportCommand(plan, {
    background: bg,
    rasters: new Map(),
    caps: { encoders: new Set(["libx264"]), videotoolboxDecode: false, major: 8 },
    quality: "high",
    output: join(dir, `${name}.mp4`),
  });
  const graph = cmd.graph.replace(/format=yuv420p,fps=30,trim=end_frame=(\d+)\[vout\]/, "format=yuv444p,fps=30,trim=end_frame=$1[vout]");
  writeFileSync(join(dir, `${name}.txt`), graph);
  const out = join(dir, `${name}.mkv`);
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      ...CAP,
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
      out,
      "-map",
      "[aout]",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, `${name}: ${r.stderr.slice(-1500)}`);
  assert.equal(silentFailure(r.stderr), undefined);
  return readRgb(out);
}

const at = (img: Float64Array, x: number, y: number): [number, number, number] => {
  const i = (y * W + x) * 3;
  return [img[i]!, img[i + 1]!, img[i + 2]!];
};
/** A reference made pixel by pixel from the two decoded sources. */
function make(
  f: (x: number, y: number, top: [number, number, number], under: [number, number, number]) => readonly [number, number, number],
  top: Float64Array,
  under: Float64Array,
) {
  const out = new Float64Array(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = f(x, y, at(top, x, y), at(under, x, y));
      out.set(v, (y * W + x) * 3);
    }
  return out;
}
/** Mean and 99th percentile of |a − b| in 0–255. */
function diff(a: Float64Array, b: Float64Array) {
  const d = Array.from(a, (v, i) => Math.abs(v - b[i]!) * 255).sort((p, q) => p - q);
  return { mean: d.reduce((s, v) => s + v, 0) / d.length, p99: d[Math.floor(d.length * 0.99)]! };
}
const report: Array<string> = [];
const check = (name: string, got: Float64Array, want: Float64Array, mean: number, p99: number) => {
  const r = diff(got, want);
  report.push(`${name} ${r.mean.toFixed(2)}/${r.p99.toFixed(1)}`);
  assert.ok(r.mean <= mean && r.p99 <= p99, `${name}: mean ${r.mean.toFixed(2)} (≤ ${mean}), p99 ${r.p99.toFixed(1)} (≤ ${p99})`);
};
const near = (got: readonly number[], want: readonly number[], tol: number, what: string) =>
  assert.ok(
    got.every((v, i) => Math.abs(v - want[i]!) * 255 <= tol),
    `${what}: ${got.map((v) => Math.round(v * 255))} vs ${want.map((v) => Math.round(v * 255))}`,
  );
const mix = (a: readonly number[], b: readonly number[], t: number) => a.map((v, i) => v * t + b[i]! * (1 - t)) as [number, number, number];
after(() => report.length && console.log(`  matte export vs core (mean/p99, 0–255): ${report.join(", ")}`));

test("D326: chroma key: the screen shows the clip below, subjects are kept, spill is pulled off; the whole frame as core computes it", { skip }, () => {
  const effects: Item["effects"] = [{ module: "effect.chroma-key", params: { color: "#00ff00", tolerance: 0.25, softness: 0.1, spill: 0.5 } }];
  const got = exported("key", project("screen.mkv", "back.mkv", effects));
  const top = readRgb(join(dir, "screen.mkv"));
  const under = readRgb(join(dir, "back.mkv"));
  const key = clipFx({ type: "clip", effects })!.key!;
  near(at(got, 10, 90), at(under, 10, 90), 3, "screen area shows the backdrop");
  near(at(got, 300, 170), at(under, 300, 170), 3, "screen corner shows the backdrop");
  near(at(got, 80, 90), at(top, 80, 90), 3, "red subject kept");
  const pale = at(top, 230, 90);
  near(at(got, 230, 90), despill(key, ...pale), 3, "pale green subject kept, spill pulled off");
  assert.ok(at(got, 230, 90)[1] < pale[1] - 0.08, "the spill came off");
  check(
    "key",
    got,
    make((_x, _y, t, u) => mix(despill(key, ...t), u, keyAlpha(key, ...t)), top, under),
    1.5,
    8,
  );
});

test(
  "D326: blend modes: screen, multiply, overlay, add, lighten and darken blend onto the clip below as core's (CSS's) sums",
  { skip, timeout: 120000 },
  () => {
    const top = readRgb(join(dir, "leak.mkv"));
    const under = readRgb(join(dir, "back.mkv"));
    for (const mode of ["screen", "multiply", "overlay", "add", "lighten", "darken"] as const satisfies ReadonlyArray<BlendMode>) {
      const got = exported(`blend-${mode}`, project("leak.mkv", "back.mkv", [{ module: "effect.blend", params: { mode } }]));
      check(
        `blend ${mode}`,
        got,
        make((_x, _y, t, u) => [0, 1, 2].map((c) => blendChannel(mode, u[c]!, t[c]!)) as [number, number, number], top, under),
        1.5,
        6,
      );
    }
    const screen = exported(
      "blend-screen-half",
      project("leak.mkv", "back.mkv", [{ module: "effect.blend", params: { mode: "screen" } }], [{ frame: 0, opacity: 0.5 }]),
    );
    check(
      "blend screen at 50 %",
      screen,
      make(
        (_x, _y, t, u) =>
          mix(
            [0, 1, 2].map((c) => blendChannel("screen", u[c]!, t[c]!)),
            u,
            0.5,
          ),
        top,
        under,
      ),
      1.5,
      6,
    );
  },
);

test(
  "D326: shape masks: inside shows the clip, outside the clip below, the feather blends, invert flips, ellipse and keyed masks follow core",
  { skip, timeout: 120000 },
  () => {
    const top = readRgb(join(dir, "red.mkv"));
    const under = readRgb(join(dir, "back.mkv"));
    const masked = (name: string, params: Record<string, unknown>, keys?: Item["keys"]) => {
      const effects: Item["effects"] = [{ module: "effect.mask", params }];
      const got = exported(name, project("red.mkv", "back.mkv", effects, keys));
      const m = maskAt(clipFx({ type: "clip", effects })!.mask!, keys, FRAME, { w: W, h: H });
      check(
        name,
        got,
        make((x, y, t, u) => mix(t, u, maskCoverage(m, x + 0.5, y + 0.5)), top, under),
        1,
        6,
      );
      return got;
    };
    const rect = masked("mask-rect", { shape: "rectangle", x: 60, y: 30, w: 200, h: 120, radius: 24, feather: 16 });
    near(at(rect, 160, 90), at(top, 160, 90), 3, "inside");
    near(at(rect, 20, 90), at(under, 20, 90), 3, "outside");
    near(at(rect, 70, 90), at(top, 70, 90), 3, "past the feather (8 px inside the edge) it's all the clip");
    near(at(rect, 60, 90), mix(at(top, 60, 90), at(under, 60, 90), 0.5), 12, "on the edge: half and half");
    near(at(rect, 61, 31), at(under, 61, 31), 4, "the rounded corner is cut");
    const inv = masked("mask-ellipse-invert", { shape: "ellipse", invert: true, x: 80, y: 20, w: 160, h: 140, feather: 4 });
    near(at(inv, 160, 90), at(under, 160, 90), 3, "inverted: the ellipse's middle shows the clip below");
    near(at(inv, 10, 10), at(top, 10, 10), 3, "inverted: outside shows the clip");
    const keyed = masked("mask-keyed", { shape: "rectangle", x: 0, y: 40, w: 100, h: 100, feather: 0 }, [
      { frame: 0, maskX: 0 },
      { frame: 20, maskX: 200 },
    ]);
    near(at(keyed, 140, 90), at(top, 140, 90), 3, "a keyed mask has moved (x 100 at frame 10)");
    near(at(keyed, 20, 90), at(under, 20, 90), 3, "and left its first place");
  },
);

test("D326: render_frames draws the key, the mask and the blend as the export does", { skip, timeout: 120000 }, async () => {
  const { renderFramesWith } = await import("../../apps/server/src/export/exporter/frames.ts");
  const effects: Item["effects"] = [
    { module: "effect.chroma-key", params: { color: "#00ff00" } },
    { module: "effect.mask", params: { shape: "ellipse", x: 20, y: 10, w: 280, h: 160, feather: 6 } },
    { module: "effect.blend", params: { mode: "screen" } },
  ];
  const p = project("screen.mkv", "back.mkv", effects);
  const want = exported("frames-all", p);
  const [frame] = await renderFramesWith("ffmpeg", p, (m) => m.path, new Map(), [FRAME], W, new AbortController().signal);
  const jpeg = join(dir, "frames-all.jpg");
  writeFileSync(jpeg, frame!.jpeg);
  const got = readRgb(jpeg, 0);
  check("render_frames vs export", got, want, 4, 20);
});
