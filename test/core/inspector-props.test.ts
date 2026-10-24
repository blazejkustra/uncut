// Feedback X3/E3 (D129, D131) without the app: the text properties the new Inspector sets (italic,
// case, rotation, opacity) come out of core textHtml (the preview's and the export's one path, so
// the export matches), validate, and read in History; the Inspector's planners (frame alignment,
// case, several items in one edit) make valid edits; the one Background element's linear / radial
// gradients, middle stop and grain, with backgrounds saved before still drawing as they did.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEdit,
  createSession,
  describeOp,
  loadModules,
  solidBackground,
  textHtml,
  validateProject,
  type Item,
  type Op,
  type Project,
} from "../../packages/core/src/index.ts";
import { itemLabel } from "../../apps/web/src/state/project.ts";
import { caseOf, planBackground, planCase, planFrameAlign, planMany, planStyle, planTransform } from "../../apps/web/src/preview/text.ts";

const modules = await loadModules("spec/modules/builtin");
const a: Item = {
  id: "a",
  type: "text",
  start: 0,
  duration: 90,
  text: "Hello there",
  transform: { x: 100, y: 200 },
  style: { preset: "text.title", size: 100, weight: 700 },
};
const b: Item = { id: "b", type: "text", start: 0, duration: 90, text: "Second", transform: { x: 100, y: 600 }, style: { preset: "text.header", size: 60 } };
const bg: Item = { id: "bg", type: "component", component: "component.solid", duration: 90, props: { color: "#0B1D3A" } };
const project: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [a] },
    { id: "text-2", kind: "text", name: "Text 2", items: [b] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [bg] },
  ],
};
const itemIn = (p: Project, id: string) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id)!;
function apply(p: Project, plan: { ops: ReadonlyArray<unknown> } | { problem: string }) {
  assert.ok("ops" in plan, `planned: ${"problem" in plan ? plan.problem : ""}`);
  const next = applyEdit(createSession(p), { actor: "user", ops: plan.ops as ReadonlyArray<Op> }).project;
  assert.deepEqual(validateProject(next, modules), [], "the edit validates");
  return next;
}

