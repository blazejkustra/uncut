// Phase 5 chunk 1 (D65) on the bundled server, with the scripted stand-in for claude
// (helpers/fake-claude.ts) driving the real MCP server: the agent's footage tools.
// - media_import of a generated folder (3 clips, a text file and a subfolder skipped) waits for the
//   import and returns the probes; the import is the agent's: the next note doesn't list it and
//   Undo turn removes it. Safety refusals: relative paths, the project's folder and cache, the
//   per-call cap; sources are referenced, never changed.
// - contact_sheet of a media file (right cells, frames and size; always the first video stream,
//   checked on a clip whose second stream is a larger default mjpeg) and of a timeline range.
// - ui_show puts a one-time request in the agent state (the renderer side is in agent-app).
// All media is made here with ffmpeg's lavfi sources; nothing from ~/Documents/devrel/drone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const skip = !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA) ? "server bundle or media core not built (run pnpm build)" : !hasFfmpeg ? "ffmpeg isn't installed" : false;

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
type ToolResult = { tool: string; result: { isError?: boolean; content: Content } };
let root = "";
let footage = "";
let server: Server;
let client: Client;
let agent: ReturnType<Client["subscribe"]>;
let dir = "";
const plan = () => join(root, "plan.json");
const promptLog = () => join(root, "prompts.jsonl");
const resultLog = () => join(root, "results.jsonl");
const sent = (): Array<{ prompt: string }> => readFileSync(promptLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const latest = () => agent.values.at(-1);
const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));

