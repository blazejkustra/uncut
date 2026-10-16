import type { SetupCheck, KeyInfo } from "@uncut/contracts";
import { Terminal, Check, CircleAlert, Copy, AudioLines, X, Download, TriangleAlert, KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useState, useRef, type ReactElement, type SVGProps } from "react";
import { actions, useApp } from "../state/store.ts";
import { ClaudeMark, OpenAIMark } from "../panels/composer/providerMarks.tsx";
import { ElevenLabsMark, GoogleMark } from "../panels/generate/marks.tsx";
import { ArgentMark, FFmpegMark, WhisperCppMark } from "./toolMarks.tsx";
import "./rowMarks.css";

// D277 (user's call): the agents and the keyed providers show their real marks (the composer's and
// the Generate tab's); Freesound has none, so it keeps the key icon. D281: so do the tools (Argent,
// FFmpeg, and whisper.cpp's neutral mark); a check without one gets the terminal icon.
type Mark = (props: SVGProps<SVGSVGElement>) => ReactElement;
const CHECK_MARKS: Record<string, Mark> = { claude: ClaudeMark, codex: OpenAIMark, argent: ArgentMark, ffmpeg: FFmpegMark, whisper: WhisperCppMark };
const KEY_MARKS: Partial<Record<KeyInfo["provider"], Mark>> = { openai: OpenAIMark, google: GoogleMark, elevenlabs: ElevenLabsMark };
const RowMark = ({ mark: M, id }: { mark: Mark; id: string }) => <M className="wiz-mark" data-testid={`row-mark-${id}`} aria-hidden focusable="false" />;

const CHIP: Record<SetupCheck["status"], { label: string; className: string; icon: typeof Check }> = {
  ready: { label: "Ready", className: "ok", icon: Check },
  "needs-login": { label: "Needs login", className: "warn", icon: CircleAlert },
  warning: { label: "Found", className: "warn", icon: CircleAlert },
  missing: { label: "Not installed", className: "dim", icon: CircleAlert },
  error: { label: "Error", className: "error", icon: CircleAlert },
};

