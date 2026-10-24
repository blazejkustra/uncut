// Clip looks and effects (D136): the registry against the manifests, the colour maths and its
// table, the compiled effects, the planners and their words, the zoom pulse in the box, shake's
// JS and ffmpeg forms, the overlays, and a plugin's filters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ADJUST_INFO,
  applyEdit,
  clipFx,
  colourFn,
  colourLut,
  createSession,
  cubeText,
  describeOp,
  EFFECTS,
  fxBox,
  fxOverlayHtml,
  fxOverlayInner,
  fxPictureSize,
  fxSkips,
  fxWords,
  GRAIN_HOLD,
  GRAIN_STATES,
  layout,
  loadModules,
  LOOKS,
  lutAt,
  needsPicturePass,
  hasOverlay,
  planAdjust,
  planEffect,
  planRemoveEffect,
  planSetLook,
  posterize,
  pulseZoom,
  readContributions,
  shakeAt,
  shakeExpr,
  shakeWindow,
  validateModule,
  validateProject,
  visibleRect,
  visualsAt,
  clipBox,
  type Item,
  type ModuleManifest,
  type Op,
  type Project,
} from "../../packages/core/src/index.ts";

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function project(effects?: Item["effects"], extra: Partial<Item> = {}): Project {
  return {
    format: "uncut/0",
    name: "Fx",
    canvas: { width: 1280, height: 720, fps: 30 },
    media: [
      { id: "m-a", kind: "video", name: "A.mp4", path: "/a.mp4", probe: { frames: 300, fps: 30, width: 1280, height: 720, hasAudio: false } },
      { id: "m-s", kind: "audio", name: "S.m4a", path: "/s.m4a", probe: { frames: 300, fps: 30, hasAudio: true } },
    ],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [{ id: "c1", type: "clip", media: "m-a", in: 0, duration: 90, ...(effects ? { effects } : {}), ...extra }],
      },
      { id: "a", kind: "audio", name: "Audio", items: [{ id: "s1", type: "audio", media: "m-s", start: 0, duration: 90 }] },
    ],
  };
}

test("D136: every effect, the look and Adjust have a manifest whose params are the registry's", async () => {
  for (const e of EFFECTS) {
    const m = json(`spec/modules/builtin/${e.id}.json`);
    assert.equal(m.kind, "effect", e.id);
    assert.equal(m.name, e.name);
    assert.deepEqual(validateModule(m), [], e.id);
    const props = m.params.properties as Record<string, { minimum: number; maximum: number; default: number }>;
    assert.deepEqual(
      Object.keys(props),
      e.params.map((p) => p.key),
      e.id,
    );
    for (const p of e.params)
      assert.deepEqual([props[p.key]!.minimum, props[p.key]!.maximum, props[p.key]!.default], [p.min, p.max, p.default], `${e.id} ${p.key}`);
  }
  const look = json("spec/modules/builtin/effect.look.json");
  assert.deepEqual(validateModule(look), []);
  assert.deepEqual(
    look.params.then.properties.look.enum,
    LOOKS.map((l) => l.id),
  );
  const color = json("spec/modules/builtin/effect.color.json");
  assert.deepEqual(
    Object.keys(color.params.properties),
    ADJUST_INFO.map((a) => a.key),
  );
  assert.equal(new Set(LOOKS.map((l) => l.id)).size, LOOKS.length);
  assert.ok(LOOKS.length >= 14 && EFFECTS.length >= 13);
});

