// A vision module standing in for a plugin: it answers matte and faces calls by writing the files a
// real module writes, so VisionAnalysis, its cache and everything above it run for real.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VisionAnalysis, type VisionCallResult } from "../../apps/server/src/analysis/vision/vision.ts";
import type { Item, Project } from "../../packages/core/src/index.ts";

export interface MatteSpec {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: number;
  /** geq's lum expression (X, Y, N). */
  readonly lum: string;
}

export interface FaceBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface FakeVisionOptions {
  readonly matte?: MatteSpec;
  readonly face?: (frame: number) => FaceBox;
  /** Waited for before answering a call. */
  readonly hold?: (tool: string, signal: AbortSignal) => Promise<void>;
  /** The module's error sentence, by tool. */
  readonly refuse?: Readonly<Record<string, string>>;
  /** No module is installed here. */
  readonly noModule?: boolean;
  /** The module is installed, but the user hasn't allowed it. */
  readonly disallowed?: boolean;
}

export type FakeCall = { readonly tool: string; readonly signal: AbortSignal } & Record<string, unknown>;

const MANIFEST = { id: "fake.vision", kind: "analyzer", analyzer: { inputs: ["video"], outputs: ["matte", "faces"], backend: "system" } };
const FACE_FPS = 30;

export const SMALL_MATTE: MatteSpec = { width: 64, height: 36, fps: 30, frames: 60, lum: "if(lt(X,32),255,0)" };

function writeMatte(out: string, m: MatteSpec) {
  const source = `color=c=black:s=${m.width}x${m.height}:r=${m.fps}:d=${m.frames / m.fps},format=gray,geq=lum='${m.lum}'`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-threads", "4", "-filter_threads", "4", "-f", "lavfi", "-i", source, "-c:v", "ffv1", "-threads", "4", "-f", "matroska", out]);
}

const facesJson = (args: Record<string, unknown>, face: FakeVisionOptions["face"]) => {
  const start = args.start as number;
  const end = args.end as number;
  const count = face ? Math.round((end - start) * FACE_FPS) : 0;
  const frames = Array.from({ length: count }, (_, i) => ({ t: start + i / FACE_FPS, faces: [{ id: 1, confidence: 0.9, ...face!(i) }] }));
  return { start, end, fps: FACE_FPS, width: 1920, height: 1080, frames };
};

const answered = (structured?: unknown): VisionCallResult => ({ content: [{ type: "text", text: "written" }], structured });

export function fakeVision(options: FakeVisionOptions = {}) {
  const calls: Array<FakeCall> = [];
  const matte = options.matte ?? SMALL_MATTE;
  const vision = new VisionAnalysis({
    candidates: async () => (options.noModule ? [] : [{ id: MANIFEST.id, name: "Fake", version: "1.0.0", allowed: !options.disallowed, manifest: MANIFEST }]),
    call: async (_id, tool, args, { signal }) => {
      if (tool === "version") return { content: [] };
      calls.push({ tool, signal, ...args });
      await options.hold?.(tool, signal);
      const refusal = options.refuse?.[tool];
      if (refusal) return { isError: true, content: [{ type: "text", text: refusal }] };
      if (signal.aborted) return { content: [] };
      if (tool === "faces") {
        writeFileSync(args.out as string, JSON.stringify(facesJson(args, options.face)));
        return answered({});
      }
      writeMatte(args.out as string, matte);
      const times = Array.from({ length: matte.frames }, (_, i) => i / matte.fps);
      return answered({ width: matte.width, height: matte.height, fps: matte.fps, frames: matte.frames, times });
    },
    ffmpeg: async () => "ffmpeg",
    platform: "macos-arm64",
  });
  return { vision, calls };
}

export function visionFolder() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-vision-")));
  const dir = join(root, "P.uncut");
  mkdirSync(dir);
  writeFileSync(join(dir, "project.json"), "{}");
  const media = join(root, "talk.mp4");
  writeFileSync(media, Buffer.alloc(4096, 3));
  return { root, dir, media, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export const CUTOUT_PERSON = { module: "effect.cutout", params: { mode: "person" } };
export const FACE_BLUR_ON = { module: "effect.face-blur", params: { amount: 8 } };

/** One 2 s clip "c" of a 1920×1080 video on a vertical canvas. */
export function oneClipProject(path: string, clip: Partial<Item> = {}): Project {
  return {
    format: "uncut/0",
    name: "Vision",
    canvas: { width: 1080, height: 1920, fps: 30 },
    media: [{ id: "m", kind: "video", name: "talk.mp4", path, probe: { frames: 60, fps: 30, width: 1920, height: 1080, hasAudio: false } }],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c", type: "clip", media: "m", in: 0, duration: 60, ...clip } as Item] }],
  };
}

/** Past the short pin a finished run holds for those waiting on it. */
export async function afterRunSettled() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

export function deferred() {
  let open = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}
