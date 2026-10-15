// D139-D142 on the bundled server with fake-claude's long-lived session: several messages go to
// one claude (one spawn, one MCP server, one tools/list); text and thinking stream live and the full
// message replaces what streamed (no doubles); a Stop that claude doesn't answer kills it and the
// next message resumes; a crash mid-turn and an idle close both resume on the next message; a
// stored session that is gone starts fresh; @mentions reach claude as a <context> block with the
// real ids while the card keeps the labels; step labels say names, not "m-" ids.
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
  message: number;
  pid: number;
  mcpPid: number;
  mcpToken: string;
  partial: boolean;
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
const gone = async (pid: number) => {
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(100);
  return !alive(pid);
};

let root = "";
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});
before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-session-")));
});

async function setup(name: string, env: Record<string, string> = {}) {
  const base = join(root, name);
  mkdirSync(join(base, "projects"), { recursive: true });
  const plan = join(base, "plan.json");
  const log = join(base, "prompts.jsonl");
  const toolsLog = join(base, "tools.jsonl");
  writeFileSync(log, "");
  writeFileSync(toolsLog, "");
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(base, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan, FAKE_PROMPT_LOG: log, FAKE_TOOLS_LOG: toolsLog, ...env } });
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
    runs: (): Array<Run> => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    toolLists: () => readFileSync(toolsLog, "utf8").trim().split("\n").filter(Boolean),
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

test("several messages, one claude: one spawn, one MCP server, one tools/list; the second message continues the session", { skip, timeout: 60000 }, async () => {
  const s = await setup("one");
  try {
    for (const [i, prompt] of ["first", "second", "third"].entries()) {
      const t = await s.ask(prompt, [{ tool: "project_read" }, { text: `Answer ${i + 1}` }]);
      assert.equal(t.status, "done", t.error);
    }
    const runs = s.runs();
    assert.deepEqual(runs.map((r) => r.message), [1, 2, 3], "three messages to the same process");
    assert.equal(new Set(runs.map((r) => r.pid)).size, 1, "one spawn");
    assert.equal(new Set(runs.map((r) => r.mcpPid)).size, 1, "one MCP server");
    assert.equal(s.toolLists().length, 1, "tools listed once");
    assert.deepEqual(runs.map((r) => r.resume), [null, "fake-session", "fake-session"]);
    assert.ok(runs.every((r) => r.partial), "partial messages are asked for");
    assert.ok(alive(runs[0]!.pid), "it waits for the next message");
  } finally {
    await s.stop();
  }
});

test("live output: thinking and text stream in, the full message replaces them (no doubles), and a step shows while it runs", { skip, timeout: 60000 }, async () => {
  const s = await setup("live");
  try {
    const gate = join(root, "live", "gate.json");
    const id = await s.start("explain", [
      { think: "The user wants a title. I should read the timeline first." },
      { tool: "project_read" },
      { text: "Adding a title card over the opening shot now, then I'll check it.", slow: 400 },
      { await: gate },
    ]);
    // Mid-stream: a text item that is still growing.
    await s.agent.until(() => s.turn(id)?.items.some((i: any) => i.kind === "text" && i.live && i.text.length > 0 && !i.text.endsWith("check it.")), 10000);
    const mid = s.turn(id).items;
    assert.deepEqual(mid.slice(0, 2).map((i: any) => i.kind), ["thinking", "step"]);
    assert.equal(mid[0].text, "The user wants a title. I should read the timeline first.");
    writeFileSync(gate, "[]");
    const t = await s.done(id);
    assert.equal(t.status, "done");
    assert.deepEqual(
      t.items.map((i: any) => [i.kind, i.text]),
      [
        ["thinking", "The user wants a title. I should read the timeline first."],
        ["step", "Read the timeline"],
        ["text", "Adding a title card over the opening shot now, then I'll check it."],
        ["text", "Done: 1 step."],
      ],
    );
    assert.ok(t.items.every((i: any) => i.live === undefined), "nothing left live once the turn ends");
  } finally {
    await s.stop();
  }
});

