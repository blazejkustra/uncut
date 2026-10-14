// The Agent tab's composer (D140, t3code-like): a multiline box where Enter sends and ⇧Enter is a
// new line; @ opens a picker of media, items, tracks and markers that inserts an @label chip (Add to
// chat, D141, inserts the same); ↑ in an empty box brings back earlier prompts; while a turn runs the
// button is Stop and Enter queues the message for when it ends. The text and chips live in the store.
import type { AgentMention, AgentTurn } from "@uncut/contracts";
import { mentionCandidates } from "@uncut/core/mentions";
import { ArrowUp, AtSign, Film, Flag, ListVideo, MousePointer2, Music, Rows3, Square, X } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { usePlayback } from "../preview/playback.ts";
import { frameTimecode } from "../state/format.ts";
import { itemLabel } from "../state/project.ts";
import { actions, useApp, type Project } from "../state/store.ts";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text with its @labels (of `labels`) as chip spans: the composer's backdrop and the turn card's prompt. */
export function withChips(text: string, labels: ReadonlyArray<string>, className = "chip"): ReactNode {
  const unique = [...new Set(labels.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!unique.length) return text;
  const re = new RegExp(`(@(?:${unique.map(escape).join("|")}))`, "g");
  return text.split(re).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className={className} data-testid="agent-chip">
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

const KIND_ICON = { media: Film, item: ListVideo, track: Rows3, marker: Flag } as const;

export function Composer({ project, online, blocked, turns, running, provider }: { project: Project; online: boolean; blocked: boolean; turns: ReadonlyArray<AgentTurn>; running: string | null; provider: string }) {
  const { agentDraft: draft, agentMentions: mentions, agentQueued: queued, agentFocus } = useApp();
  const input = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  // The @query position the user closed the picker at (Esc), until the text changes.
  const [dismissed, setDismissed] = useState<number | undefined>(undefined);
  const history = useRef<{ at: number; saved: string }>({ at: -1, saved: "" });
  const caretTo = useRef<number | undefined>(undefined);

  // Add to chat: the caret goes to the end of the box.
  useEffect(() => {
    if (!agentFocus) return;
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    setCaret(el.value.length);
  }, [agentFocus]);
  // A caret position chosen by an edit (a picked mention, a deleted chip) once React has the new text.
  useLayoutEffect(() => {
    const at = caretTo.current;
    if (at === undefined || !input.current) return;
    caretTo.current = undefined;
    input.current.setSelectionRange(at, at);
    setCaret(at);
  }, [draft]);

  const candidates = useMemo(() => mentionCandidates(project as never), [project]);
  const before = draft.slice(0, caret);
  const query = /(?:^|\s)@([^\s@]{0,40})$/.exec(before);
  const at = query ? caret - query[1]!.length - 1 : -1;
  const matches = useMemo(() => {
    if (!query) return [];
    const q = query[1]!.toLowerCase();
    return candidates.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 8);
  }, [candidates, query?.[1]]);
  const pickerOpen = !!query && dismissed !== at && matches.length > 0 && !blocked;
  useEffect(() => setPick(0), [query?.[1]]);

  const setDraft = (text: string, next?: ReadonlyArray<AgentMention>) => {
    if (text !== draft) setDismissed(undefined);
    actions.setAgentDraft(text, next);
  };
  const choose = (c: (typeof candidates)[number]) => {
    const insert = `@${c.label} `;
    const text = draft.slice(0, at) + insert + draft.slice(caret);
    const mention: AgentMention = { kind: c.kind, id: c.id, label: c.label, ...(c.frame !== undefined ? { frame: c.frame } : {}) };
    caretTo.current = at + insert.length;
    setDraft(text, [...mentions.filter((m) => !(m.kind === c.kind && m.id === c.id && m.label === c.label)), mention]);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !online || blocked) return;
    history.current = { at: -1, saved: "" };
    if (running) {
      // One message waits for the turn to end; a second one joins it.
      actions.agentQueue({ prompt: queued ? `${queued.prompt}\n\n${text}` : text, mentions: [...(queued?.mentions ?? []), ...mentions] });
      setDraft("", []);
      return;
    }
    setDraft("", []);
    if (!(await actions.agentSend(text, mentions))) actions.setAgentDraft(text, mentions);
  };

  // Earlier prompts, newest first, for ↑ / ↓.
  const prompts = useMemo(() => [...new Set([...turns].reverse().map((t) => t.prompt))], [turns]);
  const recall = (index: number) => {
    const h = history.current;
    if (h.at === -1) h.saved = draft;
    h.at = index;
    const text = index === -1 ? h.saved : prompts[index]!;
    // The chips of a recalled prompt, found again by their labels.
    const turn = turns.find((t) => t.prompt === text);
    const again = (turn?.mentions ?? []).flatMap((m) => {
      const c = candidates.find((x) => x.kind === m.kind && x.label === m.label);
      return c ? [{ kind: c.kind, id: c.id, label: c.label }] : [];
    });
    caretTo.current = text.length;
    setDraft(text, again);
  };

  const labels = mentions.map((m) => m.label);
  return (
    <div className="composer" data-testid="composer">
      <ContextLine project={project} />
      {queued && (
        <div className="composer-queued" data-testid="agent-queued">
          <span className="ellipsis">Queued: {queued.prompt}</span>
          <button className="icon-btn" title="Don't send it" data-testid="agent-unqueue" onClick={() => actions.agentQueue(undefined)}>
            <X />
          </button>
        </div>
      )}
      {pickerOpen && (
        <div className="mention-picker" role="listbox" data-testid="mention-picker">
          {matches.map((c, i) => {
            const Icon = c.kind === "media" && c.detail === "Sound" ? Music : KIND_ICON[c.kind];
            return (
              <button
                key={`${c.kind}:${c.id}`}
                role="option"
                aria-selected={i === pick}
                className={`mention-option ${i === pick ? "active" : ""}`}
                data-testid="mention-option"
                data-kind={c.kind}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(c);
                }}
                onMouseEnter={() => setPick(i)}
              >
                <Icon />
                <span className="ellipsis grow">{c.label}</span>
                <span className="mention-detail">{c.detail}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="composer-box">
        <div className="composer-hl" ref={backdrop} aria-hidden="true">
          {withChips(draft, labels)}
          {"​"}
        </div>
        <textarea
          ref={input}
          id="agent-input"
          data-testid="agent-input"
          rows={3}
          value={draft}
          spellCheck={false}
          disabled={!online || blocked}
          placeholder={blocked ? "Set up Claude Code to use the agent" : running ? "Write the next message; it's sent when this turn ends" : "Ask for an edit; @ to point at media or a clip"}
          onChange={(e) => {
            history.current.at = -1;
            setCaret(e.target.selectionStart);
            setDraft(e.target.value);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onScroll={(e) => backdrop.current && (backdrop.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            const el = e.currentTarget;
            if (pickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setPick((p) => (p + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                choose(matches[pick]!);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissed(at);
                return;
              }
            }
            // A chip goes whole with one Backspace.
            if (e.key === "Backspace" && el.selectionStart === el.selectionEnd) {
              const head = draft.slice(0, el.selectionStart);
              const chip = labels.filter((l) => head.endsWith(`@${l}`)).sort((a, b) => b.length - a.length)[0];
              if (chip) {
                e.preventDefault();
                const from = el.selectionStart - chip.length - 1;
                caretTo.current = from;
                setDraft(draft.slice(0, from) + draft.slice(el.selectionStart));
                return;
              }
            }
            // ↑ in an empty box (or at its start) brings back the last prompt; ↓ goes forward again.
            if (e.key === "ArrowUp" && !e.shiftKey && prompts.length && el.selectionStart === 0 && el.selectionEnd === 0 && (draft === "" || history.current.at >= 0)) {
              e.preventDefault();
              recall(Math.min(prompts.length - 1, history.current.at + 1));
              return;
            }
            if (e.key === "ArrowDown" && history.current.at >= 0 && el.selectionStart === draft.length) {
              e.preventDefault();
              recall(history.current.at - 1);
              return;
            }
            // Enter sends (or queues while a turn runs), ⇧Enter is a new line.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
      </div>
      <div className="composer-foot">
        <button
          className="icon-btn composer-at"
          title="Point at media, a clip, a track or a marker"
          data-testid="agent-at"
          disabled={!online || blocked}
          onClick={() => {
            const el = input.current;
            if (!el) return;
            const pos = el.selectionStart;
            const pad = pos > 0 && !/\s/.test(draft[pos - 1]!) ? " @" : "@";
            caretTo.current = pos + pad.length;
            setDraft(draft.slice(0, pos) + pad + draft.slice(pos));
            el.focus();
          }}
        >
          <AtSign />
        </button>
        <span className="composer-who">{provider}, your subscription</span>
        {running ? (
          <button className="send stop" data-testid="agent-stop" title="Stop" disabled={!online} onClick={() => void actions.agentCancel()}>
            <Square />
          </button>
        ) : (
          <button className="send" data-testid="agent-send" title="Send (Enter)" disabled={!draft.trim() || !online || blocked} onClick={() => void send()}>
            <ArrowUp />
          </button>
        )}
      </div>
    </div>
  );
}

/** What the agent is told about where you are: the playhead and the selected item. */
function ContextLine({ project }: { project: Project }) {
  const frame = usePlayback((s) => Math.floor(s.frame));
  const selected = usePlayback((s) => s.selected);
  const item = selected ? project.tracks.flatMap((t) => t.items).find((i) => i.id === selected) : undefined;
  return (
    <div className="composer-ctx" data-testid="agent-context">
      <MousePointer2 />
      <span className="ellipsis">
        Playhead {frameTimecode(frame, project.canvas.fps)}
        {item ? `, selected ${itemLabel(project, item)}` : ""}
      </span>
    </div>
  );
}
