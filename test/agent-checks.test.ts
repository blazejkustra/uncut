// Phase 6 chunk 8 (D90, D91) on the bundled server through the scripted stand-in for claude
// (helpers/fake-claude.ts, never the real one) and the real MCP server:
// - project_check returns the project's checks (rule, severity, sentence, items, frame, fix or
//   hint), filtered by rules and severity; a fix's ops go through timeline_edit as they are and
//   clear the finding; checks.disabled leaves a rule out;
// - music_list filters the bundled library by mood, tempo and words; music_add copies a track into
//   the project's media/ folder (relative path, same bytes as the bundled file), adds it as audio
//   media on the turn, answers "already in the project" the second time, refuses unknown ids;
//   timeline_edit puts it on the audio track; Undo turn removes the media;
// - the tools, their step labels, and the system prompt's taste and music notes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mcpTools, stepLabel, SYSTEM_PROMPT, TOOL_NAMES } from "../apps/server/src/agentTools.ts";
import { MUSIC_TRACKS, projectChecks, type Project } from "../packages/core/src/index.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "./helpers/server.ts";

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
const skip = !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA) ? "server bundle or media core not built (run pnpm build)" : !FFMPEG || !FFPROBE ? "ffmpeg isn't installed" : false;

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
const results = () => readFileSync(resultLog(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
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
    env: { PATH: `${shimDir}:/usr/bin:/bin`, UNCUT_DATA_DIR: join(root, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan(), FAKE_PROMPT_LOG: join(root, "prompts.jsonl"), FAKE_RESULT_LOG: resultLog() },
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

test("project_check lists the checks with fixes; a fix through timeline_edit clears its finding; filters and disabled rules", { skip, timeout: 180000 }, async () => {
  const start = results().length;
  const turn = await ask("add a title and check it", [
    { tool: "project_read", args: {} },
    {
      tool: "timeline_edit",
      args: {
        baseRevision: "$rev",
        summary: "Title and a background",
        ops: [
          { op: "insert_item", track: "main", item: { id: "bg", type: "component", component: "component.solid", duration: 150, props: { color: "#101010" } } },
          { op: "insert_item", track: "text", item: { id: "title", type: "text", start: 0, duration: 45, text: "We built it seven times.", transform: { x: 160, y: 400 }, style: { preset: "text.title", size: 96 } } },
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
  assert.equal(all.checks.findIndex((c: any) => c.severity === "info"), all.warnings, "warnings first");
  const period = all.checks.find((c: any) => c.rule === "trailing-period");
  assert.deepEqual(period.items, ["title"]);
  assert.equal(period.frame, 0);
  assert.equal(period.seconds, 0);
  assert.deepEqual(period.fix, { summary: 'Remove the period from "We built it seven times"', ops: [{ op: "update_item", item: "title", set: { text: "We built it seven times" } }] });
  const read = all.checks.find((c: any) => c.rule === "text-read-time");
  assert.match(read.message, /fully on screen for 1\.5 s, and 5 words need about 2\.0 s/);
  assert.ok(read.fix.ops[0].set.duration === 60, JSON.stringify(read.fix));
  assert.ok(all.checks.find((c: any) => c.rule === "silent").hint, "no fix: a hint");
  assert.match(all.note, /never block the export/);
  // The same list as core's.
  assert.deepEqual(rules, projectChecks(onDisk()).map((c) => c.id));
  assert.ok(answer(mine[3]).checks.every((c: any) => c.severity === "info"));
  assert.deepEqual(answer(mine[4]).checks.map((c: any) => c.rule), ["trailing-period"]);
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
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Turn off the canvas check", ops: [{ op: "update_project", set: { checks: { disabled: ["canvas-format"] } } }] } },
    { tool: "project_check", args: {} },
  ]);
  assert.equal(off.status, "done", off.error);
  assert.equal(answer(results().at(-2)).ok, true, results().at(-2).result.content[0].text);
  const last = answer(results().at(-1));
  assert.ok(!last.checks.some((c: any) => c.rule === "canvas-format"));
  assert.deepEqual(last.disabled, ["canvas-format"]);
});

test("music_list filters the library; music_add copies a track into media/ and adds it on the turn; Undo turn removes it", { skip, timeout: 180000 }, async () => {
  const start = results().length;
  const turn = await ask("add some calm music", [
    { tool: "music_list", args: {} },
    { tool: "music_list", args: { mood: "warm" } },
    { tool: "music_list", args: { tempo: "medium" } },
    { tool: "music_list", args: { query: "upright" } },
    { tool: "music_list", args: { tempo: "glacial" } },
    { tool: "music_add", args: { id: "cozy-4" } },
    { tool: "music_add", args: { id: "cozy-4" } },
    { tool: "music_add", args: { id: "cozy-99" } },
    { tool: "project_read", args: {} },
    {
      tool: "timeline_edit",
      args: { baseRevision: "$rev", summary: "Music under the title", ops: [{ op: "insert_item", track: "audio", item: { id: "music-1", type: "audio", media: "m-sleepy-upright-piano-seamless-loop", in: 0, start: 0, duration: 150, fadeIn: 30, fadeOut: 60 } }] },
    },
    { tool: "music_list", args: { query: "sleepy" } },
  ]);
  assert.equal(turn.status, "done", turn.error);
  const mine = results().slice(start);
  const all = answer(mine[0]).tracks;
  assert.equal(all.length, MUSIC_TRACKS.length);
  for (const t of all) {
    assert.equal(t.license, "CC0-1.0");
    assert.ok(t.frames === Math.floor(t.seconds * 30) && Math.abs(t.lufs + 16) <= 0.5, JSON.stringify(t));
    assert.ok(["slow", "medium", "fast", "free"].includes(t.tempo));
  }
  assert.ok(answer(mine[1]).tracks.every((t: any) => t.moods.includes("warm")) && answer(mine[1]).tracks.length >= 1);
  assert.deepEqual(answer(mine[2]).tracks.map((t: any) => t.id), ["cozy-3"]);
  assert.deepEqual(answer(mine[3]).tracks.map((t: any) => t.id), ["cozy-4"]);
  assert.equal(mine[4].result.isError, true);
  // music_add: copied into media/ under its own name, the same bytes as the bundled file; audio media on the turn.
  const added = answer(mine[5]);
  assert.equal(added.media, "m-sleepy-upright-piano-seamless-loop");
  assert.equal(added.path, "media/cozy-4.m4a");
  const track = MUSIC_TRACKS.find((t) => t.id === "cozy-4")!;
  assert.equal(added.frames, Math.floor(track.seconds * 30));
  assert.match(added.next, /"type":"audio","media":"m-sleepy-upright-piano-seamless-loop"/);
  assert.ok(readFileSync(join(dir, "media", "cozy-4.m4a")).equals(readFileSync(resolve("assets/music/cozy-4.m4a"))));
  const again = answer(mine[6]);
  assert.equal(again.media, added.media);
  assert.match(again.note, /already in the project/);
  assert.equal(mine[7].result.isError, true);
  assert.match(mine[7].result.content[0].text, /"cozy-99" isn't one/);
  assert.equal(answer(mine[9]).ok, true, JSON.stringify(answer(mine[9])));
  assert.equal(answer(mine[10]).tracks[0].media, added.media, "music_list says it's in the project");
  const p = onDisk();
  const media = p.media.find((m) => m.id === added.media)!;
  assert.deepEqual(media, { id: added.media, kind: "audio", name: track.title, path: "media/cozy-4.m4a", probe: { frames: added.frames, hasAudio: true } });
  // The real file is at least as long as the frames say.
  const seconds = Number(execFileSync(FFPROBE!, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(dir, media.path)], { encoding: "utf8" }));
  assert.ok(seconds * 30 >= added.frames, `${seconds} s`);
  assert.deepEqual(p.tracks.find((t) => t.id === "audio")!.items.map((i) => i.id), ["music-1"]);
  // The card: the add is an edit of the turn, with its line.
  assert.ok(turn.edits.some((e: any) => e.summary === `Added ${track.title} from the music library` && /Added media Sleepy Upright Piano Seamless Loop \(m-sleepy-upright-piano-seamless-loop\)/.test(e.lines[0])), JSON.stringify(turn.edits));
  // Undo turn: the item and the media go (the copy stays in media/, reused by the next add).
  await client.ok("agent.undoTurn", { turnId: turn.id });
  const back = onDisk();
  assert.ok(!back.media.some((m) => m.id === added.media));
  assert.deepEqual(back.tracks.find((t) => t.id === "audio")!.items, []);
  assert.ok(existsSync(join(dir, "media", "cozy-4.m4a")));
});

test("the tools, their labels and the system prompt's taste and music notes", { skip }, () => {
  for (const name of ["project_check", "music_list", "music_add"]) {
    assert.ok((TOOL_NAMES as ReadonlyArray<string>).includes(name));
    assert.ok(mcpTools().some((t) => t.name === name), name);
  }
  assert.equal(stepLabel("project_check", {}), "Checked the video against the taste checks");
  assert.equal(stepLabel("music_list", { mood: "calm", tempo: "slow" }), "Looked for calm slow music in the library");
  assert.equal(stepLabel("music_list", {}), "Looked through the music library");
  assert.equal(stepLabel("music_add", { id: "cozy-2" }), "Added Dusty rhodes neo soul loop from the music library");
  assert.match(SYSTEM_PROMPT, /run project_check and fix each warning/);
  assert.match(SYSTEM_PROMPT, /words ÷ 3 s \(2 s minimum/);
  assert.match(SYSTEM_PROMPT, /never ·, • or \* between words/);
  assert.match(SYSTEM_PROMPT, /music_add copies one into the project's media/);
  assert.match(SYSTEM_PROMPT, /-16 LUFS/);
  assert.match(SYSTEM_PROMPT, /ui_show panel "checks"/);
  assert.doesNotMatch(SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("- Taste")), /swmansion/);
  const prompt = JSON.parse(readFileSync(join(root, "prompts.jsonl"), "utf8").trim().split("\n")[0]!);
  assert.match(prompt.system ?? "", /project_check/, "the CLI gets it");
});
