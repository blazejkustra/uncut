// The text's content (split out of inspector/text.tsx, D129): typed with the preview drafting at
// once, saved after a pause, on blur or ⌘Enter; Esc puts the saved text back; Accent wraps the
// selection in [[ ]]. A burst is planned against the revision it started at (D6).
import type { Item } from "@uncut/core/types";
import { Highlighter } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { findItem } from "../../timeline/edit.ts";
import { type PreviewDraft } from "../../preview/playback.ts";
import { type ProjectModel } from "../../state/project.ts";
import { actions, getState, projectOf } from "../../state/store.ts";
import { planText, toggleAccent } from "../../preview/text.ts";
import { TYPING_PAUSE_MS, showDraft, dropDraft, origin } from "../fields.tsx";

export function TextContent({ project, item, disabled }: { project: ProjectModel; item: Item; disabled: boolean }) {
  const saved = item.text ?? "";
  const [value, setValue] = useState(saved);
  const ref = useRef<HTMLTextAreaElement>(null);
  // The revision the text field shows: set when it last matched the saved text (mount, a change
  // to the item while nothing was pending, a finished save). A burst is planned against it, so an
  // agent edit the user hadn't seen yet makes the save conflict instead of being overwritten.
  const base = useRef(origin());
  // Typed but not saved yet.
  const dirty = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draft = useRef<PreviewDraft | undefined>(undefined);
  const latest = useRef({ value, saved, id: item.id });
  latest.current = { value, saved, id: item.id };

  /** Show the saved text again and take the current revision as the new base. */
  const resync = (text: string) => {
    base.current = origin();
    latest.current = { ...latest.current, value: text };
    if (mounted.current) setValue(text);
  };
  // A change to the item from anywhere (the agent, undo, a save) shows up unless typing is pending.
  useEffect(() => {
    if (!dirty.current) resync(item.text ?? "");
  }, [item]);

  const commit = () => {
    clearTimeout(timer.current);
    const { value: text, saved: was, id } = latest.current;
    const from = base.current;
    const d = draft.current;
    draft.current = undefined;
    const pending = dirty.current;
    dirty.current = false;
    if (!pending || text === was) return dropDraft(d);
    void actions.itemEdit((p) => planText(p, id, text), from).finally(() => {
      dropDraft(d);
      // Saved or refused (a conflict shows in the banner): show what's saved now, unless the user
      // has typed on meanwhile.
      if (dirty.current) return;
      const snapshot = getState().snapshot;
      const now = snapshot ? findItem(projectOf(snapshot), id)?.item.text : undefined;
      if (now !== undefined) resync(now);
    });
  };
  // Leaving the item (another selection, the Inspector closing) saves what was typed.
  useEffect(
    () => () => {
      commit();
      mounted.current = false;
    },
    [],
  );

  const change = (text: string) => {
    setValue(text);
    latest.current = { ...latest.current, value: text };
    dirty.current = true;
    draft.current = showDraft(project, planText(project, item.id, text)) ?? draft.current;
    clearTimeout(timer.current);
    timer.current = setTimeout(commit, TYPING_PAUSE_MS);
  };

  const accent = () => {
    const el = ref.current;
    if (!el) return;
    const next = toggleAccent(value, el.selectionStart, el.selectionEnd);
    if (next.text === value) return;
    change(next.text);
    commit();
    requestAnimationFrame(() => el.setSelectionRange(next.from, next.to));
  };

  return (
    <div className="group">
      <div className="group-label row">
        <span>Text</span>
        <button className="btn ghost small-btn" data-testid="insp-accent" title="Accent the selected words ([[ ]] in the text)" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={accent}>
          <Highlighter />
          Accent
        </button>
      </div>
      <textarea
        ref={ref}
        className="field input text-area"
        data-testid="insp-text"
        value={value}
        rows={3}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => change(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey) {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            clearTimeout(timer.current);
            dirty.current = false;
            dropDraft(draft.current);
            draft.current = undefined;
            resync(saved);
            const el = e.currentTarget;
            requestAnimationFrame(() => el.blur());
          }
        }}
      />
    </div>
  );
}
