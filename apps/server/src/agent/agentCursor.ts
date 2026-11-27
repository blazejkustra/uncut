// D348: the agent's cursor. Each tool call points at what it touches (an item's edge, the ruler at
// a frame, transcript words), kept per running turn and published with the agent
// (AgentInfo.cursor). The renderer turns targets into pixels. Never saved.
import type { AgentCursor, AgentCursorChild, AgentCursorStop, AgentCursorTarget } from "@uncut/contracts";
import { layout, type Project } from "@uncut/core";

/** The stops a published cursor keeps: enough for the renderer's queue between two publishes. */
export const CURSOR_STOPS = 6;
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
const PARK: AgentCursorTarget = { kind: "park" };
const STAY: AgentCursorTarget = { kind: "stay" };

type Args = Record<string, unknown>;
type Edge = "start" | "end" | "centre";

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Args | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Args) : undefined);
const frames = (v: unknown) => (Array.isArray(v) ? v.filter((f): f is number => typeof f === "number" && Number.isFinite(f)) : []);
const wordIndex = (v: unknown) => num(v) ?? (typeof v === "string" && /^w?\d+$/.test(v) ? Number(v.replace(/^w/, "")) : undefined);

/** Where an item is on the timeline now, when it's on a track. */
function placed(project: Project | undefined, id: string) {
  const track = project?.tracks.find((t) => t.items.some((i) => i.id === id));
  const item = track?.items.find((i) => i.id === id);
  if (!project || !track || !item) return undefined;
  return { track: track.id, start: layout(project).starts.get(id) ?? 0, duration: item.duration };
}

function itemAt(project: Project | undefined, id: string, at: Edge): AgentCursorTarget {
  const p = placed(project, id);
  if (!p) return { kind: "item", item: id, at };
  const into = at === "end" ? p.duration : at === "centre" ? p.duration / 2 : 0;
  return { kind: "item", item: id, at, frame: Math.round(p.start + into), track: p.track };
}

function itemOffset(project: Project | undefined, id: string, offset: number): AgentCursorTarget {
  const p = placed(project, id);
  if (!p) return { kind: "item", item: id, offset };
  return { kind: "item", item: id, offset, frame: p.start + offset, track: p.track };
}

/** An item the edit adds: it isn't drawn until the edit lands, so its track and start stand in. */
function newItem(id: string | undefined, track: string | undefined, start: number | undefined): AgentCursorTarget | undefined {
  if (id) return { kind: "item", item: id, at: "centre", ...(track ? { track } : {}), ...(start !== undefined ? { frame: start } : {}) };
  return start !== undefined ? { kind: "time", frame: start } : undefined;
}

const time = (frame: number, end?: number, preview = false): AgentCursorTarget => ({
  kind: "time",
  frame,
  ...(end !== undefined && end > frame ? { end } : {}),
  ...(preview ? { preview: true } : {}),
});

function rangeOf(v: unknown): AgentCursorTarget | undefined {
  const range = obj(v);
  const start = num(range?.start);
  return start === undefined ? undefined : time(start, num(range?.end));
}

/** Where one timeline_edit op points; undefined for ops with nothing on the timeline (media, project, sequences). */
function opTarget(op: Args, project: Project | undefined): AgentCursorTarget | undefined {
  const item = str(op.item);
  const track = str(op.track) ?? str(obj(op.track)?.id);
  const edge = (at: Edge) => (item ? itemAt(project, item, at) : undefined);
  const into = (offset: number | undefined) => (item && offset !== undefined ? itemOffset(project, item, offset) : edge("centre"));
  switch (op.op) {
    case "trim_item":
      return edge(op.edge === "start" ? "start" : "end");
    case "roll_edit":
      return edge("end");
    case "set_transition":
      return edge("start");
    case "split_item":
      return into(num(op.at));
    case "replace_range": {
      const start = item ? placed(project, item)?.start : undefined;
      const from = num(op.from);
      return into(start !== undefined && from !== undefined ? Math.max(0, from - start) : undefined);
    }
    case "insert_item":
      return newItem(str(obj(op.item)?.id), track, num(obj(op.item)?.start));
    case "place_item":
      return item ? edge("centre") : newItem(str(obj(op.item)?.id), track, num(op.start));
    case "insert_text":
      return newItem(str(op.id), undefined, num(op.start));
    case "insert_device_frame":
      return newItem(str(op.clipId), undefined, num(op.start));
    case "nest_items":
    case "text_behind_subject": {
      const first = [...(Array.isArray(op.items) ? op.items : []), ...(Array.isArray(op.texts) ? op.texts : [])].find((x) => typeof x === "string");
      return typeof first === "string" ? itemAt(project, first, "centre") : undefined;
    }
    case "add_track":
    case "update_track":
    case "delete_track":
      return track ? { kind: "track", track } : undefined;
    default:
      return edge("centre");
  }
}

