// D349: a video with sound the agent puts on the timeline (insert_item, place_item, put_on_main)
// becomes a linked pair, the clip muted and its sound on an audio track; a muted clip stays one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, type Op, type Project } from "../../packages/core/src/index.ts";
import { linkIndex } from "../../packages/core/src/timeline/arrange.ts";
import { expandConvenienceOps } from "../../apps/server/src/agent/tools/expand.ts";
import { linkedOps } from "../helpers/links.ts";

const project = (): Project => ({
  format: "uncut/0",
  name: "Agent pairs",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [{ id: "talk", kind: "video", name: "talk.mp4", path: "/talk.mp4", probe: { frames: 600, fps: 30, width: 320, height: 180, hasAudio: true } }],
  tracks: [
    { id: "v2", kind: "video", name: "Video 2", items: [{ id: "o", type: "clip", media: "talk", in: 0, start: 0, duration: 60 }] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
  ],
});

function edited(p: Project, ops: ReadonlyArray<unknown>): Project {
  const expanded = expandConvenienceOps(p, ops);
  if ("problem" in expanded) throw new Error(expanded.problem);
  return applyEdit(createSession(p), { actor: "agent", ops: linkedOps(p, expanded.ops as ReadonlyArray<Op>) }).project;
}
const soundOf = (p: Project, id: string) => {
  const index = linkIndex(p.tracks);
  const key = index.keyOf.get(id);
  return key ? index.members.get(key)!.find((m) => m.item.id !== id) : undefined;
};

test("D349: the agent's insert_item and place_item of a video with sound make a pair", () => {
  const p = edited(project(), [
    { op: "insert_item", track: "main", item: { id: "c1", type: "clip", media: "talk", in: 0, duration: 90 } },
    { op: "place_item", track: "v2", place: "free-track", item: { id: "c2", type: "clip", media: "talk", in: 200, duration: 30, start: 10 } },
  ]);
  for (const id of ["c1", "c2"]) {
    const sound = soundOf(p, id);
    assert.ok(sound, `${id} has its sound`);
    assert.equal(sound.track.kind, "audio");
    assert.equal(p.tracks.flatMap((t) => t.items).find((i) => i.id === id)!.mute, true);
  }
});

test("D349: put_on_main pairs the clip it moves; a clip the agent inserts muted stays one clip", () => {
  const p = edited(project(), [
    { op: "put_on_main", item: "o" },
    { op: "insert_item", track: "main", item: { id: "quiet", type: "clip", media: "talk", in: 0, duration: 30, mute: true } },
  ]);
  assert.ok(soundOf(p, "o"));
  assert.equal(soundOf(p, "quiet"), undefined);
  assert.equal(p.tracks.flatMap((t) => t.items).filter((i) => i.type === "audio").length, 1);
});
