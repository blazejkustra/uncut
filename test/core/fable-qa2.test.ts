// Fable QA round 2 (planning/FEEDBACK.md, D146–D158) without the app: the planners behind the
// fixes, each checked against the validator the server uses.
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyEdit, clipBox, createSession, EASES, layout, loadModules, validateProject, visualsAt, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import { componentInfo, defaultComponentBox } from "../../packages/core/src/visual/components.ts";
import { cameraName } from "../../packages/core/src/text/mentions.ts";
import { planSetSpeed } from "../../packages/core/src/timeline/arrange.ts";
import { planEffect, planSetLook } from "../../packages/core/src/visual/fx.ts";
import { planInsertText } from "../../packages/core/src/text/textPlan.ts";
import { safeMargin } from "../../packages/core/src/visual/render.ts";
import { cutFit, newTrackIndexOver, planGroupTrim, planGrouping, planLayer, planMoveToNewTrack, planSetTransition, planTrim, withGroups, withOverlayRipple } from "../../apps/web/src/timeline/edit.ts";
import { keyEase, keyFrames, nearbyKey, planKeyEase, planResetPosition } from "../../apps/web/src/timeline/clip.ts";
import { planForAll } from "../../apps/web/src/timeline/multi.ts";
import { copyItems, planPaste } from "../../apps/web/src/timeline/clipboard.ts";
import { planCanvas, rescaleItem } from "../../apps/web/src/settings/canvas.ts";
import { planAddText, TEXT_PRESETS } from "../../apps/web/src/state/project.ts";
import { planAddComponent } from "../../apps/web/src/preview/components.ts";

const modules = await loadModules("spec/modules/builtin");
const base: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 900, fps: 30, width: 1920, height: 1080, hasAudio: true } },
    { id: "song", kind: "audio", name: "song.m4a", path: "/song.m4a", probe: { frames: 900, hasAudio: true } },
  ],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [{ id: "t1", type: "text", start: 200, duration: 60, text: "Hi", transform: { x: 100, y: 100 }, style: { size: 96 } }] },
    { id: "overlay", kind: "video", name: "Overlay", items: [{ id: "pip", type: "clip", media: "m", in: 0, start: 160, duration: 60, transform: { x: 1200, y: 600, w: 640, h: 360 } }] },
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "a", type: "clip", media: "m", in: 0, duration: 150 },
        { id: "b", type: "clip", media: "m", in: 300, duration: 150 },
        { id: "c", type: "clip", media: "m", in: 600, duration: 150 },
      ],
    },
    { id: "sfx", kind: "audio", name: "Sounds", items: [{ id: "whoosh", type: "audio", media: "song", in: 0, start: 400, duration: 30 }] },
  ],
};
function apply(project: Project, plan: { ops: ReadonlyArray<unknown> } | { problem: string }) {
  assert.ok("ops" in plan, `planned: ${"problem" in plan ? plan.problem : ""}`);
  const next = applyEdit(createSession(project), { actor: "user", ops: plan.ops as ReadonlyArray<Op> }).project;
  assert.deepEqual(validateProject(next, modules), []);
  return next;
}
const itemIn = (project: Project, id: string) => project.tracks.flatMap((t) => t.items).find((i) => i.id === id)!;
const trackOf = (project: Project, id: string) => project.tracks.find((t) => t.items.some((i) => i.id === id))!;

test("F2 (D147): a filter or effect on several clips is one edit on each of them; items it doesn't apply to are skipped", () => {
  const ids = ["a", "b", "c", "t1"];
  const look = planForAll(base, ids, (p, id) => planSetLook(p, id, "teal-orange"), (n) => `Filter Teal & Orange on ${n} clips`);
  assert.ok("ops" in look);
  assert.deepEqual(look.ids, ["a", "b", "c"], "the text is skipped");
  assert.equal(look.summary, "Filter Teal & Orange on 3 clips");
  const p = apply(base, look);
  for (const id of ["a", "b", "c"]) assert.equal((itemIn(p, id).effects?.[0]?.params as { look?: string }).look, "teal-orange");
  const blur = planForAll(p, ["a", "c"], (q, id) => planEffect(q, id, "effect.blur"), (n) => `Add blur to ${n} clips`);
  assert.ok("ops" in blur && blur.ops.length === 2);
  // None applies: the first reason.
  const none = planForAll(base, ["t1"], (q, id) => planSetLook(q, id, "teal-orange"), () => "");
  assert.ok("problem" in none);
});

