// Edits built on vision results (D328): auto reframe (a clip's box keyed to follow its subject on
// a canvas of another shape) and "text behind subject" (the clip copied above the text with its
// background removed). Each is one edit, so one Undo.
import { layout } from "../timeline/timeline.ts";
import { takenIds } from "../timeline/arrange/place.ts";
import { freshId } from "../timeline/agentPlace.ts";
import type { Item, Op, Project, Track } from "../timeline/types.ts";
import { CUTOUT } from "./fx/defs.ts";
import { visionProblem, visionSeconds } from "./vision.ts";

type Plan = { readonly ops: ReadonlyArray<Op>; readonly summary: string } | { readonly problem: string };

export interface SubjectBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// ---- the camera path ----

export interface ReframeOptions {
  /** Frames per second of the clip's frames. */
  readonly fps: number;
  /** The visible window's width, as a share of the picture along the pan (0 to 1]. */
  readonly window: number;
  /** The lowest and highest window centre that keeps the picture covering the canvas (shares of the picture). */
  readonly min: number;
  readonly max: number;
}

/** The low-pass's time constant (s): run forwards then backwards, so it doesn't lag. */
export const REFRAME_SMOOTH_S = 0.4;
/** How far the subject may drift off the window's centre (a share of the window) before the camera moves. */
export const REFRAME_DEAD_ZONE = 0.15;
/** A move takes this long (s) for a small step, up to REFRAME_MOVE_MAX_S for a step of a whole window. */
export const REFRAME_MOVE_MIN_S = 0.5;
export const REFRAME_MOVE_MAX_S = 1.2;

export interface CameraKey {
  readonly frame: number;
  /** The window's centre, a share of the picture along the pan. */
  readonly centre: number;
  readonly ease: "linear" | "inOut";
}

/** Missing subject positions filled from the nearest one before (or after, at the start). */
function filled(positions: ReadonlyArray<number | undefined>): Array<number> | undefined {
  const first = positions.find((p) => p !== undefined);
  if (first === undefined) return undefined;
  let last = first;
  return positions.map((p) => (last = p ?? last));
}

/** A forwards-then-backwards exponential low-pass (no lag), time constant `seconds`. */
export function smooth(values: ReadonlyArray<number>, fps: number, seconds = REFRAME_SMOOTH_S): Array<number> {
  const a = 1 - Math.exp(-1 / Math.max(1e-6, seconds * fps));
  const out = [...values];
  for (let i = 1; i < out.length; i++) out[i] = out[i - 1]! + a * (out[i]! - out[i - 1]!);
  for (let i = out.length - 2; i >= 0; i--) out[i] = out[i + 1]! + a * (out[i]! - out[i + 1]!);
  return out;
}

/** Below this speed (a share of the window a second) the subject counts as still, so a move can end. */
export const REFRAME_STILL = 0.1;

/** A move that starts at `from` lasts at least to `end`, and on while the subject keeps going the same way. */
function moveEnd(path: ReadonlyArray<number>, from: number, end: number, direction: number, still: number): number {
  let last = end;
  while (last < path.length - 1 && (path[last + 1]! - path[last]!) * direction > still) last++;
  return Math.max(from, last);
}

/**
 * The camera's keys for a subject's centre on each frame (shares of the picture along the pan;
 * undefined where nothing was found): smoothed, then held until the subject leaves the dead zone
 * round the window's centre, when one eased move takes it to where the subject is by the move's
 * end (a move lasts while the subject keeps going the same way). Always inside [min, max].
 * Undefined when the subject is never found.
 */
export function reframePath(positions: ReadonlyArray<number | undefined>, o: ReframeOptions): Array<CameraKey> | undefined {
  const known = filled(positions);
  if (!known) return undefined;
  const clamp = (v: number) => Math.min(o.max, Math.max(o.min, v));
  const path = smooth(known, o.fps).map(clamp);
  const dead = REFRAME_DEAD_ZONE * o.window;
  let centre = path[0]!;
  const keys: Array<CameraKey> = [{ frame: 0, centre, ease: "linear" }];
  let f = 1;
  while (f < path.length) {
    if (Math.abs(path[f]! - centre) <= dead) {
      f++;
      continue;
    }
    const share = Math.min(1, Math.abs(path[f]! - centre) / Math.max(o.window, 1e-6));
    const length = Math.max(1, Math.round((REFRAME_MOVE_MIN_S + (REFRAME_MOVE_MAX_S - REFRAME_MOVE_MIN_S) * share) * o.fps));
    const end = moveEnd(path, f, Math.min(path.length - 1, f + length), Math.sign(path[f]! - centre), (REFRAME_STILL * o.window) / o.fps);
    const last = keys.at(-1)!;
    if (last.frame === f - 1 || last.frame === f) keys[keys.length - 1] = { ...last, ease: "inOut" };
    else keys.push({ frame: f - 1, centre, ease: "inOut" });
    centre = path[end]!;
    keys.push({ frame: end, centre, ease: "linear" });
    f = end + 1;
  }
  return keys;
}

