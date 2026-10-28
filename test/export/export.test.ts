// Phase 4 chunk 6 (D34, D39, D54, D55): export as a server job.
// - The plan's maths against core: every layer's frames, opacity, source time and text motion are
//   visualsAt's; every sound's gain is audibleAt's; the gain expression ffmpeg evaluates matches.
// - On the bundled server with ffmpeg-made media: an export probes right (size, fps, length, an
//   audio stream), shows the source frame it should, and its sound has the levels core expects;
//   loudness normalisation lands on its target; a silent project gets a silent track; an existing
//   file is only replaced when asked; missing media is a clear error; cancelling (while drawing
//   text, or mid-render) leaves no ffmpeg, no rasteriser, no temp files and no partial output.
// - The agent's render_frames returns JPEGs that match the export's frames.
// - The user's DJI clip (when present) exports at 4K and matches the source frame (SSIM).
// SSIM against what the preview draws is in export-app.test.ts (the packaged app).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  audibleAt,
  baseBox,
  canvasBox,
  irisRadius,
  componentBox,
  componentHtml,
  isDrawnComponent,
  isPlainBox,
  layout,
  moveBox,
  textHtml,
  visualsAt,
} from "../../packages/core/src/index.ts";
import type { Item, Project } from "../../packages/core/src/timeline/types.ts";
import type { Visual } from "../../packages/core/src/timeline/timeline.ts";
import {
  alphaAt,
  AUDIO_BLOCK,
  exportCommand,
  rasterLooks,
  silentFailure,
  frameLookup,
  gainAt,
  gainExpr,
  graphFileArgs,
  irisAt,
  outputSize,
  placementOf,
  planExport,
  rampsAt,
  wipeAt,
  type GainModel,
  type VisualLayer,
} from "../../apps/server/src/export/exportPlan.ts";
import { CLIP_POINTS, expectedClipColour, makeClipMedia, splitProject } from "../helpers/clip-fixture.ts";
import {
  close as closeColour,
  COLOUR_CHECKS,
  expectedAt,
  expectedColour,
  makeTransitionMedia,
  MOVE_CHECKS,
  movesProject,
  rampWipeProject,
  transitionProject,
  type Rgb,
} from "../helpers/transition-fixture.ts";
import { rasterizerCommand } from "../../apps/server/src/export/rasterizer.ts";
import { sweepStaleTemp } from "../../apps/server/src/export/exporter.ts";
import { demoProject, FOOTAGE, skipDemo } from "../helpers/demo.ts";
import { exportProject, FPS, makeExportFixture, writeProject } from "../helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, projectCopy, startServer } from "../helpers/server.ts";
import { until } from "../helpers/wait.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skipFfmpeg = hasFfmpeg ? false : "needs ffmpeg";
const skipServer =
  !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(DESKTOP) || !existsSync(MCP)
    ? "server, desktop or media core not built (run pnpm build)"
    : skipFfmpeg;

// ---- the plan against core (no processes) ----

/** The fixture plus the awkward cases: an odd transition (half frames), speed, every move in and out. */
function trickyProject(): Project {
  const p = exportProject("/nowhere");
  const tracks = p.tracks.map((t) => {
    if (t.id === "main")
      return {
        ...t,
        items: [
          {
            id: "card",
            type: "component" as const,
            component: "component.solid",
            duration: 45,
            props: { color: "#123" },
            animation: { out: { module: "move.fade", duration: 15 } },
          },
          { id: "a1", type: "clip" as const, media: "m-a", in: 10, duration: 60, speed: 1.5, animation: { in: { module: "move.rise", duration: 9 } } },
          {
            id: "b",
            type: "clip" as const,
            media: "m-b",
            in: 15,
            duration: 50,
            transitionIn: { module: "transition.crossfade", duration: 15 },
            animation: { out: { module: "move.slide-left", duration: 11 } },
          },
          { id: "a2", type: "clip" as const, media: "m-a", in: 120, duration: 40, transitionIn: { module: "transition.crossfade", duration: 9 } },
        ],
      };
    if (t.id === "text")
      return {
        ...t,
        items: [
          {
            id: "t1",
            type: "text" as const,
            start: 3,
            duration: 40,
            text: "Rise",
            animation: { in: { module: "move.rise", duration: 12 }, out: { module: "move.wipe", duration: 10 } },
          },
          {
            id: "t2",
            type: "text" as const,
            start: 60,
            duration: 30,
            text: "Slide",
            style: { preset: "text.header" },
            animation: { in: { module: "move.slide-left", duration: 8 }, out: { module: "move.fade", duration: 30 } },
          },
          {
            id: "t3",
            type: "text" as const,
            start: 100,
            duration: 50,
            text: "Wipe",
            animation: { in: { module: "move.wipe", duration: 14 }, out: { module: "move.rise", duration: 7 } },
          },
        ],
      };
    if (t.id === "overlay")
      return {
        ...t,
        items: [
          ...t.items,
          { id: "end-card", type: "component" as const, component: "component.end-card", start: 150, duration: 20 },
          { id: "logo", type: "graphic" as const, src: "logo.svg", start: 175, duration: 10 },
        ],
      };
    if (t.id === "audio")
      return {
        ...t,
        mixer: { gainDb: -3 },
        items: [
          {
            id: "music",
            type: "audio" as const,
            media: "m-music",
            in: 30,
            start: 5,
            duration: 200,
            gainDb: 2,
            fadeIn: 17,
            fadeOut: 23,
            gainKeys: [
              { frame: 0, db: -70 },
              { frame: 40, db: 0 },
              { frame: 40, db: -6 },
              { frame: 120, db: 3 },
            ],
          },
        ],
      };
    return t;
  });
  return { ...p, tracks };
}

/**
 * What the export draws of what visualsAt lists, as the preview draws it: clips of video or image
 * media, backgrounds (component.solid) and text. Deliberately not drawn (in neither): graphics,
 * captions and other components.
 */
const drawn = (project: Project, v: Visual) => {
  const media = v.item.media ? project.media.find((m) => m.id === v.item.media) : undefined;
  // Components the registry draws (D76) too; a graphic only with a readable file (none here: its src isn't one).
  return (
    (v.item.type === "clip" && media !== undefined && media.kind !== "audio") ||
    (v.item.type === "component" && (v.item.component === "component.solid" || isDrawnComponent(v.item))) ||
    (v.item.type === "text" && typeof v.item.text === "string")
  );
};

/** The fixture's main track with every drawn transition (D73) and odd lengths: a dip into a clip with a fade, a wipe into a background. */
function transitionsProject(): Project {
  const p = exportProject("/nowhere");
  const tracks = p.tracks.map((t) =>
    t.id === "main"
      ? {
          ...t,
          items: [
            { id: "a1", type: "clip" as const, media: "m-a", in: 0, duration: 60, fadeOut: 20, animation: { out: { module: "move.fade", duration: 10 } } },
            {
              id: "b",
              type: "clip" as const,
              media: "m-b",
              in: 0,
              duration: 50,
              fadeIn: 10,
              transitionIn: { module: "transition.dip-to-black", duration: 15 },
            },
            { id: "a2", type: "clip" as const, media: "m-a", in: 120, duration: 40, transitionIn: { module: "transition.wipe", duration: 11 } },
            {
              id: "card",
              type: "component" as const,
              component: "component.solid",
              duration: 40,
              props: { color: "#123" },
              transitionIn: { module: "transition.wipe", duration: 8 },
            },
            { id: "a3", type: "clip" as const, media: "m-a", in: 200, duration: 50, transitionIn: { module: "transition.crossfade", duration: 7 } },
          ],
        }
      : t,
  );
  return { ...p, tracks };
}

/**
 * Boxed clips (D75): a cover box with rounded corners zooming (eased) and fading by keys, a looped
 * clip in a box wiped in from a crossfaded one, a still moving across the frame, a plain clip with
 * only an opacity, odd sizes and an odd output scale.
 */
function boxesProject(): Project {
  const p = exportProject("/nowhere");
  const tracks = p.tracks.map((t) => {
    if (t.id === "main")
      return {
        ...t,
        items: [
          {
            id: "a1",
            type: "clip" as const,
            media: "m-a",
            in: 0,
            duration: 60,
            transform: { x: 101, y: 51, w: 799, fit: "cover" as const, radius: 21 },
            keys: [
              { frame: 0, scale: 1, ease: "out" as const },
              { frame: 40, scale: 1.37, opacity: 1 },
              { frame: 59, opacity: 0.4 },
            ],
          },
          {
            id: "b",
            type: "clip" as const,
            media: "m-c",
            in: 10,
            duration: 200,
            loop: true,
            transform: { x: 0, w: 960.5, opacity: 0.7 },
            transitionIn: { module: "transition.wipe", duration: 10 },
          },
          {
            id: "a2",
            type: "clip" as const,
            media: "m-a",
            in: 40,
            duration: 40,
            transform: { opacity: 0.5 },
            transitionIn: { module: "transition.crossfade", duration: 9 },
          },
        ],
      };
    if (t.id === "overlay")
      return {
        ...t,
        items: [
          {
            id: "still",
            type: "clip" as const,
            media: "m-still",
            start: 20,
            duration: 100,
            transform: { x: 1500, y: 50, w: 333, fit: "contain" as const, radius: 30 },
            keys: [
              { frame: 0, x: 1500, ease: "inOut" as const },
              { frame: 60, x: 40, y: 700 },
            ],
          },
        ],
      };
    return t;
  });
  return { ...p, tracks };
}

/**
 * Iris, push and zoom (D79) into and out of every kind of item: a plain clip pushed out by a boxed
 * one, an iris into a background, the background zoomed out under a clip, a clip pushed out by a
 * text, an iris into a component, the component zoomed out, an iris into a looped clip; odd
 * lengths and an odd output scale.
 */
function movesPlanProject(): Project {
  const p = exportProject("/nowhere");
  const tracks = p.tracks.map((t) =>
    t.id === "main"
      ? {
          ...t,
          items: [
            { id: "a1", type: "clip" as const, media: "m-a", in: 0, duration: 40 },
            {
              id: "b",
              type: "clip" as const,
              media: "m-b",
              in: 20,
              duration: 40,
              transform: { x: 101, y: 51, w: 640, radius: 12 },
              transitionIn: { module: "transition.push-left", duration: 20 },
            },
            {
              id: "card",
              type: "component" as const,
              component: "component.solid",
              duration: 30,
              props: { color: "#123" },
              transitionIn: { module: "transition.iris", duration: 15 },
            },
            { id: "a2", type: "clip" as const, media: "m-a", in: 120, duration: 30, transitionIn: { module: "transition.zoom", duration: 11 } },
            { id: "t", type: "text" as const, text: "Pushed", duration: 30, transitionIn: { module: "transition.push-left", duration: 9 } },
            { id: "end", type: "component" as const, component: "component.end-card", duration: 30, transitionIn: { module: "transition.iris", duration: 12 } },
            { id: "a3", type: "clip" as const, media: "m-a", in: 200, duration: 30, transitionIn: { module: "transition.zoom", duration: 10 } },
            { id: "c", type: "clip" as const, media: "m-c", in: 10, duration: 150, loop: true, transitionIn: { module: "transition.iris", duration: 7 } },
          ],
        }
      : t,
  );
  return { ...p, tracks };
}