test("textHtml draws italic, lower / title case, rotation about the centre and the text's own opacity (times its fade)", () => {
  const html = textHtml({ ...a, style: { ...a.style, italic: true, case: "title" }, transform: { ...a.transform, rotate: -12.5, opacity: 0.5 } }, project, {
    opacity: 0.8,
  });
  assert.match(html, /font-style:italic/);
  assert.match(html, /text-transform:capitalize/);
  assert.match(html, /opacity:0\.4;/, "0.5 own × 0.8 fade");
  assert.match(html, /transform:rotate\(-12\.5deg\)/);
  assert.match(textHtml({ ...a, style: { ...a.style, case: "lower", uppercase: true } }, project), /text-transform:lowercase/, "case wins over uppercase");
  // With a move: translate first, then the rotation, then the zoom (all about the box's centre).
  assert.match(
    textHtml({ ...a, transform: { ...a.transform, rotate: 90 } }, project, { motion: { dy: 54, scale: 1.5 } }),
    /transform:translate\(0cqw,5cqh\) rotate\(90deg\) scale\(1\.5\)/,
  );
  // Nothing set: none of it (projects from before draw byte for byte as they did).
  const plain = textHtml(a, project);
  assert.ok(!/font-style|rotate\(|text-transform/.test(plain), plain);
  assert.match(plain, /opacity:1;/);
});

test("the new fields validate (and wrong ones don't), and read in History", () => {
  const ok = apply(project, {
    ops: [{ op: "update_item", item: "a", set: { style: { ...a.style, italic: true, case: "lower" }, transform: { x: 1, y: 2, rotate: 30, opacity: 0.25 } } }],
  });
  assert.equal(itemIn(ok, "a").style?.italic, true);
  const bad = {
    ...project,
    tracks: [{ ...project.tracks[0]!, items: [{ ...a, style: { ...a.style, case: "upper" } }] }, ...project.tracks.slice(1)],
  } as unknown as Project;
  assert.ok(validateProject(bad, modules).length > 0, "case is lower or title only (upper is uppercase)");
  const words = describeOp({ op: "update_item", item: "a", set: { style: { italic: true, case: "title" } } } as Op, project);
  assert.match(words, /italic/);
  assert.match(words, /title case/);
});

test("planTransform: rotation within ±180 to 0.1°, opacity 0–1 to 0.01; 0° and 100 % leave the transform clean", () => {
  let p = apply(project, planTransform(project, "a", { rotate: 370.04 }));
  assert.equal(itemIn(p, "a").transform?.rotate, 10);
  p = apply(p, planTransform(p, "a", { rotate: -190 }));
  assert.equal(itemIn(p, "a").transform?.rotate, 170);
  p = apply(p, planTransform(p, "a", { opacity: 0.333 }));
  assert.equal(itemIn(p, "a").transform?.opacity, 0.33);
  p = apply(p, planTransform(p, "a", { rotate: 0, opacity: 1 }));
  assert.deepEqual(itemIn(p, "a").transform, { x: 100, y: 200 });
});

test("planFrameAlign puts the measured box against the safe area or centres it", () => {
  const size = { w: 600, h: 120 };
  const at = (edge: Parameters<typeof planFrameAlign>[2]) => itemIn(apply(project, planFrameAlign(project, "a", edge, size)), "a").transform!;
  assert.equal(at("left").x, 72, "the safe margin (1080 / 15)");
  assert.equal(at("right").x, 1920 - 72 - 600);
  assert.equal(at("hcenter").x, 660);
  assert.equal(at("top").y, 72);
  assert.equal(at("bottom").y, 1080 - 72 - 120);
  assert.equal(at("vcenter").y, 480);
  assert.equal(at("vcenter").x, 100, "one axis at a time");
});

test("planCase: capitals, lower, title and back to as typed, against the look's own case", () => {
  let p = apply(project, planCase(project, "a", "upper"));
  assert.equal(caseOf(itemIn(p, "a")), "upper");
  p = apply(p, planCase(p, "a", "title"));
  assert.deepEqual([itemIn(p, "a").style?.case, itemIn(p, "a").style?.uppercase], ["title", undefined]);
  p = apply(p, planCase(p, "a", "none"));
  assert.equal(caseOf(itemIn(p, "a")), "none");
  assert.equal(itemIn(p, "a").style?.case, undefined);
});

test("planMany: several selected texts restyled in one edit; one refusal refuses all", () => {
  const plan = planMany(project, ["a", "b"], (p, id) => planStyle(p, id, { italic: true, color: "#FF000080" }, "Restyle text"));
  assert.ok("ops" in plan);
  assert.equal(plan.ops.length, 2);
  assert.match(plan.summary, /\(2 items\)/);
  const p = apply(project, plan);
  assert.equal(itemIn(p, "b").style?.color, "#FF000080", "an #RRGGBBAA colour (the fill's opacity) is a CSS colour");
  assert.match(textHtml(itemIn(p, "b"), p), /color:#FF000080;/);
  assert.ok("problem" in planMany(project, ["a", "gone"], (q, id) => planStyle(q, id, { italic: true })));
});

test("one Background element: solid, linear (angle), radial, a middle stop and grain; old props draw as before", () => {
  assert.equal(solidBackground(bg, project), "#0B1D3A");
  assert.equal(
    solidBackground({ ...bg, props: { color: "#000", to: "#fff", angle: 90 } }, project),
    "linear-gradient(90deg, #000, #fff)",
    "pre-D131 gradient unchanged",
  );
  assert.equal(solidBackground({ ...bg, props: { color: "#000", via: "#f00", to: "#fff" } }, project), "linear-gradient(180deg, #000, #f00, #fff)");
  assert.equal(solidBackground({ ...bg, props: { color: "#000", to: "#fff", gradient: "radial" } }, project), "radial-gradient(circle at 50% 50%, #000, #fff)");
  const grain = solidBackground({ ...bg, props: { color: "#000", noise: 0.3 } }, project);
  assert.match(grain, /^url\('data:image\/svg\+xml,[^']+'\) 0 0 \/ 240px 240px, #000$/);
  assert.ok(
    decodeURIComponent(grain).includes("feTurbulence") && decodeURIComponent(grain).includes("opacity=%270.3%27".replace(/%27/g, "'")),
    "fractal noise at the amount",
  );
  assert.ok(!grain.includes('"'), "fits in a style attribute");
  // Planner: radial drops the angle, solid drops every gradient field, grain 0 is none.
  let p = apply(project, planBackground(project, "bg", { to: "#3B1E54", angle: 120, via: "#222222" }));
  p = apply(p, planBackground(p, "bg", { gradient: "radial" }));
  assert.deepEqual(itemIn(p, "bg").props, { color: "#0B1D3A", to: "#3B1E54", via: "#222222", gradient: "radial" });
  assert.equal(itemLabel(p, itemIn(p, "bg")), "Radial gradient #0B1D3A → #3B1E54");
  p = apply(p, planBackground(p, "bg", { noise: 0.4 }));
  p = apply(p, planBackground(p, "bg", { to: null, noise: 0 }));
  assert.deepEqual(itemIn(p, "bg").props, { color: "#0B1D3A" });
});
