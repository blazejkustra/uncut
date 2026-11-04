// D328: auto reframe's subject. Faces first (the largest face on each frame); a clip with no face
// anywhere follows the person matte's bounding box instead (worked out on a small copy of its
// frames). The results it reads are pinned while it runs, and a matte it made is kept for a while
// after (holdVision), so a second reframe doesn't make it again. Core planReframe then turns the
// subject into the clip's box and keys against the project as it is when the edit is made.
import { spawn } from "node:child_process";

import { withoutApiKey } from "../../app/shellEnv.ts";
import { localInputs } from "../../media/localInputs.ts";

import { type FaceFrames, type Item, type Project, type SubjectBox, facesAt, frameIndex, planReframe, visionProblem, visionRange } from "@uncut/core";

import { type ClipVisionTarget, ensureClipVision, holdVision, pinVision, requestId, VisionStopped, visionMediaPath } from "./clipVision.ts";
import { VisionFailure, type VisionAnalysis } from "./vision.ts";

/** The matte is read this many pixels wide to find the subject's box. */
const BOX_WIDTH = 96;

const largest = (faces: ReadonlyArray<SubjectBox>) => faces.reduce<SubjectBox | undefined>((a, f) => (!a || f.w * f.h > a.w * a.h ? f : a), undefined);

/** The box (0 to 1) of a grey frame's pixels above half, undefined when there are none. */
export function brightBox(frame: Uint8Array, w: number, h: number): SubjectBox | undefined {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (frame[y * w + x]! < 128) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  return x1 < 0 ? undefined : { x: x0 / w, y: y0 / h, w: (x1 + 1 - x0) / w, h: (y1 + 1 - y0) / h };
}

/** Every frame of a matte .mkv as its bright box, read small. */
function matteBoxes(ffmpeg: string, video: string, width: number, height: number, signal: AbortSignal): Promise<Array<SubjectBox | undefined>> {
  const w = BOX_WIDTH;
  const h = Math.max(2, Math.round((BOX_WIDTH * height) / width / 2) * 2);
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-threads",
      "4",
      "-i",
      video,
      "-vf",
      `scale=${w}:${h}:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "pipe:1",
    ];
    const child = spawn(ffmpeg, localInputs(ffmpeg, args), { env: withoutApiKey(process.env), stdio: ["ignore", "pipe", "pipe"] });
    const boxes: Array<SubjectBox | undefined> = [];
    let pending = Buffer.alloc(0);
    const size = w * h;
    child.stdout.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= size) {
        boxes.push(brightBox(new Uint8Array(pending.subarray(0, size)), w, h));
        pending = pending.subarray(size);
      }
    });
    const onAbort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (code === 0) resolve(boxes);
      else reject(new VisionFailure("failed", "ffmpeg couldn't read the matte to find the subject."));
    });
  });
}

const targetOf = async (project: Project, dir: string, item: Item, output: "matte" | "faces"): Promise<ClipVisionTarget> => {
  const media = project.media.find((m) => m.id === item.media)!;
  const range = visionRange(project, item);
  if (!range) throw new VisionFailure("invalid", "Uncut doesn't know this video's length yet, so it can't analyse it.");
  const request = { output, ...(output === "matte" ? { mode: "person" as const } : {}), ...range };
  return { ...request, media, path: await visionMediaPath(dir, media), dir, id: requestId(media.id, request) };
};

export type SubjectAt = (seconds: number) => SubjectBox | undefined;

/** Where a clip's subject is at each media second: faces found first (on the device, cached), else the person matte's box. */
export async function reframeSubject(
  vision: VisionAnalysis,
  project: Project,
  dir: string,
  itemId: string,
  ffmpeg: () => Promise<string | undefined>,
  signal: AbortSignal = new AbortController().signal,
): Promise<SubjectAt> {
  const item = project.tracks.flatMap((t) => t.items).find((i) => i.id === itemId);
  if (!item) throw new VisionFailure("invalid", "Pick a clip first.");
  const problem = visionProblem(project, item, "faces");
  if (problem) throw new VisionFailure("invalid", problem.replace("Face blur works", "Auto reframe works"));
  const faces = await ensureClipVision(vision, await targetOf(project, dir, item, "faces"), { signal });
  const release = pinVision([faces]);
  try {
    const result = faces.output === "faces" ? (faces.result as FaceFrames) : undefined;
    const byFace: SubjectAt = (s) => (result ? largest(facesAt(result, s)) : undefined);
    if (result?.frames.some((f) => f.faces.length)) return byFace;
    const matte = await ensureClipVision(vision, await targetOf(project, dir, item, "matte"), { signal });
    const held = pinVision([matte]);
    try {
      holdVision(matte);
      const bin = await ffmpeg();
      if (signal.aborted) throw new VisionStopped();
      if (matte.output !== "matte" || !bin) return byFace;
      const boxes = await matteBoxes(bin, matte.video, matte.info.width, matte.info.height, signal);
      return (s) => boxes[frameIndex(matte.info.times, s)];
    } finally {
      held();
    }
  } finally {
    release();
  }
}

/** The reframe edit of a clip in `project` from its subject (or why it can't be). */
export function reframePlan(project: Project, itemId: string, subjectAt: SubjectAt, zoom?: number | undefined) {
  const plan = planReframe(project, itemId, subjectAt, zoom !== undefined ? { zoom } : {});
  if ("problem" in plan) throw new VisionFailure("invalid", plan.problem);
  return plan;
}

/** The edit that reframes a clip to follow its subject on the project's canvas (or why it can't). */
export async function reframeEdit(
  vision: VisionAnalysis,
  project: Project,
  dir: string,
  itemId: string,
  ffmpeg: () => Promise<string | undefined>,
  options: { readonly zoom?: number | undefined; readonly signal?: AbortSignal | undefined; readonly latest?: (() => Project) | undefined } = {},
): Promise<{ readonly ops: ReadonlyArray<unknown>; readonly summary: string }> {
  const subject = await reframeSubject(vision, project, dir, itemId, ffmpeg, options.signal);
  return reframePlan(options.latest?.() ?? project, itemId, subject, options.zoom);
}
