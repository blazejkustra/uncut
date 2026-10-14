// Issue #33 (D194) on the bundled server with fake-claude's session: Claude Code's own tools
// (WebSearch, WebFetch, Bash, Read, Write, Task) in the work log with their labels and results,
// permission prompts over stdio (can_use_tool) decided by the composer's access: Edit freely runs
// them and asks only for destructive commands, Ask before big changes puts commands and writes on
// a card (Allow once, Always for this session, Deny), Look only refuses commands and writes
// without a card; a Stop closes an open card; a pasted folder joins --add-dir; media_download
// brings a file from the web (a loopback stub here) into media/downloads and imports it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(BUNDLE) && existsSync(MCP) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";
const flagValue = (argv: Array<string>, flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const flagValues = (argv: Array<string>, flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]!] : []));
// A 1x1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

let root = "";
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});
before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-builtins-")));
});

async function setup(name: string, env: Record<string, string> = {}) {
  const base = join(root, name);
  mkdirSync(join(base, "projects"), { recursive: true });
  const plan = join(base, "plan.json");
  const log = join(base, "prompts.jsonl");
  const results = join(base, "results.jsonl");
  writeFileSync(log, "");
  writeFileSync(results, "");
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(base, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan, FAKE_PROMPT_LOG: log, FAKE_RESULT_LOG: results, UNCUT_APPROVAL_MS: "8000", FAKE_REQUIRE_INIT: "1", ...env } });
  const client = await connect(server.ready.port, server.ready.token);
  const agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "P" });
  await agent.until((s) => s?.dir === snap.dir);
  const turns: Array<unknown> = [];
  const latest = () => agent.values.at(-1);
  const turn = (id: string) => latest()?.turns.find((t: { id: string }) => t.id === id);
  const self = {
    base,
    client,
    agent,
    dir: snap.dir as string,
    turn,
    runs: (): Array<{ argv: Array<string>; pid: number; prompt: string; system: string; initialized: boolean }> => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    decisions: (): Array<{ builtin: string; decision: { behavior: string; message?: string; toolUseID?: string } }> =>
      readFileSync(results, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.builtin),
    start: async (prompt: string, steps: Array<unknown>, extra: Record<string, unknown> = {}) => {
      turns.push(steps);
      writeFileSync(plan, JSON.stringify(turns));
      const { turnId } = await client.ok("agent.send", { prompt, ...extra });
      return turnId as string;
    },
    /** The next permission card of turn `id` that isn't one of `seen` (cards already answered). */
    card: async (id: string, ...seen: Array<string>) => {
      const fits = (v: any) => v?.approval?.turnId === id && !!v.approval.permission && !seen.includes(v.approval.id);
      await agent.until(fits, 10000);
      return agent.values.findLast(fits).approval;
    },
    done: async (id: string) => {
      await agent.until(() => turn(id) && turn(id).status !== "running", 20000);
      return turn(id);
    },
    stop: async () => {
      client.close();
      await server.stop();
    },
  };
  return self;
}

const stepsOf = (t: any) => t.items.filter((i: any) => i.kind === "step");

