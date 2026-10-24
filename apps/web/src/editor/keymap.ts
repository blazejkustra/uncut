// Issue #78 (D257): the keymap. Every keyboard action the editor has, its keys under each preset
// (Uncut, Premiere Pro, DaVinci Resolve, Final Cut Pro), the user's own changes on top, and the
// conflict rules. Remembered on this Mac (localStorage, like Labs). editor/keys.ts runs the actions,
// Settings › Shortcuts edits them, the shortcuts sheet and tooltips show them.
//
// A key is written the way the app shows it: modifiers in macOS order (⌃⌥⇧⌘) then the key ("⇧⌘Z",
// "S", "Space", "←", "⌫"). For a printed character that ⇧ already changes ("?", "+") the ⇧ is
// part of the character. With ⌥ the key is read from the physical key (⌥; not "…").
// Menu keys (⌘Z, ⌘N, ⌘O, ⌘E, ⌘W, ⌘,, ⌘A/⌘C/⌘X/⌘V which text fields share, and the View menu's
// ⇧⌘L/⇧⌘I/⇧⌘T/⇧⌘F) stay fixed: the macOS menu shows them from main (menu.ts), which has no keymap.
import { useSyncExternalStore } from "react";

export type ShortcutGroup = "Playback" | "Edit" | "Timeline" | "View" | "App";

/** The actions a user can rebind. */
export const ACTION_IDS = [
  "play",
  "shuttleBack",
  "pause",
  "shuttleForward",
  "frameBack",
  "frameForward",
  "secondBack",
  "secondForward",
  "toStart",
  "toEnd",
  "prevEdit",
  "nextEdit",
  "prevKey",
  "nextKey",
  "markIn",
  "markOut",
  "split",
  "delete",
  "rippleDelete",
  "duplicate",
  "deselect",
  "zoomIn",
  "zoomOut",
  "fit",
  "toolSelect",
  "toolBlade",
  "toolHand",
  "addToChat",
  "shortcuts",
] as const;
export type ActionId = (typeof ACTION_IDS)[number];

/** Rows shown but not rebindable: menu keys (fixed) and pointer gestures (not keys). */
export type FixedId =
  | "selectAll"
  | "copy"
  | "cut"
  | "paste"
  | "undo"
  | "redo"
  | "toggleLeft"
  | "toggleRight"
  | "toggleTimeline"
  | "focusMode"
  | "export"
  | "settings"
  | "close"
  | "exitFull"
  | "zoomPointer"
  | "scrollSideways"
  | "clickSelect";
export type ShortcutId = ActionId | FixedId;

export interface ActionDef {
  readonly id: ShortcutId;
  readonly group: ShortcutGroup;
  readonly does: string;
  /** Uncut's keys (the default preset). */
  readonly keys: ReadonlyArray<string>;
  /** "menu": set by the macOS menu; "pointer": a mouse or trackpad gesture; "context": a key that only works somewhere (full screen). */
  readonly fixed?: "menu" | "pointer" | "context";
}

