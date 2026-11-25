// Linked items (D338, by delta since D347): an edit changes a linked item only when it changes its
// mate, links of different lengths keep their frames, and whatever the link adds is in the edit's lines.
// The fixture mirrors the xd2 project at revision 143 (a voice of 1520 frames linked to a 733-frame
// camera clip) and the revision 144 that restyled other items and cut the voice to 733.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { applyEdit, createSession, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import { linkLines } from "../../packages/core/src/timeline/arrange.ts";
import { linkedOps } from "../helpers/links.ts";
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
const edit = (p: Project, ops: ReadonlyArray<Op>) => apply(p, linkedOps(p, ops));

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
  assert.deepEqual(linkedOps(offset, restyle), restyle);
  const after = edit(offset, restyle);
  assert.deepEqual(find(after, "audio-7"), find(offset, "audio-7"));
});

test("xd2 revision 143 to 144: restyling other items keeps the 1520-frame voice whole", () => {
  const rev143 = project({ duration: 1520 });
  const rev144 = edit(rev143, restyle);
  assert.equal(find(rev144, "audio-7")!.duration, 1520);
  assert.equal(find(rev144, "audio-7")!.linkedTo, "clip-13");
  assert.deepEqual(linkLines(rev143, restyle, linkedOps(rev143, restyle)), []);
});

test("D347: a 1520-frame voice linked to a 733-frame clip keeps its frames when the clip is trimmed (its end didn't line up)", async () => {
  const unlinked = project({ duration: 1520, linkedTo: undefined });
  const link: ReadonlyArray<Op> = [
    { op: "update_item", item: "audio-7", set: { link: "voice" } },
    { op: "update_item", item: "clip-13", set: { link: "voice" } },
  ];
  const { rows, send } = editor(unlinked);
  assert.equal((await send(link))._tag, "Success");
  assert.equal(rows.length, 1);
  const linked = edit(unlinked, link);
  const trimmed = edit(linked, [{ op: "trim_item", item: "clip-13", edge: "end", frames: 100 }]);
  assert.deepEqual([find(trimmed, "clip-13")!.duration, find(trimmed, "audio-7")!.duration], [633, 1520]);
  const split = edit(linked, [{ op: "split_item", item: "clip-13", at: 300, newId: "clip-13b" }]);
  const voice = split.tracks.find((t) => t.id === "audio")!.items.filter((i) => i.id !== "audio-6");
  assert.deepEqual(
    voice.map((i) => [i.start, i.duration]),
    [
      [1102, 300],
      [1402, 1220],
    ],
  );
});

test("a trim of the clip still trims its linked voice where their ends line up, and the edit's lines say so", async () => {
  const p = project();
  const trim: ReadonlyArray<Op> = [{ op: "trim_item", item: "clip-13", edge: "end", frames: 100 }];
  assert.equal(find(edit(p, trim), "audio-7")!.duration, 633);
  assert.equal(find(edit(p, trim), "audio-6")!.duration, 163, "the other voice's clip didn't change");
  const { rows, send } = editor(p);
  const result = await send(trim);
  assert.equal(result._tag, "Success");
  const lines = rows[0]!.lines ?? [];
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines[1]!, /Trimmed camera\.mp4 \(audio-7\) with the item it's linked to: end edge by 3\.3s/);
});
