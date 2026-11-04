// D328: the agent's reframe and text_behind_subject ops, expanded by the server into the edit ops
// that do them; reframe finds the clip's faces through a fake vision module standing in for a plugin,
// only from media files the project may read (D12); bad shapes and refusals come back as sentences.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyEdit, createSession, CUTOUT, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import { VisionAnalysis } from "../../apps/server/src/analysis/vision/vision.ts";
import { expandVisionOps } from "../../apps/server/src/agent/tools/visionOps.ts";
import { OP_SHAPES } from "../../apps/server/src/agent/tools/opShapes.ts";

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
    candidates: async () => [{ id: "fake.vision", name: "Fake", version: "1.0.0", manifest: { id: "fake.vision", kind: "analyzer", analyzer: { inputs: ["video"], outputs: ["matte", "faces"], backend: "system" } } }],
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
    const r = await expandVisionOps(f.project(), f.dir, [{ op: "reframe", item: "c" }, { op: "text_behind_subject", texts: ["title"] }], vision, async () => "ffmpeg");
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
