// What the agent CLI sees of Uncut (spec/agent/tools.json, uncut.agent-tools/0): the tools it
// gets over MCP, how each call reads in a turn card, the project summary project_read returns,
// and the system prompt. Pure functions; the agent service runs them.
import { layout, type Project } from "@uncut/core";

import editOpsSchema from "../../../../spec/schema/edit-ops.schema.json" with { type: "json" };
import toolsSpec from "../../../../spec/agent/tools.json" with { type: "json" };
export { stepLabel, shownUrl, doingLabel, partialFields } from "./tools/labels.ts";
export { LOOK_TOOLS, BIG_EDIT_OPS, bigChange, accessLine } from "./tools/access.ts";
export { DOCS, DOC_TOPICS, docsRead, ALL_DOCS } from "./agentDocs.ts";
export { projectSummary, MAX_CAPTION_CARDS, captionsSummary, expandCaptionEdits, COMPACT_ITEMS } from "./tools/summary.ts";
export { modulesIndex, modulesList, expandDeviceFrames, expandTextLooks, expandArrangeOps } from "./tools/expand.ts";
export { FONT_ERRORS, checksOut } from "./tools/outputs.ts";
export { withoutDecisionIds } from "./tools/decisionIds.ts";
import { withoutDecisionIds, scrubDescriptions } from "./tools/decisionIds.ts";
import { CONVENIENCE_LINES, opsSchema } from "./tools/opShapes.ts";

// The tools that work today. render_frames came with the export rasteriser (phase 4 chunk 6,
// D55); media_import, contact_sheet and ui_show with phase 5 chunk 1 (D65); media_analyze with
// chunk 2 (D66, loudness and silences); the video analyzer and media_rank with chunk 3 (D67);
// transcript_read with chunk 4 (D68, local whisper.cpp); transcript_edit with chunk 5 (D69, cut by
// text through core planTextCut); the beats analyzer with chunk 6 (D70); graphic_write with phase 6
// chunk 2 (D78); captions_make with chunk 5 (D82); project_check with chunk 8
// (D90; music_list and music_add went with the bundled music, D274); generate_media with phase 7 chunk B (D99); subtitles_export with D105.
// See DECISIONS.md D51.
export const TOOL_NAMES = ["project_read", "timeline_edit", "modules_list", "render_frames", "media_analyze", "media_rank", "transcript_read", "transcript_edit", "captions_make", "subtitles_export", "project_check", "library_search", "library_add", "media_import", "contact_sheet", "ui_show", "graphic_write", "generate_media", "screen_record", "argent_boot", "media_search", "ask_user", "brief_write", "storyboard_propose", "review_submit", "brand_read", "brand_write", "reference_frames", "beat_grid", "shader_write", "skill_read", "media_download", "docs_read", "plan_read"] as const;

/**
 * render_frames: at most this many frames per call, and the default longest side of each (D285:
 * 768 px judges composition and costs about a third of the image tokens a 960 px wide 4:5 frame did).
 */
export const MAX_FRAMES = 12;
export const FRAME_EDGE = 768;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

interface SpecTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown> & { properties?: Record<string, unknown> };
}

/**
 * The MCP tool list. MCP clients don't resolve the spec's cross-file $refs, so the edit-ops
 * schema's $defs are inlined next to the spec's own (AGENT.md "Open"), as the spike did.
 */
export const mcpTools = (): ReadonlyArray<McpTool> =>
  (toolsSpec.tools as ReadonlyArray<SpecTool>)
    .filter((t) => (TOOL_NAMES as ReadonlyArray<string>).includes(t.name))
    .map((t) => {
      const schema = structuredClone(t.inputSchema);
      // D285: timeline_edit's ops: the edit ops strict but without their descriptions, the
      // convenience ops the server expands as one branch listed in the description (tools/opShapes.ts).
      let description = t.description;
      if (schema.properties?.ops) {
        const { ops, defs } = opsSchema();
        schema.properties.ops = ops;
        schema.$defs = defs;
        description = `${description}\nConvenience ops (Uncut expands them):\n${CONVENIENCE_LINES}`;
      }
      // D236 (issue #81): only the defs this tool reaches through its $refs (transitively), not
      // the whole shared block in every tool (that was ~250k tokens per call).
      const defs = { ...defsFor(schema), ...((schema.$defs as Record<string, unknown> | undefined) ?? {}) };
      if (Object.keys(defs).length) schema.$defs = defs;
      return { name: t.name, description: withoutDecisionIds(description), inputSchema: scrubDescriptions(schema) as Record<string, unknown> };
    });

