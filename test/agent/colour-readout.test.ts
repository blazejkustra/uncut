// The measure tool's colour (handoff point 22): the readout of solid and ramped frames, the white
// balance cast and the effect.color values that neutralise it or match another clip, checked by
// running them through core's own colour maths; the stated directions of temperature and tint
// follow that maths; a JPEG decoded by ffmpeg reads as the colour it was made of.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adjustOf, colourFn } from "../../packages/core/src/index.ts";
import {
  balanceShift,
  castWords,
  colourReadout,
  colourStats,
  graded,
  GRADING_DIRECTIONS,
  matchReadout,
  matchShift,
  mergeStats,
} from "../../apps/server/src/agent/agentColour.ts";
import { jpegPixels, parsePpm, type RgbImage } from "../../apps/server/src/export/exporter/framePixels.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const ffmpeg = (() => spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim() || "ffmpeg")();

const solid = (r: number, g: number, b: number, width = 64, height = 36): RgbImage => {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i += 3) ((rgb[i] = r), (rgb[i + 1] = g), (rgb[i + 2] = b));
  return { width, height, rgb };
};
const adjusted = (image: RgbImage, params: Record<string, number>) => graded(image, { adjust: adjustOf(params) });

test("a mid grey frame: its luma, points and mean, neutral, nothing to fix", () => {
  const s = colourStats(solid(128, 128, 128));
  assert.equal(s.luma, 128);
  assert.equal(s.black, 128);
  assert.equal(s.white, 128);
  assert.deepEqual(s.rgb, [128, 128, 128]);
  assert.equal(s.saturation, 0);
  assert.equal(s.neutral?.rMinusG, 0);
  assert.equal(castWords(s.neutral), "neutral");
  const out = colourReadout(s);
  assert.equal(out.neutralise, undefined);
  assert.match(out.whiteBalance, /^neutral/);
});

test("a ramp from black to white: black and white points at the 1st and 99th percentiles, crushed and clipped shares", () => {
  const width = 256;
  const rgb = new Uint8Array(width * 3);
  for (let x = 0; x < width; x++) rgb.fill(x, 3 * x, 3 * x + 3);
  const s = colourStats({ width, height: 1, rgb });
  assert.ok(s.black >= 1 && s.black <= 3, `${s.black}`);
  assert.ok(s.white >= 252 && s.white <= 254, `${s.white}`);
  assert.ok(Math.abs(s.luma - 127.5) < 1);
  assert.ok(s.crushed > 1 && s.clipped > 1);
});

test("a warm magenta cast is named, and the suggested temperature and tint neutralise it through core's maths", () => {
  const cast = solid(140, 126, 134);
  const s = colourStats(cast);
  assert.match(castWords(s.neutral), /warm.*magenta/);
  const fix = balanceShift(s.neutral!.linear);
  assert.equal(fix.limited, undefined);
  assert.ok(fix.tint < 0, "magenta is fixed with tint towards green");
  assert.ok(fix.temperature < 0, "warm is fixed with temperature towards cool");
  assert.match(colourReadout(s).neutralise ?? "", /^add temperature -0\.\d+ and tint -0\.\d+ to the clip's effect\.color$/);
  const after = colourStats(adjusted(cast, { temperature: fix.temperature, tint: fix.tint }));
  assert.ok(Math.abs(after.neutral!.rMinusG) <= 2 && Math.abs(after.neutral!.bMinusG) <= 2, JSON.stringify(after.neutral));
  assert.equal(castWords(after.neutral), "neutral");
});

test("a cast past the controls' range is clamped and says so", () => {
  const s = colourStats(solid(150, 100, 140));
  const fix = balanceShift(s.neutral!.linear);
  assert.equal(fix.limited, true);
  assert.equal(fix.tint, -1);
  assert.match(colourReadout(s).neutralise ?? "", /at the control's limit/);
});

test("a green cool cast goes the other way", () => {
  const s = colourStats(solid(100, 140, 150));
  assert.match(castWords(s.neutral), /cool.*green/);
  const fix = balanceShift(s.neutral!.linear);
  assert.ok(fix.tint > 0 && fix.temperature > 0, JSON.stringify(fix));
});

test("the stated directions are core's: temperature + warms, tint + turns magenta", () => {
  assert.match(GRADING_DIRECTIONS, /temperature \+ is warmer \(more red, less blue\)/);
  assert.match(GRADING_DIRECTIONS, /tint \+ is magenta \(less green\), − green/);
  const grey = solid(128, 128, 128);
  const warm = colourStats(adjusted(grey, { temperature: 0.3 })).rgb;
  assert.ok(warm[0] > warm[1] && warm[1] > warm[2], `${warm}`);
  const magenta = colourStats(adjusted(grey, { tint: 0.3 })).rgb;
  assert.ok(magenta[0] > magenta[1] && magenta[2] > magenta[1], `${magenta}`);
  const green = colourStats(adjusted(grey, { tint: -0.3 })).rgb;
  assert.ok(green[1] > green[0] && green[1] > green[2], `${green}`);
});

test("matching one clip to another: the exposure and balance changes land it on the reference", () => {
  const reference = colourStats(solid(150, 150, 150));
  const dark = solid(96, 90, 100);
  const darkStats = colourStats(dark);
  const line = matchReadout({ name: "Camera A", stats: reference }, { name: "Camera B", stats: darkStats });
  assert.match(line, /^To match Camera B to Camera A: add exposure \+[\d.]+, temperature [+-][\d.]+, tint [+-][\d.]+ to Camera B's effect\.color/);
  const { exposure, balance } = matchShift(reference, darkStats);
  assert.ok(balance && !balance.limited);
  const after = colourStats(adjusted(dark, { exposure, temperature: balance.temperature, tint: balance.tint }));
  assert.ok(Math.abs(after.luma - reference.luma) < 3, `${after.luma}`);
  assert.equal(castWords(after.neutral), "neutral");
});

test("a clip's samples merge into one readout", () => {
  const m = mergeStats([colourStats(solid(100, 100, 100)), colourStats(solid(200, 200, 200))]);
  assert.equal(m.luma, 150);
  assert.equal(m.black, 100);
  assert.equal(m.white, 200);
});

test("a saturated frame has no neutral area to judge", () => {
  const s = colourStats(solid(250, 0, 0));
  assert.equal(s.neutral, undefined);
  assert.match(colourReadout(s).whiteBalance, /no near-neutral area/);
});

test("ffmpeg decodes a JPEG of a known colour to its pixels", { skip: hasFfmpeg ? false : "needs ffmpeg" }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-colour-")));
  try {
    const file = join(dir, "c.jpg");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x8c6e82:s=96x54", "-frames:v", "1", "-q:v", "2", file]);
    const [image] = await jpegPixels(ffmpeg, [readFileSync(file)]);
    assert.equal(image!.width, 96);
    assert.equal(image!.height, 54);
    const s = colourStats(image!);
    assert.ok(Math.abs(s.rgb[0] - 0x8c) <= 3 && Math.abs(s.rgb[1] - 0x6e) <= 3 && Math.abs(s.rgb[2] - 0x82) <= 3, `${s.rgb}`);
    assert.match(castWords(s.neutral), /magenta/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PPM parsing reads the header with a comment", () => {
  const header = new TextEncoder().encode("P6\n# by test\n2 1\n255\n");
  const data = new Uint8Array([...header, 1, 2, 3, 4, 5, 6]);
  const image = parsePpm(data);
  assert.equal(image.width, 2);
  assert.deepEqual([...image.rgb], [1, 2, 3, 4, 5, 6]);
});
