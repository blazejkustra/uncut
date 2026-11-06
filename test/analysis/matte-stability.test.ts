// D332: the steady matte. The survey's holds (a dropout held, a real cut and a subject leaving not
// held, a burst held only briefly), the cut finder, the three-frame median (flicker removed where
// the picture is still, a moving edge kept as it is, nothing across a cut or from a dropout, three
// frames kept), the moving hold, and stabiliseMatte end to end through ffmpeg.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { heldMatte, shiftedMatte } from "../../apps/server/src/analysis/vision/matteHold.ts";
import { TemporalMedian, findCuts, holdLimits, planHolds, type MedianFrame } from "../../apps/server/src/analysis/vision/matteStability.ts";
import { stabiliseMatte } from "../../apps/server/src/analysis/vision/stabiliseMatte.ts";
import type { MatteInfo } from "../../packages/contracts/src/index.ts";

const LIMITS = holdLimits(25);
const noCuts = (n: number) => new Uint8Array(n);
const shown = (use: Int32Array) => [...use];

test("holds: a person dropping out for a few frames shows the last good frame's matte", () => {
  const areas = [0.05, 0.05, 0.05, 0, 0.002, 0, 0.05, 0.05];
  assert.deepEqual(shown(planHolds(areas, noCuts(8), LIMITS)), [0, 1, 2, 2, 2, 2, 6, 7]);
});

test("holds: a matte fading out over two frames counts against the bigger one before", () => {
  const areas = [0.05, 0.05, 0.03, 0.008, 0.05];
  assert.deepEqual(shown(planHolds(areas, noCuts(5), LIMITS)), [0, 1, 2, 2, 4]);
});

test("holds: a real shot cut is never held across", () => {
  const areas = [0.05, 0.05, 0, 0, 0.05];
  const cuts = Uint8Array.from([0, 0, 1, 0, 0]);
  assert.deepEqual(shown(planHolds(areas, cuts, LIMITS)), [0, 1, 2, 3, 4]);
  const cutInside = Uint8Array.from([0, 0, 0, 1, 0]);
  assert.deepEqual(shown(planHolds(areas, cutInside, LIMITS)), [0, 1, 2, 3, 4]);
});

test("holds: a subject that leaves the frame (empty for longer than a hold) isn't held", () => {
  const areas = [0.05, 0.05, ...Array<number>(LIMITS.hold + 1).fill(0), 0.05];
  assert.deepEqual(
    shown(planHolds(areas, noCuts(areas.length), LIMITS)),
    areas.map((_, t) => t),
  );
});

test("holds: a one-frame burst (people popping in) is held, someone who comes in and stays isn't", () => {
  assert.deepEqual(shown(planHolds([0.05, 0.05, 0.3, 0.05], noCuts(4), LIMITS)), [0, 1, 1, 3]);
  const stays = [0.05, 0.05, 0.3, 0.3, 0.3, 0.3, 0.05];
  assert.deepEqual(shown(planHolds(stays, noCuts(7), LIMITS)), [0, 1, 2, 3, 4, 5, 6]);
});

test("holds: an empty matte has nothing to hold, a collapse that turns into a burst isn't a dropout", () => {
  assert.deepEqual(shown(planHolds([0, 0, 0.05, 0.05], noCuts(4), LIMITS)), [0, 1, 2, 3]);
  assert.deepEqual(shown(planHolds([0.05, 0.05, 0.001, 0.4, 0.05], noCuts(5), LIMITS)), [0, 1, 2, 3, 4]);
});

test("holds: the limits follow the frame rate", () => {
  assert.deepEqual(holdLimits(25), { hold: 13, burst: 3 });
  assert.deepEqual(holdLimits(60), { hold: 30, burst: 6 });
});

test("cuts: a jump in the picture, also a one-frame flash; a pan that keeps changing isn't one", () => {
  assert.deepEqual([...findCuts([0, 2, 3, 60, 2, 3])], [0, 0, 0, 1, 0, 0]);
  assert.deepEqual([...findCuts([0, 2, 60, 60, 2, 2])], [0, 0, 1, 0, 0, 0]);
  assert.deepEqual([...findCuts([0, 30, 34, 38, 31, 33])], [0, 0, 0, 0, 0, 0]);
});

