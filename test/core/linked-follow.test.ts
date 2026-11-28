// D123 linked items: an edit re-syncs a linked item only when it changes the item's clip; a link
// between items of different lengths is refused; whatever the follow changes is in the edit's lines.
// The fixture mirrors the xd2 project at revision 143 (a voice of 1520 frames linked to a 733-frame
// camera clip) and the revision 144 that restyled other items and cut the voice to 733.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { applyEdit, createSession, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import { linkedFollowLines, linkLengthProblem, withLinkedAudio } from "../../packages/core/src/timeline/arrange.ts";
import { makeEditUnlocked } from "../../apps/server/src/project/projects/edit.ts";
import type { ProjectFormatShape } from "../../apps/server/src/project/format.ts";
import type { OpenProject } from "../../apps/server/src/project/projects/service.ts";
import type { NewRow } from "../../apps/server/src/project/history.ts";

// effect is the server's dependency, not the repo root's.
const fromServer = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const Effect = (await import(pathToFileURL(fromServer.resolve("effect/Effect")).href)) as typeof import("../../apps/server/node_modules/effect/dist/Effect.js");

const cam = (id: string, start: number, duration: number, input: number): Item => ({ id, type: "clip", media: "cam", in: input, start, duration });

const project = (voice: Partial<Item> = {}): Project => ({
  format: "uncut/0",
  name: "xd2",
  canvas: { width: 1080, height: 1920, fps: 30 },
  media: [
    { id: "cam", kind: "video", name: "camera.mp4", path: "/camera.mp4", probe: { frames: 20000, fps: 30, width: 1080, height: 1920, hasAudio: true } },
    { id: "screen", kind: "video", name: "screen.mov", path: "/screen.mov", probe: { frames: 20000, fps: 30, width: 1920, height: 1080, hasAudio: false } },
  ],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [{ id: "title-mcp", type: "text", start: 1200, duration: 90, text: "MCP coming soon" }] },
    {
      id: "video-track-2",
      kind: "video",
      name: "Camera",
      items: [cam("clip-10", 939, 163, 3494), cam("clip-13", 1102, 733, 3680), cam("cam-a2", 1835, 787, 4413)],
    },
    { id: "video-track-1", kind: "video", name: "Screen", items: [{ id: "screen-a2", type: "clip", media: "screen", in: 4480, start: 1835, duration: 787 }] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
    {
      id: "audio",
      kind: "audio",
      name: "Voice",
      items: [
        { id: "audio-6", type: "audio", media: "cam", in: 3494, start: 939, duration: 163, linkedTo: "clip-10" },
        { id: "audio-7", type: "audio", media: "cam", in: 3680, start: 1102, duration: 733, linkedTo: "clip-13", ...voice },
      ],
    },
  ],
});

const find = (p: Project, id: string) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id);
const apply = (p: Project, ops: ReadonlyArray<Op>) => applyEdit(createSession(p), { actor: "user", ops }).project;
const edit = (p: Project, ops: ReadonlyArray<Op>) => apply(p, withLinkedAudio(p, ops));

const restyle: ReadonlyArray<Op> = [
  { op: "update_item", item: "screen-a2", set: { transform: { x: -779, y: -241, w: 3286, h: 1700 } } },
  { op: "update_item", item: "title-mcp", set: { transform: { x: 1376, y: 660, w: 496 }, style: { size: 48, weight: 800 } } },
];

const editor = (p: Project) => {
  const rows: Array<NewRow> = [];
  const open = { dir: "/xd2", session: createSession(p), past: [], future: [], unlogged: [], history: { agentList: () => [] } } as unknown as OpenProject;
  const format = { validate: () => [], validateOps: () => [] } as unknown as ProjectFormatShape;
  const run = makeEditUnlocked({
    format,
    commit: (_p, next, _move, row) => {
      rows.push(row);
      return Effect.succeed({ dir: "/xd2", project: next.project, revision: next.revision, canUndo: true, canRedo: false });
    },
  });
  const send = (ops: ReadonlyArray<Op>) => Effect.runPromise(Effect.result(run(open, { ops, summary: "Edit" })));
  return { rows, send };
};

test("an edit that leaves a linked item's clip alone leaves the linked item alone", () => {
  const offset = project({ start: 1110 });
  assert.deepEqual(withLinkedAudio(offset, restyle), restyle);
  const after = edit(offset, restyle);
  assert.deepEqual(find(after, "audio-7"), find(offset, "audio-7"));
});

test("xd2 revision 143 to 144: restyling other items keeps the 1520-frame voice whole", () => {
  const rev143 = project({ duration: 1520 });
  const rev144 = edit(rev143, restyle);
  assert.equal(find(rev144, "audio-7")!.duration, 1520);
  assert.equal(find(rev144, "audio-7")!.linkedTo, "clip-13");
  assert.deepEqual(linkedFollowLines(rev143, restyle), []);
});

