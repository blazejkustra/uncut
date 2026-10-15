// Transition and track-flag planners (edit.ts), and how a cut fits its transition.
import { type Cut, cutsOf, transitionName, transitionLimits, transitionInfo, defaultFrames, overlaps, handleBefore, handleAfter } from "@uncut/core/transitions";
import type { TimedModule } from "@uncut/core/types";
import type { ProjectModel, Track } from "../../state/project.ts";
import { type Plan, findItem, lockOf, secondsLabel } from "./base.ts";

// ---- transitions (D73) ----

/** The main track's cuts (see core cutsOf). */
export const mainCuts = (project: ProjectModel): Array<Cut> => cutsOf(project.tracks.find((t) => t.role === "main"));

/** The cut nearest to a frame, if the main track has one. */
export function nearestCut(project: ProjectModel, frame: number): Cut | undefined {
  let best: Cut | undefined;
  for (const cut of mainCuts(project)) if (!best || Math.abs(cut.frame - frame) < Math.abs(best.frame - frame)) best = cut;
  return best;
}

/**
 * Set, change or remove (null) the transition into the main item `itemId`, as one edit with the
 * label history.db and the agent's note show ("Added crossfade", "Changed transition to 0.8 s",
 * "Changed transition to wipe", "Removed crossfade"). A new one gets the module's default length;
 * a changed type keeps the length; every length is clamped to the module's limits and the cut's
 * (core transitionLimits: half the shorter clip, the media handles). No ops when nothing changes.
 */
export function planSetTransition(project: ProjectModel, itemId: string, next: { readonly module: string; readonly duration?: number } | null): Plan | { readonly problem: string } {
  const placed = findItem(project, itemId);
  if (!placed || placed.track.role !== "main") return { problem: "Transitions go between two clips on the main track." };
  if (placed.index === 0) return { problem: "The first clip on the main track has nothing to transition from." };
  const locked = lockOf(placed) ?? (placed.track.items[placed.index - 1]?.locked ? "The clip before this cut is locked." : undefined);
  if (locked) return { problem: locked };
  const before = placed.item.transitionIn;
  if (next === null) {
    if (!before) return { ops: [], summary: "" };
    return { ops: [{ op: "set_transition", item: itemId, transition: null }], summary: `Removed ${transitionName(before.module).toLowerCase()}` };
  }
  const limits = transitionLimits(project, itemId, next.module);
  if ("problem" in limits) return limits;
  const info = transitionInfo(next.module);
  const wanted = next.duration ?? before?.duration ?? (info ? defaultFrames(info, project.canvas.fps) : limits.min);
  const duration = Math.min(limits.max, Math.max(limits.min, Math.round(wanted)));
  const transition: TimedModule = { module: next.module, duration };
  if (before && before.module === transition.module && before.duration === duration) return { ops: [], summary: "" };
  const name = transitionName(next.module).toLowerCase();
  const summary = !before ? `Added ${name}` : before.module !== next.module ? `Changed transition to ${name}` : `Changed transition to ${secondsLabel(duration, project.canvas.fps)}`;
  return { ops: [{ op: "set_transition", item: itemId, transition }], summary };
}

export type TrackFlag = "hidden" | "locked" | "mute" | "solo";

export const trackFlag = (track: Track, flag: TrackFlag) => (flag === "mute" || flag === "solo" ? track.mixer?.[flag] === true : track[flag] === true);

/** Hide, lock, mute or solo a track (mute and solo are stored in its mixer, D54/D83). */
export function planTrackFlag(project: ProjectModel, trackId: string, flag: TrackFlag): Plan | { readonly problem: string } {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return { problem: "That track isn't in the project any more." };
  const on = !trackFlag(track, flag);
  // Off removes the flag (null), so project.json stays clean; mute and solo keep the rest of the mixer.
  if (flag === "solo") {
    const { solo: _, ...rest } = track.mixer ?? {};
    const mixer = on ? { ...rest, solo: true } : rest;
    return { ops: [{ op: "update_track", track: track.id, set: { mixer: Object.keys(mixer).length ? mixer : null } }], summary: `${on ? "Solo" : "Unsolo"} ${track.name}` };
  }
  const verb = { hidden: on ? "Hide" : "Show", locked: on ? "Lock" : "Unlock", mute: on ? "Mute" : "Unmute" }[flag];
  const set = flag === "mute" ? { mixer: { ...track.mixer, mute: on } } : { [flag]: on ? true : null };
  return { ops: [{ op: "update_track", track: track.id, set }], summary: `${verb} track ${track.name}` };
}

/**
 * Whether a transition fits a cut (F9, D153), for the Transitions tiles and the cut's type list: it
 * fits (with the longest it can be there, and whether `wanted` frames get shortened to it), or
 * not, with a short word for a tile ("Needs 0.3 s more footage", "Clips too short") and the
 * planner's sentence.
 */
export type CutFit = { readonly fits: true; readonly max: number; readonly clamped: boolean } | { readonly fits: false; readonly short: string; readonly problem: string };
export function cutFit(project: ProjectModel, cutId: string, module: string, wanted?: number): CutFit {
  const limits = transitionLimits(project, cutId, module);
  if (!("problem" in limits)) return { fits: true, max: limits.max, clamped: wanted !== undefined && wanted > limits.max };
  const placed = findItem(project, cutId);
  const prev = placed && placed.track.role === "main" ? placed.track.items[placed.index - 1] : undefined;
  const info = transitionInfo(module);
  if (placed && prev && info && overlaps(module) && /footage/.test(limits.problem)) {
    const have = Math.min(handleBefore(project.media, placed.item), handleAfter(project.media, prev));
    const need = Math.max(1, Math.ceil(info.minFrames / 2) - have);
    return { fits: false, short: `Needs ${secondsLabel(need, project.canvas.fps)} more footage`, problem: limits.problem };
  }
  return { fits: false, short: /too short/.test(limits.problem) ? "Clips too short" : "Doesn't fit here", problem: limits.problem };
}