const turns: Array<unknown> = [];
const nextTurn = (steps: Array<unknown>) => {
  turns.push(steps);
  writeFileSync(plan(), JSON.stringify(turns));
};
/** Run a turn; returns the finished turn and the tool results it produced, in order. */
async function ask(prompt: string, steps: Array<unknown>) {
  nextTurn(steps);
  const before = existsSync(resultLog()) ? readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).length : 0;
  const { turnId } = await client.ok("agent.send", { prompt });
  await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 120000);
  const turn = latest().turns.find((t: any) => t.id === turnId);
  const results = (readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).slice(before).map((l) => JSON.parse(l)) as Array<ToolResult>).map((r) => r.result);
  return { turn, results };
}
const textOf = (r: { content: Content }) => r.content.find((c) => c.type === "text")!.text!;
const jsonOf = (r: { content: Content }) => JSON.parse(textOf(r));
const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
const probe = (file: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { encoding: "utf8" })) as { streams: Array<{ width: number; height: number; codec_name: string }> };
/** The sheet image of a result, saved to `name` in test-output and the temp folder; returns the temp path. */
function saveImage(r: { content: Content }, name: string) {
  const image = r.content.find((c) => c.type === "image");
  assert.ok(image, "the result has an image");
  assert.equal(image!.mimeType, "image/jpeg");
  const file = join(root, name);
  writeFileSync(file, Buffer.from(image!.data!, "base64"));
  mkdirSync("test-output", { recursive: true });
  writeFileSync(join("test-output", name), Buffer.from(image!.data!, "base64"));
  return file;
}
/** The colour at (x, y) of an image, as [r, g, b]. */
const pixel = (file: string, x: number, y: number) => [...execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `format=rgb24,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-"])];
const isRed = ([r, g, b]: Array<number>) => r! > 180 && g! < 80 && b! < 80;
const isBlue = ([r, g, b]: Array<number>) => b! > 180 && r! < 80 && g! < 80;
const isYellow = ([r, g, b]: Array<number>) => r! > 180 && g! > 180 && b! < 80;
const isGreen = ([r, g, b]: Array<number>) => g! > 90 && r! < 80 && b! < 80;
// The sheet layout (agentFootage.ts): 6 px gaps, 22 px captions, cells at most 320 px wide.
const cellCentre = (i: number, columns: number, w = 320, h = 180) => [6 + (i % columns) * (w + 6) + w / 2, 6 + Math.floor(i / columns) * (h + 22 + 6) + h / 2] as const;
const hashOf = (file: string) => createHash("sha1").update(readFileSync(file)).digest("hex");

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-footage-")));
  mkdirSync(join(root, "projects"));
  footage = join(root, "Footage");
  mkdirSync(join(footage, "sub"), { recursive: true });
  // A: 4 s test pattern with a tone; B: 1.5 s of red then 1.5 s of yellow, plus a larger blue mjpeg
  // stream marked as the default (ffmpeg's own pick), like the cover picture DJI files carry;
  // C: 2 s of green, silent.
  ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(footage, "A.mp4"));
  ff("-f", "lavfi", "-i", "color=red:size=320x180:rate=30:d=1.5,format=yuv420p[r];color=yellow:size=320x180:rate=30:d=1.5,format=yuv420p[y];[r][y]concat", "-f", "lavfi", "-i", "color=blue:size=1280x720:rate=30", "-t", "3", "-map", "0:v", "-map", "1:v", "-c:v:0", "libx264", "-pix_fmt:v:0", "yuv420p", "-c:v:1", "mjpeg", "-pix_fmt:v:1", "yuvj420p", "-disposition:v:0", "0", "-disposition:v:1", "default", join(footage, "B.mov"));
  ff("-f", "lavfi", "-i", "color=0x00A000:size=320x180:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(footage, "C.mp4"));
  writeFileSync(join(footage, "notes.txt"), "shot list\n");
  writeFileSync(join(footage, ".DS_Store"), "");
  ff("-f", "lavfi", "-i", "color=white:size=64x64:rate=30", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(footage, "sub", "D.mp4"));
  writeFileSync(promptLog(), "");
  writeFileSync(resultLog(), "");
  server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan(), FAKE_PROMPT_LOG: promptLog(), FAKE_RESULT_LOG: resultLog() } });
  client = await connect(server.ready.port, server.ready.token);
  agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Footage test" });
  dir = snap.dir;
  await agent.until((s) => s?.dir === dir);
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("media_import of a folder: its 3 clips with probes, the rest skipped; the next note doesn't list it; Undo turn removes it", { skip, timeout: 120000 }, async () => {
  const sources = ["A.mp4", "B.mov", "C.mp4"].map((n) => join(footage, n));
  const before = sources.map((f) => [hashOf(f), statSync(f).mtimeMs]);
  const jobs = client.subscribe("media.jobs");
  const { turn, results } = await ask("import my footage folder", [{ tool: "media_import", args: { path: footage } }]);
  assert.equal(turn.status, "done", turn.error);
  assert.deepEqual(turn.items[0], { kind: "step", tool: "media_import", text: "Imported Footage", status: "done" });
  const [result] = results;
  assert.ok(!result!.isError, textOf(result!));
  const out = jsonOf(result!);
  assert.deepEqual(out.imported.map((m: any) => [m.id, m.kind, m.name, m.path, m.hasAudio]), [
    ["m-a", "video", "A.mp4", join(footage, "A.mp4"), true],
    ["m-b", "video", "B.mov", join(footage, "B.mov"), false],
    ["m-c", "video", "C.mp4", join(footage, "C.mp4"), false],
  ]);
  const a = out.imported[0];
  assert.ok(Math.abs(a.frames - 120) <= 1 && Math.abs(a.seconds - 4) < 0.05, JSON.stringify(a));
  assert.deepEqual([a.width, a.height, a.fps], [320, 180, 30]);
  assert.ok(Math.abs(out.imported[2].frames - 60) <= 1);
  assert.deepEqual(out.skipped.map((s: any) => [s.path, s.reason]), [
    [join(footage, "notes.txt"), "Not a media file (by its extension)."],
    [join(footage, "sub"), "A folder: only the files directly inside the folder you named are imported."],
  ]);
  assert.deepEqual(out.failed, []);
  assert.equal(out.revision, (await client.ok("project.get")).revision);
  // In the project, saved; one edit on the card; the job is marked as the agent's.
  assert.deepEqual(onDisk().media.map((m: any) => m.id), ["m-a", "m-b", "m-c"]);
  assert.equal(turn.edits.length, 1);
  assert.deepEqual(turn.edits[0].lines, ["Added media A.mp4 (m-a)", "Added media B.mov (m-b)", "Added media C.mp4 (m-c)"]);
  assert.equal(turn.edits[0].summary, "Imported 3 files");
  assert.deepEqual(turn.undo, { state: "available" });
  await jobs.until((list) => list.some((j: any) => j.agent === true && j.phase === "done"), 30000);
  // Referenced, never changed.
  assert.deepEqual(sources.map((f) => [hashOf(f), statSync(f).mtimeMs]), before);
  assert.deepEqual(readdirSync(join(dir, "media")), [], "nothing is copied into the project");

  // D6: the import is the agent's, so the next turn's note doesn't list it as a change by hand.
  const second = await ask("what's in there?", [{ tool: "project_read" }]);
  assert.equal(second.turn.note, undefined, `no manual-edit note: ${second.turn.note}`);
  assert.doesNotMatch(sent().at(-1)!.prompt, /by hand|Added media/);
  assert.equal(jsonOf(second.results[0]!).media.length, 3);

  // Undo turn takes the import back as one step.
  const snap = await client.ok("agent.undoTurn", { turnId: turn.id });
  assert.deepEqual(snap.project.media, []);
  assert.deepEqual(onDisk().media, []);
  await agent.until((s) => s?.turns.find((t: any) => t.id === turn.id)?.undo.state === "undone");
});

test("media_import refuses relative paths, the project's own folder and cache, too many files; reports missing and unreadable files", { skip, timeout: 120000 }, async () => {
  const many = join(root, "Many");
  mkdirSync(many);
  for (let i = 0; i < 51; i++) writeFileSync(join(many, `clip-${i}.mp4`), "");
  mkdirSync(join(dir, ".cache", "thumbs"), { recursive: true });
  const { turn, results } = await ask("try some bad imports", [
    { tool: "media_import", args: { path: "Footage/A.mp4" } },
    { tool: "media_import", args: { path: dir } },
    { tool: "media_import", args: { path: join(dir, ".cache") } },
    { tool: "media_import", args: { path: join(dir, ".cache", "thumbs") } },
    { tool: "media_import", args: { path: join(dir, "project.json") } },
    { tool: "media_import", args: { path: many } },
    { tool: "media_import", args: { path: join(footage, "A.mp4"), paths: [join(footage, "C.mp4")] } },
    { tool: "media_import", args: { paths: [join(footage, "A.mp4"), join(footage, "C.mp4")], name: "Two" } },
    { tool: "media_import", args: { paths: [join(footage, "missing.mp4"), join(footage, "notes.txt")] } },
    { tool: "media_import", args: { path: join(footage, "A.mp4"), name: "Opening shot" } },
    { tool: "media_import", args: { paths: [footage] } },
  ]);
  assert.equal(turn.status, "done", turn.error);
  const [relative, project, cache, thumbs, file, cap, both, named, missing, single, again] = results as Array<{ isError?: boolean; content: Content }>;
  const refusedWith = (r: { isError?: boolean; content: Content } | undefined, pattern: RegExp) => {
    assert.ok(r?.isError, `refused: ${r && textOf(r)}`);
    assert.match(textOf(r!), pattern);
  };
  refusedWith(relative, /"Footage\/A\.mp4" isn't an absolute path/);
  refusedWith(project, /is the project's own folder/);
  refusedWith(cache, /in the project's cache \(\.cache\)/);
  refusedWith(thumbs, /in the project's cache \(\.cache\)/);
  refusedWith(file, /inside the project's folder/);
  refusedWith(cap, /That's 51 media files; media_import takes at most 50 per call/);
  refusedWith(both, /Pass path .* or paths .*, not both/);
  refusedWith(named, /name is only for importing one file/);
  // A missing file and a file that isn't media are reported per file, not refused.
  assert.ok(!missing!.isError, textOf(missing!));
  const m = jsonOf(missing!);
  assert.deepEqual(m.imported, []);
  assert.deepEqual(m.failed.map((f: any) => [f.path, f.message]), [
    [join(footage, "missing.mp4"), "The file doesn't exist."],
    [join(footage, "notes.txt"), "Uncut can't read this kind of file yet."],
  ]);
  // name sets the display name of one file.
  const s = jsonOf(single!);
  assert.deepEqual(s.imported.map((x: any) => [x.id, x.name]), [["m-opening-shot", "Opening shot"]]);
  // Importing the folder again adds B and C; A is skipped as already there, with its id.
  const g = jsonOf(again!);
  assert.deepEqual(g.imported.map((x: any) => x.id), ["m-b", "m-c"]);
  assert.ok(g.skipped.some((x: any) => x.path === join(footage, "A.mp4") && x.reason === "Already in the project." && x.id === "m-opening-shot"), JSON.stringify(g.skipped));
  assert.deepEqual(onDisk().media.map((x: any) => x.id), ["m-opening-shot", "m-b", "m-c"]);
  assert.equal(turn.edits.length, 2, "one edit per import that added something");
});

test("contact_sheet: media sheets (cells, frames, size, first video stream), a timeline-range sheet, and its refusals", { skip, timeout: 180000 }, async () => {
  const insert = (id: string, mediaId: string) => ({ op: "insert_item", track: "main", item: { id, type: "clip", media: mediaId, in: 0, duration: 60 } });
  const { turn, results } = await ask("look at the footage", [
    { tool: "contact_sheet", args: { media: "m-opening-shot", at: "every", every: 30, columns: 2 } },
    { tool: "contact_sheet", args: { media: "m-b", max: 3 } },
    { tool: "contact_sheet", args: { media: "m-b", range: { start: 44, end: 46 } } },
    { tool: "contact_sheet", args: { media: "m-opening-shot", max: 60 } },
    { tool: "contact_sheet", args: { media: "m-opening-shot", every: 1 } },
    { tool: "contact_sheet", args: { media: "m-b", at: "shots" } },
    { tool: "contact_sheet", args: { media: "m-nope" } },
    { tool: "contact_sheet", args: { range: { start: 0, end: 60 } } },
    { tool: "project_read" },
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Put B and C on the timeline", ops: [insert("clip-b", "m-b"), insert("clip-c", "m-c")] } },
    { tool: "contact_sheet", args: { range: { start: 0, end: 120 }, every: 20 } },
  ]);
  assert.equal(turn.status, "done", turn.error);
  const [every30, mjpeg, cut, sixty, tooMany, shots, unknown, empty, , edit, timeline] = results as Array<{ isError?: boolean; content: Content }>;
  assert.deepEqual(turn.items.filter((i: any) => i.tool === "contact_sheet").map((i: any) => i.text).slice(0, 2), ["Looked over Opening shot", "Looked over B.mov"]);
  assert.equal(turn.items.filter((i: any) => i.tool === "contact_sheet").at(-1).text, "Looked over the edit (frames 0–120)");

  // Every 30 frames of the 4 s clip: 4 cells in 2 columns of 320×180 with captions.
  assert.ok(!every30!.isError, textOf(every30!));
  assert.match(textOf(every30!), /^Contact sheet of m-opening-shot \(Opening shot\), 4 cells in 2 columns, 658×422/);
  assert.match(textOf(every30!), /\n1: frame 0 \(0:00\.00\)\n2: frame 30 \(0:01\.00\)\n3: frame 60 \(0:02\.00\)\n4: frame 90 \(0:03\.00\)$/);
  const sheet = saveImage(every30!, "agent-sheet-media.jpg");
  assert.deepEqual([probe(sheet).streams[0]!.width, probe(sheet).streams[0]!.height], [658, 422]);
  // Under each cell, the caption strip (dark sheet background, light text) isn't the picture.
  assert.ok(pixel(sheet, 3, 3).every((v) => v < 40), "the sheet's background is dark");

  // The clip whose default stream is a larger blue mjpeg: every cell is the first video stream
  // (red, then yellow from 1.5 s), never blue, and each cell is the frame its caption says.
  assert.ok(!mjpeg!.isError, textOf(mjpeg!));
  assert.match(textOf(mjpeg!), /3 cells in 3 columns, 984×214/);
  assert.match(textOf(mjpeg!), /\n1: frame 0 \(0:00\.00\)\n2: frame 30 \(0:01\.00\)\n3: frame 60 \(0:02\.00\)$/);
  const streams = saveImage(mjpeg!, "agent-sheet-streams.jpg");
  const cells = [0, 1, 2].map((i) => pixel(streams, ...cellCentre(i, 3)));
  for (const c of cells) assert.ok(!isBlue(c), `not the mjpeg stream: ${c}`);
  assert.ok(isRed(cells[0]!) && isRed(cells[1]!), `frames 0 and 30 are red: ${cells}`);
  assert.ok(isYellow(cells[2]!), `frame 60 (2 s) is yellow: ${cells[2]}`);
  // Exactly at the cut: frame 44 (1.4667 s) is the last red one, 45 (1.5 s) the first yellow.
  assert.match(textOf(cut!), /\n1: frame 44 \(0:01\.47\)\n2: frame 45 \(0:01\.50\)$/);
  const atCut = saveImage(cut!, "agent-sheet-cut.jpg");
  assert.ok(isRed(pixel(atCut, ...cellCentre(0, 2))), "frame 44 is red");
  assert.ok(isYellow(pixel(atCut, ...cellCentre(1, 2))), "frame 45 is yellow");

  // 60 cells, the cap: still at most 1600 px wide.
  assert.ok(!sixty!.isError, textOf(sixty!));
  assert.equal(textOf(sixty!).split("\n").filter((l) => /^\d+: frame/.test(l)).length, 60);
  const big = probe(saveImage(sixty!, "agent-sheet-60.jpg")).streams[0]!;
  assert.ok(big.width <= 1568 && big.height <= 1568, `${big.width}×${big.height}`);
  assert.deepEqual([big.width, big.height], [6 * 227 + 7 * 6, 10 * (128 + 22) + 11 * 6]);

  assert.ok(tooMany!.isError);
  assert.match(textOf(tooMany!), /Every 1 frames over 120 frames is 120 cells; a sheet holds at most 60\. Use every ≥ 2/);
  // One cell per shot (D67): B cuts from red to yellow at frame 45, so two shots, each shown by its middle frame.
  assert.ok(!shots!.isError, textOf(shots!));
  assert.equal(turn.items.filter((i: any) => i.tool === "contact_sheet")[5].text, "Looked over the shots of B.mov");
  assert.match(textOf(shots!), /^Contact sheet of m-b \(B\.mov\), 2 cells in 2 columns, 658×214/);
  assert.match(textOf(shots!), /2 shots; each cell is the middle frame of its shot/);
  assert.match(textOf(shots!), /\n1: frame 22 \(0:00\.73\), shot frames 0–45 \(0:00\.00–0:01\.50\)\n2: frame 67 \(0:02\.23\), shot frames 45–90 \(0:01\.50–0:03\.00\)$/);
  const shotSheet = saveImage(shots!, "agent-sheet-shots.jpg");
  assert.ok(isRed(pixel(shotSheet, ...cellCentre(0, 2))), "the first shot is red");
  assert.ok(isYellow(pixel(shotSheet, ...cellCentre(1, 2))), "the second shot is yellow");
  assert.ok(unknown!.isError);
  assert.match(textOf(unknown!), /There's no media "m-nope"\. project_read lists the media ids: m-opening-shot, m-b, m-c/);
  assert.ok(empty!.isError);
  assert.match(textOf(empty!), /The timeline is empty/);
  assert.ok(!edit!.isError, textOf(edit!));

  // The edit, frames 0–120 every 20: B (red until 1.5 s) for frames 0–59, C (green) from 60, as the export draws it.
  assert.ok(!timeline!.isError, textOf(timeline!));
  assert.match(textOf(timeline!), /^Contact sheet of the edit \(revision \d+\), 6 cells in 3 columns, 984×422, drawn as the export draws them/);
  assert.match(textOf(timeline!), /\n1: frame 0 \(0:00\.00\)\n2: frame 20 \(0:00\.67\)\n3: frame 40 \(0:01\.33\)\n4: frame 60 \(0:02\.00\)\n5: frame 80 \(0:02\.67\)\n6: frame 100 \(0:03\.33\)$/);
  const edited = saveImage(timeline!, "agent-sheet-edit.jpg");
  assert.deepEqual([probe(edited).streams[0]!.width, probe(edited).streams[0]!.height], [984, 422]);
  for (const i of [0, 1, 2]) assert.ok(isRed(pixel(edited, ...cellCentre(i, 3))), `cell ${i + 1} shows B`);
  for (const i of [3, 4, 5]) assert.ok(isGreen(pixel(edited, ...cellCentre(i, 3))), `cell ${i + 1} shows C: ${pixel(edited, ...cellCentre(i, 3))}`);
});

test("ui_show: one request per call in the agent state, checked against the project", { skip, timeout: 60000 }, async () => {
  const { turn, results } = await ask("show me the green clip", [
    { tool: "ui_show", args: { frame: 75, select: ["clip-c"], panel: "inspector" } },
    { tool: "ui_show", args: { select: ["nope"] } },
    { tool: "ui_show", args: { panel: "transcript" } },
    { tool: "ui_show", args: { frame: 5000 } },
  ]);
  assert.equal(turn.status, "done", turn.error);
  const [ok, unknown, panel, past] = results as Array<{ isError?: boolean; content: Content }>;
  assert.equal(textOf(ok!), "Shown: a pill over the preview points the user at frame 75 and clip-c (a click jumps there; their playhead and selection stay put), the inspector panel is open.");
  assert.equal(turn.items[0].text, "Pointed at frame 75 and C.mp4, opened the Inspector panel");
  assert.ok(unknown!.isError);
  assert.match(textOf(unknown!), /There's no timeline item "nope"/);
  assert.ok(panel!.isError);
  assert.match(textOf(panel!), /panel must be one of media, text, elements, audio, inspector, agent/);
  assert.equal(textOf(past!), "Shown: a pill over the preview points the user at frame 120, where the project ends (a click jumps there; their playhead and selection stay put).");
  // The state carries the last request, with a new id each time.
  const ui = latest().ui;
  assert.equal(ui.frame, 120);
  assert.equal(ui.select, undefined);
  assert.ok(agent.values.some((s: any) => s?.ui?.frame === 75 && s.ui.select === "clip-c" && s.ui.panel === "inspector" && s.ui.id !== ui.id));
});

test("contact_sheet picks the frame export shows at mixed rates, shows the last frame past the picture's end, fits vertical footage; import edge cases", { skip, timeout: 240000 }, async () => {
  const mixed = join(root, "Mixed");
  mkdirSync(mixed);
  // 25 fps: red on its first frame, blue after. 59.94 fps: red and blue frames alternating.
  const flip = (expr: string) => `format=rgb24,geq=r='if(${expr},255,0)':g=0:b='if(${expr},0,255)'`;
  ff("-f", "lavfi", "-i", `color=black:size=320x180:rate=25,${flip("eq(N,0)")}`, "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "1", join(mixed, "R25.mp4"));
  ff("-f", "lavfi", "-i", `color=black:size=320x180:rate=60000/1001,${flip("eq(mod(N,2),0)")}`, "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "1", join(mixed, "S5994.mp4"));
  // 1 s of picture with 2 s of sound: the media is 2 s long, its picture ends at 1 s.
  ff("-f", "lavfi", "-i", "color=red:size=320x180:rate=30:d=1", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(mixed, "Short.mp4"));
  // Vertical (9:16) footage.
  ff("-f", "lavfi", "-i", "testsrc2=size=180x320:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(mixed, "V.mp4"));
  // A folder with many non-media files, and one Uncut may not read.
  const sidecars = join(root, "Sidecars");
  mkdirSync(sidecars);
  for (let i = 0; i < 25; i++) writeFileSync(join(sidecars, `take-${i}.srt`), "");
  const locked = join(root, "Locked");
  mkdirSync(locked);
  execFileSync("chmod", ["000", locked]);
  try {
    const { turn, results } = await ask("check mixed rates", [
      { tool: "media_import", args: { path: mixed } },
      { tool: "project_read" },
      {
        tool: "timeline_edit",
        args: {
          baseRevision: "$rev",
          summary: "Mixed-rate clips over the main track",
          ops: [
            { op: "add_track", track: { id: "mix", kind: "video", name: "Mix" }, index: 0 },
            { op: "insert_item", track: "mix", item: { id: "r25", type: "clip", media: "m-r25", in: 0, start: 0, duration: 10 } },
            { op: "insert_item", track: "mix", item: { id: "s5994", type: "clip", media: "m-s5994", in: 0, start: 10, duration: 10 } },
          ],
        },
      },
      { tool: "render_frames", args: { frames: [0, 1, 2, 3, 10, 11, 12, 13, 14, 15], scale: 0.1 } },
      { tool: "contact_sheet", args: { media: "m-r25", range: { start: 0, end: 4 } } },
      { tool: "contact_sheet", args: { media: "m-s5994", range: { start: 0, end: 6 } } },
      { tool: "contact_sheet", args: { media: "m-v" } },
      { tool: "contact_sheet", args: { media: "m-v", columns: 1, max: 60 } },
      { tool: "media_import", args: { path: sidecars } },
      { tool: "media_import", args: { path: locked } },
    ]);
    assert.equal(turn.status, "done", turn.error);
    const [imported, , edit, rendered, r25, s5994, vertical, oneColumn, many, denied] = results as Array<{ isError?: boolean; content: Content }>;
    assert.ok(!imported!.isError && !edit!.isError, textOf(edit!));
    assert.deepEqual(jsonOf(imported!).imported.map((m: any) => m.id), ["m-r25", "m-s5994", "m-short", "m-v"]);

    // The edit as render_frames draws it (the export's maths), frame by frame: red or blue.
    assert.ok(!rendered!.isError, textOf(rendered!));
    const colour = (c: Array<number>) => (isRed(c) ? "red" : isBlue(c) ? "blue" : `?${c}`);
    const images = rendered!.content.filter((c) => c.type === "image");
    const exported = images.map((img, i) => {
      const file = join(root, `mixed-${i}.jpg`);
      writeFileSync(file, Buffer.from(img.data!, "base64"));
      return colour(pixel(file, 96, 54));
    });
    // 25 fps in 30: frame 0 at 0 s and frame 1 at 0.033 s both show the source's red frame 0
    // (the next starts at 0.04 s); frames 2 and 3 show later, blue frames.
    assert.deepEqual(exported.slice(0, 4), ["red", "red", "blue", "blue"]);
    // The sheets show the same frames as the export, cell by cell.
    const cellsOf = (r: { content: Content }, count: number, name: string) => {
      const file = saveImage(r, name);
      const columns = Number(/cells in (\d+) columns/.exec(textOf(r))![1]);
      return Array.from({ length: count }, (_, i) => colour(pixel(file, ...cellCentre(i, columns))));
    };
    assert.ok(!r25!.isError, textOf(r25!));
    assert.deepEqual(cellsOf(r25!, 4, "agent-sheet-25fps.jpg"), exported.slice(0, 4), "25 fps source in a 30 fps project");
    assert.ok(!s5994!.isError, textOf(s5994!));
    const s = cellsOf(s5994!, 6, "agent-sheet-5994fps.jpg");
    assert.deepEqual(s, exported.slice(4, 10), "59.94 fps source in a 30 fps project");
    assert.ok(s.every((c) => c === "red" || c === "blue"), s.join(","));

    // Past the end of the picture: the last frame, labelled as such. The probe says how long a
    // file is; one whose sound outlasts its picture (or a probe that's off) is 2 s here, picture 1 s.
    const disk = onDisk();
    disk.media.find((x: any) => x.id === "m-short").probe.frames = 60;
    writeFileSync(join(dir, "project.json"), `${JSON.stringify(disk, null, 2)}\n`);
    await client.ok("project.reload");
    const [short] = (await ask("look at the short one", [{ tool: "contact_sheet", args: { media: "m-short", every: 15 } }])).results;
    assert.ok(!short!.isError, textOf(short!));
    assert.match(textOf(short!), /Note: frame 30 is past the end of the picture, so cell 3 shows its last frame, 29; frame 45 is past the end of the picture, so cell 4 shows its last frame, 29\./);
    assert.match(textOf(short!), /\n1: frame 0 \(0:00\.00\)\n2: frame 15 \(0:00\.50\)\n3: frame 29 \(0:00\.97\)\n4: frame 29 \(0:00\.97\)$/);
    const shortFile = saveImage(short!, "agent-sheet-short.jpg");
    for (const i of [0, 1, 2, 3]) assert.ok(isRed(pixel(shortFile, ...cellCentre(i, 4))), `cell ${i + 1} has the picture`);

    // Vertical footage stays within 1568 px either way; 1 column of 60 gives way to a fit and says so.
    for (const [r, name] of [[vertical!, "agent-sheet-vertical.jpg"], [oneColumn!, "agent-sheet-vertical-60.jpg"]] as const) {
      assert.ok(!r.isError, textOf(r));
      const { width, height } = probe(saveImage(r, name)).streams[0]!;
      assert.ok(width <= 1568 && height <= 1568, `${name}: ${width}×${height}`);
      assert.ok(height > width, `${name} is laid out for portrait cells: ${width}×${height}`);
    }
    assert.match(textOf(vertical!), /24 cells in 6 columns, 1260×1562/);
    assert.match(textOf(oneColumn!), /60 cells in 10 columns, .* 1 columns didn't fit the sheet's size, so it has 10\./);

    // 25 skipped files: 20 listed, the rest counted by reason.
    const m = jsonOf(many!);
    assert.equal(m.skipped.length, 20);
    assert.equal(m.skippedTotal, 25);
    assert.deepEqual(m.skippedByReason, { "Not a media file (by its extension).": 25 });
    // A folder Uncut can't read says so, with where to allow it.
    assert.ok(denied!.isError);
    assert.match(textOf(denied!), /Uncut isn't allowed to read .*Locked\. .*Privacy & Security → Files and Folders/);
  } finally {
    execFileSync("chmod", ["755", locked]);
  }
});

test("media_import returns the user's changes made since the agent's read, and its revision can be edited from", { skip, timeout: 120000 }, async () => {
  const one = join(root, "One");
  mkdirSync(one);
  ff("-f", "lavfi", "-i", "color=white:size=320x180:rate=30", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(one, "W.mp4"));
  // The fake reads, waits while the user edits by hand, imports, then edits from the import's revision.
  nextTurn([
    { tool: "project_read" },
    { sleep: 1500 },
    { tool: "media_import", args: { path: join(one, "W.mp4") } },
  ]);
  const { turnId } = await client.ok("agent.send", { prompt: "import W" });
  await new Promise((r) => setTimeout(r, 700));
  const now = await client.ok("project.get");
  await client.ok("project.edit", { baseRevision: now.revision, ops: [{ op: "update_track", track: "audio", set: { name: "Music" } }] });
  await agent.until((st) => st?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 60000);
  const lines = readFileSync(resultLog(), "utf8").trim().split("\n");
  const result = JSON.parse(lines.at(-1)!).result as { isError?: boolean; content: Content };
  assert.ok(!result.isError, textOf(result));
  const out = jsonOf(result);
  assert.match(out.userChanges, /by hand/);
  assert.match(out.userChanges, /track audio/);
  // An edit based on the returned revision goes through (the fake can't chain it; ask directly).
  // It adds its own track: the test must not depend on tracks an earlier test added.
  const ops = [
    { op: "add_track", track: { id: "w-track", kind: "video", name: "W" }, index: 0 },
    { op: "insert_item", track: "w-track", item: { id: "w", type: "clip", media: "m-w", in: 0, start: 40, duration: 10 } },
  ];
  const { turn, results } = await ask("use it", [{ tool: "timeline_edit", args: { baseRevision: out.revision, summary: "Use W", ops } }]);
  assert.equal(turn.status, "done", turn.error);
  assert.ok(!results[0]!.isError, textOf(results[0]!));
});

test("sheet maths and step labels: frames, the grid, the clock, the turn card's words", async () => {
  const { sheetFrames, sheetLayout, clock } = await import("../../apps/server/src/agent/agentFootage.ts");
  const { stepLabel, TOOL_NAMES } = await import("../../apps/server/src/agent/agentTools.ts");
  assert.deepEqual(sheetFrames(0, 120, 30, 60), [0, 30, 60, 90]);
  assert.deepEqual(sheetFrames(10, 20, undefined, 4), [10, 12, 15, 17]);
  assert.deepEqual(sheetFrames(0, 3, undefined, 24), [0, 1, 2], "never more cells than frames");
  assert.match((sheetFrames(0, 1000, 10, 60) as { refused: string }).refused, /100 cells; a sheet holds at most 60\. Use every ≥ 17/);
  assert.deepEqual(sheetLayout(4, 16 / 9), { columns: 4, rows: 1, cellWidth: 320, cellHeight: 180, width: 1310, height: 214 });
  assert.deepEqual(sheetLayout(60, 9 / 16, 10), { columns: 10, rows: 6, cellWidth: 130, cellHeight: 231, width: 1366, height: 1560 });
  assert.deepEqual(sheetLayout(24, 9 / 16), { columns: 6, rows: 4, cellWidth: 203, cellHeight: 361, width: 1260, height: 1562 }, "vertical footage fits");
  // A column count whose cells would be too small (or out of range) gives way to the best fit.
  assert.equal(sheetLayout(60, 16 / 9, 1).columns, 6);
  assert.equal(sheetLayout(5, 16 / 9, 99).columns, 5);
  for (const aspect of [16 / 9, 9 / 16, 1, 21 / 9, 1 / 3]) {
    for (const n of [1, 5, 12, 24, 37, 60]) {
      for (const columns of [undefined, 1, 10]) {
        const l = sheetLayout(n, aspect, columns);
        assert.ok(l.width <= 1568 && l.height <= 1568 && l.cellWidth >= 40, `${n} cells, aspect ${aspect.toFixed(2)}, columns ${columns}: ${JSON.stringify(l)}`);
      }
    }
  }
  assert.equal(clock(83.5), "1:23.50");
  assert.equal(clock(3723), "1:02:03.00");
  assert.deepEqual(TOOL_NAMES.slice(-20, -12), ["media_import", "contact_sheet", "ui_show", "graphic_write", "generate_media", "screen_record", "argent_boot", "media_search"]);
  assert.equal(stepLabel("media_import", { path: "/Users/me/Drone/" }), "Imported Drone");
  assert.equal(stepLabel("media_import", { paths: ["/a.mp4", "/b.mp4"] }), "Imported 2 paths");
  assert.equal(stepLabel("contact_sheet", { media: "m-dji", every: 60 }), "Looked over m-dji");
  assert.equal(stepLabel("contact_sheet", {}), "Looked over the edit");
  assert.equal(stepLabel("ui_show", { panel: "agent" }), "Opened the Agent tab");
  assert.equal(stepLabel("ui_show", { frame: 30, panel: "media" }), "Pointed at frame 30, opened the Media panel");
});
