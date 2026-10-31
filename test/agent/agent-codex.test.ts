// Issue #106 on the bundled server with fake-codex (`codex app-server`): a message sent with
// provider "codex" runs in one long-lived app-server per chat (a thread started, then turns in it);
// Uncut's tools reach it through the same MCP server, pre-approved, and its edits undo as one turn;
// text and thinking stream; the token meter follows Codex's usage; Stop interrupts the turn and the
// session lives on; Ask first sends Codex's command approvals to a card; a crash resumes the thread
// and a lost thread starts fresh; usage-limit and sign-in failures are said in words; switching to
// Claude Code starts its own conversation (no Codex thread id as --resume); the setup row reports
// Codex's sign-in from its app-server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE_CODEX = resolve("test/helpers/fake-codex.ts");
const FAKE_CLAUDE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(BUNDLE) && existsSync(MCP) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";

interface Run {
  prompt: string;
  resume: string | null;
  threadId: string;
  pid: number;
  mcpPid: number;
  mcpToken: string;
  threadConfig: {
    cwd: string;
    sandbox: string;
    approvalPolicy: string;
    model?: string;
    developerInstructions: string;
    mcp: Array<string>;
    mcpApproval: string | null;
  };
  approvals: Array<{ command: string; decision: string }>;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let root = "";
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});
before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-codex-")));
});

