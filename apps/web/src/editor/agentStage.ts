// #75 (D255): a new, empty project shows the agent in the middle of the window ("centre stage").
// It docks into the side panel's Agent tab when the first turn runs or media lands, or when the user
// goes to the editor (Esc, "Go to editor", a click outside it). Going there is remembered per project
// on this Mac; the Agent tab's empty state brings it back while the project is still empty.
import { useSyncExternalStore } from "react";

import type { AgentState } from "@uncut/contracts";
import type { Project } from "../state/store.ts";

export const STAGE_DISMISSED_KEY = "uncut.stage.dismissed";
const MAX_REMEMBERED = 50;

const readDismissed = (): Array<string> => {
  try {
    const raw = JSON.parse(localStorage.getItem(STAGE_DISMISSED_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

let dismissed: ReadonlyArray<string> = readDismissed();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const save = (next: ReadonlyArray<string>) => {
  dismissed = next;
  try {
    localStorage.setItem(STAGE_DISMISSED_KEY, JSON.stringify(next));
  } catch {}
  emit();
};

/** Nothing imported and nothing on any track. */
export const projectEmpty = (project: Project) => project.media.length === 0 && project.tracks.every((t) => t.items.length === 0);

/** The agent has been used in this project (a turn, or one running). Unknown (not loaded yet) counts as used. */
export const agentUsed = (agent: AgentState | null, dir: string) => !agent || agent.dir !== dir || agent.running !== null || agent.turns.length > 0;

/** Whether the stage shows: an empty project whose agent hasn't run, not sent to the editor. */
export const stageWanted = (project: Project, dir: string, agent: AgentState | null, list: ReadonlyArray<string>) =>
  projectEmpty(project) && !agentUsed(agent, dir) && !list.includes(dir);

/** How the stage was sent to the editor. */
export type StageDismissal = "esc" | "link" | "outside";

// Docking (the stage went to the Agent tab): for a moment the side panel's agent slides in from
// the middle (a CSS animation; nothing covers the page, so clicks are never held up).
let docking = false;
let dockTimer: ReturnType<typeof setTimeout> | undefined;
const dockListeners = new Set<() => void>();
export function markDocked() {
  docking = true;
  dockListeners.forEach((l) => l());
  clearTimeout(dockTimer);
  dockTimer = setTimeout(() => {
    docking = false;
    dockListeners.forEach((l) => l());
  }, 700);
}
export const useDocking = () =>
  useSyncExternalStore(
    (l) => (dockListeners.add(l), () => void dockListeners.delete(l)),
    () => docking,
  );

export const stage = {
  /** Sends the stage to the editor for this project (remembered). */
  dismiss(dir: string) {
    if (dismissed.includes(dir)) return;
    save([...dismissed.filter((d) => d !== dir), dir].slice(-MAX_REMEMBERED));
  },
  /** Brings it back (the Agent tab's empty state). */
  reopen(dir: string) {
    if (dismissed.includes(dir)) save(dismissed.filter((d) => d !== dir));
  },
};

export const useStageDismissed = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => dismissed,
  );
