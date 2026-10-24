// D261 (issue #93): the context meter's numbers from claude's stream-json usage (usage.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLAUDE_CODE_BASE_TOKENS,
  assistantUsage,
  contextOf,
  estimateTokens,
  messageContextEstimate,
  resultWindow,
  systemToolsEstimate,
  windowFor,
} from "../../apps/server/src/agent/session/usage.ts";

const assistant = (usage: unknown, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  message: { id: "m1", model: "claude-opus-5-5", content: [], usage },
  parent_tool_use_id: null,
  ...extra,
});

test("assistantUsage: the call's input, cache read, cache creation and output", () => {
  assert.deepEqual(assistantUsage(assistant({ input_tokens: 12, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 1_500, output_tokens: 400 })), {
    used: 31_912,
    model: "claude-opus-5-5",
  });
});

test("assistantUsage: missing or odd fields count as 0; no usage or none at all is undefined", () => {
  assert.deepEqual(assistantUsage(assistant({ input_tokens: 5000 })), { used: 5000, model: "claude-opus-5-5" });
  assert.deepEqual(assistantUsage(assistant({ input_tokens: "7", cache_read_input_tokens: -3, output_tokens: 10 })), { used: 10, model: "claude-opus-5-5" });
  assert.equal(assistantUsage(assistant(undefined)), undefined);
  assert.equal(assistantUsage(assistant({})), undefined);
  assert.equal(assistantUsage({ type: "user", message: { usage: { input_tokens: 9 } } }), undefined);
  const noModel = { type: "assistant", message: { usage: { input_tokens: 9 } } };
  assert.deepEqual(assistantUsage(noModel), { used: 9, model: undefined });
});

test("assistantUsage: a subagent's message (parent_tool_use_id) isn't the conversation's context", () => {
  assert.equal(assistantUsage(assistant({ input_tokens: 90_000 }, { parent_tool_use_id: "toolu_1" })), undefined);
});

test("resultWindow: modelUsage's contextWindow for the model, else the only or largest one", () => {
  const result = (modelUsage: unknown) => ({ type: "result", usage: { input_tokens: 999_999 }, modelUsage });
  const two = { "claude-haiku-5-5": { contextWindow: 200_000 }, "claude-opus-5-5": { contextWindow: 1_000_000 } };
  assert.equal(resultWindow(result(two), "claude-haiku-5-5"), 200_000);
  assert.equal(resultWindow(result(two), "claude-opus-5-5[1m]"), 1_000_000, "the [1m] suffix still finds its entry");
  assert.equal(resultWindow(result({ "claude-opus-5-5-20261001": { contextWindow: 200_000 } }), "claude-opus-5-5"), 200_000, "a dated key");
  assert.equal(resultWindow(result({ "claude-sonnet-5-5": { contextWindow: 200_000 } }), "other"), 200_000, "the only entry");
  assert.equal(resultWindow(result(two), undefined), 1_000_000, "the largest when none matches");
  assert.equal(resultWindow(result({ x: { costUSD: 1 } }), "x"), undefined, "no contextWindow");
  assert.equal(resultWindow(result(undefined), "x"), undefined);
  assert.equal(resultWindow({ type: "assistant", modelUsage: two }, "claude-opus-5-5"), undefined);
});

test("windowFor: [1m] in the model id is 1M, else unknown (D269: never a guessed 200k)", () => {
  assert.equal(windowFor("claude-opus-5-5[1m]"), 1_000_000);
  assert.equal(windowFor("claude-opus-5-5"), undefined);
  assert.equal(windowFor(undefined), undefined);
});

test("estimates: prose at 4 characters a token, JSON at 2.4, plus Claude Code's own", () => {
  assert.equal(estimateTokens(4000), 1000);
  assert.equal(estimateTokens(2400, "json"), 1000);
  assert.equal(systemToolsEstimate(40_000, 24_000), CLAUDE_CODE_BASE_TOKENS + 20_000);
  const message = `do it\n\n<editor-context>\n${"x".repeat(395)}\n</editor-context>`;
  assert.equal(messageContextEstimate(message, "do it"), Math.round((message.length - 5) / 4));
  assert.equal(messageContextEstimate("hi", "hi"), 0);
});

test("contextOf: the conversation is the rest, never below 0; parts never exceed what was used", () => {
  assert.deepEqual(contextOf({ used: 100_000, window: 200_000, systemTools: 30_000, message: 2_000, model: "m" }), {
    used: 100_000,
    window: 200_000,
    systemTools: 30_000,
    conversation: 68_000,
    message: 2_000,
    model: "m",
  });
  const small = contextOf({ used: 10_000, window: 200_000, systemTools: 30_000, message: 2_000 });
  assert.deepEqual(small, { used: 10_000, window: 200_000, systemTools: 10_000, conversation: 0, message: 0 });
});
