import type { MenuCommand } from "../bridge.ts";
import { actions } from "./actions.ts";
import { online, state } from "./core.ts";

export function runCommand(command: MenuCommand) {
  // The way to another environment works while this one is away.
  if (command.type === "open-environments") return void actions.openEnvironments();
  // Settings and the shortcuts sheet are local UI: they open while the server is away too.
  if (command.type === "open-settings") return actions.openSettings();
  if (command.type === "shortcuts") return actions.openShortcuts();
  // Everything below talks to the server; while it's away the buttons are disabled too.
  if (!online()) return;
  if (command.type === "open-setup") return actions.openSetup();
  if (command.type === "export") return actions.openExport();
  switch (command.type) {
    case "new-project":
      // Over the editor if one is open; the current project only closes once the new one exists.
      return actions.showNewProject();
    case "open-project":
      return void actions.openWithDialog();
    case "open-recent":
      return void actions.openProject(command.dir);
    case "close-project":
      if (state.newProjectOpen) return actions.hideNewProject();
      return void actions.closeProject();
    case "undo":
    case "redo":
      return undoOrRedo(command.type);
  }
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "number", "email", "url", "tel", "password"]);

export const isTextEntry = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);

// In a text field ⌘Z undoes typing; elsewhere it undoes the last project change.
function undoOrRedo(kind: "undo" | "redo") {
  if (isTextEntry(document.activeElement)) document.execCommand(kind);
  else void actions[kind]();
}

// The menu shows these shortcuts but doesn't register them (registerAccelerator: false), so
// the keys arrive here and there is one code path for them.
export function onKeyDown(event: KeyboardEvent) {
  if (!event.metaKey || event.altKey || event.ctrlKey) return;
  const key = event.key.toLowerCase();
  const command: MenuCommand | undefined =
    key === "z"
      ? { type: event.shiftKey ? "redo" : "undo" }
      : event.shiftKey
        ? undefined
        : key === ","
          ? { type: "open-settings" }
          : key === "n"
          ? { type: "new-project" }
          : key === "e" && state.snapshot
          ? { type: "export" }
          : key === "o"
            ? { type: "open-project" }
            : key === "w" && state.snapshot
              ? { type: "close-project" }
              : undefined;
  if (!command) return;
  event.preventDefault();
  runCommand(command);
}
