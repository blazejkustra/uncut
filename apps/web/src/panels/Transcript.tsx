// The Transcript panel (D32, D69): what's said on the main track, clip by clip in edit order (what
// you'd hear), as selectable words. The word under the playhead is highlighted while it plays;
// clicking a word goes there (and selects it); dragging or ⇧-clicking selects more, and ⌫/Delete
// cuts the selection through core planTextCut as one undoable edit. "Remove pauses" (threshold)
// and "Remove fillers" (hesitations only; "maybe" ones are only marked) do the same for the whole
// edit, with the count they'd cut on the button. "Make captions" (D82) makes captions from the
// transcripts that follow the cuts (mode and look picked in a small popover). Media without a transcript can be transcribed
// here (the Library's analysis job, with its progress); a missing whisper.cpp or speech model
// points to Setup.
import { decodeEnvelope, DEFAULT_PAUSE_MIN_S, fillersOf, pausesOf, type EditWord, type Filler, type Pause } from "@uncut/core/transcript";
import { Captions, Scissors, Settings, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CAPTION_DEFAULTS, CAPTION_MODE_NAMES, CAPTION_MODES, type CaptionMode } from "@uncut/core/captions";
import { TEXT_STYLES } from "@uncut/core/looks";

import type { Plan } from "../timeline/edit.ts";
import { frameTimecode, timecode } from "../state/format.ts";
import { analysisText } from "../state/analysisText.ts";
import { getPlayback, playback, usePlayback } from "../preview/playback.ts";
import type { ProjectModel } from "../state/project.ts";
import { actions, activeAnalyses, getState, projectOf, useApp } from "../state/store.ts";
import { BottomTabs } from "../timeline/BottomTabs.tsx";
import {
  doneTranscripts,
  getTranscripts,
  mediaOnMain,
  planCaptions,
  planCutWords,
  planRemoveFillers,
  planRemovePauses,
  selectedWords,
  transcriptStore,
  useTranscripts,
  wordKey,
  wordsOfEdit,
  type MediaTranscript,
  type TranscriptEntry,
} from "./transcript.ts";

/** Pause thresholds on offer (seconds); the default is core's DEFAULT_PAUSE_MIN_S. */
const PAUSE_STEPS = [0.3, 0.5, 0.8, 1, 1.5, 2];
const PAUSE_SHOWN_S = 0.3;
let pauseMin = DEFAULT_PAUSE_MIN_S;

const EMPTY: ReadonlyArray<EditWord> = [];
type Marks = { readonly fillers: ReadonlyMap<number, Filler["kind"]>; readonly pauses: ReadonlyMap<number, Pause> };

// A drag selects words: pressed on one, extended over the ones the pointer enters.
let dragging = false;
function onWordDown(e: React.PointerEvent, w: EditWord) {
  if (e.button !== 0) return;
  e.preventDefault();
  if (e.shiftKey && getTranscripts().anchor !== undefined) return transcriptStore.extend(wordKey(w));
  transcriptStore.select(wordKey(w));
  dragging = true;
  playback.seek(w.start);
}
function onWordEnter(w: EditWord) {
  if (dragging) transcriptStore.extend(wordKey(w));
}