/** Every row, in the order Settings and the sheet list them. */
export const ACTIONS: ReadonlyArray<ActionDef> = [
  { id: "play", group: "Playback", keys: ["Space"], does: "Play or pause (from the pointer while skimming the timeline)" },
  { id: "shuttleBack", group: "Playback", keys: ["J"], does: "Play backwards (press again to go faster)" },
  { id: "pause", group: "Playback", keys: ["K"], does: "Pause" },
  { id: "shuttleForward", group: "Playback", keys: ["L"], does: "Play forwards (press again to go faster)" },
  { id: "frameBack", group: "Playback", keys: ["←"], does: "One frame back" },
  { id: "frameForward", group: "Playback", keys: ["→"], does: "One frame forward" },
  { id: "secondBack", group: "Playback", keys: ["⇧←"], does: "One second back" },
  { id: "secondForward", group: "Playback", keys: ["⇧→"], does: "One second forward" },
  { id: "toStart", group: "Playback", keys: ["Home"], does: "Go to the start" },
  { id: "toEnd", group: "Playback", keys: ["End"], does: "Go to the end" },
  { id: "prevEdit", group: "Playback", keys: ["↑"], does: "Previous edit" },
  { id: "nextEdit", group: "Playback", keys: ["↓"], does: "Next edit" },
  { id: "prevKey", group: "Playback", keys: ["["], does: "Previous keyframe (of the selection, else of any item)" },
  { id: "nextKey", group: "Playback", keys: ["]"], does: "Next keyframe (of the selection, else of any item)" },
  { id: "markIn", group: "Playback", keys: ["I"], does: "Mark in at the playhead" },
  { id: "markOut", group: "Playback", keys: ["O"], does: "Mark out at the playhead" },
  { id: "exitFull", group: "Playback", keys: ["Esc"], does: "Leave the full-screen preview", fixed: "context" },
  { id: "split", group: "Edit", keys: ["S", "⌘B"], does: "Split at the playhead" },
  { id: "delete", group: "Edit", keys: ["⌫", "Delete"], does: "Delete the selection (leaves a gap)" },
  { id: "rippleDelete", group: "Edit", keys: ["⇧⌫", "⇧Delete"], does: "Ripple delete: delete and close the gap" },
  { id: "duplicate", group: "Edit", keys: ["⌘D"], does: "Duplicate the selection" },
  { id: "deselect", group: "Edit", keys: ["Esc"], does: "Deselect" },
  { id: "selectAll", group: "Edit", keys: ["⌘A"], does: "Select everything on the timeline", fixed: "menu" },
  { id: "copy", group: "Edit", keys: ["⌘C"], does: "Copy", fixed: "menu" },
  { id: "cut", group: "Edit", keys: ["⌘X"], does: "Cut", fixed: "menu" },
  { id: "paste", group: "Edit", keys: ["⌘V"], does: "Paste at the playhead", fixed: "menu" },
  { id: "undo", group: "Edit", keys: ["⌘Z"], does: "Undo", fixed: "menu" },
  { id: "redo", group: "Edit", keys: ["⇧⌘Z"], does: "Redo", fixed: "menu" },
  { id: "zoomIn", group: "Timeline", keys: ["+", "⌘=", "="], does: "Zoom the timeline in" },
  { id: "zoomOut", group: "Timeline", keys: ["−", "⌘−"], does: "Zoom the timeline out" },
  { id: "fit", group: "Timeline", keys: ["⌘0"], does: "Fit the project in the timeline" },
  { id: "toolSelect", group: "Timeline", keys: ["V"], does: "Select tool (held down: only until you let go)" },
  { id: "toolBlade", group: "Timeline", keys: ["C"], does: "Blade tool: a click cuts there (held down: only until you let go)" },
  { id: "toolHand", group: "Timeline", keys: ["H"], does: "Hand tool (held down: only until you let go)" },
  { id: "zoomPointer", group: "Timeline", keys: ["⌘ scroll", "Pinch"], does: "Zoom the timeline around the pointer", fixed: "pointer" },
  { id: "scrollSideways", group: "Timeline", keys: ["⇧ scroll"], does: "Scroll the timeline sideways", fixed: "pointer" },
  { id: "clickSelect", group: "Timeline", keys: ["⇧ click", "⌘ click"], does: "Select a range, add or remove one item", fixed: "pointer" },
  // D256 (#76): the View menu's layout keys, handled with the menu's others (store/keys.ts).
  { id: "toggleLeft", group: "View", keys: ["⇧⌘L"], does: "Hide or show the left panel", fixed: "menu" },
  { id: "toggleRight", group: "View", keys: ["⇧⌘I"], does: "Hide or show the right panel", fixed: "menu" },
  { id: "toggleTimeline", group: "View", keys: ["⇧⌘T"], does: "Hide or show the timeline", fixed: "menu" },
  { id: "focusMode", group: "View", keys: ["⇧⌘F"], does: "Focus mode: only the preview and the agent", fixed: "menu" },
  { id: "export", group: "App", keys: ["⌘E"], does: "Export", fixed: "menu" },
  { id: "settings", group: "App", keys: ["⌘,"], does: "Settings", fixed: "menu" },
  // D264 (#77): the selection (timeline items, or words in the Transcript) as chips in the composer.
  { id: "addToChat", group: "App", keys: ["⌘L"], does: "Add the selection to the agent chat" },
  { id: "shortcuts", group: "App", keys: ["?"], does: "Keyboard shortcuts" },
  { id: "close", group: "App", keys: ["⌘W"], does: "Close the project", fixed: "menu" },
];

export const actionDef = (id: ShortcutId): ActionDef => ACTIONS.find((a) => a.id === id)!;
export const isActionId = (id: string): id is ActionId => (ACTION_IDS as ReadonlyArray<string>).includes(id);