const W = 16;
const H = 8;
const plain = (v: number) => new Uint8Array(W * H).fill(v);
const frame = (matte: Uint8Array, picture: Uint8Array, over: Partial<MedianFrame> = {}): MedianFrame => ({
  matte,
  picture,
  dropout: false,
  cutBefore: false,
  ...over,
});

function runMedian(frames: ReadonlyArray<MedianFrame>): Array<Uint8Array> {
  const median = new TemporalMedian({ width: W, height: H, gateWidth: W, gateHeight: H });
  return [...frames.flatMap((f) => median.push(f)), ...median.flush()];
}

test("median: a one-frame flicker where the picture is still is removed", () => {
  const flicker = plain(255);
  flicker[3] = 0;
  const out = runMedian([frame(plain(255), plain(90)), frame(flicker, plain(90)), frame(plain(255), plain(90))]);
  assert.equal(out.length, 3);
  assert.deepEqual([...out[1]!], [...plain(255)]);
});

/** A bright bar two pixels wide at column x, the same in the picture and the matte. */
function bar(x: number) {
  const out = plain(0);
  for (let y = 0; y < H; y++) out[y * W + x] = out[y * W + x + 1] = 255;
  return out;
}

test("median: a moving edge keeps its own frame's matte (no lag, no trail)", () => {
  const frames = [2, 6, 10].map((x) => frame(bar(x), bar(x)));
  const out = runMedian(frames);
  frames.forEach((f, i) => assert.deepEqual([...out[i]!], [...f.matte], `frame ${i}`));
});

test("median: nothing across a cut, and a dropout frame neither votes nor is smoothed", () => {
  const flicker = plain(255);
  flicker[3] = 0;
  const acrossCut = runMedian([frame(plain(255), plain(90)), frame(flicker, plain(90)), frame(plain(255), plain(90), { cutBefore: true })]);
  assert.equal(acrossCut[1]![3], 0);
  const besideDropout = runMedian([frame(plain(255), plain(90)), frame(flicker, plain(90)), frame(plain(255), plain(90), { dropout: true })]);
  assert.equal(besideDropout[1]![3], 0);
  const dropout = runMedian([frame(plain(255), plain(90)), frame(flicker, plain(90), { dropout: true }), frame(plain(255), plain(90))]);
  assert.equal(dropout[1]![3], 0);
});

test("median: memory stays at three frames however long the clip", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const median = new TemporalMedian({ width: W, height: H, gateWidth: W, gateHeight: H });
  const refs: Array<WeakRef<Uint8Array>> = [];
  for (let t = 0; t < 40; t++) {
    const matte = plain(t % 2 ? 255 : 250);
    refs.push(new WeakRef(matte));
    median.push(frame(matte, plain(90)));
  }
  await new Promise((resolve) => setImmediate(resolve));
  gc();
  const alive = refs.map((r, t) => (r.deref() ? t : -1)).filter((t) => t >= 0);
  assert.deepEqual(alive, [37, 38, 39]);
});

/** A grey picture with texture everywhere, so phase correlation can follow it. */
function texture(w: number, h: number, seed: number) {
  const out = new Uint8Array(w * h);
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = 40 + (s % 160);
  }
  return out;
}

function shiftedPicture(p: Uint8Array, w: number, h: number, dx: number) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = p[y * w + Math.min(w - 1, Math.max(0, x - dx))]!;
  return out;
}

const centreX = (m: Uint8Array, w: number) => {
  let sum = 0;
  let n = 0;
  m.forEach((v, i) => {
    if (v > 128) {
      sum += i % w;
      n++;
    }
  });
  return sum / n;
};

