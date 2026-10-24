import type { EditWord } from "@uncut/core/transcript";
import { Captions, ChevronDown, X, Settings } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Popover } from "../../inspector/controls.tsx";
import { type CaptionMode, CAPTION_MODES, CAPTION_MODE_NAMES } from "@uncut/core/captions";
import { TEXT_STYLES } from "@uncut/core/looks";
import { analysisText } from "../../state/analysisText.ts";
import { usePlayback, getPlayback } from "../../preview/playback.ts";
import type { ProjectModel } from "../../state/project.ts";
import { useApp, activeAnalyses, actions } from "../../state/store.ts";
import { wordKey } from "../transcript.ts";
import { captionChoice, makeCaptions } from "./cuts.ts";
import { Tooltip } from "../../ui/Tooltip.tsx";

/**
 * The Captions row (#59): what's there and one button; the choices (how they show, the look) open in
 * the shared Popover, which is drawn over everything and kept inside the window, so a narrow panel
 * can't clip it.
 */
export function CaptionsButton({
  project,
  media,
  disabled,
  transcribed,
}: {
  project: ProjectModel;
  media: ReadonlyArray<string>;
  disabled: boolean;
  transcribed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<CaptionMode>(captionChoice.mode);
  const [look, setLook] = useState(captionChoice.look);
  const anchor = useRef<HTMLButtonElement>(null);
  const existing = project.tracks.some((t) => t.items.some((i) => i.type === "captions" && media.includes(i.source ?? "")));
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="tx-tool tx-captions">
      <div className="tx-tool-text">
        <div className="tx-tool-title">Captions</div>
        <div className="tx-tool-meta">{!transcribed ? "Transcribe first" : existing ? "On the timeline" : "From the transcript"}</div>
      </div>
      <button
        ref={anchor}
        className={`btn ${open ? "active" : ""}`}
        data-testid="make-captions"
        aria-label={existing ? "Captions" : "Make captions"}
        aria-expanded={open && !disabled}
        disabled={disabled}
        title={disabled ? "Transcribe the speech first: captions are made from the transcript" : "Captions from the transcript: they follow your cuts"}
        onClick={() => setOpen(!open)}
      >
        {existing ? "Remake" : "Make"}
        <ChevronDown />
      </button>
      {open && !disabled && (
        <Popover anchor={anchor.current} onClose={close} testId="captions-menu" width={248}>
          <div className="tx-pop-label">Show</div>
          <div className="tx-modes" role="radiogroup">
            {CAPTION_MODES.map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? "active" : ""}
                data-testid={`captions-mode-${m}`}
                onClick={() => setMode(m)}
              >
                {CAPTION_MODE_NAMES[m]}
              </button>
            ))}
          </div>
          <div className="tx-pop-label">Look</div>
          <select className="field input" data-testid="captions-look" value={look} onChange={(e) => setLook(e.target.value)}>
            {Object.values(TEXT_STYLES).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button
            className="btn primary tx-pop-go"
            data-testid="captions-make"
            onClick={() => {
              setOpen(false);
              void makeCaptions(mode, look);
            }}
          >
            <Captions />
            {existing ? "Remake captions" : "Make captions"}
          </button>
          {existing && <div className="small muted">Remaking keeps your fixes when the transcript is the same.</div>}
        </Popover>
      )}
    </div>
  );
}

export function Untranscribed({
  mediaId,
  name,
  online,
  whisperReady,
  checking,
  modelMissing,
  modelLabel,
}: {
  mediaId: string;
  name: string;
  online: boolean;
  whisperReady: boolean;
  checking: boolean;
  modelMissing: boolean;
  modelLabel: string;
}) {
  const app = useApp();
  const job = activeAnalyses(app, mediaId).find((j) => j.analyzer === "transcript");
  if (job) {
    const pct = Math.round((job.phase === "running" ? job.progress : 0) * 100);
    return (
      <div className="tx-state busy" data-testid="tx-progress" data-phase={job.phase}>
        <div className="tx-state-row">
          <span className="tx-state-text">{analysisText(job)}</span>
          <Tooltip label="Stop transcribing">
            <button
              className="icon-btn"
              data-testid="tx-cancel"
              aria-label="Stop transcribing"
              disabled={!online}
              onClick={() => void actions.cancelAnalysis(job.id)}
            >
              <X />
            </button>
          </Tooltip>
        </div>
        <div className="tx-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  if (!checking && !whisperReady) {
    return (
      <div className="tx-state" data-testid="tx-no-whisper">
        <span className="tx-state-text">
          <strong>{name}</strong> isn't transcribed. Transcribing needs whisper.cpp, which isn't installed.
        </span>
        <button className="btn" onClick={actions.openSetup}>
          <Settings />
          Set up
        </button>
      </div>
    );
  }
  return (
    <div className="tx-state" data-testid="tx-untranscribed">
      <span className="tx-state-text">
        <strong>{name}</strong> isn't transcribed yet.{modelMissing ? ` The first transcript downloads the speech model (${modelLabel}).` : ""} It runs on this
        Mac.
      </span>
      <div className="tx-state-row">
        <button className="btn primary" data-testid="tx-transcribe" disabled={!online || checking} onClick={() => void actions.transcribe(mediaId)}>
          <Captions />
          Transcribe
        </button>
        {modelMissing && (
          <button className="link-btn" data-testid="tx-setup" onClick={actions.openSetup}>
            Choose the model in Setup
          </button>
        )}
      </div>
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
      if (words[mid]!.start <= frame) ((at = mid), (lo = mid + 1));
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
