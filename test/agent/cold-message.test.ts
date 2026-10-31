// The composer's warning before a message that rewrites the whole context (coldMessage.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import { CACHE_TTL_MS, coldMessage } from "../../apps/web/src/state/coldMessage.ts";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const context = (used: number, idleMs: number, more: Record<string, unknown> = {}) => ({
  used,
  systemTools: 0,
  conversation: used,
  message: 0,
  model: "claude-opus-5-5",
  answeredAt: ago(idleMs),
  ...more,
});

test("warns past the hour and over 200k, never at or under either line", () => {
  assert.deepEqual(coldMessage(context(450_000, CACHE_TTL_MS + 1), NOW), { tokens: 450_000 });
  assert.equal(coldMessage(context(450_000, CACHE_TTL_MS), NOW), undefined);
  assert.equal(coldMessage(context(200_000, CACHE_TTL_MS + 1), NOW), undefined);
});

test("dollars only when an API key pays for the model the rate was fitted on", () => {
  assert.equal(coldMessage(context(450_000, CACHE_TTL_MS + 1, { billedToKey: true }), NOW)?.dollars, 3.6);
  assert.equal(coldMessage(context(450_000, CACHE_TTL_MS + 1, { billedToKey: true, model: "claude-opus-5-5[1m]" }), NOW)?.dollars, 3.6);
  assert.equal(coldMessage(context(450_000, CACHE_TTL_MS + 1, { billedToKey: true, model: "claude-haiku-5" }), NOW)?.dollars, undefined);
  assert.equal(coldMessage(context(450_000, CACHE_TTL_MS + 1), NOW)?.dollars, undefined);
});

test("no answer time (Codex, an older save) or no context: no warning", () => {
  assert.equal(coldMessage(undefined, NOW), undefined);
  assert.equal(coldMessage({ used: 450_000, systemTools: 0, conversation: 450_000, message: 0 }, NOW), undefined);
});
