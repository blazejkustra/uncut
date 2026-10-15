// Phase 6 chunk 7 (D84–D88) on the bundled server through the scripted stand-in for claude
// (helpers/fake-claude.ts, never the real one) and the real MCP server: modules_list shows the audio
// effects (heard in the preview, noise removal too, D246); the agent adds the voice preset to the
// voice track, ducks the music under the voice and sets a −23 LUFS target with timeline_edit; the
// edit starts the voice's loudness analysis (ducking needs it) and says so; the card's lines read
// the chain; the export plan of the result ducks the music during the speech; Undo turn takes it
// all back; the system prompt documents it and no longer says audio effects aren't heard.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SYSTEM_PROMPT } from "../../apps/server/src/agent/agentTools.ts";
import { planExport } from "../../apps/server/src/export/exportPlan.ts";
import { cachedFor, targetOf, type LoudnessResult } from "../../apps/server/src/analysis/analysis.ts";
import { decodeEnvelope, VOICE_PRESET, type Project } from "../../packages/core/src/index.ts";
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
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const results = () => readFileSync(resultLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l));

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-effects-")));
  mkdirSync(join(root, "projects"));
  const footage = join(root, "Footage");
  mkdirSync(footage);
  // Voice: a 300 Hz "phrase" from 1.5 to 3 s of 5 s; music: a steady 660 Hz bed.
  ff("-f", "lavfi", "-i", "aevalsrc='0.3*sin(2*PI*300*t)*between(t,1.5,3)':s=48000:d=5", "-c:a", "aac", join(footage, "Voice.m4a"));
  ff("-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", "5", "-c:a", "aac", join(footage, "Music.m4a"));
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
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Effects" });
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
          { op: "insert_item", track: "voice", item: { id: "v", type: "audio", media: "m-voice", in: 0, start: 0, duration: 150 } },
          { op: "insert_item", track: "music", item: { id: "s", type: "audio", media: "m-music", in: 0, start: 0, duration: 150 } },
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

test("the agent lists the audio effects, adds the voice preset, ducks the music under the voice and sets −23 LUFS; Undo turn takes it back", { skip, timeout: 180000 }, async () => {
  const before = results().length;
  const turn = await ask("make the voice sound better, duck the music under it and make it broadcast loudness", [
    { tool: "modules_list", args: { kind: "audio-processor" } },
    { tool: "project_read", args: {} },
    {
      tool: "timeline_edit",
      args: {
        baseRevision: "$rev",
        summary: "Voice preset, music ducked under the voice, −23 LUFS",
        ops: [
          { op: "update_track", track: "voice", set: { mixer: { effects: VOICE_PRESET } } },
          { op: "update_track", track: "music", set: { mixer: { gainDb: -6, effects: [{ module: "audio.duck", params: { under: ["voice"], amountDb: -12, attackMs: 250, releaseMs: 600 } }] } } },
          { op: "update_project", set: { master: { loudness: { targetLufs: -23 } } } },
        ],
      },
    },
  ]);
  assert.equal(turn.status, "done", turn.error);
  const mine = results().slice(before);
  // modules_list: the six audio processors with their params; every one is heard in the preview.
  const modules = JSON.parse(mine[0].result.content[0].text) as Array<{ id: string; showsInPreview: boolean; exportOnly?: boolean; params?: { properties?: Record<string, unknown> } }>;
  const byId = new Map(modules.map((m) => [m.id, m]));
  // Every one is heard in the preview since D246 (noise removal too); nothing is export-only.
  for (const id of ["audio.eq", "audio.compressor", "audio.voice-enhance", "audio.denoise", "audio.duck", "audio.limiter"]) assert.equal(byId.get(id)?.showsInPreview, true, `${id} is heard in the preview`);
  assert.equal(byId.get("audio.denoise")?.exportOnly, undefined);
  assert.ok(byId.get("audio.eq")?.params?.properties?.lowCutHz, "EQ params listed");
  assert.ok(byId.get("audio.duck")?.params?.properties?.attackMs, "duck params listed");
  // The edit: saved as sent; the answer says the voice's loudness was measured for ducking.
  const p = onDisk();
  assert.deepEqual(p.tracks.find((t) => t.id === "voice")!.mixer, { effects: VOICE_PRESET });
  assert.deepEqual(p.tracks.find((t) => t.id === "music")!.mixer, { gainDb: -6, effects: [{ module: "audio.duck", params: { under: ["voice"], amountDb: -12, attackMs: 250, releaseMs: 600 } }] });
  assert.deepEqual(p.master, { loudness: { targetLufs: -23 } });
  const edit = JSON.parse(mine[2].result.content[0].text);
  assert.equal(edit.ok, true);
  assert.match(edit.ducking, /Measured the loudness of Voice\.m4a for ducking/);
  assert.deepEqual(turn.edits[0].lines, [
    "Set effects of track voice: EQ (low cut 80 Hz, +4 dB at 3.5 kHz), Compressor (−20 dB, 2.5:1, make-up +2 dB)",
    "Set effects of track music: ducking under voice, −12 dB; volume −6 dB",
    "Set the master: loudness target Broadcast (−23 LUFS)",
  ]);
  // The loudness analysis is cached, and the export plan of the result ducks the music during the speech (1.5–3 s).
  const voice = p.media.find((m) => m.id === "m-voice")!;
  const loud = (await cachedFor(targetOf(dir, voice, p.canvas.fps), "loudness")) as LoudnessResult | undefined;
  assert.ok(loud?.hasAudio && loud.envelope, "the voice's loudness is cached");
  const exported = planExport(p, { mediaPath: (m) => join(dir, m.path), width: 640, height: 360, envelopes: new Map([["m-voice", decodeEnvelope(loud.envelope)!]]) });
  assert.ok(!("problem" in exported));
  const duck = exported.audio.find((a) => a.track === "music")!.gain.duck!;
  assert.ok(duck.length === 4 && Math.abs(duck[1]!.frame / 30 - 1.5) < 0.1 && Math.abs(duck[2]!.frame / 30 - 3) < 0.1 && duck[1]!.db === -12, JSON.stringify(duck));
  assert.deepEqual(exported.buses.map((b) => b.track), ["voice"], "the voice's effects are its own bus");
  // A wrong value is refused with the manifest's reason.
  const bad = await ask("duck it more", [
    { tool: "project_read", args: {} },
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Too far", ops: [{ op: "update_track", track: "music", set: { mixer: { effects: [{ module: "audio.duck", params: { under: ["voice"], amountDb: 3 } }] } } }] } },
  ]);
  assert.equal(bad.status, "done");
  const refused = results().at(-1).result;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /audio\.duck: must be <= 0/);
  // Deleting the key track the music ducks under is refused with a reason that names both.
  const del = await ask("delete the voice track", [
    { tool: "project_read", args: {} },
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Delete voice", ops: [{ op: "delete_track", track: "voice" }] } },
  ]);
  assert.equal(del.status, "done");
  const delRefused = results().at(-1).result;
  assert.equal(delRefused.isError, true);
  assert.match(delRefused.content[0].text, /track \\"Music\\" \(music\) ducks under track \\"voice\\", which doesn't exist: remove or retarget its audio\.duck entry/);
  assert.ok(onDisk().tracks.some((t) => t.id === "voice"), "nothing was deleted");

  await client.ok("agent.undoTurn", { turnId: turn.id });
  const back = onDisk();
  assert.equal(back.tracks.find((t) => t.id === "voice")!.mixer, undefined);
  assert.equal(back.tracks.find((t) => t.id === "music")!.mixer, undefined);
  assert.equal(back.master, undefined);
});

