// More transitions (D133), without the app: every new module's manifest and defaults, what each
// does to the clips at its cut (masks, moves on both axes, zoom on the incoming clip, blur, colour
// layers), the mask shapes' three forms agreeing (core's signed distance, the outline the preview
// clips to, and the geq expression the export evaluates, run through ffmpeg), and the export plan
// (a mask layer cut at the reveal's end, a blur's sigmas and cuts, a vertical push's geometry).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";

import {
  audibleAt,
  defaultFrames,
  dipsOf,
  incomingFx,
  layout,
  loadModules,
  maskDistance,
  maskGeq,
  maskRings,
  outgoingFx,
  TRANSITIONS,
  transitionInfo,
  validateProject,
  visualsAt,
  type MaskShape,
  type Project,
} from "../../packages/core/src/index.ts";
import { exportCommand, planExport } from "../../apps/server/src/export/exportPlan.ts";

const modules = await loadModules("spec/modules/builtin");
const close = (a: number, b: number, msg?: string, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg ?? ""} ${a} vs ${b}`);
const canvas = { width: 1920, height: 1080 };
const NEW = TRANSITIONS.slice(6);
const SHAPES: ReadonlyArray<MaskShape> = [
  "wipe-left",
  "wipe-up",
  "wipe-down",
  "split-v",
  "split-h",
  "box",
  "diamond",
  "diagonal",
  "circle-close",
  "clock",
  "blinds",
];

function twoClips(module: string, duration = 20, extra: Record<string, unknown> = {}): Project {
  return {
    format: "uncut/0",
    name: "T",
    canvas: { width: 1920, height: 1080, fps: 30 },
    media: [{ id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 300, fps: 30, width: 1920, height: 1080, hasAudio: true } }],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "a", type: "clip", media: "m", in: 0, duration: 60 },
          { id: "b", type: "clip", media: "m", in: 40, duration: 60, transitionIn: { module, duration }, ...extra },
        ],
      },
    ],
  };
}
const of = (p: Project, f: number, id: string) => visualsAt(p, layout(p).starts, f).find((v) => v.item.id === id);

test("D133: 28 transitions, each with a manifest, a name, limits that hold its default, and a shape or a move that's drawn", () => {
  assert.equal(TRANSITIONS.length, 28);
  assert.equal(new Set(TRANSITIONS.map((t) => t.id)).size, 28);
  assert.equal(new Set(TRANSITIONS.map((t) => t.name)).size, 28);
  for (const t of NEW) {
    const m = modules.get(t.id);
    assert.ok(m, `${t.id} has a manifest`);
    assert.equal(m.name, t.name);
    assert.deepEqual(m.transition, { minFrames: t.minFrames, maxFrames: t.maxFrames });
    const d = defaultFrames(t, 30);
    assert.ok(d >= t.minFrames && d <= t.maxFrames, t.id);
    assert.ok(t.mask || t.enter || t.exit || t.inZoom || t.blur || t.color, `${t.id} draws something`);
    // No middle dots, asterisks or bullets between words on screen.
    assert.doesNotMatch(`${t.name} ${t.description}`, /[·*•]/);
    assert.deepEqual(validateProject(twoClips(t.id, Math.max(t.minFrames, 20)), modules), [], t.id);
  }
  // Every shape is used by exactly one transition.
  assert.deepEqual(NEW.flatMap((t) => (t.mask ? [t.mask] : [])).sort(), [...SHAPES].sort());
});

test("D133: moves on both axes (push both, slide only the incoming clip), zoom out on the incoming clip, blur on both, linear in p", () => {
  const fx = (id: string, p: number) => [incomingFx(`transition.${id}`, p, canvas), outgoingFx(`transition.${id}`, p, canvas)] as const;
  let [i, o] = fx("push-up", 0.25);
  assert.deepEqual([i.shift, i.shiftY, i.opacity], [undefined, 0.75 * 1080, 1]);
  assert.deepEqual([o.shift, o.shiftY], [undefined, -0.25 * 1080]);
  [i, o] = fx("push-down", 0.5);
  assert.deepEqual([i.shiftY, o.shiftY], [-540, 540]);
  [i, o] = fx("push-right", 0.5);
  assert.deepEqual([i.shift, o.shift], [-960, 960]);
  for (const [id, x, y] of [
    ["slide-left", 960, undefined],
    ["slide-right", -960, undefined],
    ["slide-up", undefined, 540],
    ["slide-down", undefined, -540],
  ] as const) {
    [i, o] = fx(id, 0.5);
    assert.deepEqual([i.shift, i.shiftY, i.opacity], [x, y, 1], id);
    assert.deepEqual(o, { opacity: 1 }, `${id}: the outgoing clip stays`);
  }
  [i, o] = fx("zoom-out", 0.5);
  close(i.zoom!, 1.125);
  close(i.opacity, 0.5);
  assert.deepEqual(o, { opacity: 1 });
  [i, o] = fx("blur", 0.25);
  close(i.blur!, 0.75 * 0.02 * 1080);
  close(o.blur!, 0.25 * 0.02 * 1080);
  close(i.opacity, 0.25);
  [i, o] = fx("flash", 0.5);
  assert.deepEqual([i.opacity, o], [0.5, { opacity: 1 }]);
  for (const s of SHAPES) {
    const t = TRANSITIONS.find((x) => x.mask === s)!;
    [i, o] = fx(t.id.slice("transition.".length), 0.4);
    assert.deepEqual(i, { opacity: 1, mask: { shape: s, p: 0.4 } }, t.id);
    assert.deepEqual(o, { opacity: 1 });
  }
  // On the timeline: a vertical push moves both boxes, a slide only the incoming one; a mask on the incoming clip.
  const push = twoClips("transition.push-up");
  assert.equal(of(push, 60, "a")!.box!.y, -540);
  assert.equal(of(push, 60, "b")!.box!.y, 540);
  assert.equal(of(push, 60, "b")!.shiftY, 540);
  const slide = twoClips("transition.slide-down");
  assert.equal(of(slide, 60, "a")!.box!.y, 0);
  assert.equal(of(slide, 60, "b")!.box!.y, -540);
  const clock = twoClips("transition.clock");
  assert.deepEqual(of(clock, 60, "b")!.mask, { shape: "clock", p: 0.5 });
  assert.equal(of(clock, 60, "a")!.mask, undefined);
  assert.equal(of(clock, 70, "b")!.mask, undefined);
  const blur = twoClips("transition.blur");
  close(of(blur, 60, "a")!.blur!, 0.5 * 0.02 * 1080);
  close(of(blur, 60, "b")!.blur!, 0.5 * 0.02 * 1080);
  assert.equal(of(blur, 40, "a")!.blur, undefined);
});

test("D133: dip to white keeps the clips apart under a white layer (the sound dips); a flash crossfades under one", () => {
  const white = twoClips("transition.dip-to-white");
  const { starts } = layout(white);
  const dips = dipsOf(white.tracks[0]!, starts);
  assert.equal(dips.length, 1);
  assert.equal(dips[0]!.item.props!.color, "#ffffff");
  assert.deepEqual(
    visualsAt(white, starts, 55).map((v) => v.item.id),
    ["a", "dip:b"],
  );
  close(of(white, 55, "dip:b")!.opacity, 0.5);
  close(of(white, 60, "dip:b")!.opacity, 1);
  // The sound dips like a dip to black's: the outgoing clip fades out, nothing overlaps.
  assert.deepEqual(
    audibleAt(white, starts, 65).map((s) => s.item.id),
    ["b"],
  );
  assert.deepEqual(
    audibleAt(white, starts, 55).map((s) => s.item.id),
    ["a"],
  );
  const flash = twoClips("transition.flash", 10);
  const f = layout(flash).starts;
  assert.deepEqual(
    visualsAt(flash, f, 57).map((v) => v.item.id),
    ["a", "b", "dip:b"],
  );
  close(of(flash, 57, "b")!.opacity, 0.2);
  close(of(flash, 57, "dip:b")!.opacity, 0.4);
  assert.equal(dipsOf(flash.tracks[0]!, f)[0]!.item.props!.color, "#ffffff");
  // A crossfade gets no layer.
  assert.equal(dipsOf(twoClips("transition.crossfade").tracks[0]!, f).length, 0);
});

/** Even-odd point-in-polygon over a shape's rings. */
function inside(rings: ReturnType<typeof maskRings>, x: number, y: number) {
  let n = 0;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) n++;
    }
  }
  return n % 2 === 1;
}

test("D133: every mask's outline (the preview's clip-path) agrees with its signed distance (the export's), away from the edge", () => {
  const [W, H] = [320, 180];
  for (const shape of SHAPES) {
    for (const p of [0.15, 0.5, 0.8]) {
      const rings = maskRings(shape, p, W, H);
      let checked = 0;
      for (let y = 0.5; y < H; y += 3) {
        for (let x = 0.5; x < W; x += 3) {
          const d = maskDistance(shape, p, W, H, x, y);
          if (Math.abs(d) < 1.5) continue;
          checked++;
          assert.equal(inside(rings, x, y), d > 0, `${shape} at ${p}: (${x}, ${y}) d=${d}`);
        }
      }
      assert.ok(checked > 3000, `${shape} ${p}`);
    }
    // Nothing at 0, everything at 1 (corners included).
    assert.ok(maskDistance(shape, 0, W, H, W / 2 + 7, H / 2 + 5) <= 0.5, `${shape} at 0`);
    for (const [x, y] of [
      [0.5, 0.5],
      [W - 0.5, H - 0.5],
      [W / 2, H / 2 + 3],
    ])
      assert.ok(maskDistance(shape, 1, W, H, x!, y!) >= -0.5, `${shape} at 1 (${x}, ${y})`);
  }
});

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;

test("D133: every mask's geq expression (export, render_frames) gives core's coverage, pixel for pixel", { skip: hasFfmpeg ? false : "needs ffmpeg" }, () => {
  const [W, H] = [96, 54];
  for (const shape of SHAPES) {
    const p = 0.37;
    const sd = maskGeq(shape, String(p), W, H, "(X+0.5)", "(Y+0.5)");
    const raw = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${W}x${H},format=gray`,
      "-vf",
      `geq=lum='255*clip(${sd}+0.5,0,1)'`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-",
    ]);
    let worst = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const want = 255 * Math.min(1, Math.max(0, maskDistance(shape, p, W, H, x + 0.5, y + 0.5) + 0.5));
        worst = Math.max(worst, Math.abs(raw[y * W + x]! - want));
      }
    }
    assert.ok(worst <= 1.01, `${shape}: off by ${worst}`);
  }
});

