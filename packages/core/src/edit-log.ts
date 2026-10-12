// Turns the user's manual edits since the agent's last turn into the short note
// the agent gets before its next turn (D6). The same entries feed the
// "You made N edits by hand" line in the Agent tab.
import type { Id, Op, Project, Session } from "./types.ts";

const secs = (frames: number, fps: number) => `${(Math.abs(frames) / fps).toFixed(1)}s`;

function label(project: Project, id: Id) {
  for (const t of project.tracks) {
    const item = t.items.find((i) => i.id === id);
    if (item) {
      const media = item.media && project.media.find((m) => m.id === item.media);
      const name = item.name ?? (item.text ? `text "${item.text.replace(/\n/g, " ")}"` : (media || undefined)?.name ?? (item.component === "component.solid" ? "background" : item.component) ?? id);
      return `${name} (${id})`;
    }
  }
  return id;
}

/** Hide, lock and mute in words (the timeline's track buttons); undefined for anything else. */
function trackFlag(track: Id, set: { readonly [key: string]: unknown }): string | undefined {
  const keys = Object.keys(set);
  if (keys.length !== 1) return undefined;
  const on = (v: unknown) => v === true;
  if (keys[0] === "hidden") return `${on(set.hidden) ? "Hid" : "Showed"} track ${track}`;
  if (keys[0] === "locked") return `${on(set.locked) ? "Locked" : "Unlocked"} track ${track}`;
  if (keys[0] === "mixer") {
    // Only when the mute flag is the news; other mixer changes keep the generic line.
    const mute = (set.mixer as { readonly mute?: unknown } | null)?.mute;
    if (mute === true) return `Muted track ${track}`;
    if (mute === false) return `Unmuted track ${track}`;
  }
  return undefined;
}

const quote = (text: string, max = 60) => {
  const flat = text.replace(/\n/g, " / ");
  return `"${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}"`;
};
const round = (n: unknown) => (typeof n === "number" ? String(Math.round(n)) : String(n));
const MOVE_NAMES: Readonly<Record<string, string>> = { "move.fade": "fade", "move.rise": "rise", "move.slide-left": "slide left", "move.wipe": "wipe", "move.word-by-word": "word by word" };
const STYLE_WORDS: Readonly<Record<string, (v: unknown) => string>> = {
  preset: (v) => `style ${v}`,
  size: (v) => `size ${round(v)}`,
  weight: (v) => `weight ${v}`,
  color: (v) => `colour ${v}`,
  align: (v) => `aligned ${v}`,
  font: (v) => `font ${v}`,
  tracking: (v) => `tracking ${v}`,
  lineHeight: (v) => `line height ${v}`,
};

/**
 * update_item in words, one clause per changed field: text, style, position, animation and a
 * background's colours read as sentences; anything else as "changed <field>".
 */
