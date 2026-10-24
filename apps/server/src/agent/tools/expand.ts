// The modules list and the timeline_edit ops expanded before they're applied.
import {
  type ModuleManifest,
  DRAWN_MOVES,
  DRAWN_TRANSITIONS,
  DRAWN_COMPONENTS,
  HEARD_EFFECTS,
  TEXT_STYLES,
  type Modules,
  UNDRAWN_COMPONENTS,
  type Project,
  applyEdit,
  createSession,
  type Op,
  planDeviceFrame,
  type Device,
  type TextLook,
  planInsertText,
} from "@uncut/core";
import { planPutOnMain, takenIds, planDetachAudio, planSetSpeed, planReplaceRange } from "@uncut/core/arrange";
import { withoutDecisionIds } from "./decisionIds.ts";

// The preview shows these today; other modules are valid in project.json but don't draw yet.
const SHOWN_IN_PREVIEW = (m: ModuleManifest) =>
  m.kind === "text-style" ||
  (DRAWN_MOVES as ReadonlyArray<string>).includes(m.id) ||
  DRAWN_TRANSITIONS.includes(m.id) ||
  DRAWN_COMPONENTS.includes(m.id) ||
  HEARD_EFFECTS.includes(m.id);

/**
 * A built-in text style's look (D80, from its manifest via core TEXT_STYLES) for the agent: every
 * field, with the units spelled out.
 */
const textStyleLook = (id: string) => {
  const look = TEXT_STYLES[id];
  if (!look) return undefined;
  const { id: _id, name: _name, description: _description, ...rest } = look;
  return {
    ...rest,
    units:
      "size and y: share of the canvas height; x and w: share of its width; span: x = safe margin, w = width minus twice it; stroke, shadow and background lengths: em of the font size (an item's own style fields are canvas px)",
  };
};

export function modulesList(modules: Modules, kind?: string) {
  return [...modules.values()]
    .filter((m) => !kind || m.kind === kind)
    .map((m) => ({
      id: m.id,
      kind: m.kind,
      name: m.name,
      source: "builtin",
      ...(typeof m.description === "string" ? { description: withoutDecisionIds(m.description) } : {}),
      ...(m.params ? { params: m.params } : {}),
      ...(m.transition ? { transition: m.transition } : {}),
      ...(m.kind === "text-style" && textStyleLook(m.id) ? { look: textStyleLook(m.id) } : {}),
      // Components (D76): how one is placed (sizes in canvas px for a canvas whose shorter side is 1080).
      ...(m.kind === "component" && m.component && typeof m.component === "object" ? { component: m.component } : {}),
      ...(UNDRAWN_COMPONENTS[m.id] ? { notDrawn: UNDRAWN_COMPONENTS[m.id] } : {}),
      showsInPreview: SHOWN_IN_PREVIEW(m),
    }));
}

/** A module's purpose in one short line: its description's first clause, no decision ids. */
const purpose = (text: string) => {
  const first = withoutDecisionIds(text)
    .split(/(?<=\.)\s|;\s|:\s/)[0]!
    .replace(/\.$/, "");
  return first.length > 90 ? `${first.slice(0, 88).replace(/\s\S*$/, "")}…` : first;
};

/**
 * D285 (issue #81): modules_list without a kind: every module's id and purpose by kind, plugins
 * (approval, warnings) as they are, and how to get the details. The whole list was ~70k chars.
 */
export function modulesIndex(listed: ReadonlyArray<Record<string, unknown>>) {
  const modules: Record<string, Record<string, string>> = {};
  const plugins: Array<Record<string, unknown>> = [];
  for (const m of listed) {
    if (m.plugin === true || m.skipped) {
      // A plugin as the index shows it: what it is and whether it may run; its contributions (skills
      // are in the system prompt, looks and components under their kind; a generator plugin's
      // generators, #107) come with kind or ids.
      const { contributes: _c, capabilities: _cap, version: _v, generators: _g, description, ...rest } = m;
      plugins.push({ ...rest, ...(typeof description === "string" && description ? { description: purpose(description) } : {}) });
      continue;
    }
    const kind = String(m.kind ?? "other");
    const text = typeof m.description === "string" && m.description ? m.description : String(m.name ?? m.id);
    (modules[kind] ??= {})[String(m.id)] =
      `${purpose(text)}${m.showsInPreview === false ? " (not drawn in the preview)" : ""}${m.source === "project" || m.source === "plugin" ? ` (a shader effect from ${m.source === "project" ? "this project" : "a plugin"})` : ""}`;
  }
  return {
    modules,
    ...(plugins.length ? { plugins } : {}),
    next: 'modules_list {"kind": "effect"} gives that kind\'s modules with their params; {"ids": ["effect.color"]} gives just those, whole (a plugin with what it contributes).',
  };
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
  readonly hold?: unknown;
}