test("D133 export plan: a mask layer cut at the reveal's end, a blur's sigmas cut at both sides, a vertical push moves the box", () => {
  const plan = (p: Project) => {
    const r = planExport(p, { mediaPath: (m) => m.path, width: 960, height: 540 });
    if ("problem" in r) throw new Error(r.problem);
    return r;
  };
  const clock = plan(twoClips("transition.clock"));
  const b = clock.visuals.filter((l) => l.item.id === "b");
  assert.deepEqual(
    b.map((l) => [l.f0, l.f1, l.mask?.shape]),
    [
      [50, 70, "clock"],
      [70, 120, undefined],
    ],
  );
  assert.deepEqual(b[0]!.mask, { shape: "clock", st: 50, d: 20 });
  const cmd = exportCommand(clock, {
    background: "/bg.png",
    rasters: new Map(),
    caps: { encoders: new Set(), videotoolboxDecode: false, major: 8 },
    quality: "draft",
    output: "/out.mp4",
  });
  assert.match(cmd.graph, /geq=lum='255\*clip\(\(hypot\(/);
  assert.match(cmd.graph, /atan2/);

  const blur = plan(twoClips("transition.blur"));
  const a = blur.visuals.filter((l) => l.item.id === "a");
  assert.deepEqual(
    a.map((l) => [l.f0, l.f1, !!l.blur]),
    [
      [0, 50, false],
      [50, 70, true],
    ],
  );
  close(a[1]!.blur![10]!, 0.5 * 0.02 * 540, "sigma in output px");
  const bb = blur.visuals.filter((l) => l.item.id === "b");
  assert.deepEqual(
    bb.map((l) => [l.f0, l.f1, !!l.blur]),
    [
      [50, 70, true],
      [70, 120, false],
    ],
  );
  const blurCmd = exportCommand(blur, {
    background: "/bg.png",
    rasters: new Map(),
    caps: { encoders: new Set(), videotoolboxDecode: false, major: 8 },
    quality: "draft",
    output: "/out.mp4",
  });
  assert.match(blurCmd.graph, /gblur@g\d+ sigma/);

  const push = plan(twoClips("transition.push-down"));
  const pa = push.visuals.filter((l) => l.item.id === "a");
  assert.deepEqual(
    pa.map((l) => [l.f0, l.f1, !!l.geometry]),
    [
      [0, 50, false],
      [50, 70, true],
    ],
  );
  assert.equal(pa[1]!.geometry!.frames[10]!.y, 270);
  const pb = push.visuals.filter((l) => l.item.id === "b");
  assert.deepEqual(
    pb.map((l) => [l.f0, l.f1, !!l.geometry]),
    [
      [50, 70, true],
      [70, 120, false],
    ],
  );
  assert.equal(pb[0]!.geometry!.frames[10]!.y, -270);
  // Zoom out: the incoming clip's geometry over the transition only, faded in.
  const zoom = plan(twoClips("transition.zoom-out"));
  const zb = zoom.visuals.filter((l) => l.item.id === "b");
  assert.deepEqual(
    zb.map((l) => [l.f0, l.f1, !!l.geometry]),
    [
      [50, 70, true],
      [70, 120, false],
    ],
  );
  assert.equal(zb[0]!.ramps.length, 1);
  // Dip to white: a white layer.
  const white = plan(twoClips("transition.dip-to-white"));
  assert.ok(white.visuals.some((l) => l.item.id === "dip:b" && l.kind === "raster" && /#ffffff/i.test(l.states[0]!)));
  assert.ok(transitionInfo("transition.dip-to-white")!.overlaps === false);
});
