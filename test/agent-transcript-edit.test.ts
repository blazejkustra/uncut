// Phase 5 chunk 5 (D69) on the bundled server: transcript_edit through the scripted stand-in for
// claude (helpers/fake-claude.ts) and the real MCP server. The transcript is a fake one written
// into the analysis cache (<project>/.cache/analysis/<fingerprint>/transcript.json), so no whisper
// runs: the PATH has only ffmpeg and ffprobe (a media without a cached transcript then fails with
// "whisper.cpp isn't installed").
// - dryRun answers the plan (removed text, frames, the new length) and changes nothing.
// - Applying cuts the word and the pauses as ONE agent edit on the turn; a second ask for the same
//   word is a no-op with a note; Undo turn restores the clip.
// - Refusals with sentences; step labels.
// All media is made here with ffmpeg; nothing from ~/Documents/devrel/drone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fingerprint, writeCached } from "../apps/server/src/analysis.ts";
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

// Words on round frames at 30 fps (the same as test/text-cut.test.ts).
const WORDS = [
  { text: "Hello", start: 0.5, end: 1.0, p: 0.9 },
  { text: "um", start: 1.2, end: 1.5, p: 0.8 },
  { text: "this", start: 1.6, end: 2.0, p: 0.9 },
  { text: "is", start: 2.1, end: 2.3, p: 0.9 },
  { text: "a", start: 2.4, end: 2.5, p: 0.9 },
  { text: "test.", start: 2.6, end: 3.0, p: 0.9 },
  { text: "Second", start: 4.0, end: 4.5, p: 0.9 },
  { text: "part", start: 4.6, end: 5.0, p: 0.9 },
];
const TRANSCRIPT = { hasAudio: true, seconds: 6, language: "en", requestedLanguage: "auto", model: "base", segments: [{ start: 0.5, end: 5, text: "Hello um this is a test. Second part", words: [0, 8] }], words: WORDS };

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
type Content = Array<{ type: string; text?: string }>;
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
  const before = readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).length;
  const { turnId } = await client.ok("agent.send", { prompt });
  await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 120000);
  const turn = agent.values.at(-1).turns.find((t: any) => t.id === turnId);
  const results = readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).slice(before).map((l) => JSON.parse(l).result as { isError?: boolean; content: Content });
  return { turn, results };
}
const textOf = (r: { content: Content }) => r.content.find((c) => c.type === "text")!.text!;
const jsonOf = (r: { content: Content }) => JSON.parse(textOf(r));
const mainOf = (snap: any) => snap.project.tracks.find((t: any) => t.role === "main").items.map((i: any) => [i.id, i.media, i.in, i.duration]);

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-transcript-edit-")));
  mkdirSync(join(root, "projects"));
  const footage = join(root, "Footage");
  mkdirSync(footage);
  for (const name of ["Talk", "Other"]) {
    ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", `sine=frequency=${name === "Talk" ? 300 : 500}:sample_rate=48000`, "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(footage, `${name}.mp4`));
  }
  ff("-f", "lavfi", "-i", "color=red:size=64x64", "-frames:v", "1", join(footage, "Card.png"));
  // PATH: ffmpeg, ffprobe and node (the fake claude's runtime), and no whisper-cli.
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
      UNCUT_ANALYZE_WAIT_MS: "3000",
      FAKE_PLAN: plan(),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_RESULT_LOG: resultLog(),
    },
  });
  client = await connect(server.ready.port, server.ready.token);
  agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Cut by text" });
  dir = snap.dir;
  await agent.until((s) => s?.dir === dir);
  const { turn } = await ask("import the talk and put it on the timeline", [
    { tool: "media_import", args: { path: footage } },
    { tool: "project_read", args: {} },
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Add the talk", ops: [{ op: "insert_item", track: "main", item: { id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 180 } }] } },
  ]);
  assert.equal(turn.status, "done", turn.error);
  await writeCached(dir, await fingerprint(join(footage, "Talk.mp4")), "transcript", TRANSCRIPT);
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("transcript_edit: dryRun changes nothing; applying cuts words and pauses as one edit; Undo turn restores", { skip, timeout: 120000 }, async () => {
  const start = await client.ok("project.get", {});
  assert.deepEqual(mainOf(start), [["clip-1", "m-talk", 0, 180]]);
  const { turn, results } = await ask("cut the um and the long pauses", [
    { tool: "transcript_edit", args: { remove: [{ from: "w1" }], dryRun: true } },
    { tool: "transcript_edit", args: { media: "m-talk", remove: [{ from: "w1", to: "w1" }], pauses: { min: 0.5 } } },
    { tool: "transcript_edit", args: { remove: [{ from: 1 }] } },
  ]);
  assert.equal(turn.status, "done", turn.error);
  assert.deepEqual(
    turn.items.filter((i: any) => i.kind === "step").map((i: any) => i.text),
    ["Planned cutting words", "Cut words and pauses over 0.5 s from m-talk", "Cut words"],
  );

  const dry = jsonOf(results[0]!);
  assert.equal(results[0]!.isError, undefined, textOf(results[0]!));
  assert.equal(dry.applied, false);
  assert.equal(dry.media, "m-talk", "the one media on main, when media is left out");
  assert.deepEqual(dry.removed, [{ words: "w1", text: "um", mediaFrames: { start: 36, end: 45 }, frames: 9, seconds: 0.3, clips: ["clip-1"] }]);
  assert.deepEqual([dry.durationBefore, dry.duration, dry.framesRemoved, dry.revision], [180, 171, 9, start.revision]);
  assert.match(dry.note, /dry run: nothing changed/);

  const applied = jsonOf(results[1]!);
  assert.equal(applied.applied, true, textOf(results[1]!));
  assert.deepEqual(applied.removed.map((r: any) => [r.text, r.mediaFrames.start, r.mediaFrames.end, r.pauses ?? 0]), [["(pause)", 0, 13, 1], ["um", 36, 45, 0], ["(pause)", 92, 118, 1], ["(pause)", 152, 180, 1]]);
  assert.equal(applied.framesRemoved, 13 + 9 + 26 + 28);
  assert.deepEqual([applied.durationBefore, applied.duration, applied.seconds], [180, 104, 3.47]);
  assert.equal(applied.revision, start.revision + 1);
  assert.match(applied.note, /Undo turn reverts it/);

  const again = jsonOf(results[2]!);
  assert.equal(again.applied, false);
  assert.deepEqual(again.removed, []);
  assert.match(again.notes.join(" "), /"um" \(w1\) isn't in the edit any more \(already cut\)/);

  const after = await client.ok("project.get", {});
  assert.equal(after.revision, start.revision + 1, "one edit");
  assert.deepEqual(mainOf(after), [["clip-1", "m-talk", 13, 23], ["clip-2", "m-talk", 45, 47], ["clip-3", "m-talk", 118, 34]]);
  assert.equal(turn.edits.length, 1);
  assert.equal(turn.edits[0].summary, "Cut 1 word and 3 pauses (2.5 s)");
  assert.deepEqual(turn.edits[0].lines, ["Removed a pause (0.4 s) from clip-1", 'Cut "um" (0.3 s) from clip-1', "Removed a pause (0.9 s) from clip-1", "Removed a pause (0.9 s) from clip-1"]);

  const undone = await client.ok("agent.undoTurn", { turnId: turn.id });
  assert.deepEqual(mainOf(undone), [["clip-1", "m-talk", 0, 180]]);
});

test("transcript_edit refusals: nothing asked, bad word ids, a still image, no transcript and no whisper", { skip, timeout: 120000 }, async () => {
  const { turn, results } = await ask("try some bad cuts", [
    { tool: "transcript_edit", args: {} },
    { tool: "transcript_edit", args: { remove: [{ from: "x12" }] } },
    { tool: "transcript_edit", args: { remove: [{ from: "w3", to: "w99" }] } },
    { tool: "transcript_edit", args: { media: "m-card", fillers: true } },
    { tool: "transcript_edit", args: { media: "m-other", fillers: true } },
    { tool: "transcript_edit", args: { pauses: { min: 0 } } },
  ]);
  assert.equal(turn.status, "done", turn.error);
  assert.ok(results.every((r) => r.isError), JSON.stringify(results.map((r) => r.isError)));
  assert.match(textOf(results[0]!), /Say what to cut/);
  assert.match(textOf(results[1]!), /word ids like "w12"/);
  assert.match(textOf(results[2]!), /there's no w99/);
  assert.match(textOf(results[3]!), /still image/);
  assert.match(textOf(results[4]!), /whisper\.cpp isn't installed/);
  assert.match(textOf(results[5]!), /pauses must be/);
  assert.equal(turn.edits.length, 0);
});

test("transcript_edit's tool schema and labels", { skip }, async () => {
  const { mcpTools, stepLabel, TOOL_NAMES } = await import("../apps/server/src/agentTools.ts");
  assert.ok(TOOL_NAMES.includes("transcript_edit"));
  const tool = mcpTools().find((t) => t.name === "transcript_edit")!;
  assert.deepEqual(Object.keys((tool.inputSchema as any).properties), ["media", "remove", "pauses", "fillers", "dryRun"]);
  assert.equal(stepLabel("transcript_edit", { fillers: true, pauses: {} }), "Cut pauses and fillers");
  assert.equal(stepLabel("transcript_edit", { remove: [{}, {}], media: "m-a", dryRun: true }), "Planned cutting 2 word ranges from m-a");
});
