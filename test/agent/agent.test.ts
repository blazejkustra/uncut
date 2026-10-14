// Phase 1.3: the agent contract. Tools must be well-formed, the drone trace must
// replay into a valid 60 s cut with no shaky footage, and manual edits must be
// reported to the agent and protected from being overwritten (D6, D7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020Module from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { loadModules, validateProject, projectDuration } from "../../packages/core/src/timeline/validate.ts";
import { applyEdit, createSession, undoTurn, EditConflict, EditError, TurnDependency } from "../../packages/core/src/timeline/apply-ops.ts";
import { manualEditsNote } from "../../packages/core/src/timeline/edit-log.ts";
import type { Op, Problem, Project } from "../../packages/core/src/timeline/types.ts";

// ajv is CommonJS; .default is the class under Node and TypeScript alike (see core validate.ts).
const Ajv2020 = Ajv2020Module.default;

// Tools, traces and example projects are JSON the tests poke at freely.
const read = async (p: string): Promise<any> => JSON.parse(await readFile(new URL(p, import.meta.url), "utf8"));
const modules = await loadModules(
  new URL("../../spec/modules/builtin/", import.meta.url).pathname,
  new URL("../../spec/examples/plugins/", import.meta.url).pathname,
);
const tools = await read("../../spec/agent/tools.json");
const trace = await read("../../spec/agent/traces/drone-shaky.json");
const montage = await read("../../spec/examples/drone-montage.uncut/project.json");
const promo = await read("../../spec/examples/close-the-loop.uncut/project.json");
const editOpsSchema = await read("../../spec/schema/edit-ops.schema.json");
const validate = (p: Project) => validateProject(p, modules);

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(editOpsSchema);
const toolCheck = new Map<string, ValidateFunction>(tools.tools.map((t: any) => [t.name, ajv.compile({ ...t.inputSchema, $defs: tools.$defs })]));
for (const m of modules.values()) for (const t of (m.agentTools as Array<any> | undefined) ?? []) toolCheck.set(t.name, ajv.compile(t.inputSchema));

/** Main-track clips that use footage the trace's analysis marked as shaky. */
function shakyOverlaps(project: Project) {
  const shaky = new Map<string, Array<any>>();
  for (const c of trace.calls.filter((c: any) => c.tool === "media_analyze")) {
    shaky.set(c.input.media, c.output.stability.filter((s: any) => s.value < trace.expect.maxShakyStability));
  }
  const hits: Array<string> = [];
  for (const item of project.tracks.find((t) => t.role === "main")!.items) {
    const from = item.in!;
    const to = item.in! + item.duration;
    for (const s of shaky.get(item.media!)!) if (!(to <= s.start || from >= s.end)) hits.push(`${item.id} ${from}-${to} hits ${s.label}`);
  }
  return hits;
}

test("every tool has a unique name, a description and a compilable input schema", () => {
  const names = tools.tools.map((t: any) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of tools.tools) assert.ok(t.description.length > 20, `${t.name} needs a real description`);
  assert.ok(toolCheck.has("argent_record"), "module tools (Argent) are merged in");
});

test("timeline_edit rejects malformed ops", () => {
  const check = toolCheck.get("timeline_edit")!;
  assert.equal(check({ baseRevision: 0, summary: "x", ops: [{ op: "trim_item", item: "lake", edge: "end", frames: 0 }] }), false, "zero-frame trim");
  assert.equal(check({ baseRevision: 0, summary: "x", ops: [{ op: "explode", item: "lake" }] }), false, "unknown op");
  assert.equal(check({ baseRevision: 0, summary: "x", ops: [] }), false, "empty edit");
  assert.equal(check({ baseRevision: 0, ops: [{ op: "delete_item", item: "lake" }] }), false, "missing summary");
});

test("drone trace: every call is valid for its tool", () => {
  for (const [i, call] of trace.calls.entries()) {
    const check = toolCheck.get(call.tool);
    assert.ok(check, `call ${i}: unknown tool ${call.tool}`);
    assert.ok(check(call.input), `call ${i} (${call.tool}): ${JSON.stringify(check.errors)}`);
  }
});

test("drone trace: the edit replays into a valid 60 s cut with no shaky footage", () => {
  const edit = trace.calls.find((c: any) => c.tool === "timeline_edit").input;
  const session = applyEdit(createSession(montage), { actor: "agent", turnId: "turn-1", ...edit }, validate);
  assert.deepEqual(validate(session.project), []);
  assert.equal(projectDuration(session.project), trace.expect.duration);

  assert.deepEqual(shakyOverlaps(session.project), []);
});