test("F5 (D148): key frames for the timeline's diamonds, previous / next key, and a key's ease drawn by the same curve everywhere", () => {
  const keyed: Project = { ...base, tracks: base.tracks.map((t) => (t.id === "overlay" ? { ...t, items: [{ ...t.items[0]!, keys: [{ frame: 5, scale: 1 }, { frame: 20, scale: 2 }, { frame: 40, x: 0, scale: 1 }] }] } : t)) };
  const pip = itemIn(keyed, "pip");
  assert.deepEqual(keyFrames(pip), [5, 20, 40]);
  // Project frames: the clip starts at 160.
  assert.equal(nearbyKey(keyed, 170, 1, ["pip"]), 180);
  assert.equal(nearbyKey(keyed, 180, 1, ["pip"]), 200);
  assert.equal(nearbyKey(keyed, 180, -1, ["pip"]), 165);
  assert.equal(nearbyKey(keyed, 165, -1, ["pip"]), undefined);
  assert.equal(nearbyKey(keyed, 0, 1), 165, "no selection: any item's keys");
  assert.equal(keyEase(pip, 5), "linear");
  assert.equal(keyEase(pip, 6), undefined);
  for (const ease of ["in", "out", "inOut", "linear"] as const) {
    const p = apply(keyed, planKeyEase(keyed, "pip", 5, ease));
    const item = itemIn(p, "pip");
    assert.equal(keyEase(item, 5), ease);
    // Halfway from the key at 5 (scale 1) to 20 (scale 2): the ease's curve (the box the preview
    // draws and the export samples per frame, core clipBox).
    const half = clipBox(item, p.canvas, { width: 1920, height: 1080 }, 12.5).scale;
    assert.ok(Math.abs(half - (1 + EASES[ease](0.5))) < 1e-9, `${ease}: ${half}`);
  }
  assert.ok("problem" in planKeyEase(keyed, "pip", 6, "in"), "only on a key");
});

test("F6 (D149): a clip dragged from Main onto a text lane lands on a new video track under it; text onto a video lane, on a new text track over it", () => {
  const text = base.tracks[0]!;
  const index = newTrackIndexOver(base, itemIn(base, "b"), text);
  assert.equal(index, 1);
  const p = apply(base, planMoveToNewTrack(base, "b", { index: index! }, 150));
  assert.deepEqual(p.tracks.map((t) => t.id), ["text", "video-track-1", "overlay", "main", "sfx"]);
  assert.equal(itemIn(p, "b").start, 150);
  assert.equal(newTrackIndexOver(base, itemIn(base, "t1"), base.tracks[2]!), 2, "text over main: above it");
  assert.equal(newTrackIndexOver(base, itemIn(base, "pip"), base.tracks[2]!), undefined, "a lane that takes it is a plain move");
  assert.equal(newTrackIndexOver(base, itemIn(base, "whoosh"), base.tracks[0]!), undefined, "sounds stay with the audio lanes");
});

test("F7 (D152): every element's default box sits inside the safe area on 9:16, 1:1, 4:5 and 16:9; a lower third bottom-left", () => {
  const ids = ["component.lower-third", "component.callout", "component.subscribe", "component.progress-bar", "component.countdown", "component.sticker", "component.image-frame", "component.shape", "component.chart", "component.code-block", "component.terminal", "component.agent-log", "component.compare-table"];
  for (const [w, h] of [[1080, 1920], [1080, 1080], [1080, 1350], [1920, 1080]] as const) {
    const canvas = { width: w, height: h, fps: 30 as const };
    const m = safeMargin({ canvas });
    for (const id of ids) {
      if (!componentInfo(id)) continue;
      const box = defaultComponentBox(id, { canvas })!;
      assert.ok(box, `${id} has a box`);
      assert.ok(box.x >= m - 1 && box.y >= m - 1 && box.x + box.w <= w - m + 1 && box.y + box.h <= h - m + 1, `${id} on ${w}x${h} inside the safe area: ${JSON.stringify(box)}`);
    }
    const lt = defaultComponentBox("component.lower-third", { canvas })!;
    assert.equal(lt.x, m, `lower third at the left margin on ${w}x${h}`);
    assert.ok(lt.y + lt.h / 2 > h * 0.6, `lower third in the lower part on ${w}x${h}: ${JSON.stringify(lt)}`);
  }
  // The planner uses it (a 9:16 project).
  const vertical: Project = { ...base, canvas: { width: 1080, height: 1920, fps: 30 } };
  const add = planAddComponent(vertical, "component.lower-third", 0);
  assert.ok("ops" in add);
  const p = apply(vertical, add);
  assert.deepEqual(itemIn(p, add.itemId).transform, defaultComponentBox("component.lower-third", vertical));
});