test("D194 Edit freely: web search, fetch, reads, subagents and plain commands run without a card, with their labels and results; a destructive command asks, can't be remembered, and Deny refuses it", { skip, timeout: 60000 }, async () => {
  const s = await setup("edit");
  try {
    const id = await s.start("make a promo for Argent", [
      { builtin: "Bash", args: { command: "ls media", description: "List media" }, result: "a.mp4\nb.mp4" },
      { builtin: "WebSearch", args: { query: "Argent Software Mansion" }, result: "1. Argent: control simulators from your agent (argent.example.dev)" },
      { builtin: "WebFetch", args: { url: "https://argent.example.dev/docs/", prompt: "What does it do?" }, result: "Argent lets coding agents drive iOS simulators." },
      { builtin: "Read", args: { file_path: "~/Downloads/logo.svg" }, prompt: false, result: "<svg/>" },
      { builtin: "Task", args: { description: "Research Argent's features", prompt: "…", subagent_type: "general-purpose" }, prompt: false, result: "Features: …" },
      { builtin: "Bash", args: { command: "rm -rf ~/Desktop/old-renders" } },
    ]);
    const card = await s.card(id);
    assert.equal(card.permission.tool, "Bash");
    assert.equal(card.permission.target, "rm -rf ~/Desktop/old-renders");
    assert.match(card.permission.why, /outside the project/);
    assert.equal(card.permission.always, false, "a destructive command is never remembered");
    assert.equal(card.text, "Run a command");
    await s.client.ok("agent.approve", { id: card.id, allow: false });
    const t = await s.done(id);
    assert.equal(t.status, "done", t.error);
    const steps = stepsOf(t);
    assert.deepEqual(
      steps.map((x: any) => x.text),
      ["Ran `ls media`", 'Searched the web for "Argent Software Mansion"', "Read argent.example.dev/docs", "Read ~/Downloads/logo.svg", 'Started a subagent "Research Argent\'s features"', "Ran `rm -rf ~/Desktop/old-renders`"],
    );
    assert.equal(steps[1].tool, "WebSearch");
    assert.match(steps[1].result, /argent\.example\.dev/, "the search's answer opens from its row");
    assert.equal(steps[0].result, "a.mp4\nb.mp4");
    assert.equal(steps[5].status, "error");
    assert.match(steps[5].error, /said no to "Run a command: rm -rf ~\/Desktop\/old-renders"/);
    assert.equal(steps[5].result, undefined);
    const decisions = s.decisions();
    assert.deepEqual(
      decisions.map((d) => [d.builtin, d.decision.behavior]),
      [["Bash", "allow"], ["WebSearch", "allow"], ["WebFetch", "allow"], ["Read", "allow"], ["Task", "allow"], ["Bash", "deny"]],
      "web tools and an allowlisted command are allowed by Uncut without a card",
    );
    assert.match(decisions[0]!.decision.toolUseID ?? "", /^toolu_/, "the answer names the tool call");
    // The editor context tells a resumed conversation what it can use.
    assert.match(s.runs()[0]!.prompt, /Tools: Claude Code's own \(WebSearch and WebFetch/);
    assert.match(s.runs()[0]!.system, /media_download/);
  } finally {
    await s.stop();
  }
});

test("D194 Ask before big changes: a command waits for a card; Allow once runs it once; Always for this session lets that exact command run again without a card; a write in .cache goes, elsewhere it asks", { skip, timeout: 60000 }, async () => {
  const s = await setup("ask");
  try {
    const dir = s.dir;
    const id = await s.start("tidy up", [
      { builtin: "Bash", args: { command: "ls -la" } },
      { builtin: "Bash", args: { command: "ls media" } },
      { builtin: "Bash", args: { command: "ls media" } },
      { builtin: "Write", args: { file_path: join(dir, ".cache", "notes.txt"), content: "x" } },
      { builtin: "Write", args: { file_path: join(dir, "script.sh"), content: "x" } },
    ], { access: "ask" });
    const one = await s.card(id);
    assert.equal(one.permission.target, "ls -la");
    assert.equal(one.permission.always, true);
    await s.client.ok("agent.approve", { id: one.id, allow: true });
    const two = await s.card(id, one.id);
    assert.equal(two.permission.target, "ls media", "Allow once doesn't cover the next command");
    await s.client.ok("agent.approve", { id: two.id, allow: true, always: true });
    // `ls media` again and the .cache write go without a card; the project write asks.
    const three = await s.card(id, one.id, two.id);
    assert.equal(three.permission.tool, "Write");
    assert.equal(three.permission.target, "script.sh");
    assert.equal(three.text, "Write a file");
    await s.client.ok("agent.approve", { id: three.id, allow: false });
    const t = await s.done(id);
    assert.equal(t.status, "done", t.error);
    assert.deepEqual(
      s.decisions().map((d) => d.decision.behavior),
      ["allow", "allow", "allow", "allow", "deny"],
    );
    const steps = stepsOf(t);
    assert.deepEqual(steps.map((x: any) => x.text), ["Ran `ls -la`", "Ran `ls media`", "Ran `ls media`", "Wrote .cache/notes.txt", "Wrote script.sh"]);
    assert.equal(steps[4].status, "error");
    // Uncut's own files are never written by hand, even in Edit freely.
    const id2 = await s.start("fix the project", [{ builtin: "Edit", args: { file_path: join(dir, "project.json"), old_string: "a", new_string: "b" } }], { access: "edit" });
    const t2 = await s.done(id2);
    assert.match(stepsOf(t2)[0].error, /project\.json is Uncut's own file/);
  } finally {
    await s.stop();
  }
});

test("D194 Look only: commands and writes are refused without a card, the web still works", { skip, timeout: 60000 }, async () => {
  const s = await setup("look");
  try {
    const id = await s.start("look around", [
      { builtin: "WebSearch", args: { query: "Argent" }, result: "results" },
      { builtin: "Bash", args: { command: "ls" } },
      { builtin: "Write", args: { file_path: join(s.dir, "notes.md"), content: "x" } },
    ], { access: "look" });
    const t = await s.done(id);
    assert.equal(t.status, "done", t.error);
    assert.ok(!s.agent.values.some((v: any) => v?.approval?.permission), "no card was shown");
    const steps = stepsOf(t);
    assert.equal(steps[0].status, "done");
    assert.match(steps[1].error, /Look only.*commands don't run/);
    assert.match(steps[2].error, /Look only.*can't be written/);
    assert.match(s.runs()[0]!.prompt, /Access: Look only\. You may read files, search and read the web/);
  } finally {
    await s.stop();
  }
});

test("D194 Stop while a permission card is open: the card goes, claude's request is cancelled, the turn stops", { skip, timeout: 60000 }, async () => {
  const s = await setup("stop");
  try {
    const id = await s.start("run it", [{ builtin: "Bash", args: { command: "npm run build" } }, { text: "never" }], { access: "ask" });
    await s.card(id);
    await s.client.ok("agent.cancel", {});
    const t = await s.done(id);
    assert.equal(t.status, "cancelled");
    await s.agent.until((v) => !v?.approval, 5000);
    // The next turn runs normally (no answer was owed for the cancelled request).
    const id2 = await s.start("again", [{ builtin: "WebSearch", args: { query: "x" } }]);
    const t2 = await s.done(id2);
    assert.equal(t2.status, "done", t2.error);
  } finally {
    await s.stop();
  }
});

test("D194 a folder pasted in a message is offered on a card the first time a tool needs it; Always makes it the chat's folder for reading (--add-dir from the next message, with --resume); writes there still ask", { skip, timeout: 60000 }, async () => {
  // The server's home folder is this test's, so the pasted folder is one level under it.
  const s = await setup("dirs", { HOME: join(root, "dirs") });
  try {
    const assets = join(s.base, "Marketing assets");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "logo.svg"), "<svg/>");
    const a = await s.done(await s.start("hello", [{ text: "hi" }]));
    assert.equal(a.status, "done", a.error);
    const read = { builtin: "Read", args: { file_path: join(assets, "logo.svg") } };
    const id = await s.start(`use the logo in ${assets.replace(/ /g, "\\ ")}/logo.svg please`, [read, read, { builtin: "Write", args: { file_path: join(assets, "notes.txt"), content: "x" } }]);
    const card = await s.card(id);
    assert.equal(card.text, "Use a folder you mentioned");
    assert.equal(card.permission.target, "~/Marketing assets");
    assert.equal(card.permission.always, true);
    await s.client.ok("agent.approve", { id: card.id, allow: true, always: true });
    const write = await s.card(id, card.id);
    assert.equal(write.text, "Write a file");
    assert.equal(write.permission.always, false, "a write in a mentioned folder is never remembered");
    await s.client.ok("agent.approve", { id: write.id, allow: false });
    const b = await s.done(id);
    assert.equal(b.status, "done", b.error);
    assert.deepEqual(s.decisions().map((x) => x.decision.behavior), ["allow", "allow", "deny"], "the second read needs no card");
    const c = await s.done(await s.start("next", [{ text: "ok" }]));
    assert.equal(c.status, "done", c.error);
    const runs = s.runs();
    assert.deepEqual(flagValues(runs[1]!.argv, "--add-dir"), [], "not before it was confirmed");
    assert.deepEqual(flagValues(runs[2]!.argv, "--add-dir"), [assets]);
    assert.notEqual(runs[2]!.pid, runs[1]!.pid, "a new folder: another claude");
    assert.equal(flagValue(runs[2]!.argv, "--resume"), "fake-session");
  } finally {
    await s.stop();
  }
});

test("D194 media_download: a picture from the web (redirect followed) lands in media/downloads and in Media as an edit of the turn; a web page is refused; Look only refuses it", { skip, timeout: 60000 }, async () => {
  const web: Server = createServer((req, res) => {
    if (req.url === "/go") return void res.writeHead(302, { location: "/files/logo.png" }).end();
    if (req.url === "/clip.mp4") return void res.writeHead(200, { "content-type": "video/mp4" }).end("#EXTM3U\nhttps://evil.example/a.ts\n");
    if (req.url === "/files/logo.png") return void res.writeHead(200, { "content-type": "image/png", "content-length": String(PNG.length) }).end(PNG);
    res.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
  });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  const port = (web.address() as { port: number }).port;
  const s = await setup("download");
  try {
    const id = await s.start("get the logo", [
      { tool: "media_download", args: { url: `http://127.0.0.1:${port}/go`, name: "Argent logo" } },
      { tool: "media_download", args: { url: `http://127.0.0.1:${port}/about` } },
      { tool: "media_download", args: { url: `http://127.0.0.1:${port}/clip.mp4` } },
    ]);
    const t = await s.done(id);
    assert.equal(t.status, "done", t.error);
    const steps = stepsOf(t);
    assert.equal(steps[0].text, `Downloaded Argent logo from 127.0.0.1/go`);
    assert.equal(steps[0].status, "done", steps[0].error);
    assert.equal(steps[1].status, "error");
    assert.match(steps[1].error, /text\/html, not a picture, video or sound/);
    assert.match(steps[2].error, /isn't MP4 \(it may be a web page or a playlist\)/, "a playlist labelled as video is refused");
    assert.ok(!existsSync(join(s.dir, "media", "downloads", "clip.mp4")), "and not kept");
    const file = join(s.dir, "media", "downloads", "Argent logo.png");
    assert.ok(existsSync(file), "saved under its name");
    assert.deepEqual(readFileSync(file), PNG);
    assert.equal(t.edits.length, 1, "the import is an edit of the turn");
    const project = JSON.parse(readFileSync(join(s.dir, "project.json"), "utf8"));
    assert.ok(project.media.some((m: any) => m.name === "Argent logo" && m.path.endsWith("Argent logo.png")), JSON.stringify(project.media));
    const look = await s.done(await s.start("again", [{ tool: "media_download", args: { url: `http://127.0.0.1:${port}/files/logo.png` } }], { access: "look" }));
    assert.match(stepsOf(look)[0].error, /Look only/);
  } finally {
    await s.stop();
    web.close();
  }
});

test("D194 the SDK's initialize handshake goes first; the secret deny rules ride every session; Look only starts claude without Bash and the file-writing tools (a change of access restarts it with --resume)", { skip, timeout: 60000 }, async () => {
  const s = await setup("modes");
  try {
    const a = await s.done(await s.start("look", [{ text: "ok" }], { access: "look" }));
    assert.equal(a.status, "done", a.error);
    const b = await s.done(await s.start("look again", [{ text: "ok" }], { access: "look" }));
    assert.equal(b.status, "done", b.error);
    const c = await s.done(await s.start("now edit", [{ text: "ok" }], { access: "edit" }));
    assert.equal(c.status, "done", c.error);
    const d = await s.done(await s.start("ask", [{ text: "ok" }], { access: "ask" }));
    assert.equal(d.status, "done", d.error);
    const runs = s.runs();
    assert.ok(runs.every((r) => r.initialized), "every message came after initialize was answered (fake-claude refuses one before it)");
    assert.equal(flagValue(runs[0]!.argv, "--disallowedTools"), "Bash,Write,Edit,MultiEdit,NotebookEdit");
    assert.equal(runs[1]!.pid, runs[0]!.pid, "same access, same claude");
    assert.notEqual(runs[2]!.pid, runs[1]!.pid, "Look only to Edit freely: another claude");
    assert.equal(flagValue(runs[2]!.argv, "--resume"), "fake-session");
    assert.equal(flagValue(runs[2]!.argv, "--disallowedTools"), undefined);
    assert.equal(runs[3]!.pid, runs[2]!.pid, "Edit freely and Ask share a session (Uncut decides per request)");
    for (const run of runs) {
      const settings = JSON.parse(flagValue(run.argv, "--settings")!);
      const deny: Array<string> = settings.permissions.deny;
      for (const rule of ["Read(~/.ssh/**)", "Edit(~/.ssh/**)", "Bash(*/.ssh/*)", "Bash(*~/.ssh*)", "Read(~/.aws/**)", "Read(~/Library/Keychains/**)", "Read(~/.claude/**)", "Read(~/.config/gh/**)", "Read(//**/.env)", "Bash(* .env*)"]) assert.ok(deny.includes(rule), rule);
    }
  } finally {
    await s.stop();
  }
});

test("D194 a claude that never answers initialize gets the message after the wait, but approvals fail closed and the Agent tab says so", { skip, timeout: 60000 }, async () => {
  const s = await setup("noinit", { FAKE_REQUIRE_INIT: "", FAKE_IGNORE_INIT: "1", UNCUT_AGENT_INIT_MS: "400" });
  try {
    const t = await s.done(await s.start("hello", [{ builtin: "Bash", args: { command: "ls" } }, { builtin: "WebSearch", args: { query: "x" } }]));
    assert.equal(t.status, "done", t.error);
    assert.equal(s.runs()[0]!.initialized, false);
    assert.deepEqual(s.decisions().map((x) => x.decision.behavior), ["deny", "deny"], "even an allowlisted command is refused");
    assert.match(s.decisions()[0]!.decision.message!, /didn't answer initialize/);
    assert.match(s.agent.values.at(-1).warning, /approvals can't be asked/);
  } finally {
    await s.stop();
  }
});

test("D194 the web marks the whole chat: after a WebSearch, a later turn's outside read and allowlisted command ask", { skip, timeout: 60000 }, async () => {
  const s = await setup("websession");
  try {
    const a = await s.done(await s.start("research", [{ builtin: "WebSearch", args: { query: "Argent" } }]));
    assert.equal(a.status, "done", a.error);
    const id = await s.start("now list", [{ builtin: "Bash", args: { command: "ls" } }]);
    const card = await s.card(id);
    assert.equal(card.permission.target, "ls");
    await s.client.ok("agent.approve", { id: card.id, allow: true });
    const b = await s.done(id);
    assert.equal(b.status, "done", b.error);
  } finally {
    await s.stop();
  }
});
