// The Transcript panel (D32, D69; a left rail tab since U11, D177): what's said on the main track, clip by clip in edit order (what
// you'd hear), or (D215) on an item off it (a source picker lists them, a take read from its
// microphone; selecting one on the timeline reads it), as selectable words. The word under the playhead is highlighted while it plays;
// clicking a word goes there (and selects it); dragging or ⇧-clicking selects more, and ⌫/Delete
// cuts the selection through core planTextCut as one undoable edit (a bar shows the selection, with
// Cut and clear). The tools (#59, D231) are rows in one card: Fillers (hesitations only; "maybe" ones
// are only marked) and "Pauses over [x s]" do the same for the whole edit, each row saying what it
// would cut; Captions (D82) makes captions from the transcripts that follow the cuts (mode and look
// picked in the shared, window-clamped Popover). Media without a transcript can be transcribed
// here (the Library's analysis job, with its progress); a missing whisper.cpp or speech model
// points to Setup.
import { fillersOf, pausesOf, type EditWord, type Filler, type Pause } from "@uncut/core/transcript";
import { AtSign, Captions, Scissors, X } from "lucide-react";
import { Tooltip } from "../ui/Tooltip.tsx";
import { memo, useEffect, useMemo, useRef } from "react";

import { frameTimecode, timecode } from "../state/format.ts";
import { playback, usePlayback } from "../preview/playback.ts";
import { layoutOf, type ProjectModel } from "../state/project.ts";
import { actions, getState, useApp } from "../state/store.ts";
import { doneTranscripts, getTranscripts, mainSpeechMedia, mediaOnMain, scopeKey, scopeOf, sourceChoices, planRemoveFillers, planRemovePauses, selectedWords, transcriptStore, useTranscripts, wordKey, wordsOfEdit, type MediaTranscript } from "./transcript.ts";
import { useTranscriptLoading, load, useCutBusy, cutSelectedWords, removeAll, addSelectedWordsToChat } from "./transcriptView/cuts.ts";
import { useThreshold, PAUSE_SHOWN_S, PAUSE_STEPS } from "./transcriptView/threshold.ts";
import { Untranscribed, CaptionsButton, PlayheadWord } from "./transcriptView/parts.tsx";
export { cutSelectedWords, makeCaptions, removeAll } from "./transcriptView/cuts.ts";

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
  // The timeline shows next to the transcript (U11): one selection at a time, so ⌫ means one thing.
  const timelineSelected = usePlayback((s) => s.selected);
  useEffect(() => {
    if (anchor !== undefined) playback.select(undefined);
  }, [anchor]);
  useEffect(() => {
    if (timelineSelected !== undefined) transcriptStore.clear();
  }, [timelineSelected]);
  const transcripts = useMemo(() => doneTranscripts(entries), [entries]);
  // D215: the main track, or an item off it (the picker, or the item selected on the timeline).
  const source = useTranscripts((s) => s.source);
  const scope = useMemo(() => scopeOf(project, source), [project, source]);
  const choices = useMemo(() => sourceChoices(project), [project]);
  useEffect(() => {
    if (timelineSelected === undefined) return;
    const item = project.tracks.flatMap((t) => t.items).find((i) => i.id === timelineSelected);
    if (!item || item.type === "text" || item.type === "captions") return;
    const own = scopeOf(project, item.id);
    const onMain = project.tracks.some((t) => t.role === "main" && t.items.some((i) => i.id === item.id || i.id === item.linkedTo));
    if (own) transcriptStore.setSource(item.id);
    else if (onMain) transcriptStore.setSource(undefined);
  }, [timelineSelected]);
  const words = useMemo(() => wordsOfEdit(project, transcripts, scope), [project, transcripts, scope]);
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
  const pausePlan = useMemo(() => planRemovePauses(project, transcripts, threshold, scope), [project, transcripts, threshold, scope]);
  const fillerPlan = useMemo(() => planRemoveFillers(project, transcripts, scope), [project, transcripts, scope]);
  const fps = project.canvas.fps;
  const media = scope ? [scope.media] : mediaOnMain(project);
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
  const shownUntranscribed = new Set<string>();
  // The blocks: each main clip in edit order, or (D215) each item of the source in timeline order.
  const { starts } = layoutOf(project);
  const rows = scope
    ? scope.items.flatMap((id) => {
        const at = project.tracks.flatMap((tr) => tr.items.map((i) => ({ i, tr }))).find((x) => x.i.id === id);
        return at ? [{ item: at.i, start: starts.get(id) ?? 0, mediaId: scope.media as string | undefined, where: at.tr.name as string | undefined }] : [];
      })
    : (main?.items ?? []).map((item) => ({ item, start: starts.get(item.id) ?? 0, mediaId: item.type === "clip" && item.media ? mainSpeechMedia(project, item) : undefined, where: undefined as string | undefined }));
  const blocks = rows.map(({ item, start, mediaId, where }) => {
    const m = mediaId ? project.media.find((x) => x.id === mediaId) : undefined;
    if (!m || !media.includes(m.id)) return null;
    const entry = entries.get(m.id);
    const head = (
      <div className="tx-head">
        <span className="ellipsis">
          {item.name ?? m.name}
          {where ? <span className="muted">, {where}</span> : null}
        </span>
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
  const secs = (p: typeof pausePlan) => ("problem" in p ? "" : `${(p.framesRemoved / fps).toFixed(1)}\u00a0s`);
  const anyDone = transcripts.size > 0;
  const locked = !scope && main?.locked === true;
  const busy = useCutBusy();
  const status = locked ? "The main track is locked: unlock it to cut by text." : busy ? "Measuring the sound before cutting…" : selected.length ? `${selected.length} word${selected.length === 1 ? "" : "s"} selected` : "";
  return (
    <aside className="library tx-panel" data-testid="transcript-panel">
      <div className="lib-head">Transcript</div>
      {(choices.length > 0 || scope) && (
        <div className="tx-source">
          <select
            className="tx-select"
            data-testid="tx-source"
            title="What to read"
            value={scope ? (choices.find((c) => scopeKey(c.scope) === scopeKey(scope))?.id ?? "main") : "main"}
            onChange={(e) => transcriptStore.setSource(e.target.value === "main" ? undefined : e.target.value)}
          >
            <option value="main">Main track</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {media.length > 0 && (
        <div className="tx-tools" data-testid="tx-tools">
          <div className="tx-tool">
            <div className="tx-tool-text">
              <div className="tx-tool-title">Fillers</div>
              <div className="tx-tool-meta">{!anyDone ? "um, uh, yyy" : fillerCount ? `${fillerCount} found, ${secs(fillerPlan)}` : "None in the edit"}</div>
            </div>
            <button
              className="btn"
              data-testid="remove-fillers"
              data-count={fillerCount}
              aria-label="Remove fillers"
              disabled={!online || busy || !fillerCount}
              title={locked ? "The main track is locked" : fillerCount ? `Cut ${fillerCount} hesitation${fillerCount === 1 ? "" : "s"} (um, uh, yyy), ${secs(fillerPlan)}. Words marked "maybe" stay.` : "No hesitations (um, uh, yyy) in the edit"}
              onClick={() => void removeAll("fillers")}
            >
              Remove
            </button>
          </div>
          <div className="tx-tool">
            <div className="tx-tool-text">
              <label className="tx-tool-title tx-pause-label">
                Pauses over
                <select className="tx-select tx-threshold" data-testid="pause-threshold" value={threshold} aria-label="Shortest pause to remove" onChange={(e) => setThreshold(Number(e.target.value))}>
                  {PAUSE_STEPS.map((s) => (
                    <option key={s} value={s}>
                      {s} s
                    </option>
                  ))}
                </select>
              </label>
              <div className="tx-tool-meta">{!anyDone ? "Gaps between words" : pauseCount ? `${pauseCount} found, ${secs(pausePlan)}` : "None in the edit"}</div>
            </div>
            <button
              className="btn"
              data-testid="remove-pauses"
              data-count={pauseCount}
              aria-label="Remove pauses"
              disabled={!online || busy || !pauseCount}
              title={locked ? "The main track is locked" : pauseCount ? `Cut ${pauseCount} pause${pauseCount === 1 ? "" : "s"} of at least ${threshold} s (${secs(pausePlan)}), keeping a little quiet next to the words` : `No pauses of ${threshold} s or more in the edit`}
              onClick={() => void removeAll("pauses")}
            >
              Remove
            </button>
          </div>
          <CaptionsButton project={project} media={media} disabled={!online || busy || !anyDone} transcribed={anyDone} />
        </div>
      )}
      <div className={`tx-selbar ${status ? "on" : ""} ${selected.length && !locked && !busy ? "sel" : ""}`}>
        <span className="tx-status" data-testid="tx-status">
          {status}
        </span>
        {selected.length > 0 && (
          <>
            <button className="btn ghost" data-testid="tx-cut" disabled={!online || busy} title="Cut the selected words (⌫)" onClick={() => void cutSelectedWords()}>
              <Scissors />
              Cut
            </button>
            {/* D264 (#77): the words as a chip in the Agent tab's composer. */}
            <Tooltip label="Add these words to chat" shortcut="addToChat">
              <button className="icon-btn" data-testid="tx-add-to-chat" onClick={() => addSelectedWordsToChat()}>
                <AtSign />
              </button>
            </Tooltip>
            <Tooltip label="Clear the selection" keys={["Esc"]}>
              <button className="icon-btn" data-testid="tx-clear" aria-label="Clear the selection" onClick={() => transcriptStore.clear()}>
                <X />
              </button>
            </Tooltip>
          </>
        )}
      </div>
      <div
        className="tx-body"
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
            <div className="empty-sub">{scope ? "No speech here." : "Put a clip with speech on the main track: its words show here, and cutting a word cuts the video."}</div>
          </div>
        ) : (
          <div className="tx-doc">{blocks}</div>
        )}
        <PlayheadWord words={words} container={bodyRef} />
      </div>
    </aside>
  );
}
