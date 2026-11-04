// D328: background removal and face blur in the export, with a matte and face boxes standing in
// for a vision module's: exportCommand's graph through ffmpeg, pixel by pixel against core's maths
// (matteAlpha, faceCoverage) on the decoded sources. 320×180 synthetic clips, 1 s, lossless;
// ffmpeg capped at two threads.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { faceCoverage, faceMasks, facesAt, matteAlpha, type FaceFrames, type Item, type Project, type Track } from "../../packages/core/src/index.ts";
import { exportCommand, planExport, silentFailure } from "../../apps/server/src/export/exportPlan.ts";
import { writeFaceMasks } from "../../apps/server/src/export/exporter/faceMasks.ts";
import type { VisionLookup } from "../../apps/server/src/export/plan/vision.ts";

const countFrames = (file: string) =>
  Number(
    execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], {
      encoding: "utf8",
    }).trim(),
  );

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = hasFfmpeg ? false : "needs ffmpeg";
const W = 320;
const H = 180;
const FPS = 30;
const CAP = ["-threads", "2", "-filter_threads", "2", "-filter_complex_threads", "2"];
let dir = "";

function lavfi(name: string, source: string, codec: ReadonlyArray<string>) {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...CAP, "-f", "lavfi", "-i", source, ...codec, join(dir, name)]);
}

/** A lossless BT.709 clip drawn in RGB. */
const clip = (name: string, draw: string) =>
  lavfi(name, `color=c=black:s=${W}x${H}:r=${FPS}:d=1,format=rgb24,${draw}`, [
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
  ]);

/** The matte: a white square that moves 4 px right each frame, a soft edge, on black (FFV1 gray, like a module's). */
const MATTE = (x: number, y: number, n: number) => 255 * Math.min(1, Math.max(0, Math.min(x - (60 + 4 * n), 180 + 4 * n - x, y - 40, 140 - y) / 4 + 0.5));

function readRgb(file: string, n: number): Float64Array {
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
  dir = mkdtempSync(join(tmpdir(), "uncut-vision-export-"));
  // The subject: a hue sweep with fine detail (so a blur shows).
  clip("top.mkv", "geq=r='255*(0.5+0.5*sin(X/3))':g='255*(0.5+0.5*sin(Y/4))':b='255*clip(X/W,0,1)'");
  clip("under.mkv", "geq=r=30:g=60:b=220");
  lavfi("matte.mkv", `color=c=black:s=${W}x${H}:r=${FPS}:d=1,format=gray,geq=lum='255*clip(min(min(X-(60+4*N),180+4*N-X),min(Y-40,140-Y))/4+0.5,0,1)'`, [
    "-c:v",
    "ffv1",
  ]);
});
after(() => dir && rmSync(dir, { recursive: true, force: true }));

const media = (id: string, file: string) => ({
  id,
  kind: "video" as const,
  name: file,
  path: join(dir, file),
  probe: { frames: 30, fps: FPS, width: W, height: H, hasAudio: false },
});

function project(effects: Item["effects"], extra: Partial<Item> = {}): Project {
  const tracks: Array<Track> = [
    { id: "top", kind: "video", name: "Top", items: [{ id: "t1", type: "clip", media: "m-top", start: 0, in: 0, duration: 30, effects, ...extra }] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "u1", type: "clip", media: "m-under", in: 0, duration: 30 }] },
  ];
  return {
    format: "uncut/0",
    name: "Vision",
    canvas: { width: W, height: H, fps: FPS, background: "#000000" },
    media: [media("m-top", "top.mkv"), media("m-under", "under.mkv")],
    tracks,
  };
}

const matteInfo = { fps: FPS, width: W, height: H, times: Array.from({ length: 30 }, (_, i) => i / FPS) };
/** A face at the left moving right, missing on frames 12 and 13 (drawn between its neighbours). */
const FACES: FaceFrames = {
  frames: Array.from({ length: 30 }, (_, i) => ({ t: i / FPS, faces: i === 12 || i === 13 ? [] : [{ id: 1, x: 0.2 + i * 0.01, y: 0.3, w: 0.2, h: 0.35 }] })),
};
const lookup: VisionLookup = (_media, request) =>
  request.output === "matte" ? { matte: { file: join(dir, "matte.mkv"), info: matteInfo } } : { faces: FACES };

