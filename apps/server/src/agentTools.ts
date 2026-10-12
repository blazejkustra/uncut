// What the agent CLI sees of Uncut (spec/agent/tools.json, uncut.agent-tools/0): the tools it
// gets over MCP, how each call reads in a turn card, the project summary project_read returns,
// and the system prompt. Pure functions; the agent service runs them.
import { DRAWN_MOVES, layout, SOLID, TEXT_STYLES, type ModuleManifest, type Modules, type Project } from "@uncut/core";

import { MAX_CELLS, MAX_IMPORT, shortName } from "./agentFootage.ts";

import editOpsSchema from "../../../spec/schema/edit-ops.schema.json" with { type: "json" };
import toolsSpec from "../../../spec/agent/tools.json" with { type: "json" };

// The tools that work today. render_frames came with the export rasteriser (phase 4 chunk 6,
// D55); media_import, contact_sheet and ui_show with phase 5 chunk 1 (D65); media_analyze with
// chunk 2 (D66, loudness and silences for now); transcript_read and generate_media come with
// their features. See DECISIONS.md D51.
export const TOOL_NAMES = ["project_read", "timeline_edit", "modules_list", "render_frames", "media_analyze", "media_import", "contact_sheet", "ui_show"] as const;

/** render_frames: at most this many frames per call, and the default width of each. */
export const MAX_FRAMES = 24;
export const FRAME_WIDTH = 960;
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
    case "render_frames": {
      const frames = Array.isArray(args.frames) ? args.frames.filter((f): f is number => typeof f === "number") : [];
      const list = frames.length > 4 ? `${frames.slice(0, 3).join(", ")} and ${frames.length - 3} more` : frames.join(", ");
      return frames.length === 1 ? `Looked at frame ${list}` : frames.length ? `Looked at frames ${list}` : "Looked at the edit";
    }
    case "media_import": {
      const paths = typeof args.path === "string" ? [args.path] : Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : [];
      if (paths.length === 1) return `Imported ${shortName(paths[0]!)}`;
      return paths.length ? `Imported ${paths.length} paths` : "Imported media";
    }
    case "contact_sheet": {
      const range = args.range && typeof args.range === "object" ? (args.range as { start?: unknown; end?: unknown }) : undefined;
      const span = range && typeof range.start === "number" && typeof range.end === "number" ? ` (frames ${range.start}–${range.end})` : "";
      return typeof args.media === "string" ? `Looked over ${args.media}${span}` : `Looked over the edit${span}`;
    }
    case "media_analyze": {
      const names = Array.isArray(args.analyzers) ? args.analyzers.filter((a): a is string => typeof a === "string") : [];
      const what = names.length && names.every((n) => n === "silence") ? "Found the silences in" : names.length && names.every((n) => n === "loudness") ? "Measured the loudness of" : "Analysed the sound of";
      return typeof args.media === "string" ? `${what} ${args.media}` : "Analysed media";
    }
    case "ui_show": {
      const parts: Array<string> = [];
      if (typeof args.frame === "number") parts.push(`moved the playhead to frame ${args.frame}`);
      const select = Array.isArray(args.select) ? args.select.find((s): s is string => typeof s === "string") : undefined;
      if (select) parts.push(`selected ${select}`);
      if (typeof args.panel === "string") parts.push(`opened ${args.panel === "agent" ? "the Agent tab" : `the ${args.panel[0]!.toUpperCase()}${args.panel.slice(1)} panel`}`);
      const text = parts.join(", ") || "pointed at the editor";
      return `${text[0]!.toUpperCase()}${text.slice(1)}`;
    }
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
const SHOWN_IN_PREVIEW = (m: ModuleManifest) => m.kind === "text-style" || (DRAWN_MOVES as ReadonlyArray<string>).includes(m.id) || m.id === "transition.crossfade" || m.id === SOLID;

/** A built-in text style's look (core TEXT_STYLES), in canvas fractions, for the agent. */
const textStyleLook = (id: string) => {
  const look = TEXT_STYLES[id];
  if (!look) return undefined;
  return { size: `${look.size} × canvas height`, weight: look.weight, font: look.font, color: look.color, ...(look.align ? { align: look.align } : {}), position: `x ${look.x} × width, y ${look.y} × height` };
};

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
      ...(m.kind === "text-style" && textStyleLook(m.id) ? { look: textStyleLook(m.id) } : {}),
      showsInPreview: SHOWN_IN_PREVIEW(m),
    }));
}