const DEVICE_FRAME_KEYS = new Set(["op", "media", "device", "start", "duration", "in", "box", "frameId", "clipId", "color", "url", "hold"]);

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
    if (op.device !== undefined && !["phone", "android", "browser"].includes(op.device as string))
      return { problem: `${where}: device must be phone, android or browser.` };
    for (const k of ["start", "duration", "in"] as const)
      if (op[k] !== undefined && !Number.isInteger(op[k])) return { problem: `${where}: ${k} must be a whole number of frames.` };
    for (const k of ["frameId", "clipId", "color", "url"] as const)
      if (op[k] !== undefined && typeof op[k] !== "string") return { problem: `${where}: ${k} must be a string.` };
    const box = op.box as { x?: unknown; y?: unknown; h?: unknown } | undefined;
    if (
      box !== undefined &&
      (typeof box !== "object" ||
        box === null ||
        Object.entries(box).some(([k, v]) => !["x", "y", "h"].includes(k) || typeof v !== "number" || !Number.isFinite(v)))
    )
      return { problem: `${where}: box takes numbers x, y and h (canvas pixels).` };
    if (box?.h !== undefined && !((box.h as number) > 0)) return { problem: `${where}: box.h must be more than 0 (the frame's height in canvas pixels).` };
    if (op.hold !== undefined && typeof op.hold !== "boolean") return { problem: `${where}: hold must be true or false.` };
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
      hold: op.hold as boolean | undefined,
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
export function expandTextLooks(
  project: Project,
  ops: ReadonlyArray<unknown>,
  pluginLooks: Readonly<Record<string, TextLook>> = {},
): { ops: Array<unknown> } | { problem: string } {
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
    for (const k of ["style", "transform"] as const)
      if (op[k] !== undefined && (typeof op[k] !== "object" || op[k] === null || Array.isArray(op[k]))) return { problem: `${where}: ${k} must be an object.` };
    if (op.animation !== undefined && op.animation !== null && (typeof op.animation !== "object" || Array.isArray(op.animation)))
      return { problem: `${where}: animation must be {in?, out?} or null.` };
    if (op.track !== undefined)
      return { problem: `${where}: track isn't taken: insert_text picks a free text track (or adds one). Use insert_item to put text on a given track.` };
    let now: Project = project;
    try {
      if (out.length) now = applyEdit(createSession(project), { actor: "agent", ops: out as ReadonlyArray<Op> }).project;
    } catch {}
    const plan = planInsertText(
      now,
      {
        look: op.look,
        start: op.start,
        duration: op.duration,
        ...(typeof op.text === "string" ? { text: op.text } : {}),
        ...(typeof op.id === "string" ? { id: op.id } : {}),
        ...(op.style ? { style: op.style as Record<string, never> } : {}),
        ...(op.transform ? { transform: op.transform as { x?: number; y?: number; w?: number } } : {}),
        ...(op.animation !== undefined ? { animation: op.animation as null } : {}),
        ...(op.alone === true ? { alone: true } : {}),
      },
      pluginLooks,
    );
    if ("problem" in plan) return { problem: `${where}: ${plan.problem}` };
    out.push(...plan.ops);
  }
  return { ops: out };
}

/**
 * timeline_edit's ops with each detach_audio (D123), set_speed (D125), put_on_main (D215) and replace_range (issue #118)
 * expanded into the edit ops that do it (core planDetachAudio / planSetSpeed / planPutOnMain / planReplaceRange),
 * planned against the project as the ops before it leave it. Other ops pass through.
 */
