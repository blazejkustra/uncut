// Round 3 agent feedback (U1-U6, D181-D185) on the bundled server with fake-claude's session:
// the spawned claude's command line and environment (isolation, tool loading, thinking display), the
// fallback when claude refuses --thinking-display, model/effort choices restarting with --resume,
// failed tool calls with their reason, empty thinking dropped, the now line's present-tense target
// while a call streams in, access modes (Look only, Ask first), attached images, moment
// and range chips with what's on screen, and edits landing one by one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(BUNDLE) && existsSync(MCP) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";

interface Run {
  prompt: string;
  resume: string | null;
  pid: number;
  argv: Array<string>;
  envValues: Record<string, string | null>;
  env: Array<string>;
  alwaysLoad: boolean | null;
  images: Array<{ media_type: string; bytes: number }>;
  system: string;
  refused?: string;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flagValue = (argv: Array<string>, flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
// A 1x1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let root = "";
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});
before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-round3-")));
});

async function setup(name: string, env: Record<string, string> = {}) {
  const base = join(root, name);
  mkdirSync(join(base, "projects"), { recursive: true });
  const plan = join(base, "plan.json");
  const log = join(base, "prompts.jsonl");
  writeFileSync(log, "");
  const server = await startServer({
    env: { UNCUT_DATA_DIR: join(base, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan, FAKE_PROMPT_LOG: log, UNCUT_APPROVAL_MS: "8000", ...env },
  });
  const client = await connect(server.ready.port, server.ready.token);
  const agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "P" });
  await agent.until((s) => s?.dir === snap.dir);
  const turns: Array<unknown> = [];
  const latest = () => agent.values.at(-1);
  const turn = (id: string) => latest()?.turns.find((t: { id: string }) => t.id === id);
  const self = {
    server,
    client,
    agent,
    dir: snap.dir as string,
    turn,
    lines: (): Array<Run> =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    runs: (): Array<Run> => self.lines().filter((r) => !r.refused),
    start: async (prompt: string, steps: Array<unknown>, extra: Record<string, unknown> = {}) => {
      turns.push(steps);
      writeFileSync(plan, JSON.stringify(turns));
      const { turnId } = await client.ok("agent.send", { prompt, ...extra });
      return turnId as string;
    },
    done: async (id: string) => {
      await agent.until(() => turn(id) && turn(id).status !== "running", 20000);
      return turn(id);
    },
    ask: async (prompt: string, steps: Array<unknown>, extra: Record<string, unknown> = {}) => self.done(await self.start(prompt, steps, extra)),
    stop: async () => {
      client.close();
      await server.stop();
    },
  };
  return self;
}

