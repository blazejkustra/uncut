// A part of the timeline as a project of its own (G7, D127): what "Export In to Out" / "Selected
// clips" / a custom range renders. Browser-safe.
//
// The cut math is the edit engine's: items are cut with trim_item (in points, keys and volume keys
// move as a trim moves them), then every free item is shifted left by `from`. On main, the clips
// before the range go and the ones that straddle it are trimmed (a fade or move the range cuts
// through keeps the part left of it, starting over from its own start: a known approximation); a transition whose blend would
// reach outside the range (or that no longer fits a trimmed clip) goes, so the first frame is a
// clean cut. Captions that follow main follow the trimmed clips; markers and scenes shift. Locks
// don't apply (the result is only rendered). The result passes the timeline rules.
import { applyEdit, createSession } from "./apply-ops.ts";
import { timelineProblems } from "./rules.ts";
import { layout } from "./timeline.ts";
import type { Frame, Mutable, Op, Project } from "./types.ts";

export interface FrameRange {
  readonly from: Frame;
  readonly to: Frame;
}

/** The range clamped to the project ([0, end]); undefined when it's empty. */
export function clampRange(project: Pick<Project, "tracks">, range: FrameRange): FrameRange | undefined {
  const end = layout(project).duration;
  const from = Math.max(0, Math.floor(range.from));
  const to = Math.min(end, Math.ceil(range.to));
  return to > from ? { from, to } : undefined;
}

/** `project` cut to frames [from, to) and shifted so `from` is frame 0 (see the header). */
export function sliceProject(project: Project, range: FrameRange): Project | { readonly problem: string } {
  const r = clampRange(project, range);
  if (!r) return { problem: "That part of the timeline is empty." };
  const { from, to } = r;
  const unlocked = structuredClone(project) as Mutable<Project>;
  for (const t of unlocked.tracks) {
    delete t.locked;
    for (const i of t.items) delete i.locked;
  }
  const { starts } = layout(unlocked);
  const ops: Array<Op> = [];
  const shifts: Array<{ id: string; start: number }> = [];
  // What the range cut off each item's start and end: a fade or an in/out move it cut through
  // keeps only what's left of it, one it cut off entirely goes (else it would play again at the cut).
  const cutOff = new Map<string, { head: number; tail: number }>();
  for (const track of unlocked.tracks) {
    const main = track.role === "main";
    track.items.forEach((item, index) => {
      const s = starts.get(item.id) ?? 0;
      const e = s + item.duration;
      // Captions that follow main (D82) draw wherever their media plays there: they come along.
      if (item.type === "captions" && item.coversMain) {
        shifts.push({ id: item.id, start: Math.max(0, s - from) });
        return;
      }
      if (e <= from || s >= to) {
        ops.push({ op: "delete_item", item: item.id });
        return;
      }
      if (s < from) ops.push({ op: "trim_item", item: item.id, edge: "start", frames: from - s });
      if (e > to) ops.push({ op: "trim_item", item: item.id, edge: "end", frames: e - to });
      if (s < from || e > to) cutOff.set(item.id, { head: Math.max(0, from - s), tail: Math.max(0, e - to) });
      if (main && item.transitionIn) {
        const half = Math.ceil(item.transitionIn.duration / 2);
        // The first clip left, or a blend reaching outside the range: a clean cut instead.
        if (s <= from || s - half < from || s + half > to || index === 0) ops.push({ op: "set_transition", item: item.id, transition: null });
      }
      if (!main) shifts.push({ id: item.id, start: Math.max(s, from) - from });
    });
  }
  const session = applyEdit(createSession(unlocked as Project), { actor: "user", ops });
  const draft = structuredClone(session.project) as Mutable<Project>;
  const byId = new Map(shifts.map((x) => [x.id, x.start]));
  // D224: main items keep their frames in the part (a deleted item before one took its gap with it).
  for (const track of draft.tracks) {
    if (track.role !== "main") continue;
    let end = 0;
    for (const item of track.items) {
      const start = Math.max(end, (starts.get(item.id) ?? 0) - from);
      if (start > end) item.gap = start - end;
      else delete item.gap;
      end = start + item.duration;
    }
  }
  for (const track of draft.tracks) {
    for (const item of track.items) {
      if (byId.has(item.id)) item.start = byId.get(item.id)!;
      const cut = cutOff.get(item.id);
      if (cut?.head) {
        if (item.fadeIn !== undefined) item.fadeIn = Math.max(0, item.fadeIn - cut.head);
        if (item.fadeIn === 0) delete item.fadeIn;
        const a = item.animation?.in;
        if (a && item.animation) {
          if (a.duration <= cut.head) delete item.animation.in;
          else a.duration -= cut.head;
        }
      }
      if (cut?.tail) {
        if (item.fadeOut !== undefined) item.fadeOut = Math.max(0, item.fadeOut - cut.tail);
        if (item.fadeOut === 0) delete item.fadeOut;
        const a = item.animation?.out;
        if (a && item.animation) {
          if (a.duration <= cut.tail) delete item.animation.out;
          else a.duration -= cut.tail;
        }
      }
      if (item.animation && !Object.keys(item.animation).length) delete item.animation;
      // What a trim leaves too long for the shorter item: animations, fades, volume keys.
      for (const k of ["in", "out", "loop"] as const) {
        const a = item.animation?.[k];
        if (a && a.duration > item.duration) a.duration = item.duration;
      }
      if (item.gainKeys?.some((k) => k.frame > item.duration)) item.gainKeys = item.gainKeys.filter((k) => k.frame <= item.duration);
      if (item.gainKeys?.length === 0) delete item.gainKeys;
      if ((item.fadeIn ?? 0) + (item.fadeOut ?? 0) > item.duration) {
        if (item.fadeIn !== undefined) item.fadeIn = Math.min(item.fadeIn, item.duration);
        if (item.fadeOut !== undefined) item.fadeOut = Math.max(0, Math.min(item.fadeOut, item.duration - (item.fadeIn ?? 0)));
        if (item.fadeOut === 0) delete item.fadeOut;
      }
    }
  }
  if (draft.markers) draft.markers = draft.markers.filter((m) => m.frame >= from && m.frame < to).map((m) => ({ ...m, frame: m.frame - from }));
  if (draft.scenes) draft.scenes = draft.scenes.filter((x) => x.end > from && x.start < to).map((x) => ({ ...x, start: Math.max(0, x.start - from), end: Math.min(to, x.end) - from }));
  // Any transition the trims left that no longer fits (too long for a trimmed clip, no handle) goes.
  for (let pass = 0; pass < 4; pass++) {
    const bad = timelineProblems(draft as Project).filter((p) => p.code.startsWith("transition-"));
    if (!bad.length) break;
    for (const p of bad) {
      const id = p.path.split("/items/")[1]?.split("/")[0];
      for (const t of draft.tracks) for (const i of t.items) if (i.id === id) delete i.transitionIn;
    }
  }
  const left = timelineProblems(draft as Project);
  if (left.length) return { problem: `That part can't be exported on its own: ${left[0]!.message}.` };
  return draft as Project;
}
