// D325: the vision contract (packages/contracts vision.ts), choosing a provider (providers.ts) and
// the cache (visionCache.ts, VisionAnalysis) with a fake module standing in for a plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { clipBox, frameAt, parseFaces, parseMatteInfo, parseTrack } from "../../packages/contracts/src/index.ts";
import { validateModule } from "../../packages/core/src/index.ts";

import { NO_PROVIDER, pickProvider, platformOf, type VisionCandidate } from "../../apps/server/src/analysis/vision/providers.ts";
import { visionDir, visionFiles, visionKey } from "../../apps/server/src/analysis/vision/visionCache.ts";
import { VisionAnalysis, VisionFailure, type VisionCallResult, type VisionDeps } from "../../apps/server/src/analysis/vision/vision.ts";
import { fingerprint } from "../../apps/server/src/analysis/analysis.ts";

const APPLE = JSON.parse(readFileSync(resolve("plugins/apple-vision/uncut.module.json"), "utf8")) as Record<string, unknown>;

const matteInfo = (over: Record<string, unknown> = {}) => ({
  format: "uncut.matte/1",
  mode: "person",
  start: 1,
  end: 1.1,
  fps: 30,
  width: 64,
  height: 36,
  frames: 3,
  times: [0.9667, 1, 1.0333],
  module: { id: "apple.vision", version: "0.1.0" },
  ...over,
});

const candidate = (id: string, outputs: ReadonlyArray<string>, platforms?: ReadonlyArray<string>, version = "1.0.0"): VisionCandidate => ({
  id,
  name: id,
  version,
  manifest: { id, kind: "analyzer", analyzer: { inputs: ["video"], outputs, backend: "system" }, ...(platforms ? { requires: { platforms } } : {}) },
});

// ---- the contract ----

test("contract: a matte's info parses, and frames, times, size and range are checked", () => {
  assert.ok("value" in parseMatteInfo(matteInfo()));
  assert.match((parseMatteInfo(matteInfo({ format: "uncut.matte/2" })) as { problem: string }).problem, /uncut\.matte\/1/);
  assert.match((parseMatteInfo(matteInfo({ mode: "cat" })) as { problem: string }).problem, /uncut\.matte\/1/);
  assert.match((parseMatteInfo(matteInfo({ frames: 4 })) as { problem: string }).problem, /4 frames but lists 3/);
  assert.match((parseMatteInfo(matteInfo({ times: [1, 1, 1.1] })) as { problem: string }).problem, /don't rise/);
  assert.match((parseMatteInfo(matteInfo({ width: 63.5 })) as { problem: string }).problem, /whole pixels/);
  assert.match((parseMatteInfo(matteInfo({ end: 1 })) as { problem: string }).problem, /range is empty/);
  assert.match((parseMatteInfo(matteInfo({ module: undefined })) as { problem: string }).problem, /uncut\.matte\/1/);
});

test("contract: faces are boxes inside the picture with whole ids, frame times rising", () => {
  const faces = (frames: unknown) => ({ start: 0, end: 1, fps: 30, width: 1920, height: 1080, frames });
  const face = { id: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.4, confidence: 0.9 };
  assert.ok(
    "value" in
      parseFaces(
        faces([
          { t: 0, faces: [face] },
          { t: 0.033, faces: [] },
        ]),
      ),
  );
  assert.ok("problem" in parseFaces(faces([{ t: 0, faces: [{ ...face, x: 1.2 }] }])));
  assert.ok("problem" in parseFaces(faces([{ t: 0, faces: [{ ...face, id: 1.5 }] }])));
  assert.ok("problem" in parseFaces(faces([{ t: 0, faces: [{ ...face, confidence: 2 }] }])));
  assert.ok(
    "problem" in
      parseFaces(
        faces([
          { t: 0.1, faces: [] },
          { t: 0, faces: [] },
        ]),
      ),
  );
  assert.ok("problem" in parseFaces(faces([{ t: 0, faces: [{ id: 1 }] }])));
});

test("contract: a track has a box on every frame, and lost only on its last", () => {
  const track = (frames: unknown) => ({ start: 0, end: 1, fps: 30, width: 640, height: 360, frames });
  const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2, confidence: 1 };
  assert.ok(
    "value" in
      parseTrack(
        track([
          { t: 0, ...box },
          { t: 0.033, lost: true },
        ]),
      ),
  );
  assert.ok("problem" in parseTrack(track([])));
  assert.ok(
    "problem" in
      parseTrack(
        track([
          { t: 0, lost: true },
          { t: 0.033, ...box },
        ]),
      ),
  );
  assert.ok("problem" in parseTrack(track([{ t: 0, x: 0.1 }])));
});

