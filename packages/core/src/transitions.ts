// The main-track transitions the preview and export draw (D73, D79), and how long one can be at a cut.
// Modules from plugins (not built in) have no known limits here; the server still checks theirs.
// Browser-safe: the renderer's Transitions panel and Inspector, the server's export and the
// agent's docs all read this list. The limits are the modules' manifests'
// (spec/modules/builtin/transition.*.json; test/transitions.test.ts keeps them in step).
//
// How each one draws (timeline.ts visualsAt via transitionAt; export follows it). Every one but dip
// to black overlaps: centred on the cut, the outgoing clip runs half the transition past its end and
// the incoming one starts half before its start, on top; video needs media handles on both sides
// and the sound crossfades over the same frames. p is the share of the transition done, linear in
// frames (0 at its first frame's moment, 1 at its end); none of them ease.
// - transition.crossfade: the incoming clip fades in (opacity p).
// - transition.wipe: the incoming clip, fully opaque, is shown from the left edge of the canvas up
//   to p of its width.
// - transition.iris (D79): the incoming clip, fully opaque, is shown inside a circle at the canvas's
//   centre whose radius grows from 0 to the half diagonal (p · hypot(W, H) / 2: the corners at 1).
// - transition.push-left (D79): both clips move left by p of the canvas width, side by side: the
//   outgoing one shifted −p·W, the incoming one +(1 − p)·W; both opaque.
// - transition.zoom (D79): the outgoing clip's picture grows from 1 to ZOOM_SCALE (linear in p)
//   about its box's centre (the canvas's for a full-frame clip), while the incoming clip fades in
//   over it exactly like a crossfade.
// - transition.dip-to-black: no overlap and no handles. A black layer over the main track fades
//   in over the first half (the outgoing clip's last frames) and out over the second (the
//   incoming clip's first); the cut frame is black. The sound dips too: the outgoing clip fades
//   out over its last half, the incoming one fades in over its first.
// A move (push, zoom) applies to an item's box (box.ts moveBox: clips and components); items
// without one (text, backgrounds, graphics) move as the whole canvas. Iris and wipe reveal the
// canvas, whatever the box. transition.cut and plugin transitions draw as a crossfade.
import type { Item, Media, Project, Track } from "./types.ts";

export interface TransitionInfo {
  readonly id: string;
  readonly name: string;
  /** Limits in frames, from the module's manifest. */
  readonly minFrames: number;
  readonly maxFrames: number;
  /** The length a new one gets, in seconds (then clamped to the limits and the cut). */
  readonly defaultSeconds: number;
  /** The clips overlap at the cut (half the transition each side), so video needs handles. */
  readonly overlaps: boolean;
  readonly description: string;
}

export const CROSSFADE = "transition.crossfade";
export const WIPE = "transition.wipe";
export const DIP_TO_BLACK = "transition.dip-to-black";
export const IRIS = "transition.iris";
export const PUSH_LEFT = "transition.push-left";
export const ZOOM = "transition.zoom";

/** How much larger the outgoing picture is at the end of a zoom transition (D79). */
export const ZOOM_SCALE = 1.2;

export const TRANSITIONS: ReadonlyArray<TransitionInfo> = [
  { id: CROSSFADE, name: "Crossfade", minFrames: 2, maxFrames: 60, defaultSeconds: 0.5, overlaps: true, description: "The next clip fades in over this one." },
  { id: DIP_TO_BLACK, name: "Dip to black", minFrames: 4, maxFrames: 90, defaultSeconds: 0.8, overlaps: false, description: "Fades to black and back up; the sound dips with it. Needs no spare footage." },
  { id: WIPE, name: "Wipe", minFrames: 4, maxFrames: 30, defaultSeconds: 0.5, overlaps: true, description: "The next clip is revealed from the left edge." },
  { id: IRIS, name: "Iris", minFrames: 6, maxFrames: 30, defaultSeconds: 0.5, overlaps: true, description: "The next clip opens in a growing circle from the centre." },
  { id: PUSH_LEFT, name: "Push", minFrames: 4, maxFrames: 30, defaultSeconds: 0.5, overlaps: true, description: "The next clip slides in from the right, pushing this one out to the left." },
  { id: ZOOM, name: "Zoom", minFrames: 4, maxFrames: 30, defaultSeconds: 0.5, overlaps: true, description: "This clip zooms in as the next one fades in over it." },
];

/** The modules the preview and export draw as themselves. */
export const DRAWN_TRANSITIONS: ReadonlyArray<string> = TRANSITIONS.map((t) => t.id);

export const transitionInfo = (module: string | undefined) => TRANSITIONS.find((t) => t.id === module);

/**
 * Frame limits of every built-in transition module (their manifests'; a test keeps them equal), so
 * a length set by hand is clamped as the server checks it. transition.cut has none.
 */
export const TRANSITION_LIMITS: Readonly<Record<string, { readonly minFrames: number; readonly maxFrames: number }>> = Object.fromEntries(TRANSITIONS.map((t) => [t.id, { minFrames: t.minFrames, maxFrames: t.maxFrames }]));

/** Whether a transition overlaps the clips at its cut (everything but dip to black; unknown ones draw as a crossfade). */
export const overlaps = (module: string) => transitionInfo(module)?.overlaps ?? true;

/**
 * What an overlapping transition does to the clips at its cut at share p (D79): `opacity` multiplies
 * the clip's; `wipe` is the share of the canvas width shown from the left, `iris` the share of the
 * half diagonal a centred circle shows (both absent when whole); `shift` moves it right by canvas
 * px and `zoom` scales its picture about its box's centre (absent when not moved).
 */