// ---- auto reframe ----

export interface ReframeGeometry {
  /** The pan's axis: x when the picture is wider than the canvas, else y. */
  readonly axis: "x" | "y";
  /** The box: the picture at its cover size, centred on the other axis. */
  readonly w: number;
  readonly h: number;
  readonly zoom: number;
  readonly window: number;
  readonly min: number;
  readonly max: number;
}

/** How a picture of `media` size pans on the canvas at cover size times `zoom`; undefined when it already fits. */
export function reframeGeometry(
  canvas: { readonly width: number; readonly height: number },
  media: { readonly width: number; readonly height: number },
  zoom = 1,
): ReframeGeometry | undefined {
  const k = Math.max(canvas.width / media.width, canvas.height / media.height);
  const w = media.width * k;
  const h = media.height * k;
  const axis = w - canvas.width >= h - canvas.height ? "x" : "y";
  const side = axis === "x" ? w : h;
  const view = axis === "x" ? canvas.width : canvas.height;
  if (side - view < 1 && zoom <= 1) return undefined;
  const reach = (side - view) / (2 * zoom * side);
  return { axis, w, h, zoom, window: view / (zoom * side), min: 0.5 - reach, max: 0.5 + reach };
}

/** The box's x (or y) that puts the window's centre at `centre` (a share of the picture). */
export const boxAt = (g: ReframeGeometry, view: number, centre: number) => {
  const side = g.axis === "x" ? g.w : g.h;
  return Math.round((view / 2 - g.zoom * (centre - 0.5) * side - side / 2) * 100) / 100;
};

const locate = (project: Pick<Project, "tracks">, id: string) => {
  for (const track of project.tracks) {
    const index = track.items.findIndex((i) => i.id === id);
    if (index >= 0) return { track, item: track.items[index]! };
  }
  return undefined;
};

/** A subject's centre along the pan: the largest face, else the subject's box. */
export const subjectCentre = (box: SubjectBox | undefined, axis: "x" | "y") => (box ? (axis === "x" ? box.x + box.w / 2 : box.y + box.h / 2) : undefined);

/**
 * Auto reframe: the clip's box becomes its picture at cover size for the canvas, keyed on the pan's
 * axis to follow the subject (`subjectAt`: its box at a media second, undefined where none was
 * found). Other keys stay; the box's x, y and scale keys are replaced.
 */
export function planReframe(
  project: Pick<Project, "tracks" | "media" | "canvas">,
  itemId: string,
  subjectAt: (seconds: number) => SubjectBox | undefined,
  options: { readonly zoom?: number } = {},
): Plan {
  const found = locate(project, itemId);
  if (!found) return { problem: "Pick a clip first." };
  const { track, item } = found;
  if (track.locked || item.locked) return { problem: "That clip is locked: unlock it to reframe it." };
  const problem = visionProblem(project, item, "faces");
  if (problem) return { problem: problem.replace("Face blur works", "Auto reframe works") };
  const media = project.media.find((m) => m.id === item.media)!;
  if (!media.probe?.width || !media.probe?.height) return { problem: "Uncut doesn't know this video's size yet." };
  const zoom = Math.min(4, Math.max(1, options.zoom ?? 1));
  const g = reframeGeometry(project.canvas, { width: media.probe.width, height: media.probe.height }, zoom);
  if (!g) return { problem: "This clip already has the canvas's shape: there's nothing to reframe." };
  const positions = Array.from({ length: item.duration }, (_, f) => subjectCentre(subjectAt(visionSeconds(project, item, f)), g.axis));
  const path = reframePath(positions, { fps: project.canvas.fps, window: g.window, min: g.min, max: g.max });
  if (!path) return { problem: "No face or subject was found in this clip, so there's nothing to follow." };
  const view = g.axis === "x" ? project.canvas.width : project.canvas.height;
  const other =
    g.axis === "x" ? { y: Math.round(((project.canvas.height - g.h) / 2) * 100) / 100 } : { x: Math.round(((project.canvas.width - g.w) / 2) * 100) / 100 };
  const { x: _x, y: _y, w: _w, h: _h, fit: _fit, scale: _scale, ...rest } = item.transform ?? {};
  const transform = {
    ...rest,
    ...other,
    [g.axis]: boxAt(g, view, path[0]!.centre),
    w: Math.round(g.w * 100) / 100,
    h: Math.round(g.h * 100) / 100,
    fit: "cover",
    ...(zoom !== 1 ? { scale: zoom } : {}),
  };
  const kept = (item.keys ?? []).flatMap((k) => {
    const { x: _kx, y: _ky, scale: _ks, ...own } = k;
    return Object.keys(own).some((f) => f !== "frame" && f !== "ease") ? [own] : [];
  });
  const moves = path.length > 1 ? path.map((k) => ({ frame: k.frame, ease: k.ease, [g.axis]: boxAt(g, view, k.centre) })) : [];
  const keys = [...kept, ...moves].sort((a, b) => a.frame - b.frame);
  const name = item.name ?? media.name ?? item.id;
  const moved = Math.max(0, path.length - 1);
  return {
    ops: [{ op: "update_item", item: itemId, set: { transform, keys: keys.length ? keys : null } }],
    summary: `Reframe ${name} to follow the subject${moved ? ` (${Math.ceil(moved / 2)} move${moved > 2 ? "s" : ""})` : ""}`,
  };
}

