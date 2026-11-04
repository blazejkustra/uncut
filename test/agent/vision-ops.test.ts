// D328: the agent's reframe and text_behind_subject ops, expanded by the server into the edit ops
// that do them; reframe finds the clip's faces through a fake vision module standing in for a plugin,
// only from media files the project may read (D12); bad shapes and refusals come back as sentences.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyEdit, createSession, CUTOUT, keyAt, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import { VisionAnalysis } from "../../apps/server/src/analysis/vision/vision.ts";
import { expandVisionOps } from "../../apps/server/src/agent/tools/visionOps.ts";
import { OP_SHAPES } from "../../apps/server/src/agent/tools/opShapes.ts";
import { expandConvenienceOps } from "../../apps/server/src/agent/tools/expand.ts";

/** A face on the left for the first second, then on the right. */
const FACES = {
  start: 0,
  end: 6,
  fps: 30,
  width: 1920,
  height: 1080,
  frames: Array.from({ length: 180 }, (_, i) => ({ t: i / 30, faces: [{ id: 1, x: i < 30 ? 0.1 : 0.75, y: 0.2, w: 0.1, h: 0.2, confidence: 0.9 }] })),
};

function fakeVision(calls: Array<Record<string, unknown>>) {
  return new VisionAnalysis({
    candidates: async () => [
      {
        id: "fake.vision",
        name: "Fake",
        version: "1.0.0",
        manifest: { id: "fake.vision", kind: "analyzer", analyzer: { inputs: ["video"], outputs: ["matte", "faces"], backend: "system" } },
      },
    ],
    call: async (_id, tool, args) => {
      if (tool === "version") return { content: [] };
      calls.push({ tool, ...args });
      writeFileSync(args.out as string, JSON.stringify(FACES));
      return { content: [{ type: "text", text: "written" }], structured: {} };
    },
    ffmpeg: async () => "ffmpeg",
    platform: "macos-arm64",
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "uncut-vision-ops-"));
  const dir = join(root, "P.uncut");
  mkdirSync(dir);
  writeFileSync(join(root, "talk.mp4"), Buffer.alloc(4096, 3));
  writeFileSync(join(dir, "project.json"), "{}");
  const project = (path = join(root, "talk.mp4")): Project => ({
    format: "uncut/0",
    name: "Ops",
    canvas: { width: 1080, height: 1920, fps: 30 },
    media: [{ id: "m", kind: "video", name: "talk.mp4", path, probe: { frames: 180, fps: 30, width: 1920, height: 1080, hasAudio: true } }],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [{ id: "title", type: "text", text: "HI", start: 0, duration: 60 } as Item] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c", type: "clip", media: "m", in: 0, duration: 90 } as Item] },
    ],
  });
  return { root, dir, project, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const apply = (p: Project, ops: ReadonlyArray<unknown>) => applyEdit(createSession(p), { actor: "agent", ops: ops as ReadonlyArray<Op> }).project;

test("D328: reframe finds the faces, then keys the clip to follow them; text_behind_subject copies the clip above the text", async () => {
  const f = fixture();
  try {
    const calls: Array<Record<string, unknown>> = [];
    const vision = fakeVision(calls);
    const r = await expandVisionOps(
      f.project(),
      f.dir,
      [
        { op: "reframe", item: "c" },
        { op: "text_behind_subject", texts: ["title"] },
      ],
      vision,
      async () => "ffmpeg",
    );
    assert.ok(!("problem" in r), JSON.stringify(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.tool, "faces");
    assert.deepEqual([calls[0]!.start, calls[0]!.end], [0, 4]);
    const after = apply(f.project(), r.ops);
    const clip = after.tracks.find((t) => t.id === "main")!.items[0]!;
    assert.equal(clip.transform?.fit, "cover");
    assert.ok((clip.keys?.length ?? 0) >= 2 && (clip.keys?.length ?? 0) <= 4, JSON.stringify(clip.keys));
    assert.ok(clip.keys!.at(-1)!.x! < clip.keys![0]!.x!, "the box moves left to bring the right-hand face to the middle");
    const copy = after.tracks[0]!.items[0]!;
    assert.ok(copy.effects?.some((e) => e.module === CUTOUT));
    assert.equal(after.tracks[1]!.id, "text");
    // The faces are cached: a second reframe asks the module nothing.
    await expandVisionOps(f.project(), f.dir, [{ op: "reframe", item: "c" }], vision, async () => "ffmpeg");
    assert.equal(calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test("D328: the vision ops refuse bad shapes, files outside the rules and what can't be done, with a sentence", async () => {
  const f = fixture();
  try {
    const vision = fakeVision([]);
    const ffmpeg = async () => "ffmpeg";
    const problem = async (p: Project, ops: Array<unknown>) => ((await expandVisionOps(p, f.dir, ops, vision, ffmpeg)) as { problem: string }).problem;
    assert.match(await problem(f.project(), [{ op: "reframe", item: "c", zoom: 9 }]), /zoom must be a number from 1 to 4/);
    assert.match(await problem(f.project(), [{ op: "reframe", item: "c", aspect: "9:16" }]), /unknown field aspect/);
    assert.match(await problem(f.project(), [{ op: "text_behind_subject", texts: [] }]), /texts must be text item ids/);
    assert.match(await problem(f.project(), [{ op: "text_behind_subject", texts: ["c"] }]), /text items/);
    assert.match(await problem(f.project(join(f.dir, "project.json")), [{ op: "reframe", item: "c" }]), /project's own files/);
    assert.match(await problem(f.project(join(f.root, "gone.mp4")), [{ op: "reframe", item: "c" }]), /isn't there/);
    assert.match(OP_SHAPES.reframe!, /"op":"reframe", item, zoom\?/);
    assert.match(OP_SHAPES.text_behind_subject!, /texts/);
  } finally {
    f.cleanup();
  }
});

function trackFixture() {
  const root = mkdtempSync(join(tmpdir(), "uncut-track-ops-"));
  const dir = join(root, "P.uncut");
  mkdirSync(dir);
  writeFileSync(join(dir, "project.json"), "{}");
  const media = join(root, "talk.mp4");
  writeFileSync(media, Buffer.alloc(4096, 3));
  const project: Project = {
    format: "uncut/0",
    name: "T",
    canvas: { width: 1920, height: 1080, fps: 30 },
    media: [{ id: "m", kind: "video", name: "talk.mp4", path: media, probe: { frames: 60, fps: 30, width: 1920, height: 1080, hasAudio: false } }],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [{ id: "t", type: "text", text: "Hi", start: 0, duration: 60, transform: { x: 50, y: 60 } } as Item] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c", type: "clip", media: "m", in: 0, duration: 60 } as Item] },
    ],
  };
  return { root, dir, media, project, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const TRACK_OP = { op: "track", item: "t", target: "c", at: 0, box: { x: 200, y: 200, w: 100, h: 100 } };

/** A module that writes a track: the object moves right, lost at `lostAt` when given. */
function trackVision(calls: Array<Record<string, unknown>>, lostAt?: number, hold?: (signal: AbortSignal) => Promise<void>) {
  return new VisionAnalysis({
    candidates: async () => [
      {
        id: "fake.vision",
        name: "Fake",
        version: "1.0.0",
        manifest: { id: "fake.vision", kind: "analyzer", analyzer: { inputs: ["video"], outputs: ["track"], backend: "system" } },
      },
    ],
    call: async (_id, tool, args, { signal }) => {
      if (tool === "version") return { content: [] };
      calls.push({ tool, ...args });
      await hold?.(signal);
      const count = lostAt ?? 60;
      const frames: Array<Record<string, unknown>> = Array.from({ length: count }, (_, i) => ({
        t: i / 30,
        x: 0.1 + i * 0.005,
        y: 0.2,
        w: 0.1,
        h: 0.1,
        confidence: 0.9,
      }));
      if (lostAt !== undefined) frames.push({ t: lostAt / 30, lost: true });
      writeFileSync(args.out as string, JSON.stringify({ start: 0, end: 2, fps: 30, width: 1920, height: 1080, frames }));
      return { content: [{ type: "text", text: "written" }], structured: {} };
    },
    ffmpeg: async () => "ffmpeg",
    platform: "macos-arm64",
  });
}

const FFMPEG = async () => "ffmpeg";

test("D329: track follows the object and writes ordinary keys on the text; a loss is a note, and the box reaches the module as 0 to 1", async () => {
  const f = trackFixture();
  try {
    const calls: Array<Record<string, unknown>> = [];
    const r = await expandVisionOps(f.project, f.dir, [TRACK_OP], trackVision(calls, 30), FFMPEG);
    assert.ok(!("problem" in r), JSON.stringify(r));
    assert.deepEqual(calls[0]!.box, { x: 200 / 1920, y: 200 / 1080, w: 100 / 1920, h: 100 / 1080 });
    assert.equal(calls[0]!.media, realpathSync(f.media));
    const after = applyEdit(createSession(f.project), { actor: "agent", ops: r.ops as ReadonlyArray<Op> }).project;
    const keys = after.tracks[0]!.items[0]!.keys!;
    assert.equal(keys[0]!.x, 50);
    assert.ok(keys.at(-1)!.x! > 50);
    assert.match(r.notes[0]!, /lost at 0:01/);
  } finally {
    f.cleanup();
  }
});

test("D329: track's bad shapes, a reversed clip and offline media are refused with a sentence", async () => {
  const f = trackFixture();
  try {
    const vision = trackVision([]);
    const problem = async (op: unknown, project = f.project) => {
      const r = await expandVisionOps(project, f.dir, [op], vision, FFMPEG);
      return (r as { problem: string }).problem;
    };
    assert.match(await problem({ ...TRACK_OP, at: 1.5 }), /at must be a timeline frame/);
    assert.match(await problem({ ...TRACK_OP, box: { x: 1 } }), /box must be/);
    assert.match(await problem({ ...TRACK_OP, target: 3 }), /target must/);
    assert.match(await problem({ ...TRACK_OP, zoom: 2 }), /unknown field zoom/);
    assert.match(await problem({ ...TRACK_OP, scale: "yes" }), /scale must/);
    const reversed = {
      ...f.project,
      tracks: [f.project.tracks[0]!, { ...f.project.tracks[1]!, items: [{ ...f.project.tracks[1]!.items[0]!, reverse: true }] }],
    };
    assert.match(await problem(TRACK_OP, reversed), /plays backwards/);
    rmSync(f.media);
    assert.match(await problem(TRACK_OP), /isn't there/);
  } finally {
    f.cleanup();
  }
});

test("D329: stopping the turn stops the tracker", async () => {
  const f = trackFixture();
  try {
    const stop = new AbortController();
    const seen: Array<AbortSignal> = [];
    const vision = trackVision([], undefined, (signal) => {
      seen.push(signal);
      stop.abort();
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const r = await expandVisionOps(f.project, f.dir, [TRACK_OP], vision, FFMPEG, stop.signal);
    assert.match((r as { problem: string }).problem, /Stopped/);
    assert.equal(seen[0]!.aborted, true);
  } finally {
    f.cleanup();
  }
});

test("D329: the track op's shape is in the tool's spec", () => {
  assert.match(OP_SHAPES.track!, /"op":"track"/);
});

const textKeys = (p: Project, ops: ReadonlyArray<unknown>) =>
  applyEdit(createSession(p), { actor: "agent", ops: ops as ReadonlyArray<Op> }).project.tracks[0]!.items[0]!.keys!;

test("D329 review: the user changing the target during the wait: track plans on the project as it is after it", async () => {
  const f = trackFixture();
  try {
    let open = f.project;
    const faster = {
      ...f.project,
      tracks: [f.project.tracks[0]!, { ...f.project.tracks[1]!, items: [{ ...f.project.tracks[1]!.items[0]!, speed: 2, duration: 30 }] }],
    };
    const vision = trackVision([], undefined, async () => {
      open = faster;
    });
    const r = await expandVisionOps(f.project, f.dir, [TRACK_OP], vision, FFMPEG, undefined, { current: () => open });
    assert.ok(!("problem" in r), JSON.stringify(r));
    const atFifteen = keyAt(textKeys(faster, r.ops), "x", 15, 30)! - 50;
    assert.ok(Math.abs(atFifteen - 30 * 0.005 * 1920) < 10, `the clip's new 2× mapping: moved ${atFifteen}`);
    const gone = { ...f.project, tracks: [f.project.tracks[0]!, { ...f.project.tracks[1]!, items: [] }] };
    const vanish = trackVision([], undefined, async () => {
      open = gone;
    });
    const refused = await expandVisionOps(f.project, f.dir, [{ ...TRACK_OP, box: { x: 210, y: 200, w: 100, h: 100 } }], vanish, FFMPEG, undefined, {
      current: () => open,
    });
    assert.match((refused as { problem: string }).problem, /video clip/);
  } finally {
    f.cleanup();
  }
});

test("D329 review: reframe plans on the project as it is after the wait too", async () => {
  const f = fixture();
  try {
    const before = f.project();
    const fade = [
      { frame: 0, opacity: 0 },
      { frame: 20, opacity: 1 },
    ];
    let open = before;
    const vision = fakeVision([]);
    const current = () => (open = apply(before, [{ op: "update_item", item: "c", set: { keys: fade } }]));
    const r = await expandVisionOps(before, f.dir, [{ op: "reframe", item: "c" }], vision, FFMPEG, undefined, { current });
    assert.ok(!("problem" in r), JSON.stringify(r));
    const clip = apply(open, r.ops).tracks[1]!.items[0]!;
    assert.ok(
      clip.keys!.some((k) => k.opacity === 1),
      "the key added during the wait stays",
    );
  } finally {
    f.cleanup();
  }
});

test("D329 review: a title added in the same batch can be pinned; a bad earlier op is a sentence, never a throw", async () => {
  const f = trackFixture();
  try {
    const prepare = (p: Project, ops: ReadonlyArray<unknown>) => expandConvenienceOps(p, ops);
    const title = { op: "insert_text", id: "new-title", look: "text.big-title", text: "Hi", start: 0, duration: 60 };
    const pin = { ...TRACK_OP, item: "new-title" };
    const r = await expandVisionOps(f.project, f.dir, [title, pin], trackVision([]), FFMPEG, undefined, { prepare });
    assert.ok(!("problem" in r), JSON.stringify(r));
    const ready = expandConvenienceOps(f.project, r.ops);
    assert.ok(!("problem" in ready), JSON.stringify(ready));
    const after = applyEdit(createSession(f.project), { actor: "agent", ops: ready.ops as ReadonlyArray<Op> }).project;
    const pinned = after.tracks.flatMap((t) => t.items).find((i) => i.id === "new-title")!;
    assert.ok(pinned.keys!.length >= 2, JSON.stringify(pinned.keys));

    const noPrepare = await expandVisionOps(f.project, f.dir, [title, pin], trackVision([]), FFMPEG);
    assert.match((noPrepare as { problem: string }).problem, /ops\[1\] \(track\): the ops before it can't be applied/);
    const bad = await expandVisionOps(f.project, f.dir, [{ op: "update_item", item: "nope", set: {} }, TRACK_OP], trackVision([]), FFMPEG, undefined, {
      prepare,
    });
    assert.match((bad as { problem: string }).problem, /can't be applied/);
    const badLook = await expandVisionOps(f.project, f.dir, [{ ...title, look: 3 }, pin], trackVision([]), FFMPEG, undefined, { prepare });
    assert.match((badLook as { problem: string }).problem, /look must be/);
  } finally {
    f.cleanup();
  }
});

test("D329 review: run.ts gives the vision ops the project now and the expansions; tracked is once per result; reframe's call has the long timeout", () => {
  const run = readFileSync("apps/server/src/agent/tools/run.ts", "utf8");
  assert.match(run, /r\.abort\.signal,\s*\{\s*current: openNow,\s*prepare,?\s*\}/);
  assert.doesNotMatch(run, /\.\.\.tracked,\s*\.\.\.tracked/);
  const actions = readFileSync("apps/web/src/state/store/actions/export.ts", "utf8");
  assert.match(actions, /c\["vision\.reframe"\]\(\{ itemId \}\), VISION_EDIT_TIMEOUT_MS\)/);
  assert.match(actions, /c\["vision\.track"\]\(ask\), VISION_EDIT_TIMEOUT_MS\)/);
});