for (const [name, project, size] of [
  ["fixture", exportProject("/nowhere"), [1920, 1080]],
  ["tricky", trickyProject(), [1920, 1080]],
  ["transitions", transitionsProject(), [1920, 1080]],
  ["boxes", boxesProject(), [1278, 718]],
  ["moves", movesPlanProject(), [1278, 718]],
] as const) {
  test(`export plan (${name}): layers, opacity, source time, motion and boxes are visualsAt's, in its order`, () => {
    const [width, height] = size;
    const plan = planExport(project, { mediaPath: (m) => m.path, width, height });
    if ("problem" in plan) throw new Error(plan.problem);
    const { starts, duration } = layout(project);
    assert.equal(plan.frames, duration);
    for (let f = 0; f < duration; f++) {
      const seen: Array<Visual> = visualsAt(project, starts, f).filter((v) => drawn(project, v));
      const layers: Array<VisualLayer> = plan.visuals.filter((l) => f >= l.f0 && f < l.f1);
      assert.deepEqual(
        layers.map((l) => l.item.id),
        seen.map((v) => v.item.id),
        `frame ${f}: drawn layers in order`,
      );
      for (const [i, l] of layers.entries()) {
        const v = seen[i]!;
        const opacity = rampsAt(l.ramps, f) * alphaAt(l, f);
        assert.ok(Math.abs(opacity - v.opacity) < 1e-9, `${l.item.id} at ${f}: opacity ${opacity} vs ${v.opacity}`);
        const kx = width / project.canvas.width;
        const ky = height / project.canvas.height;
        if (l.kind === "video" || l.kind === "image") {
          // The box (D75; moved by a push or zoom, D79): a layer without geometry is the plain full frame; one with it is core's box in output pixels.
          if (!l.geometry) assert.ok(isPlainBox(v.box!, project.canvas), `${l.item.id} at ${f}: drawn plain but core has a box`);
          else {
            const media = project.media.find((m) => m.id === l.item.media)!;
            assert.deepEqual(
              l.geometry.frames[f - l.f0],
              placementOf(v.box!, kx, ky, baseBox(l.item, project.canvas, media.probe)),
              `${l.item.id} at ${f}: box`,
            );
          }
        } else if (isDrawnComponent(l.item) && l.kind === "raster") {
          // A component's box (pushed or zoomed, D79) is drawn into its HTML, as the preview draws it.
          assert.equal(l.geometry, undefined);
          const own = componentBox(l.item, project.canvas, f - layout(project).starts.get(l.item.id)!)!;
          assert.equal(
            l.states[l.frames[f - l.f0]!],
            componentHtml(l.item, project, f - layout(project).starts.get(l.item.id)!, { opacity: own.opacity, motion: v.motion, fps: FPS, box: v.box! }),
            `${l.item.id} at ${f}: look`,
          );
        } else {
          // Text, backgrounds and graphics: a push or zoom moves the canvas (D79).
          const moved = v.shift !== undefined || v.zoom !== undefined;
          if (!l.geometry) assert.ok(!moved, `${l.item.id} at ${f}: core moves it, the plan doesn't`);
          else
            assert.deepEqual(
              l.geometry.frames[f - l.f0],
              placementOf(moveBox(canvasBox(project.canvas), v.shift, v.zoom), kx, ky, canvasBox(project.canvas)),
              `${l.item.id} at ${f}: moved canvas`,
            );
        }
        assert.ok(Math.abs(wipeAt(l.wipe, f) - (v.wipe ?? 1)) < 1e-9, `${l.item.id} at ${f}: wipe ${wipeAt(l.wipe, f)} vs ${v.wipe}`);
        assert.ok(Math.abs(irisAt(l.iris, f) - (v.iris ?? 1)) < 1e-9, `${l.item.id} at ${f}: iris ${irisAt(l.iris, f)} vs ${v.iris}`);
        if (l.kind === "video") assert.ok(Math.abs(l.source + ((f - l.f0) * l.speed) / FPS - v.source) < 1e-9, `${l.item.id} at ${f}: source time`);
        if (l.kind === "raster" && l.item.type === "text")
          assert.equal(l.states[l.frames[f - l.f0]!], textHtml(l.item, project, { motion: v.motion }), `${l.item.id} at ${f}: look`);
      }
    }
  });

  test(`export plan (${name}): every sound's gain is audibleAt's`, () => {
    const plan = planExport(project, { mediaPath: (m) => m.path, width: 1920, height: 1080 });
    if ("problem" in plan) throw new Error(plan.problem);
    const { starts, duration } = layout(project);
    for (let f = 0; f < duration; f += 0.25) {
      const heard = audibleAt(project, starts, f).filter((a) => a.gain > 0);
      for (const a of heard) {
        const layer = plan.audio.find((l) => l.item.id === a.item.id);
        assert.ok(layer, `${a.item.id} sounds at ${f} but isn't in the plan`);
        assert.ok(f >= layer.from && f < layer.to, `${a.item.id} at ${f} is outside its span`);
        const local = f - starts.get(a.item.id)!;
        assert.ok(Math.abs(gainAt(layer.gain, local) - a.gain) < 1e-9, `${a.item.id} at ${f}: gain ${gainAt(layer.gain, local)} vs ${a.gain}`);
        assert.ok(Math.abs(layer.source + ((f - layer.from) * layer.speed) / FPS - a.source) < 1e-6, `${a.item.id} at ${f}: source time`);
      }
    }
  });
}

