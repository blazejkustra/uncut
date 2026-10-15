// D218: usage limits, rate limits and sign-in problems in the Agent tab's words (agentLimits.ts,
// modelled on t3code's ClaudeAdapterV2), and the environment every claude gets (claudeEnv).
import { test } from "node:test";
import assert from "node:assert/strict";

import { formatWait, onRateLimit, resultError, resultFailed, signedOutMessage, turnLimits } from "../../apps/server/src/agent/agentLimits.ts";
import { claudeEnv } from "../../apps/server/src/app/shellEnv.ts";
import { sessionArgs, sessionEnv } from "../../apps/server/src/agent/agent.ts";
import { criticArgs } from "../../apps/server/src/agent/agentCritic.ts";

const NOW = 1_800_000_000_000;
const inSeconds = (s: number) => NOW / 1000 + s;

test("formatWait: minutes, hours, both", () => {
  assert.equal(formatWait(45 * 60_000), "45m");
  assert.equal(formatWait(3 * 3_600_000), "3h");
  assert.equal(formatWait(125 * 60_000 - 1), "2h 5m");
});

test("a rejected window pauses the turn with one notice per window; an allowed one clears it", () => {
  const l = turnLimits();
  const first = onRateLimit(l, { status: "rejected", rateLimitType: "five_hour", resetsAt: inSeconds(7500) }, NOW);
  assert.equal(first.notice, "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 2h 5m. Wait, or press Stop and send it again later.");
  assert.deepEqual(onRateLimit(l, { status: "rejected", rateLimitType: "five_hour", resetsAt: inSeconds(7500) }, NOW), {}, "repeats say nothing");
  assert.match(onRateLimit(l, { status: "rejected", rateLimitType: "seven_day_opus" }, NOW).notice ?? "", /until the 7-day Opus limit resets\./, "no reset time: no wait");
  assert.deepEqual(onRateLimit(l, { status: "allowed", rateLimitType: "five_hour" }, NOW), { cleared: false }, "another window is still rejected");
  assert.deepEqual(onRateLimit(l, { status: "allowed", rateLimitType: "seven_day_opus" }, NOW), { cleared: true });
});

test("warnings and overage keep running: no notice", () => {
  const l = turnLimits();
  assert.deepEqual(onRateLimit(l, { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: inSeconds(60) }, NOW), {});
  assert.deepEqual(onRateLimit(l, { status: "rejected", rateLimitType: "five_hour", overageStatus: "allowed" }, NOW), {});
  assert.equal(l.rejected.size, 0);
  assert.match(onRateLimit(l, { status: "rejected", rateLimitType: "weird_new" }, NOW).notice ?? "", /until the limit resets\./, "an unknown window has no label");
  assert.match(onRateLimit(turnLimits(), { status: "rejected", rateLimitType: "constructor" }, NOW).notice ?? "", /until the limit resets\./, "no prototype lookups");
});

