// D238 (issue #65): the screen or window to record is picked in a modal, not a grid on the tab:
// screens first, then windows, a search over their names, and a refresh. A pick closes it.
import { RefreshCw, Search, X } from "lucide-react";
import React, { useEffect, useState } from "react";

import { loadSources, useRecorder } from "../../capture/recorder.ts";
import { SourceTile } from "../thisMac/controls.tsx";
import { Tooltip } from "../../ui/Tooltip.tsx";

export function SourcePicker({ picked, onPick, onClose }: { picked: string; onPick: (id: string) => void; onClose: () => void }) {
  const sources = useRecorder((s) => s.sources);
  const loading = useRecorder((s) => s.loadingSources);
  const error = useRecorder((s) => s.sourcesError);
  const [query, setQuery] = useState("");
  useEffect(() => {
    void loadSources();
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), e.preventDefault(), onClose());
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  const q = query.trim().toLowerCase();
  const shown = (sources ?? []).filter((s) => !q || s.name.toLowerCase().includes(q));
  return (
    <div className="modal-layer capture-picker-layer" data-testid="capture-source-picker" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal capture-picker" role="dialog" aria-label="Choose a screen or window">
        <div className="capture-picker-head">
          <span className="capture-picker-title">Choose a screen or window</span>
          <Tooltip label="List screens and windows again">
            <button className="icon-btn" data-testid="capture-sources-refresh" disabled={loading} onClick={() => void loadSources()}>
              <RefreshCw className={loading ? "spin" : ""} />
            </button>
          </Tooltip>
          <Tooltip label="Close">
            <button className="icon-btn" data-testid="capture-source-picker-close" onClick={onClose}>
              <X />
            </button>
          </Tooltip>
        </div>
        {(sources?.length ?? 0) > 6 && (
          <label className="capture-search">
            <Search />
            <input data-testid="capture-source-search" placeholder="Find a window" spellCheck={false} value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}
        {error && <div className="inline-error small">{error}</div>}
        <div className="capture-picker-body">
          {(["screen", "window"] as const).map((kind) => {
            const group = shown.filter((s) => s.kind === kind);
            if (!group.length) return null;
            return (
              <React.Fragment key={kind}>
                <div className="capture-sources-group small muted">{kind === "screen" ? "Screens" : "Windows"}</div>
                <div className="capture-sources" data-testid="capture-sources" data-kind={kind}>
                  {group.map((s) => (
                    <SourceTile key={s.id} source={s} active={picked === s.id} disabled={false} onPick={() => (onPick(s.id), onClose())} />
                  ))}
                </div>
              </React.Fragment>
            );
          })}
          {!sources && loading && <div className="small muted">Looking for screens and windows…</div>}
          {sources && shown.length === 0 && !loading && <div className="small muted">{q ? "Nothing by that name." : "No screens or windows to record."}</div>}
        </div>
      </div>
    </div>
  );
}
