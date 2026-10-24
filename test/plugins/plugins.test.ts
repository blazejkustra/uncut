// Phase 7 chunk 1: the plugin host (D97).
// - discovery: UNCUT_PLUGINS_DIR, then <dataDir>/plugins, then the bundled folder; the first id
//   wins; broken manifests (not JSON, not the schema, not a process plugin, a built-in id) are
//   skipped with a sentence, never thrown; tool-name collisions leave that tool out with a warning;
// - the environment a plugin gets: no API keys, no Claude Code or Uncut variables;
// - the process host on its own: lazy start, a call, a crash then a restart (new pid), a timeout
//   that stops the process, stop leaves no process behind;
// - end to end on the bundled server with the scripted claude (helpers/fake-claude.ts, never the
//   real one) and the fake plugin (helpers/fake-plugin): tools/list has the plugin's tools,
//   modules_list shows source, approval and warnings, a call is refused before the user allows
//   it and works after (text and image pass through), the plugin's environment has no keys, the
//   turn card's step label, crash and restart, timeout, plugins.list/approve/revoke, approvals
//   in settings.json, and no plugin process left once the server stops.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverPlugins, isApproved, PluginHost, pluginAsks, toMcpResult, type ProcessSpec } from "../../apps/server/src/plugins/plugins.ts";
import { agentEnv, pluginEnv } from "../../apps/server/src/app/shellEnv.ts";
import { modulesList, stepLabel, SYSTEM_PROMPT, TOOL_NAMES } from "../../apps/server/src/agent/agentTools.ts";
import { loadModules, validateModule } from "../../packages/core/src/index.ts";
import { BUNDLE, MEDIA, MODULES, connect, killAll, startServer } from "../helpers/server.ts";

const FAKE_PLUGIN = resolve("test/helpers/fake-plugin");
const FAKE_SERVER = join(FAKE_PLUGIN, "server.ts");
const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE_CLAUDE = resolve("test/helpers/fake-claude.ts");
const KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "ELEVENLABS_API_KEY",
  "SOME_SERVICE_API_KEY",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "FAL_KEY",
  "REPLICATE_API_TOKEN",
  "HF_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_PROFILE",
  "STRIPE_SECRET",
  "db_password",
];
const manifest = JSON.parse(readFileSync(join(FAKE_PLUGIN, "uncut.module.json"), "utf8"));
const textIn = (r: { content: ReadonlyArray<{ type: string }> }) => (r.content[0] as unknown as { text: string }).text;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const gone = async (pid: number, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await sleep(50);
  return !alive(pid);
};

let root = "";
/** A plugin folder: the fake plugin's server.ts with this manifest (merged over the fake's). */
const plugin = (parent: string, folder: string, patch: Record<string, unknown> = {}) => {
  const dir = join(parent, folder);
  mkdirSync(dir, { recursive: true });
  cpSync(FAKE_SERVER, join(dir, "server.ts"));
  writeFileSync(join(dir, "uncut.module.json"), JSON.stringify({ ...manifest, ...patch }, null, 2));
  return realpathSync(dir);
};
const tool = (name: string) => ({ name, description: `The fake's ${name}.`, inputSchema: { type: "object" } });

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-plugins-")));
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the fake plugin's manifest and the extended schema: timeoutSeconds is bounded", () => {
  assert.deepEqual(validateModule(manifest), []);
  assert.deepEqual(validateModule({ ...manifest, runtime: { ...manifest.runtime, timeoutSeconds: 30 } }), []);
  assert.ok(validateModule({ ...manifest, runtime: { ...manifest.runtime, timeoutSeconds: 4000 } }).length > 0);
  // html modules (the built-ins) still need no command.
  assert.deepEqual(validateModule({ manifest: "uncut.module/0", id: "x.y", kind: "transition", name: "X", version: "1.0.0", runtime: { type: "html" } }), []);
});

