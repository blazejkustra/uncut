// The Audio and Sound effects tabs (D33, D54, D91, D134): the project's sounds, the online library
// (Openverse without a key, Freesound with the user's key: CC0 and CC BY only) and the bundled CC0
// files (the music of D91 and the sound-effects pack), and Copy credits for what needs it (D135).
import { creditsOf, creditsText } from "@uncut/core/library";
import { AudioLines, Check, Copy, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";

import { bridge } from "../state/bridge.ts";
import { timecode } from "../state/format.ts";
import { actions, activeJobs, useApp, type Project } from "../state/store.ts";
import { SoundBrowser } from "./audio/SoundBrowser.tsx";

/**
 * The Audio tab (D33, D54): the project's sound files (music, voiceover, effects) with + to put one
 * on the first audio track, at the playhead if it's free there, else after the last sound (a track
 * is made if there is none), then the music library (D134): online and the bundled tracks (D91).
 */
export function AudioLibrary({ project }: { project: Project }) {
  const app = useApp();
  const online = app.connection === "connected";
  const importing = activeJobs(app).length > 0;
  const fps = project.canvas.fps;
  const sounds = project.media.filter((m) => m.kind === "audio");
  return (
    <aside className="library" data-testid="audio-library">
      <div className="lib-head">
        Audio
        <span className="lib-head-actions">
          <CopyCredits project={project} />
          <button className="icon-btn" data-testid="audio-import" disabled={!online} title="Import music or sound" onClick={() => void actions.importMedia()}>
            {importing ? <RefreshCw className="spin" /> : <Plus />}
          </button>
        </span>
      </div>
      <div className="lib-section">
        <div className="lib-label">In this project</div>
        {sounds.length === 0 ? (
          <div className="muted small" data-testid="audio-empty">
            No music or sound yet
          </div>
        ) : (
          <div data-testid="audio-list">
            {sounds.map((m) => (
              <div key={m.id} className="audio-row" data-testid="audio-row" data-id={m.id} title={m.path}>
                <AudioLines />
                <span className="audio-name">{m.name}</span>
                {m.probe?.frames !== undefined && <span className="audio-dur">{timecode(m.probe.frames, fps).replace(/^00:/, "")}</span>}
                <button
                  className="icon-btn"
                  data-testid="audio-add"
                  disabled={!online}
                  title="Add to the audio track at the playhead (or after the last sound)"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    void actions.addMedia(m.id);
                  }}
                >
                  <Plus />
                </button>
              </div>
            ))}
          </div>
        )}
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
