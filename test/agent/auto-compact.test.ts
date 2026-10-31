// A conversation is summarised at about 250k, and the agent reloads its brief, kit and graphic after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPACT_HOOKS, sessionSettings } from "../../apps/server/src/agent/permissions/settings.ts";
import { AUTO_COMPACT_WINDOW, sessionEnv } from "../../apps/server/src/agent/session/config.ts";

test("Uncut's window wins over one from outside", () => {
  const env = sessionEnv({ PATH: "/usr/bin", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "900000" });
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, String(AUTO_COMPACT_WINDOW));
});

test("sign-in variables pass next to the window", () => {
  const env = sessionEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "t" });
  assert.equal(env.ANTHROPIC_API_KEY, "k");
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "t");
});

test("every access gets the compaction hooks, and they run with no shell metacharacter inside the text", () => {
  for (const access of ["auto", "ask", "look"] as const) {
    assert.deepEqual(JSON.parse(sessionSettings({ access })).hooks, JSON.parse(JSON.stringify(COMPACT_HOOKS)));
  }
  const commands = [...COMPACT_HOOKS.PreCompact, ...COMPACT_HOOKS.SessionStart].flatMap((h) => h.hooks.map((x) => x.command));
  for (const command of commands) assert.match(command, /^echo '[^']+'$/);
  assert.match(commands[1]!, /plan_read and brand_read/);
});
