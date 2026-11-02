// The export goldens: small projects made from generated media, exported through the packaged app.
// High quality goes through libx264, which is deterministic, so every frame's hash must match.
// Standard goes through VideoToolbox, which isn't, so key frames are held to an SSIM bar instead.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { shaderEntry, type Project, type ShaderParam } from "../../packages/core/src/index.ts";
import { buildShader } from "../../apps/server/src/plugins/shaderBuild.ts";
import { makeClipMedia, splitProject } from "../../test/helpers/clip-fixture.ts";
import { makeExportFixture } from "../../test/helpers/export-fixture.ts";
import { makeColours } from "../../test/helpers/fx-fixture.ts";

export interface GoldenItem {
  readonly id: string;
  readonly title: string;
  readonly quality: "standard" | "high";
  readonly compare: "hash" | "ssim";
  readonly minSsim: number;
  readonly frames: number;
  readonly hasAudio: boolean;
  readonly keyFrames: ReadonlyArray<number>;
  readonly flashes?: number;
  /** The file's name in the footage folder; the item is skipped when it isn't there. */
  readonly footage?: string;
  readonly project: (root: string, footageDir: string) => Project;
}

const FPS = 30;

function syncProject(root: string): Project {
  const media = join(root, "sync.mp4");
  if (!existsSync(media)) {
    mkdirSync(root, { recursive: true });
    const flash = "color=black:s=640x360:r=30,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(mod(n\\,30)\\,15)'";
    const beep = "aevalsrc='0.6*sin(2*PI*1000*t)*lt(mod(t-0.5\\,1)\\,0.0333)':s=48000:d=6";
    const encode = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-t", "6"];
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", flash, "-f", "lavfi", "-i", beep, ...encode, media]);
  }
  return {
    format: "uncut/0",
    name: "Sync",
    canvas: { width: 1280, height: 720, fps: FPS },
    media: [{ id: "m-sync", kind: "video", name: "sync.mp4", path: media, probe: { frames: 180, fps: FPS, width: 640, height: 360, hasAudio: true } }],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "first", type: "clip", media: "m-sync", in: 0, duration: 75 },
          { id: "second", type: "clip", media: "m-sync", in: 100, duration: 75 },
        ],
      },
    ],
  };
}

const SHADER_PARAMS: ReadonlyArray<ShaderParam> = [{ key: "amplitude", label: "Amplitude", type: "number", min: 0, max: 0.05, default: 0.02 }];
const SHADER_BODY = `(uv, t, size, p) {
  let c = uv - vec2f(0.5);
  let d = length(c * vec2f(size.x / size.y, 1.0));
  let off = normalize(c + vec2f(0.00001)) * sin(d * 40.0 - t * 8.0) * p.amplitude;
  return vec4f(frame(uv + off).rgb, 1.0);
}`;

function shaderProject(root: string): Project {
  mkdirSync(root, { recursive: true });
  const media = join(root, "Colours.mp4");
  if (!existsSync(media)) makeColours(media);
  const built = buildShader(SHADER_PARAMS, SHADER_BODY);
  if (!("wgsl" in built)) throw new Error(`the golden's shader doesn't build: ${built.problems.join("; ")}`);
  const def = { id: "project.golden-ripple", name: "Golden ripple", params: SHADER_PARAMS, wgsl: built.wgsl };
  return {
    format: "uncut/0",
    name: "Shader",
    canvas: { width: 640, height: 360, fps: FPS },
    media: [{ id: "m-c", kind: "video", name: "Colours.mp4", path: media, probe: { frames: 60, fps: FPS, width: 640, height: 360, hasAudio: false } }],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [{ id: "c1", type: "clip", media: "m-c", in: 0, duration: 30, effects: [shaderEntry(def, { amplitude: 0.02 })] }],
      },
    ],
  };
}

function clipBoxProject(root: string) {
  if (!existsSync(join(root, "Split.mp4"))) makeClipMedia(root);
  return splitProject(root);
}

function timelineProject(root: string) {
  return makeExportFixture(root);
}

const FOOTAGE_CLIP = "first-flight.mp4";

function footageProject(_root: string, footageDir: string): Project {
  const path = join(footageDir, FOOTAGE_CLIP);
  return {
    format: "uncut/0",
    name: "Footage",
    canvas: { width: 1920, height: 1080, fps: FPS },
    media: [{ id: "m-f", kind: "video", name: FOOTAGE_CLIP, path, probe: { frames: 1530, fps: FPS, width: 1920, height: 1080, hasAudio: true } }],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "f1", type: "clip", media: "m-f", in: 300, duration: 90 }] }],
  };
}

export const GOLDEN_ITEMS: ReadonlyArray<GoldenItem> = [
  {
    id: "clip-box",
    title: "A boxed clip with a keyed zoom, every frame",
    quality: "high",
    compare: "hash",
    minSsim: 1,
    frames: 90,
    hasAudio: true,
    keyFrames: [0, 45, 89],
    project: clipBoxProject,
  },
  {
    id: "timeline-high",
    title: "Clips, cut, crossfade, overlays, text and music at High",
    quality: "high",
    compare: "hash",
    minSsim: 1,
    frames: 240,
    hasAudio: true,
    keyFrames: [20, 75, 120, 165, 225],
    project: timelineProject,
  },
  {
    id: "timeline-standard",
    title: "The same timeline at Standard, hardware encoded",
    quality: "standard",
    compare: "ssim",
    minSsim: 0.97,
    frames: 240,
    hasAudio: true,
    keyFrames: [20, 75, 120, 165, 225],
    project: timelineProject,
  },
  {
    id: "av-sync",
    title: "Flashes and beeps stay together across a cut",
    quality: "standard",
    compare: "ssim",
    minSsim: 0.97,
    frames: 150,
    hasAudio: true,
    keyFrames: [15, 80],
    flashes: 5,
    project: syncProject,
  },
  {
    id: "shader",
    title: "A WebGPU shader effect drawn by the rasteriser",
    quality: "high",
    compare: "hash",
    minSsim: 1,
    frames: 30,
    hasAudio: true,
    keyFrames: [0, 12, 23],
    project: shaderProject,
  },
  {
    id: "footage",
    title: "Three seconds of real footage",
    quality: "standard",
    compare: "ssim",
    minSsim: 0.95,
    frames: 90,
    hasAudio: true,
    keyFrames: [0, 45, 89],
    footage: FOOTAGE_CLIP,
    project: footageProject,
  },
];