test("drone trace check catches a cut that keeps shaky footage", () => {
  const edit = structuredClone(trace.calls.find((c: any) => c.tool === "timeline_edit").input);
  edit.ops.find((o: any) => o.item === "ridge" && o.edge === "end").frames = 830; // keeps 100 shaky frames
  edit.ops.find((o: any) => o.item === "orbit" && o.edge === "end").frames = 1600;
  const session = applyEdit(createSession(montage), { actor: "agent", ...edit }, validate);
  assert.deepEqual(validate(session.project), [], "the cut is valid, just shaky");
  assert.deepEqual(shakyOverlaps(session.project), ["ridge 120-520 hits strong wind, constant shake"]);
});

test("D6: the agent can't overwrite a newer manual edit, but can edit other things", () => {
  let s = createSession(montage);
  s = applyEdit(s, { actor: "user", ops: [{ op: "trim_item", item: "ridge", edge: "end", frames: 300 }] }, validate);
  assert.equal(s.revision, 1);
  assert.throws(
    () => applyEdit(s, { actor: "agent", baseRevision: 0, ops: [{ op: "trim_item", item: "ridge", edge: "start", frames: 120 }] }, validate),
    EditConflict,
  );
  const ok = applyEdit(s, { actor: "agent", baseRevision: 0, ops: [{ op: "trim_item", item: "orbit", edge: "end", frames: 600 }] }, validate);
  assert.equal(ok.revision, 2);
});

test("D6: the agent gets a note listing the user's manual edits, and only those", () => {
  let s = createSession(promo);
  s = applyEdit(s, { actor: "agent", turnId: "t1", summary: "built the promo", ops: [{ op: "update_item", item: "txt-hook", set: { text: "Claude Code tests your app" } }] }, validate);
  const since = s.revision;
  assert.equal(manualEditsNote(s, since), "", "no note when the user did nothing");
  s = applyEdit(s, { actor: "user", ops: [{ op: "trim_item", item: "sim-login", edge: "end", frames: 90 }] }, validate);
  s = applyEdit(s, { actor: "user", ops: [{ op: "update_item", item: "txt-hook", set: { transform: { x: 72, y: 496 } } }] }, validate);
  s = applyEdit(s, { actor: "user", ops: [{ op: "update_track", track: "a1", set: { mixer: { gainDb: -4 } } }] }, validate);
  const note = manualEditsNote(s, since);
  assert.match(note, /3 edits by hand/);
  assert.match(note, /intentional/);
  assert.match(note, /Trimmed Login flow, iPhone 16 Pro \(sim-login\) by 3\.0s at the end/);
  assert.match(note, /Moved text "Claude Code tests your app" \(txt-hook\) on the canvas to x 72, y 496/);
  assert.match(note, /Set volume of track a1 to −4 dB/);
  assert.doesNotMatch(note, /built the promo/);
});

test("D7: undo a whole agent turn and keep the user's later edits", () => {
  let s = createSession(montage);
  const edit = trace.calls.find((c: any) => c.tool === "timeline_edit").input;
  s = applyEdit(s, { actor: "agent", turnId: "turn-1", ...edit }, validate);
  s = applyEdit(s, { actor: "user", ops: [{ op: "update_item", item: "music", set: { gainDb: -3 } }] }, validate);
  const undone = undoTurn(montage, s, "turn-1");
  assert.equal(projectDuration(undone.project), 5850, "the cut is gone");
  assert.equal(undone.project.tracks[1].items[0].gainDb, -3, "the user's change survived");
});

test("D7: undoing a turn never moves revisions back; kept entries keep theirs", () => {
  let s = createSession(promo);
  s = applyEdit(s, { actor: "agent", turnId: "t1", ops: [{ op: "update_item", item: "txt-hook", set: { text: "one" } }] }, validate);
  s = applyEdit(s, { actor: "agent", turnId: "t1", ops: [{ op: "trim_item", item: "sim-login", edge: "end", frames: 30 }] }, validate);
  s = applyEdit(s, { actor: "user", ops: [{ op: "update_track", track: "a1", set: { mixer: { gainDb: -4 } } }] }, validate);
  const undone = undoTurn(promo, s, "t1", validate);
  assert.equal(undone.revision, s.revision + 1, "one past the session, not renumbered from 0");
  assert.deepEqual(undone.log.map((e) => [e.revision, e.actor]), [[3, "user"]], "the user's entry keeps revision 3");
  assert.equal(JSON.stringify(undone.project.tracks.find((t) => t.id === "a1")), JSON.stringify(s.project.tracks.find((t) => t.id === "a1")));
  // A revision read before the undo can still be checked against the kept log.
  assert.throws(() => applyEdit(undone, { actor: "agent", baseRevision: 2, ops: [{ op: "update_track", track: "a1", set: { hidden: true } }] }), EditConflict);
});

