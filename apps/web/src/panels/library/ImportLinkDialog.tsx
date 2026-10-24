// D259 (#94), D280: Import from link… (shown only while its catalog plugin is installed and
// allowed). The plugin runs the user's own yt-dlp on the server: if there's none, the dialog says
// how to install it (brew install yt-dlp, with Copy) and offers Check again, and does nothing else.
// Every time it opens, the rights notice first (and its line stays above Import). Then a link,
// Video (best up to a height, 1080p by default) or Audio only (m4a), Import; progress and Cancel
// while it downloads; errors in plain words. The media lands in Media (on the timeline too when the
// link was dropped there), named after the video's title.
import { DEFAULT_LINK_QUALITY, type LinkKind, type LinkQuality, type LinkTool } from "@uncut/contracts";
import { Check, Copy, Link2, RefreshCw } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import { plainError, useApp } from "../../state/store.ts";
import { call, connection } from "../../state/store/server.ts";
import { closeLinkImport, setLinkJobs, useLinkDialog, useLinkJobs, type LinkDialogRequest } from "./linkImport.ts";
import "./importLink.css";

export const BREW_COMMAND = "brew install yt-dlp";
const QUALITIES: ReadonlyArray<{ readonly id: LinkQuality; readonly label: string }> = [
  { id: "best", label: "Best available" },
  { id: "2160", label: "Up to 4K (2160p)" },
  { id: "1440", label: "Up to 1440p" },
  { id: "1080", label: "Up to 1080p" },
  { id: "720", label: "Up to 720p" },
  { id: "480", label: "Up to 480p" },
];

/** Mounted once (in the editor): keeps link.jobs while connected, and draws the dialog when open. */
export function LinkImportHost() {
  const connected = useApp().connection === "connected";
  useEffect(() => {
    if (!connected || !connection) return;
    return connection.subscribe((c) => c["link.jobs"]({}), setLinkJobs);
  }, [connected]);
  const request = useLinkDialog();
  return request ? <ImportLinkDialog request={request} /> : null;
}

type Step =
  | { readonly kind: "checking" }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable"; readonly problem: string }
  | { readonly kind: "notice" }
  | { readonly kind: "form" }
  | { readonly kind: "job"; readonly jobId: string };