export interface TransitionFx {
  readonly opacity: number;
  readonly wipe?: number;
  readonly iris?: number;
  readonly shift?: number;
  readonly zoom?: number;
}

const NONE: TransitionFx = { opacity: 1 };

/** The incoming clip at share p (0 ≤ p < 1) of an overlapping `module` transition into it. */
export function incomingFx(module: string, p: number, canvas: { readonly width: number }): TransitionFx {
  if (module === WIPE) return { opacity: 1, wipe: p };
  if (module === IRIS) return { opacity: 1, iris: p };
  if (module === PUSH_LEFT) return { opacity: 1, shift: (1 - p) * canvas.width };
  // Crossfade, zoom, transition.cut and plugins: a fade.
  return { opacity: p };
}

/** The outgoing clip at share p (0 < p ≤ 1) of an overlapping `module` transition out of it. */
export function outgoingFx(module: string, p: number, canvas: { readonly width: number }): TransitionFx {
  if (module === PUSH_LEFT) return { opacity: 1, shift: -p * canvas.width };
  if (module === ZOOM) return { opacity: 1, zoom: 1 + (ZOOM_SCALE - 1) * p };
  return NONE;
}

/** Whether the incoming clip fades in (its opacity ramps) through an overlapping `module` transition. */
export const fadesIn = (module: string) => module !== WIPE && module !== IRIS && module !== PUSH_LEFT;

/** Whether an overlapping `module` transition moves or reveals the outgoing clip too (push, zoom). */
export const movesOutgoing = (module: string) => module === PUSH_LEFT || module === ZOOM;

/** The iris's radius in canvas px at share `iris` (the half diagonal at 1, so the corners are in). */
export const irisRadius = (iris: number, canvas: { readonly width: number; readonly height: number }) => (iris * Math.hypot(canvas.width, canvas.height)) / 2;

/** A transition's name for people ("Crossfade"), or its id when it isn't one the panel knows. */
export const transitionName = (module: string) => transitionInfo(module)?.name ?? module.replace(/^transition\./, "");

/** A new transition's length at this fps, before the cut's limits. */
export const defaultFrames = (info: TransitionInfo, fps: number) => Math.min(info.maxFrames, Math.max(info.minFrames, Math.round(info.defaultSeconds * fps)));

export type TransitionLimits = { readonly min: number; readonly max: number } | { readonly problem: string };

/**
 * How long a `module` transition into the main item `itemId` can be: the module's limits, at most
 * half the shorter clip (rules.ts: both clips at least twice its length), and for an overlapping
 * one the media handles (rules.ts: ceil(d/2) frames of video before the incoming clip's in-point
 * and after the outgoing one's out-point). A problem, as a sentence, when no length fits.
 */
export function transitionLimits(project: Pick<Project, "tracks" | "media">, itemId: string, module: string): TransitionLimits {
  const track = project.tracks.find((t) => t.role === "main" && t.items.some((i) => i.id === itemId));
  if (!track) return { problem: "Transitions go between two clips on the main track." };
  const index = track.items.findIndex((i) => i.id === itemId);
  if (index < 1) return { problem: "The first clip on the main track has nothing to transition from." };
  const limits = TRANSITION_LIMITS[module];
  const prev = track.items[index - 1]!;
  const item = track.items[index]!;
  const min = limits?.minFrames ?? 1;
  let max = Math.min(limits?.maxFrames ?? Infinity, Math.floor(Math.min(prev.duration, item.duration) / 2));
  if (max < min) return { problem: `The clips at this cut are too short for a ${transitionName(module).toLowerCase()}: both need at least ${2 * min} frames.` };
  if (overlaps(module)) {
    const before = handleBefore(project.media, item);
    const after = handleAfter(project.media, prev);
    max = Math.min(max, 2 * before, 2 * after);
    if (max < min) {
      const short = before < after ? `"${item.id}" starts at the beginning of its footage` : `"${prev.id}" ends at the end of its footage`;
      return { problem: `Not enough footage for a ${transitionName(module).toLowerCase()} here: ${short}. Trim the clips at this cut, or use Dip to black.` };
    }
  }
  return { min, max };
}

const videoOf = (media: ReadonlyArray<Media>, item: Item) => {
  const m = item.media ? media.find((x) => x.id === item.media) : undefined;
  return m?.kind === "video" ? m : undefined;
};

/** Spare frames of video before an item's in-point (Infinity for stills, backgrounds and the rest). */
export function handleBefore(media: ReadonlyArray<Media>, item: Item): number {
  return videoOf(media, item) ? Math.max(0, item.in ?? 0) : Infinity;
}

/** Spare frames of video after an item's out-point (as rules.ts counts them: speed aside). */
export function handleAfter(media: ReadonlyArray<Media>, item: Item): number {
  const m = videoOf(media, item);
  if (!m?.probe?.frames) return Infinity;
  return Math.max(0, m.probe.frames - (item.in ?? 0) - item.duration);
}

/** A main-track cut: the clip after it (whose transitionIn it is) and the frame it's on. */
export interface Cut {
  readonly item: Item;
  readonly prev: Item;
  readonly index: number;
  readonly frame: number;
}

/** Every cut between two main-track items, in time order. */
export function cutsOf(track: Track | undefined): Array<Cut> {
  if (!track || track.role !== "main") return [];
  const out: Array<Cut> = [];
  let t = 0;
  track.items.forEach((item, index) => {
    if (index > 0) out.push({ item, prev: track.items[index - 1]!, index, frame: t });
    t += item.duration;
  });
  return out;
}
