// The Inspector's captions editor (D82): mode, lines, word fixes, then Style.
import type { Item } from "@uncut/core/types";
import { useEffect, useRef, useState } from "react";

import { frameTimecode } from "../state/format.ts";
import { playback, usePlayback } from "../preview/playback.ts";
import { type ProjectModel } from "../state/project.ts";
import {
  autoMaxChars,
  CAPTION_MODE_NAMES,
  CAPTION_MODES,
  captionCardAt,
  captionCards,
  captionSettings,
  captionsCoverMain,
  captionWordText,
  planCaptionEdit,
  type CaptionEdit,
} from "@uncut/core/captions";
import { TextStyleTab } from "./text.tsx";
import { CaptionStyleGallery } from "./captionStyles.tsx";
import { send, NumberField, Tabs, Group } from "./fields.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";

export function CaptionsEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const [tab, setTab] = useState<"captions" | "style">("captions");
  return (
    <div data-testid="captions-editor">
      <div className="group tabs-group">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            ["captions", "Captions"],
            ["style", "Style"],
          ]}
        />
      </div>
      {tab === "captions" ? (
        <CaptionsTab project={project} item={item} disabled={locked} />
      ) : (
        <>
          <CaptionStyleGallery project={project} item={item} disabled={locked} />
          <TextStyleTab project={project} item={item} disabled={locked} />
        </>
      )}
    </div>
  );
}

/** The modes' names in the Inspector's narrow column. */
const CAPTION_SHORT = { line: "Lines", word: "Word by word", single: "One word" } as const;

