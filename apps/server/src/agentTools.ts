// What the agent CLI sees of Uncut (spec/agent/tools.json, uncut.agent-tools/0): the tools it
// gets over MCP, how each call reads in a turn card, the project summary project_read returns,
// and the system prompt. Pure functions; the agent service runs them.
import {
  applyEdit,
  COMPONENTS,
  createSession,
  DRAWN_COMPONENTS,
  DRAWN_MOVES,
  DRAWN_TRANSITIONS,
  layout,
  MAX_RASTER_STATES,
  planDeviceFrame,
  planInsertText,
  WORD_STYLES,
  TEXT_STYLES,
  TRANSITIONS,
  UNDRAWN_COMPONENTS,
  type Device,
  type ModuleManifest,
  type Modules,
  type Op,
  type Project,
} from "@uncut/core";

import { MAX_CELLS, MAX_IMPORT, shortName } from "./agentFootage.ts";

import editOpsSchema from "../../../spec/schema/edit-ops.schema.json" with { type: "json" };
import toolsSpec from "../../../spec/agent/tools.json" with { type: "json" };

// The tools that work today. render_frames came with the export rasteriser (phase 4 chunk 6,
// D55); media_import, contact_sheet and ui_show with phase 5 chunk 1 (D65); media_analyze with
// chunk 2 (D66, loudness and silences); the video analyzer and media_rank with chunk 3 (D67);
// transcript_read with chunk 4 (D68, local whisper.cpp); transcript_edit with chunk 5 (D69, cut by
// text through core planTextCut); the beats analyzer with chunk 6 (D70); graphic_write with phase 6
// chunk 2 (D78); generate_media comes with its feature.
// See DECISIONS.md D51.
export const TOOL_NAMES = ["project_read", "timeline_edit", "modules_list", "render_frames", "media_analyze", "media_rank", "transcript_read", "transcript_edit", "media_import", "contact_sheet", "ui_show", "graphic_write"] as const;

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
      // timeline_edit's ops: the edit ops, or the convenience ops the server expands (insert_device_frame D76, insert_text D80).
      if (schema.properties?.ops) schema.properties.ops = { type: "array", minItems: 1, items: { anyOf: [{ $ref: "#/$defs/op" }, { $ref: "#/$defs/insertDeviceFrame" }, { $ref: "#/$defs/insertText" }] } };
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
      if (args.at === "shots") return typeof args.media === "string" ? `Looked over the shots of ${args.media}${span}` : "Looked over the shots";
      return typeof args.media === "string" ? `Looked over ${args.media}${span}` : `Looked over the edit${span}`;
    }
    case "media_analyze": {
      const names = Array.isArray(args.analyzers) ? args.analyzers.filter((a): a is string => typeof a === "string") : [];
      const sound = new Set(["loudness", "silence"]);
      const picture = new Set(["video", "shots", "motion", "stability"]);
      const only = (n: string) => names.length > 0 && names.every((x) => x === n);
      const rhythm = new Set(["beats", "rhythm", "onsets", "tempo"]);
      const what = names.length > 0 && names.every((x) => x === "transcript" || x === "transcription")
        ? "Transcribed"
        : names.length > 0 && names.every((x) => rhythm.has(x))
        ? "Found the beats in"
        : only("silence")
        ? "Found the silences in"
        : only("loudness")
          ? "Measured the loudness of"
          : only("shots")
            ? "Found the shots in"
            : only("stability") || only("motion")
              ? "Measured the camera motion of"
              : !names.length || names.every((x) => sound.has(x))
                ? "Analysed the sound of"
                : names.length && names.every((x) => picture.has(x))
                  ? "Analysed the picture of"
                  : "Analysed";
      return typeof args.media === "string" ? `${what} ${args.media}` : "Analysed media";
    }
    case "media_rank": {
      const ids = typeof args.media === "string" ? [args.media] : Array.isArray(args.media) ? args.media.filter((m): m is string => typeof m === "string") : [];
      if (ids.length) return ids.length === 1 ? `Scored the take ${ids[0]}` : `Ranked ${ids.length} takes`;
      if (typeof args.folder === "string") return `Ranked the takes from ${shortName(args.folder)}`;
      return "Ranked the takes";
    }
    case "transcript_read": {
      const media = typeof args.media === "string" ? args.media : "the media";
      const range = args.range && typeof args.range === "object" ? (args.range as { start?: unknown; end?: unknown }) : undefined;
      const span = range && typeof range.start === "number" && typeof range.end === "number" ? ` (frames ${range.start}–${range.end})` : "";
      return typeof args.from === "number" && args.from > 0 ? `Read more of the transcript of ${media}${span}` : `Read the transcript of ${media}${span}`;
    }
    case "transcript_edit": {
      const what: Array<string> = [];
      const ranges = Array.isArray(args.remove) ? args.remove.length : 0;
      if (ranges) what.push(ranges === 1 ? "words" : `${ranges} word ranges`);
      if (args.pauses !== undefined) {
        const min = args.pauses && typeof args.pauses === "object" ? (args.pauses as { min?: unknown }).min : undefined;
        what.push(typeof min === "number" ? `pauses over ${min} s` : "pauses");
      }
      if (args.fillers === true) what.push("fillers");
      const list = what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what.at(-1)}` : (what[0] ?? "words");
      const from = typeof args.media === "string" ? ` from ${args.media}` : "";
      return args.dryRun === true ? `Planned cutting ${list}${from}` : `Cut ${list}${from}`;
    }
    case "graphic_write":
      return typeof args.name === "string" ? `Wrote the graphic ${args.name}` : "Wrote a graphic";
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
const SHOWN_IN_PREVIEW = (m: ModuleManifest) => m.kind === "text-style" || (DRAWN_MOVES as ReadonlyArray<string>).includes(m.id) || DRAWN_TRANSITIONS.includes(m.id) || DRAWN_COMPONENTS.includes(m.id);

/**
 * A built-in text style's look (D80, from its manifest via core TEXT_STYLES) for the agent: every
 * field, with the units spelled out.
 */
const textStyleLook = (id: string) => {
  const look = TEXT_STYLES[id];
  if (!look) return undefined;
  const { id: _id, name: _name, description: _description, ...rest } = look;
  return { ...rest, units: "size and y: share of the canvas height; x and w: share of its width; span: x = safe margin, w = width minus twice it; stroke, shadow and background lengths: em of the font size (an item's own style fields are canvas px)" };
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
      // Components (D76): how one is placed (sizes in canvas px for a canvas whose shorter side is 1080).
      ...(m.kind === "component" && m.component && typeof m.component === "object" ? { component: m.component } : {}),
      ...(UNDRAWN_COMPONENTS[m.id] ? { notDrawn: UNDRAWN_COMPONENTS[m.id] } : {}),
      showsInPreview: SHOWN_IN_PREVIEW(m),
    }));
}

/** An insert_device_frame op as the agent writes it (spec/agent/tools.json $defs/insertDeviceFrame). */
interface DeviceFrameOp {
  readonly op: "insert_device_frame";
  readonly media?: unknown;
  readonly device?: unknown;
  readonly start?: unknown;
  readonly duration?: unknown;
  readonly in?: unknown;
  readonly box?: unknown;
  readonly frameId?: unknown;
  readonly clipId?: unknown;
  readonly color?: unknown;
  readonly url?: unknown;
}

const DEVICE_FRAME_KEYS = new Set(["op", "media", "device", "start", "duration", "in", "box", "frameId", "clipId", "color", "url"]);

/**
 * timeline_edit's ops with each insert_device_frame expanded into the edit ops that make it
 * (core planDeviceFrame: tracks, the footage clip on the screen, the frame), planned against the
 * project as the ops before it leave it. Other ops pass through untouched (the edit validates
 * them). A malformed device-frame op is a problem, as a sentence.
 */
export function expandDeviceFrames(project: Project, ops: ReadonlyArray<unknown>): { ops: Array<unknown> } | { problem: string } {
  if (!ops.some((op) => (op as { op?: unknown })?.op === "insert_device_frame")) return { ops: [...ops] };
  const out: Array<unknown> = [];
  for (const [i, raw] of ops.entries()) {
    const op = raw as DeviceFrameOp;
    if (op?.op !== "insert_device_frame") {
      out.push(raw);
      continue;
    }
    const where = `ops[${i}] (insert_device_frame)`;
    const extra = Object.keys(op).filter((k) => !DEVICE_FRAME_KEYS.has(k));
    if (extra.length) return { problem: `${where}: unknown field ${extra.join(", ")}.` };
    if (op.media !== undefined && typeof op.media !== "string") return { problem: `${where}: media must be a media id.` };
    if (op.device !== undefined && !["phone", "android", "browser"].includes(op.device as string)) return { problem: `${where}: device must be phone, android or browser.` };
    for (const k of ["start", "duration", "in"] as const) if (op[k] !== undefined && !Number.isInteger(op[k])) return { problem: `${where}: ${k} must be a whole number of frames.` };
    for (const k of ["frameId", "clipId", "color", "url"] as const) if (op[k] !== undefined && typeof op[k] !== "string") return { problem: `${where}: ${k} must be a string.` };
    const box = op.box as { x?: unknown; y?: unknown; h?: unknown } | undefined;
    if (box !== undefined && (typeof box !== "object" || box === null || Object.entries(box).some(([k, v]) => !["x", "y", "h"].includes(k) || typeof v !== "number" || !Number.isFinite(v)))) return { problem: `${where}: box takes numbers x, y and h (canvas pixels).` };
    if (box?.h !== undefined && !((box.h as number) > 0)) return { problem: `${where}: box.h must be more than 0 (the frame's height in canvas pixels).` };
    if (typeof op.in === "number" && op.in < 0) return { problem: `${where}: in must be 0 or more (a frame of the media).` };
    if (typeof op.start !== "number" || typeof op.duration !== "number") return { problem: `${where}: start and duration are required.` };
    if (op.start < 0 || op.duration < 1) return { problem: `${where}: start must be 0 or more and duration at least 1 frame.` };
    // The project as the ops before this one leave it (they're checked for real when the edit runs).
    let now: Project = project;
    try {
      if (out.length) now = applyEdit(createSession(project), { actor: "agent", ops: out as ReadonlyArray<Op> }).project;
    } catch {}
    const plan = planDeviceFrame(now, {
      media: op.media as string | undefined,
      device: op.device as Device | undefined,
      start: op.start,
      duration: op.duration,
      in: op.in as number | undefined,
      box: box as { x?: number; y?: number; h?: number } | undefined,
      frameId: op.frameId as string | undefined,
      clipId: op.clipId as string | undefined,
      color: op.color as string | undefined,
      url: op.url as string | undefined,
    });
    if ("problem" in plan) return { problem: `${where}: ${plan.problem}` };
    out.push(...plan.ops);
  }
  return { ops: out };
}

