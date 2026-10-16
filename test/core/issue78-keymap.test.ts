// Issue #78 (D257): the keymap. Presets map the programs' own keys and keep Uncut's for the rest,
// no preset has a conflict, rebinding reports and resolves conflicts (swap / replace), menu keys
// are refused, keys read from events, and the keymap is remembered (and survives junk).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_IDS,
  actionFor,
  assignKey,
  bindingsOf,
  checkKey,
  choosePreset,
  clearAction,
  conflicts,
  DEFAULT_KEYMAP,
  keyOf,
  makeKeymapStore,
  parseKeymap,
  presetBindings,
  PRESETS,
  removeKey,
  resetAction,
  STORAGE_KEY,
  type KeyLike,
} from "../../apps/web/src/editor/keymap.ts";

const ev = (key: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, code, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...mods });

test("Uncut preset: the keys the app always had", () => {
  const b = presetBindings("uncut");
  assert.deepEqual(b.split, ["S", "⌘B"]);
  assert.deepEqual(b.play, ["Space"]);
  assert.deepEqual(b.rippleDelete, ["⇧⌫", "⇧Delete"]);
  assert.deepEqual([b.toolSelect, b.toolBlade, b.toolHand], [["V"], ["C"], ["H"]]);
  assert.equal(actionFor(b, "?"), "shortcuts");
});

test("presets: their programs' keys, Uncut's for the rest, and no conflicts", () => {
  const premiere = presetBindings("premiere");
  assert.deepEqual(premiere.split, ["⌘K"]);
  assert.deepEqual(premiere.fit, ["\\"]);
  assert.deepEqual(premiere.rippleDelete, ["⇧Delete", "⌥⌫"]);
  assert.deepEqual(premiere.shuttleBack, ["J"], "unmapped: Uncut's");
  assert.equal(actionFor(premiere, "S"), undefined, "S isn't split in Premiere");
  const resolve = presetBindings("resolve");
  assert.deepEqual(resolve.split, ["⌘B", "⌘\\"]);
  assert.deepEqual([resolve.toolSelect, resolve.toolBlade, resolve.toolHand], [["A"], ["B"], ["H"]]);
  assert.deepEqual(resolve.fit, ["⇧Z"]);
  const fcp = presetBindings("finalcut");
  assert.deepEqual(fcp.rippleDelete, ["⌫"]);
  assert.deepEqual(fcp.delete, ["⇧⌫"]);
  assert.deepEqual(fcp.prevKey, ["⌥;"]);
  assert.deepEqual(fcp.nextEdit, ["↓", "'"]);
  for (const p of PRESETS) {
    const b = presetBindings(p.id);
    assert.deepEqual(conflicts(b), [], `${p.label}: no conflicts`);
    for (const id of ACTION_IDS) assert.ok(Array.isArray(b[id]), `${p.label}: ${id}`);
  }
});

test("rebinding: free key, taken key (replace or swap), menu key refused, clear, remove, reset", () => {
  let s = DEFAULT_KEYMAP;
  s = assignKey(s, "split", "X", 0);
  assert.deepEqual(bindingsOf(s).split, ["X", "⌘B"]);
  assert.equal(checkKey(bindingsOf(s), "split", "X").kind, "same");
  // J is shuttleBack's: replace takes it away.
  assert.deepEqual(checkKey(bindingsOf(s), "split", "J"), { kind: "taken", by: "shuttleBack" });
  const replaced = assignKey(s, "split", "J", 0, "replace");
  assert.deepEqual(bindingsOf(replaced).split, ["J", "⌘B"]);
  assert.deepEqual(bindingsOf(replaced).shuttleBack, []);
  assert.deepEqual(conflicts(bindingsOf(replaced)), []);
  // Swap: shuttleBack gets the key split gave up.
  const swapped = assignKey(s, "split", "J", 0, "swap");
  assert.deepEqual(bindingsOf(swapped).split, ["J", "⌘B"]);
  assert.deepEqual(bindingsOf(swapped).shuttleBack, ["X"]);
  // Added (no slot): a swap has nothing to give, so it's a replace.
  const added = assignKey(DEFAULT_KEYMAP, "split", "K", undefined, "swap");
  assert.deepEqual(bindingsOf(added).split, ["S", "⌘B", "K"]);
  assert.deepEqual(bindingsOf(added).pause, []);
  // Menu keys.
  assert.deepEqual(checkKey(bindingsOf(s), "split", "⌘Z"), { kind: "reserved", by: "Undo" });
  assert.equal(checkKey(bindingsOf(s), "split", "⌘Q").kind, "reserved");
  assert.equal(assignKey(s, "split", "⌘Z", 0), s);
  // D256: the View menu's layout keys are menu keys too.
  for (const [k, by] of [["⇧⌘L", "Hide or show the left panel"], ["⇧⌘I", "Hide or show the right panel"], ["⇧⌘T", "Hide or show the timeline"], ["⇧⌘F", "Focus mode: only the preview and the agent"]] as const) {
    assert.deepEqual(checkKey(bindingsOf(s), "split", k), { kind: "reserved", by });
    assert.equal(assignKey(s, "split", k, 0), s);
  }
  // Clear, remove one, reset.
  assert.deepEqual(bindingsOf(clearAction(s, "split")).split, []);
  assert.deepEqual(bindingsOf(removeKey(s, "split", 1)).split, ["X"]);
  assert.deepEqual(bindingsOf(resetAction(s, "split")).split, ["S", "⌘B"]);
  // Setting the preset's own keys again keeps no override.
  assert.deepEqual(assignKey(s, "split", "S", 0).overrides, {});
  // A preset drops the user's changes.
  assert.deepEqual(choosePreset("premiere"), { preset: "premiere", overrides: {} });
});

