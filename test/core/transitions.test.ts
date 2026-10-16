// Transitions UI chunk (D73) and iris / push / zoom (D79), without the app: the drawn transitions'
// maths in core (crossfade, dip to black, wipe, iris, push, zoom), their sound, the handle rules, how long one can be at a cut, the planner's
// edits and labels, and what trims, splits, deletes and moves do to them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyEdit, audibleAt, canvasBox, clipBox, componentBox, componentHtml, createSession, defaultFrames, irisRadius, layout, loadModules, moveBox, spanOf, timelineProblems, transitionAt, TRANSITION_LIMITS, TRANSITIONS, transitionLimits, validateProject, visualsAt, ZOOM_SCALE, type Project } from "../../packages/core/src/index.ts";
import { modulesList, SYSTEM_PROMPT } from "../../apps/server/src/agent/agentTools.ts";
import { validateOps } from "../../packages/core/src/index.ts";
import { mainCuts, nearestCut, planDelete, planMove, planSetTransition, planSplit, planTrim } from "../../apps/web/src/timeline/edit.ts";
import { AGENT_TEXT } from "../helpers/agentText.ts";

const modules = await loadModules("spec/modules/builtin");
const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} ${a} vs ${b}`);

/** Two video clips on main (a: frames 0–60 of m, b: 40–100 of m, so each has handles), a title above. */
function twoClips(transition?: { module: string; duration: number }, extra: Partial<Project["tracks"][number]["items"][number]> = {}): Project {
  return {
    format: "uncut/0",
    name: "T",
    canvas: { width: 1920, height: 1080, fps: 30 },
    media: [{ id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 300, fps: 30, width: 1920, height: 1080, hasAudio: true } }],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [{ id: "title", type: "text", start: 0, duration: 120, text: "Hi" }] },
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "a", type: "clip", media: "m", in: 0, duration: 60 },
          { id: "b", type: "clip", media: "m", in: 40, duration: 60, ...(transition ? { transitionIn: transition } : {}), ...extra },
        ],
      },
    ],
  };
}
const at = (p: Project, f: number) => visualsAt(p, layout(p).starts, f);
const ids = (p: Project, f: number) => at(p, f).map((v) => v.item.id);
const of = (p: Project, f: number, id: string) => at(p, f).find((v) => v.item.id === id);

test("the drawn transitions match their manifests; dip to black is a built-in module", () => {
  for (const t of TRANSITIONS) {
    const m = modules.get(t.id);
    assert.ok(m, `${t.id} has a manifest`);
    assert.equal(m.kind, "transition");
    assert.equal(m.name, t.name);
    assert.deepEqual(m.transition, { minFrames: t.minFrames, maxFrames: t.maxFrames }, t.id);
    assert.equal((m.ui as { panel?: string } | undefined)?.panel, "transitions");
    const d = defaultFrames(t, 30);
    assert.ok(d >= t.minFrames && d <= t.maxFrames);
  }
  // The first six (D73, D79) keep their order; D133's follow (test/core/transitions-more.test.ts).
  assert.deepEqual(TRANSITIONS.slice(0, 6).map((t) => t.id), ["transition.crossfade", "transition.dip-to-black", "transition.wipe", "transition.iris", "transition.push-left", "transition.zoom"]);
  assert.deepEqual(TRANSITIONS.slice(0, 6).map((t) => defaultFrames(t, 30)), [15, 24, 15, 15, 15, 15]);
  // Every built-in transition's limits (drawn or not) are known to the renderer, as the manifests say.
  const builtins = [...modules.values()].filter((m) => m.kind === "transition" && m.builtin);
  assert.deepEqual(Object.keys(TRANSITION_LIMITS).sort(), builtins.filter((m) => m.transition).map((m) => m.id).sort());
  for (const m of builtins) if (m.transition) assert.deepEqual(TRANSITION_LIMITS[m.id], { minFrames: m.transition.minFrames, maxFrames: m.transition.maxFrames }, m.id);
  assert.equal(defaultFrames(TRANSITIONS[0]!, 30), 15);
  assert.equal(defaultFrames(TRANSITIONS[1]!, 30), 24);
  // The agent's docs list them.
  const schema = readFileSync("spec/schema/edit-ops.schema.json", "utf8");
  for (const t of TRANSITIONS) assert.match(schema, new RegExp(`${t.id.replace(".", "\\.")} \\(${t.minFrames}–${t.maxFrames} frames`));
});

test("crossfade: the incoming clip starts half early and fades in linearly over the outgoing one", () => {
  const p = twoClips({ module: "transition.crossfade", duration: 20 });
  assert.deepEqual(validateProject(p, modules), []);
  assert.deepEqual(ids(p, 49), ["a", "title"]);
  // From 50 (cut 60 − 10) to 70: b over a, opacity 0 → 1.
  assert.deepEqual(ids(p, 50), ["a", "b", "title"]);
  close(of(p, 55, "b")!.opacity, 0.25);
  close(of(p, 60, "b")!.opacity, 0.5);
  close(of(p, 60, "a")!.opacity, 1);
  assert.equal(of(p, 60, "b")!.wipe, undefined);
  assert.deepEqual(ids(p, 70), ["b", "title"]);
});

test("dip to black: no overlap, a black layer over main fades in to the cut and out after it", () => {
  const p = twoClips({ module: "transition.dip-to-black", duration: 20 });
  assert.deepEqual(validateProject(p, modules), []);
  assert.deepEqual(ids(p, 49), ["a", "title"]);
  // a ends at the cut, b starts on it; the black layer sits above main, under the text track.
  assert.deepEqual(ids(p, 50), ["a", "dip:b", "title"]);
  assert.deepEqual(ids(p, 59), ["a", "dip:b", "title"]);
  assert.deepEqual(ids(p, 60), ["b", "dip:b", "title"]);
  assert.deepEqual(ids(p, 70), ["b", "title"]);
  const black = (f: number) => of(p, f, "dip:b")!.opacity;
  close(black(50), 0);
  close(black(55), 0.5);
  close(black(60), 1, "the cut frame is black");
  close(black(65), 0.5);
  close(black(69), 0.1);
  // The clips themselves stay opaque, and their source times are their own.
  close(of(p, 59, "a")!.opacity, 1);
  close(of(p, 60, "b")!.opacity, 1);
  close(of(p, 60, "b")!.source, 40 / 30);
  const dip = of(p, 60, "dip:b")!;
  assert.equal(dip.item.component, "component.solid");
  assert.deepEqual(dip.item.props, { color: "#000000" });
  // An odd length: half frames, still symmetric.
  const odd = twoClips({ module: "transition.dip-to-black", duration: 9 });
  close(of(odd, 60, "dip:b")!.opacity, 1);
  close(of(odd, 56, "dip:b")!.opacity, 0.5 / 4.5);
  assert.equal(of(odd, 55, "dip:b"), undefined);
  // On a hidden main track the dip goes with it.
  const hidden = { ...p, tracks: p.tracks.map((t) => (t.id === "main" ? { ...t, hidden: true } : t)) };
  assert.deepEqual(ids(hidden, 60), ["title"]);
});

test("dip to black skips the clips' own animations at the cut, as a crossfade does", () => {
  const fade = { module: "move.fade", duration: 10 };
  const base = twoClips({ module: "transition.dip-to-black", duration: 20 }, { animation: { in: fade } });
  const p = { ...base, tracks: base.tracks.map((t) => (t.id === "main" ? { ...t, items: [{ ...t.items[0]!, animation: { out: fade } }, t.items[1]!] } : t)) };
  close(of(p, 59, "a")!.opacity, 1, "a's fade-out is skipped");
  close(of(p, 60, "b")!.opacity, 1, "b's fade-in is skipped");
});

test("wipe: the incoming clip is revealed from the left, linearly, fully opaque", () => {
  const p = twoClips({ module: "transition.wipe", duration: 20 });
  assert.deepEqual(validateProject(p, modules), []);
  assert.deepEqual(ids(p, 50), ["a", "b", "title"]);
  close(of(p, 50, "b")!.wipe!, 0);
  close(of(p, 55, "b")!.wipe!, 0.25);
  close(of(p, 60, "b")!.wipe!, 0.5);
  close(of(p, 60, "b")!.opacity, 1);
  assert.equal(of(p, 70, "b")!.wipe, undefined, "whole once it's done");
  assert.equal(of(p, 60, "a")!.wipe, undefined);
});

test("iris (D79): the incoming clip, opaque, shows in a circle growing from the canvas's centre to its corners, linearly", () => {
  const p = twoClips({ module: "transition.iris", duration: 20 });
  assert.deepEqual(validateProject(p, modules), []);
  assert.deepEqual(ids(p, 49), ["a", "title"]);
  assert.deepEqual(ids(p, 50), ["a", "b", "title"]);
  close(of(p, 50, "b")!.iris!, 0);
  close(of(p, 55, "b")!.iris!, 0.25);
  close(of(p, 60, "b")!.iris!, 0.5);
  close(of(p, 60, "b")!.opacity, 1, "not faded");
  assert.equal(of(p, 60, "b")!.wipe, undefined);
  assert.equal(of(p, 70, "b")!.iris, undefined, "whole once it's done");
  // The outgoing clip is untouched: no reveal, no move, box unchanged.
  const a = of(p, 60, "a")!;
  assert.equal(a.iris, undefined);
  assert.equal(a.shift, undefined);
  assert.equal(a.zoom, undefined);
  assert.deepEqual(a.box, clipBox({}, p.canvas, p.media[0]!.probe, 60));
  // Radius: half the diagonal at 1 (1101.45 px at 1920×1080), so mid-way the centre is in and the corners out.
  close(irisRadius(1, p.canvas), Math.hypot(960, 540));
  close(irisRadius(0.5, p.canvas), Math.hypot(960, 540) / 2);
  assert.ok(irisRadius(0.5, p.canvas) > 0 && irisRadius(0.5, p.canvas) < Math.hypot(960, 540));
  // An odd length: half frames.
  const odd = twoClips({ module: "transition.iris", duration: 9 });
  close(of(odd, 56, "b")!.iris!, 0.5 / 9);
  assert.equal(of(odd, 55, "b"), undefined);
});

test("push-left (D79): both clips slide left by the share of the canvas width, side by side, opaque", () => {
  const p = twoClips({ module: "transition.push-left", duration: 20 });
  assert.deepEqual(validateProject(p, modules), []);
  assert.deepEqual(ids(p, 50), ["a", "b", "title"]);
  for (const [f, share] of [[50, 0], [55, 0.25], [60, 0.5], [65, 0.75], [69, 0.95]] as const) {
    const a = of(p, f, "a")!;
    const b = of(p, f, "b")!;
    close(a.opacity, 1);
    close(b.opacity, 1);
    if (share === 0) assert.equal(a.shift, undefined, "the outgoing clip hasn't moved yet");
    else close(a.shift!, -share * 1920, `a at ${f}`);
    close(b.shift!, (1 - share) * 1920, `b at ${f}`);
    // The boxes carry it (the preview and export draw the box): b's left edge meets a's right edge.
    close(b.box!.x, (1 - share) * 1920);
    close(a.box!.x + a.box!.w, b.box!.x);
    close(b.box!.content.x, b.box!.x, "the picture moves with its box");
  }
  assert.equal(of(p, 70, "b")!.shift, undefined, "in place once it's done");
  assert.equal(of(p, 70, "a"), undefined);
  assert.equal(of(p, 49, "a")!.shift, undefined);
  // The title above isn't on the main track: not moved.
  assert.equal(of(p, 60, "title")!.shift, undefined);
});

test("zoom (D79): the outgoing picture grows 1 → ZOOM_SCALE about its box's centre while the incoming one fades in over it", () => {
  const p = twoClips({ module: "transition.zoom", duration: 20 });
  assert.deepEqual(validateProject(p, modules), []);
  assert.equal(ZOOM_SCALE, 1.2);
  close(of(p, 60, "b")!.opacity, 0.5, "b fades in like a crossfade");
  close(of(p, 55, "b")!.opacity, 0.25);
  assert.equal(of(p, 60, "b")!.zoom, undefined, "b isn't zoomed");
  assert.equal(of(p, 50, "a")!.zoom, undefined, "a starts at 1");
  close(of(p, 55, "a")!.zoom!, 1.05);
  close(of(p, 60, "a")!.zoom!, 1.1);
  close(of(p, 69, "a")!.zoom!, 1 + 0.2 * 0.95);
  close(of(p, 60, "a")!.opacity, 1, "a stays opaque under b");
  // Its box: same place and size; the picture 1.1× about the centre (it overflows, the box clips it).
  const box = of(p, 60, "a")!.box!;
  assert.deepEqual([box.x, box.y, box.w, box.h], [0, 0, 1920, 1080]);
  close(box.scale, 1.1);
  close(box.content.w, 1920 * 1.1);
  close(box.content.x, -96);
  close(box.content.y, -54);
});

test("transitionAt and moveBox: shares at the edges, a boxed clip and a component moved, the canvas box for text", () => {
  const p = twoClips({ module: "transition.push-left", duration: 20 });
  const main = p.tracks[1]!;
  const { starts } = layout(p);
  const spanA = spanOf(main, 0, starts.get("a")!);
  const spanB = spanOf(main, 1, starts.get("b")!);
  assert.equal(spanA.next, "transition.push-left");
  assert.equal(spanB.into, "transition.push-left");
  assert.deepEqual(transitionAt(spanA, 30, p.canvas), { opacity: 1 });
  assert.deepEqual(transitionAt(spanB, 70, p.canvas), { opacity: 1 });
  close(transitionAt(spanA, 60, p.canvas).shift!, -960);
  close(transitionAt(spanB, 60, p.canvas).shift!, 960);
  // moveBox: a picture-in-picture box moves with its picture; a zoom about its own centre.
  const pip = clipBox({ transform: { x: 100, y: 50, w: 640, h: 360, radius: 12 } }, p.canvas, { width: 1920, height: 1080 }, 0);
  const pushed = moveBox(pip, -300);
  assert.deepEqual([pushed.x, pushed.y, pushed.w, pushed.h, pushed.radius, pushed.content.x], [-200, 50, 640, 360, 12, -200]);
  const zoomed = moveBox(pip, 0, 1.2);
  close(zoomed.content.x, 420 - 384);
  close(zoomed.content.w, 768);
  assert.equal(moveBox(pip), pip);
  assert.deepEqual(canvasBox(p.canvas), { x: 0, y: 0, w: 1920, h: 1080, fit: "fill", scale: 1, opacity: 1, radius: 0, content: { x: 0, y: 0, w: 1920, h: 1080 } });
  // A boxed clip on main being pushed in: its box shifts by (1 − p)·W from where it is.
  const boxed = twoClips({ module: "transition.push-left", duration: 20 }, { transform: { x: 100, y: 50, w: 640, h: 360 } });
  close(of(boxed, 60, "b")!.box!.x, 100 + 960);
  // A component pushed in: its box moves, and componentHtml draws it there when given it.
  const comp: Project = {
    ...p,
    tracks: [p.tracks[0]!, { ...main, items: [main.items[0]!, { id: "card", type: "component", component: "component.end-card", duration: 60, transitionIn: { module: "transition.push-left", duration: 20 } }] }],
  };
  assert.deepEqual(validateProject(comp, modules), []);
  const v = of(comp, 60, "card")!;
  const own = componentBox(v.item, comp.canvas, 0)!;
  close(v.box!.x, own.x + 960);
  assert.match(componentHtml(v.item, comp, 0, { box: v.box }), new RegExp(`left:${Math.round((own.x + 960) * 1000) / 1000}px`));
  assert.match(componentHtml(v.item, comp, 0), new RegExp(`left:${Math.round(own.x * 1000) / 1000}px`));
  // Text on main has no box: shift and zoom only (the preview and export move it as the canvas).
  const text: Project = { ...p, tracks: [{ ...main, items: [{ id: "t1", type: "text", text: "One", duration: 60 }, { id: "t2", type: "text", text: "Two", duration: 60, transitionIn: { module: "transition.zoom", duration: 20 } }] }] };
  close(of(text, 60, "t1")!.zoom!, 1.1);
  assert.equal(of(text, 60, "t1")!.box, undefined);
  close(of(text, 60, "t2")!.opacity, 0.5);
});

test("the agent (D79): iris, push and zoom are listed as drawn, documented, and accepted by set_transition", () => {
  const list = modulesList(modules, "transition") as Array<{ id: string; showsInPreview: boolean }>;
  for (const id of ["transition.crossfade", "transition.dip-to-black", "transition.wipe", "transition.iris", "transition.push-left", "transition.zoom"]) assert.equal(list.find((m) => m.id === id)?.showsInPreview, true, id);
  assert.equal(list.find((m) => m.id === "transition.cut")?.showsInPreview, false);
  assert.match(AGENT_TEXT, /transition\.iris \(6–30 frames, a circle opening from the centre\), transition\.push-left \(4–30 frames/);
  assert.match(AGENT_TEXT, /transition\.zoom \(4–30 frames/);
  assert.doesNotMatch(AGENT_TEXT, /iris, push-left, zoom\) are saved but draw as a crossfade/);
  for (const [module, duration] of [["transition.iris", 6], ["transition.push-left", 30], ["transition.zoom", 15]] as const) {
    const ops = [{ op: "set_transition", item: "b", transition: { module, duration } }];
    assert.deepEqual(validateOps(ops), [], module);
    const s = applyEdit(createSession(twoClips()), { actor: "agent", ops: ops as never }, (p) => validateProject(p, modules));
    assert.deepEqual(s.project.tracks[1]!.items[1]!.transitionIn, { module, duration });
  }
  // Out of the manifest's range: refused.
  assert.throws(() => applyEdit(createSession(twoClips()), { actor: "agent", ops: [{ op: "set_transition", item: "b", transition: { module: "transition.iris", duration: 4 } }] as never }, (p) => validateProject(p, modules)));
});

test("sound: a crossfade, wipe, iris, push or zoom crossfades it; a dip to black dips it (no overlap)", () => {
  for (const module of ["transition.crossfade", "transition.wipe", "transition.iris", "transition.push-left", "transition.zoom"]) {
    const p = twoClips({ module, duration: 20 });
    const g = (f: number, id: string) => audibleAt(p, layout(p).starts, f).find((a) => a.item.id === id)?.gain;
    close(g(60, "a")!, 0.5, module);
    close(g(60, "b")!, 0.5, module);
  }
  const p = twoClips({ module: "transition.dip-to-black", duration: 20 });
  const g = (f: number, id: string) => audibleAt(p, layout(p).starts, f).find((a) => a.item.id === id)?.gain;
  close(g(45, "a")!, 1);
  close(g(55, "a")!, 0.5);
  assert.equal(g(60, "a"), undefined, "a stops at the cut");
  assert.equal(g(59, "b"), undefined, "b doesn't start early");
  close(g(60, "b")!, 0);
  close(g(65, "b")!, 0.5);
  close(g(70, "b")!, 1);
  // The dip replaces the clip's own fade on that side.
  const faded = twoClips({ module: "transition.dip-to-black", duration: 20 }, { fadeIn: 40 });
  close(audibleAt(faded, layout(faded).starts, 70).find((a) => a.item.id === "b")!.gain, 1);
});

test("handles: a crossfade or wipe needs footage past the cut, a dip to black doesn't", () => {
  // b from its media's first frame: nothing before its in-point.
  const noHandle = (module: string) => {
    const p = twoClips({ module, duration: 20 });
    return { ...p, tracks: p.tracks.map((t) => (t.id === "main" ? { ...t, items: [t.items[0]!, { ...t.items[1]!, in: 0 }] } : t)) };
  };
  assert.deepEqual(timelineProblems(noHandle("transition.dip-to-black")), []);
  assert.deepEqual(validateProject(noHandle("transition.dip-to-black"), modules), []);
  for (const module of ["transition.crossfade", "transition.wipe"]) assert.deepEqual(timelineProblems(noHandle(module)).map((e) => e.code), ["transition-handles"], module);
  // Module limits still apply to a dip (4–90 frames), and both clips must be twice it.
  const long = twoClips({ module: "transition.dip-to-black", duration: 40 });
  assert.deepEqual(timelineProblems(long).map((e) => e.code), ["transition-too-long"]);
  assert.ok(validateProject(twoClips({ module: "transition.dip-to-black", duration: 2 }), modules).some((e) => e.code === "transition-length"));
});

test("transitionLimits: the module's limits, half the shorter clip, the handles; a sentence when nothing fits", () => {
  const p = twoClips();
  assert.deepEqual(transitionLimits(p, "b", "transition.crossfade"), { min: 2, max: 30 });
  assert.deepEqual(transitionLimits(p, "b", "transition.wipe"), { min: 4, max: 30 });
  assert.deepEqual(transitionLimits(p, "b", "transition.dip-to-black"), { min: 4, max: 30 });
  // Shorter handles: b from frame 7 of its media allows 14; a ending 3 frames before the media's end allows 6.
  const tight = { ...p, tracks: p.tracks.map((t) => (t.id === "main" ? { ...t, items: [{ ...t.items[0]!, in: 237 }, { ...t.items[1]!, in: 7 }] } : t)) };
  assert.deepEqual(transitionLimits(tight, "b", "transition.crossfade"), { min: 2, max: 6 });
  assert.deepEqual(transitionLimits(tight, "b", "transition.dip-to-black"), { min: 4, max: 30 });
  const none = { ...p, tracks: p.tracks.map((t) => (t.id === "main" ? { ...t, items: [t.items[0]!, { ...t.items[1]!, in: 0 }] } : t)) };
  assert.match((transitionLimits(none, "b", "transition.crossfade") as { problem: string }).problem, /Not enough footage for a crossfade here: "b" starts at the beginning of its footage.*Dip to black/);
  // An iris keeps its manifest's limits: 6–30.
  assert.deepEqual(transitionLimits(p, "b", "transition.iris"), { min: 6, max: 30 });
  assert.deepEqual(planSetTransition(p, "b", { module: "transition.iris", duration: 99 }), { ops: [{ op: "set_transition", item: "b", transition: { module: "transition.iris", duration: 30 } }], summary: "Added iris" });
  assert.match((transitionLimits(p, "a", "transition.crossfade") as { problem: string }).problem, /first clip/);
  assert.match((transitionLimits(p, "title", "transition.crossfade") as { problem: string }).problem, /main track/);
  const short = { ...p, tracks: p.tracks.map((t) => (t.id === "main" ? { ...t, items: [{ ...t.items[0]!, duration: 7 }, t.items[1]!] } : t)) };
  assert.match((transitionLimits(short, "b", "transition.wipe") as { problem: string }).problem, /too short for a wipe: both need at least 8 frames/);
});

test("planSetTransition: one edit each, labelled for history; lengths default, clamp and survive a type change", () => {
  const apply = (p: Project, plan: ReturnType<typeof planSetTransition>) => {
    assert.ok("ops" in plan, "problem" in plan ? plan.problem : "");
    const s = applyEdit(createSession(p), { actor: "user", ops: plan.ops });
    assert.deepEqual(validateProject(s.project, modules), []);
    return s.project;
  };
  const p0 = twoClips();
  let plan = planSetTransition(p0, "b", { module: "transition.crossfade" });
  assert.deepEqual(plan, { ops: [{ op: "set_transition", item: "b", transition: { module: "transition.crossfade", duration: 15 } }], summary: "Added crossfade" });
  let p = apply(p0, plan);
  plan = planSetTransition(p, "b", { module: "transition.crossfade", duration: 24 });
  assert.equal((plan as { summary: string }).summary, "Changed transition to 0.8 s");
  p = apply(p, plan);
  // Too long for the cut: clamped to 30 (half of each 60-frame clip); the same again is no edit.
  plan = planSetTransition(p, "b", { module: "transition.crossfade", duration: 500 });
  assert.deepEqual((plan as unknown as { ops: Array<unknown> }).ops, [{ op: "set_transition", item: "b", transition: { module: "transition.crossfade", duration: 30 } }]);
  assert.equal((plan as { summary: string }).summary, "Changed transition to 1 s");
  p = apply(p, plan);
  assert.deepEqual(planSetTransition(p, "b", { module: "transition.crossfade", duration: 31 }), { ops: [], summary: "" });
  // Changing the type keeps the length (clamped to the new module's limits).
  plan = planSetTransition(p, "b", { module: "transition.dip-to-black" });
  assert.equal((plan as { summary: string }).summary, "Changed transition to dip to black");
  p = apply(p, plan);
  assert.equal(p.tracks[1]!.items[1]!.transitionIn?.duration, 30);
  plan = planSetTransition(p, "b", { module: "transition.wipe", duration: 1 });
  assert.equal((plan as { summary: string }).summary, "Changed transition to wipe");
  p = apply(p, plan);
  assert.equal(p.tracks[1]!.items[1]!.transitionIn?.duration, 4, "wipe's minimum");
  plan = planSetTransition(p, "b", null);
  assert.deepEqual(plan, { ops: [{ op: "set_transition", item: "b", transition: null }], summary: "Removed wipe" });
  p = apply(p, plan);
  assert.equal(p.tracks[1]!.items[1]!.transitionIn, undefined);
  assert.deepEqual(planSetTransition(p, "b", null), { ops: [], summary: "" });
  // Refusals, as sentences.
  assert.match((planSetTransition(p, "a", { module: "transition.crossfade" }) as { problem: string }).problem, /first clip/);
  assert.match((planSetTransition(p, "title", { module: "transition.crossfade" }) as { problem: string }).problem, /main track/);
  const locked = { ...p, tracks: p.tracks.map((t) => (t.id === "main" ? { ...t, locked: true } : t)) };
  assert.match((planSetTransition(locked, "b", { module: "transition.crossfade" }) as { problem: string }).problem, /locked/);
  // A locked clip on either side refuses it (the timeline's drop targets use this too).
  for (const i of [0, 1]) {
    const one = { ...p, tracks: p.tracks.map((t) => (t.id === "main" ? { ...t, items: t.items.map((it, k) => (k === i ? { ...it, locked: true } : it)) } : t)) };
    assert.match((planSetTransition(one, "b", { module: "transition.crossfade" }) as { problem: string }).problem, /locked/, `locked ${i}`);
  }
  const noHandle = { ...p, tracks: p.tracks.map((t) => (t.id === "main" ? { ...t, items: [t.items[0]!, { ...t.items[1]!, in: 0 }] } : t)) };
  assert.match((planSetTransition(noHandle, "b", { module: "transition.wipe" }) as { problem: string }).problem, /Not enough footage/);
  apply(noHandle, planSetTransition(noHandle, "b", { module: "transition.dip-to-black" }));
});

test("cuts: listed in order; the nearest one to a frame", () => {
  const p0 = twoClips();
  const p = { ...p0, tracks: p0.tracks.map((t) => (t.id === "main" ? { ...t, items: [...t.items, { id: "c", type: "clip" as const, media: "m", in: 120, duration: 30 }] } : t)) };
  assert.deepEqual(mainCuts(p).map((c) => [c.item.id, c.prev.id, c.frame]), [["b", "a", 60], ["c", "b", 120]]);
  assert.equal(nearestCut(p, 0)?.item.id, "b");
  assert.equal(nearestCut(p, 95)?.item.id, "c");
  assert.equal(nearestCut(twoClips(), 1000)?.item.id, "b");
  assert.equal(nearestCut({ ...p0, tracks: [p0.tracks[0]!] }, 10), undefined);
});

test("a dip to black at a cut: trims need no handles but keep twice its length, splits stay clear, delete and moves drop it", () => {
  const ok = <T extends object>(plan: T) => {
    assert.ok(!("problem" in plan), "problem" in plan ? String(plan.problem) : "");
    return plan as Exclude<T, { readonly problem: string }>;
  };
  const base = twoClips({ module: "transition.dip-to-black", duration: 20 });
  // b from frame 0 and a to the media's end: no handles at all.
  const p: Project = { ...base, tracks: base.tracks.map((t) => (t.id === "main" ? { ...t, items: [{ ...t.items[0]!, in: 240 }, { ...t.items[1]!, in: 0 }] } : t)) };
  assert.deepEqual(validateProject(p, modules), []);
  const run = (plan: { ops: ReadonlyArray<unknown> }) => {
    const s = applyEdit(createSession(p), { actor: "user", ops: plan.ops as never });
    assert.deepEqual(validateProject(s.project, modules), []);
    return s.project;
  };
  // b's start can't extend (it's at frame 0 of its media) but nothing else stops it; shortening stops at 40 (2 × 20).
  assert.equal(ok(planTrim(p, "b", "start", -10)).ops.length, 0);
  assert.equal(ok(planTrim(p, "b", "start", 500)).duration, 40);
  assert.equal(ok(planTrim(p, "a", "end", -500)).duration, 40);
  run(ok(planTrim(p, "a", "start", 15)));
  // A crossfade in the same spot would be invalid; the dip is fine after a trim of a's end.
  run(ok(planTrim(p, "a", "end", -10)));
  // Splits within twice the dip of the cut are refused.
  assert.match((planSplit(p, undefined, 30) as { problem: string }).problem, /transition/);
  assert.match((planSplit(p, undefined, 75) as { problem: string }).problem, /transition/);
  run(ok(planSplit(p, undefined, 10)));
  // Delete a: b is first, its dip goes in the same edit. Move b first: the cut changes, the dip goes.
  assert.equal(run(ok(planDelete(p, "a"))).tracks[1]!.items[0]!.transitionIn, undefined);
  const moved = run(ok(planMove(p, "b", "main", 0)));
  assert.deepEqual(moved.tracks[1]!.items.map((i) => [i.id, !!i.transitionIn]), [["b", false], ["a", false]]);
});