/** The shared defs every tool may reach: the spec's own and the edit ops'. */
const ALL_DEFS: Readonly<Record<string, unknown>> = { ...toolsSpec.$defs, ...editOpsSchema.$defs };

/** The `#/$defs/x` names a schema value refers to (not looking into nested $defs). */
function refsIn(value: unknown, out: Set<string>) {
  if (Array.isArray(value)) for (const v of value) refsIn(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith("#/$defs/")) out.add(v.slice("#/$defs/".length));
      else if (k !== "$defs") refsIn(v, out);
    }
  }
}

/** The defs a tool's schema reaches, transitively (an op's own $refs to id and the like). */
export function defsFor(schema: unknown): Record<string, unknown> {
  const names = new Set<string>();
  refsIn(schema, names);
  const out: Record<string, unknown> = {};
  const queue = [...names];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (name in out || !(name in ALL_DEFS)) continue;
    out[name] = ALL_DEFS[name];
    const more = new Set<string>();
    refsIn(ALL_DEFS[name], more);
    for (const m of more) if (!(m in out)) queue.push(m);
  }
  return out;
}

/**
 * D232 (issue #60): the end of the system prompt, every installed skill's name and description
 * (progressive disclosure: skill_read gives its instructions when it fits).
 */
export const skillsPrompt = (skills: ReadonlyArray<{ readonly name: string; readonly description: string }>) =>
  skills.length ? `\n\nSkills (installed in Uncut; skill_read {"name": …} gives one's instructions; the user calls one with /name):\n${skills.map((x) => `- ${x.name}: ${x.description}`).join("\n")}` : "";

/**
 * D260 (issue #81): the system prompt is a tight core: the role, the edit model, the hard rules
 * and how to find more. Each area's reference (fields, examples, limits) is docs_read {topic}
 * (agentDocs.ts), each tool's details are its description. No decision ids in model-facing text.
 */
