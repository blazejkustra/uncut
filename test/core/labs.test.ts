// D245 (#91): Labs flags: a typed list, off by default, remembered (localStorage), and the rule
// that keeps the way back from an active remote open while Environments is off.
import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const labs = await import("../../apps/web/src/settings/labs.ts");

test("Labs: Environments is listed, off by default, and remembered when turned on", () => {
  // D280: Import from link is a catalog plugin now, not a Labs flag.
  assert.deepEqual(labs.FLAG_IDS, ["environments"]);
  assert.equal(labs.FLAGS.environments.default, false);
  assert.equal(labs.flagOn("environments"), false);
  let heard = 0;
  const stop = labs.subscribeFlags(() => heard++);
  labs.setFlag("environments", true);
  assert.equal(labs.flagOn("environments"), true);
  assert.equal(store.get("uncut.labs.environments"), "on");
  labs.setFlag("environments", false);
  assert.equal(store.has("uncut.labs.environments"), false, "the default isn't stored");
  assert.equal(heard, 2);
  stop();
});

test("Labs: Environments opens with the flag on, or to leave an active remote", () => {
  assert.equal(labs.environmentsUsable(false, "local"), false);
  assert.equal(labs.environmentsUsable(false, "remote"), true);
  assert.equal(labs.environmentsUsable(true, "local"), true);
});
