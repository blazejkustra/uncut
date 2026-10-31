// D316: a graphic's elements as data. From a scan to the listed elements (wrappers and followers
// left out, declared ones first), the file's own frames and the item's through in and skips, the
// edit plan (one update_item, an edit that goes back to the file drops out), and the format.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyEdit,
  createSession,
  elementBlocks,
  elementSpan,
  planElementMove,
  elementsInfo,
  graphicElementsFrom,
  graphicInfo,
  graphicTime,
  itemFrameOf,
  joinScans,
  loadModules,
  planElementEdit,
  planElementEdits,
  scanTimes,
  validateProject,
  type Project,
  type ScannedElement,
} from "../../packages/core/src/index.ts";

const modules = await loadModules(new URL("../../spec/modules/builtin/", import.meta.url).pathname);

const fps = 30;
const seconds = 20;
const duration = seconds * fps;
const ts = scanTimes(seconds, 6000);
const sample = (t: number) => Math.round((t * ts.length) / seconds);
const el = (key: string, from: number, to: number, extra: Partial<ScannedElement> = {}): ScannedElement => ({
  key,
  tag: "div",
  text: "",
  area: 1000,
  runs: [[sample(from), sample(to)]],
  ...extra,
});

test("a wrapper on screen throughout is left out, its children are the elements", () => {
  const found = graphicElementsFrom(
    [el("panel", 0, 19.9), el("title", 1, 4, { parent: "panel", text: "Hello there" }), el("card", 5, 9, { parent: "panel" })],
    ts,
    fps,
    duration,
  );
  assert.deepEqual(
    found.elements.map((e) => e.key),
    ["title", "card"],
  );
  assert.equal(found.elements[0]!.name, "Hello there");
  assert.equal(found.elements[0]!.kind, "text");
  assert.equal(found.elements[0]!.parent, undefined);
  assert.equal(found.reason, undefined);
});

test("a child that comes and goes with its parent isn't listed; one with its own time is", () => {
  const found = graphicElementsFrom(
    [el("card", 2, 9), el("label", 2, 9, { parent: "card", text: "same" }), el("badge", 4, 9, { parent: "card" }), el("other", 10, 12)],
    ts,
    fps,
    duration,
  );
  assert.deepEqual(
    found.elements.map((e) => e.key),
    ["card", "badge", "other"],
  );
  assert.equal(found.elements[1]!.parent, "card");
});

test("the span covers the moments around what the samples saw, and the graphic's ends are kept", () => {
  const found = graphicElementsFrom([el("a", 0, 3), el("b", 5, 19.95)], ts, fps, duration);
  const [a, b] = found.elements;
  assert.equal(a!.from[0], 0);
  assert.ok(a!.from[1] >= 3 * fps && a!.from[1] <= 3 * fps + 4, String(a!.from));
  assert.ok(b!.from[0] <= 5 * fps && b!.from[0] >= 5 * fps - 4, String(b!.from));
  assert.equal(b!.from[1], duration);
});

test("declared elements are all there is once a file declares any, with the times it says", () => {
  const found = graphicElementsFrom(
    [el("title", 1, 4, { at: 1.5, out: 3.5, name: "Title" }), el("card", 5, 9, { at: 5 }), el("extra", 10, 12)],
    ts,
    fps,
    duration,
  );
  assert.deepEqual(
    found.elements.map((e) => [e.key, e.name, e.from, e.timing]),
    [
      ["title", "Title", [45, 105], "declared"],
      ["card", "card", [150, duration], "declared"],
    ],
  );
});

test("a graphic drawn on one canvas stays one block and says why", () => {
  const found = graphicElementsFrom([el("c", 0, 19.9, { tag: "canvas" })], ts, fps, duration);
  assert.equal(found.elements.length, 0);
  assert.match(found.reason!, /one canvas/);
  const blank = graphicElementsFrom([], ts, fps, duration);
  assert.match(blank.reason!, /no elements/);
});

