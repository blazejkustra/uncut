// The clip box model's fixtures (D75). Split.mp4: 640×480, BT.709, 10 s at 30 fps, red on its left
// quarter and blue on the rest (so a zoom visibly moves the split line). Pattern.mp4: ffmpeg's
// testsrc2 at 1280×720 (texture for SSIM). On a 1280×720 canvas with a grey background:
//   main: "split" at x 100, y 200, w 640 (h from the 4:3 media: 480), fit cover, scale keyed
//         1 → 1.2 over its 90 frames.
// `expectedClipColour` composites what core visualsAt says is at a canvas point from the split
// clip's known colours, as the reference the export is checked against.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { layout, visualsAt } from "../../packages/core/src/index.ts";
import type { Project } from "../../packages/core/src/timeline/types.ts";
import type { Rgb } from "./transition-fixture.ts";

export const GREY: Rgb = [128, 128, 128];
const bt709 = ["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

export function makeClipMedia(root: string) {
  mkdirSync(root, { recursive: true });
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=640x480:r=30,drawbox=x=160:y=0:w=480:h=480:color=blue:t=fill",
    "-t",
    "10",
    ...bt709,
    "-c:v",
    "libx264",
    "-crf",
    "10",
    join(root, "Split.mp4"),
  ]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=1280x720:r=30",
    "-t",
    "10",
    ...bt709,
    "-c:v",
    "libx264",
    "-crf",
    "16",
    join(root, "Pattern.mp4"),
  ]);
}

export const SPLIT_PROBE = { frames: 300, fps: 30, width: 640, height: 480, hasAudio: false };
export const PATTERN_PROBE = { frames: 300, fps: 30, width: 1280, height: 720, hasAudio: false };

export function splitProject(root: string): Project {
  return {
    format: "uncut/0",
    name: "Split",
    canvas: { width: 1280, height: 720, fps: 30, background: "#808080" },
    media: [{ id: "m-split", kind: "video", name: "Split.mp4", path: join(root, "Split.mp4"), probe: SPLIT_PROBE }],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          {
            id: "split",
            type: "clip",
            media: "m-split",
            in: 0,
            duration: 90,
            transform: { x: 100, y: 200, w: 640, fit: "cover" },
            keys: [
              { frame: 0, scale: 1 },
              { frame: 90, scale: 1.2 },
            ],
          },
        ],
      },
    ],
  };
}

/** The split clip's colours (as given, or as a decoder reads them back) and the canvas grey. */
export interface ClipPalette {
  readonly red: Rgb;
  readonly blue: Rgb;
  readonly grey: Rgb;
}
export const NOMINAL: ClipPalette = { red: [255, 0, 0], blue: [0, 0, 255], grey: GREY };

/**
 * What core says is at canvas point (x, y) at frame f: the canvas grey under every boxed split clip
 * whose box holds the point, by its opacity. Also how far the point is from the nearest edge that
 * changes the colour (the box's edges and the split line), in canvas pixels.
 */
export function expectedClipColour(project: Project, f: number, x: number, y: number, palette: ClipPalette = NOMINAL): { colour: Rgb; margin: number } {
  let c: Array<number> = [...palette.grey];
  let margin = Infinity;
  for (const v of visualsAt(project, layout(project).starts, f)) {
    const b = v.box;
    if (!b) continue;
    margin = Math.min(margin, Math.abs(x - b.x), Math.abs(x - b.x - b.w), Math.abs(y - b.y), Math.abs(y - b.y - b.h));
    const split = b.content.x + 0.25 * b.content.w;
    margin = Math.min(margin, Math.abs(x - split));
    if (x < b.x || x >= b.x + b.w || y < b.y || y >= b.y + b.h) continue;
    const colour = (x - b.content.x) / b.content.w < 0.25 ? palette.red : palette.blue;
    c = c.map((k, i) => k * (1 - v.opacity) + colour[i]! * v.opacity);
  }
  return { colour: c.map(Math.round) as unknown as Rgb, margin };
}

/** Points to sample: inside left of the split, across where the zoom moves the split, the right part, inside the corners, just outside the box. */
export const CLIP_POINTS: ReadonlyArray<readonly [number, number, string]> = [
  [150, 300, "left part"],
  [244, 440, "where the zoom moves the split"],
  [600, 300, "right part"],
  [112, 212, "just inside the top-left corner"],
  [728, 668, "just inside the bottom-right corner"],
  [88, 400, "just left of the box"],
  [420, 700, "below the box"],
  [1000, 100, "far outside"],
];
