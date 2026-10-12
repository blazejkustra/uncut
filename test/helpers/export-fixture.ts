// A small project for the export tests, made from ffmpeg-generated media with known content:
// two picture clips with tones (A: testsrc2 + 660 Hz, B: mandelbrot + 880 Hz, both at half
// scale), a 4:3 test-pattern clip without sound (C) and 440 Hz music at half scale.
//   main:    title card (solid, 45 f) | A from 0 (60 f) | A from 90 (45 f: a split with a trimmed
//            in-point) | B from 15 (90 f) with a 20-frame crossfade
//   overlay: C at 100 for 40 f (letterboxed over the main track), fading in over 10 f; a still
//            (Still.png) at 215 for 25 f fading in over 20 f
//   text:    a title over the card with a 10-frame fade in; a lower third at 150 rising in
//   audio:   the music from 0 for 240 f at −6 dB with 30-frame fades
// At 30 fps on a 1920×1080 canvas the export is 240 frames (8 s).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Project } from "../../packages/core/src/types.ts";

export const FPS = 30;

/** Make the media in `root` (once) and return a project.json body for a project in `root`. */
export function makeExportFixture(root: string): Project {
  mkdirSync(root, { recursive: true });
  const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  const tone = (hz: number) => `aevalsrc=0.5*sin(2*PI*${hz}*t):s=48000`;
  // Tagged BT.709 like a camera's or phone's footage, so the preview and ffmpeg read the colours alike.
  const bt709 = ["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
  ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", tone(660), "-t", "10", ...bt709, "-c:v", "libx264", "-c:a", "aac", "-b:a", "192k", "-shortest", join(root, "A.mp4"));
  ff("-f", "lavfi", "-i", "mandelbrot=size=640x360:rate=30", "-f", "lavfi", "-i", tone(880), "-t", "6", ...bt709, "-c:v", "libx264", "-c:a", "aac", "-b:a", "192k", "-shortest", join(root, "B.mp4"));
  ff("-f", "lavfi", "-i", "testsrc=size=480x360:rate=30", "-t", "4", ...bt709, "-c:v", "libx264", join(root, "C.mp4"));
  ff("-f", "lavfi", "-i", "testsrc=size=640x360", "-frames:v", "1", join(root, "Still.png"));
  ff("-f", "lavfi", "-i", `${tone(440)}:d=10`, "-c:a", "aac", "-b:a", "192k", join(root, "Music.m4a"));
  return exportProject(root);
}

/** The project over the media in `root` (see the header). */
export function exportProject(root: string): Project {
  return {
    format: "uncut/0",
    name: "Export test",
    canvas: { width: 1920, height: 1080, fps: FPS },
    media: [
      { id: "m-a", kind: "video", name: "A.mp4", path: join(root, "A.mp4"), probe: { frames: 300, fps: 30, width: 640, height: 360, hasAudio: true } },
      { id: "m-b", kind: "video", name: "B.mp4", path: join(root, "B.mp4"), probe: { frames: 180, fps: 30, width: 640, height: 360, hasAudio: true } },
      { id: "m-c", kind: "video", name: "C.mp4", path: join(root, "C.mp4"), probe: { frames: 120, fps: 30, width: 480, height: 360, hasAudio: false } },
      { id: "m-still", kind: "image", name: "Still.png", path: join(root, "Still.png"), probe: { width: 640, height: 360, hasAudio: false } },
      { id: "m-music", kind: "audio", name: "Music.m4a", path: join(root, "Music.m4a"), probe: { frames: 300, hasAudio: true } },
    ],
    tracks: [
      {
        id: "text",
        kind: "text",
        name: "Text",
        items: [
          { id: "title", type: "text", start: 0, duration: 45, text: "Export [[test]]", style: { preset: "text.title" }, animation: { in: { module: "move.fade", duration: 10 } } },
          { id: "lower", type: "text", start: 150, duration: 60, text: "A lower third", style: { preset: "text.lower-third" }, animation: { in: { module: "move.rise", duration: 12 } } },
        ],
      },
      { id: "overlay", kind: "video", name: "Overlay", items: [
          { id: "bars", type: "clip", media: "m-c", in: 0, start: 100, duration: 40, animation: { in: { module: "move.fade", duration: 10 } } },
          { id: "still", type: "clip", media: "m-still", start: 215, duration: 25, animation: { in: { module: "move.fade", duration: 20 } } },
        ],
      },
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "card", type: "component", component: "component.solid", duration: 45, props: { color: "#0B1D3A", to: "#3A0B2E", angle: 135 } },
          { id: "a1", type: "clip", media: "m-a", in: 0, duration: 60 },
          { id: "a2", type: "clip", media: "m-a", in: 90, duration: 45 },
          { id: "b", type: "clip", media: "m-b", in: 15, duration: 90, transitionIn: { module: "transition.crossfade", duration: 20 } },
        ],
      },
      { id: "audio", kind: "audio", name: "Audio", items: [{ id: "music", type: "audio", media: "m-music", in: 0, start: 0, duration: 240, gainDb: -6, fadeIn: 30, fadeOut: 30 }] },
    ],
  };
}

/** Write `project` as `<root>/<name>.uncut/project.json`; returns the project folder. */
export function writeProject(root: string, name: string, project: Project) {
  const dir = join(root, `${name}.uncut`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.json"), JSON.stringify(project, null, 2));
  return dir;
}