test("D7: a turn a later edit builds on can't be undone, and a turn with nothing in the log says so", () => {
  let s = createSession(promo);
  s = applyEdit(s, { actor: "agent", turnId: "t1", summary: "add a label", ops: [{ op: "insert_item", track: "t1", item: { id: "txt-new", type: "text", start: 760, duration: 60, text: "x" } }] }, validate);
  s = applyEdit(s, { actor: "user", summary: "reword it", ops: [{ op: "update_item", item: "txt-new", set: { text: "y" } }] }, validate);
  assert.throws(
    () => undoTurn(promo, s, "t1", validate),
    (e) => e instanceof TurnDependency && e.entry.summary === "reword it" && /builds on this turn/.test(e.message),
  );
  assert.throws(() => undoTurn(promo, s, "t-unknown", validate), (e) => e instanceof EditError && !(e instanceof TurnDependency) && /no edits in this session/.test(e.message));
});

test("edits are atomic: an invalid edit leaves the project untouched", () => {
  const s = createSession(promo);
  const before = JSON.stringify(s.project);
  assert.throws(
    () => applyEdit(s, { actor: "agent", ops: [
      { op: "update_item", item: "txt-hook", set: { text: "ok" } },
      { op: "update_item", item: "sim-login", set: { in: 300 } },
    ] }, validate),
    (e) => e instanceof EditError && e.details.some((d) => (d as Problem).code === "media-range"),
  );
  assert.equal(JSON.stringify(s.project), before);
  assert.throws(() => applyEdit(s, { actor: "agent", ops: [{ op: "delete_item", item: "ghost" }] }), EditError);
});

test("every op type works and keeps the promo valid", () => {
  let s = createSession(promo);
  const steps: Array<Array<Op>> = [
    [{ op: "insert_item", track: "t1", item: { id: "txt-new", type: "text", start: 760, duration: 60, text: "argent.example.com", style: { preset: "text.mono-label" } } }],
    [{ op: "split_item", item: "sim-login", at: 180, newId: "sim-login-b" }],
    [{ op: "move_item", item: "cmp-tap", start: 430 }],
    [{ op: "delete_item", item: "result-bg" }],
    [{ op: "set_transition", item: "sim-login", transition: null }],
    [{ op: "add_track", track: { id: "v3", kind: "video", name: "Logo" }, index: 1 }],
    [{ op: "update_track", track: "v3", set: { hidden: true } }],
    [{ op: "delete_track", track: "v3" }],
    [{ op: "add_media", media: { id: "m-new", kind: "image", name: "Badge", path: "media/badge.png", probe: { width: 64, height: 64 } } }],
    [{ op: "update_media", media: "m-new", set: { path: "media/badge-2.png", source: { module: "argent.capture", device: "SIM-1" } } }],
    [{ op: "delete_media", media: "m-new" }],
    [{ op: "update_project", set: { name: "Close the loop v2" } }],
    [{ op: "update_item", item: "txt-taps", set: { animation: null } }],
    [{ op: "trim_item", item: "terminal", edge: "start", frames: 30 }],
  ];
  for (const ops of steps) s = applyEdit(s, { actor: "user", ops }, validate);
  assert.deepEqual(validate(s.project), []);
  assert.equal(s.revision, steps.length);
  const main = s.project.tracks.find((t) => t.role === "main")!.items.map((i) => i.id);
  assert.deepEqual(main, ["hook-bg", "terminal", "sim-login", "sim-login-b", "signoff"]);
  const covered = new Set(editOpsSchema.$defs.op.oneOf.map((o: any) => o.properties.op.const));
  assert.deepEqual([...new Set(steps.flat().map((o) => o.op))].sort(), [...covered].sort(), "every op type is exercised");
});

test("the editor context says when the playhead is at the end, after the last frame (D56)", async () => {
  const { playheadLine } = await import("../../apps/server/src/agent/agentTools.ts");
  const p = { format: "uncut/0", name: "P", canvas: { width: 1920, height: 1080, fps: 30 }, media: [], tracks: [{ id: "text", kind: "text", name: "Text", items: [{ id: "t", type: "text", start: 0, duration: 420, text: "Hi" }] }] } as unknown as Project;
  assert.equal(playheadLine(p, 30), "Playhead: frame 30 (1.00 s).");
  assert.equal(playheadLine(p, 420), "Playhead: frame 420 (14.00 s), the end of the project, after its last frame (419); nothing is drawn here.");
  assert.equal(playheadLine({ ...p, tracks: [] }, 0), "Playhead: frame 0 (0.00 s).");
});