test("export plan (boxes): keyed boxes, loops in passes, the wipe on a box, and the per-frame lookups ffmpeg evaluates", () => {
  const project = boxesProject();
  const plan = planExport(project, { mediaPath: (m) => m.path, width: 1278, height: 718 });
  if ("problem" in plan) throw new Error(plan.problem);
  const of = (id: string) => plan.visuals.filter((l) => l.item.id === id);
  // b (m-c: 120 frames) at 60 from in 10 for 200 frames, wiped in over [55, 65), crossfading out
  // into a2 until 264.5: the wipe's frames, the rest of the first pass, then the media again from 0.
  assert.deepEqual(
    of("b").map((l) => [l.f0, l.f1, !!l.wipe, l.kind === "video" ? Math.round(l.source * FPS) : -1]),
    [
      [55, 65, true, 5],
      [65, 170, false, 15],
      [170, 265, false, 0],
    ],
  );
  // The box's size never changes in a layer; a cover picture covers it at every frame.
  for (const l of plan.visuals) {
    if ((l.kind !== "video" && l.kind !== "image") || !l.geometry) continue;
    const [p0] = l.geometry.frames;
    for (const p of l.geometry.frames) {
      assert.ok(p.w === p0!.w && p.h === p0!.h && p.radius === p0!.radius, `${l.item.id}: one box size`);
      if (l.item.transform?.fit === "cover") assert.ok(p.cx <= 0 && p.cy <= 0 && p.cx + p.cw >= p.w && p.cy + p.ch >= p.h, `${l.item.id}: covered`);
    }
  }
  // Two boxes that share an edge meet on one pixel at any output scale (no seam, no overlap).
  for (const k of [1, 0.6667, 0.5, 1.37]) {
    const left = placementOf({ x: 0, y: 0, w: 640.4, h: 720, fit: "fill", scale: 1, opacity: 1, radius: 0, content: { x: 0, y: 0, w: 640.4, h: 720 } }, k, k);
    const right = placementOf(
      { x: 640.4, y: 0, w: 639.6, h: 720, fit: "fill", scale: 1, opacity: 1, radius: 0, content: { x: 640.4, y: 0, w: 639.6, h: 720 } },
      k,
      k,
    );
    assert.equal(left.x + left.w, right.x, `scale ${k}`);
    assert.equal(right.x + right.w, Math.round(1280 * k));
  }
  // The ffmpeg graph builds (keyed sizes, positions and opacity are expressions and commands).
  const rasters = new Map(plan.visuals.filter((l) => l.kind === "raster").map((l) => [l, { kind: "still" as const, png: "/x.png" }]));
  const { graph } = exportCommand(plan, {
    background: "/bg.png",
    rasters,
    caps: { encoders: new Set(), videotoolboxDecode: false, major: 8 },
    quality: "draft",
    output: "/out.mp4",
  });
  assert.match(graph, /scale=w='st\(9,floor\(t\*30\+0\.5\)\);if\(lt/);
  assert.match(graph, /sendcmd=c='/);
  assert.match(graph, /alphamerge/);
  assert.match(graph, /repeatlast=0:x='st\(9,floor\(t\*30\+0\.5\)-20\)/);
});

/** Evaluates the subset of ffmpeg's expression language frameLookup writes (st, ld, if, lt, numbers). */
test("export plan (D79 review): slices keep only their own looks (one look: a still), looks are drawn once across layers, a long loop stays one looped input, a boxed push isn't cut", () => {
  const p = exportProject("/nowhere");
  const main = (items: Array<Item>): Project => ({
    ...p,
    media: [
      ...p.media,
      { id: "m-short", kind: "video", name: "Short.mp4", path: "/short.mp4", probe: { frames: 150, fps: 30, width: 640, height: 360, hasAudio: false } },
    ],
    tracks: p.tracks.map((t) => (t.id === "main" ? { ...t, items } : t)),
  });
  const project = main([
    { id: "a1", type: "clip", media: "m-a", in: 30, duration: 60 },
    // A terminal typing, revealed by an iris and pushed out: cut at the iris's end only (its box is in its HTML).
    { id: "term", type: "component", component: "component.terminal", duration: 90, transitionIn: { module: "transition.iris", duration: 20 } },
    // A text pushed in and out: the canvas moves, so three slices; its look never changes.
    { id: "t", type: "text", text: "Pushed", duration: 60, transitionIn: { module: "transition.push-left", duration: 20 } },
    // A boxed clip pushed in and zoomed out: its geometry is needed throughout, so it isn't cut.
    {
      id: "b",
      type: "clip",
      media: "m-b",
      in: 30,
      duration: 60,
      transform: { x: 100, y: 50, w: 640 },
      transitionIn: { module: "transition.push-left", duration: 20 },
    },
    // 150 frames of media looped over 3000 frames, pushed in and zoomed out.
    { id: "loop", type: "clip", media: "m-short", in: 0, duration: 3000, loop: true, transitionIn: { module: "transition.zoom", duration: 20 } },
    { id: "a2", type: "clip", media: "m-a", in: 30, duration: 60, transitionIn: { module: "transition.zoom", duration: 20 } },
  ]);
  const withPush = main(
    project.tracks
      .find((t) => t.id === "main")!
      .items.map((i) => (i.id === "loop" ? { ...i, transitionIn: { module: "transition.push-left", duration: 20 } } : i)),
  );
  for (const proj of [project, withPush]) {
    const plan = planExport(proj, { mediaPath: (m) => m.path, width: 1920, height: 1080 });
    if ("problem" in plan) throw new Error(plan.problem);
    // Every raster slice's looks are exactly the ones its frames use; one look is drawn as a still.
    for (const l of plan.visuals) {
      if (l.kind !== "raster") continue;
      assert.equal(new Set(l.frames).size, l.states.length, `${l.item.id} ${l.f0}–${l.f1}: unused looks`);
      assert.deepEqual(
        [...new Set(l.frames)].sort((x, y) => x - y),
        l.states.map((_, i) => i),
      );
      assert.equal(new Set(l.states).size, l.states.length, `${l.item.id}: a look twice`);
    }
    const term = plan.visuals.filter((l) => l.item.id === "term");
    assert.deepEqual(
      term.map((l) => [l.f0, l.f1, !!l.iris]),
      [
        [50, 70, true],
        [70, 160, false],
      ],
    );
    const text = plan.visuals.filter((l) => l.item.id === "t");
    assert.deepEqual(
      text.map((l) => [l.f0, l.f1, !!l.geometry, l.kind === "raster" ? l.states.length : -1]),
      [
        [140, 160, true, 1],
        [160, 200, false, 1],
        [200, 220, true, 1],
      ],
    );
    // The rasteriser draws each distinct look once: the terminal's typing, the text, the backgrounds.
    const looks = rasterLooks(plan);
    const all = plan.visuals.flatMap((l) => (l.kind === "raster" ? l.states : []));
    assert.equal(looks.length, new Set(all).size);
    assert.ok(looks.length < all.length, `${looks.length} looks drawn for ${all.length} slice states`);
    // The boxed push: one layer with its geometry, not cut at the push's end or the zoom's start.
    assert.deepEqual(
      plan.visuals.filter((l) => l.item.id === "b").map((l) => [l.f0, l.f1, !!l.geometry]),
      [[200, 280, true]],
    );
    // The long loop: one looped input for its long middle; the transitions' frames seek.
    const loop = plan.visuals.filter((l) => l.item.id === "loop");
    const cycled = loop.filter((l) => l.kind === "video" && l.cycle);
    assert.equal(cycled.length, 1, JSON.stringify(loop.map((l) => [l.f0, l.f1, l.kind === "video" && !!l.cycle])));
    assert.ok(cycled[0]!.f1 - cycled[0]!.f0 > 2900);
    assert.ok(
      loop.every((l) => (l.kind === "video" && l.cycle) || l.f1 - l.f0 <= 20),
      "only short seeked pieces besides the looped one",
    );
  }
});

function evalLookup(expr: string, frame: number): number {
  const slots = new Map<number, number>();
  let i = 0;
  const parse = (): number => {
    if (expr.startsWith("st(", i)) {
      i += 3;
      const slot = Number(/^\d+/.exec(expr.slice(i))![0]);
      i += String(slot).length + 1;
      assert.ok(expr.startsWith("n)", i));
      i += 2;
      slots.set(slot, frame);
      assert.equal(expr[i++], ";");
      return parse();
    }
    if (expr.startsWith("if(lt(ld(", i)) {
      i += 9;
      const slot = Number(/^\d+/.exec(expr.slice(i))![0]);
      i += String(slot).length + 2;
      const bound = Number(/^-?[\d.]+/.exec(expr.slice(i))![0]);
      i += /^-?[\d.]+/.exec(expr.slice(i))![0].length + 2;
      const a = parse();
      i++;
      const b = parse();
      i++;
      return slots.get(slot)! < bound ? a : b;
    }
    const m = /^-?[\d.]+(e-?\d+)?/.exec(expr.slice(i))!;
    i += m[0].length;
    return Number(m[0]);
  };
  return parse();
}

test("frameLookup: the value of every frame, clamped outside, shallow for long keyed runs", () => {
  const values = Array.from({ length: 500 }, (_, f) => (f < 100 ? 7 : Math.round(100 + f * 1.37)));
  const expr = frameLookup(values, "n");
  for (let f = 0; f < 500; f++) assert.equal(evalLookup(expr, f), values[f], `frame ${f}`);
  assert.equal(evalLookup(expr, -3), 7);
  assert.equal(evalLookup(expr, 900), values[499]);
  assert.ok((expr.match(/if\(/g) ?? []).length === 400, "one branch per run boundary");
  let depth = 0;
  let deepest = 0;
  for (const c of expr) (c === "(" ? depth++ : c === ")" && depth--, (deepest = Math.max(deepest, depth)));
  assert.ok(deepest < 40, `nesting ${deepest}`);
  assert.equal(frameLookup([4, 4, 4], "n"), "4");
});

test("export sizes: Draft 720p, Standard 1080p by the shorter side, never upscaled; High is the canvas", () => {
  assert.deepEqual(outputSize({ width: 3840, height: 2160 }, "draft"), { width: 1280, height: 720 });
  assert.deepEqual(outputSize({ width: 3840, height: 2160 }, "standard"), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize({ width: 3840, height: 2160 }, "high"), { width: 3840, height: 2160 });
  assert.deepEqual(outputSize({ width: 1080, height: 1920 }, "draft"), { width: 720, height: 1280 });
  assert.deepEqual(outputSize({ width: 1280, height: 720 }, "standard"), { width: 1280, height: 720 });
  assert.ok(!("problem" in planExport(exportProject("/x"), { mediaPath: (m) => m.path, width: 2, height: 2 })));
  const empty = { ...exportProject("/x"), tracks: exportProject("/x").tracks.map((t) => ({ ...t, items: [] })) };
  assert.match((planExport(empty, { mediaPath: (m) => m.path, width: 2, height: 2 }) as { problem: string }).problem, /empty/);
});

test("the gain expression ffmpeg evaluates matches the gain, block by block", { skip: skipFfmpeg }, () => {
  const models: Array<GainModel> = [
    {
      baseDb: -1,
      keys: [
        { frame: 0, db: -70 },
        { frame: 30, db: 0 },
        { frame: 30, db: -6 },
        { frame: 90, db: 4 },
      ],
      duration: 120,
      half: 0,
      nextHalf: 0,
      fadeIn: 13,
      fadeOut: 21,
    },
    { baseDb: -6, keys: [], duration: 60, half: 7.5, nextHalf: 10, fadeIn: 20, fadeOut: 20 },
  ];
  for (const m of models) {
    const seconds = (m.duration + m.half + m.nextHalf) / FPS;
    const raw = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `aevalsrc=1:s=48000:d=${seconds}`,
        "-af",
        `aformat=sample_fmts=fltp,asetnsamples=n=${AUDIO_BLOCK}:p=0,volume=eval=frame:volume='${gainExpr(m, FPS)}'`,
        "-f",
        "f32le",
        "-",
      ],
      { maxBuffer: 1 << 26 },
    );
    const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    let worst = 0;
    for (let b = 0; (b + 1) * AUDIO_BLOCK <= samples.length; b++) {
      const local = (((b + 0.5) * AUDIO_BLOCK) / 48000) * FPS - m.half;
      worst = Math.max(worst, Math.abs(samples[b * AUDIO_BLOCK]! - gainAt(m, local)));
    }
    assert.ok(worst < 1e-4, `worst block differs by ${worst}`);
  }
});

test("the rasteriser starts as the desktop says; without it, the workspace's Electron runs the desktop bundle (dev, tests)", () => {
  // Packaged: the desktop passes its own binary and no entry (it always runs its bundled main).
  assert.deepEqual(rasterizerCommand({ UNCUT_RENDER_BIN: "/Applications/Uncut.app/Contents/MacOS/Uncut", UNCUT_RENDER_ENTRY: "" }), {
    bin: "/Applications/Uncut.app/Contents/MacOS/Uncut",
    args: ["--uncut-render"],
  });
  // pnpm dev: a bare Electron, so the desktop bundle is the entry.
  assert.deepEqual(rasterizerCommand({ UNCUT_RENDER_BIN: "/x/electron", UNCUT_RENDER_ENTRY: "/x/main.cjs" }), {
    bin: "/x/electron",
    args: ["/x/main.cjs", "--uncut-render"],
  });
  // A Linux server (D106): Chromium's captures out of /dev/shm (Docker's is 64 MB).
  assert.deepEqual(rasterizerCommand({ UNCUT_RENDER_BIN: "/x/electron", UNCUT_RENDER_ENTRY: "/x/main.cjs" }, { execPath: "/x/node", platform: "linux" }), {
    bin: "/x/electron",
    args: ["/x/main.cjs", "--uncut-render", "--disable-dev-shm-usage"],
  });
  if (!existsSync(DESKTOP)) return;
  // The server on Electron-as-Node with nothing passed: never a bare --uncut-render (Electron's welcome app).
  assert.deepEqual(rasterizerCommand({}, { electron: "44.6.0", execPath: "/x/electron" }), { bin: "/x/electron", args: [DESKTOP, "--uncut-render"] });
  const node = rasterizerCommand({}, { electron: undefined, execPath: process.execPath });
  assert.ok("bin" in node && /electron/i.test(node.bin) && node.args[0] === DESKTOP, JSON.stringify(node));
});

test("ffmpeg 6 gets the graph with -filter_complex_script, 7 and later with -/filter_complex", () => {
  assert.deepEqual(graphFileArgs({ major: 6 }, "/g.txt"), ["-filter_complex_script", "/g.txt"]);
  assert.deepEqual(graphFileArgs({ major: 8 }, "/g.txt"), ["-/filter_complex", "/g.txt"]);
  assert.deepEqual(graphFileArgs({ major: undefined }, "/g.txt"), ["-/filter_complex", "/g.txt"]);
});

test("stale export and rasteriser temp folders are swept: dead owners, or an hour old without one", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-sweep-")));
  try {
    const make = (name: string, ageMs = 0) => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "f.png"), "x");
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(join(dir, name), t, t);
    };
    make("uncut-export-999999-dead01"); // owner gone
    make("uncut-render-profile-999999-dead02");
    make(`uncut-export-${process.pid}-mine01`); // ours (the server itself)
    make(`uncut-render-profile-${process.ppid}-live01`, 5 * 3600_000); // an owner that's alive, however old
    make("uncut-export-old001", 2 * 3600_000); // no owner, two hours old
    make("uncut-export-new001"); // no owner, fresh
    make("uncut-export-test-abcdef", 5 * 3600_000); // not ours
    await sweepStaleTemp(dir);
    assert.deepEqual(
      readdirSync(dir).sort(),
      [`uncut-export-${process.pid}-mine01`, "uncut-export-new001", "uncut-export-test-abcdef", `uncut-render-profile-${process.ppid}-live01`].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- on the server ----

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let temp = "";
let server: Server;
let client: Client;
let jobs: ReturnType<Client["subscribe"]>;
const job = (id: string) => jobs.values.at(-1)?.find((j: { id: string }) => j.id === id);
const finished = (id: string, timeout = 120000) =>
  jobs.until((list) => list.some((j: any) => j.id === id && ["done", "failed", "cancelled"].includes(j.phase)), timeout).then(() => job(id));
const children = () =>
  spawnSync("pgrep", ["-P", String(server.proc.pid)], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const resultLog = () => join(root, "results.jsonl");

before(async () => {
  if (skipServer) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-export-test-")));
  temp = join(root, "tmp");
  mkdirSync(temp);
  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(resultLog(), "");
  makeExportFixture(join(root, "media"));
  // The server's temp folder is its own, so leftovers are ours to see.
  server = await startServer({
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      TMPDIR: temp,
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: join(root, "plan.json"),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_RESULT_LOG: resultLog(),
    },
  });
  client = await connect(server.ready.port, server.ready.token);
  jobs = client.subscribe("export.jobs");
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

const open = async (name: string, project: Project) => client.ok("project.open", { dir: writeProject(root, name, project) });
const probe = (file: string) =>
  JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,duration:format=duration", "-of", "json", file],
      { encoding: "utf8" },
    ),
  ) as {
    streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate: string; nb_frames?: string }>;
    format: { duration: string };
  };
/** Frame n of a video (by index, not by seeking) as a PNG. */
const frameOf = (file: string, n: number, out: string) => (
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-update", "1", out]),
  out
);
/** SSIM of two images at 480×270 grey (1 = identical). */
const ssim = (a: string, b: string) => {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};
/** RMS of the left channel over [t, t + d) seconds (decoded from the start: an AAC seek can land oddly). */
const rms = (file: string, t: number, d = 0.05) => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-af", `pan=mono|c0=FL,atrim=start=${t}:duration=${d}`, "-f", "f32le", "-"]);
  const s = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  return Math.sqrt(s.reduce((a, x) => a + x * x, 0) / s.length);
};
/** The RMS core expects over the same window: every sound is a sine at amplitude 0.5 of its own pitch. */
const expectedRms = (project: Project, t: number, d = 0.05) => {
  const { starts } = layout(project);
  const steps = 50;
  const power = new Map<string, number>();
  for (let i = 0; i < steps; i++) {
    const f = (t + ((i + 0.5) / steps) * d) * FPS;
    for (const a of audibleAt(project, starts, f)) {
      const pitch = a.item.media!;
      power.set(pitch, (power.get(pitch) ?? 0) + (0.5 * a.gain) ** 2 / 2 / steps);
    }
  }
  return Math.sqrt([...power.values()].reduce((a, b) => a + b, 0));
};

