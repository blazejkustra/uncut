import { type Project, type TrackAsk, type TrackFrame, planTrack, trackRequest } from "@uncut/core";

import { type ClipVisionResult, type ClipVisionTarget, ensureClipVision, requestId, visionMediaPath } from "./clipVision.ts";
import { VisionFailure, type VisionAnalysis } from "./vision.ts";

export interface TrackJobAsk extends TrackAsk {
  readonly scale?: boolean | undefined;
}

export async function trackTarget(project: Project, dir: string, ask: TrackJobAsk): Promise<ClipVisionTarget> {
  const request = trackRequest(project, ask);
  if ("problem" in request) throw new VisionFailure("invalid", request.problem);
  const clip = project.tracks.flatMap((t) => t.items).find((i) => i.id === ask.target)!;
  const media = project.media.find((m) => m.id === clip.media)!;
  const target = { output: "track" as const, start: request.start, end: request.end, box: request.box };
  return { ...target, media, path: await visionMediaPath(dir, media), dir, id: `${requestId(media.id, target)}|${ask.item}` };
}

const framesOf = (made: ClipVisionResult): ReadonlyArray<TrackFrame> => (made.output === "track" ? made.result.frames : []);

export function trackPlan(project: Project, ask: TrackJobAsk, target: Pick<ClipVisionTarget, "start">, made: ClipVisionResult) {
  const plan = planTrack(project, { item: ask.item, target: ask.target, start: target.start, scale: ask.scale }, framesOf(made));
  if ("problem" in plan) throw new VisionFailure("invalid", plan.problem);
  return plan;
}

export async function trackEdit(vision: VisionAnalysis, project: Project, dir: string, ask: TrackJobAsk, latest: () => Project, signal?: AbortSignal) {
  const target = await trackTarget(project, dir, ask);
  const made = await ensureClipVision(vision, target, { signal });
  return trackPlan(latest(), ask, target, made);
}