/** One clip's words; re-renders only when its words, marks, threshold or selected span change. */
const ClipWords = memo(function ClipWords({ own, transcript, marks, threshold, selLo, selHi, fps }: { own: ReadonlyArray<EditWord>; transcript: MediaTranscript; marks: Marks | undefined; threshold: number; selLo: number; selHi: number; fps: number }) {
  return (
    <p className="tx-words">
      {own.map((w, i) => {
        const filler = marks?.fillers.get(w.index);
        const pause = marks?.pauses.get(w.index);
        const next = own[i + 1];
        const key = wordKey(w);
        const sel = i >= selLo && i <= selHi && selLo !== -1;
        return (
          <span key={key}>
            <span
              className={`tx-word ${filler ? `filler ${filler}` : ""} ${sel ? "sel" : ""}`}
              data-testid="tx-word"
              data-key={key}
              data-clip={w.clip}
              data-index={w.index}
              data-start={w.start}
              data-end={w.end}
              data-filler={filler}
              title={filler === "hesitation" ? "A hesitation: Remove fillers cuts it" : filler === "maybe" ? "Maybe a filler: cut it by hand if it adds nothing" : frameTimecode(w.start, fps)}
              onPointerDown={(e) => onWordDown(e, w)}
              onPointerEnter={() => onWordEnter(w)}
            >
              {(transcript.words[w.index]?.text ?? "").trim()}
            </span>
            {pause && next && next.index === w.index + 1 ? (
              <span className={`tx-pause ${pause.end - pause.start >= threshold ? "long" : ""}`} data-testid="tx-pause" data-seconds={(pause.end - pause.start).toFixed(2)} title={`A ${(pause.end - pause.start).toFixed(1)} s pause`}>
                {(pause.end - pause.start).toFixed(1)}s
              </span>
            ) : (
              " "
            )}
          </span>
        );
      })}
    </p>
  );
});

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
const useCutBusy = () => useSyncExternalStore((l) => (busyListeners.add(l), () => void busyListeners.delete(l)), () => cutBusy);
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
  const keys = selectedWords(wordsOfEdit(projectOf(getState().snapshot!), doneTranscripts(before.entries)), before.anchor, before.focus);
  if (!keys.length) return false;
  await withLoudness([...new Set(keys.map((w) => w.media))]);
  const snapshot = getState().snapshot;
  if (!snapshot) return false;
  const project = projectOf(snapshot);
  const { entries, anchor, focus } = getTranscripts();
  const transcripts = doneTranscripts(entries);
  const selected = selectedWords(wordsOfEdit(project, transcripts), anchor, focus);
  if (!selected.length) return false;
  return sendCut(planCutWords(project, transcripts, selected));
}

/** The last mode and look picked for "Make captions" (kept for the session). */
let captionChoice: { mode: CaptionMode; look: string } = { mode: CAPTION_DEFAULTS.mode, look: CAPTION_DEFAULTS.look };

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
  await withLoudness(mediaOnMain(projectOf(first)));
  const snapshot = getState().snapshot;
  if (!snapshot) return false;
  const plan = planCaptions(projectOf(snapshot), doneTranscripts(getTranscripts().entries), { mode, look });
  const applied = await actions.timelineEdit(plan);
  if (applied && !("problem" in plan)) playback.select(plan.items[0]);
  return applied;
}

/** Remove pauses / fillers: planned when clicked, on the project as it is then (not the render's). */
export const removeAll = (kind: "pauses" | "fillers") => oneCut(() => removeEvery(kind));
async function removeEvery(kind: "pauses" | "fillers") {
  const first = getState().snapshot;
  if (!first) return false;
  await withLoudness(mediaOnMain(projectOf(first)));
  const snapshot = getState().snapshot;
  if (!snapshot) return false;
  const project = projectOf(snapshot);
  const transcripts = doneTranscripts(getTranscripts().entries);
  return sendCut(kind === "pauses" ? planRemovePauses(project, transcripts, pauseMin) : planRemoveFillers(project, transcripts));
}