// ---- text behind subject ----

const spanOf = (starts: ReadonlyMap<string, number>, item: Item) => {
  const from = starts.get(item.id) ?? item.start ?? 0;
  return { from, to: from + item.duration };
};

/**
 * Text behind subject: the video clip under the texts (on a track below them, overlapping them
 * most) copied onto a new track above them, its background removed (person mode), silent. One edit.
 */
export function planTextBehindSubject(project: Project, textIds: ReadonlyArray<string>): Plan & { readonly copyId?: string } {
  const texts = textIds.map((id) => ({ id, at: locate(project, id) }));
  if (!texts.length) return { problem: "Pick a text first." };
  if (texts.some((t) => !t.at || t.at.item.type !== "text")) return { problem: "Text behind subject works on text items: pick one or more texts." };
  const { starts } = layout(project);
  const topIndex = Math.min(...texts.map((t) => project.tracks.indexOf(t.at!.track)));
  const spans = texts.map((t) => spanOf(starts, t.at!.item));
  const from = Math.min(...spans.map((s) => s.from));
  const to = Math.max(...spans.map((s) => s.to));
  const lowest = Math.max(...texts.map((t) => project.tracks.indexOf(t.at!.track)));
  const below = project.tracks.slice(lowest + 1).filter((t: Track) => t.kind === "video" && !t.hidden);
  let best: { item: Item; overlap: number } | undefined;
  for (const track of below)
    for (const item of track.items) {
      if (item.type !== "clip" || project.media.find((m) => m.id === item.media)?.kind !== "video") continue;
      const s = spanOf(starts, item);
      const overlap = Math.min(to, s.to) - Math.max(from, s.from);
      if (overlap > 0 && (!best || overlap > best.overlap)) best = { item, overlap };
    }
  if (!best) return { problem: "There's no video clip under that text to put it behind." };
  const problem = visionProblem(project, best.item, "matte");
  if (problem) return { problem };
  const taken = takenIds(project);
  const trackId = freshId("cutout", taken);
  const copyId = freshId(`${best.item.id}-cutout`, new Set([...taken, trackId]));
  const { gap: _gap, linkedTo: _linked, transitionIn: _transition, ...source } = best.item;
  const effects = [...(source.effects ?? []).filter((e) => e.module !== CUTOUT), { module: CUTOUT, params: { mode: "person", softness: 1, shrink: 0 } }];
  const copy: Item = { ...source, id: copyId, start: spanOf(starts, best.item).from, mute: true, effects };
  const names = new Set(project.tracks.map((t) => t.name));
  let name = "Cutout";
  for (let n = 2; names.has(name); n++) name = `Cutout ${n}`;
  const clipName = best.item.name ?? project.media.find((m) => m.id === best!.item.media)?.name ?? best.item.id;
  return {
    ops: [{ op: "add_track", index: topIndex, track: { id: trackId, kind: "video", name } } as Op, { op: "insert_item", track: trackId, item: copy } as Op],
    summary: `Put the text behind the subject of ${clipName}`,
    copyId,
  };
}