test("discovery: folder order, the first id wins, broken manifests and tool collisions are reported, not thrown", async () => {
  const env = join(root, "discover/env");
  const user = join(root, "discover/user");
  const bundled = join(root, "discover/bundled");
  const fake = plugin(env, "fake");
  const shadowed = plugin(user, "fake-copy");
  const userOnly = plugin(user, "other", { id: "other.tool", name: "Other", agentTools: [tool("other_echo"), tool("project_read"), tool("fake_echo")] });
  plugin(env, "bad-tools", {
    id: "bad.tools",
    name: "Bad tools",
    agentTools: [
      tool("bad_ok"),
      { name: "a".repeat(53), description: "x", inputSchema: { type: "object" } },
      { name: "bad_schema", description: "x", inputSchema: { type: "string" } },
      { name: "bad_empty", description: "x", inputSchema: {} },
    ],
  });
  const shipped = plugin(bundled, "shipped", { id: "shipped.tool", name: "Shipped", capabilities: [], agentTools: [tool("shipped_echo")] });
  mkdirSync(join(env, "not-json"));
  writeFileSync(join(env, "not-json/uncut.module.json"), "{ nope");
  plugin(env, "bad-schema", { id: "Bad Id", version: "one" });
  plugin(env, "html", { id: "html.thing", runtime: { type: "html" } });
  plugin(env, "builtin-id", { id: "transition.crossfade" });
  plugin(env, "no-command", { id: "no.command", runtime: { type: "process" } });
  mkdirSync(join(env, "just-a-folder")); // no manifest: not a plugin, nothing to say
  writeFileSync(join(env, "stray.json"), "{}"); // files beside the folders are ignored

  const builtins = await loadModules(MODULES);
  const found = await discoverPlugins(
    [
      { source: "user", dir: env },
      { source: "user", dir: user },
      { source: "user", dir: join(root, "discover/missing") }, // a missing folder is no plugins
      { source: "bundled", dir: bundled },
    ],
    { moduleIds: new Set(builtins.keys()), toolNames: new Set(TOOL_NAMES) },
  );
  const badTools = found.plugins.find((p) => p.id === "bad.tools")!;
  assert.deepEqual(
    badTools.tools.map((t) => t.name),
    ["bad_ok"],
    "only tools Claude can take",
  );
  assert.deepEqual(badTools.warnings, [
    `Its tool ${"a".repeat(53)} is left out: a tool name can have at most 52 letters, digits, _ or -.`,
    'Its tool bad_schema is left out: its inputSchema must be an object schema ({"type":"object", ...}).',
    'Its tool bad_empty is left out: its inputSchema must be an object schema ({"type":"object", ...}).',
  ]);
  assert.deepEqual(
    found.plugins.filter((p) => p.id !== "bad.tools").map((p) => [p.id, p.source, p.dir]),
    [
      ["fake.capture", "user", fake],
      ["other.tool", "user", userOnly],
      ["shipped.tool", "bundled", shipped],
    ],
  );
  const fakeFound = found.plugins.find((p) => p.id === "fake.capture")!;
  assert.deepEqual(
    fakeFound.tools.map((t) => t.name),
    ["fake_echo", "fake_env", "fake_crash", "fake_sleep"],
  );
  assert.deepEqual(fakeFound.spec, {
    id: "fake.capture",
    name: "Fake capture",
    dir: fake,
    command: "node",
    args: ["server.ts", "--from-manifest"],
    timeoutMs: 120000,
  });
  // A tool Uncut has, or an earlier plugin has, is left out; the rest stay.
  const other = found.plugins.find((p) => p.id === "other.tool")!;
  assert.deepEqual(
    other.tools.map((t) => t.name),
    ["other_echo"],
  );
  assert.deepEqual(other.warnings, [
    "Its tool project_read is left out: Uncut has a tool with that name.",
    "Its tool fake_echo is left out: the plugin fake.capture has one with that name.",
  ]);

  const problems = Object.fromEntries(found.broken.map((b) => [b.dir.split("/").at(-1), b.problem]));
  assert.deepEqual(Object.keys(problems).sort(), ["bad-schema", "builtin-id", "fake-copy", "html", "no-command", "not-json"]);
  assert.match(problems["not-json"]!, /^Its uncut\.module\.json isn't valid JSON/);
  assert.match(problems["bad-schema"]!, /doesn't match the module format: \/id must match pattern/);
  assert.match(problems.html!, /only "process" and "data" plugins load/);
  assert.equal(problems["no-command"], "Its runtime has no command, so Uncut can't start it.");
  assert.equal(problems["builtin-id"], "Its id transition.crossfade belongs to a built-in module.");
  assert.equal(problems["fake-copy"], `Another plugin with the id fake.capture comes first (${fake}), so this one is skipped.`);
  assert.equal(found.broken.find((b) => b.dir === shadowed)?.source, "user");

  // Approval: bundled always; a user plugin for that folder and at least its capabilities.
  const approval = {
    dir: fake,
    version: "0.1.0",
    command: "node",
    args: ["server.ts", "--from-manifest"],
    capabilities: ["process:spawn", "media:write"],
    approvedAt: "x",
  };
  assert.equal(
    isApproved(
      found.plugins.find((p) => p.id === "shipped.tool")!,
      undefined,
    ),
    true,
  );
  assert.equal(isApproved(fakeFound, undefined), false);
  assert.equal(isApproved(fakeFound, approval), true);
  assert.equal(isApproved(fakeFound, { ...approval, dir: shadowed }), false, "another folder with the same id");
  assert.equal(isApproved(fakeFound, { ...approval, capabilities: ["media:write"] }), false, "it asks for more than was allowed");
  assert.equal(isApproved(fakeFound, { ...approval, command: "python3" }), false, "another command");
  assert.equal(isApproved(fakeFound, { ...approval, args: ["other.ts"] }), false, "other arguments");
  assert.deepEqual(pluginAsks(fakeFound), [
    "It runs as a program on this Mac with your rights: it can do anything you can, including reading and changing your files. Allow it only if you trust where it came from.",
    "It says it will start other programs and add media files.",
  ]);
});

test("a plugin's environment has no API keys, no Claude Code and no Uncut variables; the agent's has no keys", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/Users/x", LANG: "en_US.UTF-8", UNCUT_TOKEN: "t", UNCUT_DATA_DIR: "/d", ELECTRON_RUN_AS_NODE: "1" };
  for (const k of KEYS) env[k] = "secret";
  assert.deepEqual(Object.keys(pluginEnv(env)).sort(), ["HOME", "LANG", "PATH"]);
  const agent = agentEnv(env);
  for (const k of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "ELEVENLABS_API_KEY",
    "FAL_KEY",
    "REPLICATE_API_TOKEN",
    "HF_TOKEN",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
  ])
    assert.ok(!(k in agent), k);
  assert.equal(agent.UNCUT_DATA_DIR, "/d", "the agent keeps what it had");
});

