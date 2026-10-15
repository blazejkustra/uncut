// The editor's keyboard shortcuts (G3, D118). One table (SHORTCUTS) is what the Keyboard
// shortcuts sheet and Settings show; useEditorKeys is what they do. They never fire while a text
// field, a list or a slider has focus, or while a dialog is open. ⌘Z/⇧⌘Z and the menu's keys
// (⌘N, ⌘O, ⌘E, ⌘W, ⌘,) live in the store.
import { useEffect } from "react";

import { cutSelectedWords } from "../panels/Transcript.tsx";
import { getTranscripts, transcriptStore } from "../panels/transcript.ts";
import { getPlayback, playback } from "../preview/playback.ts";
import { actions, getState, isTextEntry, projectOf } from "../state/store.ts";
import { installFocusRules, isTyping } from "./focus.ts";
import { copyItems, nextEditPoint, planDeleteMany, planPaste, type Clip } from "../timeline/clipboard.ts";
import { nearbyKey } from "../timeline/clip.ts";
import { findItem, withGroups } from "../timeline/edit.ts";
import { toolForKey, toolKeys } from "../timeline/tools.ts";

export interface Shortcut {
  readonly keys: ReadonlyArray<string>;
  readonly does: string;
  readonly group: "Playback" | "Edit" | "Timeline" | "App";
}

export const SHORTCUTS: ReadonlyArray<Shortcut> = [
  { group: "Playback", keys: ["Space"], does: "Play or pause" },
  { group: "Playback", keys: ["J", "K", "L"], does: "Play backwards, pause, play forwards (press again to go faster)" },
  { group: "Playback", keys: ["←", "→"], does: "One frame back or forward" },
  { group: "Playback", keys: ["⇧←", "⇧→"], does: "One second back or forward" },
  { group: "Playback", keys: ["Home", "End"], does: "Go to the start or the end" },
  { group: "Playback", keys: ["↑", "↓"], does: "Previous or next edit" },
  { group: "Playback", keys: ["[", "]"], does: "Previous or next keyframe (of the selection, else of any item)" },
  { group: "Playback", keys: ["I", "O"], does: "Mark in or out at the playhead" },
  { group: "Edit", keys: ["S", "⌘B"], does: "Split at the playhead" },
  { group: "Edit", keys: ["⌫", "Delete"], does: "Delete the selection" },
  { group: "Edit", keys: ["⇧⌫", "⇧Delete"], does: "Ripple delete: delete and close the gap" },
  { group: "Edit", keys: ["⌘A"], does: "Select everything on the timeline" },
  { group: "Edit", keys: ["⌘C", "⌘X", "⌘V"], does: "Copy, cut, paste at the playhead" },
  { group: "Edit", keys: ["⌘D"], does: "Duplicate the selection" },
  { group: "Edit", keys: ["⌘Z", "⇧⌘Z"], does: "Undo, redo" },
  { group: "Edit", keys: ["Esc"], does: "Deselect" },
  { group: "Timeline", keys: ["+", "−"], does: "Zoom the timeline in or out (also ⌘= and ⌘−)" },
  { group: "Timeline", keys: ["⌘0"], does: "Fit the project in the timeline" },
  { group: "Timeline", keys: ["V", "C", "H"], does: "Select, Blade (a click cuts there) or Hand tool; held down, only until you let go" },
  { group: "Timeline", keys: ["⌘ scroll", "Pinch"], does: "Zoom the timeline around the pointer" },
  { group: "Timeline", keys: ["⇧ scroll"], does: "Scroll the timeline sideways" },
  { group: "Timeline", keys: ["⇧ click", "⌘ click"], does: "Select a range, add or remove one item" },
  { group: "App", keys: ["⌘E"], does: "Export" },
  { group: "App", keys: ["⌘,"], does: "Settings" },
  { group: "App", keys: ["?"], does: "Keyboard shortcuts" },
  { group: "App", keys: ["⌘W"], does: "Close the project" },
];

// Keys belong to the control while typing, picking from a list or moving a slider.
export const isEditable = (el: EventTarget | null) => isTextEntry(el) || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && el.type === "range");

// ⌘C keeps the items here (not on the system clipboard: they're project data, not text).
let clipboard: ReadonlyArray<Clip> = [];
export const clipboardItems = () => clipboard;