test("contract: boxes reaching past the picture are cut to it; nothing finite inside is refused", () => {
  const range = { start: 0, end: 1, fps: 30, width: 640, height: 360 };
  const track = parseTrack({
    ...range,
    frames: [
      { t: 0, x: 0.9, y: -0.0036, w: 0.2, h: 0.5, confidence: 0.8 },
      { t: 0.033, lost: true },
    ],
  });
  assert.ok("value" in track);
  assert.deepEqual(track.value.frames[0], { t: 0, x: 0.9, y: 0, w: 0.1, h: 0.4964, confidence: 0.8 });
  const faces = parseFaces({ ...range, frames: [{ t: 0, faces: [{ id: 3, x: -0.05, y: 0.5, w: 0.2, h: 0.6, confidence: 0.9 }] }] });
  assert.ok("value" in faces);
  assert.deepEqual(faces.value.frames[0]!.faces[0], { id: 3, x: 0, y: 0.5, w: 0.15, h: 0.5, confidence: 0.9 });
  assert.deepEqual(clipBox({ x: 1.2, y: 0, w: 0.1, h: 0.1 }), undefined, "wholly outside");
  assert.deepEqual(clipBox({ x: 0.1, y: 0.1, w: 0, h: 0.1 }), undefined, "no width");
  assert.deepEqual(clipBox({ x: Number.NaN, y: 0.1, w: 0.1, h: 0.1 }), undefined, "not finite");
  assert.ok("problem" in parseTrack({ ...range, frames: [{ t: 0, x: 0.1, y: 0.1, w: -0.2, h: 0.2 }] }));
  assert.ok("problem" in parseFaces({ ...range, frames: [{ t: 0, faces: [{ id: 1, x: 2, y: 0, w: 0.1, h: 0.1, confidence: 0.5 }] }] }));
});

test("contract: the frame for a moment is the last starting at or before it (+0.0001 s), variable rate too", () => {
  const times = [0, 0.0333, 0.0667, 0.15, 0.2];
  assert.equal(frameAt(times, -0.01), -1);
  assert.equal(frameAt(times, 0), 0);
  assert.equal(frameAt(times, 0.0332), 1, "within 0.0001 s of a frame's start picks it");
  assert.equal(frameAt(times, 0.0331), 0);
  assert.equal(frameAt(times, 0.149), 2, "a gap holds the frame before it");
  assert.equal(frameAt(times, 5), 4);
  assert.equal(frameAt([], 1), -1);
});

test("contract: the module schema takes the vision outputs, the system backend and macOS x64; the Apple plugin's manifest is valid", () => {
  assert.deepEqual(validateModule(APPLE), []);
  assert.deepEqual((APPLE.analyzer as { outputs: Array<string> }).outputs, ["matte", "faces", "track"]);
  assert.deepEqual((APPLE.requires as { platforms: Array<string> }).platforms, ["macos-arm64", "macos-x64"]);
  assert.ok(validateModule({ ...APPLE, analyzer: { inputs: ["video"], outputs: ["masks"], backend: "system" } }).length > 0);
  assert.ok(validateModule({ ...APPLE, requires: { platforms: ["macos-ppc"] } }).length > 0);
  assert.equal((APPLE as { agentTools?: unknown }).agentTools, undefined, "Uncut calls it, never the agent");
});

// ---- choosing a provider ----

test("providers: the platform names", () => {
  assert.equal(platformOf("darwin", "arm64"), "macos-arm64");
  assert.equal(platformOf("darwin", "x64"), "macos-x64");
  assert.equal(platformOf("win32", "x64"), "windows-x64");
  assert.equal(platformOf("linux", "x64"), "linux-x64");
  assert.equal(platformOf("linux", "arm64"), undefined);
});

