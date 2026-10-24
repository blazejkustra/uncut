// Solid-colour clips for the transition tests (D73): Red.mp4 and Blue.mp4 (ffmpeg colour sources,
// plus Ramp.mp4, a horizontal gradient,
// BT.709 tagged, 10 s at 30 fps, 640×360), on a 640×360 canvas:
//   main: red (in 30, 60 f) | blue (in 30, 60 f), crossfade 20 | red-2 (in 30, 60 f), dip to black 20
//         | blue-2 (in 30, 60 f), wipe 20
// Cuts at 60, 120 and 180; every clip has 30 frames of handle on both sides. `expectedColour`
// composites what core visualsAt says is on screen at a frame and a point, from the clips' known
// colours, as the reference both the export and the preview are checked against.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { layout, visualsAt } from "../../packages/core/src/index.ts";
import type { Project } from "../../packages/core/src/timeline/types.ts";

export const RED: Rgb = [255, 0, 0];
export const BLUE: Rgb = [0, 0, 255];
export type Rgb = readonly [number, number, number];

export function makeTransitionMedia(root: string) {
  mkdirSync(root, { recursive: true });
  const bt709 = ["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
  for (const [name, colour] of [
    ["Red.mp4", "red"],
    ["Blue.mp4", "blue"],
  ] as const) {
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${colour}:s=640x360:r=30`,
      "-t",
      "10",
      ...bt709,
      "-c:v",
      "libx264",
      join(root, name),
    ]);
  }
  // A left-to-right ramp (green rises, blue falls across the width), for checking a wipe keeps the picture in place.
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=640x360:r=30,format=rgb24,geq=r='0':g='X*255/W':b='255-X*255/W'",
    "-t",
    "10",
    ...bt709,
    "-c:v",
    "libx264",
    "-crf",
    "10",
    join(root, "Ramp.mp4"),
  ]);
}

export function transitionProject(
  root: string,
  transitions: { crossfade?: number; dip?: number; wipe?: number } = { crossfade: 20, dip: 20, wipe: 20 },
): Project {
  const probe = { frames: 300, fps: 30, width: 640, height: 360, hasAudio: false };
  const tr = (module: string, duration: number | undefined) => (duration ? { transitionIn: { module, duration } } : {});
  return {
    format: "uncut/0",
    name: "Transitions",
    canvas: { width: 640, height: 360, fps: 30 },
    media: [
      { id: "m-red", kind: "video", name: "Red.mp4", path: join(root, "Red.mp4"), probe },
      { id: "m-blue", kind: "video", name: "Blue.mp4", path: join(root, "Blue.mp4"), probe },
    ],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "red", type: "clip", media: "m-red", in: 30, duration: 60 },
          { id: "blue", type: "clip", media: "m-blue", in: 30, duration: 60, ...tr("transition.crossfade", transitions.crossfade) },
          { id: "red-2", type: "clip", media: "m-red", in: 30, duration: 60, ...tr("transition.dip-to-black", transitions.dip) },
          { id: "blue-2", type: "clip", media: "m-blue", in: 30, duration: 60, ...tr("transition.wipe", transitions.wipe) },
        ],
      },
    ],
  };
}

/**
 * The colour core says is at frame f, at x (a fraction of the width): every visual over the canvas
 * colour, by its opacity and wipe, blended in the space the colours are given in (`palette`: the
 * clips' colours as a screenshot shows them, for the preview on a Display P3 screen).
 */
export function expectedColour(project: Project, f: number, x: number, palette: { readonly red: Rgb; readonly blue: Rgb } = { red: RED, blue: BLUE }): Rgb {
  let c: Array<number> = [128, 128, 128];
  for (const v of visualsAt(project, layout(project).starts, f)) {
    if (v.wipe !== undefined && x >= v.wipe) continue;
    const colour: Rgb = v.item.id.startsWith("dip:") ? [0, 0, 0] : v.item.media === "m-red" ? palette.red : palette.blue;
    c = c.map((k, i) => k * (1 - v.opacity) + colour[i]! * v.opacity);
  }
  return c.map(Math.round) as unknown as Rgb;
}

/** The checks: frame, x (fraction), what's there. Mid-crossfade, mid-dip on both sides, the black cut, mid-wipe on both sides. */
export const COLOUR_CHECKS: ReadonlyArray<readonly [number, number, string]> = [
  [30, 0.5, "red"],
  [55, 0.5, "a quarter into the crossfade"],
  [60, 0.5, "mid-crossfade"],
  [115, 0.5, "dipping: blue half dark"],
  [120, 0.5, "the dip's cut: black"],
  [125, 0.5, "coming up: red half dark"],
  [175, 0.1, "a quarter into the wipe: shown"],
  [175, 0.5, "a quarter into the wipe: not yet"],
  [180, 0.25, "mid-wipe: shown"],
  [180, 0.75, "mid-wipe: not yet"],
  [220, 0.5, "blue"],
];

/** The colour an 8-bit sRGB pixel should be within: yuv420p and the encoder move solid colours a little. */
export const close = (got: Rgb, want: Rgb, tolerance = 10) => got.every((g, i) => Math.abs(g - want[i]!) <= tolerance);

/** Red, then the ramp wiping in over 20 frames at the cut at 60 (a wipe's content must not shift). */
export function rampWipeProject(root: string): Project {
  const probe = { frames: 300, fps: 30, width: 640, height: 360, hasAudio: false };
  return {
    format: "uncut/0",
    name: "Ramp wipe",
    canvas: { width: 640, height: 360, fps: 30 },
    media: [
      { id: "m-red", kind: "video", name: "Red.mp4", path: join(root, "Red.mp4"), probe },
      { id: "m-ramp", kind: "video", name: "Ramp.mp4", path: join(root, "Ramp.mp4"), probe },
    ],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "red", type: "clip", media: "m-red", in: 30, duration: 60 },
          { id: "ramp", type: "clip", media: "m-ramp", in: 30, duration: 60, transitionIn: { module: "transition.wipe", duration: 20 } },
        ],
      },
    ],
  };
}

/**
 * Iris, push and zoom (D79) between solid colours, 640×360 at 30 fps, every clip with 30 frames of
 * handle: red | blue (iris 20) | red-2 (push 20) | green (a background, push 20) | blue-2 (zoom 20)
 * | green-2 (a background, iris 20). Cuts at 60, 120, 180, 240 and 300; 360 frames.
 */
export function movesProject(root: string): Project {
  const probe = { frames: 300, fps: 30, width: 640, height: 360, hasAudio: false };
  const tr = (module: string) => ({ transitionIn: { module, duration: 20 } });
  return {
    format: "uncut/0",
    name: "Moves",
    canvas: { width: 640, height: 360, fps: 30 },
    media: [
      { id: "m-red", kind: "video", name: "Red.mp4", path: join(root, "Red.mp4"), probe },
      { id: "m-blue", kind: "video", name: "Blue.mp4", path: join(root, "Blue.mp4"), probe },
    ],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "red", type: "clip", media: "m-red", in: 30, duration: 60 },
          { id: "blue", type: "clip", media: "m-blue", in: 30, duration: 60, ...tr("transition.iris") },
          { id: "red-2", type: "clip", media: "m-red", in: 30, duration: 60, ...tr("transition.push-left") },
          { id: "green", type: "component", component: "component.solid", duration: 60, props: { color: "#00ff00" }, ...tr("transition.push-left") },
          { id: "blue-2", type: "clip", media: "m-blue", in: 30, duration: 60, ...tr("transition.zoom") },
          { id: "green-2", type: "component", component: "component.solid", duration: 60, props: { color: "#00ff00" }, ...tr("transition.iris") },
        ],
      },
    ],
  };
}

export const GREEN: Rgb = [0, 255, 0];

/**
 * The colour core says is at frame f at (x, y) (fractions of the canvas) in a project of full-frame
 * solid colours: each visual covers the point unless a wipe, an iris or a push leaves it out (a zoom
 * of a full-frame colour changes nothing), blended by its opacity over the canvas grey.
 */
export function expectedAt(
  project: Project,
  f: number,
  x: number,
  y: number,
  palette: { readonly red: Rgb; readonly blue: Rgb; readonly green?: Rgb } = { red: RED, blue: BLUE },
): Rgb {
  const { width: W, height: H } = project.canvas;
  let c: Array<number> = [128, 128, 128];
  for (const v of visualsAt(project, layout(project).starts, f)) {
    if (v.wipe !== undefined && x >= v.wipe) continue;
    if (v.iris !== undefined && Math.hypot((x - 0.5) * W, (y - 0.5) * H) > (v.iris * Math.hypot(W, H)) / 2) continue;
    if (v.shift !== undefined && (x * W < v.shift || x * W >= v.shift + W)) continue;
    const colour: Rgb = v.item.id.startsWith("dip:")
      ? [0, 0, 0]
      : v.item.media === "m-red"
        ? palette.red
        : v.item.media === "m-blue"
          ? palette.blue
          : (palette.green ?? GREEN);
    c = c.map((k, i) => k * (1 - v.opacity) + colour[i]! * v.opacity);
  }
  return c.map(Math.round) as unknown as Rgb;
}

/** Frame, x, y (fractions), what's there: before, mid and late in each of the iris, the pushes and the zoom. */
export const MOVE_CHECKS: ReadonlyArray<readonly [number, number, number, string]> = [
  [30, 0.5, 0.5, "red"],
  [60, 0.5, 0.5, "mid-iris: the centre is blue"],
  [60, 0.02, 0.04, "mid-iris: a corner is still red"],
  [60, 0.75, 0.5, "mid-iris: inside the circle (160 px out)"],
  [60, 0.85, 0.5, "mid-iris: outside it (224 px out)"],
  [68, 0.97, 0.5, "late iris: past the half width, blue"],
  [115, 0.7, 0.5, "a quarter into the push: blue still left of 480"],
  [115, 0.8, 0.5, "a quarter into the push: red right of 480"],
  [120, 0.45, 0.5, "mid-push: blue pushed out left of 320"],
  [120, 0.55, 0.5, "mid-push: red in from 320"],
  [180, 0.45, 0.5, "mid-push into the background: red"],
  [180, 0.55, 0.5, "mid-push into the background: green"],
  [185, 0.3, 0.5, "late push: green from 160"],
  [235, 0.5, 0.5, "a quarter into the zoom: green under blue"],
  [240, 0.5, 0.5, "mid-zoom: half and half"],
  [270, 0.5, 0.5, "blue"],
  [300, 0.5, 0.5, "mid-iris into the background: green at the centre"],
  [300, 0.02, 0.04, "mid-iris into the background: blue in the corner"],
];
