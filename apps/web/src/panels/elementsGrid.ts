// Which elements the Elements grid shows (E2, D130), remembered on this Mac (localStorage, like the
// panel sizes). The components made for screen-recorded dev promos (agent log, compare table, device
// frame, terminal, code block) start hidden: they stay in core's registry (the agent and plugins
// still insert them, old projects still draw them) and come back from the grid's hidden list. Any
// element can be hidden from its tile and shown again.
import { useSyncExternalStore } from "react";

const KEY = "uncut.elements.hidden";
export const HIDDEN_BY_DEFAULT: ReadonlyArray<string> = [
  "component.agent-log",
  "component.compare-table",
  "component.device-frame",
  "component.terminal",
  "component.code-block",
];

const read = (): ReadonlyArray<string> => {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (raw === null) return HIDDEN_BY_DEFAULT;
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : HIDDEN_BY_DEFAULT;
  } catch {
    return HIDDEN_BY_DEFAULT;
  }
};

let hidden = read();
const listeners = new Set<() => void>();
const save = (next: ReadonlyArray<string>) => {
  hidden = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  for (const l of listeners) l();
};

export const useHiddenElements = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => hidden,
  );
export const hideElement = (id: string) => !hidden.includes(id) && save([...hidden, id]);
export const showElement = (id: string) => hidden.includes(id) && save(hidden.filter((h) => h !== id));