test("scan chunks join: a run across two chunks is one run", () => {
  const joined = joinScans(
    [
      [{ ...el("a", 0, 0), runs: [[3, 4]], text: "ab" }],
      [
        { ...el("a", 0, 0), runs: [[0, 2]], text: "abc" },
        { ...el("b", 0, 0), runs: [[1, 1]] },
      ],
    ],
    [0, 5],
  );
  assert.deepEqual(joined.find((e) => e.key === "a")!.runs, [[3, 7]]);
  assert.equal(joined.find((e) => e.key === "a")!.text, "abc");
  assert.deepEqual(joined.find((e) => e.key === "b")!.runs, [[6, 6]]);
});

test("itemFrameOf undoes graphicTime through in and skips, and lands after a skip inside one", () => {
  const item = {
    in: 30,
    skips: [
      { at: 60, frames: 40 },
      { at: 90, frames: 10 },
    ],
    duration: 200,
  };
  for (const local of [0, 10, 59, 60, 61, 89, 90, 150]) assert.equal(itemFrameOf(item, graphicTime(item, local)), local);
  assert.equal(itemFrameOf(item, 30 + 70), 60);
  assert.equal(itemFrameOf({}, 12), 12);
});

const element = { key: "title", from: [30, 120] as const, text: "Hello" };

test("a change plans one update_item; going back to the file drops the edit, the last one the field", () => {
  const moved = planElementEdit({ id: "g" }, element, { in: 60, out: 150 });
  assert.deepEqual(moved, { op: "update_item", item: "g", set: { elements: { title: { from: [30, 120], in: 60, out: 150 } } } });
  const elements = (moved as { set: { elements: Record<string, object> } }).set.elements;
  const back = planElementEdit({ id: "g", elements: elements as never }, element, { in: 30, out: 120 });
  assert.deepEqual(back, { op: "update_item", item: "g", set: { elements: null } });
  const cleared = planElementEdit({ id: "g", elements: { title: { color: "#fff" } } }, element, { color: null });
  assert.deepEqual(cleared, { op: "update_item", item: "g", set: { elements: null } });
});

test("one end alone keeps the other where it is now; a span never goes under a frame", () => {
  const first = planElementEdit({ id: "g" }, element, { out: 90 }) as unknown as { set: { elements: { title: { in: number; out: number } } } };
  assert.deepEqual([first.set.elements.title.in, first.set.elements.title.out], [30, 90]);
  const tiny = planElementEdit({ id: "g" }, element, { in: 100, out: 40 }) as unknown as { set: { elements: { title: { in: number; out: number } } } };
  assert.deepEqual([tiny.set.elements.title.in, tiny.set.elements.title.out], [100, 101]);
});

test("a new text remembers the file's length; the file's own text is no edit", () => {
  const typed = planElementEdit({ id: "g" }, element, { text: "Bonjour" }) as unknown as { set: { elements: { title: object } } };
  assert.deepEqual(typed.set.elements.title, { text: "Bonjour", sourceLength: 5 });
  assert.deepEqual(planElementEdit({ id: "g" }, element, { text: "Hello" }), { op: "update_item", item: "g", set: { elements: null } });
});

test("several elements are one op, and the span reads from the edit", () => {
  const op = planElementEdits({ id: "g" }, [
    { element, change: { hidden: true } },
    { element: { key: "card", from: [0, 10] }, change: { x: 12 } },
  ]) as unknown as { set: { elements: Record<string, object> } };
  assert.deepEqual(Object.keys(op.set.elements).sort(), ["card", "title"]);
  assert.deepEqual(elementSpan(element, { from: [30, 120], in: 1, out: 2 }), [1, 2]);
  assert.deepEqual(elementSpan(element, { hidden: true }), [30, 120]);
});

test("render's info carries the edits in key order, and nothing at all without them", () => {
  const canvas = { width: 100, height: 100, fps: 30 };
  assert.equal("elements" in graphicInfo({ duration: 10 }, canvas, 0), false);
  assert.equal(elementsInfo({ elements: {} }), undefined);
  const info = graphicInfo({ duration: 10, elements: { b: { hidden: true }, a: { x: 1 } } }, canvas, 0);
  assert.deepEqual(info.elements, [
    { key: "a", x: 1 },
    { key: "b", hidden: true },
  ]);
});

