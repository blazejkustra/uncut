import { test } from "node:test";
import assert from "node:assert/strict";

import { planTrim } from "../../apps/web/src/timeline/edit.ts";
import { planResetPosition } from "../../apps/web/src/timeline/clip.ts";
import {
  applyEdit,
  createSession,
  animationAt,
  keyAt,
  planTrack,
  planUntrack,
  textHtml,
  thinPath,
  trackProblem,
  trackRequest,
  trackTargets,
  type Item,
  type Project,
  type RenderTarget,
  type Op,
  type TrackFrame,
} from "../../packages/core/src/index.ts";

const CANVAS = { width: 1920, height: 1080, fps: 30 } as const;
const TEXT: Item = { id: "t", type: "text", text: "Hello", start: 0, duration: 120, transform: { x: 100, y: 200 } };

function project(clip: Partial<Item> = {}, overlay: Partial<Item> = {}): Project {
  return {
    format: "uncut/0",
    name: "T",
    canvas: CANVAS,
    media: [{ id: "m", kind: "video", name: "ball.mp4", path: "/x/ball.mp4", probe: { frames: 600, fps: 30, width: 1920, height: 1080, hasAudio: false } }],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [{ ...TEXT, ...overlay } as Item] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c", type: "clip", media: "m", in: 0, duration: 120, ...clip } as Item] },
    ],
  };
}

/** The object moves right by 0.1 of the picture a second, from x 0.1. */
const steady = (seconds = 20, from = 0): Array<TrackFrame> =>
  Array.from({ length: seconds * 30 }, (_, i) => ({ t: from + i / 30, x: 0.1 + (i / 30) * 0.1, y: 0.5, w: 0.1, h: 0.1 }));