function CaptionsTab({ project, item, disabled }: { project: ProjectModel; item: Item; disabled: boolean }) {
  const edit = (change: CaptionEdit) => send((p) => planCaptionEdit(p, item.id, change));
  const mode = item.mode === "word" || item.mode === "single" ? item.mode : "line";
  const s = captionSettings(item, project);
  const cards = captionCards(project, item);
  const n = usePlayback((st) => captionCardAt(project, item, st.frame)?.n ?? -1);
  const card = n >= 0 ? cards[n] : undefined;
  const fps = project.canvas.fps;
  const listRef = useRef<HTMLDivElement>(null);
  // Words hidden by a fix (""): always reachable here, also when a whole card is hidden.
  const hidden = (item.edits ?? []).filter((e) => e.text.trim() === "").map((e) => e.word);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-current]")?.scrollIntoView({ block: "nearest" });
  }, [n]);
  return (
    <>
      <Group label="Show">
        <div className="seg" role="group">
          {CAPTION_MODES.map((m) => (
            <button
              key={m}
              className={mode === m ? "active" : ""}
              data-testid={`cap-mode-${m}`}
              disabled={disabled}
              title={CAPTION_MODE_NAMES[m]}
              onClick={() => edit({ mode: m })}
            >
              {CAPTION_SHORT[m]}
            </button>
          ))}
        </div>
      </Group>
      <Group label="Cards">
        <div className="seg" role="group">
          {[1, 2].map((k) => (
            <button
              key={k}
              className={s.maxLines === k ? "active" : ""}
              data-testid={`cap-lines-${k}`}
              disabled={disabled}
              onClick={() => edit({ lines: { maxLines: k } })}
            >
              {k === 1 ? "1 line" : "2 lines"}
            </button>
          ))}
        </div>
        <div className="field-row">
          <NumberField
            label="Characters"
            testId="cap-chars"
            value={item.lines?.maxChars}
            placeholder={`${autoMaxChars(item, project)}`}
            min={4}
            max={200}
            disabled={disabled}
            onCommit={(v) => edit({ lines: { maxChars: v === undefined ? null : Math.round(v) } })}
          />
          <NumberField
            label="Seconds"
            testId="cap-seconds"
            value={s.maxSeconds}
            step={0.5}
            min={0.5}
            max={30}
            disabled={disabled}
            onCommit={(v) => edit({ lines: { maxSeconds: v ?? null } })}
          />
          <NumberField
            label="Pause"
            testId="cap-pause"
            value={s.pause}
            step={0.1}
            min={0}
            max={10}
            disabled={disabled}
            onCommit={(v) => edit({ lines: { pause: v ?? null } })}
          />
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            data-testid="cap-fillers"
            checked={item.hideFillers === true}
            disabled={disabled}
            onChange={(e) => edit({ hideFillers: e.target.checked })}
          />
          Hide fillers (um, uh)
        </label>
        {!captionsCoverMain(project, item) && (
          <div className="hint small">
            <span className="muted">The edit is longer than these captions. </span>
            <button className="link-btn small" data-testid="cap-cover" disabled={disabled} onClick={() => edit({ cover: true })}>
              Cover the whole edit
            </button>
          </div>
        )}
      </Group>
      <Group label={card ? `Card at ${frameTimecode(card.from, fps)}` : "Card at the playhead"}>
        {card ? (
          <div className="cap-words" data-testid="cap-card" data-from={card.from}>
            {cardIndices(card).map((index, i) => {
              const text = captionWordText(item, index);
              const original = (item.words?.[index]?.text ?? "").trim();
              const shown = card.words.some((w) => w.index === index);
              if (!shown && text !== "") return null;
              return (
                <span key={index} className="cap-word">
                  {i > 0 && shown && (
                    <Tooltip label="Start a new card at this word">
                      <button
                        className={`cap-break ${(item.breaks ?? []).includes(index) ? "on" : ""}`}
                        data-testid="cap-break"
                        data-index={index}
                        disabled={disabled}
                        onClick={() => edit({ breaks: [{ index, on: true }] })}
                      >
                        ↵
                      </button>
                    </Tooltip>
                  )}
                  {i === 0 && (item.breaks ?? []).includes(index) && (
                    <Tooltip label="Join this card to the one before">
                      <button
                        className="cap-break on"
                        data-testid="cap-join"
                        data-index={index}
                        disabled={disabled}
                        onClick={() => edit({ breaks: [{ index, on: false }] })}
                      >
                        ↵
                      </button>
                    </Tooltip>
                  )}
                  {shown ? (
                    <CaptionWord
                      key={`${index}:${text}`}
                      index={index}
                      value={text}
                      original={original}
                      disabled={disabled}
                      onCommit={(t) => edit({ words: [{ index, text: t }] })}
                    />
                  ) : (
                    <button
                      className="cap-hidden"
                      data-testid="cap-restore"
                      data-index={index}
                      disabled={disabled}
                      title={`Hidden: click to show "${original}" again`}
                      onClick={() => edit({ words: [{ index, text: null }] })}
                    >
                      {original}
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        ) : (
          <div className="muted small" data-testid="cap-no-card">
            {cards.length ? "No caption under the playhead. Pick a card below to edit its words." : "No speech of this media plays on the main track."}
          </div>
        )}
        <div className="muted small">Type over a word to fix it; empty hides it (click a struck-out word to show it again).</div>
      </Group>
      {hidden.length > 0 && (
        <Group label={`Hidden words (${hidden.length})`}>
          <div className="cap-words" data-testid="cap-hidden-list">
            {hidden.map((index) => (
              <button
                key={index}
                className="cap-hidden"
                data-testid="cap-restore"
                data-index={index}
                disabled={disabled}
                title="Show it again"
                onClick={() => edit({ words: [{ index, text: null }] })}
              >
                {(item.words?.[index]?.text ?? "").trim()}
              </button>
            ))}
          </div>
        </Group>
      )}
      <Group label={`All cards (${cards.length})`}>
        <div className="cap-list" ref={listRef}>
          {cards.map((c, k) => (
            <button
              key={`${c.from}-${c.words[0]!.index}`}
              className="cap-row"
              data-testid="cap-card-row"
              data-from={c.from}
              data-current={k === n ? "true" : undefined}
              onClick={() => playback.seek(c.from)}
            >
              <span className="mono small muted">{frameTimecode(c.from, fps)}</span>
              <span className="ellipsis">{c.words.map((w) => w.text).join(" ")}</span>
            </button>
          ))}
        </div>
      </Group>
    </>
  );
}

/** Every word index from a card's first to its last, hidden ones included. */
const cardIndices = (card: { readonly words: ReadonlyArray<{ readonly index: number }> }) => {
  const a = card.words[0]!.index;
  const b = card.words.at(-1)!.index;
  return Array.from({ length: b - a + 1 }, (_, k) => a + k);
};

/** One caption word: typed over, committed on Enter, blur or unmount (playback moving on mid-typing); Esc puts it back; empty hides it. */
function CaptionWord({
  index,
  value,
  original,
  disabled,
  onCommit,
}: {
  index: number;
  value: string;
  original: string;
  disabled: boolean;
  onCommit: (text: string | null) => void;
}) {
  const [text, setText] = useState(value);
  const latest = useRef({ text, value, original, onCommit, done: false });
  latest.current = { ...latest.current, text, value, original, onCommit };
  const commit = () => {
    const l = latest.current;
    const next = l.text.replace(/\s+/g, " ").trim();
    if (next === l.value) return;
    l.done = true;
    l.onCommit(next === l.original ? null : next);
  };
  useEffect(() => () => void (!latest.current.done && commit()), []);
  return (
    <input
      className={`cap-input ${value !== original ? "edited" : ""}`}
      data-testid="cap-word"
      data-index={index}
      value={text}
      placeholder={original}
      title={value !== original ? `Fixed (the transcript says "${original}")` : `w${index}`}
      size={Math.max(2, text.length || original.length)}
      spellCheck={false}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setText(value);
          latest.current.text = value;
          const el = e.currentTarget;
          requestAnimationFrame(() => el.blur());
        }
      }}
    />
  );
}

/** A background (component.solid): its colour, or a gradient between two. */
