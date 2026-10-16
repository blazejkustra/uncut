// Auto-update's toast (issue #102, D276), bottom right over every screen (welcome and editor).
// "Uncut X is ready" with Restart to update / Later once an update has downloaded, shown only
// while no export, recording or agent turn runs. After Uncut › Check for Updates… also
// "Checking for updates…", the download's progress and "You're up to date". A failed check shows
// nothing (the shell logs it).
import { Download, X } from "lucide-react";
import { useEffect } from "react";

import { dismissUpdate, restartToUpdate, startUpdates, useUpdates } from "../state/updates.ts";
import { Tooltip } from "./Tooltip.tsx";
import "./update.css";

/** How long "You're up to date" stays. */
const UP_TO_DATE_MS = 4000;

export function UpdateToast() {
  useEffect(startUpdates, []);
  const { status, busy, dismissed, refused } = useUpdates();
  const closed = dismissed === status;
  useEffect(() => {
    if (status.kind !== "none" || !status.manual || closed) return;
    const t = setTimeout(dismissUpdate, UP_TO_DATE_MS);
    return () => clearTimeout(t);
  }, [status, closed]);

  let body: React.ReactNode = null;
  if (closed) body = null;
  else if (status.kind === "downloaded" && !busy)
    body = (
      <>
        <Download />
        <span className="banner-text">
          <strong>Uncut {status.version} is ready</strong>
          <span className="update-sub" data-testid="update-sub">{refused === "busy" ? "Something started meanwhile. Restart once it's done." : refused === "not-ready" ? "Couldn't prepare the update. Download it from GitHub instead." : "Restart to update now, or it installs when you quit."}</span>
        </span>
        <button className="btn primary" data-testid="update-restart" onClick={() => void restartToUpdate()}>
          Restart to update
        </button>
        <button className="btn ghost" data-testid="update-later" onClick={dismissUpdate}>
          Later
        </button>
      </>
    );
  else if (status.kind === "checking" && status.manual) body = <span className="banner-text">Checking for updates…</span>;
  else if (status.kind === "none" && status.manual) body = <span className="banner-text">You're up to date (Uncut {status.version}).</span>;
  else if (status.kind === "downloading" && status.manual)
    body = (
      <span className="banner-text">
        Downloading Uncut {status.version}… {status.percent}%
        <span className="update-progress" style={{ width: `${status.percent}%` }} />
      </span>
    );
  if (!body) return null;
  return (
    <div className="update-toasts">
      <div className="banner toast update-toast" data-testid="update-toast" data-kind={status.kind}>
        {body}
        {status.kind !== "downloaded" && (
          <Tooltip label="Dismiss">
            <button className="icon-btn" data-testid="update-dismiss" onClick={dismissUpdate}>
              <X />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
