// D245 (#91): Labs, a small set of feature flags remembered on this Mac (localStorage, like
// "Use proxies for preview"). Adding one is an entry in FLAGS; flagOn / useFlag read it anywhere.
// A flag hides nothing from the code: its UI stays, disabled, with a hint that it's in Labs.
import { useSyncExternalStore } from "react";

export const FLAGS = {
  environments: {
    label: "Environments",
    description: "Edit on another machine: pair a remote Uncut server and switch the window to it.",
    default: false,
  },
} as const satisfies Record<string, { readonly label: string; readonly description: string; readonly default: boolean }>;

export type Flag = keyof typeof FLAGS;
export const FLAG_IDS = Object.keys(FLAGS) as Array<Flag>;

/** Where Settings › Labs lives: the hint on a disabled entry point. */
export const LABS_HINT = "Turn it on in Settings › Labs";

const key = (flag: Flag) => `uncut.labs.${flag}`;

const read = (flag: Flag): boolean => {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key(flag));
    return raw === null ? FLAGS[flag].default : raw === "on";
  } catch {
    return FLAGS[flag].default;
  }
};

let flags: Readonly<Record<Flag, boolean>> = Object.fromEntries(FLAG_IDS.map((f) => [f, read(f)])) as Record<Flag, boolean>;
const listeners = new Set<() => void>();

export const flagOn = (flag: Flag) => flags[flag];

export function setFlag(flag: Flag, on: boolean) {
  flags = { ...flags, [flag]: on };
  try {
    if (on === FLAGS[flag].default) localStorage.removeItem(key(flag));
    else localStorage.setItem(key(flag), on ? "on" : "off");
  } catch {}
  for (const l of listeners) l();
}

export const subscribeFlags = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export const useFlag = (flag: Flag) => useSyncExternalStore(subscribeFlags, () => flags[flag]);

/**
 * Environments can be opened when the flag is on, or while a remote is the active one: the way
 * back to This Mac never closes (D245).
 */
export const environmentsUsable = (flag: boolean, kind: "local" | "remote") => flag || kind === "remote";
