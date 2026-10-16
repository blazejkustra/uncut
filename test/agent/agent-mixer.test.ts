// Phase 6 chunk 6 (D83) on the bundled server through the scripted stand-in for claude
// (helpers/fake-claude.ts, never the real one) and the real MCP server: the agent pans a track,
// solos another and sets the master volume with timeline_edit (update_track's mixer, update_project's
// master); the project, the turn card's lines and Undo turn follow; the system prompt says pan and
// solo are heard and how the master works; the export plan of the result honours all three.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SYSTEM_PROMPT } from "../../apps/server/src/agent/agentTools.ts";
import { planExport } from "../../apps/server/src/export/exportPlan.ts";
import { panGains } from "../../packages/core/src/index.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { AGENT_TEXT } from "../helpers/agentText.ts";

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

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let server: Server;
let client: Client;
let agent: ReturnType<Client["subscribe"]>;
let dir = "";
const plan = () => join(root, "plan.json");
const resultLog = () => join(root, "results.jsonl");
const ff = (...args: Array<string>) => execFileSync(FFMPEG!, ["-v", "error", "-y", ...args]);
const turns: Array<unknown> = [];
async function ask(prompt: string, steps: Array<unknown>) {
  turns.push(steps);
  writeFileSync(plan(), JSON.stringify(turns));
  const { turnId } = await client.ok("agent.send", { prompt });
  await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 120000);
  return agent.values.at(-1).turns.find((t: any) => t.id === turnId);
}
const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-mixer-")));
  mkdirSync(join(root, "projects"));
  const footage = join(root, "Footage");
  mkdirSync(footage);
  ff("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", "-c:a", "aac", join(footage, "Voice.m4a"));
  ff("-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", "4", "-c:a", "aac", join(footage, "Music.m4a"));
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
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Mixer" });
  dir = snap.dir;
  await agent.until((s) => s?.dir === dir);
  const turn = await ask("put the voice and the music on two audio tracks", [
    { tool: "media_import", args: { path: footage } },
    { tool: "project_read", args: {} },
    {
      tool: "timeline_edit",
      args: {
        baseRevision: "$rev",
        summary: "Add voice and music",
        ops: [
          { op: "add_track", track: { id: "voice", kind: "audio", name: "Voice", items: [] } },
          { op: "add_track", track: { id: "music", kind: "audio", name: "Music", items: [] } },
          { op: "insert_item", track: "voice", item: { id: "v", type: "audio", media: "m-voice", in: 0, start: 0, duration: 120 } },
          { op: "insert_item", track: "music", item: { id: "s", type: "audio", media: "m-music", in: 0, start: 0, duration: 120 } },
        ],
      },
    },
  ]);
  assert.equal(turn.status, "done", turn.error);
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the agent pans the music, solos the voice and sets the master volume; the card says so; Undo turn takes it back", { skip, timeout: 120000 }, async () => {
  const turn = await ask("pan the music a bit left, solo the voice and bring the master down 3 dB", [
    { tool: "project_read", args: {} },
    {
      tool: "timeline_edit",
      args: {
        baseRevision: "$rev",
        summary: "Mix: music left, voice solo, master −3 dB",
        ops: [
          { op: "update_track", track: "music", set: { mixer: { gainDb: -6, pan: -0.4 } } },
          { op: "update_track", track: "voice", set: { mixer: { solo: true } } },
          { op: "update_project", set: { master: { gainDb: -3 } } },
        ],
      },
    },
  ]);
  assert.equal(turn.status, "done", turn.error);
  const p = onDisk();
  assert.deepEqual(p.tracks.find((t: any) => t.id === "music").mixer, { gainDb: -6, pan: -0.4 });
  assert.deepEqual(p.tracks.find((t: any) => t.id === "voice").mixer, { solo: true });
  assert.deepEqual(p.master, { gainDb: -3 });
  assert.deepEqual(turn.edits[0].lines, ["Set volume of track music to −6 dB, panned 40 % left", "Set mixer of track voice: soloed", "Set master volume to −3 dB"]);
  // The export of this project: only the soloed voice, at the master volume; the music would be panned.
  const exported = planExport(p, { mediaPath: (m) => join(dir, m.path), width: 640, height: 360 });
  assert.ok(!("problem" in exported));
  assert.deepEqual(exported.audio.map((a) => a.item.id), ["v"]);
  assert.ok(Math.abs(exported.masterGain - 10 ** (-3 / 20)) < 1e-9);
  const unsolo = planExport({ ...p, tracks: p.tracks.map((t: any) => (t.id === "voice" ? { ...t, mixer: undefined } : t)) }, { mediaPath: (m) => m.path, width: 640, height: 360 });
  assert.ok(!("problem" in unsolo));
  assert.deepEqual(unsolo.audio.find((a) => a.item.id === "s")!.pan, panGains(-0.4));

  // A wrong value is refused with the schema's reason, nothing changes.
  const bad = await ask("pan it further", [
    { tool: "project_read", args: {} },
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Too far", ops: [{ op: "update_track", track: "music", set: { mixer: { pan: -2 } } }] } },
  ]);
  assert.equal(bad.status, "done");
  const results = readFileSync(resultLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l).result);
  const lastResult = results.at(-1);
  // project_read shows the mix and says what the solo leaves audible.
  const summary = JSON.parse(results.at(-2).content[0].text);
  const read = summary.project ?? summary;
  assert.deepEqual(read.tracks.find((t: any) => t.id === "music").mixer, { gainDb: -6, pan: -0.4 });
  assert.deepEqual(read.master, { gainDb: -3 });
  assert.equal(read.mixNote, "Solo is on: only Voice will be heard, in the preview and the export.");
  assert.equal(lastResult.isError, true, JSON.stringify(lastResult));
  assert.equal(onDisk().tracks.find((t: any) => t.id === "music").mixer.pan, -0.4);

  await client.ok("agent.undoTurn", { turnId: turn.id });
  const back = onDisk();
  assert.equal(back.tracks.find((t: any) => t.id === "music").mixer, undefined);
  assert.equal(back.tracks.find((t: any) => t.id === "voice").mixer, undefined);
  assert.equal(back.master, undefined);
});

test("the system prompt: pan, solo and the master volume are heard, with an example; nothing says pan isn't heard", { skip }, () => {
  assert.doesNotMatch(AGENT_TEXT, /pan (are|is) saved but not heard|pan are saved/);
  assert.match(AGENT_TEXT, /mixer\.pan from -1 \(left\)/);
  assert.match(AGENT_TEXT, /mixer\.solo \(if any track is soloed, only soloed tracks sound, in the preview and the export/);
  assert.match(AGENT_TEXT, /"op":"update_project","set":\{"master":\{"gainDb":-3\}\}/);
  assert.match(AGENT_TEXT, /track volume, pan, mute and solo, track effects \(EQ, compressor, voice, noise removal\), ducking, the master volume and the master limiter/);
  const prompt = JSON.parse(readFileSync(join(root, "prompts.jsonl"), "utf8").trim().split("\n")[0]!);
  assert.match(prompt.system ?? "", /docs_read \{topic\}[^\n]*sound/, "the CLI is told where the sound reference is");
});