test("D136: projects with looks and effects validate; a wrong look or param is refused; old projects are unchanged", async () => {
  const modules = await loadModules("spec/modules/builtin");
  const all: Item["effects"] = [
    { module: "effect.look", params: { look: "teal-orange", intensity: 0.7 } },
    { module: "effect.color", params: { exposure: 0.4, vibrance: -0.2 } },
    ...EFFECTS.map((e) => ({ module: e.id, ...(e.params.length ? { params: Object.fromEntries(e.params.map((p) => [p.key, p.default])) } : {}) })),
  ];
  assert.deepEqual(validateProject(project(all), modules), []);
  assert.ok(validateProject(project([{ module: "effect.look", params: { look: "sparkly" } }]), modules).length > 0, "unknown look");
  assert.deepEqual(
    validateProject(project([{ module: "effect.look", params: { look: "plugin.x.y", custom: { mono: 1 }, label: "Y" } }]), modules),
    [],
    "a custom look carries its definition",
  );
  assert.ok(validateProject(project([{ module: "effect.blur", params: { amount: 500 } }]), modules).length > 0, "out of range");
  assert.ok(validateProject(project([{ module: "effect.color", params: { glow: 1 } }]), modules).length > 0, "unknown Adjust param");
  // The examples (drone-weekend's effect.color temperature and effect.stabilize) still open.
  for (const name of ["drone-weekend", "drone-montage", "close-the-loop"])
    assert.deepEqual(validateProject(json(`spec/examples/${name}.uncut/project.json`), modules), [], name);
  // A clip without effects compiles to nothing; stabilize alone draws nothing.
  assert.equal(clipFx(project().tracks[0]!.items[0]!), undefined);
  assert.equal(clipFx({ type: "clip", effects: [{ module: "effect.stabilize", params: { smoothness: 0.5 } }] }), undefined);
});

test("D136: colour maths: neutral is the identity, intensity mixes, B&W is grey, invert flips; the table reads back as trilinear", () => {
  const id = colourFn({});
  for (const c of [
    [0, 0, 0],
    [1, 1, 1],
    [0.2, 0.5, 0.9],
    [0.73, 0.11, 0.4],
  ] as const)
    assert.deepEqual(id(c[0], c[1], c[2]), c);
  const warm = LOOKS.find((l) => l.id === "warm")!.def;
  assert.deepEqual(colourFn({ look: { def: warm, intensity: 0 } })(0.3, 0.5, 0.7), [0.3, 0.5, 0.7]);
  const full = colourFn({ look: { def: warm, intensity: 1 } })(0.5, 0.5, 0.5);
  const half = colourFn({ look: { def: warm, intensity: 0.5 } })(0.5, 0.5, 0.5);
  assert.ok(full[0] > full[2] + 0.05, `warm is warmer: ${full}`);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(half[i]! - (0.5 + full[i]!) / 2) < 1e-9);
  const bw = colourFn({ look: { def: LOOKS.find((l) => l.id === "bw")!.def, intensity: 1 } })(0.9, 0.2, 0.1);
  assert.ok(Math.abs(bw[0] - bw[1]) < 1e-9 && Math.abs(bw[1] - bw[2]) < 1e-9);
  assert.deepEqual(colourFn({ invert: true })(0, 0.25, 1), [1, 0.75, 0]);
  // Every look changes a colourful set of pixels, and they differ from each other.
  const probe = [
    [0.8, 0.3, 0.2],
    [0.2, 0.6, 0.9],
    [0.5, 0.5, 0.5],
    [0.1, 0.1, 0.15],
    [0.95, 0.9, 0.8],
  ] as const;
  const sig = LOOKS.map((l) =>
    probe
      .map((p) =>
        colourFn({ look: { def: l.def, intensity: 1 } })(p[0], p[1], p[2])
          .map((v) => v.toFixed(3))
          .join(","),
      )
      .join(";"),
  );
  assert.equal(new Set(sig).size, LOOKS.length, "each look looks different");
  assert.ok(!sig.includes(probe.map((p) => p.map((v) => v.toFixed(3)).join(",")).join(";")), "no look is the identity");
  // Adjust: exposure brightens, saturation −1 is grey, temperature warms.
  assert.ok(colourFn({ adjust: { ...nil(), exposure: 1 } })(0.4, 0.4, 0.4)[0] > 0.5);
  const grey = colourFn({ adjust: { ...nil(), saturation: -1 } })(0.9, 0.1, 0.3);
  assert.ok(Math.abs(grey[0] - grey[1]) < 1e-9);
  // The table: grid points are the function; between them, trilinear.
  const spec = { look: { def: LOOKS.find((l) => l.id === "film")!.def, intensity: 0.8 }, adjust: { ...nil(), contrast: 0.2 } };
  const lut = colourLut(spec);
  const fn = colourFn(spec);
  assert.equal(lut.data.length, 33 ** 3 * 3);
  assert.equal(colourLut(spec), lut, "cached");
  for (const [r, g, b] of [
    [0, 0, 0],
    [16, 8, 31],
    [32, 32, 32],
  ])
    assert.deepEqual(
      [...lutAt(lut, r! / 32, g! / 32, b! / 32)].map((v) => v.toFixed(5)),
      [...fn(r! / 32, g! / 32, b! / 32)].map((v) => v.toFixed(5)),
    );
  let worst = 0;
  for (let i = 0; i < 500; i++) {
    const c = [Math.random(), Math.random(), Math.random()] as const;
    const a = lutAt(lut, ...c);
    const e = fn(...c);
    worst = Math.max(worst, ...a.map((v, k) => Math.abs(v - e[k]!)));
  }
  assert.ok(worst < 0.02, `the 33³ table is within 2% of the function (${worst.toFixed(4)})`);
  const cube = cubeText(lut).split("\n");
  assert.equal(cube[1], "LUT_3D_SIZE 33");
  assert.equal(cube.filter((l) => /^[\d.]+ [\d.]+ [\d.]+$/.test(l)).length, 33 ** 3);
  // Posterize: flat bands, the top value in the top band.
  assert.deepEqual(
    [0, 0.19, 0.2, 0.5, 0.99, 1].map((v) => posterize(v, 5)),
    [0, 0, 0.25, 0.5, 1, 1],
  );
});