const selection = () => {
  const { selected, also } = getPlayback();
  return selected === undefined ? [] : [selected, ...also];
};

/** ⌘C: copy the selection; false when nothing copyable is selected. */
export function copySelection(): boolean {
  const snapshot = getState().snapshot;
  if (!snapshot) return false;
  const copied = copyItems(projectOf(snapshot), selection());
  if (!copied.length) return false;
  clipboard = copied;
  return true;
}

/** ⌘V: paste what was copied at the playhead; the pasted items end up selected. */
export async function paste(at = getPlayback().frame) {
  const snapshot = getState().snapshot;
  if (!snapshot) return;
  const plan = planPaste(projectOf(snapshot), clipboard, at);
  if (await actions.timelineEdit(plan)) playback.selectMany("ids" in plan ? plan.ids : []);
}

/** ⌫ / ⌘X: delete the selection (several items in one edit). */
export async function deleteSelection() {
  const snapshot = getState().snapshot;
  // D157: a group goes as a whole.
  const ids = snapshot ? withGroups(projectOf(snapshot), selection()) : selection();
  if (ids.length > 1 && snapshot) {
    if (await actions.timelineEdit(planDeleteMany(projectOf(snapshot), ids))) playback.select(undefined);
  } else await actions.deleteSelected();
}

/** ⌘D: a copy of the selection right after it (on main: after the clip; elsewhere: where it ends). */
export async function duplicate() {
  const snapshot = getState().snapshot;
  const project = snapshot && projectOf(snapshot);
  const ids = selection();
  if (!project || !ids.length) return;
  const placed = ids.map((id) => findItem(project, id)).filter((p) => p !== undefined);
  const copied = copyItems(project, ids);
  if (!copied.length) return;
  const end = Math.max(...placed.map((p) => p.start + p.item.duration));
  const plan = planPaste(project, copied, end);
  if (await actions.timelineEdit(plan)) playback.selectMany("ids" in plan ? plan.ids : []);
}

// Issue #49: the Agent tab's conversation is text to read and copy; a selection in it beats the
// timeline's ⌘C / ⌘X (which would otherwise preventDefault and keep the menu's Copy from running).
const inAgentThread = (node: Node | null) => (node instanceof Element ? node : (node?.parentElement ?? null))?.closest("[data-testid=agent-thread]") != null;
export function agentTextSelected(): boolean {
  const sel = document.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().trim() !== "" && inAgentThread(sel.anchorNode);
}

const SHIFT_KEYS = new Set(["ArrowLeft", "ArrowRight", "?", "+", "Backspace", "Delete"]);