const INSERT_TEXT_KEYS = new Set(["op", "look", "text", "start", "duration", "id", "track", "style", "transform", "animation", "alone"]);

/**
 * timeline_edit's ops with each insert_text (D80) expanded into the edit ops that make it (core
 * planInsertText: the look's size, weight, position and moves, the looks it comes with, free or new
 * text tracks), planned against the project as the ops before it leave it. Other ops pass through.
 */
export function expandTextLooks(project: Project, ops: ReadonlyArray<unknown>): { ops: Array<unknown> } | { problem: string } {
  if (!ops.some((op) => (op as { op?: unknown })?.op === "insert_text")) return { ops: [...ops] };
  const out: Array<unknown> = [];
  for (const [i, raw] of ops.entries()) {
    const op = raw as Record<string, unknown>;
    if (op?.op !== "insert_text") {
      out.push(raw);
      continue;
    }
    const where = `ops[${i}] (insert_text)`;
    const extra = Object.keys(op).filter((k) => !INSERT_TEXT_KEYS.has(k));
    if (extra.length) return { problem: `${where}: unknown field ${extra.join(", ")}.` };
    if (typeof op.look !== "string") return { problem: `${where}: look must be a text-style module id, e.g. text.big-title (modules_list kind "text-style").` };
    if (typeof op.start !== "number" || typeof op.duration !== "number") return { problem: `${where}: start and duration are required (frames).` };
    if (op.text !== undefined && typeof op.text !== "string") return { problem: `${where}: text must be a string.` };
    if (op.id !== undefined && typeof op.id !== "string") return { problem: `${where}: id must be a string.` };
    for (const k of ["style", "transform"] as const) if (op[k] !== undefined && (typeof op[k] !== "object" || op[k] === null || Array.isArray(op[k]))) return { problem: `${where}: ${k} must be an object.` };
    if (op.animation !== undefined && op.animation !== null && (typeof op.animation !== "object" || Array.isArray(op.animation))) return { problem: `${where}: animation must be {in?, out?} or null.` };
    if (op.track !== undefined) return { problem: `${where}: track isn't taken: insert_text picks a free text track (or adds one). Use insert_item to put text on a given track.` };
    let now: Project = project;
    try {
      if (out.length) now = applyEdit(createSession(project), { actor: "agent", ops: out as ReadonlyArray<Op> }).project;
    } catch {}
    const plan = planInsertText(now, {
      look: op.look,
      start: op.start,
      duration: op.duration,
      ...(typeof op.text === "string" ? { text: op.text } : {}),
      ...(typeof op.id === "string" ? { id: op.id } : {}),
      ...(op.style ? { style: op.style as Record<string, never> } : {}),
      ...(op.transform ? { transform: op.transform as { x?: number; y?: number; w?: number } } : {}),
      ...(op.animation !== undefined ? { animation: op.animation as null } : {}),
      ...(op.alone === true ? { alone: true } : {}),
    });
    if ("problem" in plan) return { problem: `${where}: ${plan.problem}` };
    out.push(...plan.ops);
  }
  return { ops: out };
}