test("providers: none installed, none declaring the output, a platform mismatch, and the right one picked", () => {
  assert.deepEqual(pickProvider([], "matte", "macos-arm64"), { refused: "Background removal needs a vision module for this system." });
  assert.deepEqual(pickProvider([candidate("x.audio", ["transcript"])], "faces", "macos-arm64"), { refused: NO_PROVIDER.faces });
  const apple = { ...candidate("apple.vision", ["matte", "faces", "track"]), name: "Apple Vision", manifest: APPLE };
  const onWindows = pickProvider([apple], "matte", "windows-x64");
  assert.ok("refused" in onWindows);
  assert.match(
    onWindows.refused,
    /^Background removal needs a vision module for this system\. Apple Vision runs on macos-arm64, macos-x64, and this is windows-x64\.$/,
  );
  const onnx = candidate("onnx.vision", ["matte", "faces"], ["windows-x64", "linux-x64"]);
  assert.equal((pickProvider([apple, onnx], "matte", "linux-x64") as { provider: VisionCandidate }).provider.id, "onnx.vision");
  assert.equal((pickProvider([apple, onnx], "matte", "macos-arm64") as { provider: VisionCandidate }).provider.id, "apple.vision");
  assert.equal((pickProvider([apple, onnx], "matte", "macos-x64") as { provider: VisionCandidate }).provider.id, "apple.vision");
  assert.ok("refused" in pickProvider([apple, onnx], "track", "linux-x64"), "onnx doesn't declare track");
  const disallowed = pickProvider([{ ...apple, allowed: false }], "matte", "macos-arm64");
  assert.deepEqual(disallowed, { refused: `${NO_PROVIDER.matte} Apple Vision is installed but not allowed: allow it in Settings, Plugins.` });
  assert.equal((pickProvider([{ ...apple, allowed: false }, onnx], "matte", "linux-x64") as { provider: VisionCandidate }).provider.id, "onnx.vision");
  const anywhere = candidate("any.vision", ["track"]);
  assert.equal((pickProvider([anywhere], "track", undefined) as { provider: VisionCandidate }).provider.id, "any.vision", "no platforms listed: runs anywhere");
  const first = candidate("first.vision", ["matte"], ["macos-arm64"]);
  assert.equal(
    (pickProvider([first, apple], "matte", "macos-arm64") as { provider: VisionCandidate }).provider.id,
    "first.vision",
    "the list's order wins (bundled first)",
  );
});

// ---- the cache ----

test("cache: the key covers content, output, range, mode or box, and the module's id and version", () => {
  const base = { output: "matte" as const, start: 1, end: 2, mode: "person" as const, module: { id: "apple.vision", version: "0.1.0" } };
  const key = visionKey("fp", base);
  assert.match(key, /^[0-9a-f]{24}$/);
  assert.equal(visionKey("fp", { ...base, start: 1.0000001 }), key, "below a microsecond is the same range");
  for (const other of [
    visionKey("fp2", base),
    visionKey("fp", { ...base, start: 1.001 }),
    visionKey("fp", { ...base, end: 3 }),
    visionKey("fp", { ...base, mode: "subject" }),
    visionKey("fp", { ...base, module: { id: "onnx.vision", version: "0.1.0" } }),
    visionKey("fp", { ...base, module: { id: "apple.vision", version: "0.2.0" } }),
    visionKey("fp", { ...base, output: "faces", mode: undefined }),
    visionKey("fp", { ...base, output: "track", mode: undefined, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }),
  ])
    assert.notEqual(other, key);
  const files = visionFiles("/p", "fp", base);
  assert.equal(files.video, join("/p/.cache/analysis/fp/vision", `matte-${key}.mkv`));
  assert.equal(files.json, join("/p/.cache/analysis/fp/vision", `matte-${key}.json`));
});

const FAKE_FACES = {
  start: 1,
  end: 1.1,
  fps: 30,
  width: 64,
  height: 36,
  frames: [{ t: 1, faces: [{ id: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2, confidence: 0.9 }] }],
};
const FAKE_TRACK = {
  start: 1,
  end: 1.1,
  fps: 30,
  width: 64,
  height: 36,
  frames: [
    { t: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2, confidence: 1 },
    { t: 1.0333, lost: true },
  ],
};

