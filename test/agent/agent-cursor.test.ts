// D348: where an agent's cursor goes for each tool call (timeline_edit ops on items, range reads,
// frame checks, transcript cuts, tools with nothing on screen), and its children: a subagent from
// its Task call until the call's result, a subagent's own calls, a critic round while it runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project } from "../../packages/core/src/index.ts";

import { CURSOR_STOPS, cursorCall, cursorCallEnded, cursorChildCall, cursorTarget, cursorTrail, cursorView } from "../../apps/server/src/agent/agentCursor.ts";

const clip = (id: string, duration: number) => ({ id, type: "clip", media: "m1", in: 0, duration });
const project = {
  format: "uncut/0",
  name: "Cursor",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [],
  tracks: [
    { id: "main", kind: "video", role: "main", name: "Main", items: [clip("c1", 90), clip("c2", 60), clip("c3", 120)] },
    { id: "text", kind: "text", name: "Text", items: [{ id: "t1", type: "text", start: 30, duration: 45, text: "Hi" }] },
  ],
} as unknown as Project;

const edit = (...ops: Array<Record<string, unknown>>) => cursorTarget("timeline_edit", { baseRevision: 1, summary: "x", ops }, project);

test("a trim goes to the edge it trims", () => {
  assert.deepEqual(edit({ op: "trim_item", item: "c2", edge: "start", frames: 10 }), { kind: "item", item: "c2", at: "start", frame: 90, track: "main" });
  assert.deepEqual(edit({ op: "trim_item", item: "c2", edge: "end", frames: -5 }), { kind: "item", item: "c2", at: "end", frame: 150, track: "main" });
  assert.deepEqual(edit({ op: "roll_edit", item: "c1", frames: 4 }), { kind: "item", item: "c1", at: "end", frame: 90, track: "main" });
});

test("a split goes to its frame, moves, updates and deletes to the item's centre", () => {
  assert.deepEqual(edit({ op: "split_item", item: "c3", at: 40, newId: "c3b" }), { kind: "item", item: "c3", offset: 40, frame: 190, track: "main" });
  for (const op of [
    { op: "move_item", item: "t1", start: 200 },
    { op: "update_item", item: "t1", set: { text: "Yo" } },
    { op: "delete_item", item: "t1" },
    { op: "slip_item", item: "t1", frames: 3 },
    { op: "set_speed", item: "t1", speed: 2 },
  ])
    assert.deepEqual(edit(op), { kind: "item", item: "t1", at: "centre", frame: 53, track: "text" }, op.op);
  assert.deepEqual(edit({ op: "set_transition", item: "c2", transition: null }).at, "start");
});

test("a new item points where it will land; track ops at the track; the first op with a place wins", () => {
  assert.deepEqual(edit({ op: "insert_item", track: "text", item: { id: "t2", type: "text", start: 300, duration: 30 } }), {
    kind: "item",
    item: "t2",
    at: "centre",
    track: "text",
    frame: 300,
  });
  assert.deepEqual(edit({ op: "insert_text", text: "Hello", start: 60 }), { kind: "time", frame: 60 });
  assert.deepEqual(edit({ op: "update_track", track: "text", set: { name: "Titles" } }), { kind: "track", track: "text" });
  assert.deepEqual(edit({ op: "update_project", set: { name: "x" } }, { op: "trim_item", item: "c1", edge: "end", frames: 2 }).item, "c1");
  assert.deepEqual(edit({ op: "add_media", media: { id: "m2" } }), { kind: "park" });
  assert.deepEqual(edit({ op: "update_item", item: "gone", set: {} }), { kind: "item", item: "gone", at: "centre" });
});

test("range reads and frame checks go to the ruler, frames over the preview too", () => {
  assert.deepEqual(cursorTarget("project_read", { range: { start: 930, end: 1110 } }, project), { kind: "time", frame: 930, end: 1110 });
  assert.deepEqual(cursorTarget("contact_sheet", { range: { start: 10, end: 40 } }, project), { kind: "time", frame: 10, end: 40 });
  assert.deepEqual(cursorTarget("contact_sheet", {}, project), { kind: "time", frame: 0, end: 270 });
  assert.deepEqual(cursorTarget("contact_sheet", { media: "m1" }, project), { kind: "park" });
  assert.deepEqual(cursorTarget("render_frames", { frames: [120] }, project), { kind: "time", frame: 120, preview: true });
  assert.deepEqual(cursorTarget("render_frames", { frames: [90, 30, 60] }, project), { kind: "time", frame: 30, end: 90, preview: true });
  assert.deepEqual(cursorTarget("render_frames", { run: { start: 10, count: 8 } }, project), { kind: "time", frame: 10, end: 17, preview: true });
  assert.deepEqual(cursorTarget("measure", { what: "colour", items: ["c2"] }, project).item, "c2");
  assert.deepEqual(cursorTarget("measure", { what: "sound" }, project), { kind: "park" });
});