test("conflicts: two actions, or an action and the menu", () => {
  const b = { ...presetBindings("uncut"), pause: ["K", "S"], markIn: ["⌘E"] };
  const c = conflicts(b);
  assert.deepEqual(c.find((x) => x.key === "S")?.actions, ["pause", "split"]);
  assert.equal(c.find((x) => x.key === "⌘E")?.reserved, "Export");
});

test("keys from events: letters, shifted characters, named keys, ⌥ by physical key", () => {
  assert.equal(keyOf(ev("s", "KeyS")), "S");
  assert.equal(keyOf(ev("S", "KeyS", { shiftKey: true })), "⇧S");
  assert.equal(keyOf(ev("b", "KeyB", { metaKey: true })), "⌘B");
  assert.equal(keyOf(ev("z", "KeyZ", { metaKey: true, shiftKey: true })), "⇧⌘Z");
  assert.equal(keyOf(ev("?", "Slash", { shiftKey: true })), "?");
  assert.equal(keyOf(ev("+", "Equal", { shiftKey: true })), "+");
  assert.equal(keyOf(ev("-", "Minus")), "−");
  assert.equal(keyOf(ev("-", "Minus", { metaKey: true })), "⌘−");
  assert.equal(keyOf(ev(" ", "Space")), "Space");
  assert.equal(keyOf(ev("ArrowLeft", "ArrowLeft", { shiftKey: true })), "⇧←");
  assert.equal(keyOf(ev("Backspace", "Backspace", { shiftKey: true })), "⇧⌫");
  assert.equal(keyOf(ev("…", "Semicolon", { altKey: true })), "⌥;");
  assert.equal(keyOf(ev("Backspace", "Backspace", { altKey: true })), "⌥⌫");
  assert.equal(keyOf(ev("k", "KeyK", { metaKey: true })), "⌘K");
  assert.equal(keyOf(ev("\\", "Backslash")), "\\");
  assert.equal(keyOf(ev("Shift", "ShiftLeft", { shiftKey: true })), undefined);
  assert.equal(keyOf(ev("Meta", "MetaLeft", { metaKey: true })), undefined);
});

test("persistence: remembered in storage, read back, defaults stored as nothing, junk ignored", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  const a = makeKeymapStore(storage);
  let heard = 0;
  a.subscribe(() => heard++);
  a.set(assignKey(choosePreset("premiere"), "split", "X", 0));
  assert.equal(heard, 1);
  assert.deepEqual(a.bindings().split, ["X"]);
  const b = makeKeymapStore(storage);
  assert.equal(b.get().preset, "premiere");
  assert.deepEqual(b.bindings().split, ["X"]);
  assert.deepEqual(b.bindings().fit, ["\\"]);
  b.set(DEFAULT_KEYMAP);
  assert.equal(data.has(STORAGE_KEY), false);
  assert.deepEqual(parseKeymap("{nope"), DEFAULT_KEYMAP);
  assert.deepEqual(parseKeymap(JSON.stringify({ preset: "avid", overrides: { split: ["X", "X"], bogus: ["Y"], fit: [3] } })), { preset: "uncut", overrides: { split: ["X"] } });
  // No storage at all (a blocked localStorage): still works.
  const none = makeKeymapStore(undefined);
  none.set(choosePreset("resolve"));
  assert.deepEqual(none.bindings().toolBlade, ["B"]);
});

test("stale overrides: a key reserved after it was saved is dropped, an emptied override falls back (D266)", () => {
  // Saved before ⇧⌘T became the timeline toggle: one press would hide the timeline and split.
  const stale = parseKeymap(JSON.stringify({ preset: "uncut", overrides: { split: ["⇧⌘T"] } }));
  assert.deepEqual(stale.overrides, {});
  assert.deepEqual(bindingsOf(stale).split, presetBindings("uncut").split);
  assert.equal(actionFor(bindingsOf(stale), "⇧⌘T"), undefined);
  // A reserved key mixed with free ones: only the reserved one goes.
  assert.deepEqual(parseKeymap(JSON.stringify({ overrides: { zoomIn: ["⌘Z", "="], split: ["⌃⌘F", "S"] } })).overrides, { zoomIn: ["="], split: ["S"] });
  // A deliberately cleared action (no keys) stays cleared.
  assert.deepEqual(parseKeymap(JSON.stringify({ overrides: { split: [] } })).overrides, { split: [] });
  // ⌃⌘F is macOS's full screen: refused like the menu's keys.
  assert.equal(checkKey(presetBindings("uncut"), "split", "⌃⌘F").kind, "reserved");
});
