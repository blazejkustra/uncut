// Phase 6 chunk 8 (D90, D91) on the bundled server through the scripted stand-in for claude
// (helpers/fake-claude.ts, never the real one) and the real MCP server:
// - project_check returns the project's checks (rule, severity, sentence, items, frame, fix or
//   hint), filtered by rules and severity; a fix's ops go through timeline_edit as they are and
//   clear the finding; checks.disabled leaves a rule out;
// - no bundled music (D274): library_search kind music, source included, is the user's own music;
// - the tools, their step labels, and the system prompt's taste and music notes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mcpTools, stepLabel, SYSTEM_PROMPT, TOOL_NAMES } from "../../apps/server/src/agent/agentTools.ts";
import { projectChecks, type Project } from "../../packages/core/src/index.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { AGENT_TEXT } from "../helpers/agentText.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const which = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const FFMPEG = which("ffmpeg");
const FFPROBE = which("ffprobe");
const skip =
  !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA)
    ? "server bundle or media core not built (run pnpm build)"
    : !FFMPEG || !FFPROBE
      ? "ffmpeg isn't installed"
      : false;

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let server: Server;
let client: Client;
let agent: ReturnType<Client["subscribe"]>;
let dir = "";
const plan = () => join(root, "plan.json");
const resultLog = () => join(root, "results.jsonl");
const turns: Array<unknown> = [];
async function ask(prompt: string, steps: Array<unknown>) {
  turns.push(steps);
  writeFileSync(plan(), JSON.stringify(turns));
  const { turnId } = await client.ok("agent.send", { prompt });
  await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 120000);
  return agent.values.at(-1).turns.find((t: any) => t.id === turnId);
}
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const results = () =>
  readFileSync(resultLog(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const answer = (r: any) => JSON.parse(r.result.content[0].text);

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-checks-")));
  mkdirSync(join(root, "projects"));
  const shimDir = join(root, "bin");
  mkdirSync(shimDir);
  symlinkSync(FFMPEG!, join(shimDir, "ffmpeg"));
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  symlinkSync(process.execPath, join(shimDir, "node"));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(resultLog(), "");
  server = await startServer({
    env: {
      PATH: `${shimDir}:/usr/bin:/bin`,
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: plan(),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_RESULT_LOG: resultLog(),
    },
  });
  client = await connect(server.ready.port, server.ready.token);
  agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Checks" });
  dir = snap.dir;
  await agent.until((s) => s?.dir === dir);
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "project_check lists the checks with fixes; a fix through timeline_edit clears its finding; filters and disabled rules",
  { skip, timeout: 180000 },
  async () => {
    const start = results().length;
    const turn = await ask("add a title and check it", [
      { tool: "project_read", args: {} },
      {
        tool: "timeline_edit",
        args: {
          baseRevision: "$rev",
          summary: "Title and a background",
          ops: [
            {
              op: "insert_item",
              track: "main",
              item: { id: "bg", type: "component", component: "component.solid", duration: 150, props: { color: "#101010" } },
            },
            {
              op: "insert_item",
              track: "text",
              item: {
                id: "title",
                type: "text",
                start: 0,
                duration: 45,
                text: "We built it seven times.",
                transform: { x: 160, y: 400 },
                style: { preset: "text.title", size: 96 },
              },
            },
          ],
        },
      },
      { tool: "project_check", args: {} },
      { tool: "project_check", args: { severity: "info" } },
      { tool: "project_check", args: { rules: ["trailing-period"] } },
      { tool: "project_check", args: { severity: "loud" } },
    ]);
    assert.equal(turn.status, "done", turn.error);
    const mine = results().slice(start);
    const all = answer(mine[2]);
    const rules = all.checks.map((c: any) => c.rule);
    // The title: a trailing period, 1.5 s for 5 words; the 16:9 canvas and no sound are info notes.
    for (const r of ["trailing-period", "text-read-time", "canvas-format", "silent"]) assert.ok(rules.includes(r), `${r} in ${rules.join(", ")}`);
    assert.equal(all.warnings, all.checks.filter((c: any) => c.severity === "warn").length);
    assert.equal(
      all.checks.findIndex((c: any) => c.severity === "info"),
      all.warnings,
      "warnings first",
    );
    const period = all.checks.find((c: any) => c.rule === "trailing-period");
    assert.deepEqual(period.items, ["title"]);
    assert.equal(period.frame, 0);
    assert.equal(period.seconds, 0);
    assert.deepEqual(period.fix, {
      summary: 'Remove the period from "We built it seven times"',
      ops: [{ op: "update_item", item: "title", set: { text: "We built it seven times" } }],
    });
    const read = all.checks.find((c: any) => c.rule === "text-read-time");
    assert.match(read.message, /fully on screen for 1\.5 s, and 5 words need about 2\.0 s/);
    assert.ok(read.fix.ops[0].set.duration === 60, JSON.stringify(read.fix));
    assert.ok(all.checks.find((c: any) => c.rule === "silent").hint, "no fix: a hint");
    assert.match(all.note, /never block the export/);
    // The same list as core's.
    assert.deepEqual(
      rules,
      projectChecks(onDisk()).map((c) => c.id),
    );
    assert.ok(answer(mine[3]).checks.every((c: any) => c.severity === "info"));
    assert.deepEqual(
      answer(mine[4]).checks.map((c: any) => c.rule),
      ["trailing-period"],
    );
    assert.equal(mine[5].result.isError, true);
    assert.match(mine[5].result.content[0].text, /severity must be "warn" or "info"/);
    assert.equal(turn.items.filter((i: any) => i.kind === "step" && i.text === "Checked the video against the taste checks").length, 4);

    // Next turn: send the two fixes as they are, with the revision project_check answered at.
    const fix = await ask("fix what the checks found", [
      { tool: "project_check", args: { severity: "warn" } },
      { tool: "timeline_edit", args: { baseRevision: all.revision, summary: "Checks fixes", ops: [...period.fix.ops, ...read.fix.ops] } },
      { tool: "project_check", args: { severity: "warn" } },
    ]);
    assert.equal(fix.status, "done", fix.error);
    const after = results().slice(start + mine.length);
    assert.equal(answer(after[1]).ok, true, JSON.stringify(answer(after[1])));
    const left = answer(after[2]).checks.map((c: any) => c.rule);
    assert.ok(!left.includes("trailing-period") && !left.includes("text-read-time"), left.join(", "));
    const title = onDisk().tracks.find((t) => t.id === "text")!.items[0]!;
    assert.equal(title.text, "We built it seven times");
    assert.equal(title.duration, 60);

    // A rule the project turned off isn't listed.
    const off = await ask("I don't care about the format", [
      { tool: "project_read", args: {} },
      {
        tool: "timeline_edit",
        args: { baseRevision: "$rev", summary: "Turn off the canvas check", ops: [{ op: "update_project", set: { checks: { disabled: ["canvas-format"] } } }] },
      },
      { tool: "project_check", args: {} },
    ]);
    assert.equal(off.status, "done", off.error);
    assert.equal(answer(results().at(-2)).ok, true, results().at(-2).result.content[0].text);
    const last = answer(results().at(-1));
    assert.ok(!last.checks.some((c: any) => c.rule === "canvas-format"));
    assert.deepEqual(last.disabled, ["canvas-format"]);
  },
);

test("C6: a ripple trim on Main re-times the panel graphic over it, and timeline_edit says so", { skip, timeout: 180000 }, async () => {
  const start = results().length;
  const html = "<div id=b></div><script>function render(t){document.getElementById('b').textContent=t.toFixed(2)}</script>";
  const turn = await ask("cut 1 s from the second card", [
    { tool: "graphic_write", args: { name: "panel.html", html } },
    { tool: "project_read", args: {} },
    {
      tool: "timeline_edit",
      args: {
        baseRevision: "$rev",
        summary: "Two cards and a panel",
        ops: [
          {
            op: "insert_item",
            track: "main",
            item: { id: "card-1", type: "component", component: "component.solid", duration: 150, props: { color: "#202020" } },
          },
          {
            op: "insert_item",
            track: "main",
            item: { id: "card-2", type: "component", component: "component.solid", duration: 150, props: { color: "#303030" } },
          },
          { op: "add_track", track: { id: "panel-track", kind: "video", name: "Panel" }, index: 0 },
          {
            op: "insert_item",
            track: "panel-track",
            item: {
              id: "panel",
              type: "graphic",
              src: "graphics/panel.html",
              start: 150,
              duration: 300,
              keys: [
                { frame: 200, opacity: 1 },
                { frame: 210, opacity: 0 },
              ],
            },
          },
        ],
      },
    },
    { tool: "project_read", args: {} },
    {
      tool: "timeline_edit",
      args: { baseRevision: "$rev", summary: "Shorter first card", ops: [{ op: "trim_item", item: "card-1", edge: "end", frames: 30 }] },
    },
  ]);
  assert.equal(turn.status, "done", turn.error);
  const cut = answer(results().slice(start).at(-1));
  assert.equal(cut.ok, true, JSON.stringify(cut));
  assert.equal(cut.graphicsRetimed.length, 1);
  assert.match(
    cut.graphicsRetimed[0],
    /^panel \(graphics\/panel\.html\): 1\.0 s of its own time went with the footage at 9\.0 s .*Don't shift its render\(t\) times by hand\.$/,
  );
  const panel = onDisk().tracks.find((t) => t.id === "panel-track")!.items[0]!;
  assert.deepEqual([panel.start, panel.duration, panel.skips], [150, 270, [{ at: 120, frames: 30 }]]);
  assert.deepEqual(
    panel.keys!.filter((k) => k.frame >= 160).map((k) => [k.frame, k.opacity]),
    [
      [170, 1],
      [180, 0],
    ],
  );
});

test("D274: no bundled music; library_search with source included finds the user's own music, or says to ask", { skip, timeout: 180000 }, async () => {
  const start = results().length;
  const turn = await ask("add some calm music", [{ tool: "library_search", args: { kind: "music", source: "included" } }]);
  assert.equal(turn.status, "done", turn.error);
  const r = answer(results().slice(start)[0]);
  assert.deepEqual(r.yours, []);
  assert.equal(r.total, 0);
  assert.match(r.note, /Uncut ships no music: ask the user/);
});

test("the tools, their labels and the system prompt's taste and music notes", { skip }, () => {
  assert.ok((TOOL_NAMES as ReadonlyArray<string>).includes("project_check"));
  assert.ok(mcpTools().some((t) => t.name === "project_check"));
  for (const gone of ["music_list", "music_add"]) assert.ok(!(TOOL_NAMES as ReadonlyArray<string>).includes(gone), gone);
  assert.equal(stepLabel("project_check", {}), "Checked the video against the taste checks");
  assert.match(SYSTEM_PROMPT, /run project_check and fix each warning/);
  assert.match(SYSTEM_PROMPT, /words ÷ 3 s \(2 s minimum/);
  assert.match(SYSTEM_PROMPT, /never ·, • or \* between words/);
  assert.match(AGENT_TEXT, /Uncut ships no music/);
  // K1 (D121): there is no Checks tab to point the user at.
  assert.doesNotMatch(SYSTEM_PROMPT, /Checks tab/);
  assert.doesNotMatch(SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("- Taste")), /swmansion/);
  const prompt = JSON.parse(readFileSync(join(root, "prompts.jsonl"), "utf8").trim().split("\n")[0]!);
  assert.match(prompt.system ?? "", /project_check/, "the CLI gets it");
});
