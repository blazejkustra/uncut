import type { EditWord } from "@uncut/core/transcript";
import { Captions, X, Settings } from "lucide-react";
import { useState, useEffect } from "react";
import { type CaptionMode, CAPTION_MODES, CAPTION_MODE_NAMES } from "@uncut/core/captions";
import { TEXT_STYLES } from "@uncut/core/looks";
import { analysisText } from "../../state/analysisText.ts";
import { usePlayback, getPlayback } from "../../preview/playback.ts";
import type { ProjectModel } from "../../state/project.ts";
import { useApp, activeAnalyses, actions } from "../../state/store.ts";
import { wordKey } from "../transcript.ts";
import { captionChoice, makeCaptions } from "./cuts.ts";

/** "Make captions" with its choices: how they show and the look (a small popover under the button). */
export function CaptionsButton({ project, media, disabled }: { project: ProjectModel; media: ReadonlyArray<string>; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<CaptionMode>(captionChoice.mode);
  const [look, setLook] = useState(captionChoice.look);
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

export function Untranscribed({ mediaId, name, online, whisperReady, checking, modelMissing, modelLabel }: { mediaId: string; name: string; online: boolean; whisperReady: boolean; checking: boolean; modelMissing: boolean; modelLabel: string }) {
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
export function PlayheadWord({ words, container }: { words: ReadonlyArray<EditWord>; container: React.RefObject<HTMLDivElement | null> }) {
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
