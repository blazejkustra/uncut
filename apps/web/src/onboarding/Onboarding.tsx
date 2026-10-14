import type { KeyInfo, PluginInfo, SetupCheck } from "@uncut/contracts";
import { ArrowRight, AudioLines, Blocks, KeyRound, Captions, Check, CircleAlert, CircleDot, Clapperboard, Copy, Download, Film, FolderOpen, GitBranch, Plus, RefreshCw, Search, Sparkle, Terminal, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { actions, useApp } from "../state/store.ts";
import { EnvironmentChip } from "./Environments.tsx";

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
  const { setupChecks, setupChecking, setupError, setupFocus } = useApp();
  const [step, setStep] = useState(0);
  // Settings › Keys (the Generate tab's link): the Agents step, scrolled to the keys.
  useEffect(() => {
    if (setupFocus !== "keys") return;
    setStep(0);
    requestAnimationFrame(() => document.querySelector("[data-testid=keys]")?.scrollIntoView({ block: "center" }));
  }, [setupFocus]);
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
          <KeyRows />
          <EnvironmentSettings />
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
          <p />
          <div className="wiz-btns">
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
          {/* F32 (D175): one way past the whole wizard, on every step; Settings › App reopens it. */}
          <button className="btn ghost wiz-skip" data-testid="wizard-skip" onClick={() => void actions.finishSetup("stay")}>
            Skip setup
          </button>
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
  return (
    <div className="wiz-check" data-testid={`key-${k.provider}`} data-set={k.set}>
      <div className="wiz-row">
        <KeyRound />
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

function PendingRow() {
  return (
    <div className="wiz-row pending">
      <RefreshCw className="spin" />
      <div className="grow wiz-sub">Checking…</div>
    </div>
  );
}

/**
 * Settings › Plugins (D97, D102): every plugin found, its status, Allow (through the approval
 * dialog) and, for one Uncut installed, Remove; plus Add plugin… from a folder or a git URL.
 */
export function PluginRows() {
  const { plugins, pluginError, pluginInstallNote, connection, pluginDialog } = useApp();
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const offline = connection !== "connected";
  const dialog = pluginDialog ? plugins?.find((p) => p.id === pluginDialog && p.status !== "broken") : undefined;
  return (
    <div className="wiz-plugins" data-testid="plugins">
      <div className="wiz-section-row">
        <div className="wiz-section">Plugins</div>
        <div className="wiz-btns">
          {!browsing && (
            <button className="btn ghost" data-testid="plugin-browse" disabled={offline} onClick={() => setBrowsing(true)}>
              <Search />
              Browse…
            </button>
          )}
          {!adding && (
            <button className="btn ghost" data-testid="plugin-add" disabled={offline} onClick={() => setAdding(true)}>
              <Plus />
              Add plugin…
            </button>
          )}
        </div>
      </div>
      {browsing && <BrowsePlugins offline={offline} onClose={() => setBrowsing(false)} />}
      {adding && <AddPlugin offline={offline} onClose={() => setAdding(false)} />}
      {!plugins?.length && !adding && <div className="wiz-sub">No plugins yet. A plugin adds tools for the agent, like a capture source or a generator.</div>}
      {plugins?.map((p) => (
        <PluginRow key={`${p.source}:${p.dir}`} plugin={p} offline={offline} />
      ))}
      {pluginInstallNote && (
        <div className="wiz-note warn" data-testid="plugin-install-note">
          <TriangleAlert />
          {pluginInstallNote}
        </div>
      )}
      {pluginError && (
        <div className="wiz-note error" data-testid="plugin-error">
          <TriangleAlert />
          {pluginError}
        </div>
      )}
      {dialog && <PluginApproval plugin={dialog} offline={offline} />}
    </div>
  );
}

/**
 * Browse… (D103): Uncut's plugin catalog (plugins/catalog in the repo, shipped with the app, off
 * by default), searchable. Enable copies one in and opens the approval dialog; Disable removes it.
 */
function BrowsePlugins({ offline, onClose }: { offline: boolean; onClose: () => void }) {
  const { pluginCatalog, pluginInstalling, plugins } = useApp();
  const [query, setQuery] = useState("");
  useEffect(() => {
    void actions.loadCatalog();
  }, [plugins]);
  const q = query.trim().toLowerCase();
  const all = pluginCatalog?.plugins ?? [];
  const shown = all.filter((e) => !q || [e.id, e.name, e.description, e.kind, ...(e.contributes ? [...e.contributes.looks, ...e.contributes.components, ...e.contributes.rules] : [])].some((v) => v.toLowerCase().includes(q)));
  const busy = offline || !!pluginInstalling;
  return (
    <div className="wiz-check plugin-browse" data-testid="plugin-browse-panel">
      <div className="wiz-sub">Plugins that come with Uncut and are off until you enable them. Each one asks before it's allowed.</div>
      {all.length > 0 && <input className="field input" data-testid="plugin-catalog-search" placeholder="Search plugins" value={query} onChange={(e) => setQuery(e.target.value)} />}
      {pluginCatalog && !all.length && <div className="wiz-sub">No plugins in the catalog yet.</div>}
      {shown.map((e) => (
        <div className="plugin-browse-row" key={e.id} data-testid="plugin-catalog-entry" data-id={e.id} data-enabled={e.enabled ? "true" : "false"}>
          <Blocks />
          <div className="grow">
            <div className="wiz-name">{e.name}</div>
            {e.description && <div className="wiz-sub">{e.description}</div>}
            <div className="plugin-browse-tags">
              {[e.contributes ? addsLine(e.contributes) : "", e.tools.length ? `Gives the agent ${e.tools.join(", ")}` : "", e.runs ? "Runs as a program" : "Runs no program"].filter(Boolean).join(". ")}
            </div>
          </div>
          {e.enabled ? (
            <button className="btn ghost" data-testid="plugin-catalog-disable" disabled={busy} onClick={() => void actions.disablePlugin(e.id)}>
              Disable
            </button>
          ) : (
            <button className="btn" data-testid="plugin-catalog-enable" disabled={busy} onClick={() => void actions.enablePlugin(e.id)}>
              Enable…
            </button>
          )}
        </div>
      ))}
      {q && all.length > 0 && !shown.length && <div className="wiz-sub">No plugin matches that.</div>}
      {pluginCatalog?.problems.map((p) => (
        <div key={p} className="wiz-sub error">
          {p}
        </div>
      ))}
      <div className="wiz-btns">
        <button className="link-btn" data-testid="plugin-browse-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** Add plugin…: choose a folder, or paste a git URL (with an optional branch or tag). */
function AddPlugin({ offline, onClose }: { offline: boolean; onClose: () => void }) {
  const { pluginInstalling, pluginInstallError } = useApp();
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const busy = offline || !!pluginInstalling;
  const done = (ok: boolean) => ok && onClose();
  const fromUrl = async () => url.trim() && done(await actions.installPlugin({ source: url.trim(), ref: ref.trim() || undefined }));
  return (
    <div className="wiz-check" data-testid="plugin-add-panel">
      <div className="wiz-row">
        <FolderOpen />
        <div className="grow">
          <div className="wiz-name">From a folder on this Mac</div>
          <div className="wiz-sub">A folder with an uncut.module.json. Uncut copies it into its plugins folder.</div>
        </div>
        <button className="btn" data-testid="plugin-add-folder" disabled={busy} onClick={() => void actions.installPluginFolder().then(done)}>
          Choose folder…
        </button>
      </div>
      <div className="wiz-row">
        <GitBranch />
        <div className="grow plugin-git">
          <input
            className="field input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="Git URL (https://, ssh:// or git@host:path)"
            data-testid="plugin-add-url"
            value={url}
            disabled={busy}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void fromUrl()}
          />
          <input
            className="field input plugin-ref"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="Branch or tag (optional)"
            data-testid="plugin-add-ref"
            value={ref}
            disabled={busy}
            onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void fromUrl()}
          />
        </div>
        <button className="btn" data-testid="plugin-add-install" disabled={busy || !url.trim()} onClick={() => void fromUrl()}>
          {pluginInstalling ? "Installing…" : "Install"}
        </button>
      </div>
      <div className="wiz-fix">
        <span>Installing doesn't run it: you see what it asks for and allow it next.</span>
        {pluginInstallError && (
          <span className="error" data-testid="plugin-install-error">
            {pluginInstallError.message}
          </span>
        )}
        <span className="wiz-btns">
          {pluginInstallError?.reason === "replaces-bundled" && (
            <button
              className="btn"
              data-testid="plugin-add-replace"
              disabled={busy}
              onClick={() => void actions.installPlugin({ source: pluginInstallError.source, ref: pluginInstallError.ref, replaceBundled: true }).then(done)}
            >
              Install it anyway
            </button>
          )}
          <button className="link-btn" data-testid="plugin-add-cancel" onClick={onClose}>
            Cancel
          </button>
        </span>
      </div>
    </div>
  );
}

/** What a plugin adds (D103), in words: "Text looks: Soft card. Components: Corner sticker. Checks: …". */
const addsLine = (c: NonNullable<PluginInfo["contributes"]>) =>
  [c.looks.length ? `Text looks: ${c.looks.join(", ")}` : "", c.components.length ? `Components: ${c.components.join(", ")}` : "", c.rules.length ? `Checks: ${c.rules.join(", ")}` : ""].filter(Boolean).join(". ");

/** Where a plugin came from, in words (the approval dialog and the row's tooltip). */
const originLines = (p: PluginInfo): Array<[string, string]> => {
  if (p.source === "bundled") return [["Source", "Ships with Uncut"]];
  if (p.origin?.kind === "git") return [["Source", p.origin.source], ...(p.origin.ref ? [["Branch or tag", p.origin.ref] as [string, string]] : []), ["Commit", p.origin.commit ?? "unknown"]];
  if (p.origin?.kind === "catalog") return [["Source", "Uncut's plugin catalog"]];
  if (p.origin?.kind === "folder") return [["Source", `Copied from ${p.origin.source}`]];
  return [["Source", `The folder ${p.dir}`]];
};

/** Allowing a plugin (D97): where it came from, what it asks for, and that it runs with your rights. */
function PluginApproval({ plugin: p, offline }: { plugin: PluginInfo; offline: boolean }) {
  const [rights, ...rest] = p.asks;
  // Above Settings (itself a modal), outside its scrolling list.
  return createPortal(
    <div className="modal-layer plugin-approval-layer" data-testid="plugin-dialog" onMouseDown={(e) => e.target === e.currentTarget && actions.openPluginDialog(undefined)}>
      <div className="modal plugin-approval" role="dialog" aria-label={`Allow ${p.name}?`}>
        <h2>Allow {p.name}?</h2>
        <div className="plugin-facts">
          {[...originLines(p), ["Id", p.id] as [string, string], ...(p.version ? [["Version", p.version] as [string, string]] : []), ["Tools for the agent", p.tools.length ? p.tools.join(", ") : "None"] as [string, string], ...(p.contributes ? [["Adds", addsLine(p.contributes)] as [string, string]] : [])].map(([k, v]) => (
            <div className="plugin-fact" key={k} data-testid={`plugin-dialog-${k.toLowerCase().replace(/\W+/g, "-")}`}>
              <span className="k">{k}</span>
              <span className="v">{v}</span>
            </div>
          ))}
        </div>
        <div className="plugin-asks" data-testid="plugin-dialog-asks">
          {rest.map((line) => (
            <p key={line}>{line}</p>
          ))}
          {p.capabilities.length === 0 && <p>It doesn't ask for any capabilities.</p>}
        </div>
        {rights && (
          <div className="wiz-note warn" data-testid="plugin-dialog-rights">
            <TriangleAlert />
            {rights}
          </div>
        )}
        <div className="wiz-btns">
          <button className="btn ghost" data-testid="plugin-dialog-cancel" onClick={() => actions.openPluginDialog(undefined)}>
            Not now
          </button>
          <button className="btn primary" data-testid="plugin-dialog-allow" disabled={offline} onClick={() => void actions.approvePlugin(p)}>
            Allow
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PluginRow({ plugin: p, offline }: { plugin: PluginInfo; offline: boolean }) {
  const tools = p.tools.length ? `Gives the agent ${p.tools.join(", ")}` : p.contributes ? addsLine(p.contributes) : "No agent tools";
  const from = p.source === "bundled" ? "Ships with Uncut." : p.origin?.kind === "git" ? `From ${p.origin.source}${p.origin.commit ? ` at ${p.origin.commit.slice(0, 7)}` : ""}` : p.origin?.kind === "catalog" ? "From Uncut's catalog." : p.origin ? `Copied from ${p.origin.source}` : `From ${p.dir}`;
  const sub = p.status === "broken" ? "Skipped" : `${p.version ? `Version ${p.version}. ` : ""}${tools}. ${from}`;
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
          <button className="btn primary" data-testid={`plugin-allow-${p.id}`} disabled={offline} onClick={() => actions.openPluginDialog(p.id)}>
            Allow…
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
      {((p.status === "ready" && p.source === "user") || p.removable) && (
        <div className="wiz-fix wiz-actions">
          {p.status === "ready" && p.source === "user" && (
            <button className="link-btn" data-testid={`plugin-revoke-${p.id}`} disabled={offline} onClick={() => void actions.revokePlugin(p.id)}>
              Stop allowing it
            </button>
          )}
          {p.removable && (
            <button className="link-btn" data-testid={`plugin-remove-${p.id}`} disabled={offline} onClick={() => void actions.uninstallPlugin(p.id)}>
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Settings, Environments (D106): which server this window uses, and the way to the others. */
function EnvironmentSettings() {
  const { environment } = useApp();
  return (
    <div className="wiz-plugins" data-testid="settings-environments">
      <div className="wiz-section-row">
        <div className="wiz-section">Environment</div>
      </div>
      <div className="wiz-row">
        <div className="grow">
          <div className="wiz-name">{environment.kind === "remote" ? `Working on ${environment.name}` : "Working on this Mac"}</div>
          <div className="wiz-sub">{environment.kind === "remote" ? "Agents, ffmpeg, Argent and plugins above are that machine's." : "Add another machine to edit and export there instead."}</div>
        </div>
        <EnvironmentChip />
        <button className="btn" data-testid="settings-environments-manage" onClick={() => void actions.openEnvironments()}>
          Manage…
        </button>
      </div>
    </div>
  );
}