test("transcript cuts go to the words; inspector-only tools to the item", () => {
  assert.deepEqual(cursorTarget("transcript_edit", { media: "m1", remove: [{ from: "w12", to: "w20" }, { from: "w31" }] }, project), {
    kind: "words",
    media: "m1",
    from: 12,
    to: 20,
  });
  assert.deepEqual(cursorTarget("transcript_edit", { item: "c2", remove: [{ from: 7 }] }, project), { kind: "words", item: "c2", from: 7, to: 7 });
  assert.deepEqual(cursorTarget("transcript_edit", { fillers: true }, project), { kind: "words" });
  assert.deepEqual(cursorTarget("graphic_element_edit", { item: "t1", edits: [] }, project).item, "t1");
});

test("tools with nothing on screen park at the agent panel; questions stay put", () => {
  for (const tool of ["WebSearch", "WebFetch", "Read", "Bash", "project_read", "docs_read", "generate_media", "brand_read", "media_analyze"])
    assert.deepEqual(cursorTarget(tool, { query: "x", file_path: "/a", media: "m1" }, project), { kind: "park" }, tool);
  for (const tool of ["ask_user", "review_submit", "Task", "Agent"]) assert.deepEqual(cursorTarget(tool, {}, project), { kind: "stay" }, tool);
});

test("a subagent is a child from its Task call to its result, moved by its own calls", () => {
  const trail = cursorTrail();
  cursorCall(
    trail,
    { id: "tu-1", step: 0, tool: "timeline_edit", input: { ops: [{ op: "trim_item", item: "c1", edge: "end", frames: 3 }] }, label: "Trimming" },
    project,
  );
  cursorCall(
    trail,
    { id: "tu-2", step: 1, tool: "Task", input: { description: "Find the best take" }, label: 'Starting a subagent "Find the best take"' },
    project,
  );
  assert.deepEqual(
    trail.stops.map((s) => [s.seq, s.step, s.target.kind]),
    [
      [1, 0, "item"],
      [2, 1, "stay"],
    ],
  );
  assert.deepEqual(cursorView("turn-1", trail, []).children, [{ id: "tu-2", label: "Find the best take" }]);
  cursorChildCall(trail, "tu-2", "render_frames", { frames: [45] }, project);
  assert.deepEqual(cursorView("turn-1", trail, []).children[0]!.target, { kind: "time", frame: 45, preview: true });
  cursorChildCall(trail, "tu-2", "WebSearch", { query: "x" }, project);
  assert.equal(cursorView("turn-1", trail, []).children[0]!.target, undefined, "a call with nothing on screen keeps the child by its agent");
  cursorChildCall(trail, "unknown", "render_frames", { frames: [1] }, project);
  cursorCallEnded(trail, "tu-2");
  assert.deepEqual(cursorView("turn-1", trail, []).children, []);
});

test("a critic round is a child while it runs; parallel children each get one", () => {
  const trail = cursorTrail();
  for (const n of [1, 2, 3]) cursorCall(trail, { id: `t${n}`, step: n, tool: "Agent", input: { description: `Look ${n}` }, label: "x" });
  const critic = (status: string) => ({ kind: "card", card: { critic: { round: 2, status } } });
  const view = cursorView("turn-1", trail, [{ kind: "step" }, critic("running")]);
  assert.deepEqual(
    view.children.map((c) => c.label),
    ["Look 1", "Look 2", "Look 3", "Critic, round 2"],
  );
  assert.equal(cursorView("turn-1", trail, [critic("passed")]).children.length, 3);
});

test("the published trail keeps only the latest stops", () => {
  const trail = cursorTrail();
  for (let i = 0; i < CURSOR_STOPS + 3; i++) cursorCall(trail, { id: `t${i}`, step: i, tool: "project_read", input: {}, label: `Step ${i}` });
  const view = cursorView("turn-1", trail, []);
  assert.equal(view.stops.length, CURSOR_STOPS);
  assert.equal(view.stops.at(-1)!.seq, CURSOR_STOPS + 3);
  assert.equal(view.stops[0]!.label, "Step 3");
});
