// D269 (issue #101): the context meter's window is known from the start or not shown. "[1m]" on the
// model the user chose or claude's init named is 1M at the first answer (the API's message.model
// never carries it, which made the meter show 200k until the result said 1M); otherwise a window a
// result reported for the same model earlier; otherwise undefined (used count only), never 200k.
import { test } from "node:test";
import assert from "node:assert/strict";

import { contextOf, knownWindow, windowKey } from "../../apps/server/src/agent/session/usage.ts";

test("knownWindow: [1m] on the chosen or init model is 1M, though the message's model lacks it", () => {
  assert.equal(knownWindow({ model: "claude-opus-5-5", chosen: "claude-opus-5-5[1m]" }), 1_000_000);
  assert.equal(knownWindow({ model: "claude-opus-5-5", initModel: "claude-opus-5-5[1m]" }), 1_000_000, "Default model: claude's settings pick opus[1m]");
  assert.equal(knownWindow({ model: "claude-opus-5-5[1m]" }), undefined, "only the chosen or init model's marker counts");
});

test("knownWindow: unknown without a marker or a learned window (no guessed 200k)", () => {
  assert.equal(knownWindow({ model: "claude-opus-5-5", initModel: "claude-opus-5-5", chosen: "claude-opus-5-5" }), undefined);
  assert.equal(knownWindow({}), undefined);
});

test("knownWindow: a window a result reported for the same model comes back at the next first answer", () => {
  const learned = new Map<string, number>();
  const run = { model: "claude-sonnet-5-5-20261001", initModel: "claude-sonnet-5-5" };
  assert.equal(knownWindow({ ...run, learned }), undefined);
  learned.set(windowKey(run)!, 1_000_000);
  assert.equal(knownWindow({ ...run, learned }), 1_000_000);
  assert.equal(knownWindow({ model: "claude-haiku-5-5", initModel: "claude-haiku-5-5", learned }), undefined, "another model's window isn't borrowed");
});

test("knownWindow: the [1m] marker beats a learned window", () => {
  const learned = new Map([["claude-opus-5-5[1m]", 200_000]]);
  assert.equal(knownWindow({ initModel: "claude-opus-5-5[1m]", learned }), 1_000_000);
});

test("windowKey: init's model, else the chosen one, else the message's; a date suffix goes, [1m] stays", () => {
  assert.equal(windowKey({ model: "claude-opus-5-5-20261001", initModel: "claude-opus-5-5[1m]", chosen: "x" }), "claude-opus-5-5[1m]");
  assert.equal(windowKey({ model: "claude-opus-5-5-20261001", chosen: "claude-opus-5-5" }), "claude-opus-5-5");
  assert.equal(windowKey({ model: "claude-opus-5-5-20261001" }), "claude-opus-5-5");
  assert.equal(windowKey({ initModel: "claude-opus-5-5-20261001[1m]" }), "claude-opus-5-5[1m]");
  assert.equal(windowKey({}), undefined);
});

test("contextOf: no window when it isn't known", () => {
  const c = contextOf({ used: 72_000, window: undefined, systemTools: 30_000, message: 1_000 });
  assert.equal("window" in c, false);
  assert.equal(c.used, 72_000);
});
