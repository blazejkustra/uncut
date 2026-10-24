// The Elements tab's stickers (F22, D165; sections in D251): core's bundled set (drawn SVG stickers
// and emoji with keywords, no network). Without a search they're in sections (Reactions, Arrows &
// marks, Shapes & bursts, Bubbles, Badges, Social, Emoji); with one, the matches in one grid. A
// click adds a sticker component with that emoji or art at the playhead (one edit); a drag drops it
// where it's let go, on the canvas or the timeline.
import { searchStickers, STICKER_ART, STICKER_GROUPS, STICKERS, stickerArt, stickerProps, type StickerEntry } from "@uncut/core/stickers";
import { useState } from "react";

import { actions, useApp } from "../state/store.ts";
import { clearDraggedComponentProps, COMPONENT_DRAG_TYPE, setDraggedComponent } from "../preview/components.ts";
import { setDragChip } from "./dragChip.ts";

/** How many stickers a long list (the emoji, a search) shows before "More". */
const PAGE = 48;
const STICKER = "component.sticker";

function StickerButton({ s, online }: { s: StickerEntry; online: boolean }) {
  const art = s.art ? stickerArt(s.art) : undefined;
  const add = () => void actions.addComponent(STICKER, { props: stickerProps(s) });
  return (
    <button
      className={`sticker-btn ${art?.mark ? "mark" : ""}`}
      data-testid="sticker"
      data-key={s.key}
      title={s.name}
      aria-label={`Add ${s.name}`}
      disabled={!online}
      draggable={online}
      onClick={(e) => {
        e.currentTarget.blur();
        add();
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData(COMPONENT_DRAG_TYPE, STICKER);
        e.dataTransfer.effectAllowed = "copy";
        setDragChip(e, s.name);
        setDraggedComponent(STICKER, stickerProps(s));
      }}
      onDragEnd={() => {
        setDraggedComponent(undefined);
        clearDraggedComponentProps();
      }}
    >
      {s.art ? (
        <span
          className="sticker-art"
          style={art?.size ? { aspectRatio: `${art.size[0]} / ${art.size[1]}` } : undefined}
          dangerouslySetInnerHTML={{ __html: STICKER_ART[s.art]!.svg }}
        />
      ) : (
        <span className="sticker-emoji">{s.emoji}</span>
      )}
    </button>
  );
}

/** A grid of stickers, the first PAGE of a long one with "More". */
function StickerGrid({ list, online, testId = "sticker-grid", more }: { list: ReadonlyArray<StickerEntry>; online: boolean; testId?: string; more: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, PAGE);
  return (
    <>
      <div className="sticker-grid" data-testid={testId}>
        {shown.map((s) => (
          <StickerButton key={s.key} s={s} online={online} />
        ))}
      </div>
      {!all && list.length > PAGE && (
        <button className="link-btn small" data-testid="sticker-more" data-more={more} onClick={() => setAll(true)}>
          More ({list.length - PAGE})
        </button>
      )}
    </>
  );
}

/** The stickers for the Elements tab's search (empty: every section). */
export function StickerPicker({ query }: { query: string }) {
  const { connection } = useApp();
  const online = connection === "connected";
  if (query.trim()) {
    const found = searchStickers(query);
    return found.length ? (
      <StickerGrid key={query} list={found} online={online} more="search" />
    ) : (
      <div className="muted small" data-testid="sticker-none">
        No stickers match.
      </div>
    );
  }
  return (
    <>
      {STICKER_GROUPS.map((g) => {
        const list = STICKERS.filter((s) => s.group === g);
        return (
          <div key={g} className="sticker-group" data-testid="sticker-group" data-group={g}>
            <div className="sticker-group-label">{g}</div>
            <StickerGrid list={list} online={online} more={g} />
          </div>
        );
      })}
    </>
  );
}
