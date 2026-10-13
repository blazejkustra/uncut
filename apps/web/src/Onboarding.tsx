import type { PluginInfo, SetupCheck } from "@uncut/contracts";
import { ArrowRight, AudioLines, Blocks, Captions, Check, CircleAlert, CircleDot, Clapperboard, Copy, Download, Film, RefreshCw, Sparkle, Terminal, TriangleAlert, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { actions, useApp } from "./store.ts";

const STEPS = ["Agents", "Capture", "First video"] as const;

const ICONS: Record<string, typeof Film> = { claude: Sparkle, codex: Terminal, argent: CircleDot, ffmpeg: Film, whisper: Captions };

const CHIP: Record<SetupCheck["status"], { label: string; className: string; icon: typeof Check }> = {
  ready: { label: "Ready", className: "ok", icon: Check },
  "needs-login": { label: "Needs login", className: "warn", icon: CircleAlert },
  warning: { label: "Found", className: "warn", icon: CircleAlert },
  missing: { label: "Not installed", className: "dim", icon: CircleAlert },
  error: { label: "Error", className: "error", icon: CircleAlert },
};

/** The t3code-style wizard from the wireframe: Agents → Capture → First video, with real checks. */
export function Onboarding({ standalone }: { standalone: boolean }) {
  const { setupChecks, setupChecking, setupError } = useApp();
  const [step, setStep] = useState(0);
  // Escape skips (and remembers it), wherever focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && void actions.finishSetup("stay");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const byId = Object.fromEntries((setupChecks ?? []).map((c) => [c.id, c]));
  // A row: its result, "Checking…" while a check runs, or nothing if the whole check failed
  // (the error box below says so; no endless spinner).
  const row = (id: string) => (byId[id] ? <CheckRow check={byId[id]} /> : setupChecking ? <PendingRow /> : null);
  const failure = setupError && !setupChecking && (
    <div className="wiz-note error" data-testid="setup-error">
      <TriangleAlert />
      {setupError}
    </div>
  );
  // A step earns its check mark only when what it needs is ready: an agent, and ffmpeg.
  const stepDone = [
    ["claude", "codex"].some((id) => byId[id]?.status === "ready"),
    byId.ffmpeg?.status === "ready",
    false,
  ];
  const [visited, setVisited] = useState<ReadonlySet<number>>(new Set([0]));
  const go = (i: number) => {
    setVisited((v) => new Set([...v, i]));
    setStep(i);
  };
  const recheck = (
    <button className="btn ghost" data-testid="check-again" onClick={() => void actions.checkSetup()} disabled={setupChecking}>
      <RefreshCw className={setupChecking ? "spin" : ""} />
      Check again
    </button>
  );

  let body: ReactNode;
  if (step === 0) {
    body = (
      <>
        <h1>Connect your agents</h1>
        <p className="wiz-lead">Uncut runs on the Claude Code or Codex you already use, with your own subscription. No API keys needed.</p>
        <div className="wiz-list">
          {row("claude")}
          {row("codex")}
          {failure}
          {byId["api-key"] && (
            <div className="wiz-note warn" data-testid="api-key-warning">
              <TriangleAlert />
              {byId["api-key"].detail}
            </div>
          )}
        </div>
        <div className="wiz-foot">
          <p>One agent is enough. Add more any time in Settings.</p>
          <div className="wiz-btns">
            {recheck}
            <button className="btn primary" data-testid="wizard-continue" onClick={() => go(1)}>
              Continue
              <ArrowRight />
            </button>
          </div>
        </div>
      </>
    );
  } else if (step === 1) {
    const ffmpegMissing = byId.ffmpeg && byId.ffmpeg.status !== "ready";
    body = (
      <>
        <h1>Record and export</h1>
        <p className="wiz-lead">Argent records simulators, emulators, web and desktop apps. ffmpeg makes thumbnails, waveforms and the final video. whisper.cpp transcribes speech on this Mac.</p>
        <div className="wiz-list">
          {row("argent")}
          {row("ffmpeg")}
          {row("whisper")}
          {byId.whisper && <SpeechModelRow />}
          <PluginRows />
          {failure}
          {ffmpegMissing && (
            <div className="wiz-note error" data-testid="ffmpeg-callout">
              <TriangleAlert />
              Without ffmpeg Uncut can't make thumbnails or export. You can continue and install it later.
            </div>
          )}
        </div>
        <div className="wiz-foot">
          <p>Argent is optional. Skip it if you only edit footage you already have.</p>
          <div className="wiz-btns">
            {recheck}
            <button className="btn primary" data-testid="wizard-continue" onClick={() => go(2)}>
              Continue
              <ArrowRight />
            </button>
          </div>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <h1>Start a video</h1>
        <p className="wiz-lead">A project is a folder on this Mac. Pick a shape and where to keep it; your footage stays where it is.</p>
        <div className="wiz-list">
          <div className="wiz-row">
            <Clapperboard />
            <div className="grow">
              <div className="wiz-name">New project</div>
              <div className="wiz-sub">Landscape, vertical, 4:5 or 4K</div>
            </div>
          </div>
        </div>
        <div className="wiz-foot">
          <p>You can come back to this from Uncut → Settings… (⌘,).</p>
          <div className="wiz-btns">
            <button className="btn ghost" data-testid="wizard-skip" onClick={() => void actions.finishSetup("stay")}>
              Skip for now
            </button>
            <button className="btn primary" data-testid="wizard-new-project" onClick={() => void actions.finishSetup("new-project")}>
              New project
              <ArrowRight />
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className={`modal-layer ${standalone ? "standalone" : ""}`} data-testid="onboarding">
      <div className="modal wiz" data-step={STEPS[step]}>
        <div className="wiz-header">
          <div className="wiz-brand">Uncut</div>
          <ol className="wiz-steps">
            {STEPS.map((name, i) => (
              <li key={name}>
                <button className={i === step ? "current" : ""} data-testid={`wizard-step-${i}`} onClick={() => go(i)}>
                  <span
                    className={`wiz-num ${i === step ? "now" : stepDone[i] && visited.has(i) ? "done" : visited.has(i) ? "visited" : ""}`}
                    data-testid={`wizard-step-mark-${i}`}
                  >
                    {i !== step && stepDone[i] && visited.has(i) ? <Check /> : i + 1}
                  </span>
                  {name}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className="wiz-panel">{body}</div>
      </div>
    </div>
  );
}

export function CheckRow({ check }: { check: SetupCheck }) {
  const Icon = ICONS[check.id] ?? Terminal;
  const chip = CHIP[check.status];
  const ChipIcon = chip.icon;
  const found = check.status !== "missing" && check.path !== undefined;
  const version = check.version ? `Version ${check.version}.` : found ? "Version unknown." : undefined;
  const sub = [version, check.detail].filter(Boolean).join(" ");
  return (
    <div className="wiz-check" data-testid={`check-${check.id}`} data-status={check.status}>
      <div className="wiz-row">
        <Icon />
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

function PendingRow() {
  return (
    <div className="wiz-row pending">
      <RefreshCw className="spin" />
      <div className="grow wiz-sub">Checking…</div>
    </div>
  );
}

/**
 * The plugin folders Uncut found (D97), only when there are any: each one's status, what allowing
 * it means, and Allow. The full plugin manager comes later (Phase 8).
 */
export function PluginRows() {
  const { plugins, pluginError, connection } = useApp();
  if (!plugins?.length) return null;
  const offline = connection !== "connected";
  return (
    <div className="wiz-plugins" data-testid="plugins">
      <div className="wiz-section">Plugins</div>
      {plugins.map((p) => (
        <PluginRow key={`${p.source}:${p.dir}`} plugin={p} offline={offline} />
      ))}
      {pluginError && (
        <div className="wiz-note error" data-testid="plugin-error">
          <TriangleAlert />
          {pluginError}
        </div>
      )}
    </div>
  );
}

function PluginRow({ plugin: p, offline }: { plugin: PluginInfo; offline: boolean }) {
  const tools = p.tools.length ? `Gives the agent ${p.tools.join(", ")}` : "No agent tools";
  const sub = p.status === "broken" ? "Skipped" : `${p.version ? `Version ${p.version}. ` : ""}${tools}. ${p.source === "bundled" ? "Ships with Uncut." : `From ${p.dir}`}`;
  return (
    <div className="wiz-check" data-testid={p.status === "broken" ? `plugin-skipped-${p.id}` : `plugin-${p.id}`} data-status={p.status}>
      <div className="wiz-row">
        <Blocks />
        <div className="grow">
          <div className="wiz-name">{p.name}</div>
          <div className="wiz-sub" title={p.dir}>
            {sub}
          </div>
        </div>
        {p.status === "ready" ? (
          <span className="wiz-chip ok" data-testid={`plugin-chip-${p.id}`}>
            <Check />
            Allowed
          </span>
        ) : p.status === "broken" ? (
          <span className="wiz-chip error" data-testid={`plugin-chip-${p.id}`}>
            <CircleAlert />
            Not loaded
          </span>
        ) : (
          <button className="btn primary" data-testid={`plugin-allow-${p.id}`} disabled={offline} onClick={() => void actions.approvePlugin(p)}>
            Allow
          </button>
        )}
      </div>
      {(p.status === "needs-approval" || p.problem || p.warnings.length > 0) && (
        <div className="wiz-fix" data-testid={`plugin-detail-${p.id}`}>
          {p.problem && <span>{p.problem}</span>}
          {p.status === "needs-approval" && p.asks.map((line) => <span key={line}>{line}</span>)}
          {p.warnings.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
      )}
      {p.status === "ready" && p.source === "user" && (
        <div className="wiz-fix">
          <button className="link-btn" data-testid={`plugin-revoke-${p.id}`} disabled={offline} onClick={() => void actions.revokePlugin(p.id)}>
            Stop allowing it
          </button>
        </div>
      )}
    </div>
  );
}