/** Keys the user can't take: the menu's (fixed rows) and macOS's own. Key → what has it. */
export const RESERVED: ReadonlyMap<string, string> = new Map([
  ...ACTIONS.filter((a) => a.fixed === "menu").flatMap((a) => a.keys.map((k) => [k, a.does] as const)),
  ["⌘N", "New Project"],
  ["⌘O", "Open"],
  ["⌘Q", "Quit Uncut"],
  ["⌘H", "Hide Uncut"],
  ["⌥⌘H", "Hide Others"],
  ["⌘M", "Minimize"],
  ["⌃⌘F", "Enter Full Screen"],
]);

export type PresetId = "uncut" | "premiere" | "resolve" | "finalcut";
export type Bindings = Readonly<Record<ActionId, ReadonlyArray<string>>>;

/**
 * Each preset's own default keys for the actions Uncut has (researched from the programs' default
 * keyboard layouts on macOS). Actions a preset doesn't list keep Uncut's keys, less any key the
 * preset gives to another action.
 */
export const PRESETS: ReadonlyArray<{ readonly id: PresetId; readonly label: string; readonly keys: Partial<Bindings> }> = [
  { id: "uncut", label: "Uncut", keys: {} },
  {
    id: "premiere",
    label: "Premiere Pro",
    keys: {
      // Add Edit, Ripple Delete (⇧ Forward Delete, ⌥⌫), Clear, Zoom to Sequence (\), Deselect All.
      split: ["⌘K"],
      delete: ["⌫", "Delete"],
      rippleDelete: ["⇧Delete", "⌥⌫"],
      zoomIn: ["="],
      zoomOut: ["−"],
      fit: ["\\"],
      deselect: ["⇧⌘A"],
      toolSelect: ["V"],
      toolBlade: ["C"],
      toolHand: ["H"],
    },
  },
  {
    id: "resolve",
    label: "DaVinci Resolve",
    keys: {
      // Razor (⌘B) / Split Clip (⌘\), Delete Selected, Ripple Delete, Normal Edit (A), Blade (B),
      // Zoom In/Out (⌘= / ⌘−), Zoom to Fit (⇧Z), Previous/Next Keyframe ([ ]), Deselect All.
      split: ["⌘B", "⌘\\"],
      delete: ["⌫", "Delete"],
      rippleDelete: ["⇧⌫"],
      toolSelect: ["A"],
      toolBlade: ["B"],
      zoomIn: ["⌘="],
      zoomOut: ["⌘−"],
      fit: ["⇧Z"],
      prevKey: ["["],
      nextKey: ["]"],
      deselect: ["⇧⌘A"],
    },
  },
  {
    id: "finalcut",
    label: "Final Cut Pro",
    keys: {
      // Blade (⌘B), Delete (closes the gap) vs Replace with Gap (⇧⌫), Select (A), Blade (B),
      // Hand (H), Zoom In/Out, Zoom to Fit (⇧Z), Previous/Next Edit (↑ ; / ↓ '),
      // Previous/Next Keyframe (⌥; / ⌥'), Deselect All.
      split: ["⌘B"],
      delete: ["⇧⌫"],
      rippleDelete: ["⌫"],
      toolSelect: ["A"],
      toolBlade: ["B"],
      toolHand: ["H"],
      zoomIn: ["⌘="],
      zoomOut: ["⌘−"],
      fit: ["⇧Z"],
      prevEdit: ["↑", ";"],
      nextEdit: ["↓", "'"],
      prevKey: ["⌥;"],
      nextKey: ["⌥'"],
      deselect: ["⇧⌘A"],
    },
  },
];

export const presetLabel = (id: PresetId) => PRESETS.find((p) => p.id === id)!.label;
const isPresetId = (id: unknown): id is PresetId => PRESETS.some((p) => p.id === id);

/** A preset's keys for every action. */
export function presetBindings(preset: PresetId): Bindings {
  const mapped = PRESETS.find((p) => p.id === preset)?.keys ?? {};
  const taken = new Set(Object.values(mapped).flat());
  return Object.fromEntries(
    ACTION_IDS.map((id) => {
      const own = mapped[id];
      return [id, own ?? actionDef(id).keys.filter((k) => !taken.has(k))];
    }),
  ) as Record<ActionId, ReadonlyArray<string>>;
}

export interface KeymapState {
  readonly preset: PresetId;
  /** The user's changes: an action's whole key list, replacing the preset's. */
  readonly overrides: Readonly<Partial<Record<ActionId, ReadonlyArray<string>>>>;
}

export const DEFAULT_KEYMAP: KeymapState = { preset: "uncut", overrides: {} };

