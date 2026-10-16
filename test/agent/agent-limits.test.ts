// D218: usage limits, rate limits and sign-in problems in the Agent tab's words (agentLimits.ts,
// modelled on t3code's ClaudeAdapterV2), and the environment every claude gets (claudeEnv).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatWait, onRateLimit, resultError, resultFailed, signedOutMessage, turnLimits } from "../../apps/server/src/agent/agentLimits.ts";
import { agentEnv, awaitShellFrom, claudeEnv, pluginEnv, settingsArg, shellAuthReady, toolEnv, userAuthSettings, withoutApiKey } from "../../apps/server/src/app/shellEnv.ts";
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

test("auth and billing errors say which sign-in Claude Code used (its init's apiKeySource), never a key", () => {
  // The rehearsal's failure: a gave-up result after "Credit balance is too low" on an environment key.
  const credit = { subtype: "success", is_error: true, terminal_reason: "api_error", result: "Credit balance is too low" };
  assert.equal(
    resultError(credit, turnLimits(), NOW, undefined, { keySource: "ANTHROPIC_API_KEY", keyWhere: "environment" }),
    `Claude's API refused the request: "Credit balance is too low". Claude Code used ANTHROPIC_API_KEY from the environment, which has no credit. Unset it to use your Claude subscription, or top up that key.`,
  );
  assert.match(resultError(credit, turnLimits(), NOW, undefined, { keySource: "ANTHROPIC_API_KEY", keyWhere: "settings" }) ?? "", /ANTHROPIC_API_KEY from Claude Code's settings .*Remove it from settings\.json to use your Claude subscription, or top up that key\./);
  assert.match(resultError(credit, turnLimits(), NOW, undefined, { keySource: "apiKeyHelper" }) ?? "", /the key from its apiKeyHelper setting, which has no credit\. Remove apiKeyHelper/);
  assert.match(resultError(credit, turnLimits(), NOW, undefined, { keySource: "/login managed key" }) ?? "", /API key from its Anthropic Console login, which has no credit\. Run `claude auth login`/);
  // The subscription case: no API key, so the plan's usage or extra-usage credit ran out.
  assert.match(resultError(credit, turnLimits(), NOW, undefined, { keySource: "none" }) ?? "", /"Credit balance is too low"\. Claude Code used your Claude account sign-in \(no API key\).*claude\.ai/);
  // No apiKeySource (an older claude): the words and a generic hint.
  assert.match(resultError(credit, turnLimits(), NOW) ?? "", /^Claude's API refused the request: "Credit balance is too low"\. Check the credit/);
  // A billing_error on an assistant message carries the words when the result only says it gave up.
  const billed = turnLimits();
  billed.billingFailed = true;
  billed.billingText = "Your credit balance is too low to access the Anthropic API.";
  assert.match(resultError({ is_error: true, terminal_reason: "api_error", result: "" }, billed, NOW, undefined, { keySource: "ANTHROPIC_API_KEY" }) ?? "", /^Claude's API refused the request: "Your credit balance is too low to access the Anthropic API\."\. Claude Code used ANTHROPIC_API_KEY from the environment/);
  // A rejected key isn't "not signed in": it names the key.
  const bad = turnLimits();
  bad.authFailed = true;
  assert.equal(
    resultError({ is_error: true, result: "Invalid API key · Fix external API key" }, bad, NOW, undefined, { keySource: "ANTHROPIC_API_KEY", keyWhere: "environment" }),
    `Claude Code's API key was rejected ("Invalid API key · Fix external API key"). Claude Code used ANTHROPIC_API_KEY from the environment, which was rejected. Unset it to use your Claude subscription, or replace that key.`,
  );
  assert.equal(resultError({ is_error: true, result: "Not logged in" }, turnLimits(), NOW, "/c", { keySource: "none" }), signedOutMessage("/c"));
  // Never a key's value: only names and places.
  assert.doesNotMatch(resultError(credit, turnLimits(), NOW, undefined, { keySource: "ANTHROPIC_API_KEY" }) ?? "", /sk-ant/);
});

test("resultFailed: a success result that still failed", () => {
  assert.equal(resultFailed({ subtype: "success", is_error: false }), false);
  assert.equal(resultFailed({ subtype: "success", is_error: false, terminal_reason: "completed" }), false);
  assert.equal(resultFailed({ subtype: "success", is_error: false, api_error_status: 529 }), true);
  assert.equal(resultFailed({ subtype: "success", is_error: false, terminal_reason: "blocking_limit" }), true);
});

test("D277 claudeEnv: Claude Code's own sign-in passes through, other keys don't, no inherited entrypoint or SDK identity, Uncut's client id in", () => {
  const env = claudeEnv(
    {
      HOME: "/h", PATH: "/bin", CLAUDE_CONFIG_DIR: "/h/.c", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "https://gw", ANTHROPIC_SOMETHING_TOKEN: "x", CLAUDE_CODE_OAUTH_TOKEN: "o",
      CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "dev", AWS_SECRET_ACCESS_KEY: "s", CLOUD_ML_REGION: "global", GOOGLE_APPLICATION_CREDENTIALS: "/h/g.json", AZURE_TENANT_ID: "az",
      OPENAI_API_KEY: "x", GOOGLE_API_KEY: "x", ELEVENLABS_API_KEY: "x", GH_TOKEN: "x", NPM_TOKEN: "x",
      CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDECODE: "1", CLAUDE_AGENT_SDK_VERSION: "0.3.276", CLAUDE_AGENT_SDK_CLIENT_APP: "x/1", NODE_OPTIONS: "--inspect", DEBUG: "*",
    },
    "1.2.3",
  );
  // Bedrock is on: AWS_* go; Vertex and Foundry are off: their variables don't; an undocumented ANTHROPIC_*_TOKEN doesn't.
  assert.deepEqual(env, {
    HOME: "/h", PATH: "/bin", CLAUDE_CONFIG_DIR: "/h/.c", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "https://gw", CLAUDE_CODE_OAUTH_TOKEN: "o",
    CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "dev", AWS_SECRET_ACCESS_KEY: "s",
    CLAUDE_AGENT_SDK_CLIENT_APP: "uncut/1.2.3",
  });
  // ...and to no other process Uncut starts.
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "CLAUDE_CODE_USE_BEDROCK"]) {
    assert.equal(agentEnv({ [k]: "v" })[k], undefined, k);
    assert.equal(pluginEnv({ [k]: "v" })[k], undefined, k);
  }
  const session = sessionEnv({ HOME: "/h", CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "k" });
  assert.equal(session.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(session.ANTHROPIC_API_KEY, "k");
  assert.match(session.CLAUDE_AGENT_SDK_CLIENT_APP!, /^uncut\//);
});

test("D277 review: cloud credentials reach claude only with that provider switched on", () => {
  const cloudy = { HOME: "/h", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "s", AWS_PROFILE: "work", GOOGLE_APPLICATION_CREDENTIALS: "/g.json", CLOUDSDK_CONFIG: "/c", CLOUD_ML_REGION: "us", GCLOUD_PROJECT: "p", AZURE_CLIENT_SECRET: "z", AZURE_TENANT_ID: "t" };
  // A Claude login with day-job cloud keys in the shell: none of them go.
  const plain = claudeEnv(cloudy, "1");
  for (const k of Object.keys(cloudy)) if (k !== "HOME") assert.equal(plain[k], undefined, k);
  const vertex = claudeEnv({ ...cloudy, CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "p" }, "1");
  assert.deepEqual(Object.keys(vertex).filter((k) => k !== "HOME" && k !== "CLAUDE_AGENT_SDK_CLIENT_APP").sort(), ["ANTHROPIC_VERTEX_PROJECT_ID", "CLAUDE_CODE_USE_VERTEX", "CLOUDSDK_CONFIG", "CLOUD_ML_REGION", "GCLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS"]);
  const foundry = claudeEnv({ ...cloudy, CLAUDE_CODE_USE_FOUNDRY: "1" }, "1");
  assert.equal(foundry.AZURE_CLIENT_SECRET, "z");
  assert.equal(foundry.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(claudeEnv({ ...cloudy, CLAUDE_CODE_USE_BEDROCK: "0" }, "1").AWS_PROFILE, undefined, "0 is off");
  assert.equal(claudeEnv({ ...cloudy, CLAUDE_CODE_USE_MANTLE: "true" }, "1").AWS_PROFILE, "work", "Mantle uses AWS too");
});

test("D277 review: the tools around claude (ffmpeg, probes, analysers) get no sign-in variable or secret", () => {
  const env = toolEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "u", CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "p", AZURE_TENANT_ID: "t", CLOUDSDK_CONFIG: "c", GH_TOKEN: "g", MY_PASSWORD: "x", OPENAI_API_KEY: "x" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
  assert.equal(withoutApiKey, toolEnv, "the old name is the same function");
});

test("D277: a sign-in set up in Claude Code's user settings reaches the session and the critic despite --setting-sources \"\", with the commands in a 0600 file", () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-cc-settings-"));
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ apiKeyHelper: "~/bin/key.sh", awsAuthRefresh: "aws sso login", hooks: { Stop: [] }, permissions: { allow: ["Bash"] }, env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-west-1", OPENAI_API_KEY: "x", FOO: "bar" } }));
    const read = userAuthSettings({ CLAUDE_CONFIG_DIR: dir });
    assert.deepEqual(read, { env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-west-1" }, settings: { apiKeyHelper: "~/bin/key.sh", awsAuthRefresh: "aws sso login" } });
    // The settings' Bedrock switch turns on the shell's AWS profile too.
    const session = sessionEnv({ HOME: "/h", CLAUDE_CONFIG_DIR: dir, AWS_PROFILE: "work" });
    assert.deepEqual([session.CLAUDE_CODE_USE_BEDROCK, session.AWS_REGION, session.AWS_PROFILE, session.OPENAI_API_KEY], ["1", "eu-west-1", "work", undefined]);
    // The commands go in a 0600 file, never on argv; without any, the JSON stays inline.
    const own = { permissions: { deny: ["Read(~/.ssh/**)"] } };
    const file = settingsArg(dir, own, read.settings);
    assert.equal(file, join(dir, "claude-settings.json"));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { apiKeyHelper: "~/bin/key.sh", awsAuthRefresh: "aws sso login", permissions: { deny: ["Read(~/.ssh/**)"] } });
    assert.equal(settingsArg(dir, own, {}), JSON.stringify(own));
    const argv = sessionArgs({ cfg: "/tmp/m.json", settings: file });
    assert.equal(argv[argv.indexOf("--settings") + 1], file);
    assert.ok(!argv.join(" ").includes("key.sh") && !argv.join(" ").includes("eu-west-1"), "nothing of the user's on the command line");
    assert.deepEqual(criticArgs(undefined, file).slice(-2), ["--settings", file]);
    assert.equal(criticArgs(undefined).includes("--settings"), false);
    assert.deepEqual(userAuthSettings({ CLAUDE_CONFIG_DIR: join(dir, "missing") }), { env: {}, settings: {} });
    // Read again only when it changes; more than 1 MB is ignored.
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ apiKeyHelper: "/other.sh", pad: "x".repeat(1024 * 1024) }));
    assert.deepEqual(userAuthSettings({ CLAUDE_CONFIG_DIR: dir }), { env: {}, settings: {} }, "over 1 MB: nothing");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ apiKeyHelper: "/other.sh" }));
    assert.equal(userAuthSettings({ CLAUDE_CONFIG_DIR: dir }).settings.apiKeyHelper, "/other.sh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D277 review: claude waits for the login shell's answer, but not forever", async () => {
  let release!: () => void;
  awaitShellFrom(new Promise<void>((r) => (release = r)));
  let done = false;
  const waiting = shellAuthReady(5000).then(() => (done = true));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done, false, "still waiting for the shell");
  release();
  await waiting;
  awaitShellFrom(new Promise(() => {}));
  const started = Date.now();
  await shellAuthReady(50);
  assert.ok(Date.now() - started < 1000, "a shell that never answers is waited for only up to the limit");
  awaitShellFrom(Promise.resolve());
});