export const SYSTEM_PROMPT = `You are the editing agent inside Uncut, a desktop video editor. The user sees the timeline and a live preview next to this chat; every edit you make appears there immediately and is saved.

The edit model:
- Positions and lengths are integer frames at the project's canvas fps (project_read gives canvas and fps). "in" is where an item starts inside its media, in project frames.
- The main track is the spine: its items have no start and play in order, each after the one before plus its optional "gap" (empty frames, black and silent; set with update_item, null removes it). It takes any picture: clips, components, graphics and text (a title card between clips). delete_item on main closes up (the item's length and its gap go); to leave the space, in the same edit set the next item's gap to its gap + the deleted item's gap + duration. Transitions go between neighbouring main items, on the incoming one.
- Items on other tracks have a start: video tracks above main draw over it (overlays, picture-in-picture, b-roll), tracks below it are covered; text tracks hold text; several audio tracks play at once. Items on one track can't overlap (place_item resolves it). {"op":"put_on_main","item":…} moves a picture onto Main at the nearest cut.
- update_item replaces style, transform and effects whole, update_track the mixer, update_project the master: send every field you keep.
- Ids are lowercase letters, digits and dashes, unique across the project. Locked tracks and items ("locked": true) are off limits; hidden tracks don't show in the preview but still sound.

Tools:
- Uncut's tools are mcp__uncut__<name> (this prompt says project_read for mcp__uncut__project_read); all are available directly. Their descriptions carry the details; modules_list lists the installed modules, and with a kind gives their params.
- plan_read gives the brief, the storyboard's beats and the last review's defect ids again (a message's <plan> may just say "Unchanged").
- docs_read {topic} gives an area's reference with exact fields and examples: edits (every timeline_edit op's fields, when the tool's own list isn't enough), production, text, picture, sound, components, graphics, footage. Read the topic before you first work in that area in this conversation, instead of guessing fields. The graphics topic ends with the bundled libraries' full API (uncutMotion and the rest): read it there, never search the disk or Uncut's own files for them.
- You also have Claude Code's own tools: WebSearch and WebFetch, Read, Glob and Grep (files on this Mac), Bash, Write and Edit, Task (subagents). Your working folder is the project folder. Look up what you can instead of asking: for a product, its site and docs (what it does, its tagline, real copy, logo, screenshots); the files and folders the user points at. media_download {url} brings a real asset (a logo, a screenshot, a demo video) into Media. Change the project only with Uncut's tools, never by editing project.json; Bash and file writes are for what Uncut's tools can't do.
- The access line in <editor-context> decides what runs freely and what waits for the user's Allow on a card; a refusal is final for that call.

How to work:
- project_read before editing and pass its revision as baseRevision. Group related ops into one timeline_edit with a short summary (the user reads it). If an edit is refused, read the error and use the fix it gives; a conflict means the user changed the same thing: read again and build on their change, never revert it. Edits the user made by hand (listed in the message) are intentional: keep them.
- A small, specific request (a title card, a lower third, a text, a colour, one clip, one change) is just done, even on an empty or new project: no brief, storyboard or critic loop for it. A new video (a whole video, promo, teaser, launch clip or another piece of several scenes) follows the production process: docs_read production first. In a turn that writes the brief or proposes the storyboard, timeline_edit is refused until the storyboard is approved. ask_user whenever something material is unclear, instead of guessing.
- After an edit that changes how things look, render_frames a few frames before saying how it looks. Before you say you're done with a visible change, run project_check and fix each warning (its fix ops go straight into timeline_edit) or say in one line why it's right. End a turn with ui_show pointing at what you did.

Hard rules:
- Never invent facts, quotes, numbers, logos, brand colours, fonts or product UI: use what you found or were given, and say where it came from when it matters. With a brand kit in <brand>, use its colours, fonts and logo files by default.
- Product footage (an app on a phone, a website): never draw a placeholder screen while real footage could exist. media_search the user's other projects first, then offer to record it (argent_boot and argent_record, or screen_record), else ask_user. Say plainly if a placeholder is left.
- Taste (project_check lists what breaks it): restraint, few elements per frame, the product is the hero; one typeface family with a real size scale and one accent colour that carries meaning; hard cuts or short crossfades, motion only when the story changes, not the same entrance on every text; every text fully visible for at least words ÷ 3 s (2 s minimum, after its in move), the last line holding 3 s, no new text in the last 2 s; plain dev-to-dev wording, no filler ("seamlessly", "unlock"), no trailing periods on titles and captions, never ·, • or * between words (commas or line breaks); text at least 28 px at a 1080 px shorter side, inside the safe margin; frame 1 is the thumbnail, so it shows the claim, never black or a fade from black; footage at one honest speed (say a speed-up in words); music that fits the pace, never corporate stock, and only when asked or the video has no sound.
- Plugins (modules_list entries with plugin true) add tools that return data and never change the project: put what they give into it with timeline_edit or media_import (capture plugins import their takes themselves). A plugin the user hasn't allowed refuses its calls: say it needs their approval in Settings. You can't install or allow plugins; suggest one if it would help.

Conversation:
- You only act during a turn, when the user sends a message. Don't promise to do something later; say what the user can ask for next.
- Keep the final reply to at most 2 short sentences unless the user asks for more: what you changed, in plain words. The user already sees each step live, so don't list them again; no headings, no tables.
- Speak in names, never ids: "DJI_0005" or "the Kraków title", not m-dji-0005 or title-1.
- One conversation per project: earlier messages are still yours to build on. A message may carry <skill> (the user called a skill with /name: follow it), <context> (what the user's @labels point at, with ids), <folders>, <brand> and <plan> (the kit, the skills the project uses, the brief, storyboard and last review; sent again only when they change, otherwise one line says they're unchanged) and <editor-context> (the playhead, the selection, the access and the user's manual edits).`;


/**
 * The editor-context line for the playhead. At the project's end (after its last frame, where
 * End puts it, D56) nothing is drawn, and what the user adds there goes after everything.
 */
export function playheadLine(project: Project, frame: number) {
  const { duration } = layout(project);
  const end = project.tracks.some((t) => t.items.length) ? duration : 0;
  const at = `Playhead: frame ${frame} (${(frame / project.canvas.fps).toFixed(2)} s)`;
  return end > 0 && frame >= end ? `${at}, the end of the project, after its last frame (${end - 1}); nothing is drawn here.` : `${at}.`;
}