test("F9 (D153): whether a transition fits a cut, and the length it gets there", () => {
  // b starts at 300 of 900 (300 spare frames before), a ends at 150 (750 after): the crossfade's own 2 s cap (60 frames).
  assert.deepEqual(cutFit(base, "b", "transition.crossfade", 15), { fits: true, max: 60, clamped: false });
  assert.equal((cutFit(base, "b", "transition.crossfade", 90) as { clamped: boolean }).clamped, true);
  // No spare footage before c: an overlapping transition doesn't fit, a dip does.
  const tight: Project = { ...base, tracks: base.tracks.map((t) => (t.role === "main" ? { ...t, items: [t.items[0]!, { ...t.items[1]!, in: 0 }] } : t)) };
  const no = cutFit(tight, "b", "transition.crossfade");
  assert.ok(!no.fits && /Needs .* more footage/.test(no.short), JSON.stringify(no));
  assert.ok(cutFit(tight, "b", "transition.dip-to-black").fits);
  // A chosen length applies when a tile replaces a transition (not the old one's length).
  const withFade = apply(base, planSetTransition(base, "b", { module: "transition.crossfade", duration: 15 }));
  const replaced = planSetTransition(withFade, "b", { module: "transition.wipe", duration: 24 });
  assert.ok("ops" in replaced);
  assert.deepEqual((replaced.ops[0] as { transition: unknown }).transition, { module: "transition.wipe", duration: 24 });
  // Longer than the wipe can be (1 s): the tile says so instead of silently keeping less.
  assert.deepEqual(cutFit(withFade, "b", "transition.wipe", 45), { fits: true, max: 30, clamped: true });
});

test("F10 (D155): a new canvas size rescales boxes, text and elements in the same edit; Keep positions leaves them", () => {
  const p = { ...base, canvas: { width: 1080, height: 1350, fps: 30 as const } };
  const fourFive: Project = {
    ...p,
    tracks: p.tracks.map((t) => (t.id === "overlay" ? { ...t, items: [{ ...t.items[0]!, transform: { x: 0, y: 0, w: 1080, h: 1350 } }, { id: "lt", type: "component", component: "component.lower-third", start: 300, duration: 60, props: {}, transform: { x: 72, y: 1000, w: 900, h: 200 } }] } : t)),
  };
  const plan = planCanvas(fourFive, { width: 1080, height: 1080 });
  assert.ok("ops" in plan);
  assert.equal(plan.ops[0]!.op, "update_project");
  const next = apply(fourFive, plan);
  assert.deepEqual(itemIn(next, "pip").transform, { x: 0, y: 0, w: 1080, h: 1080 }, "the whole frame stays the whole frame");
  const lt = itemIn(next, "lt").transform!;
  assert.deepEqual([lt.w, lt.h], [720, 160], "sizes by the smaller ratio (0.8)");
  assert.ok(lt.y! + lt.h! <= 1080 && lt.x! >= 0 && lt.x! + lt.w! <= 1080);
  assert.equal(itemIn(next, "t1").style!.size, 77, "text size too");
  assert.match(plan.summary, /3 items rescaled/);
  const kept = planCanvas(fourFive, { width: 1080, height: 1080 }, { keepPositions: true });
  assert.ok("ops" in kept && kept.ops.length === 1);
  assert.equal(rescaleItem(itemIn(base, "a"), base.canvas, { width: 1080, height: 1920 }), undefined, "a full-frame clip needs nothing");
});

test("F11 (D156): overlays follow the footage under them when a main clip's speed or length changes", () => {
  // pip starts at 160 (10 frames into b), t1 at 200 (50 into b), whoosh at 400 (100 into c).
  const fast = planSetSpeed(base, "a", 2);
  assert.ok("ops" in fast);
  const rippled = withOverlayRipple(base, fast);
  const p = apply(base, rippled);
  // a is 75 frames now: b starts at 75, c at 225; everything after shifts by 75.
  assert.deepEqual([itemIn(p, "pip").start, itemIn(p, "t1").start, itemIn(p, "whoosh").start], [85, 125, 325]);
  assert.match(rippled.summary, /3 overlays follow/);
  // Speed on b itself: what's over b keeps its moment of b's footage.
  const slow = withOverlayRipple(base, planSetSpeed(base, "b", 0.5) as { ops: ReadonlyArray<Op>; summary: string; duration: number });
  const q = apply(base, slow);
  assert.deepEqual([itemIn(q, "pip").start, itemIn(q, "t1").start, itemIn(q, "whoosh").start], [170, 250, 550]);
  // A trim at b's end ripples what's after it.
  const trim = planTrim(base, "b", "end", -30);
  assert.ok("ops" in trim);
  const r = apply(base, withOverlayRipple(base, trim));
  assert.deepEqual([itemIn(r, "pip").start, itemIn(r, "whoosh").start], [160, 370]);
});