const nil = () => ({ exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, vibrance: 0 });

test("D136: a clip's effects compile in a fixed order; bypassed ones and other items draw nothing", () => {
  const fx = clipFx({
    type: "clip",
    effects: [
      { module: "effect.invert" },
      { module: "effect.sharpen", params: { amount: 0.61 } },
      { module: "effect.blur", params: { amount: 4 }, bypass: true },
      { module: "effect.vignette" },
      { module: "effect.zoom-pulse" },
    ],
  })!;
  assert.deepEqual(fx.colour, { invert: true });
  assert.equal(fx.sharpen, 10 / 16, "sharpen in 1/16 steps (the export's convolution)");
  assert.equal(fx.blur, undefined, "bypassed");
  assert.deepEqual(fx.vignette, { amount: 0.5, size: 0.5 });
  assert.deepEqual(fx.pulse, { amount: 0.08, period: 1 });
  assert.ok(needsPicturePass(fx) && hasOverlay(fx));
  assert.equal(needsPicturePass(clipFx({ type: "clip", effects: [{ module: "effect.vignette" }] })), false);
  assert.equal(clipFx({ type: "text", effects: [{ module: "effect.invert" }] } as unknown as Item), undefined);
  // The size effects work at: the picture's fit in its box, before zoom.
  const box = clipBox({ transform: { w: 640, h: 640, fit: "contain", scale: 1.5 } }, { width: 1280, height: 720 }, { width: 1280, height: 720 }, 0);
  assert.deepEqual(fxPictureSize(box, { width: 1280, height: 720 }), { w: 640, h: 360 });
});

