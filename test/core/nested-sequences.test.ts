// Nested sequences: the format stays open to old projects, ops nest and unnest, flattening plays the
// same frames as the timeline it replaced, and what can't work is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  applyEdit,
  canUnnest,
  createSession,
  EditConflict,
  EditError,
  flattenSequences,
  layout,
  loadModules,
  sequenceLength,
  validateOps,
  validateProject,
  visualsAt,
  type Op,
  type Project,
} from "../../packages/core/src/index.ts";
import { takenIds } from "../../packages/core/src/timeline/arrange/place.ts";

const modules = await loadModules("spec/modules/builtin");
const probe = { frames: 900, fps: 30, width: 1280, height: 720, hasAudio: true };
const base: Project = {
  format: "uncut/0",
  name: "Cut",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [{ id: "m-a", kind: "video", name: "a.mp4", path: "/x/a.mp4", probe }],
  tracks: [
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "c1", type: "clip", media: "m-a", in: 0, duration: 100 },
        { id: "c2", type: "clip", media: "m-a", in: 200, duration: 100, gap: 10 },
        { id: "c3", type: "clip", media: "m-a", in: 400, duration: 100 },
        { id: "c4", type: "clip", media: "m-a", in: 600, duration: 100 },
      ],
    },
    { id: "over", kind: "text", name: "Over", items: [{ id: "t1", type: "text", text: "Hi", start: 150, duration: 30 }] },
  ],
};

const edit = (ops: ReadonlyArray<Op>, project = base) => applyEdit(createSession(project), { actor: "agent", ops }, (p) => validateProject(p, modules)).project;
const nest: Op = { op: "nest_items", items: ["c2", "c3"], sequence: "seq", item: "n1", name: "Middle" };

/** Every frame: which media frame shows on Main. */
function picture(project: Project) {
  const { starts, duration } = layout(project);
  const out: Array<string> = [];
  for (let f = 0; f < duration; f += 7) {
    const seen = visualsAt(project, starts, f).map((v) => `${v.item.type}:${v.item.media ?? v.item.text}:${v.source.toFixed(3)}`);
    out.push(`${f} ${seen.sort().join(",")}`);
  }
  return out;
}

test("old projects: no field added, the same object flattened, every example still valid", () => {
  assert.equal(flattenSequences(base), base);
  for (const dir of readdirSync("spec/examples").filter((d) => d.endsWith(".uncut"))) {
    const project = JSON.parse(readFileSync(`spec/examples/${dir}/project.json`, "utf8")) as Project;
    assert.deepEqual(validateProject(project, modules), [], dir);
    assert.equal(flattenSequences(project), project);
    assert.equal("sequences" in project, false);
  }
});

test("the ops are well-formed", () => {
  assert.deepEqual(validateOps([nest, { op: "unnest_item", item: "n1" }, { op: "delete_sequence", sequence: "seq" }]), []);
  assert.deepEqual(validateOps([{ op: "edit_sequence", sequence: "seq", ops: [{ op: "trim_item", item: "c2", edge: "end", frames: 10 }] }]), []);
  assert.ok(validateOps([{ op: "edit_sequence", sequence: "seq", ops: [{ op: "nope" }] }]).length > 0);
});

test("nesting moves nothing: same length, same picture at every frame, and it saves valid", () => {
  const nested = edit([nest]);
  assert.deepEqual(
    nested.tracks[0]!.items.map((i) => i.id),
    ["c1", "n1", "c4"],
  );
  assert.equal(nested.tracks[0]!.items[1]!.gap, 10);
  assert.equal(nested.tracks[0]!.items[1]!.duration, 200);
  assert.equal(sequenceLength(nested, nested.sequences![0]!), 200);
  assert.equal(layout(nested).duration, layout(base).duration);
  assert.deepEqual(picture(flattenSequences(nested)), picture(base));
  assert.deepEqual(validateProject(flattenSequences(nested), modules), []);
  assert.equal(flattenSequences(nested).sequences, undefined);
});

test("unnesting gives back the timeline", () => {
  const back = edit([{ op: "unnest_item", item: "n1" }], edit([nest]));
  assert.deepEqual(back.tracks[0]!.items, base.tracks[0]!.items);
  assert.equal("sequences" in back, false);
  assert.deepEqual(validateProject(back, modules), []);
});

