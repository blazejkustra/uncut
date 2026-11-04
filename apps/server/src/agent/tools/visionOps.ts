// D328: timeline_edit's reframe and text_behind_subject ops, expanded into the edit ops that do them
// (core planReframe, from the clip's faces found on the device first; core planTextBehindSubject),
// planned against the project as the ops before them leave it. Other ops pass through. Vision only
// reads media files of the open project (clipVision.ts visionMediaPath, D12).
import { applyEdit, createSession, planTextBehindSubject, type Op, type Project } from "@uncut/core";

import { reframeEdit } from "../../analysis/vision/reframe.ts";
import type { VisionAnalysis } from "../../analysis/vision/vision.ts";

const KINDS = new Set(["reframe", "text_behind_subject"]);

export async function expandVisionOps(
  project: Project,
  dir: string,
  ops: ReadonlyArray<unknown>,
  vision: VisionAnalysis,
  ffmpeg: () => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<{ ops: Array<unknown> } | { problem: string }> {
  if (!ops.some((op) => KINDS.has((op as { op?: unknown })?.op as string))) return { ops: [...ops] };
  const out: Array<unknown> = [];
  for (const [i, raw] of ops.entries()) {
    const op = raw as Record<string, unknown>;
    if (!KINDS.has(op?.op as string)) {
      out.push(raw);
      continue;
    }
    const where = `ops[${i}] (${String(op.op)})`;
    const allowed = op.op === "reframe" ? ["op", "item", "zoom"] : ["op", "texts"];
    const extra = Object.keys(op).filter((k) => !allowed.includes(k));
    if (extra.length) return { problem: `${where}: unknown field ${extra.join(", ")}.` };
    const now = out.length ? applyEdit(createSession(project), { actor: "agent", ops: out as ReadonlyArray<Op> }).project : project;
    if (op.op === "text_behind_subject") {
      if (!Array.isArray(op.texts) || !op.texts.length || !op.texts.every((t) => typeof t === "string")) return { problem: `${where}: texts must be text item ids.` };
      const plan = planTextBehindSubject(now, op.texts as Array<string>);
      if ("problem" in plan) return { problem: `${where}: ${plan.problem}` };
      out.push(...plan.ops);
      continue;
    }
    if (typeof op.item !== "string") return { problem: `${where}: item must be a clip id.` };
    if (op.zoom !== undefined && !(typeof op.zoom === "number" && op.zoom >= 1 && op.zoom <= 4)) return { problem: `${where}: zoom must be a number from 1 to 4.` };
    try {
      const plan = await reframeEdit(vision, now, dir, op.item, ffmpeg, { zoom: op.zoom as number | undefined, signal });
      out.push(...plan.ops);
    } catch (error) {
      return { problem: `${where}: ${(error as Error).message}` };
    }
  }
  return { ops: out };
}
