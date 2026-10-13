// The export dialog (D34): three quality cards, the file and where it goes, loudness in plain
// words, "Opens in Finder when it's done". The export itself is a server job (D55): this shows its
// progress with a Cancel, and closing the dialog doesn't stop it (the top bar keeps the percentage).
// Without ffmpeg there's nothing to export with, so the dialog shows how to install it instead.
import type { ExportJob, ExportLoudness, ExportQuality } from "@uncut/contracts";
import { mixNote, SILENCE_DB } from "@uncut/core/audio";
import { dbWords } from "@uncut/core/edit-log";
import { outputSize } from "@uncut/core/export";
import { FolderOpen, X } from "lucide-react";
import { useEffect, useState } from "react";

import { shortPath } from "./format.ts";
import { CheckRow } from "./Onboarding.tsx";
import { actions, useApp, type Project } from "./store.ts";

const QUALITIES: ReadonlyArray<{ readonly id: ExportQuality; readonly label: string; readonly hint: string }> = [
  { id: "draft", label: "Draft", hint: "Fast, for a quick look" },
  { id: "standard", label: "Standard", hint: "For sharing anywhere" },
  { id: "high", label: "High", hint: "Full size, the best copy" },
];

const LOUDNESS: ReadonlyArray<{ readonly id: ExportLoudness; readonly label: string; readonly sub: string; readonly hint: string }> = [
  { id: "normal", label: "Normal", sub: "−14 LUFS", hint: "Evens out the volume so it plays as loud as other videos on YouTube, Instagram and TikTok." },
  { id: "quiet", label: "Quieter", sub: "−16 LUFS", hint: "A little quieter, as podcasts and Apple Music expect." },
  { id: "off", label: "As mixed", sub: "No change", hint: "Keeps your levels exactly as they sound in the editor." },
];

const ACTIVE = new Set(["queued", "preparing", "rendering"]);
export const exportRunning = (job: ExportJob | undefined) => job !== undefined && ACTIVE.has(job.phase);

/** A file name the Finder accepts, ending in .mp4. */
const fileName = (name: string) => {
  const clean = name.replace(/[/:]/g, "-").trim() || "Untitled";
  return /\.mp4$/i.test(clean) ? clean : `${clean}.mp4`;
};
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

const eta = (s: number | undefined) => (s === undefined ? "" : s < 60 ? `About ${Math.max(1, Math.round(s))} s left` : `About ${Math.round(s / 60)} min left`);

