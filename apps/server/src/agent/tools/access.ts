// D184: what the turn's access lets the agent's tools do, and how it's told.
import { type Project, describeOp, type Op } from "@uncut/core";
import { stepLabel } from "./labels.ts";

/** D184: the tools a "Look only" chat may use: they read, look and point, and change nothing. */
export const LOOK_TOOLS = [
  "project_read",
  "modules_list",
  "render_frames",
  "media_analyze",
  "media_rank",
  "transcript_read",
  "project_check",
  "library_search",
  "media_search",
  "contact_sheet",
  "ui_show",
  "ask_user",
  "brief_write",
  "storyboard_propose",
  "review_submit",
  "brand_read",
  "reference_frames",
  "beat_grid",
  "skill_read",
  "docs_read",
  "plan_read",
  "project_peek",
  "measure",
  "graphic_elements",
] as const;

/** D184: more ops than this in one timeline_edit is a big change in "Ask first". */
export const BIG_EDIT_OPS = 12;

/**
 * D184: whether a call is a big change that "Ask first" puts on a card first: a
 * timeline_edit that removes items, tracks or media, changes the project's settings or has more
 * than BIG_EDIT_OPS ops; a transcript_edit that cuts (not a dry run). The card's words, or undefined.
 */
export function bigChange(tool: string, input: Record<string, unknown>, project: Project): { text: string; lines: Array<string> } | undefined {
  if (tool === "transcript_edit" && input.dryRun !== true) return { text: stepLabel(tool, input).replace(/^Cut /, "Cut "), lines: [] };
  if (tool !== "timeline_edit" || !Array.isArray(input.ops) || input.dryRun === true) return undefined;
  const ops = input.ops as ReadonlyArray<{ op?: unknown }>;
  const removes = ops.some((o) => typeof o?.op === "string" && (o.op.startsWith("delete_") || o.op === "update_project"));
  if (!removes && ops.length <= BIG_EDIT_OPS) return undefined;
  const lines = ops.slice(0, 8).map((op) => {
    try {
      return describeOp(op as Op, project);
    } catch {
      return String(op?.op ?? "edit");
    }
  });
  if (ops.length > 8) lines.push(`and ${ops.length - 8} more`);
  const summary = typeof input.summary === "string" && input.summary.trim() ? input.summary.trim() : "an edit";
  return { text: `Apply "${summary.slice(0, 120)}" (${ops.length === 1 ? "1 change" : `${ops.length} changes`})`, lines };
}

/** D184, D194: the access line of the message's <editor-context> (issue #106: Auto in Codex's words for Codex). */
export function accessLine(access: "look" | "ask" | "auto", provider: "claude" | "codex" = "claude"): string {
  if (access === "look")
    return "Access: Look only. You may read files, search and read the web, look, point (ui_show), ask (ask_user) and plan (brief_write, storyboard_propose) and ask for a review (review_submit), but don't run commands, write files or change the timeline, the media, the brand kit or graphics; say what you would do.";
  if (access === "ask")
    return `Access: Ask first. Commands (Bash), file writes outside the project's .cache, removing items, tracks or media, cutting by transcript and edits of more than ${BIG_EDIT_OPS} ops wait for the user's Allow on a card; reading, the web and small edits don't. If they say no, don't retry it in this turn.`;
  if (provider === "codex")
    return "Access: Auto. Commands and file writes inside the project run in Codex's sandbox without asking; anything beyond it (the network, files outside the project, Uncut's own files) asks the user first or is refused.";
  return "Access: Auto. Claude Code approves routine commands and file writes inside the project itself; writing outside the project, Uncut's own files, deleting, sudo, git push and uploads are refused or ask the user first.";
}
