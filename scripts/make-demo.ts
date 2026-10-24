// Builds a demo .uncut project from real drone footage (paths are referenced, never copied).
// Usage: node scripts/make-demo.ts <footage.mp4> [out dir] (pnpm demo), or with UNCUT_FOOTAGE=<footage.mp4>.
// Tests build their own copy (test/helpers/demo.ts).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { Item, MediaProbe, Project } from "../packages/core/src/timeline/types.ts";

const FPS = 60;
const footage = process.argv[2] ?? process.env.UNCUT_FOOTAGE;
if (!footage) {
  console.error("Usage: node scripts/make-demo.ts <footage.mp4> [out dir]  (or set UNCUT_FOOTAGE)");
  process.exit(2);
}
const src = resolve(footage);
const out = resolve(process.argv[3] ?? "fixtures/drone-demo.uncut");

interface FfprobeStream {
  codec_type: string;
  width: number;
  height: number;
  r_frame_rate: string;
}

export function probe(path: string, fps = FPS): MediaProbe {
  const j = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration", "-of", "json", path], {
      encoding: "utf8",
    }),
  ) as {
    streams: Array<FfprobeStream>;
    format: { duration: string };
  };
  const v = j.streams.find((s) => s.codec_type === "video")!;
  const [n, d] = v.r_frame_rate.split("/").map(Number) as [number, number];
  return {
    frames: Math.floor(Number(j.format.duration) * fps),
    fps: +(n / d).toFixed(3),
    width: v.width,
    height: v.height,
    hasAudio: j.streams.some((s) => s.codec_type === "audio"),
  };
}

const s = (sec: number) => Math.round(sec * FPS);
const shot = (id: string, at: number, len: number): Item => ({ id, type: "clip", media: "m-flight", in: s(at), duration: s(len) });
const fade = { module: "transition.crossfade", duration: 30 };

const project: Project = {
  format: "uncut/0",
  name: "First flight",
  canvas: { width: 3840, height: 2160, fps: FPS },
  media: [{ id: "m-flight", kind: "video", name: basename(src), path: src, probe: probe(src) }],
  tracks: [
    {
      id: "t1",
      kind: "text",
      name: "Text",
      items: [
        {
          id: "txt-title",
          type: "text",
          start: s(0.5),
          duration: s(4.5),
          text: "First flight",
          transform: { x: 240, y: 1500 },
          style: { preset: "text.title", size: 220, weight: 650, color: "fg" },
          animation: { in: { module: "move.fade", duration: 20 } },
        },
        {
          id: "txt-city",
          type: "text",
          start: s(6.5),
          duration: s(4),
          text: "Kraków from above",
          transform: { x: 240, y: 1800 },
          style: { preset: "text.lower-third", size: 110, weight: 600, color: "fg" },
        },
      ],
    },
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        shot("reveal", 20, 6),
        { ...shot("city", 35, 6), transitionIn: fade },
        shot("above", 92, 5),
        { ...shot("quarry", 125, 6), transitionIn: fade },
        shot("orbit", 182, 7),
        shot("bench", 318, 5),
      ],
    },
  ],
};

mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "project.json"), JSON.stringify(project, null, 2) + "\n");
console.log(out);