/** A fake vision module: answers like the Apple plugin and writes its files where Uncut says. */
function fakeModule(answers: { matte?: (args: Record<string, unknown>) => VisionCallResult; helper?: () => string } = {}) {
  const calls: Array<{ id: string; tool: string; args: Record<string, unknown> }> = [];
  const call = async (
    id: string,
    tool: string,
    args: Record<string, unknown>,
    { signal, onProgress }: { signal: AbortSignal; onProgress: (p: number, t: number | undefined) => void },
  ) => {
    if (tool === "version") return { content: [], structured: { helper: answers.helper?.() ?? "uncut-vision 1" } };
    calls.push({ id, tool, args });
    onProgress(1, 2);
    if (signal.aborted) return { content: [] };
    if (tool === "matte") {
      if (answers.matte) return answers.matte(args);
      writeFileSync(args.out as string, "matte bytes");
      return { content: [{ type: "text", text: "3 frames" }], structured: { width: 64, height: 36, fps: 30, frames: 3, times: [0.9667, 1, 1.0333] } };
    }
    writeFileSync(args.out as string, JSON.stringify(tool === "faces" ? FAKE_FACES : FAKE_TRACK));
    return { content: [{ type: "text", text: "written" }], structured: { out: args.out } };
  };
  return { calls, call };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "uncut-vision-"));
  const project = join(root, "P.uncut");
  const media = join(root, "clip.mp4");
  writeFileSync(media, Buffer.alloc(4096, 7));
  return { root, project, media, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const signal = () => new AbortController().signal;

test("cache: a matte is made once and reused, also for a renamed file; another mode or module version is made again", async () => {
  const f = fixture();
  try {
    let helper = "uncut-vision 1";
    const module = fakeModule({ helper: () => helper });
    let version = "0.1.0";
    const vision = new VisionAnalysis({
      candidates: async () => [{ ...candidate("apple.vision", ["matte"], ["macos-arm64"]), version }],
      call: module.call,
      ffmpeg: async () => "/usr/bin/true",
      platform: "macos-arm64",
    });
    const progress: Array<number> = [];
    const first = await vision.matte(
      { dir: f.project, path: f.media },
      { start: 1, end: 1.1, mode: "person" },
      { signal: signal(), onProgress: (p) => progress.push(p) },
    );
    assert.equal(first.cached, false);
    assert.deepEqual(progress, [0.5]);
    assert.equal(first.info.frames, 3);
    assert.deepEqual(first.info.module, { id: "apple.vision", version: "0.1.0+uncut-vision 1" }, "the helper's version is part of the module's");
    assert.equal(readFileSync(first.video, "utf8"), "matte bytes");
    const sent = module.calls[0]!.args;
    assert.equal(sent.media, f.media);
    assert.equal(sent.ffmpeg, "/usr/bin/true");
    assert.match(sent.out as string, /\.part$/, "the module writes aside; Uncut renames it once it checks out");
    assert.deepEqual(
      readdirSync(visionDir(f.project, await fingerprint(f.media))).sort(),
      [`${first.video.split("/").pop()!.replace(".mkv", ".json")}`, first.video.split("/").pop()!].sort(),
    );

    const again = await vision.matte({ dir: f.project, path: f.media }, { start: 1, end: 1.1, mode: "person" }, { signal: signal() });
    assert.equal(again.cached, true);
    assert.equal(again.video, first.video);
    assert.equal(module.calls.length, 1);

    const moved = join(f.root, "renamed.mp4");
    renameSync(f.media, moved);
    assert.equal((await vision.matte({ dir: f.project, path: moved }, { start: 1, end: 1.1, mode: "person" }, { signal: signal() })).cached, true);

    assert.equal((await vision.matte({ dir: f.project, path: moved }, { start: 1, end: 1.1, mode: "subject" }, { signal: signal() })).cached, false);
    version = "0.2.0";
    assert.equal((await vision.matte({ dir: f.project, path: moved }, { start: 1, end: 1.1, mode: "person" }, { signal: signal() })).cached, false);
    assert.equal(module.calls.length, 3);
    version = "0.1.0";
    helper = "uncut-vision 2";
    assert.equal(
      (await vision.matte({ dir: f.project, path: moved }, { start: 1, end: 1.1, mode: "person" }, { signal: signal() })).cached,
      false,
      "a new helper redoes it",
    );
    helper = "uncut-vision 1";

    rmSync(first.video);
    assert.equal(
      (await vision.matte({ dir: f.project, path: moved }, { start: 1, end: 1.1, mode: "person" }, { signal: signal() })).cached,
      false,
      "info without its video doesn't count",
    );
  } finally {
    f.cleanup();
  }
});

test("steady matte (D332): Uncut keeps the stabiliser's matte, its progress follows the module's, and an older matte isn't reused", async () => {
  const f = fixture();
  try {
    const module = fakeModule();
    const asked: Array<Record<string, unknown>> = [];
    const make = (stabilise: VisionDeps["stabilise"]) =>
      new VisionAnalysis({
        candidates: async () => [candidate("apple.vision", ["matte"], ["macos-arm64"])],
        call: module.call,
        ffmpeg: async () => "/usr/bin/true",
        platform: "macos-arm64",
        stabilise,
      });
    const vision = make(async (input, { onProgress }) => {
      asked.push({ ...input });
      assert.equal(readFileSync(input.matte, "utf8"), "matte bytes");
      writeFileSync(input.out, "steady bytes");
      onProgress?.(1);
    });
    const progress: Array<number> = [];
    const made = await vision.matte(
      { dir: f.project, path: f.media },
      { start: 1, end: 1.1, mode: "person" },
      { signal: signal(), onProgress: (p) => progress.push(p) },
    );
    assert.equal(readFileSync(made.video, "utf8"), "steady bytes");
    assert.equal(asked[0]!.source, f.media);
    assert.equal(asked[0]!.ffmpeg, "/usr/bin/true");
    assert.equal((asked[0]!.info as { frames: number }).frames, 3);
    assert.deepEqual(progress, [0.4, 1]);
    const folder = visionDir(f.project, await fingerprint(f.media));
    assert.equal(readdirSync(folder).filter((n) => n.endsWith(".part")).length, 0, "no .part files left");
    assert.equal(JSON.parse(readFileSync(made.video.replace(/\.mkv$/, ".json"), "utf8")).result, 2);

    const sidecar = made.video.replace(/\.mkv$/, ".json");
    const older = JSON.parse(readFileSync(sidecar, "utf8"));
    delete older.result;
    const oldBase = join(folder, `matte-${"c".repeat(24)}`);
    writeFileSync(`${oldBase}.json`, JSON.stringify({ ...older, start: 0, end: 4 }));
    writeFileSync(`${oldBase}.mkv`, "old matte");
    const inside = await vision.matte({ dir: f.project, path: f.media }, { start: 2, end: 3, mode: "person" }, { signal: signal() });
    assert.equal(inside.cached, false, "a matte made before D332 covers the range but is redone");
  } finally {
    f.cleanup();
  }
});

test("steady matte (D332): a stabiliser that fails says so and leaves nothing", async () => {
  const f = fixture();
  try {
    const vision = new VisionAnalysis({
      candidates: async () => [candidate("apple.vision", ["matte"], ["macos-arm64"])],
      call: fakeModule().call,
      ffmpeg: async () => "/usr/bin/true",
      platform: "macos-arm64",
      stabilise: async (input) => {
        writeFileSync(input.out, "half");
        throw new Error("ffmpeg couldn't read the video: Invalid data");
      },
    });
    await assert.rejects(
      vision.matte({ dir: f.project, path: f.media }, { start: 1, end: 1.1, mode: "person" }, { signal: signal() }),
      (e: VisionFailure) => e.reason === "failed" && e.message === "Uncut couldn't make the matte steady: ffmpeg couldn't read the video: Invalid data",
    );
    assert.equal(existsSync(visionDir(f.project, await fingerprint(f.media))), false);
  } finally {
    f.cleanup();
  }
});

test("cache: faces and tracks are cached by range and box", async () => {
  const f = fixture();
  try {
    const module = fakeModule();
    const vision = new VisionAnalysis({
      candidates: async () => [candidate("apple.vision", ["faces", "track"], ["macos-arm64"])],
      call: module.call,
      ffmpeg: async () => undefined,
      platform: "macos-arm64",
    });
    const target = { dir: f.project, path: f.media };
    assert.equal((await vision.faces(target, { start: 1, end: 1.1 }, { signal: signal() })).cached, false);
    const faces = await vision.faces(target, { start: 1, end: 1.1 }, { signal: signal() });
    assert.equal(faces.cached, true);
    assert.equal(faces.result.frames[0]!.faces[0]!.id, 1);
    const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    assert.equal((await vision.track(target, { at: 1, end: 2, box }, { signal: signal() })).cached, false);
    assert.equal((await vision.track(target, { at: 1, end: 2, box }, { signal: signal() })).cached, true);
    assert.equal((await vision.track(target, { at: 1, end: 2, box: { ...box, x: 0.2 } }, { signal: signal() })).cached, false);
    assert.equal(module.calls.length, 3);
    assert.match(module.calls[0]!.args.out as string, /faces-[0-9a-f]{24}\.json\.[0-9a-f]{8}\.part$/, "the module writes its JSON to a file Uncut names");
    await assert.rejects(vision.track(target, { at: 1, end: 2, box: { ...box, x: 0.9 } }, { signal: signal() }), /inside the picture/);
    await assert.rejects(vision.faces(target, { start: 2, end: 1 }, { signal: signal() }), /is empty/);
  } finally {
    f.cleanup();
  }
});

test("cache: no provider, a module error, a bad answer and a cancel leave nothing behind", async () => {
  const f = fixture();
  try {
    const target = { dir: f.project, path: f.media };
    const range = { start: 1, end: 1.1, mode: "person" as const };
    const none = new VisionAnalysis({ candidates: async () => [], call: fakeModule().call, ffmpeg: async () => "ffmpeg", platform: "macos-arm64" });
    await assert.rejects(none.matte(target, range, { signal: signal() }), (e: VisionFailure) => e.reason === "no-provider" && e.message === NO_PROVIDER.matte);

    const failing = fakeModule({
      matte: (args) => {
        writeFileSync(args.out as string, "half");
        return { content: [{ type: "text", text: "Subject cutout needs macOS 14 or later." }], isError: true };
      },
    });
    const apple = async () => [candidate("apple.vision", ["matte"], ["macos-arm64"])];
    const v1 = new VisionAnalysis({ candidates: apple, call: failing.call, ffmpeg: async () => "ffmpeg", platform: "macos-arm64" });
    await assert.rejects(v1.matte(target, range, { signal: signal() }), /needs macOS 14/);

    const bad = fakeModule({
      matte: (args) => {
        writeFileSync(args.out as string, "x");
        return { content: [], structured: { width: 64, height: 36, fps: 30, frames: 2, times: [1] } };
      },
    });
    const v2 = new VisionAnalysis({ candidates: apple, call: bad.call, ffmpeg: async () => "ffmpeg", platform: "macos-arm64" });
    await assert.rejects(v2.matte(target, range, { signal: signal() }), /can't use: The matte says 2 frames but lists 1 times/);

    const controller = new AbortController();
    const cancelling = fakeModule({
      matte: (args) => {
        writeFileSync(args.out as string, "x");
        controller.abort();
        return { content: [] };
      },
    });
    const v3 = new VisionAnalysis({ candidates: apple, call: cancelling.call, ffmpeg: async () => "ffmpeg", platform: "macos-arm64" });
    await assert.rejects(v3.matte(target, range, { signal: controller.signal }), /cancelled/);

    const brokenFaces = new VisionAnalysis({
      candidates: async () => [candidate("apple.vision", ["faces"], ["macos-arm64"])],
      call: async (_id, tool, args) =>
        tool === "version" ? { content: [], structured: { helper: "uncut-vision 1" } } : (writeFileSync(args.out as string, "{not json"), { content: [] }),
      ffmpeg: async () => undefined,
      platform: "macos-arm64",
    });
    await assert.rejects(brokenFaces.faces(target, { start: 1, end: 1.1 }, { signal: signal() }), /doesn't have the faces shape/);

    const noFfmpeg = new VisionAnalysis({ candidates: apple, call: fakeModule().call, ffmpeg: async () => undefined, platform: "macos-arm64" });
    await assert.rejects(noFfmpeg.matte(target, range, { signal: signal() }), /ffmpeg isn't installed/);

    const dir = visionDir(f.project, await fingerprint(f.media));
    assert.ok(!existsSync(dirname(dir)), "no part files, no info, no empty folders");
  } finally {
    f.cleanup();
  }
});