export function CheckRow({ check }: { check: SetupCheck }) {
  const mark = CHECK_MARKS[check.id];
  const chip = CHIP[check.status];
  const ChipIcon = chip.icon;
  const found = check.status !== "missing" && check.path !== undefined;
  const version = check.version ? `Version ${check.version}.` : found ? "Version unknown." : undefined;
  const sub = [version, check.detail].filter(Boolean).join(" ");
  return (
    <div className="wiz-check" data-testid={`check-${check.id}`} data-status={check.status}>
      <div className="wiz-row">
        {mark ? <RowMark mark={mark} id={check.id} /> : <Terminal />}
        <div className="grow">
          <div className="wiz-name">
            {check.name}
            {check.optional && <span className="wiz-optional">Optional</span>}
          </div>
          <div className="wiz-sub" title={check.path}>
            {sub}
          </div>
        </div>
        <span className={`wiz-chip ${chip.className}`} data-testid={`chip-${check.id}`}>
          <ChipIcon />
          {chip.label}
        </span>
      </div>
      {check.fix && (
        <div className="wiz-fix">
          <span className="wiz-fix-text">{check.fix.text}</span>
          {check.fix.command && (
            <div className="wiz-cmd">
              <code>{check.fix.command}</code>
              <button className="link-btn" data-testid={`copy-${check.id}`} onClick={() => void actions.copy(check.fix!.command!)} title="Copy the command">
                <Copy />
                Copy
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/** The speech model for transcripts (D68): which one, and its download (on demand, never at start). */
export function SpeechModelRow() {
  const { transcription, transcriptionError, connection } = useApp();
  if (!transcription) return null;
  const model = transcription.models.find((m) => m.id === transcription.selected);
  if (!model) return null;
  const choices = transcription.models.filter((m) => m.offered || m.id === model.id);
  const download = transcription.downloads.find((d) => d.model === model.id);
  const downloading = download?.phase === "downloading";
  const total = download?.total ?? model.bytes;
  const fraction = downloading && total ? Math.min(1, download.received / total) : 0;
  const offline = connection !== "connected";
  const sub = model.installed
    ? `Downloaded (${mb(model.bytes)}). ${model.multilingual ? "Polish, English and many more languages." : "English only."}`
    : downloading
      ? `Downloading… ${Math.round(fraction * 100)}% (${mb(download.received)} of ${mb(total)})`
      : download?.phase === "failed"
        ? (download.error ?? "The download failed.")
        : `Not downloaded yet (${mb(model.bytes)}). It downloads the first time a transcript is needed, or now.`;
  return (
    <div className="wiz-check" data-testid="whisper-model" data-model={model.id} data-installed={model.installed} data-phase={download?.phase ?? ""}>
      <div className="wiz-row">
        <AudioLines />
        <div className="grow">
          <div className="wiz-name">
            Speech model
            <span className="wiz-optional">For transcripts</span>
          </div>
          <div className="wiz-sub" data-testid="whisper-model-status" title={transcription.dir}>
            {sub}
          </div>
          {downloading && (
            <div className="wiz-progress" data-testid="whisper-download-progress">
              <span style={{ width: `${Math.round(fraction * 100)}%` }} />
            </div>
          )}
        </div>
        <select className="wiz-select" data-testid="whisper-model-select" value={model.id} disabled={downloading || offline} onChange={(e) => void actions.selectModel(e.target.value)} title="The model transcripts use: bigger is more accurate, smaller downloads faster">
          {choices.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({mb(m.bytes)})
            </option>
          ))}
        </select>
        {model.installed ? (
          <span className="wiz-chip ok" data-testid="chip-whisper-model">
            <Check />
            Ready
          </span>
        ) : downloading ? (
          <button className="btn ghost" data-testid="whisper-download-cancel" disabled={offline} onClick={() => void actions.cancelModelDownload(model.id)} title="Stop the download">
            <X />
            Cancel
          </button>
        ) : (
          <button className="btn" data-testid="whisper-download" disabled={offline} onClick={() => void actions.downloadModel(model.id)}>
            <Download />
            Download
          </button>
        )}
      </div>
      {transcriptionError && (
        <div className="wiz-fix" data-testid="whisper-model-error">
          {transcriptionError}
        </div>
      )}
    </div>
  );
}

/**
 * Settings › Keys (D99): the generator keys, optional. A key is typed once and goes to the server,
 * which keeps it encrypted (the Keychain); the screen only ever learns whether one is stored.
 */
export function KeyRows() {
  const { keys, keysError, connection } = useApp();
  useEffect(() => {
    if (connection === "connected" && !keys) void actions.listKeys();
  }, [connection, keys]);
  if (!keys) return null;
  const offline = connection !== "connected";
  return (
    <div className="wiz-plugins wiz-keys" data-testid="keys">
      <div className="wiz-section">Keys (optional)</div>
      <div className="wiz-sub">GPT Image, Veo and Sound effects bill your own account. A key stays in this Mac's Keychain and never goes to the agent or into a project.</div>
      {keys.map((k) => (
        <KeyRow key={k.provider} info={k} offline={offline} />
      ))}
      {keysError && (
        <div className="wiz-note error" data-testid="keys-error">
          <TriangleAlert />
          {keysError}
        </div>
      )}
    </div>
  );
}

function KeyRow({ info: k, offline }: { info: KeyInfo; offline: boolean }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const save = async () => {
    if (!value.trim() || saving) return;
    setSaving(true);
    const ok = await actions.setKey(k.provider, value);
    setSaving(false);
    // The field forgets it once it's stored.
    if (ok) setValue("");
  };
  const mark = KEY_MARKS[k.provider];
  return (
    <div className="wiz-check" data-testid={`key-${k.provider}`} data-set={k.set}>
      <div className="wiz-row">
        {mark ? <RowMark mark={mark} id={k.provider} /> : <KeyRound />}
        <div className="grow">
          <div className="wiz-name">{k.name}</div>
          <div className="wiz-sub">
            For {k.usedBy.join(", ")}
            {k.set && k.storage === "memory" ? ". Kept until Uncut quits" : ""}
          </div>
          {k.note && (
            <div className="wiz-sub" data-testid={`key-note-${k.provider}`}>
              {k.note}
            </div>
          )}
        </div>
        {k.set ? (
          <>
            <span className="wiz-chip ok" data-testid={`key-chip-${k.provider}`}>
              <Check />
              Saved
            </span>
            <button className="btn ghost" data-testid={`key-remove-${k.provider}`} disabled={offline} onClick={() => void actions.removeKey(k.provider)}>
              Remove
            </button>
          </>
        ) : (
          <>
            <input
              ref={input}
              className="field input key-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={`${k.name} API key`}
              data-testid={`key-input-${k.provider}`}
              value={value}
              disabled={offline}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
            />
            <button className="btn" data-testid={`key-save-${k.provider}`} disabled={offline || !value.trim() || saving} onClick={() => void save()}>
              Save
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function PendingRow() {
  return (
    <div className="wiz-row pending">
      <RefreshCw className="spin" />
      <div className="grow wiz-sub">Checking…</div>
    </div>
  );
}