async function setup(name: string, env: Record<string, string> = {}) {
  const base = join(root, name);
  mkdirSync(join(base, "projects"), { recursive: true });
  const plan = join(base, "plan.json");
  const log = join(base, "prompts.jsonl");
  const toolsLog = join(base, "tools.jsonl");
  for (const f of [log, toolsLog]) if (!existsSync(f)) writeFileSync(f, "");
  const server = await startServer({
    env: {
      UNCUT_DATA_DIR: join(base, "data"),
      UNCUT_CODEX: FAKE_CODEX,
      UNCUT_CLAUDE: FAKE_CLAUDE,
      FAKE_PLAN: plan,
      FAKE_PROMPT_LOG: log,
      FAKE_TOOLS_LOG: toolsLog,
      ...env,
    },
  });
  const client = await connect(server.ready.port, server.ready.token);
  const agent = client.subscribe("agent.subscribe");
  // The same data folder again opens the project the last server made.
  const made = join(base, "projects", "P.uncut");
  const snap = existsSync(made)
    ? await client.ok("project.open", { dir: made })
    : await client.ok("project.create", { parentDir: join(base, "projects"), name: "P" });
  await agent.until((s) => s?.dir === snap.dir);
  const turns: Array<unknown> = existsSync(plan) ? JSON.parse(readFileSync(plan, "utf8")) : [];
  const latest = () => agent.values.at(-1);
  const turn = (id: string) => latest()?.turns.find((t: { id: string }) => t.id === id);
  const self = {
    client,
    agent,
    dir: snap.dir as string,
    latest,
    turn,
    runs: (): Array<Run> =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    toolLists: () => readFileSync(toolsLog, "utf8").trim().split("\n").filter(Boolean),
    start: async (prompt: string, steps: Array<unknown>, extra: Record<string, unknown> = {}) => {
      turns.push(steps);
      writeFileSync(plan, JSON.stringify(turns));
      const { turnId } = await client.ok("agent.send", { prompt, provider: "codex", ...extra });
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
  "issue #106: Codex runs the chat in one app-server: streamed text and thinking, Uncut's tools through MCP, an edit undone as one turn, the meter from its usage",
  { skip, timeout: 90000 },
  async () => {
    const s = await setup("basic");
    try {
      const first = await s.ask(
        "what's in the project?",
        [
          { think: "Looking at the project first." },
          { tool: "project_read" },
          { usage: { input: 30_000, output: 500 }, window: 258_400 },
          { text: "The project is empty, ready for a title." },
        ],
        { model: "gpt-6.1-sol", effort: "high" },
      );
      assert.equal(first.status, "done", first.error);
      assert.deepEqual(
        first.items.map((i: any) => [i.kind, i.kind === "step" ? i.status : i.text]),
        [
          ["thinking", "Looking at the project first."],
          ["step", "done"],
          ["text", "The project is empty, ready for a title."],
        ],
      );
      assert.equal(first.items[1].tool, "project_read");
      assert.equal(first.model, "gpt-6.1-sol");
      const ctx = s.latest()!.context;
      assert.equal(ctx.used, 30_500);
      assert.equal(ctx.window, 258_400);

      const second = await s.ask(
        "add a title",
        [
          { tool: "project_read" },
          {
            tool: "timeline_edit",
            args: {
              baseRevision: "$rev",
              summary: "Add a title",
              ops: [{ op: "insert_item", track: "text", item: { id: "hello-title", type: "text", start: 0, duration: 30, text: "Hello" } }],
            },
          },
          { text: "Added the title." },
        ],
        { model: "gpt-6.1-sol", effort: "high" },
      );
      assert.equal(second.status, "done", second.error);
      assert.equal(second.edits.length, 1, "the edit is the turn's");
      assert.equal(second.undo.state, "available");

      const runs = s.runs();
      assert.equal(runs.length, 2);
      assert.equal(runs[0]!.pid, runs[1]!.pid, "one app-server for both messages");
      assert.equal(runs[0]!.threadId, runs[1]!.threadId, "one thread");
      assert.equal(runs[0]!.resume, null, "a new chat starts a thread");
      assert.equal(s.toolLists().length, 1, "the MCP server listed its tools once");
      const cfg = runs[0]!.threadConfig;
      assert.equal(cfg.cwd, s.dir);
      assert.equal(cfg.model, "gpt-6.1-sol");
      assert.deepEqual([cfg.sandbox, cfg.approvalPolicy], ["workspace-write", "on-request"], "Auto");
      assert.deepEqual(cfg.mcp, ["uncut"]);
      assert.equal(cfg.mcpApproval, "approve", "Uncut's own tools aren't asked about by Codex");
      assert.match(cfg.developerInstructions, /MCP server "uncut"/);
      assert.doesNotMatch(cfg.developerInstructions, /mcp__uncut__|Claude Code's own tools/);
      assert.match(runs[0]!.prompt, /what's in the project\?/);

      await s.client.ok("agent.undoTurn", { turnId: second.id });
      const snap = await s.client.ok("project.get");
      assert.equal(JSON.stringify(snap.project).includes("hello-title"), false, "undone");
    } finally {
      await s.stop();
    }
  },
);

test("issue #106: Stop interrupts the Codex turn and the app-server lives on; Look only is a read-only sandbox", { skip, timeout: 60000 }, async () => {
  const s = await setup("stop");
  try {
    const id = await s.start("take your time", [{ text: "Starting.", slow: 0 }, { sleep: 30000 }, { text: "never" }], { access: "look" });
    await s.agent.until(() => s.turn(id)?.items.some((i: any) => i.text === "Starting."), 10000);
    await s.client.ok("agent.cancel", {});
    const t = await s.done(id);
    assert.equal(t.status, "cancelled");
    const next = await s.ask("again", [{ text: "Back." }], { access: "look" });
    assert.equal(next.status, "done", next.error);
    const runs = s.runs();
    assert.equal(runs[0]!.pid, runs[1]!.pid, "the interrupt didn't kill the app-server");
    assert.deepEqual([runs[0]!.threadConfig.sandbox, runs[0]!.threadConfig.approvalPolicy], ["read-only", "never"]);
  } finally {
    await s.stop();
  }
});

test("issue #106: Ask first sends Codex's command approvals to a card: Allow runs it, Deny declines it", { skip, timeout: 60000 }, async () => {
  const s = await setup("ask");
  try {
    const id = await s.start(
      "clean up",
      [{ command: "rm -rf ~/Desktop/old-renders", approval: true }, { command: "rm -rf ~/Desktop/other", approval: true }, { text: "Done." }],
      { access: "ask" },
    );
    await s.agent.until(() => !!s.latest()?.approval, 10000);
    const one = s.latest()!.approval;
    assert.equal(one.permission.tool, "Bash");
    assert.equal(one.permission.target, "rm -rf ~/Desktop/old-renders");
    await s.client.ok("agent.approve", { id: one.id, allow: true });
    await s.agent.until(() => s.latest()?.approval && s.latest()!.approval.id !== one.id, 10000);
    const two = s.latest()!.approval;
    assert.equal(two.permission.target, "rm -rf ~/Desktop/other");
    await s.client.ok("agent.approve", { id: two.id, allow: false });
    const t = await s.done(id);
    assert.equal(t.status, "done", t.error);
    const steps = t.items.filter((i: any) => i.kind === "step");
    assert.deepEqual(
      steps.map((x: any) => [x.text, x.status]),
      [
        ["Ran `rm -rf ~/Desktop/old-renders`", "done"],
        ["Ran `rm -rf ~/Desktop/other`", "error"],
      ],
    );
    assert.deepEqual(s.runs()[0]!.approvals, [
      { command: "rm -rf ~/Desktop/old-renders", decision: "accept" },
      { command: "rm -rf ~/Desktop/other", decision: "decline" },
    ]);
    assert.deepEqual([s.runs()[0]!.threadConfig.sandbox, s.runs()[0]!.threadConfig.approvalPolicy], ["workspace-write", "untrusted"]);
  } finally {
    await s.stop();
  }
});

test(
  "issue #106: a Codex crash resumes the thread on the next message, a lost thread starts fresh; limits and sign-in failures in words",
  { skip, timeout: 90000 },
  async () => {
    const s = await setup("crash");
    try {
      const crashed = await s.ask("one", [{ text: "Working." }, { crash: true }]);
      assert.equal(crashed.status, "error");
      assert.match(crashed.error, /crashed on purpose/);
      const after = await s.ask("two", [{ text: "Back." }]);
      assert.equal(after.status, "done", after.error);
      const runs = s.runs();
      assert.notEqual(runs[0]!.pid, runs[1]!.pid, "another app-server");
      assert.equal(runs[1]!.resume, runs[0]!.threadId, "it resumed the thread");
      assert.equal(runs[1]!.threadId, runs[0]!.threadId);

      const limited = await s.ask("three", [
        {
          limit: {
            primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
            secondary: null,
            rateLimitReachedType: "primary",
          },
        },
        { fail: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } },
      ]);
      assert.equal(limited.status, "error");
      assert.match(limited.error, /^Codex usage limit reached\. Send the message again once the limit resets \(in (59m|1h)\)/);
      const signedOut = await s.ask("four", [{ fail: { message: "401 Unauthorized", codexErrorInfo: "unauthorized" } }]);
      assert.match(signedOut.error, /Codex isn't signed in.*codex login/);
    } finally {
      await s.stop();
    }

    // A stored thread Codex lost: a fresh one (and the next message goes on in it).
    const gone = await setup("gone");
    try {
      await gone.ask("one", [{ text: "Hi." }]);
      const threadId = gone.runs()[0]!.threadId;
      await gone.stop();
      const again = await setup("gone", { FAKE_RESUME_GONE: threadId });
      try {
        const t = await again.ask("two", [{ text: "Hello again." }]);
        assert.equal(t.status, "done", t.error);
        const last = again.runs().at(-1)!;
        assert.equal(last.resume, null);
        assert.notEqual(last.threadId, threadId);
      } finally {
        await again.stop();
      }
    } catch (error) {
      await gone.stop().catch(() => {});
      throw error;
    }
  },
);

test("a switch of agent CLI starts a conversation that gets the plan whole", { skip, timeout: 60000 }, async () => {
  const s = await setup("switch-blocks");
  const brief = { film: "A teaser for Acme", audience: "devs", duration: "20 s", formats: [], assets: [], visual: "dark", hardLines: [], deliverables: [] };
  try {
    await s.client.ok("agent.planSave", { brief });
    await s.ask("codex first", [{ text: "Codex here." }], { provider: "claude" });
    await s.ask("codex now", [{ text: "Codex here." }]);
    assert.match(s.runs().at(-1)!.prompt, /A teaser for Acme/);
    assert.doesNotMatch(s.runs().at(-1)!.prompt, /Unchanged since/);
  } finally {
    await s.stop();
  }
});

test(
  "issue #106: switching between Codex and Claude Code: each starts its own conversation, no Codex thread id reaches claude",
  { skip, timeout: 60000 },
  async () => {
    const s = await setup("switch");
    try {
      await s.ask("codex first", [{ text: "Codex here." }]);
      const codexPid = s.runs()[0]!.pid;
      // fake-claude reads its own plan file (the same FAKE_PLAN): the next turn's steps.
      const plan = JSON.parse(readFileSync(join(root, "switch", "plan.json"), "utf8"));
      plan.push([{ text: "Claude here." }]);
      writeFileSync(join(root, "switch", "plan.json"), JSON.stringify(plan));
      const { turnId } = await s.client.ok("agent.send", { prompt: "now claude", provider: "claude" });
      const t = await s.done(turnId);
      assert.equal(t.status, "done", t.error);
      assert.ok(
        t.items.some((i: any) => i.text === "Claude here."),
        "claude answered",
      );
      assert.equal(t.model, undefined, "no Codex model goes to claude");
      for (let i = 0; i < 50 && alive(codexPid); i++) await sleep(100);
      assert.equal(alive(codexPid), false, "the Codex app-server was closed");
    } finally {
      await s.stop();
    }
  },
);

test("issue #106: the setup row reports Codex's sign-in from its app-server", { skip, timeout: 60000 }, async () => {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(FAKE_CODEX, join(bin, "codex"));
  const PATH = `${bin}:${process.env.PATH}`;
  const rows: Record<string, any> = {};
  for (const account of ["chatgpt", "apiKey", "none", "signed-out"]) {
    const server = await startServer({ env: { UNCUT_DATA_DIR: join(root, `setup-${account}`), PATH, FAKE_CODEX_ACCOUNT: account } });
    const client = await connect(server.ready.port, server.ready.token);
    try {
      const checks = await client.ok("setup.check");
      rows[account] = checks.find((c: any) => c.id === "codex");
    } finally {
      client.close();
      await server.stop();
    }
  }
  assert.deepEqual([rows.chatgpt.status, rows.chatgpt.detail], ["ready", "Signed in with ChatGPT (Plus)."]);
  assert.equal(rows.chatgpt.version, "0.164.0");
  assert.equal(rows.apiKey.status, "ready");
  assert.match(rows.apiKey.detail, /OpenAI API key/);
  assert.equal(rows.none.status, "ready");
  assert.match(rows.none.detail, /needs no OpenAI sign-in/);
  assert.equal(rows["signed-out"].status, "needs-login");
  assert.equal(rows["signed-out"].fix.command, "codex login");
});