test("D219 argv: the session's --settings keep Uncut's data folder out", () => {
  const argv = sessionArgs({ cfg: "/tmp/m.json", dataDir: "/Users/me/Library/Application Support/Uncut" });
  const deny = JSON.parse(argv[argv.indexOf("--settings") + 1]!).permissions.deny as Array<string>;
  assert.ok(deny.includes("Edit(//Users/me/Library/Application Support/Uncut/**)") && deny.includes("Read(//Users/me/Library/Application Support/Uncut/server-token)") && deny.includes("Bash(*Application Support*)"));
});

test("argv: the user's claude in print mode, no API key or entrypoint flags; thinking as the SDK passes it", () => {
  const argv = sessionArgs({ cfg: "/tmp/m.json", thinking: "summarized" });
  assert.equal(argv[0], "-p");
  assert.deepEqual(argv.slice(argv.indexOf("--thinking"), argv.indexOf("--thinking") + 4), ["--thinking", "adaptive", "--thinking-display", "summarized"]);
  assert.ok(!sessionArgs({ cfg: "/tmp/m.json" }).includes("--thinking"), "no thinking display: no --thinking either");
  for (const args of [argv, criticArgs(undefined)]) assert.ok(!args.some((a) => /api-key|entrypoint|--bare/i.test(a)), args.join(" "));
});