async function load(dir: string, mediaId: string) {
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

/** Loads the transcripts of the media on the main track, and again when a transcript job for one finishes. */
function useTranscriptLoading(project: ProjectModel, dir: string) {
  const { analysisJobs, connection } = useApp();
  const entries = useTranscripts((s) => s.entries);
  const online = connection === "connected";
  const media = mediaOnMain(project);
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

export function TranscriptPanel({ project, dir }: { project: ProjectModel; dir: string }) {
  const { connection, setupChecks, transcription, analysisError } = useApp();
  const online = connection === "connected";
  useTranscriptLoading(project, dir);
  useEffect(() => {
    if (!getState().setupChecks) void actions.checkSetup();
  }, []);
  const entries = useTranscripts((s) => s.entries);
  const anchor = useTranscripts((s) => s.anchor);
  const focus = useTranscripts((s) => s.focus);
  const transcripts = useMemo(() => doneTranscripts(entries), [entries]);
  const words = useMemo(() => wordsOfEdit(project, transcripts), [project, transcripts]);
  const selected = selectedWords(words, anchor, focus);
  const byClip = useMemo(() => {
    const out = new Map<string, Array<EditWord>>();
    for (const w of words) (out.get(w.clip) ?? out.set(w.clip, []).get(w.clip)!).push(w);
    return out;
  }, [words]);
  // The selection per clip as a span of positions in its word list, so rows compare primitives.
  const selIn = (clip: string) => {
    const list = byClip.get(clip);
    if (!list || !selected.length) return [-1, -1] as const;
    const keys = new Set(selected.map(wordKey));
    let lo = -1;
    let hi = -1;
    list.forEach((w, i) => {
      if (keys.has(wordKey(w))) {
        if (lo === -1) lo = i;
        hi = i;
      }
    });
    return [lo, hi] as const;
  };
  const [threshold, setThreshold] = useThreshold();
  const pausePlan = useMemo(() => planRemovePauses(project, transcripts, threshold), [project, transcripts, threshold]);
  const fillerPlan = useMemo(() => planRemoveFillers(project, transcripts), [project, transcripts]);
  const fps = project.canvas.fps;
  const media = mediaOnMain(project);
  const whisperReady = setupChecks?.find((c) => c.id === "whisper")?.status === "ready";
  const model = transcription?.models.find((m) => m.id === transcription.selected);

  // Fillers and pauses per media (index → kind / the pause after it), derived like transcript_read's.
  const marks = useMemo(() => {
    const out = new Map<string, { fillers: Map<number, Filler["kind"]>; pauses: Map<number, Pause> }>();
    for (const [id, t] of transcripts) {
      const fillers = new Map<number, Filler["kind"]>();
      for (const f of fillersOf(t.words, t.language)) for (let k = 0; k < f.n; k++) fillers.set(f.i + k, f.kind);
      const pauses = new Map<number, Pause>();
      for (const p of pausesOf(t.words, t.seconds, t.silences, PAUSE_SHOWN_S, t.segments, t.envelope)) if (!p.edge) pauses.set(p.after, p);
      out.set(id, { fillers, pauses });
    }
    return out;
  }, [transcripts]);

  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const up = () => void (dragging = false);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  const main = project.tracks.find((t) => t.role === "main");
  let t = 0;
  const shownUntranscribed = new Set<string>();
  const blocks = (main?.items ?? []).map((item) => {
    const start = t;
    t += item.duration;
    const m = item.type === "clip" && item.media ? project.media.find((x) => x.id === item.media) : undefined;
    if (!m || !media.includes(m.id)) return null;
    const entry = entries.get(m.id);
    const head = (
      <div className="tx-head">
        <span className="ellipsis">{item.name ?? m.name}</span>
        <span className="mono">{timecode(start, fps)}</span>
      </div>
    );
    if (entry?.state === "done") {
      const own = byClip.get(item.id) ?? EMPTY;
      const [lo, hi] = selIn(item.id);
      return (
        <div key={item.id} className="tx-block" data-testid="tx-block" data-clip={item.id} data-media={m.id}>
          {head}
          {own.length ? <ClipWords own={own} transcript={entry.transcript} marks={marks.get(m.id)} threshold={threshold} selLo={lo} selHi={hi} fps={fps} /> : <div className="tx-note muted">No speech in this part.</div>}
        </div>
      );
    }
    const first = !shownUntranscribed.has(m.id);
    shownUntranscribed.add(m.id);
    return (
      <div key={item.id} className="tx-block" data-testid="tx-block" data-clip={item.id} data-media={m.id}>
        {head}
        {entry?.state === "silent" ? (
          <div className="tx-note muted">No sound to transcribe.</div>
        ) : !entry || entry.state === "loading" ? (
          <div className="tx-note muted">Loading…</div>
        ) : entry.state === "error" ? (
          <div className="tx-note muted">
            {entry.message}{" "}
            <button className="link-btn" data-testid="tx-retry" onClick={() => void load(dir, m.id)}>
              Retry
            </button>
          </div>
        ) : first ? (
          <Untranscribed mediaId={m.id} name={m.name} online={online} whisperReady={whisperReady} checking={!setupChecks} modelMissing={model ? !model.installed : false} modelLabel={model ? `${model.name}, ${Math.round(model.bytes / 1e6)} MB` : ""} />
        ) : (
          <div className="tx-note muted">Not transcribed yet (see above).</div>
        )}
      </div>
    );
  });

  const pauseCount = "problem" in pausePlan ? 0 : pausePlan.pauses;
  const fillerCount = "problem" in fillerPlan ? 0 : fillerPlan.fillers;
  const secs = (p: typeof pausePlan) => ("problem" in p ? "" : `${(p.framesRemoved / fps).toFixed(1)} s`);
  const anyDone = transcripts.size > 0;
  const locked = main?.locked === true;
  const busy = useCutBusy();
  return (
    <section className="bottom" data-testid="transcript-panel">
      <div className="bottom-toolbar">
        <BottomTabs />
        <span className="muted small" data-testid="tx-status">
          {locked ? "The main track is locked: unlock it to cut by text." : busy ? "Measuring the sound before cutting…" : selected.length ? `${selected.length} word${selected.length === 1 ? "" : "s"} selected. ⌫ cuts ${selected.length === 1 ? "it" : "them"}` : anyDone ? "Click a word to go there; drag or ⇧-click to select" : ""}
        </span>
        <div className="toolbar-spacer" />
        {selected.length > 0 && (
          <button className="btn ghost" data-testid="tx-cut" disabled={!online || busy} title="Cut the selected words (⌫)" onClick={() => void cutSelectedWords()}>
            <Scissors />
            Cut
          </button>
        )}
        <button
          className="btn"
          data-testid="remove-fillers"
          data-count={fillerCount}
          disabled={!online || busy || !fillerCount}
          title={locked ? "The main track is locked" : fillerCount ? `Cut ${fillerCount} hesitation${fillerCount === 1 ? "" : "s"} (um, uh, yyy), ${secs(fillerPlan)}. Words marked "maybe" stay.` : "No hesitations (um, uh, yyy) in the edit"}
          onClick={() => void removeAll("fillers")}
        >
          Remove fillers{fillerCount ? <span className="tx-count">{fillerCount}</span> : null}
        </button>
        <div className="toolbar-sep" />
        <select className="tx-select" data-testid="pause-threshold" value={threshold} title="Pauses at least this long" onChange={(e) => setThreshold(Number(e.target.value))}>
          {PAUSE_STEPS.map((s) => (
            <option key={s} value={s}>
              ≥ {s} s
            </option>
          ))}
        </select>
        <button
          className="btn"
          data-testid="remove-pauses"
          data-count={pauseCount}
          disabled={!online || busy || !pauseCount}
          title={locked ? "The main track is locked" : pauseCount ? `Cut ${pauseCount} pause${pauseCount === 1 ? "" : "s"} of at least ${threshold} s (${secs(pausePlan)}), keeping a little quiet next to the words` : `No pauses of ${threshold} s or more in the edit`}
          onClick={() => void removeAll("pauses")}
        >
          Remove pauses{pauseCount ? <span className="tx-count">{pauseCount}</span> : null}
        </button>
        <div className="toolbar-sep" />
        <CaptionsButton project={project} disabled={!online || busy || !anyDone} />
      </div>
      <div
        className="bottom-body tx-body"
        ref={bodyRef}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) transcriptStore.clear();
        }}
      >
        {analysisError && (
          <div className="inline-error small tx-error" data-testid="tx-error">
            {analysisError}
            <button className="link-btn" onClick={actions.dismissAnalysisError}>
              Dismiss
            </button>
          </div>
        )}
        {media.length === 0 ? (
          <div className="empty" data-testid="tx-empty">
            <div className="empty-icon">
              <Captions />
            </div>
            <div className="empty-title">Nothing to read yet</div>
            <div className="empty-sub">Put a clip with speech on the main track to see what's said here, and cut it by deleting words.</div>
          </div>
        ) : (
          <div className="tx-doc">{blocks}</div>
        )}
        <PlayheadWord words={words} container={bodyRef} />
      </div>
    </section>
  );
}