test("a window of a sequence, reused twice, with an overlay inside it, flattens with its own ids and in step", () => {
  const nested = edit([
    nest,
    {
      op: "edit_sequence",
      sequence: "seq",
      ops: [
        { op: "add_track", track: { id: "inner", kind: "text", name: "Inner" } },
        { op: "insert_item", track: "inner", item: { id: "t2", type: "text", text: "In", start: 120, duration: 20 } },
      ],
    },
    { op: "insert_item", track: "main", item: { id: "n2", type: "sequence", sequence: "seq", in: 100, duration: 50 } },
  ]);
  const flat = flattenSequences(nested);
  assert.deepEqual(validateProject(flat, modules), []);
  const { starts, duration } = layout(flat);
  assert.equal(duration, layout(nested).duration);
  const second = layout(nested).starts.get("n2")!;
  assert.equal(starts.get("n2--c3"), second);
  assert.equal(flat.tracks[0]!.items.find((i) => i.id === "n2--c3")!.in ?? 0, 400);
  const overlay = flat.tracks.find((t) => t.id === "n2--inner")!;
  assert.equal(overlay.items[0]!.start, second + 20);
  assert.equal(flat.tracks.find((t) => t.id === "n1--inner")!.items[0]!.start, layout(nested).starts.get("n1")! + 120);
  assert.equal(canUnnest(nested, nested.tracks[0]!.items[1]!), false);
});

test("a sequence in a sequence plays through both", () => {
  const nested = edit([
    { op: "nest_items", items: ["c2", "c3"], sequence: "inner-s", item: "n1" },
    { op: "nest_items", items: ["n1", "c4"], sequence: "outer-s", item: "n2" },
  ]);
  assert.deepEqual(picture(flattenSequences(nested)), picture(base));
});

test("edit_sequence changes every use; shortening past a use is refused until it is trimmed in the same edit", () => {
  const nested = edit([nest]);
  const trim: Op = { op: "edit_sequence", sequence: "seq", ops: [{ op: "trim_item", item: "c3", edge: "end", frames: 50 }] };
  assert.throws(
    () => edit([trim], nested),
    (e: EditError) => JSON.stringify(e.details).includes("sequence-range"),
  );
  const both = edit([trim, { op: "trim_item", item: "n1", edge: "end", frames: 50 }], nested);
  assert.equal(flattenSequences(both).tracks[0]!.items.find((i) => i.id === "n1--c3")!.duration, 50);
});

test("what can't work is refused", () => {
  const nested = edit([nest]);
  const refused = (ops: ReadonlyArray<Op>, words: RegExp, project = nested) =>
    assert.throws(
      () => edit(ops, project),
      (e: EditError) => words.test(`${e.message} ${JSON.stringify(e.details)}`),
      JSON.stringify(ops),
    );
  refused([{ op: "nest_items", items: ["c1", "c3"], sequence: "x", item: "y" }], /neighbouring/, base);
  refused([{ op: "insert_item", track: "main", item: { id: "n2", type: "sequence", sequence: "nope", duration: 10 } }], /unknown-sequence/);
  refused([{ op: "insert_item", track: "main", item: { id: "n2", type: "sequence", sequence: "seq", in: 150, duration: 100 } }], /sequence-range/);
  refused([{ op: "update_item", item: "n1", set: { transform: { x: 1 } } }], /sequence-field/);
  refused([{ op: "set_transition", item: "n1", transition: { module: "transition.crossfade", duration: 10 } }], /sequence-transition/);
  refused(
    [
      {
        op: "edit_sequence",
        sequence: "seq",
        ops: [{ op: "insert_item", track: "seq-main", item: { id: "n9", type: "sequence", sequence: "seq", duration: 10 } }],
      },
    ],
    /sequence-cycle/,
  );
  refused([{ op: "edit_sequence", sequence: "seq", ops: [{ op: "delete_media", media: "m-a" }] }], /can't run inside/);
  refused(
    [
      { op: "delete_media", media: "m-a" },
      { op: "delete_item", item: "c1" },
      { op: "delete_item", item: "c4" },
    ],
    /still used by/,
  );
  refused([{ op: "delete_sequence", sequence: "seq" }], /still used by/);
  refused([{ op: "insert_item", track: "over", item: { id: "n2", type: "sequence", sequence: "seq", start: 900, duration: 10 } }], /item-track-kind/);
  const locked = edit([{ op: "update_item", item: "n1", set: { locked: true } }], nested);
  refused([{ op: "edit_sequence", sequence: "seq", ops: [{ op: "trim_item", item: "c3", edge: "end", frames: 5 }] }], /locked/, locked);
});

test("a locked section sees through a sequence item", () => {
  const nested = { ...edit([nest]), sections: [{ id: "s1", start: 120, end: 200, state: "locked" as const }] };
  const change: Op = { op: "edit_sequence", sequence: "seq", ops: [{ op: "update_item", item: "c2", set: { in: 300 } }] };
  assert.throws(() => edit([change], nested), /locked section/);
});

test("trimming a sequence item from the start plays on from where it was", () => {
  const nested = edit([{ op: "trim_item", item: "n1", edge: "start", frames: 30 }], edit([nest]));
  assert.equal(nested.tracks[0]!.items[1]!.in, 30);
  assert.equal(flattenSequences(nested).tracks[0]!.items.find((i) => i.id === "n1--c2")!.in, 230);
});

const lockCode = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof EditError);
    return (error.details[0] as { code?: string } | undefined)?.code;
  }
  return "no refusal";
};
const inSequence: Op = { op: "edit_sequence", sequence: "seq", ops: [{ op: "trim_item", item: "c2", edge: "end", frames: 5 }] };
const nested = edit([nest]);
const withLock = (project: Project, set: (main: Project["tracks"][number]) => Project["tracks"][number]) => ({
  ...project,
  tracks: project.tracks.map((t) => (t.role === "main" ? set(t) : t)),
});
const lockItem = (project: Project, id: string) => withLock(project, (t) => ({ ...t, items: t.items.map((i) => (i.id === id ? { ...i, locked: true } : i)) }));