test("export: the fixture renders at the canvas size and fps with sound at core's levels", { skip: skipServer, timeout: 120000 }, async () => {
  const project = exportProject(join(root, "media"));
  await open("Fixture", project);
  const output = join(root, "out", "Fixture.mp4");
  const t0 = Date.now();
  const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "off" });
  await jobs.until((list) => list.some((j: any) => j.id === jobId && j.phase === "rendering"), 60000);
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);
  console.log(`fixture export (8 s, 1080p): ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  assert.equal(done.output, output);
  assert.equal(done.progress, 1);
  const p = probe(output);
  const v = p.streams.find((s) => s.codec_type === "video")!;
  const a = p.streams.find((s) => s.codec_type === "audio")!;
  assert.equal(v.width, 1920);
  assert.equal(v.height, 1080);
  assert.equal(v.r_frame_rate, "30/1");
  assert.equal(Number(v.nb_frames), 240);
  assert.equal(a.codec_name, "aac");
  const colour = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_space,color_primaries,color_transfer,color_range", "-of", "csv=p=0", output],
    { encoding: "utf8" },
  ).trim();
  assert.equal(colour, "tv,bt709,bt709,bt709", "tagged BT.709 (range, matrix, primaries, transfer)");
  assert.ok(Math.abs(Number(p.format.duration) - 8) < 0.05, `duration ${p.format.duration}`);
  // Frame 60 is A 15 frames in (the clip after the title card), full frame.
  const src = join(root, "a-15.png");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    join(root, "media", "A.mp4"),
    "-vf",
    "select=eq(n\\,15),scale=1920:1080",
    "-frames:v",
    "1",
    "-update",
    "1",
    src,
  ]);
  const shot = ssim(frameOf(output, 60, join(root, "export-60.png")), src);
  console.log(`frame 60 vs source frame 15: SSIM ${shot.toFixed(4)}`);
  assert.ok(shot > 0.97, `SSIM ${shot}`);
  // Sound: music fading in, clip tones, the crossfade, the music fading out.
  for (const t of [0.5, 1.2, 2, 3.6, 4.7, 5, 5.2, 6.5, 7.5]) {
    const got = rms(output, t);
    const want = expectedRms(project, t);
    console.log(`  rms at ${t}s: ${got.toFixed(4)} (core ${want.toFixed(4)})`);
    assert.ok(Math.abs(got - want) <= 0.03 * want + 0.003, `rms at ${t}s: ${got} vs ${want}`);
  }
  // Nothing left in the temp folder (the rasteriser's profile included).
  assert.deepEqual(readdirSync(temp), []);
  assert.deepEqual(children(), []);
});

test("export (G7, D127): a part of the timeline exports exactly that part, picture and sound", { skip: skipServer, timeout: 120000 }, async () => {
  const project = exportProject(join(root, "media"));
  const output = join(root, "out", "Part.mp4");
  // Frames [30, 120): the export's frame 30 is the edit's frame 60 (A 15 frames in).
  const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "off", range: { from: 30, to: 120 } });
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);
  assert.deepEqual(done.range, { from: 30, to: 120 });
  assert.equal(done.seconds, 3);
  const p = probe(output);
  const v = p.streams.find((s) => s.codec_type === "video")!;
  assert.equal(Number(v.nb_frames), 90);
  assert.ok(Math.abs(Number(p.format.duration) - 3) < 0.05, `duration ${p.format.duration}`);
  const src = join(root, "a-15.png");
  const shot = ssim(frameOf(output, 30, join(root, "part-30.png")), src);
  assert.ok(shot > 0.97, `part frame 30 vs source frame 15: SSIM ${shot}`);
  for (const t of [0.2, 1.2, 2.2]) {
    const got = rms(output, t);
    const want = expectedRms(project, t + 1);
    assert.ok(Math.abs(got - want) <= 0.03 * want + 0.003, `rms at ${t}s of the part: ${got} vs ${want} (edit ${t + 1}s)`);
  }
  const empty = await client.fail("export.start", {
    output: join(root, "out", "None.mp4"),
    quality: "draft",
    loudness: "off",
    range: { from: 9000, to: 9100 },
  });
  assert.match(empty.message, /empty/);
});

/** The colour of a video's frame n at x (a fraction of the width), mid-height, averaged over 8×8 pixels. */
const pixelOf = (file: string, n: number, x: number, width = 640, height = 360): Rgb => {
  const cx = Math.max(0, Math.min(width - 8, Math.round(x * width) - 4));
  const raw = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    `select=eq(n\\,${n}),crop=8:8:${cx}:${height / 2 - 4},scale=1:1:flags=area,format=rgb24`,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-",
  ]);
  return [raw[0]!, raw[1]!, raw[2]!];
};

test("export: an existing file is replaced only when asked; loudness lands on its target; draft is 720p", { skip: skipServer, timeout: 120000 }, async () => {
  const output = join(root, "out", "Fixture.mp4");
  assert.ok(existsSync(output));
  const refused = await client.fail("export.start", { output, quality: "draft", loudness: "normal" });
  assert.equal(refused.reason, "exists");
  assert.match(refused.message, /Fixture\.mp4 already exists/);
  const { jobId } = await client.ok("export.start", { output, quality: "draft", loudness: "normal", overwrite: true });
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);
  const v = probe(output).streams.find((s) => s.codec_type === "video")!;
  assert.deepEqual([v.width, v.height], [1280, 720]);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", output, "-map", "0:a", "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/.exec(r.stderr)?.[1]);
  console.log(`loudness after "normal": ${lufs} LUFS`);
  assert.ok(Math.abs(lufs + 14) < 1, `integrated loudness ${lufs}`);
});

test("export: a project without sound gets a silent track; bad paths and missing media are clear errors", { skip: skipServer, timeout: 120000 }, async () => {
  const silent = {
    ...exportProject(join(root, "media")),
    media: [],
    tracks: [
      {
        id: "main",
        kind: "video" as const,
        role: "main" as const,
        name: "Main",
        items: [{ id: "card", type: "component" as const, component: "component.solid", duration: 30, props: { color: "white" } }],
      },
    ],
  };
  await open("Silent", silent);
  const output = join(root, "out", "Silent.mp4");
  const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "normal" });
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);
  const streams = probe(output).streams;
  assert.ok(streams.some((s) => s.codec_type === "audio"));
  assert.ok(rms(output, 0.2, 0.5) < 1e-4);
  const white = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-i",
    output,
    "-vf",
    "select=eq(n\\,10),scale=1:1,format=gray",
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-",
  ])[0]!;
  assert.ok(white > 230, `white card came out as ${white}`);

  const relative = await client.fail("export.start", { output: "Silent.mp4", quality: "standard", loudness: "off" });
  assert.equal(relative.reason, "invalid-path");
  const nowhere = await client.fail("export.start", { output: join(root, "no-such-folder", "x.mp4"), quality: "standard", loudness: "off" });
  assert.equal(nowhere.reason, "invalid-path");

  // Never over footage the project uses, even when told to replace (the file isn't touched).
  const fixture = exportProject(join(root, "media"));
  await open("Footage", fixture);
  const before = readFileSync(join(root, "media", "A.mp4"));
  const footage = await client.fail("export.start", { output: join(root, "media", "A.mp4"), quality: "standard", loudness: "off", overwrite: true });
  assert.equal(footage.reason, "source-media");
  assert.match(footage.message, /A\.mp4 would replace footage this project uses/);
  assert.ok(readFileSync(join(root, "media", "A.mp4")).equals(before));
  // A folder Uncut can't write in is said at once, in words.
  const locked = join(root, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  const unwritable = await client.fail("export.start", { output: join(locked, "x.mp4"), quality: "standard", loudness: "off" });
  chmodSync(locked, 0o755);
  assert.equal(unwritable.reason, "invalid-path");
  assert.match(unwritable.message, /isn't allowed to write in/);

  const broken = exportProject(join(root, "media"));
  await open("Broken", { ...broken, media: broken.media.map((m) => (m.id === "m-b" ? { ...m, path: join(root, "media", "Gone.mp4") } : m)) });
  const missing = await client.fail("export.start", { output: join(root, "out", "Broken.mp4"), quality: "standard", loudness: "off" });
  assert.equal(missing.reason, "missing-media");
  assert.match(missing.message, /B\.mp4 \(.*Gone\.mp4\) is missing/);
  assert.ok(!existsSync(join(root, "out", "Broken.mp4")));
});

test("export: cancelling while text is drawn or mid-render leaves no processes, temp files or output", { skip: skipServer, timeout: 180000 }, async () => {
  const media = join(root, "media");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=30",
    "-t",
    "60",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    join(media, "Long.mp4"),
  ]);
  const base = exportProject(media);
  const long: Project = {
    ...base,
    media: [
      ...base.media,
      {
        id: "m-long",
        kind: "video",
        name: "Long.mp4",
        path: join(media, "Long.mp4"),
        probe: { frames: 1800, fps: 30, width: 1280, height: 720, hasAudio: false },
      },
    ],
    tracks: base.tracks.map((t) =>
      t.id === "main"
        ? { ...t, items: [{ id: "long", type: "clip" as const, media: "m-long", in: 0, duration: 1800 }] }
        : t.id === "audio" || t.id === "overlay"
          ? { ...t, items: [] }
          : t,
    ),
  };
  await open("Long", long);
  const output = join(root, "out", "Long.mp4");

  // Right away: queued or drawing the text.
  const first = await client.ok("export.start", { output, quality: "high", loudness: "off" });
  await client.ok("export.cancel", { jobId: first.jobId });
  assert.equal((await finished(first.jobId)).phase, "cancelled");

  // Mid-render: ffmpeg is a child of the server, then it isn't.
  const { jobId } = await client.ok("export.start", { output, quality: "high", loudness: "off" });
  // A second export waits its turn; one to the same file is refused; cancelling the waiting one is immediate.
  const waiting = await client.ok("export.start", { output: join(root, "out", "Long-2.mp4"), quality: "draft", loudness: "off" });
  const same = await client.fail("export.start", { output, quality: "draft", loudness: "off", overwrite: true });
  assert.equal(same.reason, "busy");
  await jobs.until((list) => list.some((j: any) => j.id === jobId && j.phase === "rendering" && j.progress > 0.05), 60000);
  assert.equal(job(waiting.jobId).phase, "queued");
  await client.ok("export.cancel", { jobId: waiting.jobId });
  await jobs.until((list) => list.some((j: any) => j.id === waiting.jobId && j.phase === "cancelled"), 2000);
  assert.equal(job(jobId).phase, "rendering", "the running one goes on");
  const running = job(jobId);
  assert.ok(running.etaSeconds >= 0, "an ETA while rendering");
  const kids = children();
  assert.ok(kids.length >= 1, "ffmpeg runs as the server's child");
  await client.ok("export.cancel", { jobId });
  const end = await finished(jobId);
  assert.equal(end.phase, "cancelled");
  assert.equal(end.error, undefined);
  for (let i = 0; i < 20 && children().length; i++) await sleep(100);
  assert.deepEqual(children(), [], "no ffmpeg or rasteriser left");
  for (const pid of kids) assert.throws(() => process.kill(Number(pid), 0), `pid ${pid} is gone`);
  assert.deepEqual(readdirSync(temp), [], "temp files removed");
  assert.ok(!existsSync(output), "no partial output");
  assert.deepEqual(
    readdirSync(dirname(output)).filter((f) => f.startsWith(".")),
    [],
  );
});

test("export: quitting mid-render stops ffmpeg and removes the temp files before the server exits", { skip: skipServer, timeout: 120000 }, async () => {
  const quitTemp = join(root, "tmp-quit");
  mkdirSync(quitTemp);
  const other = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data-quit"), TMPDIR: quitTemp } });
  const c = await connect(other.ready.port, other.ready.token);
  try {
    const list = c.subscribe("export.jobs");
    await c.ok("project.open", { dir: projectCopy(join(root, "Long.uncut")) });
    const { jobId } = await c.ok("export.start", { output: join(root, "out", "Quit.mp4"), quality: "high", loudness: "off" });
    await list.until((l) => l.some((j: any) => j.id === jobId && j.phase === "rendering" && j.progress > 0.02), 60000);
    const kids = spawnSync("pgrep", ["-P", String(other.proc.pid)], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .filter(Boolean);
    assert.ok(kids.length >= 1);
    assert.ok(readdirSync(quitTemp).length >= 1, "temp files while rendering");
    c.close();
    await other.stop();
    // A child the server killed can still answer kill(pid, 0) for a moment: a zombie until
    // launchd reaps it once its parent is gone (#89). Stopped is what counts: gone or a zombie.
    const stopped = (pid: string) => {
      try {
        process.kill(Number(pid), 0);
      } catch {
        return true;
      }
      return spawnSync("ps", ["-o", "stat=", "-p", pid], { encoding: "utf8" }).stdout.trim().startsWith("Z");
    };
    await until(() => kids.every(stopped), `the server's children ${kids.join(", ")} to stop`, { timeout: 5000 });
    assert.deepEqual(readdirSync(quitTemp), [], "temp files removed before exit");
    assert.ok(!existsSync(join(root, "out", "Quit.mp4")));
  } finally {
    c.close();
    await other.stop();
  }
});