export const SYSTEM_PROMPT = `You are the editing agent inside Uncut, a desktop video editor. The user sees the timeline and a live preview next to this chat; every edit you make appears there immediately and is saved.
- Positions and lengths are integer frames at the project's canvas fps (project_read gives canvas and fps). Main-track items have no start: they play back to back. "in" is where an item starts inside its media, in project frames.
- Always project_read before editing and pass its revision as baseRevision. Group related ops into one timeline_edit with a short summary; the user reads it in the turn card.
- If an edit is refused, read the error and fix the ops. A conflict means the user changed the same thing (or used undo) after you read: read again and build on their change, never revert it.
- Locked tracks and items ("locked": true) are off limits: edits to them are refused. Leave them alone, or ask the user to unlock them in the timeline. Hidden tracks ("hidden": true) don't show in the preview.
- If the message lists edits the user made by hand, they are intentional: keep them and build on them.
- A project can start empty, with no media. Text needs none. Add a text item to a text track (project_read lists the tracks), for example on a 1920x1080 canvas at 30 fps:
  {"op":"insert_item","track":"text","item":{"id":"title-1","type":"text","start":0,"duration":150,"text":"Kraków from above","transform":{"x":154,"y":410},"style":{"preset":"text.title","size":130,"weight":700}}}
  transform x and y are the text box's top-left corner in canvas pixels, transform.w its width (omit it and the box fits the text); style.size is the font size in canvas pixels; scale them to the canvas. style.align (left, center, right) aligns the lines inside the box: to centre a title, set x to the safe margin (theme.margin, else the shorter canvas side / 15), w to canvas width minus twice that, and align "center". style.color is a theme token (fg, bg, mute, accent; a project without a theme still has these) or a CSS colour like "#0B1D3A"; style.weight 100–900. Text styles: modules_list with kind "text-style" (text.title, text.header, text.lower-third, ...) lists each one's look. [[word]] accents a word, **bold**, \\n breaks a line. Items on one free track can't overlap: put more text on another time or a new track (add_track with kind "text", index 0 puts it on top).
  Animations: "animation":{"in":{"module":"move.fade","duration":9},"out":{"module":"move.fade","duration":9}}; move.fade, move.rise, move.slide-left and move.wipe draw; a duration can't be longer than the item.
  The video is as long as its last item, so a 5 s title card on an empty project makes a 5 s video.
- Backgrounds are component.solid items on a video track: props.color (a theme token or CSS colour), or a gradient with props.to and props.angle (degrees, 180 = top to bottom). A title card on an empty project is a background on the main track plus the text over it, same length, e.g. a dark blue 5 s card:
  {"op":"insert_item","track":"main","item":{"id":"background-1","type":"component","component":"component.solid","duration":150,"props":{"color":"#0B1D3A"}}}
  Main-track items play back to back, so a background there sits between clips; to put one under text over footage, use a free video track above main (add_track with kind "video" at main's index) with a start.
- Sound: a clip plays its media's sound (media with probe.hasAudio); music, voiceover and effects are audio items on an audio track, e.g. {"op":"insert_item","track":"audio","item":{"id":"music-1","type":"audio","media":"m-song","in":0,"start":0,"duration":300}}. On a clip or audio item, gainDb is the volume in dB (0 or absent = as recorded, −6 about half as loud, −60 = silent, at most +12), fadeIn / fadeOut are fade lengths in frames (together no longer than the item; remove one with null), and gainKeys [{"frame":…,"db":…}] is a volume envelope in dB on top of gainDb (linear between keys). A track's volume is mixer.gainDb and mixer.mute silences it; update_track replaces the whole mixer, so send the fields you want to keep. A main-track transition crossfades the sound too. A hidden track only hides the picture: its clips still sound unless the track is muted.
- What the preview draws today: media clips, backgrounds (component.solid), and text with its position, box width, size, weight, colour, alignment, font and the in/out animations above. It plays the sound with volume, fades, gainKeys, track volume and mute (audio effects and pan are saved but not heard yet). Other components, effects and transitions other than crossfade are saved but don't draw yet, so say so if the user asks for something that won't show.
- render_frames shows you frames of the edit exactly as the export draws them (footage, backgrounds, text with its animation at that frame), as images. Look at a few frames after an edit that changes how things look (text placement, colours, a background) before saying how it looks; ask for only the frames you need (at most ${MAX_FRAMES}).
- Footage: media_import adds files from disk (a file, a folder's media files, or a list of paths; at most ${MAX_IMPORT} per call); they're referenced where they are, never copied. It returns each new media id with its probe; frames, in and duration are in project frames (probe.frames is the media's length in project frames). Only import what the user pointed you to; an import is part of your turn, so Undo turn removes it. Then put clips on the timeline with timeline_edit, e.g. {"op":"insert_item","track":"main","item":{"id":"clip-1","type":"clip","media":"m-dji-0005","in":0,"duration":150}}.
- contact_sheet gives one image with a grid of frames, each captioned with its frame and time (at most ${MAX_CELLS} cells): with media, frames pulled from the original file, numbered in project frames of that media (use them as in); with only a range (or nothing), frames of the edit. Use it to scan footage before choosing what to keep, then render_frames for a closer look at a few frames. at "shots" isn't available yet.
- media_analyze measures a media file's sound: integrated loudness (LUFS), loudness range, true peak, and the silences (below −40 dB for at least 0.3 s), each with frames you can use as in. Use it to find pauses to cut or to check levels. It waits up to about a minute; if it answers "running", call it again with the same arguments. Results are cached, so asking again is free. Only loudness (with silences) exists so far; shots, motion and transcripts come later.
- ui_show points the user at something: it moves the playhead, selects an item and/or opens a panel (media, text, elements, audio, inspector, agent). Use it at the end of a turn to show what you did, e.g. the playhead at a cut with the clip selected.
- Ids are lowercase letters, digits and dashes, unique across the project.
- You only act during a turn, when the user sends a message. Don't promise to do something later ("when you add clips, I'll move the end card"); instead say what the user can ask for next, e.g. "Once the clips are in, ask me to move the end card after them."
- Keep replies short: what you changed, in plain words.`;

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