test("a Stop claude doesn't answer kills it; the next message starts another claude with --resume", { skip, timeout: 60000 }, async () => {
  const s = await setup("deaf", { FAKE_IGNORE_INTERRUPT: "1", UNCUT_AGENT_INTERRUPT_MS: "600" });
  try {
    const id = await s.start("slow", [{ tool: "project_read" }, { sleep: 60000 }]);
    await s.agent.until(() => s.turn(id)?.items.some((i: any) => i.status === "done"), 10000);
    const { pid } = s.runs()[0]!;
    const started = Date.now();
    await s.client.ok("agent.cancel");
    const t = await s.done(id);
    assert.equal(t.status, "cancelled");
    assert.ok(Date.now() - started >= 500, "it waited for the interrupt first");
    assert.ok(await gone(pid), "then killed it");
    const next = await s.ask("again", [{ tool: "project_read" }]);
    assert.equal(next.status, "done", next.error);
    const second = s.runs()[1]!;
    assert.notEqual(second.pid, pid);
    assert.equal(second.resume, "fake-session", "started with --resume");
    assert.equal(second.message, 1);
  } finally {
    await s.stop();
  }
});

test("a crash mid-turn ends the turn with why; the next message resumes the session in a new claude", { skip, timeout: 60000 }, async () => {
  const s = await setup("crash");
  try {
    await s.ask("one", [{ tool: "project_read" }]);
    const crashed = await s.ask("two", [{ tool: "project_read" }, { crash: true }]);
    assert.equal(crashed.status, "error");
    assert.match(crashed.error, /Claude Code stopped: fake-claude: crashed on purpose/);
    const [first] = s.runs();
    assert.ok(await gone(first!.pid));
    const t = await s.ask("three", [{ tool: "project_read" }, { text: "Back." }]);
    assert.equal(t.status, "done", t.error);
    const runs = s.runs();
    assert.equal(runs.length, 3);
    assert.notEqual(runs[2]!.pid, first!.pid);
    assert.equal(runs[2]!.resume, "fake-session", "resumed with --resume");
    assert.equal(runs[2]!.prompt.split("\n\n")[0], "three", "the plan carried on at the third message");
  } finally {
    await s.stop();
  }
});

test("D218: a usage limit pauses the turn with a notice in the Agent tab, then ends it with a clear message; no retry, the same claude takes the next message", { skip, timeout: 60000 }, async () => {
  const s = await setup("limit");
  try {
    const resetsAt = Math.floor(Date.now() / 1000) + 7500 - 20;
    const id = await s.start("one", [
      { tool: "project_read" },
      { raw: { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt } } },
      { raw: { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt } } },
      { sleep: 1500 },
      { raw: { type: "assistant", error: "rate_limit", message: { id: "msg_limit", role: "assistant", content: [{ type: "text", text: "API Error: Claude usage limit reached" }] } } },
      { result: { subtype: "success", is_error: true, api_error_status: 429, result: "API Error: Claude usage limit reached" } },
    ]);
    const isPaused = (st: any) => /usage limit/.test(st?.warning ?? "");
    await s.agent.until(isPaused, 10000);
    assert.equal(s.agent.values.find(isPaused).warning, "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 2h 5m. Wait, or press Stop and send it again later.");
    assert.equal(s.turn(id).status, "running", "paused, not ended: Stop still works");
    const t = await s.done(id);
    assert.equal(t.status, "error");
    assert.equal(t.error, "Claude usage limit reached. Send the message again once the limit resets (in 2h 5m).");
    assert.equal(s.agent.values.at(-1)?.warning, undefined, "the notice goes with the turn");
    const next = await s.ask("two", [{ text: "Back." }]);
    assert.equal(next.status, "done", next.error);
    const runs = s.runs();
    assert.equal(runs.length, 2, "each message sent once: no retry");
    assert.equal(new Set(runs.map((r) => r.pid)).size, 1, "no respawn");
  } finally {
    await s.stop();
  }
});