test("moving hold: the held matte moves with the picture inside its box, a view that changed lets it go", () => {
  const mw = 320;
  const mh = 180;
  const gw = 160;
  const gh = 90;
  const matte = new Uint8Array(mw * mh);
  for (let y = 60; y < 120; y++) matte.fill(255, y * mw + 120, y * mw + 180);
  const before = texture(gw, gh, 7);
  const good = { matte, picture: { pixels: before, w: gw, h: gh } };
  assert.equal(heldMatte(good, { pixels: before, w: gw, h: gh }, mw, mh), matte, "a still picture holds the matte as it was");
  const panned = heldMatte(good, { pixels: shiftedPicture(before, gw, gh, 6), w: gw, h: gh }, mw, mh);
  assert.ok(panned, "a pan is followed");
  assert.ok(Math.abs(centreX(panned, mw) - centreX(matte, mw) - 12) <= 2, `moved ${centreX(panned, mw) - centreX(matte, mw)} px`);
  assert.equal(heldMatte(good, { pixels: texture(gw, gh, 99), w: gw, h: gh }, mw, mh), undefined, "another view isn't held");
  assert.equal(heldMatte(good, undefined, mw, mh), undefined);
});

test("moving hold: a shifted matte is empty where it came in from outside", () => {
  const m = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...shiftedMatte(m, 3, 2, 1, 0)], [0, 1, 2, 0, 4, 5]);
  assert.deepEqual([...shiftedMatte(m, 3, 2, 0, -1)], [4, 5, 6, 0, 0, 0]);
});

const onPath = (name: string) => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim() || undefined;
const ffmpeg = onPath("ffmpeg");

const [MW, MH, FRAMES] = [320, 180, 30];
const SQUARE = 60 * 60;
const INFO: MatteInfo = {
  format: "uncut.matte/1",
  mode: "person",
  start: 0,
  end: 1,
  fps: 30,
  width: MW,
  height: MH,
  frames: FRAMES,
  times: Array.from({ length: FRAMES }, (_, i) => i / 30),
  module: { id: "test", version: "1" },
};

/** A still textured picture that cuts to another at frame 20, and a matte of a square that drops out at frame 8 and at the cut (frames 20 and 21). */
function fixture(root: string) {
  const encode = (lum: string, file: string) =>
    execFileSync(ffmpeg!, [
      ...["-v", "error", "-threads", "4", "-f", "lavfi", "-i", `color=c=black:s=${MW}x${MH}:r=30:d=1,format=gray,geq=lum='${lum}'`],
      ...["-c:v", "ffv1", "-threads", "4", "-y", file],
    ]);
  const source = join(root, "source.mkv");
  const matte = join(root, "matte.mkv");
  encode("if(lt(N,20),mod(X*37+Y*91,200)+20,mod(X*53+Y*17+90,200)+20)", source);
  encode("if(between(X,100,159)*between(Y,60,119)*not(eq(N,8))*not(between(N,20,21)),255,0)", matte);
  return { ffmpeg: ffmpeg!, source, matte, out: join(root, "steady.mkv"), info: INFO };
}

const ffmpegSkip = !ffmpeg && "ffmpeg isn't installed";

test(
  "stabiliseMatte: a dropout is held, a dropout at a cut isn't, and the matte keeps its size, frames and clock",
  { skip: ffmpegSkip, timeout: 60000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "uncut-steady-"));
    try {
      const input = fixture(root);
      const progress: Array<number> = [];
      await stabiliseMatte(input, { signal: new AbortController().signal, onProgress: (f) => progress.push(f) });
      const raw = execFileSync(ffmpeg!, ["-v", "error", "-threads", "4", "-i", input.out, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], {
        maxBuffer: 64 << 20,
      });
      assert.equal(raw.length, FRAMES * MW * MH);
      const kept = (t: number) => raw.subarray(t * MW * MH, (t + 1) * MW * MH).filter((v) => v > 128).length;
      assert.equal(kept(7), SQUARE);
      assert.equal(kept(8), SQUARE, "the dropout shows the frame before");
      assert.deepEqual([kept(20), kept(21)], [0, 0], "the empty frames right after the cut stay empty");
      assert.equal(kept(22), SQUARE);
      assert.equal(progress.at(-1), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("stabiliseMatte: a cancel part way stops it as cancelled", { skip: ffmpegSkip, timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "uncut-steady-"));
  try {
    const controller = new AbortController();
    const run = stabiliseMatte(fixture(root), { signal: controller.signal, onProgress: (f) => f > 0.5 && controller.abort() });
    await assert.rejects(run, /cancelled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