async function exported(name: string, p: Project, frame: number, vision?: VisionLookup): Promise<Float64Array> {
  const plan = planExport(p, { mediaPath: (m) => m.path, width: W, height: H, vision });
  if ("problem" in plan) throw new Error(plan.problem);
  const bg = join(dir, "bg.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}`, "-frames:v", "1", bg]);
  const faceMasks = await writeFaceMasks("ffmpeg", plan, dir, new AbortController().signal);
  const cmd = exportCommand(plan, {
    background: bg,
    rasters: new Map(),
    caps: { encoders: new Set(["libx264"]), videotoolboxDecode: false, major: 8 },
    quality: "high",
    output: join(dir, `${name}.mp4`),
    faceMasks,
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
      String(frame + 1),
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
  return readRgb(out, frame);
}

const at = (img: Float64Array, x: number, y: number) => {
  const i = (y * W + x) * 3;
  return [img[i]!, img[i + 1]!, img[i + 2]!] as const;
};

test("cutout: the track below shows where the matte is black, the clip where it's white, the edge as core's matteAlpha", { skip }, async () => {
  const top = readRgb(join(dir, "top.mkv"), 0);
  const under = readRgb(join(dir, "under.mkv"), 0);
  const cutout = { module: "effect.cutout", params: { mode: "person", softness: 1, shrink: 0 } };
  for (const frame of [0, 7, 20]) {
    const out = await exported(`cutout-${frame}`, project([cutout]), frame, lookup);
    let worst = 0;
    let sum = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const a = matteAlpha({ mode: "person", softness: 1, shrink: 0 }, Math.round(MATTE(x + 0.5, y + 0.5, frame)) / 255);
        const t = at(top, x, y);
        const u = at(under, x, y);
        const o = at(out, x, y);
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(o[c]! - (a * t[c]! + (1 - a) * u[c]!)) * 255;
          worst = Math.max(worst, d);
          sum += d;
        }
      }
    const mean = sum / (W * H * 3);
    assert.ok(mean < 1.5, `frame ${frame}: mean ${mean.toFixed(2)}`);
    // Inside the square, away from its edge: the clip; well outside: the blue track below.
    assert.ok(Math.abs(at(out, 120 + 4 * frame, 90)[2]! - at(top, 120 + 4 * frame, 90)[2]!) < 0.02, `frame ${frame} inside`);
    assert.ok(Math.abs(at(out, 20, 20)[2]! - 220 / 255) < 0.02, `frame ${frame} outside`);
    assert.ok(worst < 40, `frame ${frame}: worst ${worst.toFixed(1)}`);
  }
});

test("cutout: a shrunk, crisper edge follows core's matteAlpha", { skip }, async () => {
  const cut = { mode: "person" as const, softness: 0.3, shrink: 0.6 };
  const out = await exported("cutout-shrink", project([{ module: "effect.cutout", params: cut }]), 5, lookup);
  const top = readRgb(join(dir, "top.mkv"), 5);
  const under = readRgb(join(dir, "under.mkv"), 5);
  let sum = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const a = matteAlpha(cut, Math.round(MATTE(x + 0.5, y + 0.5, 5)) / 255);
      const t = at(top, x, y);
      const u = at(under, x, y);
      const o = at(out, x, y);
      for (let c = 0; c < 3; c++) sum += Math.abs(o[c]! - (a * t[c]! + (1 - a) * u[c]!)) * 255;
    }
  assert.ok(sum / (W * H * 3) < 1.5, `mean ${(sum / (W * H * 3)).toFixed(2)}`);
});