function ImportLinkDialog({ request }: { request: LinkDialogRequest }) {
  const app = useApp();
  const online = app.connection === "connected";
  const where = app.environment.kind === "remote" ? app.environment.name : "this Mac";
  const [tool, setTool] = useState<LinkTool | undefined>();
  const [step, setStep] = useState<Step>({ kind: "checking" });
  const [url, setUrl] = useState(request.url ?? "");
  const [kind, setKind] = useState<LinkKind>("video");
  const [quality, setQuality] = useState<LinkQuality>(DEFAULT_LINK_QUALITY);
  const [problem, setProblem] = useState<string | undefined>();
  const [starting, setStarting] = useState(false);
  const jobs = useLinkJobs();
  const job = step.kind === "job" ? jobs.find((j) => j.id === step.jobId) : undefined;

  const check = async () => {
    setStep({ kind: "checking" });
    const r = await call((c) => c["link.check"]({}), 20000);
    const found = r.ok ? r.value : { found: false };
    setTool(found);
    // D280: the rights notice on every import, never remembered.
    setStep(found.found ? { kind: "notice" } : found.problem ? { kind: "unavailable", problem: found.problem } : { kind: "missing" });
  };
  useEffect(() => {
    void check();
  }, []);

  // Done: Media has it; the dialog closes.
  useEffect(() => {
    if (job?.phase === "done") closeLinkImport();
  }, [job?.phase]);

  const start = async () => {
    setProblem(undefined);
    setStarting(true);
    const r = await call((c) =>
      c["link.start"]({ url: url.trim(), kind, ...(kind === "video" ? { quality } : {}), ...(request.drop ? { drop: request.drop } : {}) }),
    );
    setStarting(false);
    if (!r.ok) {
      if (r.error.reason === "no-tool") {
        setTool({ found: false });
        setStep({ kind: "missing" });
      } else setProblem(plainError(r.error));
      return;
    }
    setStep({ kind: "job", jobId: r.value.jobId });
  };
  const running = job && (job.phase === "running" || job.phase === "importing");
  // Closing while it downloads leaves it running (Media shows it, with Cancel).
  const close = () => closeLinkImport();

  return (
    <div
      className="modal-layer"
      data-testid="link-import"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") (e.preventDefault(), close());
      }}
    >
      <div className="modal link-modal" role="dialog" aria-label="Import from link" data-step={step.kind}>
        <div className="link-title">
          <Link2 />
          Import from link
        </div>
        {step.kind === "checking" && (
          <div className="link-text" data-testid="link-checking">
            <RefreshCw className="spin" /> Looking for yt-dlp…
          </div>
        )}
        {step.kind === "unavailable" && (
          <div data-testid="link-unavailable">
            <p className="link-error">{step.problem}</p>
            <div className="confirm-actions">
              <button className="btn" data-testid="link-close" onClick={close}>
                Close
              </button>
            </div>
          </div>
        )}
        {step.kind === "missing" && (
          <div data-testid="link-missing">
            <p className="link-text">
              Import from link uses yt-dlp, a free downloader you install yourself. It isn't on {where}, and Uncut doesn't include it. Install it with Homebrew,
              then check again:
            </p>
            <CopyCommand command={BREW_COMMAND} />
            <div className="confirm-actions">
              <button className="btn" data-testid="link-close" onClick={close}>
                Close
              </button>
              <button className="btn primary" data-testid="link-check-again" disabled={!online} onClick={() => void check()}>
                Check again
              </button>
            </div>
          </div>
        )}
        {step.kind === "notice" && (
          <div data-testid="link-notice">
            <p className="link-notice-text">You need the rights to what you import. Uncut doesn't check.</p>
            <p className="link-text">
              Only import what you made, what you have permission to use, or what its licence allows. Nothing behind a sign-in can be imported.
            </p>
            <div className="confirm-actions">
              <button className="btn" data-testid="link-close" onClick={close}>
                Cancel
              </button>
              <button className="btn primary" data-testid="link-notice-ok" autoFocus onClick={() => setStep({ kind: "form" })}>
                I understand
              </button>
            </div>
          </div>
        )}
        {step.kind === "form" && (
          <form
            data-testid="link-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim() && online && !starting) void start();
            }}
          >
            <input
              className="link-url"
              data-testid="link-url"
              type="url"
              placeholder="https://…"
              autoFocus
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Link"
            />
            <div className="link-options">
              <div className="seg" role="radiogroup" aria-label="What to import">
                <button
                  type="button"
                  role="radio"
                  aria-checked={kind === "video"}
                  className={kind === "video" ? "active" : ""}
                  data-testid="link-kind-video"
                  onClick={() => setKind("video")}
                >
                  Video
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={kind === "audio"}
                  className={kind === "audio" ? "active" : ""}
                  data-testid="link-kind-audio"
                  onClick={() => setKind("audio")}
                >
                  Audio only
                </button>
              </div>
              {kind === "video" ? (
                <select
                  className="link-quality"
                  data-testid="link-quality"
                  value={quality}
                  aria-label="Quality"
                  onChange={(e) => setQuality(e.target.value as LinkQuality)}
                >
                  {QUALITIES.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="link-hint">As an m4a file</span>
              )}
            </div>
            {request.drop && <p className="link-hint">It goes on the timeline where you dropped the link.</p>}
            {problem && (
              <p className="link-error" data-testid="link-error">
                {problem}
              </p>
            )}
            <p className="link-hint" data-testid="link-rights">
              You need the rights to what you import. Uncut doesn't check.
            </p>
            <p className="link-hint" data-testid="link-tool">
              With yt-dlp{tool?.version ? ` ${tool.version}` : ""} on {where}. The name comes from the video's title.
            </p>
            <div className="confirm-actions">
              <button type="button" className="btn" data-testid="link-close" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="btn primary" data-testid="link-start" disabled={!url.trim() || !online || starting}>
                Import
              </button>
            </div>
          </form>
        )}
        {step.kind === "job" && (
          <div data-testid="link-job" data-phase={job?.phase ?? "starting"}>
            <div className="link-job-title ellipsis" title={job?.url ?? url}>
              {job?.title ?? job?.url ?? url}
            </div>
            {job?.phase === "failed" ? (
              <p className="link-error" data-testid="link-error">
                {job.error}
              </p>
            ) : job?.phase === "cancelled" ? (
              <p className="link-text" data-testid="link-cancelled">
                Cancelled. Nothing was added.
              </p>
            ) : (
              <>
                <div className="bar link-bar">
                  <span style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }} />
                </div>
                <p className="link-text" data-testid="link-status">
                  {job?.status ?? "Starting…"}
                </p>
              </>
            )}
            <div className="confirm-actions">
              {running ? (
                <>
                  <button className="btn" data-testid="link-hide" title="Keep it going; it lands in Media" onClick={close}>
                    Hide
                  </button>
                  <button
                    className="btn"
                    data-testid="link-cancel"
                    disabled={!online || job.phase === "importing"}
                    onClick={() => void call((c) => c["link.cancel"]({ jobId: job.id }))}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="btn" data-testid="link-close" onClick={close}>
                    Close
                  </button>
                  {job && (job.phase === "failed" || job.phase === "cancelled") && (
                    <button className="btn primary" data-testid="link-again" onClick={() => setStep({ kind: "form" })}>
                      Try again
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="link-command" data-testid="link-brew">
      <code>{command}</code>
      <button
        className="icon-btn"
        data-testid="link-copy"
        title="Copy"
        aria-label="Copy the command"
        data-copied={copied || undefined}
        onClick={() => {
          void navigator.clipboard?.writeText(command).catch(() => {});
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </div>
  );
}