/** "Make captions" with its choices: how they show and the look (a small popover under the button). */
function CaptionsButton({ project, disabled }: { project: ProjectModel; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<CaptionMode>(captionChoice.mode);
  const [look, setLook] = useState(captionChoice.look);
  const media = mediaOnMain(project);
  const existing = project.tracks.some((t) => t.items.some((i) => i.type === "captions" && media.includes(i.source ?? "")));
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  return (
    <div className="tx-captions">
      <button className={`btn ${open ? "active" : ""}`} data-testid="make-captions" disabled={disabled} title={disabled ? "Transcribe the speech first: captions are made from the transcript" : "Captions from the transcript: they follow your cuts"} onClick={() => setOpen(!open)}>
        <Captions />
        {existing ? "Captions" : "Make captions"}
      </button>
      {open && !disabled && (
        <div className="tx-popover" data-testid="captions-menu">
          <div className="small muted">Show</div>
          <div className="seg" role="group">
            {CAPTION_MODES.map((m) => (
              <button key={m} className={mode === m ? "active" : ""} data-testid={`captions-mode-${m}`} onClick={() => setMode(m)}>
                {CAPTION_MODE_NAMES[m]}
              </button>
            ))}
          </div>
          <div className="small muted">Look</div>
          <select className="field input" data-testid="captions-look" value={look} onChange={(e) => setLook(e.target.value)}>
            {Object.values(TEXT_STYLES).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button
            className="btn primary"
            data-testid="captions-make"
            onClick={() => {
              setOpen(false);
              void makeCaptions(mode, look);
            }}
          >
            {existing ? "Remake captions" : "Make captions"}
          </button>
          {existing && <div className="small muted">Remaking keeps your fixes when the transcript is the same.</div>}
        </div>
      )}
    </div>
  );
}

// The pause threshold is kept for the session (module state), so switching tabs doesn't reset it.
const thresholdListeners = new Set<() => void>();
const subscribeThreshold = (l: () => void) => (thresholdListeners.add(l), () => void thresholdListeners.delete(l));
function useThreshold(): [number, (v: number) => void] {
  const value = useSyncExternalStore(subscribeThreshold, () => pauseMin);
  return [value, (v: number) => ((pauseMin = v), thresholdListeners.forEach((l) => l()))];
}

function Untranscribed({ mediaId, name, online, whisperReady, checking, modelMissing, modelLabel }: { mediaId: string; name: string; online: boolean; whisperReady: boolean; checking: boolean; modelMissing: boolean; modelLabel: string }) {
  const app = useApp();
  const job = activeAnalyses(app, mediaId).find((j) => j.analyzer === "transcript");
  if (job) {
    return (
      <div className="tx-state" data-testid="tx-progress" data-phase={job.phase}>
        <span className="muted">{analysisText(job)}</span>
        <div className="tx-bar">
          <span style={{ width: `${Math.round((job.phase === "running" ? job.progress : 0) * 100)}%` }} />
        </div>
        <button className="icon-btn" data-testid="tx-cancel" title="Stop transcribing" disabled={!online} onClick={() => void actions.cancelAnalysis(job.id)}>
          <X />
        </button>
      </div>
    );
  }
  if (!checking && !whisperReady) {
    return (
      <div className="tx-state" data-testid="tx-no-whisper">
        <span className="muted">{name} isn't transcribed. Transcribing needs whisper.cpp, which isn't installed.</span>
        <button className="btn" onClick={actions.openSetup}>
          <Settings />
          Set up
        </button>
      </div>
    );
  }
  return (
    <div className="tx-state" data-testid="tx-untranscribed">
      <span className="muted">
        {name} isn't transcribed yet.{modelMissing ? ` The first transcript downloads the speech model (${modelLabel}).` : ""} It runs on this Mac.
      </span>
      <button className="btn" data-testid="tx-transcribe" disabled={!online || checking} onClick={() => void actions.transcribe(mediaId)}>
        <Captions />
        Transcribe
      </button>
      {modelMissing && (
        <button className="link-btn" data-testid="tx-setup" onClick={actions.openSetup}>
          Choose the model in Setup
        </button>
      )}
    </div>
  );
}

/**
 * Marks the word under the playhead (a DOM attribute, so a playing video doesn't re-render every
 * word 60 times a second) and keeps it in view while playing.
 */
function PlayheadWord({ words, container }: { words: ReadonlyArray<EditWord>; container: React.RefObject<HTMLDivElement | null> }) {
  // The current word's key: re-renders this component only when it changes, not every frame.
  const key = usePlayback((s) => {
    const frame = Math.floor(s.frame);
    // Words are in edit order with increasing starts: the last one starting at or before the frame.
    let lo = 0;
    let hi = words.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid]!.start <= frame) (at = mid), (lo = mid + 1);
      else hi = mid - 1;
    }
    return at >= 0 && frame < words[at]!.end ? wordKey(words[at]!) : undefined;
  });
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    root.querySelector("[data-current]")?.removeAttribute("data-current");
    if (!key) return;
    const el = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (!el) return;
    el.dataset.current = "true";
    if (!getPlayback().playing) return;
    const box = root.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) el.scrollIntoView({ block: "nearest" });
  }, [key, words, container]);
  return null;
}
