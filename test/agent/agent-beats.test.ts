// Phase 5 chunk 6 (D70) on the bundled server: media_analyze ["beats"] through the scripted
// stand-in for claude (helpers/fake-claude.ts) and the real MCP server. ffmpeg is reached through a
// logging shim first on PATH, so the test counts the beats decodes.
// - A 120 BPM click track (12 s, first click at 0.2 s): bpm, confidence, beat count, the first
//   beats in project frames (6, 21, 36, …); "tempo" again comes from the cache without ffmpeg; a
//   range lists the beats and onsets inside it; a clip without sound has none.
// - The tool's schema takes the aliases; the step label and the system prompt know beats.
// Media is made here (TS-synthesised WAV, ffmpeg lavfi); nothing from the user's footage folder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { clickTrack, writeWav } from "../helpers/beats-audio.ts";
import { mcpTools, stepLabel, SYSTEM_PROMPT } from "../../apps/server/src/agent/agentTools.ts";
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
const skip = !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA) ? "server bundle or media core not built (run pnpm build)" : !FFMPEG || !FFPROBE ? "ffmpeg isn't installed" : false;

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
type Content = Array<{ type: string; text?: string }>;
let root = "";
let shimDir = "";
let server: Server;
let client: Client;
let agent: ReturnType<Client["subscribe"]>;
const plan = () => join(root, "plan.json");
const resultLog = () => join(root, "results.jsonl");
const callLog = () => join(shimDir, "calls.log");
/** ffmpeg runs of the beats analyzer so far (mono PCM at 11025 Hz on stdout). */
const beatsRuns = () => (existsSync(callLog()) ? readFileSync(callLog(), "utf8").split("\n").filter((l) => l.includes("-ar 11025")) : []);

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
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-beats-")));
  mkdirSync(join(root, "projects"));
  const footage = join(root, "Footage");
  mkdirSync(footage);
  writeWav(join(footage, "Song.wav"), clickTrack(120, 12, 0.2).buf);
  execFileSync(FFMPEG!, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=0x00A000:size=320x180:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(footage, "Still.mp4")]);
  shimDir = join(root, "bin");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "ffmpeg"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${callLog()}"\nexec "${FFMPEG}" "$@"\n`);
  chmodSync(join(shimDir, "ffmpeg"), 0o755);
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(resultLog(), "");
  server = await startServer({
    env: {
      PATH: `${shimDir}:${dirname(FFMPEG!)}:${process.env.PATH}`,
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_CLAUDE: FAKE,
      UNCUT_ANALYZE_WAIT_MS: "20000",
      FAKE_PLAN: plan(),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_RESULT_LOG: resultLog(),
    },
  });
  client = await connect(server.ready.port, server.ready.token);
  agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Beats test" });
  await agent.until((s) => s?.dir === snap.dir);
  const { turn } = await ask("import the footage", [{ tool: "media_import", args: { path: footage } }]);
  assert.equal(turn.status, "done", turn.error);
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("media_analyze beats: bpm, confidence and the first beats in project frames; cached re-ask; range; no sound", { skip, timeout: 120000 }, async () => {
  const { turn, results } = await ask("what's the tempo of the song?", [
    { tool: "project_read", args: {} },
    { tool: "media_analyze", args: { media: "m-song", analyzers: ["beats"] } },
    { tool: "media_analyze", args: { media: "m-song", analyzers: ["tempo"] } },
    { tool: "media_analyze", args: { media: "m-song", analyzers: ["rhythm"], range: { start: 60, end: 120 } } },
    { tool: "media_analyze", args: { media: "m-still", analyzers: ["onsets"] } },
  ]);
  assert.equal(turn.status, "done", turn.error);
  assert.deepEqual(
    turn.items.filter((i: any) => i.kind === "step").map((i: any) => i.text),
    ["Read the timeline", "Found the beats in Song.wav", "Found the beats in Song.wav", "Found the beats in Song.wav", "Found the beats in Still.mp4"],
  );
  const [read, first, again, ranged, still] = results;
  assert.equal(jsonOf(read!).canvas.fps, 30);
  const out = jsonOf(first!);
  assert.equal(out.loudness, undefined, "only what was asked");
  const b = out.beats;
  assert.equal(b.state, "done", JSON.stringify(b));
  assert.equal(b.cached, false);
  assert.equal(b.hasAudio, true);
  assert.ok(Math.abs(b.bpm - 120) <= 1, `bpm ${b.bpm}`);
  assert.ok(b.confidence >= 0.5, `confidence ${b.confidence}`);
  assert.equal(b.beatCount, 24, "a click every 0.5 s from 0.2 s to 11.7 s");
  assert.equal(b.beatFrames, 15);
  assert.equal(b.firstBeat.frame, 6);
  assert.ok(Math.abs(b.firstBeat.seconds - 0.2) <= 0.03);
  assert.deepEqual(b.beats.frames.slice(0, 5), [6, 21, 36, 51, 66]);
  assert.equal(b.beats.frames.length, 24);
  assert.equal(b.onsetCount, 24);
  assert.match(out.note, /^beats: tempo \(bpm\)/);
  assert.equal(beatsRuns().length, 1, "one decode");
  assert.ok(beatsRuns()[0]!.includes("-map 0:a:0"));

  // "tempo" is the same job: from the cache, no ffmpeg.
  const second = jsonOf(again!).beats;
  assert.equal(second.cached, true);
  assert.deepEqual(second.beats, b.beats);
  assert.equal(beatsRuns().length, 1, "no ffmpeg for the cached re-ask");

  // A range: the beats and onsets inside it.
  const r = jsonOf(ranged!).beats;
  assert.deepEqual(r.beats.frames, [66, 81, 96, 111]);
  assert.equal(r.beats.count, 4);
  assert.equal(r.onsets.count, 4);
  assert.deepEqual(r.onsets.list.map((o: any) => o.frame), [66, 81, 96, 111]);
  assert.ok(r.onsets.list.every((o: any) => o.strength > 0.5));

  // The timeline's read: the cached beats without their onsets (analysis.cached omit), no job.
  const lean = (await client.ok("analysis.cached", { mediaId: "m-song", analyzer: "beats", omit: ["onsets"] })).result;
  assert.equal(lean.onsets, undefined);
  assert.equal(lean.beats.length, 24);
  assert.ok(Math.abs(lean.bpm - 120) <= 1);
  assert.equal((await client.ok("analysis.cached", { mediaId: "m-song", analyzer: "beats" })).result.onsets.length, 24, "without omit: all of it");
  assert.equal(beatsRuns().length, 1);

  // No sound: answered from the probe, no job.
  const s = jsonOf(still!).beats;
  assert.equal(s.hasAudio, false);
  assert.equal(beatsRuns().length, 1);
});

test("the tool schema, step labels and system prompt know beats", () => {
  const tool = mcpTools().find((t) => t.name === "media_analyze")!;
  const items = ((tool.inputSchema.properties as any).analyzers.items.enum as Array<string>);
  for (const name of ["beats", "rhythm", "onsets", "tempo"]) assert.ok(items.includes(name), name);
  assert.match(tool.description, /'beats' \(also 'rhythm', 'onsets', 'tempo'\)/);
  assert.doesNotMatch(tool.description, /Beats and description come later/);
  assert.equal(stepLabel("media_analyze", { media: "m-song", analyzers: ["tempo", "beats"] }), "Found the beats in m-song");
  assert.equal(stepLabel("media_analyze", { media: "m-song", analyzers: ["beats", "loudness"] }), "Analysed m-song");
  assert.match(AGENT_TEXT, /'beats' \(also 'rhythm', 'onsets', 'tempo'\)/);
  assert.doesNotMatch(AGENT_TEXT, /Beats come later/);
});