/** The text looks for the system prompt (D80). */
const LOOK_DOCS = Object.values(TEXT_STYLES)
  .filter((l) => !l.legacyShadow)
  .map((l) => `${l.id} (${l.name.toLowerCase()})`)
  .join(", ");

/** The drawn transitions for the system prompt: id, what it does, frame limits. */
const TRANSITION_DOCS = TRANSITIONS.map((t) => `${t.id} (${t.name.toLowerCase()}, ${t.minFrames}–${t.maxFrames} frames)`).join(", ");
/** The drawn components for the system prompt (D76). */
const COMPONENT_DOCS = COMPONENTS.map((c) => `${c.id} (${c.name.toLowerCase()}: props ${Object.keys(c.params.properties ?? {}).join(", ")})`).join("; ");
const UNDRAWN_DOCS = Object.keys(UNDRAWN_COMPONENTS).join(", ");

export const SYSTEM_PROMPT = `You are the editing agent inside Uncut, a desktop video editor. The user sees the timeline and a live preview next to this chat; every edit you make appears there immediately and is saved.
- Positions and lengths are integer frames at the project's canvas fps (project_read gives canvas and fps). Main-track items have no start: they play back to back. "in" is where an item starts inside its media, in project frames.
- Always project_read before editing and pass its revision as baseRevision. Group related ops into one timeline_edit with a short summary; the user reads it in the turn card.
- If an edit is refused, read the error and fix the ops. A conflict means the user changed the same thing (or used undo) after you read: read again and build on their change, never revert it.
- Locked tracks and items ("locked": true) are off limits: edits to them are refused. Leave them alone, or ask the user to unlock them in the timeline. Hidden tracks ("hidden": true) don't show in the preview.
- If the message lists edits the user made by hand, they are intentional: keep them and build on them.
- A project can start empty, with no media. Text needs none. Add a text item to a text track (project_read lists the tracks), for example on a 1920x1080 canvas at 30 fps:
  {"op":"insert_item","track":"text","item":{"id":"title-1","type":"text","start":0,"duration":150,"text":"Kraków from above","transform":{"x":154,"y":410},"style":{"preset":"text.title","size":130,"weight":700}}}
  transform x and y are the text box's top-left corner in canvas pixels, transform.w its width (omit it and the box fits the text); style.size is the font size in canvas pixels; scale them to the canvas. style.align (left, center, right) aligns the lines inside the box: to centre a title, set x to the safe margin (theme.margin, else the shorter canvas side / 15), w to canvas width minus twice that, and align "center". style.color is a theme token (fg, bg, mute, accent; a project without a theme still has these) or a CSS colour like "#0B1D3A"; style.weight 100–900. Text styles (looks, D80): modules_list with kind "text-style" lists each one's look (size, position, font, stroke, shadow, box, placeholder text, moves). The curated ones: ${LOOK_DOCS}; older ones (text.title, text.header, text.lower-third, text.footnote, text.mono-label, text.captions) draw a soft shadow only in projects made before text looks (no "textLooks" field in project.json); in newer ones no text has a shadow unless its style sets one. Easiest: {"op":"insert_text","look":"text.big-title","text":"Your words","start":0,"duration":90} inside timeline_edit's ops gives the item that look (its size, weight, position and moves, plus the looks it comes with, e.g. a kicker), on a free text track (a new one if needed); optional id, style and transform (canvas px, over the look's), animation ({in, out} or null for none), alone (skip the looks it comes with). Style fields on any text item (canvas px): stroke {width, color} (an outline; paint goes under the fill), shadow {x, y, blur, color, opacity 0–1}, background {color, opacity 0–1, padding (the sides; top and bottom get half), radius, wrap "box" (one box around the text box) or "lines" (a box behind each line, subtitle-style)}, uppercase true, tracking (em), lineHeight; false for stroke, shadow or background removes the look's; leaving a field out uses the look's. update_item replaces style whole: send the fields you keep. [[word]] accents a word, **bold**, \\n breaks a line. Items on one free track can't overlap: put more text on another time or a new track (add_track with kind "text", index 0 puts it on top).
  Animations: "animation":{"in":{"module":"move.fade","duration":9},"out":{"module":"move.fade","duration":9}}; move.fade, move.rise, move.slide-left and move.wipe draw; on text also move.word-by-word (the words appear one after another over the duration; out: they leave first to last; params {"style": ${WORD_STYLES.map((w) => `"${w}"`).join(" | ")}}) and move.zoom (scales from params.scale to full size in, or to it out, about the text's centre; params {"scale": 0.7, "ease": "linear" | "in" | "out" | "inOut", "fade": true}), e.g. "in":{"module":"move.word-by-word","duration":24,"params":{"style":"rise"}}. A duration can't be longer than the item.
  The video is as long as its last item, so a 5 s title card on an empty project makes a 5 s video.
- Backgrounds are component.solid items on a video track: props.color (a theme token or CSS colour), or a gradient with props.to and props.angle (degrees, 180 = top to bottom). A title card on an empty project is a background on the main track plus the text over it, same length, e.g. a dark blue 5 s card:
  {"op":"insert_item","track":"main","item":{"id":"background-1","type":"component","component":"component.solid","duration":150,"props":{"color":"#0B1D3A"}}}
  Main-track items play back to back, so a background there sits between clips; to put one under text over footage, use a free video track above main (add_track with kind "video" at main's index) with a start.
- Clips (video and stills) draw in a box: transform {x, y, w, h} in canvas pixels, the box's top-left and size (no w and h = the whole canvas, as clips are by default; only w or only h = the other from the media's aspect; no x / y = centred). fit: "contain" (default: all of the picture inside the box), "cover" (fills the box, the overflow cut off) or "fill" (stretched to it). scale zooms the picture inside the box about its centre (the box clips it and doesn't grow: 1.2 is a 20 % zoom in), opacity 0–1, radius rounds the box's corners (canvas pixels). update_item replaces transform whole: send every field you keep. A picture-in-picture on a 1920x1080 canvas, on a video track above main:
  {"op":"update_item","item":"clip-2","set":{"transform":{"x":1240,"y":60,"w":620,"h":349,"fit":"cover","radius":24}}}
  Two-up: two clips at the same time on two video tracks, {"x":0,"y":0,"w":960,"h":1080,"fit":"cover"} and {"x":960,"y":0,"w":960,"h":1080,"fit":"cover"}. keys animate x, y, scale and opacity, frames from the item's start, e.g. a slow zoom in (Ken Burns): "keys":[{"frame":0,"scale":1,"ease":"inOut"},{"frame":150,"scale":1.15}]. Each property uses only the keys that set it (none: the transform's value); it holds its first value before the first key and its last after the last; a key's ease (linear by default, in, out, inOut) shapes the move from that key to the next. "loop":true on a clip starts its media over from the beginning when the clip is longer than the media. On clips, in/out animations change only the opacity (rise and slide don't move a clip, wipe doesn't apply); rotate is saved but not drawn.
- Sound: a clip plays its media's sound (media with probe.hasAudio); music, voiceover and effects are audio items on an audio track, e.g. {"op":"insert_item","track":"audio","item":{"id":"music-1","type":"audio","media":"m-song","in":0,"start":0,"duration":300}}. On a clip or audio item, gainDb is the volume in dB (0 or absent = as recorded, −6 about half as loud, −60 = silent, at most +12), fadeIn / fadeOut are fade lengths in frames (together no longer than the item; remove one with null), and gainKeys [{"frame":…,"db":…}] is a volume envelope in dB on top of gainDb (linear between keys). A track's volume is mixer.gainDb and mixer.mute silences it; update_track replaces the whole mixer, so send the fields you want to keep. A main-track transition blends the sound too (a dip to black dips it, every other one crossfades it). A hidden track only hides the picture: its clips still sound unless the track is muted.
- Transitions go between two neighbouring main-track items, on the incoming one: {"op":"set_transition","item":"clip-2","transition":{"module":"transition.crossfade","duration":15}} (null removes it). They draw: ${TRANSITION_DOCS}. A crossfade fades the next item in; a wipe reveals it from the left edge; an iris opens it in a circle growing from the centre; a push slides it in from the right while the outgoing one slides out to the left; a zoom scales the outgoing picture up by 20 % while the next one fades in over it; all linear. Both items must be at least twice the transition long. Every one but dip to black is centred on the cut, so video needs spare footage there: ceil(duration/2) frames before the incoming clip's in and after the outgoing clip's end in its media; a dip to black needs none. transition.cut is saved but draws as a crossfade.
- Components (D76) are component items on a video track, drawn from their props in a box like a clip's: transform {x, y, w, h} in canvas pixels (no w and h = the component's default size, centred; an end card fills the canvas), opacity, x / y / opacity keys, in/out animations (rise and slide move them). modules_list with kind "component" gives each one's props schema and default size (component.size, canvas pixels for a canvas whose shorter side is 1080: scale it to the project's). They draw: ${COMPONENT_DOCS}. Text in them uses the bundled DM Sans and DM Mono. E.g. an end card for the last 3 s of a 1920x1080 video at 30 fps, on a free video track:
  {"op":"insert_item","track":"overlay","item":{"id":"end-card-1","type":"component","component":"component.end-card","start":600,"duration":90,"props":{"logo":{"media":"m-logo"},"title":"Argent","code":"npx @swmansion/argent init","url":"argent.swmansion.com","background":"bg"}}}
  A terminal's input lines type in by frame: "props":{"title":"zsh","lines":[{"text":"npx your-tool init","kind":"input"},{"text":"✔ Done in 1.2 s"}],"typeFrom":10,"speed":30}. A chart: "props":{"bars":[{"label":"Before","value":42},{"label":"After","value":12,"accent":true}],"unit":" s"}. A code chip: component.code-block with "props":{"code":"npx your-tool init","prompt":true} in a box about 760×120.
  A device frame shows footage on a phone or browser: the footage is a clip under the frame, its box on the frame's screen. One op does both: {"op":"insert_device_frame","media":"m-recording","device":"phone","start":0,"duration":150,"in":0} (optional box {x, y, h}, frameId, clipId; it adds the video tracks it needs, above main and under the text). Move the frame and its clip together (the clip's box is the frame's screen: modules_list's component.screens gives the rect per device). Animated components (a terminal typing) are drawn frame by frame in the export, up to ${MAX_RASTER_STATES} distinct looks per item; past that it holds frames.
- Graphics are the escape hatch for motion the components can't do: write the HTML with graphic_write (it defines render(t, info), t in seconds from the item's start; full canvas, transparent, no network, system fonts), then insert {"type":"graphic","src":"graphics/<name>","start":…,"duration":…} on a video track. Prefer components and text; keep graphics simple.
- Images can be SVG (a logo): they're stills like PNGs, drawn sharp at their box's size.
- What the preview draws today: media clips in their box (position, size, fit, scale, opacity, corners, keys, loop), backgrounds (component.solid), the components above, graphic items, the transitions above, and text with its position, box width, size, weight, colour, alignment, font, letter spacing, line height, case, outline, shadow, box and the in/out animations above. It plays the sound with volume, fades, gainKeys, track volume and mute (audio effects and pan are saved but not heard yet). Other components (${UNDRAWN_DOCS}) and effects are saved but don't draw yet, so say so if the user asks for something that won't show.
- render_frames shows you frames of the edit exactly as the export draws them (footage, backgrounds, components, graphics, text with its animation at that frame), as images. Look at a few frames after an edit that changes how things look (text placement, colours, a background) before saying how it looks; ask for only the frames you need (at most ${MAX_FRAMES}).
- Footage: media_import adds files from disk (a file, a folder's media files, or a list of paths; at most ${MAX_IMPORT} per call); they're referenced where they are, never copied. It returns each new media id with its probe; frames, in and duration are in project frames (probe.frames is the media's length in project frames). Only import what the user pointed you to; an import is part of your turn, so Undo turn removes it. Then put clips on the timeline with timeline_edit, e.g. {"op":"insert_item","track":"main","item":{"id":"clip-1","type":"clip","media":"m-dji-0005","in":0,"duration":150}}.
- contact_sheet gives one image with a grid of frames, each captioned with its frame and time (at most ${MAX_CELLS} cells): with media, frames pulled from the original file, numbered in project frames of that media (use them as in); with only a range (or nothing), frames of the edit. Use it to scan footage before choosing what to keep, then render_frames for a closer look at a few frames. at "shots" (with media) shows one frame per shot, from the video analysis.
- media_analyze measures a media file: "loudness" (also "silence") gives integrated loudness (LUFS), loudness range, true peak and the silences (below −40 dB for at least 0.3 s); "video" (also "shots", "motion", "stability") gives the cuts, frozen stretches and, per second, stability (no camera shake), sharpness, exposure and a cleanScore 0–1, with the best stretch and good/fair/poor stretches. Frames in the answers are project frames of the media you can use as in. "transcript" transcribes the speech (a summary: language, word, filler and pause counts; read it with transcript_read). "beats" (also "rhythm", "onsets", "tempo") gives the tempo (bpm), a confidence 0–1, the beats in project frames of the media (the first ones; range lists those inside it, with the onsets) and the onset count: use it to cut clips on the beat of the music (a clip of the media at timeline frame S with in I hits beat b at S + b − I). Default: loudness only; ask for "video" or "beats" by name ("video" takes longer: about a minute on a long 4K clip). It waits up to about a minute; if it answers "running", call it again with the same arguments. Results are cached, so asking again is free.
- media_rank ranks video takes (media ids, or the media from a folder, or all the project's video) by cleanScore, best first, each with its stability, sharpness and exposure and its best stretch inside one shot (window seconds long, default 5; start and end usable as in). Use it to pick the clean take or the clean part of a long one, and say why from the components (e.g. "sharper, less shake"). Look at the pick with contact_sheet or render_frames before you rely on it.
- transcript_read gives what's said in a media file, transcribed on this Mac (whisper.cpp; the language is detected, pass language like "pl" if it's wrong). Text lines start with their first word's index and frames, e.g. "w12 [300–452] So {um} this is the shot (pause 0.8 s) we wanted."; {braces} mark fillers, (pause …) gaps of at least 0.3 s; fillers and pauses also come as lists with frames. format "words" gives each word with start (the frame it begins in) and end (the frame after it), project frames of the media usable as in. Long transcripts come in pages: call again with from = next.from; range narrows to project frames of the media. The first transcript of a file takes a while (and the very first one downloads the speech model): if it answers running, call again with the same arguments. Cached afterwards.
- transcript_edit cuts by text: remove takes word ranges by the ids transcript_read gives ({"from":"w12","to":"w20"}, both ends included; {"from":"w31"} is one word), pauses {"min": seconds} removes pauses at least that long (default 0.5; a little quiet stays next to each word), fillers true removes the hesitation fillers (um, uh, yyy; never the "maybe" ones: judge those and pass them in remove if they should go). It cuts from every main-track clip that uses the media, as one edit on your turn (Undo turn reverts it); the main track closes up and items on other tracks don't move, so check titles and music still line up. Read the transcript first and cut whole phrases or sentences, not single words in the middle of one; dryRun true shows what would go and the new length without changing anything. It answers what was removed (text, seconds) and the new duration.
- ui_show points the user at something: it moves the playhead, selects an item and/or opens a panel (media, text, elements (backgrounds and components), audio, inspector, agent). Use it at the end of a turn to show what you did, e.g. the playhead at a cut with the clip selected.
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