export function bindingsOf(state: KeymapState): Bindings {
  const base = presetBindings(state.preset);
  return Object.fromEntries(ACTION_IDS.map((id) => [id, state.overrides[id] ?? base[id]])) as Record<ActionId, ReadonlyArray<string>>;
}

export interface Conflict {
  readonly key: string;
  readonly actions: ReadonlyArray<ActionId>;
  /** A menu or macOS key that one of the actions also uses. */
  readonly reserved?: string;
}

/** Keys used by more than one action, or by an action and the menu. */
export function conflicts(bindings: Bindings): ReadonlyArray<Conflict> {
  const by = new Map<string, Array<ActionId>>();
  for (const id of ACTION_IDS) for (const k of bindings[id]) by.set(k, [...(by.get(k) ?? []), id]);
  return [...by]
    .filter(([k, ids]) => ids.length > 1 || RESERVED.has(k))
    .map(([key, actions]) => (RESERVED.has(key) ? { key, actions, reserved: RESERVED.get(key)! } : { key, actions }));
}

/** Which action a key runs, if any. */
export function actionFor(bindings: Bindings, key: string): ActionId | undefined {
  return ACTION_IDS.find((id) => bindings[id].includes(key));
}

export type Check =
  | { readonly kind: "ok" }
  | { readonly kind: "same" }
  | { readonly kind: "taken"; readonly by: ActionId }
  | { readonly kind: "reserved"; readonly by: string };

/** What giving `key` to `action` would run into. */
export function checkKey(bindings: Bindings, action: ActionId, key: string): Check {
  const reserved = RESERVED.get(key);
  if (reserved) return { kind: "reserved", by: reserved };
  if (bindings[action].includes(key)) return { kind: "same" };
  const by = ACTION_IDS.find((id) => id !== action && bindings[id].includes(key));
  return by ? { kind: "taken", by } : { kind: "ok" };
}

const same = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((k, i) => k === b[i]);

/** The state with `id`'s keys set (no override kept when they equal the preset's). */
function withKeys(state: KeymapState, id: ActionId, keys: ReadonlyArray<string>): KeymapState {
  const overrides = { ...state.overrides };
  if (same(keys, presetBindings(state.preset)[id])) delete overrides[id];
  else overrides[id] = keys;
  return { ...state, overrides };
}

/**
 * Gives `key` to `action`: in place of its key at `slot`, or as one more. A key another action has
 * is taken from it ("replace"), or that action gets the replaced key instead ("swap"; with no
 * replaced key it's a replace). Reserved keys are refused (the state comes back unchanged).
 */
export function assignKey(state: KeymapState, action: ActionId, key: string, slot?: number, resolve: "swap" | "replace" = "replace"): KeymapState {
  const bindings = bindingsOf(state);
  const check = checkKey(bindings, action, key);
  if (check.kind === "reserved") return state;
  const own = bindings[action];
  const old = slot === undefined ? undefined : own[slot];
  const keys = old === undefined ? [...own.filter((k) => k !== key), key] : own.map((k, i) => (i === slot ? key : k)).filter((k, i) => k !== key || i === slot);
  let next = withKeys(state, action, keys);
  if (check.kind === "taken") {
    const theirs = bindings[check.by];
    const given = resolve === "swap" && old !== undefined && !theirs.includes(old) ? theirs.map((k) => (k === key ? old : k)) : theirs.filter((k) => k !== key);
    next = withKeys(next, check.by, given);
  }
  return next;
}

/** Takes one key off an action. */
export const removeKey = (state: KeymapState, action: ActionId, slot: number): KeymapState =>
  withKeys(
    state,
    action,
    bindingsOf(state)[action].filter((_, i) => i !== slot),
  );
/** An action with no keys. */
export const clearAction = (state: KeymapState, action: ActionId): KeymapState => withKeys(state, action, []);
/** An action back to the preset's keys. */
export function resetAction(state: KeymapState, action: ActionId): KeymapState {
  const overrides = { ...state.overrides };
  delete overrides[action];
  return { ...state, overrides };
}
/** A preset, with the user's changes dropped. */
export const choosePreset = (preset: PresetId): KeymapState => ({ preset, overrides: {} });

// ── Reading keys from events ───────────────────────────────────────────────────────────────────

const NAMED: Readonly<Record<string, string>> = {
  " ": "Space",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Backspace: "⌫",
  Delete: "Delete",
  Escape: "Esc",
  Enter: "↩",
  Tab: "⇥",
  Home: "Home",
  End: "End",
  PageUp: "Page Up",
  PageDown: "Page Down",
};
const CODES: Readonly<Record<string, string>> = {
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Slash: "/",
  Comma: ",",
  Period: ".",
  Minus: "−",
  Equal: "=",
  Backquote: "`",
  Space: "Space",
};
const MODIFIERS = new Set(["Meta", "Shift", "Alt", "Control", "CapsLock", "Fn", "OS", "Hyper", "Super"]);

export interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
}

/** The key an event is, as the keymap writes it; undefined for a lone modifier. */
export function keyOf(e: KeyLike): string | undefined {
  if (MODIFIERS.has(e.key)) return undefined;
  let base: string | undefined = NAMED[e.key] ?? (/^F\d{1,2}$/.test(e.key) ? e.key : undefined);
  let shiftShown = true;
  if (base === undefined) {
    // ⌥ (and ⌃) turn a letter into another character: read the physical key instead.
    const physical = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : CODES[e.code];
    if ((e.altKey || e.ctrlKey) && physical) base = physical;
    else if (e.key.length === 1) {
      const upper = e.key.toUpperCase();
      const letter = upper !== e.key.toLowerCase();
      base = e.key === "-" ? "−" : upper;
      // A ⇧ that already made the character ("?", "+") isn't shown again; ⌘ makes the browser
      // report the unshifted character, so there ⇧ always counts.
      shiftShown = letter || e.metaKey;
    } else if (physical) base = physical;
    else return undefined;
  }
  return `${e.ctrlKey ? "⌃" : ""}${e.altKey ? "⌥" : ""}${e.shiftKey && shiftShown ? "⇧" : ""}${e.metaKey ? "⌘" : ""}${base}`;
}

// ── The app's keymap (this Mac) ──────────────────────────────────────────────────────────────

export const STORAGE_KEY = "uncut.keymap";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** A saved keymap, cleaned of anything unknown; the default when there's none or it's broken. */
export function parseKeymap(raw: string | null): KeymapState {
  if (!raw) return DEFAULT_KEYMAP;
  try {
    const data = JSON.parse(raw) as { preset?: unknown; overrides?: unknown };
    const preset = isPresetId(data.preset) ? data.preset : "uncut";
    const overrides: Partial<Record<ActionId, ReadonlyArray<string>>> = {};
    if (data.overrides && typeof data.overrides === "object")
      for (const [id, keys] of Object.entries(data.overrides as Record<string, unknown>))
        if (isActionId(id) && Array.isArray(keys) && keys.every((k) => typeof k === "string" && k !== "")) {
          // A key reserved after the override was saved (the menu's, macOS's) is dropped, so one
          // press never runs two commands; an override left with no keys falls back to the preset.
          const kept = [...new Set(keys as Array<string>)].filter((k) => !RESERVED.has(k));
          if (kept.length > 0 || keys.length === 0) overrides[id] = kept;
        }
    return { preset, overrides };
  } catch {
    return DEFAULT_KEYMAP;
  }
}

export interface KeymapStore {
  get(): KeymapState;
  bindings(): Bindings;
  set(next: KeymapState): void;
  subscribe(listener: () => void): () => void;
}

/** A keymap kept in `storage` (the app's: localStorage; tests pass their own). */
export function makeKeymapStore(storage: Store | undefined): KeymapStore {
  let state = DEFAULT_KEYMAP;
  try {
    state = parseKeymap(storage?.getItem(STORAGE_KEY) ?? null);
  } catch {}
  let bindings = bindingsOf(state);
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    bindings: () => bindings,
    set(next) {
      state = next;
      bindings = bindingsOf(next);
      try {
        if (next.preset === "uncut" && !Object.keys(next.overrides).length) storage?.removeItem(STORAGE_KEY);
        else storage?.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {}
      for (const l of listeners) l();
    },
    subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)),
  };
}

const appStorage = (): Store | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

export const keymap = makeKeymapStore(appStorage());

/** The current keys of a row (fixed rows: their fixed keys). */
export const keysOf = (id: ShortcutId): ReadonlyArray<string> => (isActionId(id) ? keymap.bindings()[id] : actionDef(id).keys);

export const useKeymap = (): KeymapState => useSyncExternalStore(keymap.subscribe, keymap.get, keymap.get);
export const useBindings = (): Bindings => useSyncExternalStore(keymap.subscribe, keymap.bindings, keymap.bindings);

// Settings › Shortcuts is listening for a new key: Esc cancels that instead of closing Settings.
let recording = false;
export const isRecordingKey = () => recording;
export const setRecordingKey = (on: boolean) => void (recording = on);
