// The timeline rules a schema can't express and that need no installed modules: item kinds per
// track, starts, media ranges, keys, fades, animations, transitions between main items, overlaps.
// Browser-safe (no node:fs, no ajv), so the renderer checks a drag's planned result with the same
// rules the server's validator uses (D52) before showing it as droppable.
import { overlaps } from "./transitions.ts";
import type { Item, ItemType, Media, Problem, Project, Track } from "./types.ts";

const ITEM_TRACK_KINDS: Readonly<Record<ItemType, ReadonlyArray<Track["kind"]>>> = {
  clip: ["video"],
  component: ["video"],
  graphic: ["video"],
  text: ["text"],
  captions: ["text"],
  audio: ["audio"],
};

const err = (code: string, path: string, message: string): Problem => ({ code, path, message });

/** Start frame of every item: main-track items play back to back, free items carry `start`. */
export function resolveStarts(project: Pick<Project, "tracks">): Map<string, number> {
  const starts = new Map<string, number>();
  for (const track of project.tracks) {
    let t = 0;
    for (const item of track.items) {
      if (track.role === "main") {
        starts.set(item.id, t);
        t += item.duration;
      } else {
        starts.set(item.id, item.start ?? 0);
      }
    }
  }
  return starts;
}

export function projectDuration(project: Pick<Project, "tracks">): number {
  const starts = resolveStarts(project);
  let end = 0;
  for (const track of project.tracks) for (const item of track.items) end = Math.max(end, starts.get(item.id)! + item.duration);
  return end;
}

/** Problems with the timeline itself (see the header). Expects a project of the right shape. */
export function timelineProblems(project: Pick<Project, "tracks" | "media">): Array<Problem> {
  const errors: Array<Problem> = [];
  const media = new Map<string, Media>(project.media.map((m) => [m.id, m]));
  const starts = resolveStarts(project);
  const startOf = (item: Item) => starts.get(item.id)!;
  for (const track of project.tracks) {
    const tpath = `/tracks/${track.id}`;
    const main = track.role === "main";
    track.items.forEach((item, index) => {
      const ipath = `${tpath}/items/${item.id}`;
      if (!ITEM_TRACK_KINDS[item.type]?.includes(track.kind)) errors.push(err("item-track-kind", ipath, `a ${item.type} item can't go on a ${track.kind} track`));
      if (main && item.start !== undefined) errors.push(err("main-item-start", ipath, "main-track items play back to back and must not have a start"));
      if (!main && item.start === undefined) errors.push(err("missing-start", ipath, "items on free tracks need a start frame"));

      // Media references and ranges.
      const mediaId = item.type === "captions" ? item.source : item.media;
      if (mediaId !== undefined) {
        const m = media.get(mediaId);
        if (!m) errors.push(err("unknown-media", ipath, `media "${mediaId}" does not exist`));
        else {
          const needsAudio = item.type === "audio" || item.type === "captions";
          if (needsAudio && !(m.kind === "audio" || m.probe?.hasAudio)) errors.push(err("media-kind", ipath, `"${mediaId}" has no audio`));
          if (!needsAudio && m.kind === "audio") errors.push(err("media-kind", ipath, `"${mediaId}" is audio-only`));
          const used = (item.in ?? 0) + item.duration * (item.speed ?? 1);
          if (m.kind !== "image" && m.probe?.frames && !item.loop && item.type !== "captions" && used > m.probe.frames) {
            errors.push(err("media-range", ipath, `uses frames up to ${used} but "${mediaId}" has ${m.probe.frames}`));
          }
        }
      }

      for (const [k, a] of Object.entries(item.animation ?? {})) {
        if (a && a.duration > item.duration) errors.push(err("animation-too-long", `${ipath}/animation/${k}`, `${k} animation is longer than the item`));
      }
      for (const k of item.gainKeys ?? []) {
        if (k.frame > item.duration) errors.push(err("key-range", `${ipath}/gainKeys`, `key at ${k.frame} is past the item's end (${item.duration})`));
      }
      for (const k of item.keys ?? []) {
        if (k.frame > item.duration) errors.push(err("key-range", `${ipath}/keys`, `key at ${k.frame} is past the item's end (${item.duration})`));
      }
      if ((item.fadeIn ?? 0) + (item.fadeOut ?? 0) > item.duration) errors.push(err("fade-too-long", ipath, "fades are longer than the item"));

      // Transitions only between two main-track items, and no longer than either.
      if (item.transitionIn) {
        const tr = item.transitionIn;
        if (!main) errors.push(err("transition-track", ipath, "transitions only go between items on the main track"));
        else if (index === 0) errors.push(err("transition-first", ipath, "the first main-track item has nothing to transition from"));
        else {
          const prev = track.items[index - 1]!;
          if (tr.duration > Math.min(prev.duration, item.duration) / 2) {
            errors.push(err("transition-too-long", ipath, `a ${tr.duration}-frame transition needs both items to be at least ${tr.duration * 2} frames`));
          }
          // An overlapping transition is centred on the cut, so both clips need spare media
          // (handles) past the cut; a dip to black keeps them apart and needs none.
          const half = overlaps(tr.module) ? Math.ceil(tr.duration / 2) : 0;
          const prevMedia = prev.media && media.get(prev.media);
          const curMedia = item.media && media.get(item.media);
          if (half > 0 && curMedia && curMedia.kind === "video" && (item.in ?? 0) < half) {
            errors.push(err("transition-handles", ipath, `needs ${half} frames of "${item.media}" before its in-point for the ${tr.module}`));
          }
          if (half > 0 && prevMedia && prevMedia.kind === "video" && prevMedia.probe?.frames && (prev.in ?? 0) + prev.duration + half > prevMedia.probe.frames) {
            errors.push(err("transition-handles", ipath, `"${prev.id}" needs ${half} frames of "${prev.media}" after its out-point for the ${tr.module}`));
          }
        }
      }
    });

    // Free tracks: nothing may overlap on one track.
    if (!main) {
      const sorted = [...track.items].sort((a, b) => startOf(a) - startOf(b));
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1]!;
        const b = sorted[i]!;
        if (startOf(b) < startOf(a) + a.duration) errors.push(err("overlap", `${tpath}/items/${b.id}`, `"${b.id}" overlaps "${a.id}" on track "${track.id}"`));
      }
    }
  }
  return errors;
}
