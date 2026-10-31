// D316: the agent's view of a graphic's elements: timeline frames through the item's start, in and
// skips, and its edits as the one update_item the timeline makes too.
import { test } from "node:test";
import assert from "node:assert/strict";

import { elementEditOp, elementRows, graphicItem } from "../../apps/server/src/agent/tools/graphicElements.ts";
import type { GraphicElements, Item, Op, Project } from "../../packages/core/src/index.ts";

const item: Item = { id: "g", type: "graphic", src: "graphics/a.html", start: 100, duration: 200, in: 30, skips: [{ at: 50, frames: 20 }] };
const found: GraphicElements = {
  elements: [
    { key: "title", name: "Title", kind: "text", from: [40, 60], text: "Hello", timing: "measured" },
    { key: "late", name: "late", kind: "box", from: [120, 150], timing: "declared" },
  ],
};
const project = {
  canvas: { width: 100, height: 100, fps: 30 },
  media: [],
  tracks: [{ id: "v", name: "V", kind: "video", items: [item, { id: "c", type: "text", start: 0, duration: 10 }] }],
} as unknown as Project;

test("a graphic item is found with its start; anything else says so", () => {
  assert.deepEqual(graphicItem(project, "g"), { item, start: 100 });
  assert.match((graphicItem(project, "c") as { problem: string }).problem, /no graphic item "c"/);
});

test("rows are timeline frames: start, in and skips taken into account", () => {
  const rows = elementRows(found, item, 100);
  assert.deepEqual(
    rows.map((r) => [r.element, r.start, r.end]),
    [
      ["title", 110, 130],
      ["late", 170, 200],
    ],
  );
});

test("an edit in timeline frames lands on the graphic's own frames, one op for all", () => {
  const planned = elementEditOp(found, item, 100, [
    { element: "late", start: 180, end: 210 },
    { element: "title", hidden: true },
  ]) as { op: Op };
  assert.deepEqual(planned.op, {
    op: "update_item",
    item: "g",
    set: { elements: { late: { from: [120, 150], in: 130, out: 160 }, title: { hidden: true } } },
  });
  const after = { ...item, elements: { late: { from: [120, 150], in: 130, out: 160 } } };
  assert.deepEqual(
    elementRows(found, after, 100).map((r) => [r.element, r.start, r.end]),
    [
      ["title", 110, 130],
      ["late", 180, 210],
    ],
  );
});

test("an element that isn't there is refused by name", () => {
  assert.match((elementEditOp(found, item, 100, [{ element: "nope", hidden: true }]) as { problem: string }).problem, /no element "nope"/);
});
