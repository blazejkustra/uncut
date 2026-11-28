// D349: a main clip's sound on its own audio track still counts as the main track's sound: music
// ducked under Main ducks under it, it is voice (not music) to the checks, a paste into the middle
// of V1 keeps it on A1, and a slipped sound without media for a crossfade cuts there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, audibleAt, createSession, layout, type Op, type Project } from "../../packages/core/src/index.ts";
import { duckCurve } from "../../packages/core/src/audio/ducking.ts";
import { projectChecks } from "../../packages/core/src/checks/checks.ts";
import { soundRoles } from "../../packages/core/src/checks/soundRoles.ts";
import { planAddMedia } from "../../apps/web/src/state/project.ts";
import { copyItems, planPaste } from "../../apps/web/src/timeline/clipboard.ts";
import { withLinkMates } from "../../apps/web/src/timeline/edit.ts";
import { linkedOps } from "../helpers/links.ts";

const base = (): Project => ({
  format: "uncut/0",
  name: "Mix",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "cam", kind: "video", name: "IMG_0412.MOV", path: "/IMG_0412.MOV", probe: { frames: 300, fps: 30, width: 320, height: 180, hasAudio: true } },
    { id: "song", kind: "audio", name: "Song.m4a", path: "/Song.m4a", probe: { frames: 600, fps: 30, hasAudio: true } },
  ],
  tracks: [
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
    { id: "music", kind: "audio", name: "Music", items: [{ id: "s", type: "audio", media: "song", in: 0, start: 0, duration: 300 }] },
  ],
});
const apply = (p: Project, ops: ReadonlyArray<unknown>) => applyEdit(createSession(p), { actor: "user", ops: linkedOps(p, ops as ReadonlyArray<Op>) }).project;
function add(p: Project, range?: { in: number; frames: number }): Project {
  const plan = planAddMedia(p, "cam", 0, range);
  if ("problem" in plan) throw new Error(plan.problem);
  return apply(p, plan.ops);
}
const soundOf = (p: Project, clip: string) => withLinkMates(p, clip)[1]!;

test("D349: music ducked under Main ducks under a placed clip's linked sound", () => {
  const p = add(base());
  const ducked: Project = {
    ...p,
    tracks: p.tracks.map((t) =>
      t.id === "music" ? { ...t, mixer: { effects: [{ module: "audio.duck", params: { under: ["main"], amountDb: -12, thresholdDb: -40 } }] } } : t,
    ),
  };
  const curve = duckCurve(
    ducked,
    ducked.tracks.find((t) => t.id === "music")!,
    new Map([["cam", { rate: 100, db: Array.from({ length: 1000 }, () => -10) }]]),
  );
  assert.ok(curve && curve.keys.length > 0, "the music ducks");
  assert.equal(Math.min(...curve.keys.map((k) => k.db)), -12);
});

test("D349: a placed clip's linked sound is voice to the checks, and the music-ducking check still finds it", () => {
  const p = add(base());
  const sound = soundOf(p, p.tracks.find((t) => t.role === "main")!.items[0]!.id);
  for (const speechMedia of [[], ["cam"]]) assert.equal(soundRoles(p, { speechMedia }).get(sound)?.role, "voice", JSON.stringify(speechMedia));
  const checks = projectChecks(p, { speechMedia: ["cam"] }).filter((c) => c.id === "music-ducking");
  assert.equal(checks.length, 1);
  assert.match(checks[0]!.message, /^Music plays under Audio/);
});

test("D349: ⌘V of a pair into the middle of V1 puts its sound on A1, where the later sound moves away from", () => {
  let p = add(add(base(), { in: 0, frames: 90 }), { in: 100, frames: 90 });
  const [a] = p.tracks.find((t) => t.role === "main")!.items;
  const plan = planPaste(p, copyItems(p, withLinkMates(p, a!.id)), 30);
  if ("problem" in plan) throw new Error(plan.problem);
  p = apply(p, plan.ops);
  const audio = p.tracks.filter((t) => t.kind === "audio" && t.id !== "music");
  assert.equal(audio.length, 1, "no new audio track");
  const starts = layout(p).starts;
  assert.deepEqual(
    audio[0]!.items.map((i) => starts.get(i.id)).sort((x, y) => x! - y!),
    [0, 90, 180],
  );
});

test("D349: a linked sound slipped too close to its media's start has no crossfade into it (it would play early)", () => {
  let p = add(add(base(), { in: 0, frames: 90 }), { in: 100, frames: 90 });
  const [, b] = p.tracks.find((t) => t.role === "main")!.items;
  p = apply(p, [{ op: "set_transition", item: b!.id, transition: { module: "transition.crossfade", duration: 20 } }]);
  const sound = soundOf(p, b!.id);
  const slipped = apply(p, [{ op: "update_item", item: sound, set: { in: 5 }, solo: true }]);
  const heard = (q: Project, f: number) => audibleAt(q, layout(q).starts, f).filter((x) => x.item.id === sound && x.gain > 0);
  assert.equal(heard(p, 85).length, 1, "with media before it, the sound fades in early");
  assert.equal(heard(slipped, 85).length, 0, "without, it starts at its cut");
});