test("the system prompt: effects, the voice preset, ducking, the limiter and targets are documented; nothing says audio effects aren't heard", { skip }, () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /audio effects are saved but not heard/);
  assert.match(SYSTEM_PROMPT, /Track effects \(D84\) are mixer\.effects/);
  assert.match(SYSTEM_PROMPT, /The voice preset is an EQ and a compressor/);
  assert.match(SYSTEM_PROMPT, /"module":"audio\.duck","params":\{"under":\["voice"\]/);
  assert.match(SYSTEM_PROMPT, /The master limiter \(D86\) is on by default at −1 dBTP/);
  assert.match(SYSTEM_PROMPT, /master\.loudness \{"targetLufs":-23\}/);
  assert.doesNotMatch(SYSTEM_PROMPT, /export only/);
  assert.match(SYSTEM_PROMPT, /track effects \(EQ, compressor, voice, noise removal\)/);
  const prompt = JSON.parse(readFileSync(join(root, "prompts.jsonl"), "utf8").trim().split("\n")[0]!);
  assert.match(prompt.system ?? "", /audio\.duck/, "the CLI gets it");
});

test("a project saved before v0.2 of the audio manifests opens, edits and undoes (old EQ bands, deep duck, low limiter, unbounded ratio)", { skip, timeout: 60000 }, async () => {
  const old = join(root, "projects", "Old.uncut");
  mkdirSync(old);
  const project: Project = {
    ...onDisk(),
    name: "Old",
    tracks: onDisk().tracks.map((t) =>
      t.id === "voice"
        ? { ...t, mixer: { effects: [{ module: "audio.eq", params: { lowCutHz: 5, bands: [{ f: 1000, g: 3 }] } }, { module: "audio.compressor", params: { ratio: 30, thresholdDb: -80 } }] } }
        : t.id === "music"
          ? { ...t, mixer: { effects: [{ module: "audio.duck", params: { under: [], amountDb: -60 } }] } }
          : t,
    ),
    master: { effects: [{ module: "audio.limiter", params: { ceilingDb: -20 } }] },
  };
  // Media paths stay valid from the new folder: absolute.
  const media = project.media.map((m) => ({ ...m, path: m.path.startsWith("/") ? m.path : join(dir, m.path) }));
  writeFileSync(join(old, "project.json"), JSON.stringify({ ...project, media }, null, 2));
  const opened = await client.ok("project.open", { dir: old });
  assert.equal(opened.project.name, "Old");
  const edited = await client.ok("project.edit", { baseRevision: opened.revision, ops: [{ op: "update_project", set: { master: { gainDb: -3, effects: project.master!.effects } } }] });
  assert.equal(edited.project.master.gainDb, -3);
  const undone = await client.ok("project.undo");
  assert.deepEqual(undone.project.master, project.master, "undo back into the old shape is allowed");
  const redone = await client.ok("project.redo");
  assert.equal(redone.project.master.gainDb, -3);
  await client.ok("project.open", { dir });
});
