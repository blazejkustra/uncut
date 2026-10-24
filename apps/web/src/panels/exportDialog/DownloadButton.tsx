import type { ExportJob } from "@uncut/contracts";
import { FolderOpen, Download } from "lucide-react";
import { actions } from "../../state/store.ts";
import { baseName } from "./format.ts";

/** D109: a remote export's Download, then where it went (with Finder, since that's on this Mac). */
export function DownloadButton({
  job,
  state,
}: {
  job: ExportJob;
  state: { readonly state: "running" } | { readonly path: string } | { readonly error: string } | undefined;
}) {
  if (state && "path" in state) {
    return (
      <>
        <span className="muted small ellipsis" data-testid="export-downloaded" title={state.path}>
          Downloaded to {baseName(state.path)}
        </span>
        <button className="btn" data-testid="export-reveal-download" onClick={() => void actions.revealLocal(state.path)}>
          <FolderOpen />
          Show in Finder
        </button>
      </>
    );
  }
  return (
    <>
      {state && "error" in state && (
        <span className="inline-error small" data-testid="export-download-error">
          {state.error}
        </span>
      )}
      <button className="btn" data-testid="export-download" disabled={state !== undefined && "state" in state} onClick={() => void actions.downloadExport(job)}>
        <Download />
        {state && "state" in state ? "Downloading…" : "Download…"}
      </button>
    </>
  );
}
