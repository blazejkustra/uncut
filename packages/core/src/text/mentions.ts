// Names instead of ids for people (D142, AG5) and the agent's <context> block for what the user
// pointed at in the composer (D140, D141). Ids ("m-dji-0005", "title-1") stay in the protocol and
// the agent's prompt; what the user reads says "DJI_0005" and "Kraków from above".
import { componentInfo } from "../visual/components.ts";
import { layout } from "../timeline/timeline.ts";
import type { Item, Project } from "../timeline/types.ts";

export type MentionKind = "media" | "item" | "track" | "marker" | "moment" | "range";
export interface Mention {
  readonly kind: MentionKind;
  readonly id: string;
  readonly label: string;
  readonly range?: { readonly start: number; readonly end: number } | undefined;
  readonly frame?: number | undefined;
}

const oneLine = (s: string) => s.replace(/\[\[|\]\]|\*\*|`/g, "").replace(/\s+/g, " ").trim();
const cut = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** An item in words, without its id: its name, its text, its media's name, or what it is. */
export function itemName(project: Project, item: Item): string {
  if (item.name) return item.name;
  if (typeof item.text === "string" && item.text.trim()) return cut(oneLine(item.text));
  if (item.type === "captions") {
    const source = project.media.find((m) => m.id === item.source);
    return source ? `Captions of ${source.name}` : "Captions";
  }
  const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
  if (media) return media.name;
  if (item.type === "component") {
    if (item.component === "component.solid") return "Background";
    const info = componentInfo(item.component);
    const p = (item.props ?? {}) as Record<string, unknown>;
    const words = [p.title, p.code].find((v): v is string => typeof v === "string" && v.trim() !== "");
    if (info) return words ? `${info.name}: ${cut(words, 30)}` : info.name;
  }
  if (item.type === "graphic" && item.src) return `Graphic ${item.src.replace(/^graphics\//, "")}`;
  return item.type === "text" ? "Text" : item.type === "audio" ? "Sound" : item.type === "clip" ? "Clip" : "Item";
}

/** id → name for the project's media, items and tracks. */
export function namesOf(project: Project): Map<string, string> {
  const names = new Map<string, string>();
  for (const t of project.tracks) {
    names.set(t.id, t.name ?? t.id);
    for (const i of t.items) names.set(i.id, itemName(project, i));
  }
  for (const m of project.media) names.set(m.id, m.name);
  return names;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MEDIA_ID = /(?<![\w-])m-[a-z0-9][a-z0-9-]*(?![\w-])/g;

/**
 * Text for people (AG5): " (id)" after a name goes, media ids become their names (an id no longer
 * in the project loses its "m-"), and item ids that read as ids (with a digit or a hyphen) become
 * the item's name. Track ids alone ("text", "main") are left: they read as words.
 */
export function friendlyText(project: Project | undefined, text: string): string {
  if (!text) return text;
  const names = project ? namesOf(project) : new Map<string, string>();
  let out = text.replace(/ \(([A-Za-z0-9_.:-]+)\)/g, (whole, id: string) => (names.has(id) || /^m-/.test(id) ? "" : whole));
  out = out.replace(MEDIA_ID, (id) => names.get(id) ?? id.slice(2));
  if (project) {
    const items = project.tracks.flatMap((t) => t.items.map((i) => i.id)).filter((id) => /[-\d]/.test(id) && !id.startsWith("m-"));
    if (items.length) {
      const re = new RegExp(`(?<![\\w-])(${items.sort((a, b) => b.length - a.length).map(escape).join("|")})(?![\\w-])`, "g");
      out = out.replace(re, (id) => names.get(id) ?? id);
    }
  }
  return out;
}

/** A chip's label as it may go into the prompt's <context>: one line, no angle brackets, at most 120 characters. */
export const mentionLabel = (label: string) => label.replace(/[\r\n<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "item";

const secs = (frame: number, fps: number) => `${(frame / fps).toFixed(2)} s`;

/**
 * The <context> block for the agent: each chip's label with the real id and what it is, so tools
 * get ids and the user's words keep names. Unknown ids (deleted since) say so.
 */
export function contextBlock(project: Project, mentions: ReadonlyArray<Mention>): string {
  if (!mentions.length) return "";
  const fps = project.canvas.fps;
  const seen = new Set<string>();
  const lines: Array<string> = [];
  for (const raw of mentions) {
    const m = { ...raw, label: mentionLabel(raw.label) };
    const key = `${m.kind}:${m.id}:${m.range?.start ?? ""}:${m.frame ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = m.kind === "moment" || m.kind === "range" ? "" : `${m.range ? `, frames ${m.range.start}–${m.range.end} (${secs(m.range.start, fps)}–${secs(m.range.end, fps)})` : ""}${m.frame !== undefined && m.kind !== "marker" ? `, picked at frame ${m.frame} (${secs(m.frame, fps)})` : ""}`;
    if (m.kind === "media") {
      const media = project.media.find((x) => x.id === m.id);
      if (!media) {
        lines.push(`@${m.label} = media ${m.id} (no longer in the project)`);
        continue;
      }
      const used = project.tracks.reduce((n, t) => n + t.items.filter((i) => i.media === media.id).length, 0);
      const facts = [media.kind, media.probe?.frames ? secs(media.probe.frames, fps) : "", media.probe?.width ? `${media.probe.width}x${media.probe.height}` : "", used ? `used ${used}x on the timeline` : "not on the timeline"].filter(Boolean);
      lines.push(`@${m.label} = media ${media.id} (${facts.join(", ")})${at}`);
    } else if (m.kind === "item") {
      const track = project.tracks.find((t) => t.items.some((i) => i.id === m.id));
      const item = track?.items.find((i) => i.id === m.id);
      if (!track || !item) {
        lines.push(`@${m.label} = item ${m.id} (no longer on the timeline)`);
        continue;
      }
      const media = item.media ? project.media.find((x) => x.id === item.media) : undefined;
      const facts = [`${item.type} on track ${track.id}${track.name && track.name !== track.id ? ` "${track.name}"` : ""}`, media ? `media ${media.id}` : "", typeof item.text === "string" ? `text "${cut(oneLine(item.text), 60)}"` : ""].filter(Boolean);
      lines.push(`@${m.label} = item ${item.id} (${facts.join(", ")})${at}`);
    } else if (m.kind === "moment") {
      const frame = m.frame ?? 0;
      lines.push(`@${m.label} = the moment at frame ${frame} (${secs(frame, fps)}): ${describeAt(project, frame, frame + 1)}`);
    } else if (m.kind === "range") {
      const r = m.range ?? { start: 0, end: 0 };
      lines.push(`@${m.label} = the stretch from frame ${r.start} to ${r.end} (${secs(r.start, fps)}–${secs(r.end, fps)}, end not included): ${describeAt(project, r.start, Math.max(r.start + 1, r.end))}`);
    } else if (m.kind === "track") {
      const track = project.tracks.find((t) => t.id === m.id);
      lines.push(track ? `@${m.label} = track ${track.id} (${track.kind}${track.role ? `, ${track.role}` : ""}, ${track.items.length} item${track.items.length === 1 ? "" : "s"})` : `@${m.label} = track ${m.id} (no longer in the project)`);
    } else {
      const frame = m.frame ?? Number(m.id.replace(/^frame:/, ""));
      lines.push(Number.isFinite(frame) && frame >= 0 ? `@${m.label} = marker at frame ${frame} (${secs(frame, fps)})` : `@${m.label} = a marker (its frame is unknown)`);
    }
  }
  return `<context>\nWhat the user's @labels point at (use the ids in tools; say the names to the user):\n${lines.join("\n")}\n</context>`;
}

/**
 * What's on the timeline in frames [from, to) (D183): every item that plays there, top track first,
 * with its id, type and track, and a text's words. For a moment's or a range's <context> line.
 */
export function describeAt(project: Project, from: number, to: number): string {
  const { starts } = layout(project);
  const found: Array<string> = [];
  for (const track of project.tracks) {
    for (const item of track.items) {
      const start = starts.get(item.id) ?? 0;
      if (start >= to || start + item.duration <= from) continue;
      const words = typeof item.text === "string" && item.text.trim() ? ` "${cut(oneLine(item.text), 60)}"` : "";
      const name = itemName(project, item);
      found.push(`${item.id} (${item.type}${words || name === item.id ? "" : ` "${cut(name, 40)}"`}${words}, track ${track.id}${track.hidden ? ", hidden" : ""}, frames ${start}–${start + item.duration})`);
    }
  }
  if (!found.length) return "nothing on the timeline there";
  return `on the timeline there: ${found.slice(0, 12).join("; ")}${found.length > 12 ? `; and ${found.length - 12} more` : ""}`;
}

/** A moment's label (D183): m:ss, with tenths when it isn't on a whole second ("0:12", "1:02.5"). */
export function momentLabel(frame: number, fps: number): string {
  const tenths = Math.round((frame / fps) * 10);
  const m = Math.floor(tenths / 600);
  const rest = tenths - m * 600;
  const s = Math.floor(rest / 10);
  const t = rest % 10;
  return `${m}:${String(s).padStart(2, "0")}${t ? `.${t}` : ""}`;
}

/** A typed moment (D183): "0:12", "1:02.5", "12s", "12.5s" → the frame at fps, or undefined. */
export function parseMoment(text: string, fps: number): number | undefined {
  const clock = /^(\d{1,3}):([0-5]\d)(?:\.(\d{1,2}))?$/.exec(text);
  const plain = /^(\d{1,5})(?:\.(\d{1,2}))?s$/.exec(text);
  let seconds: number;
  if (clock) seconds = Number(clock[1]) * 60 + Number(clock[2]) + (clock[3] ? Number(`0.${clock[3]}`) : 0);
  else if (plain) seconds = Number(plain[1]) + (plain[2] ? Number(`0.${plain[2]}`) : 0);
  else return undefined;
  return Math.round(seconds * fps);
}

/** What @ offers in the composer: media, tracks, timeline items and markers, by name. */
export function mentionCandidates(project: Project): Array<Mention & { readonly detail: string }> {
  const fps = project.canvas.fps;
  const out: Array<Mention & { detail: string }> = [];
  for (const m of project.media) out.push({ kind: "media", id: m.id, label: m.name, detail: m.kind === "video" ? "Video" : m.kind === "audio" ? "Sound" : "Image" });
  for (const t of project.tracks) {
    for (const i of t.items) out.push({ kind: "item", id: i.id, label: itemName(project, i), detail: `${t.name ?? t.id}${i.start !== undefined ? `, ${secs(i.start, fps)}` : ""}` });
  }
  for (const t of project.tracks) out.push({ kind: "track", id: t.id, label: t.name ?? t.id, detail: "Track" });
  for (const mk of project.markers ?? []) out.push({ kind: "marker", id: `frame:${mk.frame}`, label: mk.label ?? `Marker ${secs(mk.frame, fps)}`, frame: mk.frame, detail: "Marker" });
  return out;
}

// Camera-style file names (Fable QA round 2, F13, D150): "DJI_20261013182112_0042_D.MP4" is what
// a drone writes, not what a person calls the clip. On import such a file gets a short display
// name ("DJI 0042"); the file itself is untouched and any other name stays as it is.
const CAMERA_PREFIX = /^(DJI|IMG|MVI|DSC|DSCF|MAH|VID|PXL|GOPR)[_-]?(?:(\d{8})[_-](\d{6,9})|(?:\d{8,14}[_-])?(\d{3,}))(?:[_-][A-Z0-9]{1,4})?$/i;
const GOPRO = /^(G[XHL])\d{2}(\d{4})$/i;
const SONY = /^(C\d{4})(?:M\d{2})?$/i;

/** A short display name for a camera-style file name ("DJI 0042", "IMG 1234", "GX 0042", "C0001"), or undefined for other names. */
export function cameraName(fileName: string): string | undefined {
  const stem = fileName.replace(/\.[A-Za-z0-9]{2,4}$/, "");
  const cam = CAMERA_PREFIX.exec(stem);
  if (cam) {
    const prefix = cam[1]!.toUpperCase();
    // A date and a time (VID_20240101_123456): the time is the clip's number.
    const digits = cam[3] ?? cam[4]!;
    return `${prefix} ${digits.length > 6 ? digits.slice(-4) : digits}`;
  }
  const gopro = GOPRO.exec(stem);
  if (gopro) return `${gopro[1]!.toUpperCase()} ${gopro[2]}`;
  const sony = SONY.exec(stem);
  if (sony) return sony[1]!.toUpperCase();
  return undefined;
}
