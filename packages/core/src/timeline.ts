// Timeline maths shared by the preview, export and the agent's frame renders.
// Frame f means the moment f / fps. A transition is centred on its cut: the outgoing clip
// runs half the transition past its end, the incoming one starts half before its start
// and fades in on top.
import type { Item, Project, Track } from "./types.ts";

export interface Visual {
  readonly item: Item;
  readonly track: Track;
  readonly opacity: number;
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
      if (item.type === "text") {
        const fadeIn = item.animation?.in?.module === "move.fade" ? item.animation.in.duration : 0;
        if (fadeIn) opacity = Math.min(1, Math.max(0, (f - start) / fadeIn));
      }
      out.push({ item, track, opacity, source: item.media ? (item.in! + (f - start)) / fps : 0 });
    });
  }
  return out;
}
