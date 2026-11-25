// The offline voiceover's Clone a voice (Reverb): a clip from Media or a file on this Mac, where
// the speech starts and how long, a name, and the user's confirmation that they may use the voice.
// Whisper writes what the clip says unless it's typed here. Progress and Cancel stay in the form;
// the new voice is picked once it's ready. A cloned voice that's picked can be removed here.
import { Check, FileAudio, LoaderCircle, Mic, Trash2, X } from "lucide-react";
import React, { useEffect, useState } from "react";

import { bridge } from "../../state/bridge.ts";
import { actions, useApp, type Project } from "../../state/store.ts";

const CONSENT = "I have the right to use this voice";
const FILE = "file";

const clipsOf = (project: Project | undefined) => (project?.media ?? []).filter((m) => m.kind === "audio" || m.kind === "video");

/** A number from a field, clamped; the fallback when it isn't one. */
const numberOf = (text: string, min: number, max: number, fallback: number) => {
  const n = Number(text);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const DEFAULT_VOICE = "en_male_narrator_1";

export function VoiceClone({ selected, onPick }: { selected: string | undefined; onPick: (voiceId: string) => void }) {
  const app = useApp();
  const online = app.connection === "connected";
  const clips = clipsOf(app.snapshot?.project as Project | undefined);
  const job = app.voices?.clone;
  const running = job?.phase === "running";
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
  const [file, setFile] = useState<string | undefined>();
  const [start, setStart] = useState("0");
  const [seconds, setSeconds] = useState("10");
  const [name, setName] = useState("");
  const [transcript, setTranscript] = useState("");
  const [consent, setConsent] = useState(false);
  const [startedId, setStartedId] = useState<string | undefined>();

  const picked = source || clips[0]?.id || "";
  const fromFile = picked === FILE;
  const ready = online && !running && consent && name.trim().length > 0 && (fromFile ? !!file : !!picked);

  useEffect(() => {
    if (!job || job.id !== startedId || job.phase !== "done" || !job.voice) return;
    onPick(job.voice.id);
    setOpen(false);
    setName("");
    setTranscript("");
    setConsent(false);
  }, [job?.id, job?.phase, startedId]);

  const chooseFile = async () => {
    const [path] = await bridge.chooseMedia();
    if (path) setFile(path);
  };
  const clone = async () => {
    if (!ready) return;
    const jobId = await actions.cloneVoice({
      ...(fromFile ? { path: file! } : { media: picked }),
      start: numberOf(start, 0, 1e6, 0),
      seconds: numberOf(seconds, 3, 15, 10),
      name: name.trim(),
      ...(transcript.trim() ? { transcript: transcript.trim() } : {}),
      consent,
    });
    if (jobId) setStartedId(jobId);
  };

  const done = job?.phase === "done" && job.id === startedId && job.voice;
  const mine = app.voices?.voices.find((v) => v.id === selected && !v.preset);
  const remove = async () => {
    if (!mine) return;
    await actions.removeVoice(mine.id);
    onPick(DEFAULT_VOICE);
  };
  if (!open && !running)
    return (
      <div className="gen-clone-closed">
        <button className="link-btn" data-testid="voice-clone-open" disabled={!online} onClick={() => setOpen(true)}>
          <Mic />
          Clone a voice
        </button>
        {mine && (
          <button className="link-btn" data-testid="voice-remove" disabled={!online} title={`Remove ${mine.name} from this Mac`} onClick={() => void remove()}>
            <Trash2 />
            Remove this voice
          </button>
        )}
        {done && (
          <span className="gen-clone-done small" data-testid="voice-cloned">
            <Check />
            {job.voice!.name} is ready
          </span>
        )}
      </div>
    );
  return (
    <div className="gen-clone" data-testid="voice-clone">
      <div className="gen-clone-head">
        <span>Clone a voice</span>
        {!running && (
          <button className="icon-btn" title="Close" data-testid="voice-clone-close" onClick={() => setOpen(false)}>
            <X />
          </button>
        )}
      </div>
      <div className="gen-opt">
        <span className="k">Clip</span>
        <select
          className="field input gen-select"
          data-testid="voice-clone-source"
          aria-label="Clip"
          value={picked}
          disabled={running}
          onChange={(e) => setSource(e.target.value)}
        >
          {clips.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          <option value={FILE}>A file on this Mac</option>
        </select>
      </div>
      {fromFile && (
        <div className="gen-opt">
          <span className="k" />
          <button className="link-btn gen-clone-file" data-testid="voice-clone-file" disabled={running} onClick={() => void chooseFile()}>
            <FileAudio />
            {file ? file.split("/").pop() : "Choose a file"}
          </button>
        </div>
      )}
      <div className="gen-opt">
        <span className="k">From</span>
        <input
          className="field input gen-num"
          data-testid="voice-clone-start"
          aria-label="Start, in seconds"
          inputMode="decimal"
          value={start}
          disabled={running}
          onChange={(e) => setStart(e.target.value)}
        />
        <span className="small muted">s, for</span>
        <input
          className="field input gen-num"
          data-testid="voice-clone-seconds"
          aria-label="Length, in seconds"
          title="3 to 15 seconds of one person speaking"
          inputMode="decimal"
          value={seconds}
          disabled={running}
          onChange={(e) => setSeconds(e.target.value)}
        />
        <span className="small muted">s</span>
      </div>
      <div className="gen-opt">
        <span className="k">Name</span>
        <input
          className="field input gen-text"
          data-testid="voice-clone-name"
          placeholder="My voice"
          maxLength={60}
          value={name}
          disabled={running}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="gen-opt">
        <span className="k">It says</span>
        <input
          className="field input gen-text"
          data-testid="voice-clone-transcript"
          placeholder="Leave empty and Whisper writes it"
          maxLength={1000}
          value={transcript}
          disabled={running}
          onChange={(e) => setTranscript(e.target.value)}
        />
      </div>
      <label className="gen-toggle gen-clone-consent" data-testid="voice-clone-consent">
        <input type="checkbox" checked={consent} disabled={running} onChange={(e) => setConsent(e.target.checked)} />
        <span>{CONSENT}</span>
      </label>
      {running ? (
        <div className="import-progress gen-progress" data-testid="voice-clone-progress">
          <LoaderCircle className="spin" />
          <span className="gen-status">{job.status ?? "Working…"}</span>
          <button className="link-btn" data-testid="voice-clone-cancel" disabled={!online} onClick={() => void actions.cancelClone()}>
            <X />
            Cancel
          </button>
          <div className="bar indeterminate">
            <span />
          </div>
        </div>
      ) : (
        <button className="btn gen-clone-run" data-testid="voice-clone-run" disabled={!ready} onClick={() => void clone()}>
          Clone voice
        </button>
      )}
      {(app.voiceError || (job?.phase === "failed" && job.id === startedId)) && (
        <div className="inline-error small" data-testid="voice-clone-error">
          {app.voiceError ?? job?.error}
        </div>
      )}
    </div>
  );
}