const keysOfPlan = (plan: ReturnType<typeof planTrack>) => {
  if ("problem" in plan) throw new Error(plan.problem);
  const set = (plan.ops[0] as unknown as { set: { keys: Item["keys"] } }).set;
  return set.keys!;
};
const near = (a: number, b: number, tolerance = 2) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not near ${b}`);

test("D329: the box goes from canvas px to the clip's picture, and the range is what both show", () => {
  const p = project({ transform: { x: 480, y: 270, w: 960, h: 540, fit: "fill" } }, { start: 30, duration: 30 });
  const r = trackRequest(p, { item: "t", target: "c", frame: 45, box: { x: 480, y: 270, w: 480, h: 270 } });
  assert.ok(!("problem" in r));
  assert.deepEqual(r.box, { x: 0, y: 0, w: 0.5, h: 0.5 });
  near(r.start, 1.5, 0.001);
  near(r.end, 2, 0.001);
});

test("D329: a box outside the picture, a playhead off either item and a slip are refused with a sentence", () => {
  const p = project({ transform: { x: 480, y: 270, w: 960, h: 540, fit: "fill" } }, { start: 30, duration: 30 });
  const ask = { item: "t", target: "c", frame: 45 };
  assert.match((trackRequest(p, { ...ask, box: { x: 0, y: 0, w: 100, h: 100 } }) as { problem: string }).problem, /on the clip's picture/);
  assert.match((trackRequest(p, { ...ask, box: { x: 500, y: 300, w: 2, h: 100 } }) as { problem: string }).problem, /on the clip's picture/);
  assert.match((trackRequest(p, { ...ask, frame: 10, box: { x: 500, y: 300, w: 100, h: 100 } }) as { problem: string }).problem, /Move the playhead/);
});

test("D329: reversed, looped and still clips, a clip above and a locked item are refused", () => {
  assert.match(trackProblem(project({ reverse: true }), "t", "c")!, /plays backwards/);
  assert.match(trackProblem(project({ loop: true }), "t", "c")!, /looped/);
  assert.match(trackProblem(project({}, { locked: true }), "t", "c")!, /locked/);
  const above = project();
  assert.match(trackProblem({ ...above, tracks: [above.tracks[1]!, above.tracks[0]!] }, "t", "c")!, /isn't under/);
  const still = project();
  assert.match(trackProblem({ ...still, media: [{ ...still.media[0]!, kind: "image" }] }, "t", "c")!, /video clip/);
  assert.deepEqual(
    trackTargets(project(), "t").map((c) => c.id),
    ["c"],
  );
});

test("D329: a text keeps its offset from the object, on a clip that fills the canvas", () => {
  const plan = planTrack(project(), { item: "t", target: "c", start: 0 }, steady());
  const keys = keysOfPlan(plan);
  assert.equal(keys[0]!.frame, 0);
  assert.equal(keys[0]!.x, 100);
  assert.equal(keys[0]!.y, 200);
  near(keyAt(keys, "x", 60, 30)!, 100 + 2 * 0.1 * 1920);
  near(keyAt(keys, "y", 60, 30)!, 200);
  assert.ok(keys.length <= 3, `a steady move is few keys: ${keys.length}`);
});

test("D329: sped up and ramped clips follow the clip's time, not the timeline's", () => {
  const fast = keysOfPlan(planTrack(project({ speed: 2 }), { item: "t", target: "c", start: 0 }, steady()));
  near(keyAt(fast, "x", 30, 30)!, 100 + 0.2 * 1920);
  const ramp = project({
    speedKeys: [
      { frame: 0, speed: 1 },
      { frame: 30, speed: 1, ease: "linear" },
      { frame: 31, speed: 4 },
      { frame: 120, speed: 4 },
    ],
  });
  const keys = keysOfPlan(planTrack(ramp, { item: "t", target: "c", start: 0 }, steady()));
  near(keyAt(keys, "x", 15, 30)!, 100 + 0.05 * 1920, 3);
  const slope = (f: number) => keyAt(keys, "x", f + 10, 30)! - keyAt(keys, "x", f, 30)!;
  assert.ok(slope(60) > slope(5) * 3, `the object speeds up with the ramp: ${slope(5)} then ${slope(60)}`);
});

test("D329: tracking from the middle of a clip with a trim starts at the moment asked for, and earlier keys stay", () => {
  const overlay = {
    keys: [
      { frame: 0, x: 0, y: 0, opacity: 1 },
      { frame: 30, x: 100, y: 200 },
      { frame: 80, x: 999, y: 999 },
      { frame: 80, opacity: 0.5 },
    ],
  };
  const clip = { in: 30 };
  const keys = keysOfPlan(planTrack(project(clip, overlay), { item: "t", target: "c", start: 2 }, steady(10, 2)));
  assert.deepEqual(
    keys.slice(0, 2).map((k) => [k.frame, k.x]),
    [
      [0, 0],
      [30, 100],
    ],
  );
  assert.ok(!keys.some((k) => k.x === 999), "a later key of the old path goes");
  assert.ok(
    keys.some((k) => k.frame === 80 && k.opacity === 0.5),
    "another property's key stays",
  );
  near(keyAt(keys, "x", 60, 30)!, 100 + 1 * 0.1 * 1920);
});

test("D329: when the object is lost, it holds its last position and says when, on the timeline", () => {
  const frames: Array<TrackFrame> = [...steady().slice(0, 45), { t: 45 / 30, lost: true }];
  const plan = planTrack(project({}, { start: 30, duration: 90 }), { item: "t", target: "c", start: 0 }, frames);
  assert.ok(!("problem" in plan));
  assert.equal(plan.lostFrame, 45);
  assert.match(plan.note!, /lost at 0:01\.5/);
  const keys = keysOfPlan(plan);
  assert.ok(keys.at(-1)!.frame <= 15, "no keys past the loss");
  assert.equal(keyAt(keys, "x", 80, 30), keyAt(keys, "x", 14, 30));
  const never = planTrack(project(), { item: "t", target: "c", start: 0 }, [
    { t: 0, x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    { t: 1 / 30, lost: true },
  ]);
  assert.match((never as { problem: string }).problem, /straight away/);
});

test("D329: jitter is smoothed and thinned, and the first key is exactly where the item was", () => {
  const jitter = (i: number) => (i % 2 ? 0.0015 : -0.0015);
  const frames: Array<TrackFrame> = Array.from({ length: 120 }, (_, i) => ({ t: i / 30, x: 0.3 + 0.1 * Math.sin(i / 20) + jitter(i), y: 0.3, w: 0.1, h: 0.1 }));
  const keys = keysOfPlan(planTrack(project(), { item: "t", target: "c", start: 0 }, frames));
  assert.equal(keys[0]!.x, 100);
  assert.ok(keys.length < 30, `thinned: ${keys.length} keys for 120 frames`);
  for (let f = 0; f < 119; f++) {
    const expected = 100 + 0.1 * Math.sin(f / 20) * 1920;
    near(keyAt(keys, "x", f, 30)!, expected, 12);
  }
});

test("D329: a still object is one key; thinPath keeps corners", () => {
  const still = Array.from({ length: 60 }, (_, i) => ({ t: i / 30, x: 0.3, y: 0.3, w: 0.1, h: 0.1 }));
  assert.equal(keysOfPlan(planTrack(project(), { item: "t", target: "c", start: 0 }, still)).length, 1);
  assert.deepEqual(thinPath([{ values: [0, 1, 2, 3, 2, 1, 0], tolerance: 0.1 }]), [0, 3, 6]);
});

test("D329: scale is off by default; on, it's the object's size against where it started", () => {
  const growing: Array<TrackFrame> = Array.from({ length: 120 }, (_, i) => ({ t: i / 30, x: 0.3, y: 0.3, w: 0.1 + i * 0.001, h: 0.1 + i * 0.001 }));
  assert.ok(keysOfPlan(planTrack(project(), { item: "t", target: "c", start: 0 }, growing)).every((k) => k.scale === undefined));
  const keys = keysOfPlan(planTrack(project(), { item: "t", target: "c", start: 0, scale: true }, growing));
  assert.equal(keys[0]!.scale, 1);
  near(keyAt(keys, "scale", 100, 30)!, (0.1 + 0.1) / 0.1, 0.1);
});

test("D329: the clip's own box and keys are in the path; a sticker and an image take ordinary keys", () => {
  const boxed = keysOfPlan(planTrack(project({ transform: { x: 0, y: 0, w: 960, h: 540, fit: "fill" } }), { item: "t", target: "c", start: 0 }, steady()));
  near(keyAt(boxed, "x", 30, 30)! - 100, 0.1 * 960);
  const panning = keysOfPlan(
    planTrack(
      project({
        transform: { x: 0, y: 0, w: 1920, h: 1080, fit: "fill" },
        keys: [
          { frame: 0, y: 0 },
          { frame: 60, y: 100 },
        ],
      }),
      { item: "t", target: "c", start: 0 },
      steady(),
    ),
  );
  near(keyAt(panning, "y", 60, 30)!, 300);
  const base = project();
  const sticker = {
    ...base,
    tracks: [
      {
        id: "over",
        kind: "video" as const,
        name: "Over",
        items: [
          {
            id: "s",
            type: "component" as const,
            component: "component.sticker",
            start: 0,
            duration: 120,
            props: { emoji: "🔥" },
            transform: { x: 50, y: 60, w: 200, h: 200 },
          } as Item,
        ],
      },
      base.tracks[1]!,
    ],
  };
  const keys = keysOfPlan(planTrack(sticker, { item: "s", target: "c", start: 0 }, steady()));
  assert.equal(keys[0]!.x, 50);
  near(keyAt(keys, "x", 30, 30)!, 50 + 0.1 * 1920);
});

test("D329: a text's keys reach its HTML through its animation, without reflowing, and the track comes off", () => {
  const target = { canvas: { width: 1000, height: 1000, background: "#000", fps: 30 } } as unknown as RenderTarget;
  const item: Item = {
    id: "t",
    type: "text",
    text: "Hi",
    duration: 60,
    transform: { x: 100, y: 100 },
    keys: [
      { frame: 0, x: 100, y: 100 },
      { frame: 60, x: 700, y: 400, scale: 2 },
    ],
  };
  const { motion } = animationAt(item, 30, target.canvas);
  assert.deepEqual(motion.keyed, { x: 400, y: 250 });
  const html = textHtml(item, target, { motion });
  assert.match(html, /left:40%/);
  assert.match(html, /top:25%/);
  assert.match(html, /max-width:90%/);
  const plain = animationAt({ ...item, keys: undefined }, 30, target.canvas);
  assert.deepEqual(plain.motion, {});
  const off = planUntrack(
    project(
      {},
      {
        keys: [
          { frame: 0, x: 1, y: 2 },
          { frame: 5, opacity: 0.5 },
        ],
      },
    ),
    "t",
  );
  assert.ok(!("problem" in off));
  assert.deepEqual((off.ops[0] as unknown as { set: { keys: unknown } }).set.keys, [{ frame: 5, opacity: 0.5 }]);
});

const TRACK_KEYS = [
  { frame: 0, x: 0, y: 0 },
  { frame: 119, x: 500, y: 0 },
];
const planned = <T>(plan: T | { readonly problem: string }) => {
  if (plan && typeof plan === "object" && "problem" in plan) throw new Error(plan.problem);
  return plan as T;
};

test("D329 review: an overlay trims past its keys from the end, its value kept on the new end; a video clip keeps the rule", () => {
  const text = project({}, { keys: TRACK_KEYS });
  const trim = planned(planTrim(text, "t", "end", -60));
  assert.equal(trim.duration, 60);
  const after = applyEdit(createSession(text), { actor: "user", ops: trim.ops as ReadonlyArray<Op> }).project.tracks[0]!.items[0]!;
  assert.ok(after.keys!.every((k) => k.frame <= 60));
  assert.ok(Math.abs(keyAt(after.keys, "x", 60, 30)! - (500 * 60) / 119) < 1);

  const base = project();
  const overlays: ReadonlyArray<Item> = [
    { id: "s", type: "component", component: "component.sticker", start: 0, duration: 120, props: { emoji: "🔥" }, keys: TRACK_KEYS } as Item,
    { id: "i", type: "clip", media: "still", start: 0, duration: 120, keys: TRACK_KEYS } as Item,
    { id: "v", type: "clip", media: "m", in: 0, start: 0, duration: 120, keys: TRACK_KEYS } as Item,
  ];
  const many: Project = {
    ...base,
    media: [...base.media, { id: "still", kind: "image", name: "a.png", path: "/x/a.png", probe: { width: 10, height: 10 } } as Project["media"][number]],
    tracks: [
      { id: "over", kind: "video", name: "Over", items: [] },
      ...overlays.map((o, i) => ({ id: `o${i}`, kind: "video" as const, name: `O${i}`, items: [o] })),
      base.tracks[1]!,
    ],
  };
  assert.equal(planned(planTrim(many, "s", "end", -60)).duration, 60);
  assert.equal(planned(planTrim(many, "i", "end", -60)).duration, 60);
  assert.equal(planned(planTrim(many, "v", "end", -60)).duration, 119, "a video clip stops at its last key, as before");
});

test("D329 review: Remove track takes x and y, and scale only when asked; the user's scale keys otherwise stay", () => {
  const p = project(
    {},
    {
      keys: [
        { frame: 0, x: 1, y: 2, scale: 1.5 },
        { frame: 5, opacity: 0.5 },
        { frame: 9, scale: 2 },
      ],
    },
  );
  const keysAfter = (scale: boolean) =>
    ((planned(planUntrack(p, "t", { scale })) as { ops: ReadonlyArray<unknown> }).ops[0] as { set: { keys: unknown } }).set.keys;
  assert.deepEqual(keysAfter(false), [
    { frame: 0, scale: 1.5 },
    { frame: 5, opacity: 0.5 },
    { frame: 9, scale: 2 },
  ]);
  assert.deepEqual(keysAfter(true), [{ frame: 5, opacity: 0.5 }]);
});

test("D329 review: Reset position on a keyed text takes its keys off too, as a clip's does", () => {
  const keyed = project({}, { keys: TRACK_KEYS });
  const reset = planned(planResetPosition(keyed, "t")) as { ops: ReadonlyArray<unknown> };
  const set = (reset.ops[0] as { set: Record<string, unknown> }).set;
  assert.equal(set.transform, null);
  assert.equal(set.keys, null);
  const onlyKeys = project({}, { keys: TRACK_KEYS, transform: { rotate: 5 } });
  assert.deepEqual(((planned(planResetPosition(onlyKeys, "t")) as { ops: ReadonlyArray<unknown> }).ops[0] as { set: Record<string, unknown> }).set, {
    keys: null,
  });
  assert.match((planResetPosition(project({}, { transform: { rotate: 5 } }), "t") as { problem: string }).problem, /already where it starts/);
});