test(
  "U3/U2/U1: claude runs isolated from the user's Claude Code config, with every Uncut tool loaded and thinking summaries asked for",
  { skip, timeout: 60000 },
  async () => {
    const s = await setup("argv", {
      ANTHROPIC_API_KEY: "sk-test-passes-through",
      CLAUDE_CONFIG_DIR: join(root, "argv", "claude-config"),
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "0",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_AGENT_SDK_VERSION: "9.9.9",
      CLAUDE_AGENT_SDK_CLIENT_APP: "someone-else/1.0",
    });
    try {
      const t = await s.ask("hello", [{ tool: "project_read" }]);
      assert.equal(t.status, "done", t.error);
      const run = s.runs()[0]!;
      const argv = run.argv;
      assert.equal(flagValue(argv, "--setting-sources"), "", "no user, project or local settings: no hooks, plugins, rules or MCP servers of the user's");
      assert.ok(argv.includes("--strict-mcp-config"), "only Uncut's MCP server");
      // D194: Claude Code's own tools the agent uses, every prompt answered by Uncut over stdio.
      assert.equal(flagValue(argv, "--tools"), "Bash,Read,Write,Edit,WebFetch,WebSearch,Skill", "only the built-in tools the agent uses");
      assert.equal(flagValue(argv, "--allowedTools"), "mcp__uncut");
      assert.equal(flagValue(argv, "--permission-mode"), "auto", "D214: no access sent is Auto, Claude Code's own auto mode");
      assert.equal(flagValue(argv, "--permission-prompt-tool"), "stdio");
      assert.equal(flagValue(argv, "--thinking-display"), "summarized", "thinking summaries in print mode");
      // D260 amended: the current system prompt on every request, a resumed conversation included.
      assert.equal(flagValue(argv, "--system-prompt-snapshot"), "off");
      // D218: as the Agent SDK passes t3code's thinking: { type: "adaptive", display: "summarized" }.
      assert.equal(flagValue(argv, "--thinking"), "adaptive");
      assert.ok(!argv.includes("--bare"), "no --bare: it would skip the keychain login");
      assert.ok(!/showThinkingSummaries/.test(flagValue(argv, "--settings") ?? ""), "no dead showThinkingSummaries setting");
      assert.ok(JSON.parse(flagValue(argv, "--settings")!).permissions.deny.includes("Read(~/.ssh/**)"), "D194: the secret deny rules");
      assert.ok(!argv.includes("--model") && !argv.includes("--effort"), "no choice made: Claude Code's defaults");
      assert.equal(run.alwaysLoad, true, "the uncut MCP server is alwaysLoad: never deferred behind tool search");
      assert.equal(run.envValues.ENABLE_TOOL_SEARCH, "false");
      assert.equal(run.envValues.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1", "Uncut's value, not the one from outside");
      assert.equal(run.envValues.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
      assert.equal(run.envValues.ANTHROPIC_API_KEY, "sk-test-passes-through", "D277: Claude Code gets the sign-in it was set up with, an API key included");
      assert.equal(run.envValues.CLAUDE_CONFIG_DIR, join(root, "argv", "claude-config"), "the login's config dir is untouched");
      // D218: claude names its own entrypoint; Uncut identifies itself only through the SDK's documented client-app variable.
      assert.equal(run.envValues.CLAUDE_CODE_ENTRYPOINT, null, "no entrypoint from outside, none made up");
      assert.equal(run.envValues.CLAUDE_AGENT_SDK_VERSION, null, "not presented as the Agent SDK");
      assert.match(run.envValues.CLAUDE_AGENT_SDK_CLIENT_APP ?? "", /^uncut\/\d+\.\d+\.\d+/, "Uncut's own client id, not an inherited one");
      assert.ok(!argv.some((a) => /api-key|apiKey/i.test(a)), "no API key on the command line");
      assert.match(
        run.system,
        /always call the full name \(mcp__uncut__graphic_write/,
        "the prompt names the full tool names (761de95: always call mcp__uncut__<name>)",
      );
      assert.match(run.system, /follows the production process: docs_read production first/, "U6: the process (scene by scene) is one docs_read away");
      assert.match(run.prompt, /<editor-context>[\s\S]*Access: Auto\./);
    } finally {
      await s.stop();
    }
  },
);

test(
  "U1: a claude that refuses --thinking-display is started again without it, the message goes through, and it isn't passed again",
  { skip, timeout: 60000 },
  async () => {
    const s = await setup("nothinking", { FAKE_NO_THINKING_DISPLAY: "1" });
    try {
      const t = await s.ask("first", [{ tool: "project_read" }]);
      assert.equal(t.status, "done", t.error);
      const lines = s.lines();
      assert.equal(lines[0]!.refused, "--thinking-display", "the first start was refused");
      assert.ok(!s.runs()[0]!.argv.includes("--thinking-display"), "started again without it");
      assert.equal(s.runs()[0]!.prompt.split("\n\n")[0], "first");
      // A new session (another effort) doesn't try it again.
      const t2 = await s.ask("second", [{ text: "ok" }], { effort: "low" });
      assert.equal(t2.status, "done", t2.error);
      assert.equal(s.lines().filter((l) => l.refused).length, 1, "refused once only");
      assert.ok(!s.runs()[1]!.argv.includes("--thinking-display"));
    } finally {
      await s.stop();
    }
  },
);

test(
  "D260: a claude that refuses --system-prompt-snapshot is started again without it, the message goes through, and it isn't passed again",
  { skip, timeout: 60000 },
  async () => {
    const s = await setup("nosnapshot", { FAKE_NO_PROMPT_SNAPSHOT: "1" });
    try {
      const t = await s.ask("first", [{ tool: "project_read" }]);
      assert.equal(t.status, "done", t.error);
      assert.equal(s.lines()[0]!.refused, "--system-prompt-snapshot", "the first start was refused");
      assert.ok(!s.runs()[0]!.argv.includes("--system-prompt-snapshot"), "started again without it");
      assert.ok(s.runs()[0]!.argv.includes("--append-system-prompt"), "still with the prompt");
      const t2 = await s.ask("second", [{ text: "ok" }], { effort: "low" });
      assert.equal(t2.status, "done", t2.error);
      assert.equal(s.lines().filter((l) => l.refused).length, 1, "refused once only");
      assert.ok(!s.runs()[1]!.argv.includes("--system-prompt-snapshot"));
    } finally {
      await s.stop();
    }
  },
);

test(
  "U4: model and effort go to claude; another choice starts claude again with --resume; an unknown model is Claude Code's default",
  { skip, timeout: 60000 },
  async () => {
    const s = await setup("model");
    try {
      const a = await s.ask("one", [{ text: "a" }], { model: "claude-opus-5-5", effort: "high" });
      assert.equal(a.status, "done", a.error);
      assert.equal(a.model, "claude-opus-5-5", "the card knows the model");
      const b = await s.ask("two", [{ text: "b" }], { model: "claude-opus-5-5", effort: "high" });
      assert.equal(b.status, "done");
      const c = await s.ask("three", [{ text: "c" }], { model: "claude-sonnet-5-5", effort: "max" });
      assert.equal(c.status, "done");
      const d = await s.ask("four", [{ text: "d" }], { model: "gpt-9" });
      assert.equal(d.status, "done");
      const runs = s.runs();
      assert.equal(flagValue(runs[0]!.argv, "--model"), "claude-opus-5-5");
      assert.equal(flagValue(runs[0]!.argv, "--effort"), "high");
      assert.equal(runs[1]!.pid, runs[0]!.pid, "same choice, same claude");
      assert.notEqual(runs[2]!.pid, runs[1]!.pid, "another model: another claude");
      assert.equal(flagValue(runs[2]!.argv, "--model"), "claude-sonnet-5-5");
      assert.equal(flagValue(runs[2]!.argv, "--effort"), "max");
      assert.equal(flagValue(runs[2]!.argv, "--resume"), "fake-session", "it continues the conversation");
      assert.ok(!runs[3]!.argv.includes("--model"), "an unknown model id isn't passed on");
      assert.equal(d.model, undefined);
    } finally {
      await s.stop();
    }
  },
);

test(
  "U2/U1: failed calls show ✕ with why; empty thinking isn't kept; a call streaming in says what it's doing with its target",
  { skip, timeout: 60000 },
  async () => {
    const s = await setup("steps");
    try {
      const gate = join(root, "steps", "gate.json");
      const html = `<div>${"x".repeat(4000)}</div>`;
      const id = await s.start("make scene 3", [
        { think: "" },
        { missing: "graphic_write", args: { name: "s1-hook.html", html: "<div></div>" } },
        { tool: "timeline_edit", args: { baseRevision: 999, summary: "Scene 1", ops: [] } },
        { tool: "graphic_write", args: { name: "s3-enter.html", html }, slowInput: 400 },
        { await: gate },
      ]);
      // While the graphic's input streams in: the step is running and says what it writes.
      await s.agent.until(
        () => s.turn(id)?.items.some((i: any) => i.kind === "step" && i.status === "running" && i.doing === "Writing graphic s3-enter.html"),
        10000,
      );
      writeFileSync(gate, "[]");
      const t = await s.done(id);
      assert.equal(t.status, "done", t.error);
      assert.ok(!t.items.some((i: any) => i.kind === "thinking"), "an empty thinking block isn't a row");
      const steps = t.items.filter((i: any) => i.kind === "step");
      const missing = steps[0];
      assert.equal(missing.status, "error");
      assert.equal(missing.error, "Error: No such tool available: graphic_write", "claude's own reason, without its tags");
      const refused = steps[1];
      assert.equal(refused.status, "error");
      assert.match(refused.error, /baseRevision|ops/, "Uncut's reason is kept on the step");
      const wrote = steps[2];
      assert.equal(wrote.status, "done");
      assert.equal(wrote.error, undefined);
      assert.ok(
        steps.every((x: any) => x.doing === undefined),
        "doing goes when a step ends",
      );
    } finally {
      await s.stop();
    }
  },
);

test("U4 access: Look only refuses changes with why; Ask first puts a removal on a card (Don't refuses, Allow applies)", { skip, timeout: 60000 }, async () => {
  const s = await setup("access");
  try {
    const title = { id: "title-1", type: "text", start: 0, duration: 60, text: "Hello" };
    const look = await s.ask(
      "add a title",
      [
        { tool: "project_read" },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Title", ops: [{ op: "insert_item", track: "text", item: title }] } },
      ],
      { access: "look" },
    );
    assert.equal(look.status, "done");
    const step = look.items.filter((i: any) => i.kind === "step")[1];
    assert.equal(step.status, "error");
    assert.match(step.error, /Look only/);
    assert.equal(look.edits.length, 0);
    assert.match(s.runs()[0]!.prompt, /Access: Look only\./);
    // Ask: a small insert goes straight through.
    const add = await s.ask(
      "add it",
      [
        { tool: "project_read" },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Title", ops: [{ op: "insert_item", track: "text", item: title }] } },
      ],
      { access: "ask" },
    );
    assert.equal(add.edits.length, 1, "a small edit doesn't ask");
    // A removal waits for the card.
    const del = { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Remove the title", ops: [{ op: "delete_item", item: "title-1" }] } };
    const id1 = await s.start("remove it", [{ tool: "project_read" }, del], { access: "ask" });
    const card = (await s.agent.until((v) => v?.approval?.turnId === id1, 10000), s.agent.values.at(-1).approval);
    assert.match(card.text, /^Apply "Remove the title" \(1 change\)$/);
    assert.ok(card.edit.lines.length === 1 && /Hello|title/i.test(card.edit.lines[0]), JSON.stringify(card.edit));
    await s.client.ok("agent.approve", { id: card.id, allow: false });
    const no = await s.done(id1);
    assert.equal(no.edits.length, 0);
    assert.match(no.items.filter((i: any) => i.kind === "step")[1].error, /said no/);
    const id2 = await s.start("remove it now", [{ tool: "project_read" }, del], { access: "ask" });
    const card2 = (await s.agent.until((v) => v?.approval?.turnId === id2, 10000), s.agent.values.at(-1).approval);
    await s.client.ok("agent.approve", { id: card2.id, allow: true });
    const yes = await s.done(id2);
    assert.equal(yes.edits.length, 1, "allowed: the removal is applied");
  } finally {
    await s.stop();
  }
});

test(
  "U4 images: attached images reach claude as image blocks, are kept in .cache/agent-images and served for the card; too many or too big are refused",
  { skip, timeout: 60000 },
  async () => {
    const s = await setup("images");
    try {
      const t = await s.ask("use this logo", [{ text: "ok" }], { images: [{ name: "logo.png", mimeType: "image/png", data: PNG }] });
      assert.equal(t.status, "done", t.error);
      assert.deepEqual(s.runs()[0]!.images, [{ media_type: "image/png", bytes: Buffer.from(PNG, "base64").length }]);
      assert.equal(t.images.length, 1);
      const file = join(s.dir, ".cache", "agent-images", t.images[0]);
      assert.ok(existsSync(file));
      const url = `http://127.0.0.1:${s.server.ready.port}/media/agent-image/${t.images[0]}?token=${encodeURIComponent(s.server.ready.token)}`;
      const res = await fetch(url);
      assert.equal(res.status, 200);
      assert.equal(Buffer.from(await res.arrayBuffer()).toString("base64"), PNG);
      assert.equal((await fetch(url.replace(/\?token=.*/, "?token=wrong"))).status, 401);
      assert.equal((await fetch(url.replace(t.images[0], "..%2Fsecret.png"))).status, 404);
      const many = await s.client.fail("agent.send", {
        prompt: "x",
        images: Array.from({ length: 5 }, (_, i) => ({ name: `${i}.png`, mimeType: "image/png", data: PNG })),
      });
      assert.match(many.message, /at most 4/);
      const big = await s.client.fail("agent.send", {
        prompt: "x",
        images: [{ name: "big.png", mimeType: "image/png", data: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }],
      });
      assert.match(big.message, /over 5 MB/);
    } finally {
      await s.stop();
    }
  },
);

test(
  "U5 moments: a moment and a range chip give claude the frames and what's on the timeline there; the card keeps the timecodes",
  { skip, timeout: 60000 },
  async () => {
    const s = await setup("moments");
    try {
      await s.client.ok("project.edit", {
        ops: [{ op: "insert_item", track: "text", item: { id: "title-1", type: "text", start: 300, duration: 120, text: "Kraków from above" } }],
      });
      const t = await s.ask("make @0:12 bigger and calm @0:05–0:08 down", [{ text: "ok" }], {
        mentions: [
          { kind: "moment", id: "frame:360", label: "0:12", frame: 360 },
          { kind: "range", id: "range:150-240", label: "0:05–0:08", range: { start: 150, end: 240 } },
        ],
      });
      assert.equal(t.status, "done", t.error);
      const prompt = s.runs()[0]!.prompt;
      assert.match(
        prompt,
        /@0:12 = the moment at frame 360 \(12\.00 s\): on the timeline there: title-1 \(text "Kraków from above", track text, frames 300–420\)/,
      );
      assert.match(prompt, /@0:05–0:08 = the stretch from frame 150 to 240 \(5\.00 s–8\.00 s, end not included\): nothing on the timeline there/);
      assert.deepEqual(t.mentions, [
        { kind: "moment", label: "0:12" },
        { kind: "range", label: "0:05–0:08" },
      ]);
    } finally {
      await s.stop();
    }
  },
);

test("U6 progress: several edits in one turn land one by one (each published before the next starts)", { skip, timeout: 60000 }, async () => {
  const s = await setup("progress");
  try {
    const scene = (n: number) => [
      { tool: "project_read" },
      {
        tool: "timeline_edit",
        args: {
          baseRevision: "$rev",
          summary: `Scene ${n}`,
          ops: [{ op: "insert_item", track: "text", item: { id: `scene-${n}`, type: "text", start: (n - 1) * 60, duration: 60, text: `Scene ${n}` } }],
        },
      },
      { tool: "ui_show", args: { frame: (n - 1) * 60 } },
      { sleep: 300 },
    ];
    const id = await s.start("build three scenes", [...scene(1), ...scene(2), ...scene(3)]);
    const t = await s.done(id);
    assert.equal(t.status, "done", t.error);
    assert.deepEqual(
      t.edits.map((e: any) => e.summary),
      ["Scene 1", "Scene 2", "Scene 3"],
    );
    // Every count from 1 to 3 was seen on its own while the turn ran.
    const counts = s.agent.values
      .map((v: any) => v?.turns.find((x: any) => x.id === id))
      .filter((x: any) => x?.status === "running")
      .map((x: any) => x.edits.length);
    for (const n of [1, 2, 3]) assert.ok(counts.includes(n), `${n} edit(s) published while running: ${[...new Set(counts)].join(",")}`);
    // ui_show followed each scene.
    const frames = [...new Set(s.agent.values.map((v: any) => v?.ui?.frame).filter((f: any) => f !== undefined))];
    assert.deepEqual(frames, [0, 60, 120]);
    await sleep(10);
  } finally {
    await s.stop();
  }
});

test(
  "D266: after claude compacts (system/compact_boundary) the next message carries <brand> and <plan> whole; plan_read reads the plan back",
  { skip, timeout: 60000 },
  async () => {
    const results = join(root, "compact-results.jsonl");
    writeFileSync(results, "");
    const s = await setup("compact", { FAKE_RESULT_LOG: results });
    try {
      writeFileSync(join(s.dir, "brief.json"), JSON.stringify({ film: "a teaser for Acme", audience: "developers", by: "agent" }));
      const planOf = (i: number) => s.runs()[i]!.prompt.match(/<plan>\n([^]*?)\n<\/plan>/)?.[1] ?? "";
      assert.equal((await s.ask("one", [{ text: "ok" }])).status, "done");
      assert.match(planOf(0), /a teaser for Acme/, "the first message has the plan whole");
      assert.equal((await s.ask("two", [{ text: "ok" }])).status, "done");
      assert.match(planOf(1), /^Unchanged since your last message[^\n]*plan_read/, "unchanged: one line naming plan_read");
      // Claude Code compacts during this turn (auto, or /compact).
      assert.equal(
        (
          await s.ask("three", [
            { raw: { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 150000 } } },
            { text: "ok" },
          ])
        ).status,
        "done",
      );
      assert.match(planOf(2), /^Unchanged/);
      const t4 = await s.ask("four", [{ tool: "plan_read" }, { text: "ok" }]);
      assert.equal(t4.status, "done", t4.error);
      assert.match(planOf(3), /a teaser for Acme/, "after the compaction: whole again");
      assert.match(s.runs()[3]!.prompt, /<brand>\nNo brand kit is chosen/, "the brand block whole too");
      assert.equal(s.runs()[3]!.pid, s.runs()[0]!.pid, "the same claude (not a new session)");
      const read = readFileSync(results, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((x) => x.tool === "plan_read");
      assert.match(JSON.stringify(read?.result), /a teaser for Acme/, "plan_read gives the brief");
    } finally {
      await s.stop();
    }
  },
);
