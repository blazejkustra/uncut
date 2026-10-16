import { decodeEnvelope } from "@uncut/core/transcript";
import { useSyncExternalStore, useRef, useEffect } from "react";
import { type CaptionMode, CAPTION_DEFAULTS } from "@uncut/core/captions";
import type { Plan } from "../../timeline/edit.ts";
import { playback } from "../../preview/playback.ts";
import type { ProjectModel } from "../../state/project.ts";
import { actions, getState, projectOf, useApp } from "../../state/store.ts";
import { defaultCaptionStyle } from "../../inspector/captionStyle.ts";
import { transcriptStore, getTranscripts, selectedWords, wordsOfEdit, doneTranscripts, scopeOf, planCutWords, planCaptions, planRemovePauses, planRemoveFillers, mediaOnMain, type MediaTranscript, type TranscriptEntry, useTranscripts } from "../transcript.ts";
import { pauseMin } from "./threshold.ts";

/** Send a transcript plan as one edit (one ⌘Z), then drop the selection. */
async function sendCut(plan: Plan | { readonly problem: string }) {
  const applied = await actions.timelineEdit(plan);
  if (applied) transcriptStore.clear();
  return applied;
}

/** How long a cut waits for a loudness analysis it started (as the agent's transcript_edit, D74). */
const LOUDNESS_WAIT_MS = 20_000;

/**
 * Before cutting: the loudness analysis (silences and speech envelope, D74) of these media, run
 * when it isn't cached and waited for up to LOUDNESS_WAIT_MS, then their transcripts re-read, so
 * the panel cuts where the agent's transcript_edit would. Without it (failed, an export holds the
 * queue, too slow) the cut uses the transcript's own edges.
 */