test("edit_sequence is refused with the locked code when the item playing it or its track is locked", () => {
  assert.equal(
    lockCode(() => edit([inSequence], lockItem(nested, "n1"))),
    "locked",
  );
  assert.equal(
    lockCode(() =>
      edit(
        [inSequence],
        withLock(nested, (t) => ({ ...t, locked: true })),
      ),
    ),
    "locked",
  );
  assert.doesNotThrow(() => edit([inSequence, { op: "trim_item", item: "n1", edge: "end", frames: 5 }], nested));
  assert.throws(() => applyEdit(createSession(lockItem(nested, "n1")), { actor: "user", ops: [inSequence] }), EditError);
});

test("a locked sequence item keeps what it plays: a relink of a file inside it is refused", () => {
  const relink: Op = { op: "update_media", media: "m-a", set: { path: "/x/other.mp4" } };
  assert.equal(
    lockCode(() => edit([relink], lockItem(nested, "n1"))),
    "locked",
  );
  assert.doesNotThrow(() => edit([relink], nested));
});

test("a locked sequence item keeps what it plays through a sequence nested in it", () => {
  const [seq] = nested.sequences!;
  const [c2, c3] = seq!.tracks[0]!.items;
  const two: Project = {
    ...nested,
    sequences: [
      { ...seq!, tracks: [{ ...seq!.tracks[0]!, items: [c2!, { id: "n2", type: "sequence", sequence: "deep", duration: c3!.duration }] }] },
      { id: "deep", name: "Deep", tracks: [{ id: "deep-main", kind: "video", role: "main", name: "Main", items: [{ ...c3!, gap: undefined }] }] },
    ],
  };
  const deep: Op = { op: "edit_sequence", sequence: "deep", ops: [{ op: "trim_item", item: "c3", edge: "end", frames: 5 }] };
  assert.equal(
    lockCode(() => edit([deep], lockItem(two, "n1"))),
    "locked",
  );
});

test("edit_sequence takes slip_item and roll_edit", () => {
  const slipped = edit([{ op: "edit_sequence", sequence: "seq", ops: [{ op: "slip_item", item: "c3", frames: 10 }] }], nested);
  assert.equal(slipped.sequences![0]!.tracks[0]!.items.find((i) => i.id === "c3")!.in, 410);
  const rolled = edit([{ op: "edit_sequence", sequence: "seq", ops: [{ op: "roll_edit", item: "c2", frames: 5 }] }], nested);
  assert.deepEqual(
    rolled.sequences![0]!.tracks[0]!.items.map((i) => i.duration),
    [105, 95],
  );
});

test("nest_items conflicts with a newer edit of Main by its real track id", () => {
  const session = createSession({ ...base, tracks: base.tracks.map((t) => (t.role === "main" ? { ...t, id: "spine" } : t)) });
  const after = applyEdit(session, { actor: "user", ops: [{ op: "update_track", track: "spine", set: { name: "Spine" } }] });
  assert.throws(
    () => applyEdit(after, { actor: "agent", baseRevision: 0, ops: [nest] }),
    (error: Error) => error instanceof EditConflict && [...error.by.keys()].includes("track:spine"),
  );
});

test("the id helpers see into sequences", () => {
  const ids = takenIds(nested);
  for (const id of ["seq", "seq-main", "c2", "c3", "n1"]) assert.ok(ids.has(id), id);
});