test("D136: planners: one look per clip, Adjust patches and resets, effects added once and tuned, removals; locked and audio refused; History words", () => {
  let p = project();
  const apply = (plan: ReturnType<typeof planSetLook>) => {
    if ("problem" in plan) throw new Error(plan.problem);
    p = applyEdit(createSession(p), { actor: "user", ops: plan.ops as ReadonlyArray<Op> }).project;
    return plan;
  };
  assert.equal(apply(planSetLook(p, "c1", "warm")).summary, "Filter Warm on A.mp4");
  assert.equal(apply(planSetLook(p, "c1", "warm", { intensity: 0.8 })).summary, "Set Warm on A.mp4 to 80%");
  apply(planSetLook(p, "c1", "noir"));
  assert.deepEqual(
    p.tracks[0]!.items[0]!.effects,
    [{ module: "effect.look", params: { look: "noir", intensity: 1 } }],
    "replaced, intensity back to full for another look",
  );
  assert.equal(apply(planAdjust(p, "c1", { exposure: 0.35 })).summary, "Set exposure of A.mp4 to +0.35 EV");
  apply(planAdjust(p, "c1", { saturation: -0.2 }));
  assert.deepEqual(p.tracks[0]!.items[0]!.effects![1], { module: "effect.color", params: { exposure: 0.35, saturation: -0.2 } });
  assert.equal(apply(planEffect(p, "c1", "effect.vignette")).summary, "Add vignette to A.mp4");
  assert.ok("problem" in planEffect(p, "c1", "effect.vignette"), "already there");
  assert.equal(apply(planEffect(p, "c1", "effect.vignette", { amount: 0.8 })).summary, "Set vignette amount on A.mp4 to 0.8");
  apply(planEffect(p, "c1", "effect.mirror"));
  assert.deepEqual(p.tracks[0]!.items[0]!.effects!.at(-1), { module: "effect.mirror" }, "no params for an effect without settings");
  assert.equal(fxWords(p.tracks[0]!.items[0]!.effects), "filter Noir 100%, exposure +0.35 EV, saturation -20, vignette 0.8, mirror");
  const op: Op = { op: "update_item", item: "c1", set: { effects: p.tracks[0]!.items[0]!.effects } } as Op;
  assert.match(describeOp(op, p), /filter Noir 100%, exposure \+0\.35 EV/);
  assert.equal(apply(planAdjust(p, "c1", "reset")).summary, "Reset the adjustments of A.mp4");
  assert.ok(!p.tracks[0]!.items[0]!.effects!.some((e) => e.module === "effect.color"), "a neutral Adjust is removed");
  apply(planRemoveEffect(p, "c1", "effect.vignette"));
  apply(planSetLook(p, "c1", undefined));
  apply(planRemoveEffect(p, "c1", "effect.mirror"));
  assert.equal(p.tracks[0]!.items[0]!.effects, undefined, "the field goes when the last effect does");
  assert.ok("problem" in planSetLook(p, "s1", "warm"), "not on sound");
  assert.ok("problem" in planSetLook(p, "nope", "warm"));
  assert.ok("problem" in planSetLook(p, "c1", "sparkly"));
  const locked = project(undefined, { locked: true });
  assert.ok("problem" in planEffect(locked, "c1", "effect.blur"));
});

test("D136: zoom pulse is the box's zoom frame by frame (visualsAt), shake stays inside and its ffmpeg form is the same number", () => {
  const pulse = { amount: 0.1, period: 1 };
  assert.equal(pulseZoom(pulse, 0), 1);
  assert.ok(Math.abs(pulseZoom(pulse, 0.5) - 1.1) < 1e-12);
  const p = project([{ module: "effect.zoom-pulse", params: { amount: 0.1, period: 1 } }]);
  const at = (f: number) => visualsAt(p, layout(p).starts, f)[0]!.box!;
  assert.equal(at(0).scale, 1);
  assert.ok(Math.abs(at(15).scale - 1.1) < 1e-9, `half a period in: ${at(15).scale}`);
  assert.equal(at(15).w, 1280, "the box keeps its size; the picture zooms in it");
  const b0 = at(0);
  assert.equal(fxBox({ type: "clip" }, b0, 15, 30), b0);
  const shake = { amount: 12, speed: 3 };
  for (let i = 0; i < 300; i++) {
    const t = i / 30;
    const o = shakeAt(shake, t);
    assert.ok(Math.abs(o.dx) <= 12 && Math.abs(o.dy) <= 12);
    const w = shakeWindow(shake, t, 640, 360, 680, 383);
    assert.ok(w.x >= 0 && w.x <= 40 && w.y >= 0 && w.y <= 23);
    // ffmpeg's expression (sin and arithmetic) evaluated here gives the same offset.
    const js = (e: string) => Function(`return ${e.replace(/sin\(/g, "Math.sin(")}`)() as number;
    assert.ok(Math.abs(js(shakeExpr(shake, "x", String(t), 0.5)) - o.dx * 0.5) < 1e-6);
    assert.ok(Math.abs(js(shakeExpr(shake, "y", String(t), 1)) - o.dy) < 1e-6);
  }
});

