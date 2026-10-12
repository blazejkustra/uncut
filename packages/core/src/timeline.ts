// Timeline maths shared by the preview, export and the agent's frame renders.
// Frame f means the moment f / fps. A transition is centred on its cut: the outgoing clip
// runs half the transition past its end, the incoming one starts half before its start
// and fades in on top.
import type { Motion } from "./render.ts";
import type { Canvas, Item, Project, Track } from "./types.ts";

export interface Visual {
  readonly item: Item;
  readonly track: Track;
  readonly opacity: number;
  /** Offset and wipe from the item's in/out animation (opacity is already in `opacity`). */
  readonly motion: Motion;
  /** Source time in seconds (0 for items without media). */
  readonly source: number;
}

/** Start frame of every item and the project length. */
export function layout(project: Pick<Project, "tracks">): { starts: Map<string, number>; duration: number } {
  const starts = new Map<string, number>();
  let duration = 1;
  for (const track of project.tracks) {
    let t = 0;
    for (const item of track.items) {
      const start = track.role === "main" ? t : item.start!;
      if (track.role === "main") t += item.duration;
      starts.set(item.id, start);
      duration = Math.max(duration, start + item.duration);
    }
  }
  return { starts, duration };
}

/** Everything visible at frame f, bottom layer first, with opacity and source time in seconds. */
export function visualsAt(project: Pick<Project, "tracks" | "canvas">, starts: ReadonlyMap<string, number>, f: number): Array<Visual> {
  const fps = project.canvas.fps;
  const out: Array<Visual> = [];
  for (const track of [...project.tracks].reverse()) {
    if (track.hidden || track.kind === "audio") continue;
    track.items.forEach((item, i) => {
      const start = starts.get(item.id)!;
      const half = item.transitionIn ? item.transitionIn.duration / 2 : 0;
      const next = track.items[i + 1];
      const nextHalf = track.role === "main" && next?.transitionIn ? next.transitionIn.duration / 2 : 0;
      const from = start - half;
      const to = start + item.duration + nextHalf;
      if (f < from || f >= to) return;
      let opacity = 1;
      if (half && f < start + half) opacity = Math.min(1, Math.max(0, (f - from) / (2 * half)));
      // A main-track transition owns the blend at its cut: the in/out animation on that side is skipped.
      const anim = animationAt(item, f - start, project.canvas, { skipIn: half > 0, skipOut: nextHalf > 0 });
      opacity *= anim.opacity;
      out.push({ item, track, opacity, motion: anim.motion, source: item.media ? ((item.in ?? 0) + (f - start) * (item.speed ?? 1)) / fps : 0 });
    });
  }
  return out;
}

// The built-in moves (spec/modules/builtin/move.*.json) the preview and export draw. Others
// (word-by-word) are valid in project.json but show the item without motion for now.
export const DRAWN_MOVES = ["move.fade", "move.rise", "move.slide-left", "move.wipe"] as const;

const easeOut = (p: number) => 1 - (1 - p) ** 3;
const clamp01 = (p: number) => Math.min(1, Math.max(0, p));

/**
 * An item's in and out animation at `local` frames from its start. The in-animation runs from 0
 * at the first frame to 1 at `duration`; the out-animation from 1 to 0 on the item's last frame,
 * so a faded item is fully transparent on its first and last frame. Fade changes opacity
 * linearly; rise and slide-left also move (eased) by 4 % of the height / 5 % of the width; wipe
 * reveals the box from the left.
 */
export function animationAt(item: Pick<Item, "duration" | "animation">, local: number, canvas: Pick<Canvas, "width" | "height">, { skipIn = false, skipOut = false } = {}): { opacity: number; motion: Motion } {
  let opacity = 1;
  let dx = 0;
  let dy = 0;
  let reveal = 1;
  const apply = (module: string, p: number, out: boolean) => {
    const e = easeOut(p);
    if (module === "move.fade") opacity *= p;
    else if (module === "move.rise") {
      opacity *= p;
      dy += (out ? -1 : 1) * (1 - e) * canvas.height * 0.04;
    } else if (module === "move.slide-left") {
      opacity *= p;
      dx += (out ? -1 : 1) * (1 - e) * canvas.width * 0.05;
    } else if (module === "move.wipe") reveal = Math.min(reveal, e);
  };
  const a = item.animation;
  // Outside the item's own frames (a transition's pre-roll and tail) it holds its first / last
  // state; with skipIn/skipOut (the transition at that cut blends instead) it doesn't apply.
  const at = Math.max(0, Math.min(item.duration - 1, local));
  if (!skipIn && a?.in && a.in.duration > 0 && at < a.in.duration) apply(a.in.module, clamp01(at / a.in.duration), false);
  if (!skipOut && a?.out && a.out.duration > 0) {
    const left = item.duration - 1 - at;
    if (left < a.out.duration) apply(a.out.module, clamp01(left / a.out.duration), true);
  }
  const motion: { dx?: number; dy?: number; reveal?: number } = {};
  if (dx) motion.dx = dx;
  if (dy) motion.dy = dy;
  if (reveal < 1) motion.reveal = reveal;
  return { opacity, motion };
}
