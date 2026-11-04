// D328, D329: timeline_edit's reframe, text_behind_subject and track ops, expanded into the edit ops
// that do them (core planReframe, from the clip's faces found on the device first;
// core planTextBehindSubject; core planTrack, from the tracker's boxes),
// planned against the project as the ops before them leave it. Other ops pass through. Vision only
// reads media files of the open project (clipVision.ts visionMediaPath, D12).
import { applyEdit, createSession, planTextBehindSubject, type Op, type Project } from "@uncut/core";

import { reframeEdit } from "../../analysis/vision/reframe.ts";
import { trackEdit } from "../../analysis/vision/track.ts";
import { VisionFailure, type VisionAnalysis } from "../../analysis/vision/vision.ts";

const KINDS = new Set(["reframe", "text_behind_subject", "track"]);
const ALLOWED: Readonly<Record<string, ReadonlyArray<string>>> = {
  reframe: ["op", "item", "zoom"],
  text_behind_subject: ["op", "texts"],
  track: ["op", "item", "target", "box", "at", "scale"],
};

const isBox = (box: unknown): box is { x: number; y: number; w: number; h: number } => {
  const b = box as Record<string, unknown> | null | undefined;
  return !!b && [b.x, b.y, b.w, b.h].every((v) => typeof v === "number" && Number.isFinite(v));
};

function trackShapeProblem(op: Record<string, unknown>): string | undefined {
  if (typeof op.item !== "string") return "item must be the id of a text, sticker or image.";
  if (typeof op.target !== "string") return "target must be a video clip's id.";
  if (!isBox(op.box)) return "box must be {x, y, w, h} in canvas px, round the object at the frame at.";
  if (!Number.isInteger(op.at)) return "at must be a timeline frame.";
  if (op.scale !== undefined && typeof op.scale !== "boolean") return "scale must be true or false.";
  return undefined;
}

type Expanded = { readonly ops: ReadonlyArray<unknown> } | { readonly problem: string };

export interface VisionOpsContext {
  /** The open project now: a vision op waits, and the user can edit meanwhile. */
  readonly current?: () => Project;
  /** Turns convenience ops earlier in the batch into edit ops, so what follows can be planned on their result. */
  readonly prepare?: (project: Project, ops: ReadonlyArray<unknown>) => Expanded;
}

function projectAfter(base: Project, ops: ReadonlyArray<unknown>, prepare: VisionOpsContext["prepare"]): Project | { readonly problem: string } {
  if (!ops.length) return base;
  const ready = prepare ? prepare(base, ops) : { ops };
  if ("problem" in ready) return ready;
  try {
    return applyEdit(createSession(base), { actor: "agent", ops: ready.ops as ReadonlyArray<Op> }).project;
  } catch (error) {
    return { problem: (error as Error).message };
  }
}

export async function expandVisionOps(
  project: Project,
  dir: string,
  ops: ReadonlyArray<unknown>,
  vision: VisionAnalysis,
  ffmpeg: () => Promise<string | undefined>,
  signal?: AbortSignal,
  context: VisionOpsContext = {},
): Promise<{ ops: Array<unknown>; notes: Array<string> } | { problem: string }> {
  if (!ops.some((op) => KINDS.has((op as { op?: unknown })?.op as string))) return { ops: [...ops], notes: [] };
  const out: Array<unknown> = [];
  const notes: Array<string> = [];
  for (const [i, raw] of ops.entries()) {
    const op = raw as Record<string, unknown>;
    if (!KINDS.has(op?.op as string)) {
      out.push(raw);
      continue;
    }
    const where = `ops[${i}] (${String(op.op)})`;
    const extra = Object.keys(op).filter((k) => !ALLOWED[op.op as string]!.includes(k));
    if (extra.length) return { problem: `${where}: unknown field ${extra.join(", ")}.` };
    const now = projectAfter(project, out, context.prepare);
    if ("problem" in now) return { problem: `${where}: the ops before it can't be applied: ${now.problem} Fix them, or send this op in its own call.` };
    const latest = () => {
      const after = projectAfter(context.current?.() ?? project, out, context.prepare);
      if ("problem" in after)
        throw new VisionFailure("invalid", `The project changed during the wait, so the ops before it can't be applied: ${after.problem}`);
      return after;
    };
    if (op.op === "text_behind_subject") {
      if (!Array.isArray(op.texts) || !op.texts.length || !op.texts.every((t) => typeof t === "string"))
        return { problem: `${where}: texts must be text item ids.` };
      const plan = planTextBehindSubject(now, op.texts as Array<string>);
      if ("problem" in plan) return { problem: `${where}: ${plan.problem}` };
      out.push(...plan.ops);
      continue;
    }
    if (op.op === "track") {
      const shape = trackShapeProblem(op);
      if (shape) return { problem: `${where}: ${shape}` };
      const ask = {
        item: op.item as string,
        target: op.target as string,
        frame: op.at as number,
        box: op.box as { x: number; y: number; w: number; h: number },
        scale: op.scale as boolean | undefined,
      };
      try {
        const plan = await trackEdit(vision, now, dir, ask, latest, signal);
        out.push(...plan.ops);
        if ("note" in plan && plan.note) notes.push(plan.note);
      } catch (error) {
        return { problem: `${where}: ${(error as Error).message}` };
      }
      continue;
    }
    if (typeof op.item !== "string") return { problem: `${where}: item must be a clip id.` };
    if (op.zoom !== undefined && !(typeof op.zoom === "number" && op.zoom >= 1 && op.zoom <= 4))
      return { problem: `${where}: zoom must be a number from 1 to 4.` };
    try {
      const plan = await reframeEdit(vision, now, dir, op.item, ffmpeg, { zoom: op.zoom as number | undefined, signal, latest });
      out.push(...plan.ops);
    } catch (error) {
      return { problem: `${where}: ${(error as Error).message}` };
    }
  }
  return { ops: out, notes };
}