test("render_frames: the agent gets JPEGs of the edit that match the export's frames", { skip: skipServer, timeout: 120000 }, async () => {
  const project = exportProject(join(root, "media"));
  const snap = await open("Frames", project);
  assert.ok(snap.dir);
  writeFileSync(
    join(root, "plan.json"),
    JSON.stringify([
      [
        { tool: "render_frames", args: { frames: [5, 120, 150], scale: 0.25 } },
        { tool: "render_frames", args: { frames: [] } },
        { tool: "render_frames", args: { frames: [999], scale: 0.25 } },
      ],
    ]),
  );
  const agent = client.subscribe("agent.subscribe");
  const { turnId } = await client.ok("agent.send", { prompt: "Look at it" });
  await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 60000);
  const turn = agent.values.at(-1).turns.find((t: any) => t.id === turnId);
  assert.equal(turn.items.find((i: any) => i.tool === "render_frames")?.text, "Looked at frames 5, 120, 150");
  const [ok, bad, past] = readFileSync(resultLog(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l)) as Array<{ result: { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } }>;
  assert.ok(!ok!.result.isError, JSON.stringify(ok!.result).slice(0, 300));
  assert.match(ok!.result.content[0]!.text!, /Frames 5, 120, 150 .* at 480×270/);
  const images = ok!.result.content.filter((c) => c.type === "image");
  assert.equal(images.length, 3);
  const exported = join(root, "out", "Fixture-frames.mp4");
  const { jobId } = await client.ok("export.start", { output: exported, quality: "standard", loudness: "off" });
  assert.equal((await finished(jobId)).phase, "done");
  for (const [i, f] of [5, 120, 150].entries()) {
    assert.equal(images[i]!.mimeType, "image/jpeg");
    const jpg = join(root, `agent-${f}.jpg`);
    writeFileSync(jpg, Buffer.from(images[i]!.data!, "base64"));
    const s = probe(jpg).streams[0]!;
    assert.deepEqual([s.width, s.height], [480, 270]);
    const score = ssim(jpg, frameOf(exported, f, join(root, `exported-${f}.png`)));
    console.log(`render_frames ${f} vs export: SSIM ${score.toFixed(4)}`);
    assert.ok(score > 0.9, `frame ${f}: SSIM ${score}`);
  }
  assert.ok(bad!.result.isError);
  assert.match(bad!.result.content[0]!.text!, /frames must be/);
  // Past the end: the last frame is drawn, and the agent is told so.
  assert.ok(!past!.result.isError);
  assert.match(past!.result.content[0]!.text!, /^Frame 239 .*Note: frame 999 is past the last frame, so frame 239 is shown for it\./);
});