test("resultError: usage limit with the latest reset, 429, 529, give-ups, sign-in", () => {
  const l = turnLimits();
  onRateLimit(l, { status: "rejected", rateLimitType: "five_hour", resetsAt: inSeconds(600) }, NOW);
  onRateLimit(l, { status: "rejected", rateLimitType: "seven_day", resetsAt: inSeconds(7500) }, NOW);
  assert.equal(resultError({ subtype: "success", is_error: true, api_error_status: 429, result: "API Error: 429" }, l, NOW), "Claude usage limit reached. Send the message again once the limit resets (in 2h 5m).");
  const rl = turnLimits();
  rl.rateLimited = true;
  assert.equal(resultError({ subtype: "error_during_execution", is_error: true }, rl, NOW), "Claude usage limit reached. Send the message again once the limit resets.");
  assert.equal(resultError({ subtype: "success", is_error: false, terminal_reason: "blocking_limit" }, turnLimits(), NOW), "Claude usage limit reached. Send the message again once the limit resets.");
  assert.equal(resultError({ subtype: "success", is_error: true, api_error_status: 429 }, turnLimits(), NOW), "Claude API rate limit reached. Try again later.");
  assert.equal(resultError({ subtype: "success", is_error: true, api_error_status: 529 }, turnLimits(), NOW), "Claude API is overloaded (529). Try again shortly.");
  assert.equal(resultError({ subtype: "success", is_error: true, api_error_status: 529 }, l, NOW), "Claude API is overloaded (529). Try again shortly.", "a 529 isn't the usage limit");
  assert.equal(resultError({ subtype: "success", is_error: false, terminal_reason: "prompt_too_long" }, turnLimits(), NOW), "Claude stopped: the prompt exceeds the model's context window.");
  assert.equal(resultError({ subtype: "error_during_execution", is_error: true, result: "something else" }, turnLimits(), NOW), undefined, "claude's own words stay");
  assert.equal(resultError({ subtype: "success", is_error: true, terminal_reason: "constructor" }, turnLimits(), NOW), undefined);
  const auth = turnLimits();
  auth.authFailed = true;
  assert.equal(resultError({ is_error: true, api_error_status: 429 }, auth, NOW, "/x/.claude"), signedOutMessage("/x/.claude"), "sign-in first");
  assert.match(resultError({ is_error: true, result: "Not logged in · Please run /login" }, turnLimits(), NOW) ?? "", /^Claude Code isn't signed in\. Run `claude auth login` in Terminal/);
  assert.match(signedOutMessage("/x/.claude"), /CLAUDE_CONFIG_DIR is "\/x\/\.claude"/);
});

test("resultFailed: a success result that still failed", () => {
  assert.equal(resultFailed({ subtype: "success", is_error: false }), false);
  assert.equal(resultFailed({ subtype: "success", is_error: false, terminal_reason: "completed" }), false);
  assert.equal(resultFailed({ subtype: "success", is_error: false, api_error_status: 529 }), true);
  assert.equal(resultFailed({ subtype: "success", is_error: false, terminal_reason: "blocking_limit" }), true);
});

test("claudeEnv: no keys, no inherited entrypoint or SDK identity, Node switches out, Uncut's client id in", () => {
  const env = claudeEnv(
    { HOME: "/h", PATH: "/bin", CLAUDE_CONFIG_DIR: "/h/.c", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDECODE: "1", CLAUDE_AGENT_SDK_VERSION: "0.3.276", CLAUDE_AGENT_SDK_CLIENT_APP: "x/1", NODE_OPTIONS: "--inspect", DEBUG: "*" },
    "1.2.3",
  );
  assert.deepEqual(env, { HOME: "/h", PATH: "/bin", CLAUDE_CONFIG_DIR: "/h/.c", CLAUDE_AGENT_SDK_CLIENT_APP: "uncut/1.2.3" });
  const session = sessionEnv({ HOME: "/h", CLAUDE_CODE_ENTRYPOINT: "cli" });
  assert.equal(session.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.match(session.CLAUDE_AGENT_SDK_CLIENT_APP!, /^uncut\//);
});

test("argv: the user's claude in print mode, no API key or entrypoint flags; thinking as the SDK passes it", () => {
  const argv = sessionArgs({ cfg: "/tmp/m.json", thinking: "summarized" });
  assert.equal(argv[0], "-p");
  assert.deepEqual(argv.slice(argv.indexOf("--thinking"), argv.indexOf("--thinking") + 4), ["--thinking", "adaptive", "--thinking-display", "summarized"]);
  assert.ok(!sessionArgs({ cfg: "/tmp/m.json" }).includes("--thinking"), "no thinking display: no --thinking either");
  for (const args of [argv, criticArgs(undefined)]) assert.ok(!args.some((a) => /api-key|entrypoint|--bare/i.test(a)), args.join(" "));
});