function describeUpdate(id: Id, set: { readonly [key: string]: unknown }, project: Project, it: (id: Id) => string, fps: number): string {
  const keys = Object.keys(set);
  if (keys.length === 1 && keys[0] === "text" && typeof set.text === "string") return `Changed the text of ${id} to ${quote(set.text)}`;
  const parts: Array<string> = [];
  const rest: Array<string> = [];
  for (const key of keys) {
    const value = set[key];
    if (key === "text" && typeof value === "string") parts.push(`text ${quote(value)}`);
    else if (key === "style" && value && typeof value === "object") {
      const words = Object.entries(value as Record<string, unknown>).filter(([k]) => STYLE_WORDS[k]).map(([k, v]) => STYLE_WORDS[k]!(v));
      parts.push(words.length ? words.join(", ") : "style reset");
    } else if (key === "transform" && value && typeof value === "object") {
      const t = value as Record<string, unknown>;
      const pos = [t.x !== undefined ? `x ${round(t.x)}` : "", t.y !== undefined ? `y ${round(t.y)}` : ""].filter(Boolean).join(", ");
      parts.push(`position ${pos || "default"}${t.w !== undefined ? `, box ${round(t.w)} wide` : ""}`);
    } else if (key === "animation") {
      const a = (value ?? {}) as Record<string, { module?: string; duration?: number } | undefined>;
      const one = (k: "in" | "out") => (a[k]?.module ? `${MOVE_NAMES[a[k]!.module!] ?? a[k]!.module} ${k} ${secs(a[k]!.duration ?? 0, fps)}` : `no ${k} animation`);
      parts.push(`${one("in")}, ${one("out")}`);
    } else if (key === "props" && value && typeof value === "object") {
      const p = value as Record<string, unknown>;
      parts.push(p.to !== undefined ? `colour ${p.color} to ${p.to} (gradient)` : p.color !== undefined ? `colour ${p.color}` : `props ${Object.keys(p).join(", ")}`);
    } else rest.push(key);
  }
  if (!parts.length) return `Changed ${keys.join(", ")} on ${it(id)}`;
  const tail = `${parts.join("; ")}${rest.length ? `; changed ${rest.join(", ")}` : ""}`;
  if (keys.length === 1 && keys[0] === "transform") return `Moved ${it(id)} on the canvas to ${tail.replace(/^position /, "")}`;
  return `${keys.length === 1 && keys[0] === "animation" ? "Animated" : "Restyled"} ${it(id)}: ${tail}`;
}

export function describeOp(op: Op, project: Project): string {
  const fps = project.canvas.fps;
  const it = (id: Id) => label(project, id);
  switch (op.op) {
    case "trim_item":
      return `${op.frames > 0 ? "Trimmed" : "Extended"} ${it(op.item)} by ${secs(op.frames, fps)} at the ${op.edge}`;
    case "update_item":
      return describeUpdate(op.item, op.set, project, it, fps);
    case "split_item":
      return `Split ${it(op.item)} at ${secs(op.at, fps)}`;
    case "move_item":
      return `Moved ${it(op.item)}${op.track ? ` to track ${op.track}` : ""}${op.start !== undefined ? ` to ${secs(op.start, fps)}` : ""}${op.index !== undefined ? ` to position ${op.index + 1}` : ""}`;
    case "delete_item":
      return `Deleted ${op.item}`;
    case "insert_item":
      if (op.item.type === "component" && op.item.component === "component.solid") {
        const p = op.item.props ?? {};
        return `Added background ${op.item.id} (${p.to !== undefined ? `gradient ${p.color} to ${p.to}` : String(p.color ?? "default colour")}) on track ${op.track}`;
      }
      return `Added ${op.item.type} ${op.item.id} on track ${op.track}`;
    case "set_transition":
      return op.transition ? `Set ${op.transition.module} into ${it(op.item)}` : `Removed the transition into ${it(op.item)}`;
    case "update_track":
      return trackFlag(op.track, op.set) ?? `Changed ${Object.keys(op.set).join(", ")} on track ${op.track}`;
    case "add_track":
      return `Added ${op.track.kind ?? ""} track ${op.track.name ? `"${op.track.name}" (${op.track.id})` : op.track.id}`.replace("  ", " ");
    case "delete_track":
      return `Deleted track ${op.track}`;
    case "add_media":
      return `Added media ${op.media.name} (${op.media.id})`;
    case "update_project":
      return `Changed project ${Object.keys(op.set).join(", ")}`;
    default:
      // Every op is handled above; this is for ops from a newer format.
      return String((op as { op: unknown }).op).replace(/_/g, " ");
  }
}

/** The note the agent receives. Empty string when the user changed nothing. */
export function manualEditsNote(session: Session, sinceRevision: number): string {
  const entries = session.log.filter((e) => e.revision > sinceRevision && e.actor === "user");
  const lines = entries.flatMap((e) => e.ops.map((op) => `- ${describeOp(op, session.project)}`));
  if (!lines.length) return "";
  return [
    `The user made ${lines.length} edit${lines.length === 1 ? "" : "s"} by hand since your last turn (now at revision ${session.revision}).`,
    "They are intentional. Keep them, build on them, and don't undo or question them unless the user asks.",
    ...lines,
  ].join("\n");
}
