// Fable QA round 2, the Inspector chunk (planning/FEEDBACK.md F17, F18, F23; D160–D162) without the
// app: an effect turned off (bypass) is skipped by core's one definition, so by the export's filter
// chain too; editing an off effect keeps it off; the toggle is one edit with words.
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyEdit, clipFx, createSession, fxWords, loadModules, needsPicturePass, validateProject, type Op, type Project } from "../../packages/core/src/index.ts";
import { planAdjust, planEffect, planEffectBypass, planSetLook } from "../../packages/core/src/visual/fx.ts";
import { exportCommand, planExport, planLuts } from "../../apps/server/src/export/exportPlan.ts";
import { mainTextParam } from "../../apps/web/src/inspector/component/schema.ts";
import { componentInfo } from "../../packages/core/src/visual/components.ts";

const modules = await loadModules("spec/modules/builtin");
const base: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [{ id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 900, fps: 30, width: 1920, height: 1080, hasAudio: false } }],
  tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "a", type: "clip", media: "m", in: 0, duration: 60 }] }],
};
function apply(project: Project, plan: { ops: ReadonlyArray<unknown> } | { problem: string }) {
  assert.ok("ops" in plan, `planned: ${"problem" in plan ? plan.problem : ""}`);
  const next = applyEdit(createSession(project), { actor: "user", ops: plan.ops as ReadonlyArray<Op> }).project;
  assert.deepEqual(validateProject(next, modules), []);
  return next;
}
const clip = (p: Project) => p.tracks[0]!.items[0]!;
const graphOf = (p: Project) => {
  const plan = planExport(p, { mediaPath: (m) => m.path, width: 640, height: 360 });
  assert.ok(!("problem" in plan));
  const luts = new Map(planLuts(plan).map((l) => [l.key, `/tmp/${l.key}.cube`] as const));
  return exportCommand(plan, { background: "/tmp/bg.png", rasters: new Map(), caps: { encoders: new Set(["libx264"]), videotoolboxDecode: false, major: 8 }, quality: "draft", output: "/tmp/o.mp4", luts }).graph;
};

test("F18 (D161): an effect turned off isn't drawn by the preview's or the export's definition; on again it is", () => {
  let p = apply(base, planEffect(base, "a", "effect.posterize"));
  p = apply(p, planEffect(p, "a", "effect.mirror"));
  assert.equal(clipFx(clip(p))?.posterize, 5);
  assert.match(graphOf(p), /lutrgb=r='floor/, "posterize in the export chain");
  assert.match(graphOf(p), /hflip/);

  const off = planEffectBypass(p, "a", "effect.posterize", false);
  assert.ok("ops" in off);
  assert.equal(off.summary, "Turn posterize on a.mp4 off");
  assert.equal(off.ops.length, 1, "one edit");
  p = apply(p, off);
  assert.deepEqual(clip(p).effects?.map((e) => [e.module, e.bypass === true]), [["effect.posterize", true], ["effect.mirror", false]], "kept in place, marked off");
  assert.equal(clipFx(clip(p))?.posterize, undefined, "core skips it");
  assert.equal(clipFx(clip(p))?.mirror, true, "the other one still draws");
  assert.doesNotMatch(graphOf(p), /lutrgb=r='floor/, "not in the export chain");
  assert.match(graphOf(p), /hflip/);
  assert.match(fxWords(clip(p).effects), /posterize 5 \(off\)/);
  assert.ok("problem" in planEffectBypass(p, "a", "effect.posterize", false), "already off");

  // Changing an off effect's settings keeps it off.
  p = apply(p, planEffect(p, "a", "effect.posterize", { levels: 6 }));
  assert.equal(clip(p).effects?.[0]?.bypass, true);
  assert.equal((clip(p).effects?.[0]?.params as { levels: number }).levels, 6);

  p = apply(p, planEffectBypass(p, "a", "effect.posterize", true));
  assert.equal(clip(p).effects?.[0]?.bypass, undefined, "on again: no bypass field left");
  assert.equal(clipFx(clip(p))?.posterize, 6);
  assert.match(graphOf(p), /lutrgb=r='floor\(val\*6/);

  // Everything off: no picture pass at all.
  p = apply(p, planEffectBypass(p, "a", "effect.posterize", false));
  p = apply(p, planEffectBypass(p, "a", "effect.mirror", false));
  assert.equal(clipFx(clip(p)), undefined);
  assert.equal(needsPicturePass(clipFx(clip(p))), false);
  assert.doesNotMatch(graphOf(p), /hflip|lutrgb/);
});

test("F18 (D161): the filter and Adjust turn off too, and stay off while they're changed", () => {
  let p = apply(base, planSetLook(base, "a", "warm"));
  p = apply(p, planAdjust(p, "a", { exposure: 0.5 }));
  assert.ok(clipFx(clip(p))?.colour?.look && clipFx(clip(p))?.colour?.adjust);
  assert.match(graphOf(p), /lut3d/);
  p = apply(p, planEffectBypass(p, "a", "effect.look", false));
  assert.equal(clipFx(clip(p))?.colour?.look, undefined);
  p = apply(p, planSetLook(p, "a", "warm", { intensity: 0.5 }));
  assert.equal(clip(p).effects?.find((e) => e.module === "effect.look")?.bypass, true, "intensity change keeps it off");
  p = apply(p, planSetLook(p, "a", "cool"));
  assert.equal(clip(p).effects?.find((e) => e.module === "effect.look")?.bypass, undefined, "a new filter is on");
  p = apply(p, planEffectBypass(p, "a", "effect.color", false));
  p = apply(p, planAdjust(p, "a", { contrast: 0.2 }));
  assert.equal(clip(p).effects?.find((e) => e.module === "effect.color")?.bypass, true);
  assert.equal(clipFx(clip(p))?.colour?.adjust, undefined);
  p = apply(p, planEffectBypass(p, "a", "effect.look", false));
  assert.equal(clipFx(clip(p)), undefined);
  assert.doesNotMatch(graphOf(p), /lut3d/, "both off: no colour table in the export");
  assert.match(fxWords(clip(p).effects), /filter Cool 100% \(off\), exposure \+0\.5 EV, contrast \+20 \(off\)/);
});

test("F23 (D162): an element's main text is its first text param in Content", () => {
  assert.equal(mainTextParam(componentInfo("component.lower-third")!), "name");
  for (const id of ["component.subscribe", "component.callout", "component.quote"]) {
    const info = componentInfo(id);
    if (!info) continue;
    const name = mainTextParam(info);
    assert.ok(name === undefined || (info.params.properties as Record<string, { type?: string }>)[name]?.type === "string", id);
  }
});