test("tool results pass through: text and images; anything else as JSON text", () => {
  assert.deepEqual(
    toMcpResult({
      content: [
        { type: "text", text: "hi" },
        { type: "image", data: "AAA", mimeType: "image/png" },
        { type: "resource", uri: "x" },
      ],
    }),
    {
      content: [
        { type: "text", text: "hi" },
        { type: "image", data: "AAA", mimeType: "image/png" },
        { type: "text", text: '{"type":"resource","uri":"x"}' },
      ],
    },
  );
  const images = toMcpResult({
    content: [
      { type: "image", data: "R0lGODlhAQABAAAAACw=", mimeType: "image/gif" },
      { type: "image", data: "PHN2Zy8+", mimeType: "image/svg+xml" },
      { type: "image", data: "A".repeat(8 * 1024 * 1024), mimeType: "image/png" },
      { type: "image", data: "A".repeat(6 * 1024 * 1024), mimeType: "image/webp" },
    ],
  });
  assert.deepEqual(
    images.content.map((c) => (c.type === "image" ? c.mimeType : c.text)),
    [
      "image/gif",
      "(The plugin sent an image of type image/svg+xml; only PNG, JPEG, GIF and WebP are passed on, so it was left out.)",
      "(The plugin sent a 6 MB image; images over 5 MB are left out.)",
      "image/webp",
    ],
  );
  assert.deepEqual(toMcpResult({ isError: true, content: [{ type: "text", text: "no" }] }), { content: [{ type: "text", text: "no" }], isError: true });
  assert.deepEqual(toMcpResult({ structuredContent: { a: 1 } }), { content: [{ type: "text", text: '{"a":1}' }] });
  assert.equal(stepLabel("argent_record", {}, "Argent"), "Used argent_record from Argent");
  assert.equal(stepLabel("whatever", {}), "Used whatever");
  assert.ok(SYSTEM_PROMPT.includes("add tools that return data and never change the project: put what they give into it with timeline_edit"));
  assert.ok(
    modulesList(
      new Map([
        ["transition.cut", { manifest: "uncut.module/0", id: "transition.cut", kind: "transition", name: "Cut", version: "1.0.0", runtime: { type: "html" } }],
      ]),
    ).every((m) => m.source === "builtin"),
  );
});

test("the process host: lazy start, crash then restart, a timeout stops the process, stop leaves nothing behind", async () => {
  const dir = plugin(join(root, "host"), "fake");
  const log = join(root, "host/log.jsonl");
  writeFileSync(log, "");
  process.env.FAKE_PLUGIN_LOG = log;
  const host = new PluginHost();
  const spec: ProcessSpec = { id: "fake.capture", name: "Fake capture", dir, command: "node", args: ["server.ts"], timeoutMs: 800 };
  try {
    assert.equal(host.processOf(spec.id), undefined, "nothing runs before the first call");
    const echo = await host.call(spec, "fake_echo", { text: "hello" });
    assert.deepEqual(echo.content[0], { type: "text", text: "fake_echo: hello" });
    assert.equal(echo.content[1]?.type, "image");
    const first = host.processOf(spec.id)!.pid!;
    assert.equal(JSON.parse(textIn(await host.call(spec, "fake_env", {}))).pid, first, "one process for both calls");

    const crashed = await host.call(spec, "fake_crash", {});
    assert.equal(crashed.isError, true);
    assert.match((crashed.content[0] as { text: string }).text, /^Fake capture stopped \(exit code 3\)\. It starts again on the next call\.$/);
    assert.ok(await gone(first));
    const again = JSON.parse(textIn(await host.call(spec, "fake_env", {})));
    assert.notEqual(again.pid, first, "restarted");

    const slow = await host.call(spec, "fake_sleep", { ms: 5000 });
    assert.equal(slow.isError, true);
    assert.equal((slow.content[0] as { text: string }).text, "Fake capture didn't answer within 0.8 s, so Uncut stopped it. It starts again on the next call.");
    assert.ok(await gone(again.pid), "a timed-out plugin is stopped");
    assert.equal(host.processOf(spec.id), undefined);

    const fresh = JSON.parse(textIn(await host.call(spec, "fake_env", {}))).pid as number;
    await host.stopAll();
    assert.ok(await gone(fresh), "stopAll leaves no process");
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3, "three starts: the first, after the crash, after the timeout");
  } finally {
    await host.stopAll();
    delete process.env.FAKE_PLUGIN_LOG;
  }
});

