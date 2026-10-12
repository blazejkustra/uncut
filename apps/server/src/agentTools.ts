// What the agent CLI sees of Uncut (spec/agent/tools.json, uncut.agent-tools/0): the tools it
// gets over MCP, how each call reads in a turn card, the project summary project_read returns,
// and the system prompt. Pure functions; the agent service runs them.
import { layout, type ModuleManifest, type Modules, type Project } from "@uncut/core";

import editOpsSchema from "../../../spec/schema/edit-ops.schema.json" with { type: "json" };
import toolsSpec from "../../../spec/agent/tools.json" with { type: "json" };

// The tools that work today. render_frames and contact_sheet need the export rasteriser
// (phase 4 chunk 6); media_analyze, transcript_read, media_import, generate_media and ui_show
// come with their features. See DECISIONS.md D51.
export const TOOL_NAMES = ["project_read", "timeline_edit", "modules_list"] as const;
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
      if (schema.properties?.ops) schema.properties.ops = { type: "array", minItems: 1, items: { $ref: "#/$defs/op" } };
      schema.$defs = { ...toolsSpec.$defs, ...editOpsSchema.$defs };
      return { name: t.name, description: t.description, inputSchema: schema };
    });

/** A tool call as a step in the turn card. */
export function stepLabel(tool: string, input: unknown): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  switch (tool) {
    case "project_read":
      return "Read the timeline";
    case "timeline_edit":
      return typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "Edited the timeline";
    case "modules_list":
      return typeof args.kind === "string" ? `Checked the ${args.kind} modules` : "Checked the installed modules";
    default:
      return `Used ${tool}`;
  }
}

/**
 * project_read's summary: tracks with every item (main-track items get their resolved start),
 * the media with its probe, the length, and the revision to pass back as baseRevision.
 */
export function projectSummary(project: Project, revision: number, range?: { start: number; end: number }) {
  const { starts, duration } = layout(project);
  const end = project.tracks.some((t) => t.items.length) ? duration : 0;
  const fps = project.canvas.fps;
  const inRange = (id: string, length: number) => {
    const start = starts.get(id) ?? 0;
    return !range || (start < range.end && start + length > range.start);
  };
  return {
    revision,
    name: project.name,
    canvas: project.canvas,
    duration: end,
    seconds: Number((end / fps).toFixed(2)),
    media: project.media.map((m) => ({
      id: m.id,
      kind: m.kind,
      name: m.name,
      ...(m.probe ? { probe: m.probe } : {}),
      ...(m.probe?.frames ? { seconds: Number((m.probe.frames / fps).toFixed(2)) } : {}),
    })),
    tracks: project.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      ...(t.role ? { role: t.role } : {}),
      ...(t.name ? { name: t.name } : {}),
      ...(t.hidden ? { hidden: true } : {}),
      items: t.items.filter((it) => inRange(it.id, it.duration)).map((it) => ({ ...it, start: starts.get(it.id) })),
    })),
  };
}

// The preview shows these today; other modules are valid in project.json but don't draw yet.
const SHOWN_IN_PREVIEW = (m: ModuleManifest) => m.kind === "text-style" || m.id === "move.fade" || m.id === "transition.crossfade";

export function modulesList(modules: Modules, kind?: string) {
  return [...modules.values()]
    .filter((m) => !kind || m.kind === kind)
    .map((m) => ({
      id: m.id,
      kind: m.kind,
      name: m.name,
      ...(typeof m.description === "string" ? { description: m.description } : {}),
      ...(m.params ? { params: m.params } : {}),
      ...(m.transition ? { transition: m.transition } : {}),
      showsInPreview: SHOWN_IN_PREVIEW(m),
    }));
}

export const SYSTEM_PROMPT = `You are the editing agent inside Uncut, a desktop video editor. The user sees the timeline and a live preview next to this chat; every edit you make appears there immediately and is saved.
- Positions and lengths are integer frames at the project's canvas fps (project_read gives canvas and fps). Main-track items have no start: they play back to back. "in" is where an item starts inside its media, in project frames.
- Always project_read before editing and pass its revision as baseRevision. Group related ops into one timeline_edit with a short summary; the user reads it in the turn card.
- If an edit is refused, read the error and fix the ops. A conflict means the user changed the same thing (or used undo) after you read: read again and build on their change, never revert it.
- If the message lists edits the user made by hand, they are intentional: keep them and build on them.
- A project can start empty, with no media. Text needs none. Add a text item to a text track (project_read lists the tracks), for example on a 1920x1080 canvas at 30 fps:
  {"op":"insert_item","track":"text","item":{"id":"title-1","type":"text","start":0,"duration":150,"text":"Kraków from above","transform":{"x":154,"y":410},"style":{"preset":"text.title","size":130,"weight":700}}}
  transform x and y are the text's top-left corner in canvas pixels, style.size is the font size in canvas pixels; scale them to the canvas. Text styles: modules_list with kind "text-style" (text.title, text.header, text.lower-third, ...). [[word]] accents a word, \\n breaks a line. Items on one free track can't overlap: put more text on another time or a new track (add_track with kind "text", index 0 puts it on top).
  The video is as long as its last item, so a 5 s title card on an empty project makes a 5 s video.
- What the preview draws today: media clips and text (position, size, weight, fade-in). Components, backgrounds, effects, colours and alignment are saved but don't draw yet, so prefer text and media, and say so if the user asks for something that won't show.
- You can't look at frames yet. Describe what you changed instead of claiming how it looks.
- Ids are lowercase letters, digits and dashes, unique across the project.
- You only act during a turn, when the user sends a message. Don't promise to do something later ("when you add clips, I'll move the end card"); instead say what the user can ask for next, e.g. "Once the clips are in, ask me to move the end card after them."
- Keep replies short: what you changed, in plain words.`;
