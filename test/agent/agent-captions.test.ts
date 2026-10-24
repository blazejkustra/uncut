// Phase 6 chunk 5 (D82) on the bundled server: captions through the scripted stand-in for claude
// (helpers/fake-claude.ts) and the real MCP server. The transcript is a fake one written into the
// analysis cache, so no whisper runs (the PATH has only ffmpeg, ffprobe and node).
// - captions_make makes word-mode captions as one agent edit (cards in the answer, step label);
//   project_read shows the item with a word count and its cards, never the words;
// - timeline_edit's edit_captions fixes a word and forces a card start (one update_item); a
//   transcript_edit cut afterwards leaves the fix in place and the cut words out of the cards;
//   render_frames draws the card; Undo turn takes the captions away;
// - refusals with sentences; the tool schema and labels.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fingerprint, writeCached } from "../../apps/server/src/analysis/analysis.ts";
import { expandCaptionEdits, mcpTools, stepLabel, TOOL_NAMES } from "../../apps/server/src/agent/agentTools.ts";
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
const skip =
  !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA) || !existsSync(DESKTOP)
    ? "server bundle, desktop or media core not built (run pnpm build)"
    : !FFMPEG || !FFPROBE
      ? "ffmpeg isn't installed"
      : false;

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
const TRANSCRIPT = {
  hasAudio: true,
  seconds: 6,
  language: "en",
  requestedLanguage: "auto",
  model: "base",
  segments: [{ start: 0.5, end: 5, text: "Hello um this is a test. Second part", words: [0, 8] }],
  words: WORDS,
};

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
type Content = Array<{ type: string; text?: string; data?: string }>;
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
  const results = readFileSync(resultLog(), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(before)
    .map((l) => JSON.parse(l).result as { isError?: boolean; content: Content });
  return { turn, results };
}
const textOf = (r: { content: Content }) => r.content.find((c) => c.type === "text")!.text!;
const jsonOf = (r: { content: Content }) => JSON.parse(textOf(r));
const captionsOf = (snap: any) => snap.project.tracks.flatMap((t: any) => t.items).find((i: any) => i.type === "captions");

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-captions-")));
  mkdirSync(join(root, "projects"));
  const footage = join(root, "Footage");
  mkdirSync(footage);
  ff(
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=300:sample_rate=48000",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    join(footage, "Talk.mp4"),
  );
  ff("-f", "lavfi", "-i", "color=red:size=64x64", "-frames:v", "1", join(footage, "Card.png"));
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
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Captions" });
  dir = snap.dir;
  await agent.until((s) => s?.dir === dir);
  const { turn } = await ask("import the talk and put it on the timeline", [
    { tool: "media_import", args: { path: footage } },
    { tool: "project_read", args: {} },
    {
      tool: "timeline_edit",
      args: {
        baseRevision: "$rev",
        summary: "Add the talk",
        ops: [{ op: "insert_item", track: "main", item: { id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 180 } }],
      },
    },
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

test(
  "captions_make, then edit_captions fixes a word and starts a card; a transcript_edit cut keeps the fix; render_frames draws it; Undo turn",
  { skip, timeout: 180000 },
  async () => {
    const start = await client.ok("project.get", {});
    const { turn, results } = await ask("add karaoke captions and fix the name", [
      { tool: "captions_make", args: { mode: "word", hideFillers: true } },
      { tool: "project_read", args: {} },
      {
        tool: "timeline_edit",
        args: {
          baseRevision: "$rev",
          summary: "Fix the name in the captions",
          ops: [{ op: "edit_captions", item: "captions-1", words: [{ word: "w6", text: "Argent" }], breaks: [{ word: 3 }] }],
        },
      },
      { tool: "transcript_edit", args: { remove: [{ from: "w4", to: "w5" }] } },
      { tool: "project_read", args: {} },
      { tool: "render_frames", args: { frames: [20], width: 640 } },
    ]);
    assert.equal(turn.status, "done", turn.error);
    assert.deepEqual(
      turn.items.filter((i: any) => i.kind === "step").map((i: any) => i.text),
      ["Made word-by-word captions", "Read the timeline", "Fix the name in the captions", "Cut words", "Read the timeline", "Looked at frame 20"],
    );
    const made = jsonOf(results[0]!);
    assert.equal(results[0]!.isError, undefined, textOf(results[0]!));
    assert.deepEqual(
      [made.media, made.item, made.remade, made.mode, made.words, made.cardCount, made.revision],
      ["m-talk", "captions-1", false, "word", 8, 2, start.revision + 1],
    );
    assert.deepEqual(made.cards, [
      { from: 15, to: 99, words: "w0–w5", text: "Hello this is a test." },
      { from: 120, to: 159, words: "w6–w7", text: "Second part" },
    ]);
    assert.equal(turn.edits[0].summary, "Make captions");
    assert.match(turn.edits[0].lines[0], /^Made word-by-word captions of Talk\.mp4 \(2 cards, 8 words\) as captions-1$/);

    // project_read: the word snapshot as a count, the cards with their word ids.
    const read = jsonOf(results[1]!);
    const item = read.tracks.flatMap((t: any) => t.items).find((i: any) => i.type === "captions");
    assert.equal(item.words, 8);
    assert.equal(item.cards.length, 2);
    assert.ok(!JSON.stringify(read).includes('"start":0.5'), "no word timings in project_read");
    assert.equal(read.duration, 180, "captions don't lengthen the video");

    const edited = jsonOf(results[2]!);
    assert.equal(edited.ok, true, textOf(results[2]!));
    assert.equal(results[3]!.isError, undefined, textOf(results[3]!));
    const after = jsonOf(results[4]!)
      .tracks.flatMap((t: any) => t.items)
      .find((i: any) => i.type === "captions");
    assert.deepEqual(after.edits, [{ word: 6, text: "Argent" }]);
    assert.deepEqual(after.breaks, [3]);
    // "test." went with the cut ("a", 3 frames, keeps playing inside the tail kept after "is", D74,
    // so it stays, as the Transcript panel would show it): the cards follow; the fix and the forced card stay.
    assert.deepEqual(
      after.cards.map((c: any) => c.text),
      ["Hello this", "is a", "Argent part"],
    );
    const frame = results[5]!;
    assert.equal(frame.isError, undefined, textOf(frame));
    assert.ok(frame.content.some((c) => c.type === "image" && (c.data?.length ?? 0) > 1000));

    const saved = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    const cap = saved.tracks.flatMap((t: any) => t.items).find((i: any) => i.type === "captions");
    assert.equal(cap.words.length, 8, "the snapshot is in project.json");
    assert.deepEqual([cap.mode, cap.hideFillers, cap.source], ["word", true, "m-talk"]);

    const undone = await client.ok("agent.undoTurn", { turnId: turn.id });
    assert.equal(captionsOf(undone), undefined);
    assert.ok(!undone.project.tracks.some((t: any) => t.name === "Captions"), "the captions track went with them");
  },
);

test("captions refusals: an image, a bad mode, a word that isn't there", { skip, timeout: 120000 }, async () => {
  const { turn, results } = await ask("captions for the card", [
    { tool: "captions_make", args: { media: "m-card" } },
    { tool: "captions_make", args: { mode: "karaoke" } },
    { tool: "captions_make", args: { media: "m-nope" } },
    { tool: "captions_make", args: {} },
    { tool: "project_read", args: {} },
    { tool: "timeline_edit", args: { baseRevision: "$rev", ops: [{ op: "edit_captions", item: "captions-1", words: [{ word: "w99", text: "x" }] }] } },
    { tool: "timeline_edit", args: { baseRevision: "$rev", ops: [{ op: "edit_captions", item: "clip-1", mode: "word" }] } },
    { tool: "timeline_edit", args: { baseRevision: "$rev", ops: [{ op: "edit_captions", item: "captions-1", colour: "red" }] } },
  ]);
  assert.equal(turn.status, "done", turn.error);
  assert.match(textOf(results[0]!), /m-card is a still image: there's no speech to caption/);
  assert.match(textOf(results[1]!), /mode must be "line", "word" or "single"/);
  assert.match(textOf(results[2]!), /There's no media "m-nope"/);
  assert.equal(jsonOf(results[3]!).item, "captions-1", "line mode by default");
  assert.equal(jsonOf(results[3]!).mode, "line");
  assert.match(jsonOf(results[5]!).refused, /no word 99/);
  assert.match(jsonOf(results[6]!).refused, /"clip-1" isn't a captions item/);
  assert.match(jsonOf(results[7]!).refused, /unknown field colour/);
  for (const k of [0, 1, 2, 5, 6, 7]) assert.equal(results[k]!.isError, true);
});

test("captions_make's schema, edit_captions in timeline_edit, labels and the prompt", { skip }, () => {
  assert.ok(TOOL_NAMES.includes("captions_make"));
  const tool = mcpTools().find((t) => t.name === "captions_make")!;
  assert.deepEqual(Object.keys((tool.inputSchema as any).properties), ["media", "item", "mode", "look", "lines", "hideFillers"]);
  const edit = mcpTools().find((t) => t.name === "timeline_edit")!;
  // D285: a convenience op, listed in the description with its fields and checked by the server.
  assert.ok((edit.inputSchema as any).$defs.convenienceOp.properties.op.enum.includes("edit_captions"));
  assert.match(edit.description, /"op":"edit_captions", item, words\?: \[\{word, text\}\]/);
  assert.equal(stepLabel("captions_make", { media: "m-a" }), "Made captions for m-a");
  assert.equal(stepLabel("captions_make", { mode: "single" }), "Made one-word captions");
  assert.match(AGENT_TEXT, /captions_make mode "line"/);
  assert.match(AGENT_TEXT, /"op":"edit_captions"/);
  assert.deepEqual(
    expandCaptionEdits({ format: "uncut/0", name: "x", canvas: { width: 10, height: 10, fps: 30 }, media: [], tracks: [] }, [{ op: "delete_item", item: "a" }]),
    { ops: [{ op: "delete_item", item: "a" }] },
  );
});