test("the process host: a command that isn't there or exits at once is an error sentence, and restarts wait", async () => {
  const host = new PluginHost();
  const dir = plugin(join(root, "host2"), "fake");
  const missing = await host.call({ id: "a.b", name: "Missing", dir, command: "uncut-no-such-program", args: [], timeoutMs: 1000 }, "x", {});
  assert.deepEqual(missing, {
    content: [{ type: "text", text: "Couldn't start Missing: uncut-no-such-program isn't installed (not found on PATH)." }],
    isError: true,
  });
  const outside = await host.call({ id: "a.c", name: "Outside", dir, command: "../../bin/sh", args: [], timeoutMs: 1000 }, "x", {});
  assert.match((outside.content[0] as { text: string }).text, /its command \.\.\/\.\.\/bin\/sh is outside its folder/);
  const spec: ProcessSpec = { id: "a.d", name: "Quitter", dir, command: "node", args: ["-e", "process.exit(2)"], timeoutMs: 1000 };
  const t0 = Date.now();
  const r1 = await host.call(spec, "x", {});
  assert.match((r1.content[0] as { text: string }).text, /^Couldn't start Quitter: Quitter stopped \(exit code 2\)\.$/);
  await host.call(spec, "x", {});
  await host.call(spec, "x", {});
  assert.ok(Date.now() - t0 >= 250 + 500 - 50, "it waited longer before each restart");
  await host.stopAll();
});

test("the process host survives a misbehaving plugin: junk on stdout, requests to the host, a flood, a crash that leaves children, cancels, a revoke while starting", async () => {
  const dir = plugin(join(root, "host3"), "fake");
  const log = join(root, "host3/log.jsonl");
  writeFileSync(log, "");
  process.env.FAKE_PLUGIN_LOG = log;
  const entries = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const host = new PluginHost();
  const spec: ProcessSpec = { id: "fake.capture", name: "Fake capture", dir, command: "node", args: ["server.ts"], timeoutMs: 5000 };
  try {
    // null, [], 5, a string, {"id":null}, an answer to nothing (the reviewer's t1): ignored. A ping
    // gets {}, an unknown request -32601; the call still answers.
    const junk = await host.call(spec, "fake_junk", {});
    assert.deepEqual(junk, { content: [{ type: "text", text: "still here" }] });
    const replies = entries().filter((e) => e.reply);
    assert.deepEqual(
      replies.find((e) => e.reply === "p1"),
      { reply: "p1", result: {} },
    );
    assert.equal(replies.find((e) => e.reply === "s1").error.code, -32601);
    const pid = host.processOf(spec.id)!.pid!;

    // More than MAX_LINE without a newline: stopped, the call fails, memory stays bounded.
    const flood = await host.call(spec, "fake_flood", {});
    assert.equal(flood.isError, true);
    assert.match(textIn(flood), /^Fake capture stopped \(SIGKILL\): it sent more than 16 MB in one message\. It starts again on the next call\.$/);
    assert.ok(await gone(pid));

    // A plugin that crashes after starting a program: the program goes too (its process group).
    const orphan = JSON.parse(textIn(await host.call(spec, "fake_orphan", {}))).child as number;
    assert.ok(alive(orphan));
    assert.ok(await gone(orphan), "what a crashed plugin started is stopped with it");

    // The turn ends while the plugin is still starting (the reviewer's t2): cancelled at once.
    await host.stopAll();
    const early = new AbortController();
    setTimeout(() => early.abort(), 5);
    const t0 = Date.now();
    const cold = await host.call(spec, "fake_sleep", { ms: 1500 }, early.signal);
    assert.deepEqual(cold, { content: [{ type: "text", text: "The call was cancelled: the agent turn ended." }], isError: true });
    assert.ok(Date.now() - t0 < 1400, "it didn't wait for the sleep");

    // ...and mid-call: the plugin is told (notifications/cancelled).
    const mid = new AbortController();
    setTimeout(() => mid.abort(), 300);
    const cancelled = await host.call(spec, "fake_sleep", { ms: 3000 }, mid.signal);
    assert.equal(textIn(cancelled), "The call was cancelled: the agent turn ended.");
    await sleep(200);
    assert.ok(
      entries().some((e) => typeof e.cancelled === "number"),
      "the plugin got notifications/cancelled",
    );

    // Revoked while it was starting: the call is refused before it reaches the plugin.
    await host.stopAll();
    const refused = await host.call(spec, "fake_echo", { text: "x" }, undefined, async () => "Not allowed any more.");
    assert.deepEqual(refused, { content: [{ type: "text", text: "Not allowed any more." }], isError: true });

    // killAllNow also kills a plugin that is still starting.
    await host.stopAll();
    const slowStart = plugin(join(root, "host3"), "slow-start");
    writeFileSync(join(slowStart, "slow.ts"), "setInterval(() => {}, 1000);\n"); // never answers initialize
    const starting = host.call({ id: "slow.start", name: "Slow start", dir: slowStart, command: "node", args: ["slow.ts"], timeoutMs: 1000 }, "x", {});
    await sleep(500);
    const ps = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .find((l) => l.includes("slow.ts") && !l.includes("ps -axo"));
    assert.ok(ps, "the slow plugin is starting");
    const slowPid = Number(ps.trim().split(/\s+/)[0]);
    host.killAllNow();
    assert.ok(await gone(slowPid), "killAllNow stops a plugin that is still starting");
    assert.match(textIn(await starting), /^Couldn't start Slow start/);
  } finally {
    await host.stopAll();
    delete process.env.FAKE_PLUGIN_LOG;
  }
});

test("a command that is a symlink out of the plugin folder is refused", async () => {
  const dir = plugin(join(root, "host4"), "fake");
  symlinkSync("/bin/sh", join(dir, "run"));
  const host = new PluginHost();
  const r = await host.call({ id: "a.e", name: "Linked", dir, command: "./run", args: [], timeoutMs: 1000 }, "x", {});
  assert.deepEqual(r, { content: [{ type: "text", text: "Couldn't start Linked: its command ./run is outside its folder." }], isError: true });
  await host.stopAll();
});

// ---- end to end ----

const skip = !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA) ? "server bundle or media core not built (run pnpm build)" : false;

test("end to end: listed, refused until allowed, then called through the agent; env, crash, timeout, stop", { skip, timeout: 120000 }, async () => {
  const base = join(root, "e2e");
  const envDir = join(base, "env-plugins");
  const data = join(base, "data");
  const bundledDir = join(base, "bundled");
  const fakeDir = plugin(envDir, "fake", { agentTools: [...manifest.agentTools, tool("fake_junk")] });
  plugin(join(data, "plugins"), "fake-shadow"); // same id, found later: skipped
  const slowDir = plugin(envDir, "slow", {
    id: "slow.fake",
    name: "Slow fake",
    runtime: { type: "process", command: "node", args: ["server.ts", "--slow"], timeoutSeconds: 1 },
    agentTools: [tool("slow_sleep")],
  });
  plugin(bundledDir, "shipped", {
    id: "shipped.fake",
    name: "Shipped fake",
    capabilities: [],
    runtime: { type: "process", command: "node", args: ["server.ts", "--shipped"] },
    agentTools: [tool("shipped_echo")],
  });
  mkdirSync(join(envDir, "broken"));
  writeFileSync(join(envDir, "broken/uncut.module.json"), "not json");
  mkdirSync(join(base, "projects"));
  const shimDir = join(base, "bin");
  mkdirSync(shimDir);
  symlinkSync(process.execPath, join(shimDir, "node"));
  const files = {
    plan: join(base, "plan.json"),
    prompts: join(base, "prompts.jsonl"),
    results: join(base, "results.jsonl"),
    tools: join(base, "tools.jsonl"),
    pluginLog: join(base, "plugin.jsonl"),
  };
  for (const f of [files.prompts, files.results, files.tools, files.pluginLog]) writeFileSync(f, "");
  const keys = Object.fromEntries(KEYS.map((k) => [k, "secret-value"]));
  const server = await startServer({
    env: {
      ...keys,
      PATH: `${shimDir}:/usr/bin:/bin`,
      UNCUT_DATA_DIR: data,
      UNCUT_PLUGINS_DIR: envDir,
      UNCUT_BUNDLED_PLUGINS_DIR: bundledDir,
      UNCUT_CLAUDE: FAKE_CLAUDE,
      FAKE_PLAN: files.plan,
      FAKE_PROMPT_LOG: files.prompts,
      FAKE_RESULT_LOG: files.results,
      FAKE_TOOLS_LOG: files.tools,
      FAKE_PLUGIN_LOG: files.pluginLog,
    },
  });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    const agent = client.subscribe("agent.subscribe");
    const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "Plugins" });
    await agent.until((s) => s?.dir === snap.dir);
    const turns: Array<unknown> = [];
    const ask = async (prompt: string, steps: Array<unknown>) => {
      turns.push(steps);
      writeFileSync(files.plan, JSON.stringify(turns));
      const { turnId } = await client.ok("agent.send", { prompt });
      await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 60000);
      return agent.values.at(-1).turns.find((t: any) => t.id === turnId);
    };
    let seen = 0;
    const newResults = () => {
      const all = readFileSync(files.results, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const out = all.slice(seen);
      seen = all.length;
      return out;
    };
    const textOf = (r: any) => r.result.content[0].text as string;
    const pluginLog = () =>
      readFileSync(files.pluginLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    const pluginStarts = () => pluginLog().filter((e) => e.pid !== undefined);

    // plugins.list: what the Settings section shows.
    const listed = await client.ok("plugins.list");
    // The shadowed copy has the same id (listed as skipped), so the usable ones win here.
    const byId = Object.fromEntries(
      [...listed].sort((a: any, b: any) => Number(a.status !== "broken") - Number(b.status !== "broken")).map((p: any) => [p.id, p]),
    );
    assert.equal(byId["fake.capture"].status, "needs-approval");
    assert.equal(byId["fake.capture"].dir, fakeDir);
    assert.equal(byId["fake.capture"].source, "user");
    assert.deepEqual(byId["fake.capture"].tools, ["fake_echo", "fake_env", "fake_crash", "fake_sleep", "fake_junk"]);
    assert.match(byId["fake.capture"].asks[0], /runs as a program on this Mac with your rights/);
    assert.equal(byId["shipped.fake"].status, "ready", "bundled plugins are allowed");
    assert.equal(byId["shipped.fake"].source, "bundled");
    assert.equal(byId.broken.status, "broken");
    assert.match(byId.broken.problem, /isn't valid JSON/);
    const shadow = listed.filter((p: any) => p.id === "fake.capture" && p.status === "broken");
    assert.equal(shadow.length, 1, "the shadowed copy is listed as skipped");
    assert.match(shadow[0].problem, /comes first/);
    assert.equal(pluginStarts().length, 0, "listing starts nothing");

    // Turn 1: the tools are listed, modules_list shows the plugins, a call is refused, the bundled one works.
    const t1 = await ask("What plugins are there?", [
      { tool: "modules_list", args: {} },
      { tool: "fake_echo", args: { text: "hi" } },
      { tool: "shipped_echo", args: { text: "from the app" } },
    ]);
    assert.equal(t1.status, "done");
    const toolLists = readFileSync(files.tools, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.deepEqual(toolLists[0].slice(0, TOOL_NAMES.length).sort(), [...TOOL_NAMES].sort(), "the built-in tools come first");
    assert.deepEqual(toolLists[0].slice(TOOL_NAMES.length), ["shipped_echo"], "only allowed plugins' tools are listed");
    const [modules, refused, shipped] = newResults();
    // D285: without a kind, an index of the built-ins (id: purpose by kind) and the plugins as they are.
    const index = JSON.parse(textOf(modules));
    assert.equal(index.modules.transition["transition.crossfade"], "Crossfade");
    const list = index.plugins;
    const fakeEntry = list.find((m: any) => m.id === "fake.capture" && !m.skipped);
    assert.deepEqual(
      fakeEntry,
      // Not allowed yet: no description or tools from its manifest reach the agent.
      {
        id: "fake.capture",
        kind: "capture-source",
        name: "Fake capture",
        source: "user",
        plugin: true,
        approved: false,
        note: "Installed, but the user hasn't allowed it yet: its tools aren't available until they do (Uncut > Settings…, the Capture step, Plugins).",
      },
    );
    assert.equal(list.find((m: any) => m.id === "shipped.fake").approved, true);
    assert.equal(list.find((m: any) => m.id === "shipped.fake").source, "bundled");
    assert.ok(list.some((m: any) => m.id === "broken" && m.skipped && /isn't valid JSON/.test(m.warnings[0])));
    assert.ok(list.some((m: any) => m.id === "fake.capture" && m.skipped && /comes first/.test(m.warnings[0])));
    assert.equal(refused.result.isError, true);
    assert.match(textOf(refused), /^Fake capture \(fake\.capture\) isn't allowed to run yet\. The user has to allow it first/);
    assert.match(textOf(refused), /runs as a program on their Mac with their rights/);
    assert.equal(shipped.result.isError, undefined);
    assert.equal(textOf(shipped), "shipped_echo: from the app");
    const steps = t1.items.filter((i: any) => i.kind === "step");
    assert.deepEqual(
      steps.map((s: any) => [s.text, s.status]),
      [
        ["Checked the installed modules", "done"],
        ["Used fake_echo from Fake capture", "error"],
        ["Used shipped_echo from Shipped fake", "done"],
      ],
    );
    assert.equal(pluginStarts().filter((s) => s.argv.includes("--from-manifest")).length, 0, "a refused plugin isn't started");

    // The user allows it: saved in settings.json for that folder and those capabilities.
    const caps = ["process:spawn", "media:write"];
    // The approval names what the user saw: another folder, or fewer capabilities, is refused.
    assert.equal((await client.fail("plugins.approve", { id: "fake.capture", dir: slowDir, capabilities: caps })).reason, "changed");
    assert.equal((await client.fail("plugins.approve", { id: "fake.capture", dir: fakeDir, capabilities: ["media:write"] })).reason, "changed");
    const approved = await client.ok("plugins.approve", { id: "fake.capture", dir: fakeDir, capabilities: caps });
    assert.equal(approved.find((p: any) => p.id === "fake.capture" && p.status !== "broken").status, "ready");
    const saved = JSON.parse(readFileSync(join(data, "settings.json"), "utf8")).pluginApprovals["fake.capture"];
    assert.deepEqual(
      { dir: saved.dir, capabilities: saved.capabilities, version: saved.version, command: saved.command, args: saved.args },
      { dir: fakeDir, capabilities: caps, version: "0.1.0", command: "node", args: ["server.ts", "--from-manifest"] },
    );
    assert.equal((await client.fail("plugins.approve", { id: "nope.nope", dir: fakeDir, capabilities: [] }))._tag, "PluginError");
    assert.equal((await client.fail("plugins.revoke", { id: "shipped.fake" })).reason, "bundled");

    // Turn 2: the call goes through; text and image come back; the plugin's environment.
    const t2 = await ask("Use it", [
      { tool: "fake_echo", args: { text: "hi" } },
      { tool: "fake_env", args: {} },
    ]);
    assert.equal(t2.status, "done");
    const [echo, envResult] = newResults();
    assert.equal(textOf(echo), "fake_echo: hi");
    assert.equal(echo.result.content[1].type, "image");
    assert.equal(echo.result.content[1].mimeType, "image/png");
    const facts = JSON.parse(textOf(envResult));
    assert.deepEqual(facts.argv, ["--from-manifest"]);
    assert.equal(facts.cwd, fakeDir);
    for (const k of [...KEYS, "UNCUT_TOKEN", "UNCUT_DATA_DIR", "UNCUT_PLUGINS_DIR", "ELECTRON_RUN_AS_NODE", "UNCUT_AGENT_TOKEN"])
      assert.ok(!facts.env.includes(k), `${k} isn't passed to the plugin`);
    assert.ok(facts.env.includes("PATH") && facts.env.includes("FAKE_PLUGIN_LOG"));
    const firstPid = facts.pid as number;
    assert.ok(alive(firstPid), "it keeps running between calls");
    assert.deepEqual(toolLists.length, 1);
    const listedNow = readFileSync(files.tools, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .at(-1)
      .slice(TOOL_NAMES.length);
    assert.deepEqual(listedNow, ["fake_echo", "fake_env", "fake_crash", "fake_sleep", "fake_junk", "shipped_echo"], "allowed: its tools are listed");

    // Junk from the plugin on stdout (null, [], ...) and requests to the host don't hurt the server.
    const junkTurn = await ask("Junk", [
      { tool: "fake_junk", args: {} },
      { tool: "fake_env", args: {} },
    ]);
    assert.equal(junkTurn.status, "done");
    const [junk, envAgain] = newResults();
    assert.equal(textOf(junk), "still here");
    assert.equal(JSON.parse(textOf(envAgain)).pid, firstPid, "same process, server fine");

    // Stop during a long call: the plugin is told the call was cancelled.
    turns.push([{ tool: "fake_sleep", args: { ms: 20000 } }]);
    writeFileSync(files.plan, JSON.stringify(turns));
    const { turnId: longTurn } = await client.ok("agent.send", { prompt: "Take your time" });
    await agent.until((s) => s?.turns.some((t: any) => t.id === longTurn && t.items.some((i: any) => i.kind === "step")), 30000);
    await sleep(300);
    await client.ok("agent.cancel");
    await agent.until((s) => s?.turns.some((t: any) => t.id === longTurn && t.status === "cancelled"), 15000);
    const deadline = Date.now() + 5000;
    while (!pluginLog().some((e) => typeof e.cancelled === "number") && Date.now() < deadline) await sleep(50);
    assert.ok(
      pluginLog().some((e) => typeof e.cancelled === "number"),
      "the plugin got notifications/cancelled",
    );

    // Turn 3: it crashes; the next call starts it again.
    const t3 = await ask("Crash it", [
      { tool: "fake_crash", args: {} },
      { tool: "fake_env", args: {} },
    ]);
    assert.equal(t3.status, "done");
    const [crash, after] = newResults();
    assert.equal(crash.result.isError, true);
    assert.match(textOf(crash), /^Fake capture stopped \(exit code 3\)/);
    const secondPid = JSON.parse(textOf(after)).pid as number;
    assert.notEqual(secondPid, firstPid);
    assert.ok(await gone(firstPid));

    // Turn 4: a call longer than the plugin's timeout fails, and that process is stopped.
    await client.ok("plugins.approve", { id: "slow.fake", dir: slowDir, capabilities: caps });
    const t4 = await ask("Wait", [{ tool: "slow_sleep", args: { ms: 10000 } }]);
    assert.equal(t4.status, "done");
    const [slow] = newResults();
    assert.equal(slow.result.isError, true);
    assert.equal(textOf(slow), "Slow fake didn't answer within 1 s, so Uncut stopped it. It starts again on the next call.");
    const slowPid = pluginStarts().find((s) => s.argv.includes("--slow")).pid as number;
    assert.ok(await gone(slowPid), "the timed-out plugin was stopped");
    assert.equal(pluginStarts().find((s) => s.argv.includes("--slow")).cwd, slowDir);

    // Revoking stops it and refuses again.
    await client.ok("plugins.revoke", { id: "fake.capture" });
    assert.ok(await gone(secondPid), "revoking stops the plugin");
    const t5 = await ask("Again", [{ tool: "fake_echo", args: { text: "x" } }]);
    assert.equal(t5.status, "done");
    assert.match(textOf(newResults()[0]), /isn't allowed to run yet/);
    await client.ok("plugins.approve", { id: "fake.capture", dir: fakeDir, capabilities: caps });
    await ask("Once more", [{ tool: "fake_env", args: {} }]);
    const lastPid = JSON.parse(textOf(newResults()[0])).pid as number;
    const shippedPid = pluginStarts().find((s) => s.argv.includes("--shipped")).pid as number;
    assert.ok(alive(lastPid) && alive(shippedPid));

    // The server stops: no plugin process is left.
    client.close();
    await server.stop();
    assert.ok(await gone(lastPid), "the plugin stopped with the server");
    assert.ok(await gone(shippedPid), "the bundled plugin stopped with the server");
    const leftovers = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes(base) || l.includes("--from-manifest"));
    assert.deepEqual(
      leftovers.filter((l) => l.includes("server.ts")),
      [],
      "no plugin process left",
    );
  } finally {
    client.close();
    await server.stop();
  }
});

test("a server killed outright (SIGKILL) leaves no plugin behind: the plugin's stdin closes and it exits", { skip, timeout: 60000 }, async () => {
  const base = join(root, "sigkill");
  const bundledDir = join(base, "bundled");
  plugin(bundledDir, "shipped", {
    id: "shipped.fake",
    name: "Shipped fake",
    capabilities: [],
    runtime: { type: "process", command: "node", args: ["server.ts", "--shipped"] },
    agentTools: [tool("shipped_env")],
  });
  mkdirSync(join(base, "projects"));
  const shimDir = join(base, "bin");
  mkdirSync(shimDir);
  symlinkSync(process.execPath, join(shimDir, "node"));
  const plan = join(base, "plan.json");
  const results = join(base, "results.jsonl");
  writeFileSync(plan, JSON.stringify([[{ tool: "shipped_env", args: {} }]]));
  writeFileSync(results, "");
  const server = await startServer({
    env: {
      PATH: `${shimDir}:/usr/bin:/bin`,
      UNCUT_DATA_DIR: join(base, "data"),
      UNCUT_PLUGINS_DIR: "",
      UNCUT_BUNDLED_PLUGINS_DIR: bundledDir,
      UNCUT_CLAUDE: FAKE_CLAUDE,
      FAKE_PLAN: plan,
      FAKE_PROMPT_LOG: join(base, "prompts.jsonl"),
      FAKE_RESULT_LOG: results,
    },
  });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    const agent = client.subscribe("agent.subscribe");
    const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "Kill" });
    await agent.until((s) => s?.dir === snap.dir);
    const { turnId } = await client.ok("agent.send", { prompt: "go" });
    await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 30000);
    const result = JSON.parse(readFileSync(results, "utf8").trim().split("\n")[0]!).result;
    const pid = JSON.parse(result.content[0].text).pid as number;
    assert.ok(alive(pid));
    server.proc.kill("SIGKILL");
    await server.exited;
    assert.ok(await gone(pid), "the plugin exited when the server's end of its stdin closed");
  } finally {
    client.close();
    await server.stop();
  }
});
