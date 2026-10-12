// Beats on the timeline (D70): the cached beats of the media used by the timeline's items with
// sound, read from the server's analysis cache (analysis.cached, never a job: analysis is on
// demand, D66), and read again when a beats job for one of them finishes. The timeline draws them
// as ticks and, with snapping on, moves, trims and the playhead stick to them (edit.ts).
import { useEffect, useRef, useSyncExternalStore } from "react";

import type { BeatMap } from "./edit.ts";
import type { ProjectModel } from "./project.ts";
import { hasSound } from "./sound.ts";
import { actions, useApp } from "./store.ts";

/** A media file's beats analysis as the editor keeps it. */
export interface MediaBeats {
  /** null: no steady beat. */
  readonly bpm: number | null;
  readonly confidence: number;
  /** Seconds of the file. */
  readonly beats: ReadonlyArray<number>;
}

export interface BeatsState {
  readonly dir: string | undefined;
  /** By media id: the analysis, null when none is cached (or the media has no sound), "failed" when it couldn't be read (read again on reconnect; Find beats still works). Missing: being read. */
  readonly entries: ReadonlyMap<string, MediaBeats | null | "failed">;
  /** Beat times of the media that have some, for drawing and snapping. */
  readonly map: BeatMap;
}

let state: BeatsState = { dir: undefined, entries: new Map(), map: new Map() };
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const useBeats = <T>(select: (s: BeatsState) => T): T => useSyncExternalStore(subscribe, () => select(state));
export const getBeats = () => state;

function setEntry(dir: string, mediaId: string, entry: MediaBeats | null | "failed") {
  if (dir !== state.dir) return;
  const entries = new Map(state.entries);
  entries.set(mediaId, entry);
  const map = new Map<string, ReadonlyArray<number>>();
  for (const [id, e] of entries) if (e && e !== "failed" && e.beats.length) map.set(id, e.beats);
  state = { ...state, entries, map };
  for (const l of listeners) l();
}

function forProject(dir: string) {
  if (dir === state.dir) return;
  state = { dir, entries: new Map(), map: new Map() };
  for (const l of listeners) l();
}

// Reads in flight (by dir and media), so a reconnect or a finished job doesn't read twice at once.
const reading = new Set<string>();

async function load(dir: string, mediaId: string) {
  const key = `${dir}\0${mediaId}`;
  if (reading.has(key)) return;
  reading.add(key);
  let result: { hasAudio?: boolean; bpm?: number | null; confidence?: number; beats?: ReadonlyArray<number> } | null | undefined;
  try {
    // The onsets stay on the server: the timeline only draws and snaps to beats.
    result = (await actions.analysisCached(mediaId, "beats", ["onsets"])) as typeof result;
  } finally {
    reading.delete(key);
  }
  // undefined: the call failed (offline, a server error).
  if (result === undefined) return setEntry(dir, mediaId, "failed");
  setEntry(dir, mediaId, result?.hasAudio ? { bpm: result.bpm ?? null, confidence: result.confidence ?? 0, beats: result.beats ?? [] } : null);
}

/** The media with sound used on the timeline. */
const soundMediaIds = (project: ProjectModel) => [...new Set(project.tracks.flatMap((t) => t.items.filter((i) => i.media && hasSound(project, i)).map((i) => i.media!)))].sort();

/** Keeps the beats of the timeline's media loaded for the open project. */
export function useBeatsLoading(project: ProjectModel, dir: string) {
  const { analysisJobs, connection } = useApp();
  const online = connection === "connected";
  const media = soundMediaIds(project);
  const key = media.join(",");
  const seen = useRef(new Set<string>());
  useEffect(() => forProject(dir), [dir]);
  useEffect(() => {
    if (!online || state.dir !== dir) return;
    // Not read yet, or a read that failed (read again when the connection is back).
    for (const id of media) if (!state.entries.has(id) || state.entries.get(id) === "failed") void load(dir, id);
  }, [online, dir, key]);
  useEffect(() => {
    for (const job of analysisJobs) {
      if (job.projectDir !== dir || job.analyzer !== "beats" || job.phase !== "done" || seen.current.has(job.id)) continue;
      seen.current.add(job.id);
      for (const id of new Set([job.mediaId, ...job.mediaIds])) void load(dir, id);
    }
  }, [analysisJobs, dir]);
}