const project = (): Project =>
  ({
    format: "uncut/0",
    name: "t",
    canvas: { width: 100, height: 100, fps: 30 },
    media: [],
    tracks: [
      { id: "main", name: "Main", kind: "video", role: "main", items: [] },
      { id: "v", name: "V", kind: "video", items: [{ id: "g", type: "graphic", src: "graphics/a.html", start: 0, duration: 300 }] },
    ],
  }) as unknown as Project;

test("an element edit goes through the format and undoes as one revision; split keeps it on both halves", () => {
  const session = createSession(project());
  const edited = applyEdit(session, { actor: "user", ops: [planElementEdit({ id: "g" }, element, { in: 60, out: 150 })] });
  const item = () => edited.project.tracks[1]!.items[0]!;
  assert.deepEqual(item().elements, { title: { from: [30, 120], in: 60, out: 150 } });
  const split = applyEdit(createSession(edited.project), { actor: "user", ops: [{ op: "split_item", item: "g", at: 100, newId: "g2" }] });
  assert.deepEqual(
    split.project.tracks[1]!.items.map((i) => i.elements),
    [item().elements, item().elements],
  );
});

test("the format refuses a span without its source, and bad values", () => {
  const problems = (elements: unknown) => {
    const session = createSession(project());
    return validateProject(applyEdit(session, { actor: "user", ops: [{ op: "update_item", item: "g", set: { elements } as never }] }).project, modules);
  };
  assert.deepEqual(problems({ title: { from: [1, 2], in: 3, out: 9, hidden: true, x: 4, scale: 2, color: "#ffffff" } }), []);
  assert.ok(problems({ title: { in: 3, out: 9 } }).length);
  assert.ok(problems({ title: { opacity: 2 } }).length);
  assert.ok(problems({ title: { color: "red;}body{display:none" } }).length);
});

test("blocks pack in rows, clip to the item, follow edits and leave deleted elements out", () => {
  const list = [
    { key: "a", name: "a", kind: "box" as const, from: [0, 50] as const, timing: "measured" as const },
    { key: "b", name: "b", kind: "box" as const, from: [10, 30] as const, timing: "measured" as const },
    { key: "c", name: "c", kind: "box" as const, from: [50, 400] as const, timing: "measured" as const },
    { key: "d", name: "d", kind: "box" as const, from: [20, 40] as const, timing: "measured" as const },
  ];
  const item = { id: "g", type: "graphic" as const, duration: 100, elements: { d: { hidden: true } } };
  assert.deepEqual(
    elementBlocks(item, list).map((b) => [b.element.key, b.from, b.to, b.row]),
    [
      ["a", 0, 50, 0],
      ["b", 10, 30, 1],
      ["c", 50, 100, 0],
    ],
  );
  const moved = { ...item, elements: { b: { from: [10, 30], in: 60, out: 80 } } };
  assert.deepEqual(elementBlocks(moved, list).find((b) => b.element.key === "b")!.from, 60);
  assert.deepEqual(
    elementBlocks({ ...item, in: 200 }, list).map((b) => b.element.key),
    ["c"],
  );
});

test("a moved element takes the elements inside it along, in one edit", () => {
  const panel = { key: "panel", from: [30, 90] as const };
  const list = [
    panel,
    { key: "line", from: [40, 60] as const, parent: "panel" },
    { key: "word", from: [45, 50] as const, parent: "line" },
    { key: "other", from: [30, 90] as const },
  ];
  const op = planElementMove({ id: "g" }, list, panel, { in: 60, out: 120 }) as unknown as { set: { elements: Record<string, { in: number; out: number }> } };
  assert.deepEqual(Object.keys(op.set.elements).sort(), ["line", "panel", "word"]);
  assert.deepEqual([op.set.elements.line!.in, op.set.elements.line!.out], [70, 90]);
  assert.deepEqual([op.set.elements.word!.in, op.set.elements.word!.out], [75, 80]);
});