function wordsTarget(args: Args): AgentCursorTarget {
  const range = obj(Array.isArray(args.remove) ? args.remove[0] : undefined);
  const from = wordIndex(range?.from);
  const to = wordIndex(range?.to) ?? from;
  return {
    kind: "words",
    ...(str(args.media) ? { media: str(args.media)! } : {}),
    ...(str(args.item) ? { item: str(args.item)! } : {}),
    ...(from !== undefined ? { from, to: to! } : {}),
  };
}

/** Where a tool call points (D348): what it changes or reads on screen, else the agent panel's edge. */
export function cursorTarget(tool: string, input: unknown, project?: Project): AgentCursorTarget {
  const args = obj(input) ?? {};
  const item = str(args.item);
  switch (tool) {
    case "timeline_edit": {
      for (const op of Array.isArray(args.ops) ? args.ops : []) {
        const target = obj(op) && opTarget(obj(op)!, project);
        if (target) return target;
      }
      return PARK;
    }
    case "project_read": {
      const first = Array.isArray(args.items) ? args.items.find((x) => typeof x === "string") : undefined;
      return rangeOf(args.range) ?? (typeof first === "string" ? itemAt(project, first, "centre") : PARK);
    }
    case "render_frames": {
      const run = obj(args.run);
      const start = num(run?.start);
      if (start !== undefined) return time(start, start + (num(run?.count) ?? 1) - 1, true);
      const list = frames(args.frames);
      return list.length ? time(Math.min(...list), Math.max(...list), true) : PARK;
    }
    case "contact_sheet":
      if (str(args.media)) return PARK;
      return rangeOf(args.range) ?? time(0, project ? layout(project).duration : undefined);
    case "measure": {
      const items = Array.isArray(args.items) ? args.items.filter((x): x is string => typeof x === "string") : [];
      if (items.length) return itemAt(project, items[0]!, "centre");
      const list = frames(args.frames);
      return list.length ? time(Math.min(...list), Math.max(...list), true) : PARK;
    }
    case "transcript_read":
    case "transcript_edit":
      return wordsTarget(args);
    case "beat_grid":
      return rangeOf(args.range) ?? (item ? itemAt(project, item, "centre") : PARK);
    case "captions_make":
    case "graphic_elements":
    case "graphic_element_edit":
      return item ? itemAt(project, item, "centre") : PARK;
    case "ui_show": {
      const select = Array.isArray(args.select) ? args.select.find((x) => typeof x === "string") : undefined;
      if (typeof select === "string") return itemAt(project, select, "centre");
      return num(args.frame) !== undefined ? time(num(args.frame)!) : PARK;
    }
    case "ask_user":
    case "review_submit":
    case "Task":
    case "Agent":
      return STAY;
    default:
      return PARK;
  }
}

/** A running turn's cursor: its stops so far and the children (subagents) still running, by tool_use id. */
export interface CursorTrail {
  seq: number;
  readonly stops: Array<AgentCursorStop>;
  readonly children: Map<string, AgentCursorChild>;
}

export const cursorTrail = (): CursorTrail => ({ seq: 0, stops: [], children: new Map() });

export interface CursorCall {
  readonly id: string;
  readonly step: number;
  readonly tool: string;
  readonly input: unknown;
  readonly label: string;
}

/** A tool call of the agent itself: a new stop; a subagent's call also starts a child. */
export function cursorCall(trail: CursorTrail, call: CursorCall, project?: Project) {
  const target = cursorTarget(call.tool, call.input, project);
  trail.stops.push({ seq: ++trail.seq, step: call.step, label: call.label, target });
  if (trail.stops.length > CURSOR_STOPS) trail.stops.splice(0, trail.stops.length - CURSOR_STOPS);
  if (SUBAGENT_TOOLS.has(call.tool)) {
    const description = str(obj(call.input)?.description)?.trim();
    trail.children.set(call.id, { id: call.id, label: description || "Subagent" });
  }
}

/** A tool call a subagent made (its message's parent_tool_use_id): the child's cursor goes there. */
export function cursorChildCall(trail: CursorTrail, parentId: string, tool: string, input: unknown, project?: Project) {
  const child = trail.children.get(parentId);
  if (!child) return;
  const target = cursorTarget(tool, input, project);
  trail.children.set(parentId, target.kind === "park" || target.kind === "stay" ? { id: child.id, label: child.label } : { ...child, target });
}

/** A tool call answered: a subagent it started is done. */
export function cursorCallEnded(trail: CursorTrail, id: string) {
  trail.children.delete(id);
}

interface TurnItem {
  readonly kind: string;
  readonly card?: { readonly critic?: { readonly round: number; readonly status: string } | undefined } | undefined;
}

/** The cursor as published: the trail and a child for each critic round still running. */
export function cursorView(turnId: string, trail: CursorTrail, items: ReadonlyArray<TurnItem>): AgentCursor {
  const critics = items.flatMap((i): Array<AgentCursorChild> => {
    const critic = i.kind === "card" ? i.card?.critic : undefined;
    return critic?.status === "running" ? [{ id: `critic-${critic.round}`, label: `Critic, round ${critic.round}` }] : [];
  });
  return { turnId, stops: [...trail.stops], children: [...trail.children.values(), ...critics] };
}