export function useEditorKeys(fps: number) {
  useEffect(() => {
    const s = () => getState();
    const uninstall = installFocusRules();
    const dialog = () => s().newProjectOpen || s().setupOpen || s().exportOpen || s().settingsOpen || s().shortcutsOpen;
    // #48: Space plays unless a text field is really being typed in (editor/focus.ts); a list, a
    // slider or a field focused for the user doesn't take it.
    const space = (e: KeyboardEvent) => e.code === "Space" && !e.metaKey && !e.altKey && !e.ctrlKey;
    const blocked = (e: KeyboardEvent) => (space(e) ? isTyping(e.target) : isEditable(e.target)) || dialog();
    const onKeyDown = (e: KeyboardEvent) => {
      if (blocked(e) || e.altKey || e.ctrlKey) return;
      const done = () => e.preventDefault();
      const bottom = getPlayback().bottom;
      // U11 (D177): the Transcript is a rail tab next to the timeline. Words selected in it (which
      // clears the timeline's selection, and the other way round) are what ⌫ cuts.
      const words = getTranscripts().anchor !== undefined && document.querySelector("[data-testid=transcript-panel]") !== null;
      if (e.metaKey) {
        const key = e.key.toLowerCase();
        if (e.key === "=" || e.key === "+") (playback.zoomIn(), done());
        else if (e.key === "-" || e.key === "_") (playback.zoomOut(), done());
        else if (e.key === "0") (playback.zoomFit(), done());
        else if (e.shiftKey) return;
        else if (key === "b") (done(), e.repeat || void actions.split());
        // With words selected and in the mixer ⌘A, ⌘C, ⌘X and ⌘V keep their usual meaning.
        else if (bottom !== "timeline" || words) return;
        // Issue #49: text selected in the Agent tab (a reply, a step's output) copies as text, even
        // with clips selected; ⌘A there selects the conversation, not the timeline.
        else if ((key === "c" || key === "x") && agentTextSelected()) return;
        else if (key === "a" && inAgentThread(document.getSelection()?.anchorNode ?? null)) {
          done();
          const thread = document.querySelector("[data-testid=agent-thread]");
          if (thread) document.getSelection()?.selectAllChildren(thread);
        }
        else if (key === "a") {
          done();
          const snapshot = s().snapshot;
          const ids = snapshot ? projectOf(snapshot).tracks.flatMap((t) => t.items.filter((i) => i.type !== "captions").map((i) => i.id)) : [];
          playback.selectMany(ids);
        } else if (key === "c") {
          if (copySelection()) done();
        } else if (key === "x") {
          if (copySelection()) (done(), e.repeat || void deleteSelection());
        } else if (key === "v") {
          if (clipboard.length) (done(), e.repeat || void paste());
        } else if (key === "d") (done(), e.repeat || void duplicate());
        return;
      }
      if (e.code === "Space") {
        // Also stops a focused button from being "clicked" by the same key.
        done();
        // A field focused without the user choosing it lets go, so the next keys are shortcuts too.
        if (isEditable(e.target)) (e.target as HTMLElement).blur();
        if (!e.repeat) playback.toggle();
        return;
      }
      // ⇧ only changes these keys (⇧⌫ / ⇧Delete: ripple delete); with any other key it does nothing.
      if (e.shiftKey && !SHIFT_KEYS.has(e.key)) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const snapshot = s().snapshot;
      // Issue #57 (D230): V, C, H pick the timeline's tool (held: only while down).
      const tool = e.shiftKey ? undefined : toolForKey(key);
      if (tool) return (done(), toolKeys.down(tool, key, e.repeat));
      if (key === "ArrowLeft") (playback.step(e.shiftKey ? -fps : -1), done());
      else if (key === "ArrowRight") (playback.step(e.shiftKey ? fps : 1), done());
      else if (key === "ArrowUp" || key === "ArrowDown") {
        done();
        const to = snapshot && nextEditPoint(projectOf(snapshot), getPlayback().frame, key === "ArrowUp" ? -1 : 1);
        if (to !== undefined && to !== null) (playback.pause(), playback.seek(to));
      } else if (key === "[" || key === "]") {
        done();
        const to = snapshot && nearbyKey(projectOf(snapshot), getPlayback().frame, key === "[" ? -1 : 1, selection());
        if (to !== undefined && to !== null) (playback.pause(), playback.seek(to));
      } else if (key === "Home") (playback.toStart(), done());
      else if (key === "End") (playback.toEnd(), done());
      else if (key === "Escape") (playback.select(undefined), transcriptStore.clear());
      else if (key === "j") (done(), playback.shuttle(-1));
      else if (key === "k") (done(), playback.pause());
      else if (key === "l") (done(), playback.shuttle(1));
      else if (key === "i") (done(), playback.setMark("in", Math.round(getPlayback().frame)));
      else if (key === "o") (done(), playback.setMark("out", Math.round(getPlayback().frame)));
      else if (key === "+" || key === "=") (done(), playback.zoomIn());
      else if (key === "-") (done(), playback.zoomOut());
      else if (key === "?") (done(), actions.openShortcuts());
      else if (key === "s") (done(), e.repeat || void actions.split());
      else if (key === "Backspace" || key === "Delete") {
        done();
        // Selected words in the Transcript: ⌫ cuts them (D69). The Mixer (D83) shows no selection,
        // so ⌫ there deletes nothing else.
        if (!e.repeat && (words || bottom !== "mixer")) void (words ? cutSelectedWords() : e.shiftKey ? actions.rippleDelete(s().snapshot ? withGroups(projectOf(s().snapshot!), selection()) : selection()) : deleteSelection());
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && !blocked(e)) e.preventDefault();
      // A held tool key gives the tool back wherever focus went meanwhile.
      if (e.key.length === 1) toolKeys.up(e.key);
    };
    const onPointerDown = () => toolKeys.pointer();
    const onBlur = () => toolKeys.blur();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      uninstall();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [fps]);
}