export function ExportDialog({ project, dir }: { project: Project; dir: string }) {
  const { appInfo, exportJobs, exportJobId, exportFolder, setupChecks, setupChecking } = useApp();
  const [quality, setQuality] = useState<ExportQuality>("standard");
  const [loudness, setLoudness] = useState<ExportLoudness>("normal");
  const [name, setName] = useState(fileName(project.name));
  const [folder, setFolder] = useState(exportFolder ?? appInfo.defaultParentDir);
  const [error, setError] = useState<{ reason?: string | undefined; message: string } | undefined>();
  const [busy, setBusy] = useState(false);
  // A path the native save panel returned: it already asked before replacing a file there.
  const [confirmed, setConfirmed] = useState<string | undefined>();
  // A finished job stays on screen until "Export again" or the dialog closes.
  const [dismissed, setDismissed] = useState<string | undefined>();
  const job = exportJobs.find((j) => j.id === exportJobId && j.projectDir === dir && j.id !== dismissed && j.phase !== "cancelled");
  const cancelled = exportJobs.find((j) => j.id === exportJobId && j.phase === "cancelled");
  const ffmpeg = setupChecks?.find((c) => c.id === "ffmpeg");
  const noFfmpeg = ffmpeg !== undefined && ffmpeg.status !== "ready" && !job;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      actions.closeExport();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const output = `${folder.replace(/\/$/, "")}/${fileName(name)}`;
  const start = async (overwrite = false) => {
    setBusy(true);
    setError(undefined);
    const refused = await actions.startExport({ output, quality, loudness, overwrite: overwrite || output === confirmed });
    setBusy(false);
    if (refused) {
      setError(refused);
      if (refused.reason === "no-ffmpeg") void actions.checkSetup();
    }
  };
  const change = async () => {
    const chosen = await actions.chooseExportPath(output);
    if (!chosen) return;
    setFolder(dirName(chosen));
    setName(fileName(baseName(chosen)));
    setConfirmed(`${dirName(chosen).replace(/\/$/, "")}/${fileName(baseName(chosen))}`);
    setError(undefined);
  };

  let body;
  if (noFfmpeg) {
    body = (
      <div data-testid="export-no-ffmpeg">
        <p className="wiz-lead">Uncut exports with ffmpeg, and it isn't installed on this Mac yet. Install it, then check again.</p>
        <div className="wiz-list">
          <CheckRow check={ffmpeg} />
        </div>
        <div className="wiz-foot">
          <button className="btn ghost" onClick={actions.closeExport}>
            Close
          </button>
          <button className="btn primary" data-testid="export-recheck" disabled={setupChecking} onClick={() => void actions.checkSetup()}>
            {setupChecking ? "Checking…" : "Check again"}
          </button>
        </div>
      </div>
    );
  } else if (job) {
    const pct = Math.round(job.progress * 100);
    const status =
      job.phase === "queued"
        ? "Waiting for another export to finish…"
        : job.phase === "preparing"
          ? "Getting ready: drawing the text and measuring the sound…"
          : job.phase === "rendering"
            ? `Rendering… ${pct}%`
            : job.phase === "done"
              ? `Saved in ${job.elapsedSeconds ?? 0} s, and shown in Finder.`
              : "The export didn't finish.";
    body = (
      <div data-testid="export-job" data-phase={job.phase} data-progress={job.progress} data-output={job.output}>
        <p className="wiz-lead">
          <b className="mono">{baseName(job.output)}</b> in {shortPath(dirName(job.output), appInfo.homeDir)}, {job.width}×{job.height}, {job.seconds.toFixed(1)} s
        </p>
        <div className="export-status" data-testid="export-status">
          {status}
          {job.phase === "rendering" && <span className="muted">{eta(job.etaSeconds)}</span>}
        </div>
        <div className="export-bar" data-testid="export-progress">
          <div style={{ width: `${job.phase === "done" ? 100 : job.phase === "rendering" ? pct : 0}%` }} className={job.phase === "preparing" || job.phase === "queued" ? "indeterminate" : ""} />
        </div>
        {job.warnings && job.warnings.length > 0 && job.phase !== "failed" && (
          <div className="export-warnings muted small" data-testid="export-warnings">
            {job.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        )}
        {job.phase === "failed" && (
          <div className="inline-error" role="alert" data-testid="export-error">
            {job.error ?? "Something went wrong."}
          </div>
        )}
        <div className="wiz-foot">
          {ACTIVE.has(job.phase) ? (
            <>
              <button className="btn ghost" onClick={actions.closeExport} title="The export keeps going">
                Hide
              </button>
              <button className="btn" data-testid="export-cancel" onClick={() => void actions.cancelExport(job.id)}>
                Cancel export
              </button>
            </>
          ) : (
            <>
              <button className="btn ghost" data-testid="export-again" onClick={() => setDismissed(job.id)}>
                {job.phase === "done" ? "Export again" : "Try again"}
              </button>
              {job.phase === "done" && (
                <button className="btn" data-testid="export-reveal" onClick={() => void actions.showInFolder(job.output)}>
                  <FolderOpen />
                  Show in Finder
                </button>
              )}
              <button className="btn primary" data-testid="export-done" onClick={actions.closeExport}>
                Done
              </button>
            </>
          )}
        </div>
      </div>
    );
  } else {
    const look = LOUDNESS.find((l) => l.id === loudness)!;
    const note = mixNote(project);
    const masterDb = project.master?.gainDb ?? 0;
    body = (
      <form
        data-testid="export-form"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <div className="wiz-cards">
          {QUALITIES.map((q) => {
            const size = outputSize(project.canvas, q.id);
            return (
              <button type="button" key={q.id} className={`wiz-card ${q.id === quality ? "active" : ""}`} data-testid={`quality-${q.id}`} data-active={q.id === quality} onClick={() => setQuality(q.id)}>
                {q.label}
                <span>
                  {size.width}×{size.height}, {project.canvas.fps} fps
                </span>
                <span>{q.hint}</span>
              </button>
            );
          })}
        </div>
        <div className="wiz-list form-fields export-fields">
          <label className="wiz-field">
            <span>File</span>
            <input data-testid="export-name" value={name} spellCheck={false} onChange={(e) => (setName(e.target.value), setError(undefined), setConfirmed(undefined))} onBlur={() => setName(fileName(name))} />
          </label>
          <div className="wiz-field">
            <span>Folder</span>
            <b className="ellipsis" data-testid="export-folder" title={folder}>
              {shortPath(folder, appInfo.homeDir)}
            </b>
            <button type="button" className="btn ghost" data-testid="export-change" onClick={() => void change()}>
              Change…
            </button>
          </div>
        </div>
        <div className="group-label export-label">Loudness</div>
        <div className="wiz-cards">
          {LOUDNESS.map((l) => (
            <button type="button" key={l.id} className={`wiz-card ${l.id === loudness ? "active" : ""}`} data-testid={`loudness-${l.id}`} data-active={l.id === loudness} onClick={() => setLoudness(l.id)}>
              {l.label}
              <span>{l.sub}</span>
            </button>
          ))}
        </div>
        <p className="wiz-meta" data-testid="loudness-hint">
          {look.hint}
        </p>
        {note && (
          // D83: the export mixes what the preview plays, so a solo left on exports only those tracks.
          <p className="wiz-meta solo-note" data-testid="export-solo-note">
            {note}
          </p>
        )}
        {masterDb > SILENCE_DB && masterDb !== 0 && loudness !== "off" && (
          <p className="wiz-meta" data-testid="export-master-note">
            The master volume ({dbWords(masterDb)}) is heard in the editor and in As mixed; {look.label} evens the loudness out after it.
          </p>
        )}
        {cancelled && !error && <p className="wiz-meta">The last export was cancelled; nothing was saved.</p>}
        {error && (
          <div className="inline-error" role="alert" data-testid="export-refused" data-reason={error.reason}>
            {error.message}
            {error.reason === "exists" && (
              <button type="button" className="btn export-replace" data-testid="export-replace" disabled={busy} onClick={() => void start(true)}>
                Replace it
              </button>
            )}
          </div>
        )}
        <div className="wiz-foot">
          <p className="export-note">Opens in Finder when it's done.</p>
          <button type="button" className="btn ghost" onClick={actions.closeExport}>
            Cancel
          </button>
          <button type="submit" className="btn primary" data-testid="export-start" disabled={busy || !name.trim()}>
            Export
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="modal-layer" data-testid="export-modal" onMouseDown={(e) => e.target === e.currentTarget && actions.closeExport()}>
      <div className="modal wiz">
        <div className="wiz-panel">
          <div className="export-head">
            <h1>Export video</h1>
            <button className="icon-btn" title="Close (Esc)" data-testid="export-close" onClick={actions.closeExport}>
              <X />
            </button>
          </div>
          {body}
        </div>
      </div>
    </div>
  );
}