test("export: the DJI 4K clip exports at 4K and matches the source frame", { skip: skipServer || skipDemo, timeout: 600000 }, async () => {
  const projectFile = demoProject();
  const project = JSON.parse(readFileSync(projectFile, "utf8")) as Project;
  await client.ok("project.open", { dir: dirname(projectFile) });
  // A frame showing one clip alone, fully, with no text: its picture is the source's.
  const { starts, duration } = layout(project);
  let pick: { f: number; source: number } | undefined;
  for (let f = Math.floor(duration * 0.6); f < duration && !pick; f++) {
    const vs = visualsAt(project, starts, f);
    if (vs.length === 1 && vs[0]!.item.type === "clip" && vs[0]!.opacity === 1) pick = { f, source: vs[0]!.source };
  }
  assert.ok(pick, "a frame with one clip alone");
  const output = join(root, "out", "Demo.mp4");
  const t0 = Date.now();
  const { jobId } = await client.ok("export.start", { output, quality: "high", loudness: "off" });
  const done = await finished(jobId, 550000);
  assert.equal(done.phase, "done", done.error);
  const seconds = (Date.now() - t0) / 1000;
  const v = probe(output).streams.find((s) => s.codec_type === "video")!;
  assert.deepEqual([v.width, v.height, v.codec_name, v.r_frame_rate], [3840, 2160, "h264", "60/1"]);
  const shot = frameOf(output, pick.f, join(root, "demo-export.png"));
  // The source frame on screen at that moment is the last one starting at or before it (D38);
  // its neighbours show how much a frame off would cost.
  const times = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-read_intervals", `${pick.source - 0.2}%+0.4`, "-show_entries", "frame=pts_time", "-of", "csv=p=0", FOOTAGE],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .map(Number)
    .sort((a, b) => a - b);
  const onScreen = times.filter((t) => t <= pick!.source + 0.0001).length - 1;
  assert.ok(onScreen > 0 && onScreen < times.length - 1);
  const scores: Array<number> = [];
  for (const i of [onScreen - 1, onScreen, onScreen + 1]) {
    const src = join(root, `demo-src-${i}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(times[i]! - 0.0005), "-i", FOOTAGE, "-frames:v", "1", "-update", "1", src]);
    scores.push(ssim(shot, src));
  }
  console.log(
    `DJI export (${(duration / project.canvas.fps).toFixed(1)} s of 4K, High/H.264): ${seconds.toFixed(1)} s; frame ${pick.f} (source ${pick.source.toFixed(3)} s) vs the source frames before / on screen / after: SSIM ${scores.map((s) => s.toFixed(4)).join(" / ")}`,
  );
  assert.ok(scores[1]! > 0.95, `SSIM ${scores}`);
  assert.ok(scores[1]! >= Math.max(scores[0]!, scores[2]!), "the frame on screen matches best");
  rmSync(output, { force: true });
});

test("export: crossfade, dip to black and wipe between solid colours blend as core says (D73)", { skip: skipServer, timeout: 120000 }, async () => {
  const media = join(root, "solids");
  makeTransitionMedia(media);
  const project = transitionProject(media);
  await open("Transitions", project);
  const output = join(root, "out", "Transitions.mp4");
  const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "off" });
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);
  const v = probe(output).streams.find((s) => s.codec_type === "video")!;
  assert.equal(v.width, 640);
  assert.equal(Number(v.nb_frames), 240);
  for (const [f, x, what] of COLOUR_CHECKS) {
    const got = pixelOf(output, f, x);
    const want = expectedColour(project, f, x);
    console.log(`  frame ${f} at x ${x} (${what}): export ${got.join(",")}, core ${want.join(",")}`);
    assert.ok(closeColour(got, want), `frame ${f} at ${x} (${what}): ${got} vs ${want}`);
  }
  // The blends themselves, not just agreement: mid-crossfade is half red, half blue; the dip's cut is black.
  assert.deepEqual(expectedColour(project, 60, 0.5), [128, 0, 128]);
  assert.deepEqual(expectedColour(project, 120, 0.5), [0, 0, 0]);
  assert.deepEqual(expectedColour(project, 115, 0.5), [0, 0, 128]);
  assert.deepEqual(expectedColour(project, 125, 0.5), [128, 0, 0]);
  assert.deepEqual(expectedColour(project, 180, 0.25), [0, 0, 255]);
  assert.deepEqual(expectedColour(project, 180, 0.75), [255, 0, 0]);
});

test(
  "export: a wipe keeps the incoming picture in place, up to its edge, and crops only over the wipe (D73)",
  { skip: skipServer, timeout: 120000 },
  async () => {
    const media = join(root, "solids");
    if (!existsSync(join(media, "Ramp.mp4"))) makeTransitionMedia(media);
    const project = rampWipeProject(media);
    // The plan: the wiped clip is two layers, the cropped one only over the wipe's frames.
    const plan = planExport(project, { mediaPath: (m) => m.path, width: 640, height: 360 });
    if ("problem" in plan) throw new Error(plan.problem);
    const ramp = plan.visuals.filter((l) => l.item.id === "ramp");
    assert.deepEqual(
      ramp.map((l) => [l.f0, l.f1, !!l.wipe]),
      [
        [50, 70, true],
        [70, 120, false],
      ],
    );
    await open("Ramp wipe", project);
    const output = join(root, "out", "Ramp wipe.mp4");
    const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "off" });
    const done = await finished(jobId);
    assert.equal(done.phase, "done", done.error);
    // Mid-wipe (frame 60: the left 320 px shown): the ramp at x is what it is at x once the wipe is
    // over (frame 80), right up to the edge; past the edge it's still red.
    for (const x of [0.05, 0.25, 0.4, 0.47]) {
      const mid = pixelOf(output, 60, x);
      const after = pixelOf(output, 80, x);
      console.log(`  ramp at x ${x}: mid-wipe ${mid.join(",")}, after ${after.join(",")}`);
      assert.ok(closeColour(mid, after, 4), `x ${x}: ${mid} vs ${after}`);
    }
    assert.ok(closeColour(pixelOf(output, 60, 0.53), [255, 0, 0]), "past the edge: the outgoing clip");
    // A quarter in (frame 55): shown up to 160 px only.
    assert.ok(closeColour(pixelOf(output, 55, 0.2), pixelOf(output, 80, 0.2), 4));
    assert.ok(closeColour(pixelOf(output, 55, 0.3), [255, 0, 0]));
  },
);

test(
  "export: iris, push and zoom between solid colours and a background draw as core says; render_frames agrees (D79)",
  { skip: skipServer, timeout: 180000 },
  async () => {
    const media = join(root, "solids");
    if (!existsSync(join(media, "Red.mp4"))) makeTransitionMedia(media);
    const project = movesProject(media);
    await open("Moves", project);
    const output = join(root, "out", "Moves.mp4");
    const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "off" });
    const done = await finished(jobId);
    assert.equal(done.phase, "done", done.error);
    const v = probe(output).streams.find((s) => s.codec_type === "video")!;
    assert.equal(Number(v.nb_frames), 360);
    // An 8×8 average at (x, y) as fractions of the frame.
    const colourAt = (file: string, n: number, x: number, y: number): Rgb => {
      const cx = Math.max(0, Math.min(632, Math.round(x * 640) - 4));
      const cy = Math.max(0, Math.min(352, Math.round(y * 360) - 4));
      const raw = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        file,
        "-vf",
        `select=eq(n\\,${n}),crop=8:8:${cx}:${cy},scale=1:1:flags=area,format=rgb24`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-",
      ]);
      return [raw[0]!, raw[1]!, raw[2]!];
    };
    for (const [f, x, y, what] of MOVE_CHECKS) {
      const got = colourAt(output, f, x, y);
      const want = expectedAt(project, f, x, y);
      console.log(`  frame ${f} at (${x}, ${y}) (${what}): export ${got.join(",")}, core ${want.join(",")}`);
      assert.ok(closeColour(got, want), `frame ${f} at (${x}, ${y}) (${what}): ${got} vs ${want}`);
    }
    // The reference itself, not just agreement.
    assert.deepEqual(expectedAt(project, 60, 0.5, 0.5), [0, 0, 255]);
    assert.deepEqual(expectedAt(project, 60, 0.02, 0.04), [255, 0, 0]);
    assert.deepEqual(expectedAt(project, 120, 0.45, 0.5), [0, 0, 255]);
    assert.deepEqual(expectedAt(project, 120, 0.55, 0.5), [255, 0, 0]);
    assert.deepEqual(expectedAt(project, 180, 0.55, 0.5), [0, 255, 0]);
    assert.deepEqual(expectedAt(project, 240, 0.5, 0.5), [0, 128, 128]);
    // render_frames (the agent's view) draws the same mid-transition frames.
    rmSync(join(root, "plan.json.turn"), { force: true });
    const frames = [60, 120, 180, 240, 300];
    writeFileSync(join(root, "plan.json"), JSON.stringify([[{ tool: "render_frames", args: { frames, scale: 1 } }]]));
    const before = readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).length;
    const agent = client.subscribe("agent.subscribe");
    const { turnId } = await client.ok("agent.send", { prompt: "Look at the transitions" });
    await agent.until((st) => st?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 60000);
    const result = JSON.parse(readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean)[before]!) as {
      result: { isError?: boolean; content: Array<{ type: string; data?: string }> };
    };
    assert.ok(!result.result.isError, JSON.stringify(result.result).slice(0, 300));
    for (const [i, f] of frames.entries()) {
      const jpg = join(root, `moves-agent-${f}.jpg`);
      writeFileSync(jpg, Buffer.from(result.result.content.filter((c) => c.type === "image")[i]!.data!, "base64"));
      const score = ssim(jpg, frameOf(output, f, join(root, `moves-exported-${f}.png`)));
      console.log(`  render_frames ${f} vs export: SSIM ${score.toFixed(4)}`);
      // render_frames' RGB path draws red ~231 (D75, known), which flat red/blue frames weigh heavily
      // in a grey SSIM (0.92 where the shapes are identical); the colour checks below hold the shapes.
      assert.ok(score > 0.9, `frame ${f}: SSIM ${score}`);
      for (const [cf, x, y, what] of MOVE_CHECKS.filter((c) => c[0] === f)) {
        const got = colourAt(jpg, 0, x, y);
        const want = expectedAt(project, cf, x, y);
        assert.ok(closeColour(got, want, 32), `render_frames ${f} at (${x}, ${y}) (${what}): ${got} vs ${want}`);
      }
    }
  },
);

test(
  "export: a boxed split clip, cover, zooming 1 → 1.2 by a key, matches core's box pixel for pixel (D75)",
  { skip: skipServer, timeout: 120000 },
  async () => {
    const media = join(root, "boxes");
    makeClipMedia(media);
    const project = splitProject(media);
    await open("Split", project);
    const output = join(root, "out", "Split.mp4");
    const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "off" });
    const done = await finished(jobId);
    assert.equal(done.phase, "done", done.error);
    const v = probe(output).streams.find((s) => s.codec_type === "video")!;
    assert.equal(v.width, 1280);
    assert.equal(Number(v.nb_frames), 90);
    // The clip's colours as a decoder reads them back from the source (a pure red comes back as about
    // 252, 0, 0): the export is held to core's box with those, as the transition test is (D73).
    const read = (file: string, f: number, x: number, y: number): Rgb => {
      const raw = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        file,
        "-vf",
        `select=eq(n\\,${f}),format=rgb24,crop=1:1:${x}:${y}`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-",
      ]);
      return [raw[0]!, raw[1]!, raw[2]!];
    };
    const palette = { red: read(join(media, "Split.mp4"), 0, 40, 240), blue: read(join(media, "Split.mp4"), 0, 400, 240), grey: [128, 128, 128] as Rgb };
    console.log(`  source colours: red ${palette.red.join(",")}, blue ${palette.blue.join(",")}`);
    for (const f of [0, 30, 89]) {
      for (const [x, y, what] of CLIP_POINTS) {
        const want = expectedClipColour(project, f, x, y, palette);
        assert.ok(want.margin >= 3, `frame ${f} (${x}, ${y}) is ${want.margin} px from an edge: pick another point`);
        const got = read(output, f, x, y);
        console.log(`  frame ${f} at (${x}, ${y}) (${what}): export ${got.join(",")}, core ${want.colour.join(",")}`);
        assert.ok(closeColour(got, want.colour, 3), `frame ${f} at (${x}, ${y}) (${what}): ${got} vs ${want.colour}`);
      }
    }
    // render_frames draws the box as the export does (the agent's view of the edit).
    // The fake claude plays the plan's turns in order (a counter file): this is a first turn again.
    rmSync(join(root, "plan.json.turn"), { force: true });
    writeFileSync(join(root, "plan.json"), JSON.stringify([[{ tool: "render_frames", args: { frames: [0, 89], scale: 1 } }]]));
    const before = readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).length;
    const agent = client.subscribe("agent.subscribe");
    const { turnId } = await client.ok("agent.send", { prompt: "Look at the box" });
    await agent.until((st) => st?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 60000);
    const result = JSON.parse(readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean)[before]!) as {
      result: { isError?: boolean; content: Array<{ type: string; data?: string }> };
    };
    assert.ok(!result.result.isError, JSON.stringify(result.result).slice(0, 300));
    for (const [i, f] of [0, 89].entries()) {
      const jpg = join(root, `split-agent-${f}.jpg`);
      writeFileSync(jpg, Buffer.from(result.result.content.filter((c) => c.type === "image")[i]!.data!, "base64"));
      const score = ssim(jpg, frameOf(output, f, join(root, `split-exported-${f}.png`)));
      console.log(`  render_frames ${f} vs export: SSIM ${score.toFixed(4)}`);
      assert.ok(score > 0.95, `frame ${f}: SSIM ${score}`);
      for (const [x, y, what] of CLIP_POINTS) {
        const got = read(jpg, 0, x, y);
        const want = expectedClipColour(project, f, x, y, palette).colour;
        // A JPEG through render_frames' RGB path (its colours run a little off, as before D75): which of red, blue and grey is what counts.
        assert.ok(closeColour(got, want, 32), `render_frames ${f} at (${x}, ${y}) (${what}): ${got} vs ${want}`);
      }
    }
    // The zoom is real: at frame 0 the point at x 244 is red (left of the split), by frame 89 blue.
    assert.deepEqual(expectedClipColour(project, 0, 244, 440).colour, [255, 0, 0]);
    assert.deepEqual(expectedClipColour(project, 89, 244, 440).colour, [0, 0, 255]);
  },
);

// ---- boxes through ffmpeg (D75 review): odd sizes and offsets, keyed scale and pans, shared
// edges, fade with box opacity, long loops. exportCommand run directly, no server. ----

const boxMedia = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-box-ffmpeg-")));
  const v = (args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  v(["-f", "lavfi", "-i", "color=c=white:s=640x360:r=30", "-t", "4", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "10", join(dir, "white.mp4")]);
  v(["-f", "lavfi", "-i", "color=c=white:s=300x200", "-frames:v", "1", join(dir, "white.png")]);
  v(["-f", "lavfi", "-i", "color=c=black:s=1280x720", "-frames:v", "1", join(dir, "bg.png")]);
  // One second: white picture, a 0.1 s beep at its start (sine is 1/8 full scale, so ×4), then silence.
  v([
    "-f",
    "lavfi",
    "-i",
    "color=c=white:s=320x180:r=30",
    "-f",
    "lavfi",
    "-i",
    "sine=f=1000:r=48000,volume=4,atrim=duration=0.1,apad=whole_dur=1",
    "-t",
    "1",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    join(dir, "beep.mp4"),
  ]);
  return dir;
};
const runPlan = (dir: string, project: Project, name: string, size = { width: 1280, height: 720 }) => {
  const plan = planExport(project, { mediaPath: (m) => m.path, ...size });
  if ("problem" in plan) throw new Error(plan.problem);
  const out = join(dir, `${name}.mp4`);
  const cmd = exportCommand(plan, {
    background: join(dir, "bg.png"),
    rasters: new Map(),
    caps: { encoders: new Set(["libx264"]), videotoolboxDecode: false, major: 8 },
    quality: "high",
    output: out,
  });
  writeFileSync(join(dir, "graph.txt"), cmd.graph);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...cmd.inputs, "-/filter_complex", join(dir, "graph.txt"), ...cmd.outputArgs], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr.slice(-800));
  assert.equal(silentFailure(r.stderr), undefined);
  return { out, plan, inputs: cmd.inputs.filter((a) => a === "-i").length };
};
/** The lit (white) region of frame n: [x0, x1) × [y0, y1). */
const litBox = (file: string, n: number, w = 1280, h = 720) => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n}),format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"]);
  let x0 = w,
    x1 = 0,
    y0 = h,
    y1 = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (raw[y * w + x]! > 128) ((x0 = Math.min(x0, x)), (x1 = Math.max(x1, x + 1)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y + 1)));
  return [x0, x1, y0, y1];
};
const boxProject = (dir: string, items: Array<Item>, extra: Array<Item> = []): Project => ({
  format: "uncut/0",
  name: "Boxes",
  canvas: { width: 1280, height: 720, fps: 30 },
  media: [
    { id: "w", kind: "video", name: "white.mp4", path: join(dir, "white.mp4"), probe: { frames: 120, fps: 30, width: 640, height: 360, hasAudio: false } },
    { id: "s", kind: "image", name: "white.png", path: join(dir, "white.png"), probe: { width: 300, height: 200 } },
    { id: "b", kind: "video", name: "beep.mp4", path: join(dir, "beep.mp4"), probe: { frames: 30, fps: 30, width: 320, height: 180, hasAudio: true } },
  ],
  tracks: [
    { id: "top", kind: "video", name: "Top", items: extra },
    { id: "main", kind: "video", role: "main", name: "Main", items },
  ],
});
/** What core says is lit: the box ∩ the picture, in whole pixels (edges rounded like placementOf). */
const coreLit = (project: Project, id: string, f: number) => {
  const v = visualsAt(project, layout(project).starts, f).find((x) => x.item.id === id)!;
  const b = v.box!;
  const r = (n: number) => Math.round(n);
  return [
    r(Math.max(b.x, b.content.x)),
    r(Math.min(b.x + b.w, b.content.x + b.content.w)),
    r(Math.max(b.y, b.content.y)),
    r(Math.min(b.y + b.h, b.content.y + b.content.h)),
  ];
};
const within = (got: Array<number>, want: Array<number>, tol: number, what: string) =>
  assert.ok(
    got.every((g, i) => Math.abs(g - want[i]!) <= tol),
    `${what}: ${got} vs ${want}`,
  );

test("ffmpeg boxes: odd-size contain boxes (clip and still) export and land where core says, to the pixel", { skip: skipFfmpeg, timeout: 120000 }, () => {
  const dir = boxMedia();
  try {
    for (const [name, item] of [
      ["clip-odd-w", { id: "c", type: "clip", media: "w", in: 0, duration: 10, transform: { x: 101, y: 99, w: 641, h: 480, fit: "contain" } }],
      ["clip-odd-h", { id: "c", type: "clip", media: "w", in: 0, duration: 10, transform: { x: 100, y: 101, w: 801, h: 301, fit: "contain" } }],
      ["still-odd", { id: "c", type: "clip", media: "s", duration: 10, transform: { x: 101, y: 101, w: 401, h: 401, fit: "contain", radius: 9 } }],
    ] as const) {
      const project = boxProject(dir, [item as Item]);
      const { out } = runPlan(dir, project, name);
      within(litBox(out, 5), coreLit(project, "c", 5), 1, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "ffmpeg boxes: a keyed zoom is on its frame (first and last), a slow pan moves one pixel a frame, shared odd edges meet",
  { skip: skipFfmpeg, timeout: 120000 },
  () => {
    const dir = boxMedia();
    try {
      const zoom = boxProject(dir, [
        {
          id: "c",
          type: "clip",
          media: "w",
          in: 0,
          duration: 60,
          transform: { x: 101, y: 100, w: 641, h: 361, fit: "contain" },
          keys: [
            { frame: 0, scale: 1 },
            { frame: 59, scale: 0.5 },
          ],
        },
      ]);
      const a = runPlan(dir, zoom, "zoom");
      for (const f of [0, 1, 30, 59]) within(litBox(a.out, f), coreLit(zoom, "c", f), 1, `zoom frame ${f}`);
      const pan = boxProject(dir, [
        {
          id: "c",
          type: "clip",
          media: "w",
          in: 0,
          duration: 60,
          transform: { x: 100, y: 101, w: 640, h: 360 },
          keys: [
            { frame: 0, x: 0 },
            { frame: 59, x: 59 },
          ],
        },
      ]);
      const b = runPlan(dir, pan, "pan");
      for (const f of [1, 2, 3, 4, 5]) assert.deepEqual(litBox(b.out, f), [f, f + 640, 101, 461], `pan frame ${f}`);
      // Two boxes sharing the odd edge 321: full white left of it, the right box at half opacity (grey) from it on: no gap, no overlap.
      const two = boxProject(
        dir,
        [{ id: "c", type: "clip", media: "w", in: 0, duration: 10, transform: { x: 0, y: 0, w: 321, h: 720, fit: "fill" } }],
        [{ id: "d", type: "clip", media: "w", in: 0, start: 0, duration: 10, transform: { x: 321, y: 0, w: 959, h: 720, fit: "fill", opacity: 0.5 } }],
      );
      const c = runPlan(dir, two, "two");
      const raw = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        c.out,
        "-vf",
        "select=eq(n\\,3),format=gray,crop=4:1:319:360",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-",
      ]);
      assert.ok(raw[0]! > 240 && raw[1]! > 240, `left of the edge: ${[...raw]}`);
      assert.ok(Math.abs(raw[2]! - 128) < 12 && Math.abs(raw[3]! - 128) < 12, `right of the edge: ${[...raw]}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("ffmpeg boxes: a fade-in animation times the box's opacity, as core multiplies them", { skip: skipFfmpeg, timeout: 120000 }, () => {
  const dir = boxMedia();
  try {
    const project = boxProject(dir, [
      {
        id: "c",
        type: "clip",
        media: "w",
        in: 0,
        duration: 40,
        transform: { x: 100, y: 100, w: 640, h: 360, opacity: 0.6 },
        animation: { in: { module: "move.fade", duration: 20 } },
      },
    ]);
    const { out } = runPlan(dir, project, "fade");
    for (const f of [0, 5, 10, 19, 30]) {
      const v = visualsAt(project, layout(project).starts, f).find((x) => x.item.id === "c")!;
      const raw = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        out,
        "-vf",
        `select=eq(n\\,${f}),format=gray,crop=1:1:400:300`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-",
      ]);
      const want = 16 + (235 - 16) * v.opacity;
      // Full-range readback of limited-range white over black.
      const got = 16 + ((235 - 16) * raw[0]!) / 255;
      assert.ok(Math.abs(got - want) < 6, `frame ${f}: ${raw[0]} vs opacity ${v.opacity.toFixed(3)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "ffmpeg boxes: a 1 s clip looped for 200 s is one input, keeps its picture to the end and its beeps on the second",
  { skip: skipFfmpeg, timeout: 300000 },
  () => {
    const dir = boxMedia();
    try {
      const project: Project = {
        ...boxProject(dir, [{ id: "c", type: "clip", media: "b", in: 0, duration: 6000, loop: true, transform: { x: 100, y: 100, w: 320, h: 180 } }]),
        canvas: { width: 640, height: 360, fps: 30 },
      };
      writeFileSync(
        join(dir, "bg.png"),
        execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=640x360", "-frames:v", "1", "-f", "image2", "-c:v", "png", "-"]),
      );
      const { out, plan, inputs } = runPlan(dir, project, "loop", { width: 640, height: 360 });
      assert.equal(plan.visuals.filter((l) => l.item.id === "c").length, 1, "one layer");
      assert.ok(inputs <= 3, `${inputs} inputs`);
      within(litBox(out, 5990, 640, 360), [100, 420, 100, 280], 1, "picture at the end");
      const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
      const s = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
      const onsets: Array<number> = [];
      let last = -48000;
      for (let i = 0; i < s.length; i++) if (Math.abs(s[i]!) > 0.1) (i - last > 24000 && onsets.push(i / 48000), (last = i));
      assert.ok(onsets.length >= 199, `${onsets.length} beeps`);
      for (const t of onsets) assert.ok(Math.abs(t - Math.round(t)) < 0.01, `beep at ${t.toFixed(4)} s, core says on the second`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---- iris, push and zoom through ffmpeg (D79): exportCommand run directly on solid colours, a ramp
// and a still, at 640×360, checked against core's geometry at the start, middle and end. ----

/** Red / Blue / Ramp clips (the transition fixture), a white 4:3 still and a black background, at 640×360. */
const movesMedia = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-moves-ffmpeg-")));
  makeTransitionMedia(dir);
  const v = (args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  v(["-f", "lavfi", "-i", "color=c=white:s=480x360", "-frames:v", "1", join(dir, "white.png")]);
  v(["-f", "lavfi", "-i", "color=c=black:s=640x360", "-frames:v", "1", join(dir, "bg.png")]);
  return dir;
};
const SOLID_PROBE = { frames: 300, fps: 30, width: 640, height: 360, hasAudio: false };
/** Two main clips meeting at frame 60 through `module` (20 frames: frames 50–69). */
const movesPair = (dir: string, a: Item, b: Item, module: string): Project => ({
  format: "uncut/0",
  name: "Moves",
  canvas: { width: 640, height: 360, fps: 30 },
  media: [
    { id: "m-red", kind: "video", name: "Red.mp4", path: join(dir, "Red.mp4"), probe: SOLID_PROBE },
    { id: "m-blue", kind: "video", name: "Blue.mp4", path: join(dir, "Blue.mp4"), probe: SOLID_PROBE },
    { id: "m-ramp", kind: "video", name: "Ramp.mp4", path: join(dir, "Ramp.mp4"), probe: SOLID_PROBE },
    { id: "m-white", kind: "image", name: "white.png", path: join(dir, "white.png"), probe: { width: 480, height: 360 } },
  ],
  tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [a, { ...b, transitionIn: { module, duration: 20 } }] }],
});
/** Frame n of an export as 8-bit RGB rows (640×360). */
const rgbFrame = (file: string, n: number) => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n}),format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"]);
  return (x: number, y: number): Rgb => [raw[(y * 640 + x) * 3]!, raw[(y * 640 + x) * 3 + 1]!, raw[(y * 640 + x) * 3 + 2]!];
};
const isRed = (c: Rgb) => c[0] > 200 && c[1] < 50 && c[2] < 50;
const isBlue = (c: Rgb) => c[0] < 50 && c[1] < 50 && c[2] > 200;

test(
  "ffmpeg transitions: an iris opens the incoming clip in a circle from the centre, radius as core says (D79)",
  { skip: skipFfmpeg, timeout: 120000 },
  () => {
    const dir = movesMedia();
    try {
      const project = movesPair(
        dir,
        { id: "a", type: "clip", media: "m-red", in: 30, duration: 60 },
        { id: "b", type: "clip", media: "m-blue", in: 30, duration: 60 },
        "transition.iris",
      );
      const { out, plan } = runPlan(dir, project, "iris", { width: 640, height: 360 });
      // Only the iris's frames are masked: b is a masked layer 50–69, then a plain one.
      assert.deepEqual(
        plan.visuals.filter((l) => l.item.id === "b").map((l) => [l.f0, l.f1, !!l.iris]),
        [
          [50, 70, true],
          [70, 120, false],
        ],
      );
      const at = (f: number) => visualsAt(project, layout(project).starts, f).find((v) => v.item.id === "b")?.iris;
      // The start: all red (radius 0). The end: all blue.
      const start = rgbFrame(out, 50);
      for (const [x, y] of [
        [320, 180],
        [0, 0],
        [639, 359],
      ] as const)
        assert.ok(isRed(start(x, y)), `frame 50 (${x}, ${y}): ${start(x, y)}`);
      const end = rgbFrame(out, 70);
      for (const [x, y] of [
        [320, 180],
        [0, 0],
        [639, 359],
      ] as const)
        assert.ok(isBlue(end(x, y)), `frame 70 (${x}, ${y}): ${end(x, y)}`);
      // Mid-way (frame 60, share 0.5): radius 183.6 px. The centre is blue, the corners red, and along
      // the middle row the edge is where core puts it (within a pixel).
      for (const f of [55, 60, 65, 69]) {
        const r = irisRadius(at(f)!, project.canvas);
        const px = rgbFrame(out, f);
        assert.ok(isBlue(px(320, 180)), `frame ${f}: centre ${px(320, 180)}`);
        for (const [x, y] of [
          [2, 2],
          [637, 2],
          [2, 357],
          [637, 357],
        ] as const)
          assert.ok(isRed(px(x, y)), `frame ${f}: corner (${x}, ${y}) ${px(x, y)}`);
        let edge = 320;
        while (edge < 639 && px(edge + 1, 180)[2] > 128) edge++;
        console.log(
          `  iris frame ${f}: radius ${r.toFixed(1)} px (core), edge on the middle row at x ${edge} (${(edge + 1 - 320).toFixed(0)} px from the centre)`,
        );
        // (Past the canvas's half width the middle row is all blue.)
        if (r < 318) assert.ok(Math.abs(edge + 1 - 320 - r) <= 1.5, `frame ${f}: edge ${edge} vs radius ${r}`);
        else assert.equal(edge, 639);
        // Up the vertical too: a circle, not an ellipse.
        if (r < 175) {
          let top = 180;
          while (top > 0 && px(320, top - 1)[2] > 128) top--;
          assert.ok(Math.abs(180 - top - r) <= 1.5, `frame ${f}: top edge ${top} vs radius ${r}`);
        }
      }
      // Into a boxed clip (100, 50, 440 × 247.5): the circle is the canvas's, cut to the box.
      const boxed = movesPair(
        dir,
        { id: "a", type: "clip", media: "m-red", in: 30, duration: 60 },
        { id: "b", type: "clip", media: "m-blue", in: 30, duration: 60, transform: { x: 100, y: 50, w: 440 } },
        "transition.iris",
      );
      const inBox = runPlan(dir, boxed, "iris-boxed", { width: 640, height: 360 });
      const mid = rgbFrame(inBox.out, 60);
      assert.ok(isBlue(mid(320, 180)), `boxed mid-iris: centre ${mid(320, 180)}`);
      assert.ok(isRed(mid(130, 180)), `boxed mid-iris: in the box, outside the circle (190 px out) ${mid(130, 180)}`);
      const late = rgbFrame(inBox.out, 65);
      assert.ok(isBlue(late(130, 180)), `boxed late iris: in the box and the circle ${late(130, 180)}`);
      assert.ok(isRed(late(320, 320)), `boxed late iris: in the circle, below the box ${late(320, 320)}`);
      assert.ok(isRed(late(5, 5)), `boxed late iris: corner ${late(5, 5)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "ffmpeg transitions: a push slides both clips left by the share of the width, the incoming picture moving with its edge (D79)",
  { skip: skipFfmpeg, timeout: 120000 },
  () => {
    const dir = movesMedia();
    try {
      const project = movesPair(
        dir,
        { id: "a", type: "clip", media: "m-red", in: 30, duration: 60 },
        { id: "b", type: "clip", media: "m-ramp", in: 30, duration: 60 },
        "transition.push-left",
      );
      const { out, plan } = runPlan(dir, project, "push", { width: 640, height: 360 });
      // Geometry only over the push: a's last frames and b's first.
      assert.deepEqual(
        plan.visuals.map((l) => [l.item.id, l.f0, l.f1, !!l.geometry]),
        [
          ["a", 0, 50, false],
          ["a", 50, 70, true],
          ["b", 50, 70, true],
          ["b", 70, 120, false],
        ],
      );
      const after = rgbFrame(out, 80);
      for (const [f, share] of [
        [50, 0],
        [55, 0.25],
        [60, 0.5],
        [65, 0.75],
      ] as const) {
        const v = visualsAt(project, layout(project).starts, f).find((x) => x.item.id === "b")!;
        const left = Math.round(v.shift!);
        assert.equal(left, Math.round((1 - share) * 640));
        const px = rgbFrame(out, f);
        // B's left edge: red up to it, the ramp from it (red's R is high, the ramp's 0).
        let edge = 0;
        while (edge < 640 && px(edge, 180)[0] > 128) edge++;
        console.log(`  push frame ${f}: B's left edge at x ${edge}, core ${left}`);
        assert.ok(Math.abs(edge - left) <= 1, `frame ${f}: edge ${edge} vs ${left}`);
        // The picture moves with its edge: the ramp at x is the ramp at x − left once it's in place.
        for (const k of [20, 100, 150])
          if (left + k < 640)
            assert.ok(closeColour(px(left + k, 180), after(k, 180), 6), `frame ${f}: ramp at +${k}: ${px(left + k, 180)} vs ${after(k, 180)}`);
      }
      // The end: all ramp, in place.
      const end = rgbFrame(out, 70);
      for (const x of [5, 320, 630]) assert.ok(closeColour(end(x, 180), after(x, 180), 6), `frame 70 at ${x}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "ffmpeg transitions: a zoom grows the outgoing picture about the centre while the incoming one fades in over it (D79)",
  { skip: skipFfmpeg, timeout: 120000 },
  () => {
    const dir = movesMedia();
    try {
      // A white 4:3 still contained on the 16:9 canvas (black bars), zooming out into blue.
      const project = movesPair(
        dir,
        { id: "a", type: "clip", media: "m-white", duration: 60 },
        { id: "b", type: "clip", media: "m-blue", in: 30, duration: 60 },
        "transition.zoom",
      );
      const { out } = runPlan(dir, project, "zoom", { width: 640, height: 360 });
      for (const f of [50, 55, 60, 65, 69]) {
        const [a, b] = ["a", "b"].map((id) => visualsAt(project, layout(project).starts, f).find((v) => v.item.id === id)!);
        const zoom = a!.zoom ?? 1;
        const lit = a!.box!.content;
        const px = rgbFrame(out, f);
        // The white picture's left and right edges on the middle row: where core's zoomed box puts them
        // (while enough of it shows through the incoming clip to find them).
        const find = b!.opacity <= 0.75;
        let x0 = 0;
        while (x0 < 320 && px(x0, 180)[1] < 128 * (1 - b!.opacity) + 20) x0++;
        let x1 = 639;
        while (x1 > 320 && px(x1, 180)[1] < 128 * (1 - b!.opacity) + 20) x1--;
        console.log(
          `  zoom frame ${f}: scale ${zoom.toFixed(3)}, incoming opacity ${b!.opacity.toFixed(3)}; white from x ${x0} to ${x1 + 1}, core ${lit.x.toFixed(1)} to ${(lit.x + lit.w).toFixed(1)}`,
        );
        if (find)
          assert.ok(Math.abs(x0 - lit.x) <= 1.5 && Math.abs(x1 + 1 - (lit.x + lit.w)) <= 1.5, `frame ${f}: ${x0}–${x1 + 1} vs ${lit.x}–${lit.x + lit.w}`);
        // Opacity: white under blue at b's opacity in the picture, black under blue in the bars.
        const want = (under: number): Rgb => [
          Math.round(under * (1 - b!.opacity)),
          Math.round(under * (1 - b!.opacity)),
          Math.round(under * (1 - b!.opacity) + 255 * b!.opacity),
        ];
        assert.ok(closeColour(px(320, 180), want(255), 8), `frame ${f}: centre ${px(320, 180)} vs ${want(255)}`);
        if (lit.x > 6) assert.ok(closeColour(px(2, 180), want(0), 8), `frame ${f}: bar ${px(2, 180)} vs ${want(0)}`);
      }
      // At the midpoint exactly: 1.1× (white from 56 to 584) and half blue.
      const mid = visualsAt(project, layout(project).starts, 60);
      assert.ok(Math.abs(mid.find((v) => v.item.id === "a")!.zoom! - 1.1) < 1e-9);
      assert.ok(Math.abs(mid.find((v) => v.item.id === "b")!.opacity - 0.5) < 1e-9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("silentFailure: scaler and filter errors ffmpeg exits 0 on are export failures", () => {
  assert.match(silentFailure("frame=1\n[swscaler @ 0x1] Failed to allocate memory\n")!, /swscaler/);
  assert.match(silentFailure("x\nError while filtering: Cannot allocate memory\n")!, /Error while filtering/);
  assert.equal(silentFailure("[h264 @ 0x2] Reinit context\nframe=  10 fps\n"), undefined);
});