test("cutout on a sped-up clip reads the matte frame of its source frame", { skip }, async () => {
  const p = project([{ module: "effect.cutout", params: { mode: "person" } }], { speed: 2, duration: 15 });
  const out = await exported("cutout-speed", p, 6, lookup);
  // Frame 6 at 2× shows source frame 12: the square spans x 108..228.
  assert.ok(Math.abs(at(out, 100, 90)[2]! - 220 / 255) < 0.03, "left of the square is the track below");
  assert.ok(Math.abs(at(out, 112, 90)[2]! - 220 / 255) > 0.05, "inside the square is the clip");
});

test("face blur: only pixels inside the faces' masks change, and the mask follows the face across a missed frame", { skip }, async () => {
  const blur = { module: "effect.face-blur", params: { amount: 8, shape: "ellipse", feather: 6, padding: 0.1 } };
  for (const frame of [3, 12]) {
    // The same path with no faces found: what face blur leaves alone.
    const plain = await exported(`plain-${frame}`, project([blur]), frame, () => ({ faces: { frames: [] } }));
    const out = await exported(`faces-${frame}`, project([blur]), frame, lookup);
    const masks = faceMasks(facesAt(FACES, frame / FPS), { amount: 8, shape: "ellipse", feather: 6, padding: 0.1 }, W, H);
    assert.equal(masks.length, 1, `frame ${frame} has its face (drawn between its neighbours on 12)`);
    let outside = 0;
    let inside = 0;
    let inCount = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const c = faceCoverage(masks, x + 0.5, y + 0.5);
        const d = Math.max(...[0, 1, 2].map((ch) => Math.abs(at(out, x, y)[ch]! - at(plain, x, y)[ch]!))) * 255;
        if (c === 0) outside = Math.max(outside, d);
        if (c === 1) {
          inside += d;
          inCount++;
        }
      }
    assert.ok(outside <= 2, `frame ${frame}: outside the faces changed by ${outside.toFixed(1)}`);
    assert.ok(inside / inCount > 20, `frame ${frame}: inside the face changed by ${(inside / inCount).toFixed(1)} on average`);
  }
});

test("writeFaceMasks yields to the event loop between frames: a timer set on its first frame fires well before its last", { skip }, async () => {
  const FRAMES = 60;
  const masks = faceMasks(facesAt(FACES, 0), { amount: 8, shape: "ellipse", feather: 6, padding: 0.1 }, W, H);
  let read = 0;
  let readWhenTimerFired = -1;
  const frameMasks = Array.from({ length: FRAMES }, () => masks);
  const counted = new Proxy(frameMasks, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        read++;
        if (read === 1) setTimeout(() => (readWhenTimerFired = read), 0);
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const layer = { kind: "video", f0: 0, f1: FRAMES, fx: { w: W, h: H, faceMasks: counted, fx: { faceBlur: {} } } };
  const plan = { fps: FPS, visuals: [layer] } as unknown as Parameters<typeof writeFaceMasks>[1];
  const written = await writeFaceMasks("ffmpeg", plan, dir, new AbortController().signal);
  assert.equal(read, FRAMES);
  assert.ok(readWhenTimerFired > 0 && readWhenTimerFired < FRAMES / 2, `the timer fired after ${readWhenTimerFired} of ${FRAMES} frames`);
  assert.equal(countFrames(written.values().next().value!), FRAMES);
});

test("without a matte the clip is drawn unkeyed, with the reason as a warning", { skip }, () => {
  const p = project([{ module: "effect.cutout", params: { mode: "subject" } }]);
  const plan = planExport(p, {
    mediaPath: (m) => m.path,
    width: W,
    height: H,
    vision: () => ({ problem: "Background removal needs a vision module for this system." }),
  });
  if ("problem" in plan) throw new Error(plan.problem);
  assert.ok(
    plan.warnings.some((w) => /without its background removed: Background removal needs a vision module for this system\./.test(w)),
    plan.warnings.join("\n"),
  );
  const layer = plan.visuals.find((l) => l.item.id === "t1")!;
  assert.ok(layer.kind === "video" && !layer.matte);
});
