// D105 on the bundled server through the scripted stand-in for claude (helpers/fake-claude.ts):
// - media_import of a .srt makes a Subtitles track (the answer says so, one agent edit, step label);
//   project_read mentions the cues; subtitles_export writes the file next to project.json, then a
//   .vtt at a path; refusals (an existing file, a bad format, a mismatched extension); Undo turn;
// - the tool's schema, label and system prompt line.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mcpTools, stepLabel, SYSTEM_PROMPT, TOOL_NAMES } from "../../apps/server/src/agent/agentTools.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const DESKTOP = resolve("apps/desktop/dist/main.cjs");
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
const skip = !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA) || !existsSync(DESKTOP) ? "server bundle, desktop or media core not built (run pnpm build)" : !FFMPEG || !FFPROBE ? "ffmpeg isn't installed" : false;

const SRT = "1\n00:00:00,500 --> 00:00:01,500\nHello there\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond <i>cue</i>\n\n3\n00:00:09,000 --> 00:00:10,000\nPast the end\n";

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
type Content = Array<{ type: string; text?: string; data?: string }>;
let root = "";
let footage = "";
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
  const before = readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).length;
  const { turnId } = await client.ok("agent.send", { prompt });
  await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 120000);
  const turn = agent.values.at(-1).turns.find((t: any) => t.id === turnId);
  const results = readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).slice(before).map((l) => JSON.parse(l).result as { isError?: boolean; content: Content });
  return { turn, results };
}
const textOf = (r: { content: Content }) => r.content.find((c) => c.type === "text")!.text!;
const jsonOf = (r: { content: Content }) => JSON.parse(textOf(r));

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-subtitles-")));
  mkdirSync(join(root, "projects"));
  footage = join(root, "Footage");
  mkdirSync(footage);
  execFileSync(FFMPEG!, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(footage, "Talk.mp4")]);
  writeFileSync(join(footage, "talk.srt"), SRT);
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
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Subtitled" });
  dir = snap.dir;
  await agent.until((s) => s?.dir === dir);
  const { turn } = await ask("import the talk and put it on the timeline", [
    { tool: "media_import", args: { path: join(footage, "Talk.mp4") } },
    { tool: "project_read", args: {} },
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Add the talk", ops: [{ op: "insert_item", track: "main", item: { id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 180 } }] } },
  ]);
  assert.equal(turn.status, "done", turn.error);
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("media_import of a .srt, project_read, subtitles_export as .srt and .vtt, refusals, Undo turn", { skip, timeout: 180000 }, async () => {
  const vtt = join(dir, "out.vtt");
  // A subtitles file inside the project folder, imported: never written over.
  mkdirSync(join(dir, "media"), { recursive: true });
  const inside = join(dir, "media", "inside.srt");
  writeFileSync(inside, "1\n00:00:04,000 --> 00:00:05,000\nInside\n");
  const { turn, results } = await ask("import the subtitles and export them", [
    { tool: "media_import", args: { paths: [join(footage, "talk.srt"), inside] } },
    { tool: "project_read", args: {} },
    { tool: "subtitles_export", args: {} },
    { tool: "subtitles_export", args: { path: vtt } },
    { tool: "subtitles_export", args: {} },
    { tool: "subtitles_export", args: { format: "ass" } },
    { tool: "subtitles_export", args: { path: join(root, "x.srt"), format: "vtt" } },
    { tool: "subtitles_export", args: { path: "relative.srt" } },
    { tool: "subtitles_export", args: { path: join(root, "outside.srt") } },
    { tool: "subtitles_export", args: { path: "~/uncut-agent-subtitles-test.srt" } },
    { tool: "subtitles_export", args: { path: inside, overwrite: true } },
  ]);
  assert.equal(turn.status, "done", turn.error);
  assert.deepEqual(
    turn.items.filter((i: any) => i.kind === "step").map((i: any) => i.text),
    ["Imported 2 paths", "Read the timeline", "Saved the subtitles as SRT", "Saved the subtitles as out.vtt", "Saved the subtitles as SRT", "Saved the subtitles as SRT", "Saved the subtitles as x.srt", "Saved the subtitles as relative.srt", "Saved the subtitles as outside.srt", "Saved the subtitles as uncut-agent-subtitles-test.srt", "Saved the subtitles as inside.srt"],
  );
  const imported = jsonOf(results[0]!);
  assert.equal(results[0]!.isError, undefined, textOf(results[0]!));
  assert.deepEqual(imported.imported, []);
  assert.deepEqual(imported.subtitles.map((s: any) => [s.track, s.cues]), [["subtitles-track-1", 2], ["subtitles-track-2", 1]]);
  assert.equal(turn.edits[0].summary, "Imported 2 files");
  assert.match(turn.edits[0].lines[0], /Imported 2 subtitle cues from talk\.srt as track subtitles-track-1/);

  const read = jsonOf(results[1]!);
  assert.match(read.subtitles, /^3 subtitle cues .*subtitles_export/);
  const track = read.tracks.find((t: any) => t.name === "Subtitles");
  assert.deepEqual(track.items.map((i: any) => [i.start, i.duration, i.text]), [[15, 30, "Hello there"], [60, 30, "Second cue"]]);
  assert.equal(read.duration, 180, "the cue past the end was left out");

  const saved = jsonOf(results[2]!);
  assert.equal(results[2]!.isError, undefined, textOf(results[2]!));
  assert.deepEqual([saved.path, saved.format, saved.cues], [join(dir, "Subtitled.srt"), "srt", 3]);
  assert.deepEqual(saved.first[0], { from: 15, to: 45, time: "00:00:00,500 --> 00:00:01,500", text: "Hello there" });
  assert.equal(readFileSync(join(dir, "Subtitled.srt"), "utf8"), "1\n00:00:00,500 --> 00:00:01,500\nHello there\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond cue\n\n3\n00:00:04,000 --> 00:00:05,000\nInside\n");
  assert.equal(jsonOf(results[3]!).format, "vtt");
  assert.equal(readFileSync(vtt, "utf8"), "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nHello there\n\n00:00:02.000 --> 00:00:03.000\nSecond cue\n\n00:00:04.000 --> 00:00:05.000\nInside\n\n");

  assert.match(jsonOf(results[4]!).refused, /Subtitled\.srt already exists in that folder/);
  assert.match(jsonOf(results[4]!).note, /overwrite: true/);
  assert.match(textOf(results[5]!), /format must be "srt" or "vtt"/);
  assert.match(textOf(results[6]!), /path ends in \.srt but format is vtt/);
  assert.match(textOf(results[7]!), /isn't an absolute path/);
  // Outside the project folder (absolute or ~): refused, pointing at the Export dialog; an imported file is never written over.
  for (const k of [8, 9]) assert.match(textOf(results[k]!), /saves inside the project folder only .*Export dialog/);
  assert.ok(!existsSync(join(root, "outside.srt")) && !existsSync(join(homedir(), "uncut-agent-subtitles-test.srt")));
  assert.match(jsonOf(results[10]!).refused, /inside\.srt is a subtitles file this project imported, and Uncut never writes over it/);
  assert.equal(readFileSync(inside, "utf8"), "1\n00:00:04,000 --> 00:00:05,000\nInside\n");
  for (const k of [4, 5, 6, 7, 8, 9, 10]) assert.equal(results[k]!.isError, true);

  const undone = await client.ok("agent.undoTurn", { turnId: turn.id });
  assert.ok(!undone.project.tracks.some((t: any) => t.name === "Subtitles"), "Undo turn takes the Subtitles track away");
});

test("subtitles_export's schema, label and the prompt", () => {
  assert.ok(TOOL_NAMES.includes("subtitles_export"));
  const tool = mcpTools().find((t) => t.name === "subtitles_export")!;
  assert.deepEqual(Object.keys((tool.inputSchema as any).properties).sort(), ["format", "overwrite", "path"]);
  assert.equal(stepLabel("subtitles_export", { format: "vtt" }), "Saved the subtitles as WebVTT");
  assert.equal(stepLabel("subtitles_export", { path: "/x/talk.srt" }), "Saved the subtitles as talk.srt");
  assert.match(SYSTEM_PROMPT, /subtitles_export writes the subtitles as a file/);
  assert.match(SYSTEM_PROMPT, /media_import of a \.srt or \.vtt file puts its cues on a new "Subtitles" text track/);
});
