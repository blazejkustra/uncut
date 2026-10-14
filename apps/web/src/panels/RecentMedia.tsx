// Media › Recent from other projects (issue #39, D205): captures, imports and generations from the
// user's other projects on this Mac (the server's media index), newest first, with a search. Add
// brings one into this project: copied into media/imports when it lives inside another project's
// folder, else referenced (D12); one ⌘Z takes it out.
import type { MediaRecentEntry } from "@uncut/contracts";
import { AudioLines, Film, Image as ImageIcon, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";

import { actions, recentThumbUrl, useApp, type Project } from "../state/store.ts";

const ORIGIN: Record<MediaRecentEntry["origin"], string> = { capture: "Recording", import: "Import", generated: "Generated" };

const length = (s: number | undefined) => (s === undefined ? "" : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

/** "Recording from test argent, 12 s, iPhone 16 Pro" (commas, never dots between words). */
export const recentMeta = (e: MediaRecentEntry) => [`${ORIGIN[e.origin]} from ${e.project.name}`, length(e.seconds), e.device ?? "", e.app ?? ""].filter(Boolean).join(", ");

export function RecentSection({ project }: { project: Project }) {
  const app = useApp();
  const online = app.connection === "connected";
  const [entries, setEntries] = useState<ReadonlyArray<MediaRecentEntry> | undefined>();
  const [query, setQuery] = useState("");
  const [added, setAdded] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | undefined>();
  const mediaCount = project.media.length;
  useEffect(() => {
    if (!online) return;
    let live = true;
    const timer = setTimeout(() => void actions.mediaRecent(query.trim()).then((found) => live && setEntries(found)), query ? 200 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [online, query, mediaCount]);
  if (!entries || (!entries.length && !query)) return null;
  const add = async (e: MediaRecentEntry) => {
    setBusy(e.id);
    const result = await actions.mediaRecentImport(e.id);
    setBusy(undefined);
    setAdded((a) => ({ ...a, [e.id]: result.ok ? (result.copied ? "Copied into this project" : "Added") : result.message }));
  };
  return (
    <div className="lib-section" data-testid="recent-media">
      <div className="lib-label media-bar">
        <span>Recent from other projects</span>
      </div>
      <label className="recent-search">
        <Search />
        <input className="field input" data-testid="recent-media-search" value={query} placeholder="Search other projects" onChange={(ev) => setQuery(ev.target.value)} />
      </label>
      <div className="gen-results">
        {entries.length === 0 && <div className="recent-none">Nothing matches.</div>}
        {entries.map((e) => {
          const Icon = e.kind === "audio" ? AudioLines : e.kind === "image" ? ImageIcon : Film;
          return (
            <div key={e.id} className="gen-result" data-testid="recent-media-item" data-id={e.id}>
              <div className="gen-thumb">{e.thumb ? <img src={recentThumbUrl(e.id)} alt="" draggable={false} /> : <Icon />}</div>
              <div className="gen-body">
                <div className="gen-title" title={e.path}>
                  {e.name}
                </div>
                <div className="gen-by" data-testid="recent-media-meta">
                  {recentMeta(e)}
                </div>
                <div className="gen-actions">
                  {added[e.id] ? (
                    <span className="gen-by" data-testid="recent-media-added">
                      {added[e.id]}
                    </span>
                  ) : (
                    <button className="link-btn" data-testid="recent-media-add" disabled={!online || busy === e.id} title={e.copies ? "Copy it into this project's media" : "Add it to this project's media"} onClick={() => void add(e)}>
                      <Plus />
                      Add to this project
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