export function expandArrangeOps(project: Project, ops: ReadonlyArray<unknown>): { ops: Array<unknown> } | { problem: string } {
  const kinds = new Set(["detach_audio", "set_speed", "put_on_main", "replace_range"]);
  if (!ops.some((op) => kinds.has((op as { op?: unknown })?.op as string))) return { ops: [...ops] };
  const out: Array<unknown> = [];
  for (const [i, raw] of ops.entries()) {
    const op = raw as Record<string, unknown>;
    if (!kinds.has(op?.op as string)) {
      out.push(raw);
      continue;
    }
    const where = `ops[${i}] (${String(op.op)})`;
    const allowed =
      op.op === "detach_audio"
        ? ["op", "item", "id", "track"]
        : op.op === "put_on_main"
          ? ["op", "item", "frame"]
          : op.op === "replace_range"
            ? ["op", "item", "from", "to", "media", "in", "id"]
            : ["op", "item", "speed", "keepPitch"];
    const extra = Object.keys(op).filter((k) => !allowed.includes(k));
    if (extra.length) return { problem: `${where}: unknown field ${extra.join(", ")}.` };
    if (typeof op.item !== "string") return { problem: `${where}: item must be an item id.` };
    let now: Project = project;
    try {
      if (out.length) now = applyEdit(createSession(project), { actor: "agent", ops: out as ReadonlyArray<Op> }).project;
    } catch {}
    if (op.op === "replace_range") {
      // Issue #118: an overwrite edit, nothing after the piece moves.
      if (typeof op.media !== "string") return { problem: `${where}: media must be a media id.` };
      for (const k of ["from", "to", "in"] as const)
        if (op[k] !== undefined && !(Number.isInteger(op[k]) && (op[k] as number) >= 0)) return { problem: `${where}: ${k} must be a whole frame from 0.` };
      if (op.from === undefined || op.to === undefined) return { problem: `${where}: from and to are required (timeline frames).` };
      if (op.id !== undefined && typeof op.id !== "string") return { problem: `${where}: id must be a string.` };
      const plan = planReplaceRange(now, {
        item: op.item,
        from: op.from as number,
        to: op.to as number,
        media: op.media,
        in: op.in as number | undefined,
        id: op.id as string | undefined,
      });
      if ("problem" in plan) return { problem: `${where}: ${plan.problem}` };
      out.push(...plan.ops);
    } else if (op.op === "put_on_main") {
      if (op.frame !== undefined && !(Number.isInteger(op.frame) && (op.frame as number) >= 0))
        return { problem: `${where}: frame must be a whole frame from 0.` };
      const plan = planPutOnMain(now, op.item, { frame: op.frame as number | undefined });
      if ("problem" in plan) return { problem: `${where}: ${plan.problem}` };
      out.push(...plan.ops);
    } else if (op.op === "detach_audio") {
      if (op.id !== undefined && typeof op.id !== "string") return { problem: `${where}: id must be a string.` };
      if (op.track !== undefined && typeof op.track !== "string") return { problem: `${where}: track must be a track id.` };
      const taken = takenIds(now);
      if (typeof op.id === "string" && taken.has(op.id)) return { problem: `${where}: the id ${op.id} is taken.` };
      const plan = planDetachAudio(now, op.item, taken, {
        ...(typeof op.id === "string" ? { id: op.id } : {}),
        ...(typeof op.track === "string" ? { track: op.track } : {}),
      });
      if ("problem" in plan) return { problem: `${where}: ${plan.problem}` };
      out.push(...plan.ops);
    } else {
      if (typeof op.speed !== "number") return { problem: `${where}: speed must be a number from 0.1 to 10.` };
      if (op.keepPitch !== undefined && typeof op.keepPitch !== "boolean") return { problem: `${where}: keepPitch must be true or false.` };
      const plan = planSetSpeed(now, op.item, op.speed, op.keepPitch as boolean | undefined);
      if ("problem" in plan) return { problem: `${where}: ${plan.problem}` };
      out.push(...plan.ops);
    }
  }
  return { ops: out };
}