test("D136: overlays: vignette, grain (a new pattern every few frames, cycling) and letterbox bars sized to the ratio, in the picture's visible part", () => {
  const fx = clipFx({
    type: "clip",
    effects: [{ module: "effect.vignette" }, { module: "effect.letterbox", params: { ratio: 2.4 } }, { module: "effect.grain" }],
  })!;
  const html = fxOverlayInner(fx, { x: 0, y: 0, w: 1280, h: 720 }, 0);
  assert.match(html, /radial-gradient\(ellipse farthest-corner/);
  assert.match(html, /height:93\.333px;background:#000/, "(720 − 1280/2.4) / 2");
  const phases = Array.from(
    { length: GRAIN_STATES * GRAIN_HOLD * 2 },
    (_, f) => /seed="(\d)"/.exec(fxOverlayInner(fx, { x: 0, y: 0, w: 1280, h: 720 }, f))?.[1],
  );
  assert.equal(new Set(phases).size, GRAIN_STATES);
  assert.equal(phases[0], phases[1]);
  assert.notEqual(phases[0], phases[GRAIN_HOLD]);
  assert.equal(phases[0], phases[GRAIN_STATES * GRAIN_HOLD]);
  assert.equal(fxOverlayInner(clipFx({ type: "clip", effects: [{ module: "effect.blur" }] })!, { x: 0, y: 0, w: 10, h: 10 }, 0), "");
  // A contained 4:3 picture in a 16:9 box: the overlay covers the picture, not the bars.
  const box = clipBox({}, { width: 1280, height: 720 }, { width: 640, height: 480 }, 0);
  assert.deepEqual(visibleRect(box), { x: 160, y: 0, w: 960, h: 720 });
  assert.match(
    fxOverlayHtml(fx, box, 0),
    /^<div style="position:absolute;left:0px;top:0px;width:1280px;height:720px;overflow:hidden"><div class="pv-fx" style="position:absolute;left:160px/,
  );
});

test("D136: a plugin's filters (contributes.filters): schema-checked, namespaced, carried as a custom look", () => {
  const manifest = {
    manifest: "uncut.module/0",
    id: "acme.looks",
    kind: "pack",
    name: "Acme looks",
    version: "1.0.0",
    runtime: { type: "data" },
    contributes: {
      filters: [
        { id: "acme.looks.dusk", name: "Dusk", look: { adjust: { temperature: 0.4, exposure: -0.2 }, shadowTint: { color: [0.2, 0.1, 0.5], amount: 0.2 } } },
        { id: "other.pack.dusk", name: "Stolen", look: { mono: 1 } },
      ],
    },
  };
  assert.deepEqual(validateModule(manifest), []);
  assert.ok(
    validateModule({ ...manifest, contributes: { filters: [{ id: "acme.looks.bad", name: "Bad", look: { glow: 3 } }] } }).length > 0,
    "unknown look field",
  );
  const read = readContributions(manifest as unknown as ModuleManifest, { reserved: new Set(), moves: new Set() });
  assert.deepEqual(
    read.contributions.filters.map((f) => f.id),
    ["acme.looks.dusk"],
  );
  assert.equal(read.warnings.length, 1);
  const plan = planSetLook(project(), "c1", "acme.looks.dusk", { custom: read.contributions.filters[0]!.look, label: "Dusk" });
  assert.ok("ops" in plan);
  const effects = (plan.ops[0]!.set as { effects: Item["effects"] }).effects;
  assert.equal(fxWords(effects), "filter Dusk 100%");
  assert.ok(clipFx({ type: "clip", effects })!.colour?.look, "drawn from the clip alone");
});

test("D138: SVG stills take no looks or effects: the planners refuse them and a pulse doesn't zoom them (the export draws SVGs with Chromium)", () => {
  const p = project();
  const svg: Project = {
    ...p,
    media: [...p.media, { id: "m-svg", kind: "image", name: "Logo.svg", path: "/logo.svg", probe: { width: 1280, height: 720 } }],
    tracks: [
      {
        ...p.tracks[0]!,
        items: [{ id: "c1", type: "clip", media: "m-svg", duration: 90, effects: [{ module: "effect.zoom-pulse", params: { amount: 0.1, period: 1 } }] }],
      },
    ],
  };
  assert.ok(fxSkips(svg.media[2]) && !fxSkips(svg.media[0]));
  for (const plan of [planSetLook(svg, "c1", "warm"), planEffect(svg, "c1", "effect.blur"), planAdjust(svg, "c1", { exposure: 1 })])
    assert.ok("problem" in plan && /SVG/.test(plan.problem));
  assert.equal(visualsAt(svg, layout(svg).starts, 15)[0]!.box!.scale, 1);
});