test("D218: signed out, overloaded and rate-limited results say so in words", { skip, timeout: 60000 }, async () => {
  const s = await setup("auth");
  try {
    const signedOut = await s.ask("one", [
      { raw: { type: "assistant", error: "authentication_failed", message: { id: "msg_auth", role: "assistant", content: [{ type: "text", text: "Invalid API key · Please run /login" }] } } },
      { result: { subtype: "success", is_error: true, result: "Invalid API key · Please run /login" } },
    ]);
    assert.equal(signedOut.status, "error");
    assert.match(signedOut.error, /^Claude Code isn't signed in\b.*Run `claude auth login` in Terminal to sign in with your Claude subscription, then send the message again\.$/);
    const overloaded = await s.ask("two", [{ result: { subtype: "success", is_error: false, api_error_status: 529, result: "" } }]);
    assert.equal(overloaded.status, "error", "a 529 labelled success still failed");
    assert.equal(overloaded.error, "Claude API is overloaded (529). Try again shortly.");
    const limited = await s.ask("three", [{ result: { subtype: "success", is_error: true, api_error_status: 429, result: "API Error: 429" } }]);
    assert.equal(limited.error, "Claude API rate limit reached. Try again later.", "a 429 without a rejected window is a rate limit");
    assert.equal(s.runs().length, 3, "no retries");
  } finally {
    await s.stop();
  }
});

test("an idle session closes after its timeout (stdin closed, claude exits); the next message resumes", { skip, timeout: 60000 }, async () => {
  const s = await setup("idle", { UNCUT_AGENT_IDLE_MS: "700" });
  try {
    await s.ask("one", [{ tool: "project_read" }]);
    const { pid, mcpPid } = s.runs()[0]!;
    assert.ok(await gone(pid), "closed when idle");
    assert.ok(await gone(mcpPid), "with its MCP server");
    const t = await s.ask("two", [{ tool: "project_read" }]);
    assert.equal(t.status, "done", t.error);
    assert.equal(s.runs()[1]!.resume, "fake-session");
    assert.notEqual(s.runs()[1]!.pid, pid);
  } finally {
    await s.stop();
  }
});

test("a stored session that's gone (no conversation found) starts fresh once, and the message still goes through", { skip, timeout: 60000 }, async () => {
  const s = await setup("gone", { FAKE_RESUME_GONE: "fake-session" });
  try {
    await s.ask("one", [{ tool: "project_read" }]);
    await s.ask("two", [{ crash: true }]);
    const t = await s.ask("three", [{ tool: "project_read" }]);
    assert.equal(t.status, "done", t.error);
    const runs = s.runs();
    assert.equal(runs.at(-1)!.resume, null, "a fresh conversation");
    assert.match(runs.at(-1)!.prompt, /^three/);
  } finally {
    await s.stop();
  }
});

test("@mentions: claude gets the labels with a <context> block of real ids; the card keeps the labels; step labels say names (AG5)", { skip, timeout: 60000 }, async () => {
  const s = await setup("mentions");
  try {
    const media = { id: "m-drone-take-1", kind: "video", name: "Drone take", path: "/nowhere/drone.mp4", probe: { width: 3840, height: 2160, fps: 30, frames: 300, hasAudio: false } };
    await s.client.ok("project.edit", { ops: [{ op: "add_media", media }] });
    await s.client.ok("project.edit", { ops: [{ op: "insert_item", track: "main", item: { id: "clip-1", type: "clip", media: media.id, in: 0, duration: 120 } }] });
    const t = await s.ask(
      "trim @Drone take clip and select @Drone take",
      [{ tool: "ui_show", args: { select: ["clip-1"] } }, { text: "Selected m-drone-take-1." }],
      { mentions: [{ kind: "media", id: media.id, label: "Drone take" }, { kind: "item", id: "clip-1", label: "Drone take clip", range: { start: 0, end: 120 } }, { kind: "track", id: "text", label: "Not in the prompt" }] },
    );
    assert.equal(t.status, "done", t.error);
    const prompt = s.runs()[0]!.prompt;
    assert.match(prompt, /^trim @Drone take clip and select @Drone take\n\n<context>\n/);
    assert.match(prompt, /@Drone take = media m-drone-take-1 \(video, 10\.00 s, 3840x2160, used 1x on the timeline\)/);
    assert.match(prompt, /@Drone take clip = item clip-1 \(clip on track main.*media m-drone-take-1\), frames 0–120 \(0\.00 s–4\.00 s\)/);
    assert.doesNotMatch(prompt, /Not in the prompt/, "a chip whose label left the prompt isn't sent");
    assert.ok(prompt.indexOf("</context>") < prompt.indexOf("<editor-context>") || !prompt.includes("<editor-context>"));
    assert.equal(t.prompt, "trim @Drone take clip and select @Drone take");
    assert.deepEqual(t.mentions, [{ kind: "media", label: "Drone take" }, { kind: "item", label: "Drone take clip" }]);
    const steps = t.items.filter((i: any) => i.kind === "step").map((i: any) => i.text);
    assert.deepEqual(steps, ["Selected Drone take"]);
    assert.ok(steps.every((x: string) => !/\bm-/.test(x)), "no m- id in a step");
  } finally {
    await s.stop();
  }
});

test("the bridge takes calls only for the running turn: none while a stopped turn's result is pending; a normal call never waits", { skip, timeout: 60000 }, async () => {
  const s = await setup("bound", { FAKE_IGNORE_INTERRUPT: "1", UNCUT_AGENT_INTERRUPT_MS: "2500" });
  try {
    const id = await s.start("slow", [{ tool: "project_read" }, { sleep: 60000 }]);
    await s.agent.until(() => s.turn(id)?.items.some((i: any) => i.status === "done"), 10000);
    const { mcpToken } = s.runs()[0]!;
    const base = `http://127.0.0.1:${s.server.ready.port}/agent`;
    const post = (name: string, args: unknown) => fetch(`${base}/call`, { method: "POST", headers: { "x-uncut-agent-token": mcpToken, "content-type": "application/json" }, body: JSON.stringify({ name, args }) });
    // While the turn runs, a call (even one its stream didn't announce) runs at once.
    const started = Date.now();
    const ok = await post("project_read", {});
    assert.equal(ok.status, 200);
    assert.ok(Date.now() - started < 1000, "no waiting for an announcement");
    // Stop: claude doesn't answer the interrupt, so the turn's result is pending for 2.5 s.
    await s.client.ok("agent.cancel");
    const late = await post("timeline_edit", { baseRevision: 0, summary: "Late", ops: [{ op: "insert_item", track: "text", item: { id: "late-1", type: "text", start: 0, duration: 30, text: "Late" } }] });
    assert.equal(late.status, 401, "a stopped turn takes no call while its result is pending");
    assert.equal(s.turn(id).status, "running", "still in that window");
    const t = await s.done(id);
    assert.equal(t.status, "cancelled");
    assert.deepEqual(t.edits, []);
    // Idle: refused too.
    assert.equal((await post("project_read", {})).status, 401);
    const project = await s.client.ok("project.get");
    assert.ok(!project.project.tracks.some((tr: any) => tr.items.some((i: any) => i.id === "late-1")));
  } finally {
    await s.stop();
  }
});

test("a server that stops kills a claude that is still closing (idle close it didn't honour)", { skip, timeout: 60000 }, async () => {
  const s = await setup("limbo", { FAKE_LINGER: "1", UNCUT_AGENT_IDLE_MS: "400" });
  await s.ask("one", [{ tool: "project_read" }]);
  const { pid, mcpPid } = s.runs()[0]!;
  await sleep(1200);
  assert.ok(alive(pid), "its input was closed, but it lingers");
  s.client.close();
  s.server.proc.kill("SIGTERM");
  await s.server.exited;
  assert.ok(await gone(pid), "killed with the server");
  assert.ok(await gone(mcpPid));
});