async function withLoudness(mediaIds: ReadonlyArray<string>) {
  const dir = getTranscripts().dir;
  const missing = mediaIds.filter((id) => {
    const e = getTranscripts().entries.get(id);
    return e?.state === "done" && !e.transcript.measured && !loudnessFailed.has(`${dir}:${id}`);
  });
  if (!dir || !missing.length) return;
  await Promise.all(
    missing.map(async (id) => {
      const startedAt = Date.now();
      await actions.analyzeMedia(id);
      // Couldn't start (or a job of it failed / was stopped): not again for this media this session.
      const failed = () =>
        getState().analysisError !== undefined ||
        getState().analysisJobs.some((j) => j.projectDir === dir && j.analyzer === "loudness" && (j.mediaId === id || j.mediaIds.includes(id)) && (j.phase === "failed" || j.phase === "cancelled") && Date.parse(j.startedAt) >= startedAt - 1000);
      const deadline = startedAt + LOUDNESS_WAIT_MS;
      while (Date.now() < deadline) {
        if (failed()) {
          loudnessFailed.add(`${dir}:${id}`);
          return;
        }
        if (await actions.analysisCached(id, "loudness", ["envelope"])) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      await load(dir, id);
    }),
  );
}

/** Media whose loudness analysis failed this session ("dir:mediaId"): cuts don't wait for it again. */
const loudnessFailed = new Set<string>();
/** A cut is being prepared (the loudness analysis it waits for): the buttons wait, ⌫ does nothing. */
let cutBusy = false;
const busyListeners = new Set<() => void>();
const setCutBusy = (busy: boolean) => {
  cutBusy = busy;
  for (const l of busyListeners) l();
};
export const useCutBusy = () => useSyncExternalStore((l) => (busyListeners.add(l), () => void busyListeners.delete(l)), () => cutBusy);
/** Runs one cut at a time, marked busy while it waits. */
async function oneCut(run: () => Promise<boolean>) {
  if (cutBusy) return false;
  setCutBusy(true);
  try {
    return await run();
  } finally {
    setCutBusy(false);
  }
}

/** ⌫ in the Transcript panel: cut the selected words. */
export const cutSelectedWords = () => oneCut(cutSelected);
async function cutSelected() {
  if (!getState().snapshot) return false;
  const before = getTranscripts();
  const keys = selectedWords(wordsOfEdit(projectOf(getState().snapshot!), doneTranscripts(before.entries), scopeOf(projectOf(getState().snapshot!), before.source)), before.anchor, before.focus);
  if (!keys.length) return false;
  await withLoudness([...new Set(keys.map((w) => w.media))]);
  const snapshot = getState().snapshot;
  if (!snapshot) return false;
  const project = projectOf(snapshot);
  const { entries, anchor, focus, source } = getTranscripts();
  const transcripts = doneTranscripts(entries);
  const scope = scopeOf(project, source);
  const selected = selectedWords(wordsOfEdit(project, transcripts, scope), anchor, focus);
  if (!selected.length) return false;
  return sendCut(planCutWords(project, transcripts, selected, scope));
}

/** D264 (#77): the selected words as a chip in the composer (the stretch they're heard over, quoted). */
export function addSelectedWordsToChat(): boolean {
  const snapshot = getState().snapshot;
  if (!snapshot) return false;
  const project = projectOf(snapshot);
  const { entries, anchor, focus, source } = getTranscripts();
  const transcripts = doneTranscripts(entries);
  const selected = selectedWords(wordsOfEdit(project, transcripts, scopeOf(project, source)), anchor, focus);
  if (!selected.length) return false;
  const text = selected.map((w) => transcripts.get(w.media)?.words[w.index]?.text ?? "").join(" ");
  actions.addWordsToChat(Math.min(...selected.map((w) => w.start)), Math.max(...selected.map((w) => w.end)), text);
  return true;
}

/** The last mode and look picked for "Make captions" (kept for the session). */
export let captionChoice: { mode: CaptionMode; look: string } = { mode: CAPTION_DEFAULTS.mode, look: CAPTION_DEFAULTS.look };

/**
 * "Make captions" (D82): measured like a cut (the loudness pass, so words sit where they're heard),
 * then core planMakeCaptions for each transcribed media on main, one edit; the new captions are
 * selected so the Inspector shows them.
 */
export const makeCaptions = (mode: CaptionMode, look: string) => oneCut(() => makeAll(mode, look));
async function makeAll(mode: CaptionMode, look: string) {
  captionChoice = { mode, look };
  const first = getState().snapshot;
  if (!first) return false;
  await withLoudness(readMedia(projectOf(first)));
  const snapshot = getState().snapshot;
  if (!snapshot) return false;
  const plan = planCaptions(projectOf(snapshot), doneTranscripts(getTranscripts().entries), { mode, look, captionStyle: defaultCaptionStyle() }, scopeOf(projectOf(snapshot), getTranscripts().source));
  const applied = await actions.timelineEdit(plan);
  if (applied && !("problem" in plan)) playback.select(plan.items[0]);
  return applied;
}

/** Remove pauses / fillers: planned when clicked, on the project as it is then (not the render's). */
export const removeAll = (kind: "pauses" | "fillers") => oneCut(() => removeEvery(kind));
async function removeEvery(kind: "pauses" | "fillers") {
  const first = getState().snapshot;
  if (!first) return false;
  await withLoudness(readMedia(projectOf(first)));
  const snapshot = getState().snapshot;
  if (!snapshot) return false;
  const project = projectOf(snapshot);
  const transcripts = doneTranscripts(getTranscripts().entries);
  const scope = scopeOf(project, getTranscripts().source);
  return sendCut(kind === "pauses" ? planRemovePauses(project, transcripts, pauseMin, scope) : planRemoveFillers(project, transcripts, scope));
}

/** The media the tab reads now (D215: its source's, else the main track's). */
function readMedia(project: ProjectModel): Array<string> {
  const scope = scopeOf(project, getTranscripts().source);
  return scope ? [scope.media] : mediaOnMain(project);
}

export async function load(dir: string, mediaId: string) {
  if (getTranscripts().entries.get(mediaId)?.state !== "done") transcriptStore.setEntry(dir, mediaId, { state: "loading" });
  const result = (await actions.analysisCached(mediaId, "transcript")) as { hasAudio?: boolean; words?: MediaTranscript["words"]; segments?: MediaTranscript["segments"]; language?: string; seconds?: number } | null | undefined;
  let entry: TranscriptEntry;
  if (result === undefined) entry = { state: "error", message: "Couldn't read the transcript." };
  else if (result === null) entry = { state: "none" };
  else if (!result.hasAudio) entry = { state: "silent" };
  else {
    const loud = (await actions.analysisCached(mediaId, "loudness")) as { hasAudio?: boolean; silence?: { ranges?: MediaTranscript["silences"] }; envelope?: unknown } | null | undefined;
    entry = {
      state: "done",
      transcript: {
        words: result.words ?? [],
        segments: result.segments,
        language: result.language,
        seconds: result.seconds,
        silences: loud?.hasAudio ? loud.silence?.ranges : undefined,
        envelope: loud?.hasAudio ? decodeEnvelope(loud.envelope) : undefined,
        measured: !!loud,
      },
    };
  }
  transcriptStore.setEntry(dir, mediaId, entry);
}

/** Loads the transcripts of the media the tab reads (the main track's, or its source's), and again when a transcript job for one finishes. */
export function useTranscriptLoading(project: ProjectModel, dir: string) {
  const { analysisJobs, connection } = useApp();
  const entries = useTranscripts((s) => s.entries);
  const source = useTranscripts((s) => s.source);
  const online = connection === "connected";
  const scope = scopeOf(project, source);
  const media = scope ? [scope.media] : mediaOnMain(project);
  const seenJobs = useRef(new Set<string>());
  // Failed reads are tried again once each time the tab opens (and with Retry).
  const retried = useRef(new Set<string>());
  useEffect(() => transcriptStore.forProject(dir), [dir]);
  useEffect(() => {
    if (!online || getTranscripts().dir !== dir) return;
    for (const id of media) {
      const e = entries.get(id);
      if (!e) void load(dir, id);
      else if (e.state === "error" && !retried.current.has(id)) {
        retried.current.add(id);
        void load(dir, id);
      }
    }
  }, [online, dir, media.join(","), entries]);
  useEffect(() => {
    for (const job of analysisJobs) {
      if (job.projectDir !== dir || job.phase !== "done" || seenJobs.current.has(job.id)) continue;
      seenJobs.current.add(job.id);
      for (const id of new Set([job.mediaId, ...job.mediaIds])) {
        if (!media.includes(id)) continue;
        const state = getTranscripts().entries.get(id)?.state;
        // A new transcript, or (loudness) silences the pauses should follow.
        if (job.analyzer === "transcript" ? state !== "loading" : job.analyzer === "loudness" && state === "done") void load(dir, id);
      }
    }
  }, [analysisJobs, dir, media.join(",")]);
}
