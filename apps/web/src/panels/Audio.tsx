// The Audio and Sound effects tabs (D33, D54, D134, D249, D250): the online library (Openverse
// without a key, Jamendo and Freesound with the user's key: CC0 and CC BY only), the user's folders
// and Music library, the bundled CC0 sound-effects pack, and Copy credits for what needs it (D135).
import { creditsOf, creditsText } from "@uncut/core/library";
import { Check, Copy, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";

import { bridge } from "../state/bridge.ts";
import { actions, activeJobs, useApp, type Project } from "../state/store.ts";
import { SoundBrowser } from "./audio/SoundBrowser.tsx";

/**
 * The Audio tab (D33, D54, D249): music to put under the video, from the user's folders, the Music
 * app's library, Jamendo or Openverse (one search field and a source select). The project's own
 * sounds live in Media; + imports a file there.
 */
export function AudioLibrary({ project }: { project: Project }) {
  const app = useApp();
  const online = app.connection === "connected";
  const importing = activeJobs(app).length > 0;
  return (
    <aside className="library" data-testid="audio-library">
      <div className="lib-head">
        Audio
        <span className="lib-head-actions">
          <CopyCredits project={project} />
          <button className="icon-btn" data-testid="audio-import" disabled={!online} title="Import music into the project (it shows in Media)" onClick={() => void actions.importMedia()}>
            {importing ? <RefreshCw className="spin" /> : <Plus />}
          </button>
        </span>
      </div>
      <SoundBrowser kind="music" project={project} online={online} />
    </aside>
  );
}

/** The Sound effects tab (D134): the online library's sound effects by category, and the bundled pack. */
export function SfxLibrary({ project }: { project: Project }) {
  const online = useApp().connection === "connected";
  return (
    <aside className="library" data-testid="sfx-library">
      <div className="lib-head">
        Sound effects
        <span className="lib-head-actions">
          <CopyCredits project={project} />
        </span>
      </div>
      <SoundBrowser kind="sfx" project={project} online={online} />
    </aside>
  );
}

/** Copies the project's credits (D135: CC BY attributions, then the CC0 sounds) for the video's description. */
function CopyCredits({ project }: { project: Project }) {
  const [copied, setCopied] = useState(false);
  const credits = creditsOf(project);
  const count = credits.attribution.length + credits.publicDomain.length;
  if (!count) return null;
  return (
    <button
      className={`icon-btn${copied ? " done" : ""}`}
      data-testid="copy-credits"
      data-attribution={credits.attribution.length}
      title={credits.attribution.length ? `Copy credits (${credits.attribution.length} need${credits.attribution.length === 1 ? "s" : ""} attribution)` : "Copy credits"}
      onClick={async (e) => {
        e.currentTarget.blur();
        await bridge.copyText(creditsText(project));
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />}
    </button>
  );
}
