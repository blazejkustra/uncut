// Transitions UI chunk (D73), without the app: the drawn transitions' maths in core (crossfade,
// dip to black, wipe), their sound, the handle rules, how long one can be at a cut, the planner's
// edits and labels, and what trims, splits, deletes and moves do to them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyEdit, audibleAt, createSession, defaultFrames, layout, loadModules, timelineProblems, TRANSITION_LIMITS, TRANSITIONS, transitionLimits, validateProject, visualsAt, type Project } from "../packages/core/src/index.ts";
import { mainCuts, nearestCut, planDelete, planMove, planSetTransition, planSplit, planTrim } from "../apps/web/src/edit.ts";

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
  assert.deepEqual(TRANSITIONS.map((t) => t.id), ["transition.crossfade", "transition.dip-to-black", "transition.wipe"]);
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

test("sound: a crossfade or wipe crossfades it; a dip to black dips it (no overlap)", () => {
  for (const module of ["transition.crossfade", "transition.wipe"]) {
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
  // An agent-made iris (drawn as a crossfade) keeps its manifest's limits: 6–30.
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
