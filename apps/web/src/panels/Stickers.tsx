// The Elements tab's stickers (F22, D165): core's bundled set (drawn SVG stickers and emoji with
// keywords, no network) with a search. A click adds a sticker component with that emoji or art at
// the playhead (one edit).
import { searchStickers, STICKER_ART, stickerProps, type StickerEntry } from "@uncut/core/stickers";
import { useState } from "react";

import { actions, useApp } from "../state/store.ts";

/** How many stickers the grid shows before "More". */
const PAGE = 48;

export function StickerPicker() {
  const { connection } = useApp();
  const online = connection === "connected";
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const found = searchStickers(query);
  const shown = all ? found : found.slice(0, PAGE);
  const add = (s: StickerEntry) => void actions.addComponent("component.sticker", { props: stickerProps(s) });
  return (
    <div className="lib-section" data-testid="stickers">
      <div className="lib-label">Stickers</div>
      <input className="field input" data-testid="sticker-search" placeholder="Search stickers" value={query} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
      {shown.length ? (
        <div className="sticker-grid" data-testid="sticker-grid">
          {shown.map((s) => (
            <button key={s.key} className="sticker-btn" data-testid="sticker" data-key={s.key} title={s.name} aria-label={`Add ${s.name}`} disabled={!online} onClick={() => add(s)}>
              {s.art ? <span className="sticker-art" dangerouslySetInnerHTML={{ __html: STICKER_ART[s.art]!.svg }} /> : <span className="sticker-emoji">{s.emoji}</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="muted small" data-testid="sticker-none">
          No stickers match.
        </div>
      )}
      {!all && found.length > PAGE && (
        <button className="link-btn small" data-testid="sticker-more" onClick={() => setAll(true)}>
          More ({found.length - PAGE})
        </button>
      )}
    </div>
  );
}