test("linking a 1520-frame voice to a 733-frame clip is refused, with the lengths and what to do", async () => {
  const unlinked = project({ duration: 1520, linkedTo: undefined });
  const link: ReadonlyArray<Op> = [{ op: "update_item", item: "audio-7", set: { linkedTo: "clip-13" } }];
  const problem = linkLengthProblem(edit(unlinked, link), link);
  assert.match(problem ?? "", /audio-7 is 1520 frames and clip-13 is 733/);
  assert.match(problem ?? "", /Split or trim audio-7 to 733 frames first/);
  const { rows, send } = editor(unlinked);
  const result = await send(link);
  assert.equal(result._tag, "Failure");
  assert.equal(rows.length, 0, "nothing is committed");
  assert.equal(linkLengthProblem(edit(project({ linkedTo: undefined }), link), link), undefined, "equal lengths link");
  const nowhere: ReadonlyArray<Op> = [{ op: "update_item", item: "audio-7", set: { linkedTo: "title-mcp" } }];
  assert.match(linkLengthProblem(edit(unlinked, nowhere), nowhere) ?? "", /no clip with that id/);
});

test("a trim of the clip still trims its linked voice, and the edit's lines say so", async () => {
  const p = project();
  const trim: ReadonlyArray<Op> = [{ op: "trim_item", item: "clip-13", edge: "end", frames: 100 }];
  assert.equal(find(edit(p, trim), "audio-7")!.duration, 633);
  assert.equal(find(edit(p, trim), "audio-6")!.duration, 163, "the other voice's clip didn't change");
  const { rows, send } = editor(p);
  const result = await send(trim);
  assert.equal(result._tag, "Success");
  const lines = rows[0]!.lines ?? [];
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines[1]!, /audio-7\) followed camera\.mp4 \(clip-13\): length 733 to 633 frames/);
});

test("when a follow is in the way, only the item that was to follow is unlinked", () => {
  const p = project();
  const move: ReadonlyArray<Op> = [{ op: "move_item", item: "clip-13", start: 800 }];
  const after = edit(p, move);
  assert.equal(find(after, "audio-7")!.linkedTo, undefined, "audio-7 would overlap audio-6: it stops following");
  assert.equal(find(after, "audio-7")!.start, 1102);
  assert.equal(find(after, "audio-6")!.linkedTo, "clip-10", "audio-6's clip didn't change");
});

test("an item linked to a clip that is already gone is left alone", () => {
  const p = project({ linkedTo: "clip-gone" });
  assert.deepEqual(withLinkedAudio(p, restyle), restyle);
  assert.deepEqual(find(edit(p, restyle), "audio-7"), find(p, "audio-7"));
});

test("rolling the cut into a linked voice unlinks it, so its clip's next edit can't put it out of sync", () => {
  const voices = (p: Project): Project => ({
    ...p,
    tracks: p.tracks.map((t) =>
      t.id === "audio"
        ? {
            ...t,
            items: [
              { id: "audio-6", type: "audio", media: "cam", in: 3494, start: 939, duration: 163, linkedTo: "clip-10" },
              { id: "audio-7", type: "audio", media: "cam", in: 3680, start: 1102, duration: 733, linkedTo: "clip-13" },
            ],
          }
        : t,
    ),
  });
  const rolled = edit(voices(project()), [{ op: "roll_edit", item: "audio-6", frames: -30 }]);
  assert.equal(find(rolled, "audio-7")!.linkedTo, undefined, "the roll trimmed audio-7 itself");
  assert.equal(find(rolled, "audio-6")!.linkedTo, undefined);
  const trimmed = edit(rolled, [{ op: "trim_item", item: "clip-13", edge: "end", frames: 10 }]);
  assert.deepEqual(find(trimmed, "audio-7"), find(rolled, "audio-7"));
});

test("a sound that ends with its media before its clip does can be linked at that length", () => {
  const atEnd = (voice: Partial<Item>): Project => {
    const p = project({ in: 19900, ...voice });
    const camera = p.tracks.find((t) => t.id === "video-track-2")!;
    return { ...p, tracks: p.tracks.map((t) => (t === camera ? { ...t, items: t.items.map((i) => (i.id === "clip-13" ? { ...i, in: 19900 } : i)) } : t)) };
  };
  const relink: ReadonlyArray<Op> = [{ op: "update_item", item: "audio-7", set: { gainDb: -3, linkedTo: "clip-13" } }];
  const short = atEnd({ duration: 100 });
  assert.equal(linkLengthProblem(edit(short, relink), relink), undefined, "100 frames is what the follow gives it");
  const shorter = atEnd({ duration: 80, linkedTo: undefined });
  assert.match(linkLengthProblem(edit(shorter, relink), relink) ?? "", /would make audio-7 100 frames\. Split or trim audio-7 to 100 frames first/);
});