test("F13 (D150): camera-style file names get a short display name", () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ["DJI_20261013182112_0042_D.MP4", "DJI 0042"],
    ["DJI_0042.MP4", "DJI 0042"],
    ["IMG_1234.MOV", "IMG 1234"],
    ["MVI_0042.MP4", "MVI 0042"],
    ["GX010042.MP4", "GX 0042"],
    ["C0001.MP4", "C0001"],
    ["VID_20240101_123456.mp4", "VID 123456"],
    ["Product hero.mp4", undefined],
    ["Tone.m4a", undefined],
  ];
  for (const [file, want] of cases) assert.equal(cameraName(file), want, file);
});

test("F15 (D151): bring forward / send backward and reset position", () => {
  // The PiP forward: the text track above isn't for video, so a new video track goes above it.
  const up = planLayer(base, "pip", -1);
  const p = apply(base, up);
  assert.deepEqual(p.tracks.map((t) => t.id), ["video-track-1", "text", "main", "sfx"], "the empty Overlay track goes");
  const { starts } = layout(p);
  assert.deepEqual(visualsAt(p, starts, 161).map((v) => v.item.id).at(-1), "pip", "drawn on top");
  // Back down past main: behind the footage.
  const down = apply(base, planLayer(base, "pip", 1));
  assert.deepEqual(down.tracks.map((t) => t.id), ["text", "main", "video-track-1", "sfx"]);
  assert.ok("problem" in planLayer(base, "a", -1), "main clips stay");
  const reset = apply(base, planResetPosition(base, "pip"));
  assert.equal(itemIn(reset, "pip").transform, undefined);
  const resetText = apply(base, planResetPosition(base, "t1"));
  assert.equal(itemIn(resetText, "t1").transform, undefined);
});

test("F19 (D157): Kicker and title is one group: selected, trimmed, deleted and pasted together; Ungroup", () => {
  const plan = planInsertText(base, { look: "text.kicker-title", start: 30, duration: 90 });
  assert.ok("itemIds" in plan);
  const p = apply(base, { ops: plan.ops });
  const [title, kicker] = plan.itemIds as [string, string];
  assert.equal(itemIn(p, title).group, `group-${title}`);
  assert.equal(itemIn(p, kicker).group, itemIn(p, title).group);
  assert.deepEqual(withGroups(p, [kicker]), [kicker, title]);
  // Trim the title's end by 30: the kicker too.
  const trimmed = apply(p, planGroupTrim(p, title, "end", -30));
  assert.deepEqual([itemIn(trimmed, title).duration, itemIn(trimmed, kicker).duration], [60, 60]);
  // Pasted: a new group, not the original's.
  const pasted = planPaste(p, copyItems(p, withGroups(p, [title])), 300);
  assert.ok("ids" in pasted);
  const q = apply(p, pasted);
  const groups = new Set(pasted.ids.map((id) => itemIn(q, id).group));
  assert.equal(groups.size, 1);
  assert.notEqual([...groups][0], itemIn(p, title).group);
  // Ungroup from either one.
  const un = apply(p, planGrouping(p, [kicker], false));
  assert.equal(itemIn(un, title).group, undefined);
  assert.equal(itemIn(un, kicker).group, undefined);
  // Group two free items.
  const g = apply(base, planGrouping(base, ["pip", "t1"], true));
  assert.equal(itemIn(g, "pip").group, itemIn(g, "t1").group);
  assert.ok("problem" in planGrouping(base, ["a"], true));
});

test("F20 (D158): a text added from the Text tab leaves the playhead where it's fully on screen", () => {
  const preset = TEXT_PRESETS.find((t) => t.module === "text.title")!;
  const add = planAddText(base, preset, 100);
  assert.ok("ops" in add);
  const item = itemIn(apply(base, add), add.itemId) as Item;
  const inMove = item.animation?.in?.duration ?? 0;
  assert.equal(add.show ?? add.start, 100 + Math.min(item.duration - 1, inMove));
  void trackOf;
});
