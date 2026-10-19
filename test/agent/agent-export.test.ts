// export_video: the agent starts the Export dialog's job.
// - the folder: words (Desktop...), ~/ and absolute paths, the dialog's default; refusals (Uncut's
//   data, inside the project package, ~/Library, hidden and system folders, a missing folder);
// - never over a file (" 2"), one export at a time, the card (Ask first, or a folder the message
//   didn't name), the range from the marks / selection sent with the message, a failure's error;
// - on the bundled server through the scripted claude: an export to the Desktop the user named makes
//   a playable file, the job is marked agent (the editor shows it), a second one gets " 2", an
//   unnamed folder waits for the card.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Effect from "../../apps/server/node_modules/effect/dist/Effect.js";

import { LOOK_TOOLS, mcpTools, stepLabel, doingLabel, SYSTEM_PROMPT, TOOL_NAMES } from "../../apps/server/src/agent/agentTools.ts";
import { exportFileName, exportFolderProblem, freeOutput, makeExportVideo, messageNamesFolder, resolveExportFolder } from "../../apps/server/src/agent/tools/exportVideo.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const which = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const FFMPEG = which("ffmpeg");
const FFPROBE = which("ffprobe");
const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA) ? "server bundle or media core not built (run pnpm build)" : !FFMPEG || !FFPROBE ? "ffmpeg isn't installed" : false;

// ---- a home of our own (Desktop, Movies, Downloads, Library), a project and Uncut's data ----
const home = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-export-home-")));
for (const d of ["Desktop", "Movies", "Downloads", "Library/Caches", ".secret", "data", "Projects/Clip/media", "Projects/Clip/exports"]) mkdirSync(join(home, d), { recursive: true });
const project = join(home, "Projects", "Clip");
const dataDir = join(home, "data");
const savedHome = process.env.HOME;
after(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});
const o = { project, dataDir, fallback: join(home, "Movies"), home };

test("export_video's folder: words, ~/ and paths, the default, and what's refused", () => {
  assert.deepEqual(resolveExportFolder("Desktop", o), { dir: join(home, "Desktop") });
  assert.deepEqual(resolveExportFolder("desktop", o), { dir: join(home, "Desktop") });
  assert.deepEqual(resolveExportFolder("~/Downloads/", o), { dir: join(home, "Downloads") });
  assert.deepEqual(resolveExportFolder(join(home, "Movies"), o), { dir: join(home, "Movies") });
  assert.deepEqual(resolveExportFolder(undefined, o), { dir: join(home, "Movies") }, "the dialog's folder");
  const refused = (folder: string, re: RegExp) => {
    const out = resolveExportFolder(folder, o);
    assert.ok("problem" in out, `${folder} should be refused`);
    assert.match(out.problem, re, folder);
  };
  refused(dataDir, /Uncut's own data/);
  refused(join(project, "media"), /inside the project/);
  refused(project, /inside the project \(Finder shows it as one item/);
  refused(join(project, "exports"), /inside the project/);
  refused("~/Library/Caches", /~\/Library/);
  refused("~/.secret", /hidden folder/);
  refused("/System", /system folder/);
  refused("/usr/bin", /system folder/);
  refused("~/Nope", /doesn't exist/);
  refused("Some folder", /isn't a folder Uncut knows/);
  writeFileSync(join(home, "Movies", "a-file"), "x");
  refused(join(home, "Movies", "a-file"), /is a file/);
  assert.equal(exportFolderProblem("/Volumes/External/Videos", { project, dataDir, home }), undefined, "an external disk is the user's");
  assert.match(exportFolderProblem("/Applications", { project, dataDir, home })!, /system folder/);
});

test("export_video: the message names the folder, a free name, the file name", () => {
  const desktop = join(home, "Desktop");
  assert.equal(messageNamesFolder("lets export to desktop", desktop, project, home), true);
  assert.equal(messageNamesFolder("export it please", desktop, project, home), false);
  assert.equal(messageNamesFolder("put the video in Movies", desktop, project, home), false, "another folder");
  assert.equal(messageNamesFolder(`save it in ${join(home, "Downloads")}`, join(home, "Downloads"), project, home), true, "a pasted path");
  assert.equal(messageNamesFolder("save it in ~/Downloads", join(home, "Downloads"), project, home), true);
  writeFileSync(join(desktop, "Clip.mp4"), "x");
  writeFileSync(join(desktop, "Clip 2.mp4"), "x");
  assert.equal(freeOutput(desktop, "Clip.mp4", existsSync), join(desktop, "Clip 3.mp4"));
  assert.equal(freeOutput(desktop, "Other.mp4", existsSync), join(desktop, "Other.mp4"));
  assert.equal(exportFileName("Launch: v2/final"), "Launch- v2-final.mp4");
  assert.equal(exportFileName("x.MP4"), "x.MP4");
  rmSync(join(desktop, "Clip.mp4"));
  rmSync(join(desktop, "Clip 2.mp4"));
});

// ---- the tool with a stand-in exporter and card ----
type Job = { id: string; output: string; phase: string; progress: number; seconds: number; width: number; height: number; fps: number; quality: string; elapsedSeconds?: number; error?: string; warnings?: Array<string> };
function harness(opts: { access?: "auto" | "ask" | "look"; prompt?: string; answer?: "allow" | "deny"; jobs?: Array<Job>; busy?: boolean; fail?: string; ranges?: unknown } = {}) {
  const started: Array<Record<string, any>> = [];
  const cards: Array<{ text: string; permission: any }> = [];
  const jobs: Array<Job> = [...(opts.jobs ?? [])];
  const ctx = {
    textResult: (value: unknown, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) }),
    config: { dataDir },
    askUser: (_r: unknown, text: string, _e: number, _s: unknown, _a: unknown, _ed: unknown, more: any) => {
      cards.push({ text, permission: more?.permission });
      return Effect.succeed(opts.answer ?? "deny");
    },
    exporter: {
      busy: () => !!opts.busy,
      jobList: Effect.sync(() => jobs),
      cancel: () => Effect.void,
      start: (input: Record<string, any>) =>
        Effect.sync(() => {
          started.push(input);
          const failed = opts.fail !== undefined;
          if (!failed) writeFileSync(input.output, Buffer.alloc(2_500_000));
          jobs.push({ id: `j${started.length}`, output: input.output, phase: failed ? "failed" : "done", progress: 1, seconds: 6, width: 1280, height: 720, fps: 30, quality: input.quality, elapsedSeconds: 2, ...(failed ? { error: opts.fail } : { warnings: ["A graphic was drawn without blur."] }) });
          return { jobId: `j${started.length}` };
        }),
    },
  };
  const run = makeExportVideo(ctx as any);
  const r = { access: opts.access ?? "auto", turn: { prompt: opts.prompt ?? "" }, abort: new AbortController(), ...(opts.ranges ? { ranges: opts.ranges } : {}) };
  const v = { dir: project, session: { project: { name: "Clip", master: { loudness: { targetLufs: -16 } }, canvas: { width: 1080, height: 1350, fps: 30 }, tracks: [], media: [] } } };
  const call = async (args: Record<string, unknown>) => {
    const out = (await Effect.runPromise(run(r as any, v as any, args))) as unknown as { isError?: boolean; content: Array<{ text: string }> };
    const text = out.content[0]!.text;
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { isError: out.isError === true, text, json };
  };
  return { call, started, cards };
}

test("export_video: Auto and a folder the message named runs at once, with the dialog's defaults", async () => {
  process.env.HOME = home;
  const h = harness({ prompt: "lets export to desktop" });
  const out = await h.call({ folder: "Desktop" });
  assert.equal(out.isError, false, out.text);
  assert.equal(h.cards.length, 0, "no card");
  assert.deepEqual(h.started[0], { output: join(home, "Desktop", "Clip.mp4"), quality: "standard", loudness: "quiet", agent: true }, "the project's −16 LUFS is Quiet");
  assert.equal(out.json.saved, join(home, "Desktop", "Clip.mp4"));
  assert.equal(out.json.size, "2.5 MB");
  assert.equal(out.json.seconds, 6);
  assert.equal(out.json.picture, "1280×720 at 30 fps");
  assert.deepEqual(out.json.warnings, ["A graphic was drawn without blur."]);
  // Never over a file: the same export again is "Clip 2.mp4", and says so.
  const again = await h.call({ folder: "Desktop", preset: "high", motionBlur: false, fps: 25, shortSide: 720, loudness: "off" });
  assert.equal(again.json.saved, join(home, "Desktop", "Clip 2.mp4"));
  assert.match(again.json.note, /Clip\.mp4 was already there, so it's saved as Clip 2\.mp4/);
  assert.deepEqual(h.started[1], { output: join(home, "Desktop", "Clip 2.mp4"), quality: "high", loudness: "off", video: { fps: 25, shortSide: 720 }, motionBlur: false, agent: true });
  rmSync(join(home, "Desktop", "Clip.mp4"));
  rmSync(join(home, "Desktop", "Clip 2.mp4"));
});

test("export_video: a folder the message didn't name, the default folder and Ask first wait for the card", async () => {
  process.env.HOME = home;
  const unnamed = harness({ prompt: "lets export to desktop", answer: "deny" });
  const out = await unnamed.call({ folder: "Downloads" });
  assert.equal(out.isError, true);
  assert.match(out.text, /Not exported: the user said no/);
  assert.equal(unnamed.started.length, 0);
  assert.deepEqual(unnamed.cards, [{ text: "Export the video", permission: { tool: "export", target: join(home, "Downloads", "Clip.mp4"), why: "You didn't name this folder in your message, so Uncut asks before writing there.", always: false } }]);
  // No folder: the dialog's (the last export's folder, else ~/Movies), still asked.
  const last = harness({ prompt: "export it", answer: "allow", jobs: [{ id: "old", output: join(home, "Downloads", "Old.mp4"), phase: "done", progress: 1, seconds: 1, width: 1, height: 1, fps: 30, quality: "draft" }] });
  assert.equal((await last.call({})).json.saved, join(home, "Downloads", "Clip.mp4"));
  assert.equal(last.cards[0]!.permission.target, join(home, "Downloads", "Clip.mp4"));
  rmSync(join(home, "Downloads", "Clip.mp4"));
  const fresh = harness({ prompt: "export it", answer: "allow" });
  assert.equal((await fresh.call({ preset: "draft" })).json.saved, join(home, "Movies", "Clip.mp4"));
  rmSync(join(home, "Movies", "Clip.mp4"));
  // Ask first asks even for the folder the user named.
  const ask = harness({ access: "ask", prompt: "export to my Desktop", answer: "allow" });
  assert.equal((await ask.call({ folder: "Desktop" })).isError, false);
  assert.equal(ask.cards.length, 1);
  assert.equal(ask.cards[0]!.permission.why, "This chat asks before writing files.");
  rmSync(join(home, "Desktop", "Clip.mp4"));
  // Look only never gets here: it isn't a look tool.
  assert.ok(!(LOOK_TOOLS as ReadonlyArray<string>).includes("export_video"));
});

test("export_video: refusals (forbidden folders, busy, bad args, no marks), the range, and a failure's error", async () => {
  process.env.HOME = home;
  for (const folder of [dataDir, join(project, "media"), "~/Library/Caches", "/System"]) {
    const h = harness({ prompt: `export to ${folder}`, answer: "allow" });
    const out = await h.call({ folder });
    assert.equal(out.isError, true, folder);
    assert.ok(out.json.refused, folder);
    assert.equal(h.cards.length + h.started.length, 0, `${folder}: no card, no export`);
  }
  const busy = harness({ prompt: "export to desktop", jobs: [{ id: "x", output: "/Users/x/Movies/Other.mp4", phase: "rendering", progress: 0.42, seconds: 1, width: 1, height: 1, fps: 30, quality: "high" }] });
  const refused = await busy.call({ folder: "Desktop" });
  assert.match(refused.json.refused, /An export is already running \(Other\.mp4, 42%\): one at a time/);
  assert.equal(busy.started.length, 0);
  const bad = harness({ prompt: "export to desktop" });
  assert.match((await bad.call({ preset: "ultra" })).text, /preset must be/);
  assert.match((await bad.call({ range: "marks" })).text, /No In\/Out marks were set/);
  assert.match((await bad.call({ range: "selection" })).text, /Nothing was selected/);
  const ranged = harness({ prompt: "export the selection to desktop", ranges: { marks: { from: 10, to: 40 }, selection: { from: 30.4, to: 90 } } });
  await ranged.call({ folder: "Desktop", range: "selection" });
  assert.deepEqual(ranged.started[0]!.range, { from: 30, to: 90 });
  rmSync(join(home, "Desktop", "Clip.mp4"));
  await ranged.call({ folder: "Desktop", range: "marks" });
  assert.deepEqual(ranged.started[0 + 1]!.range, { from: 10, to: 40 });
  rmSync(join(home, "Desktop", "Clip.mp4"));
  const failing = harness({ prompt: "export to desktop", fail: "The disk is full. Free some space or choose another disk, then export again." });
  const failed = await failing.call({ folder: "Desktop" });
  assert.equal(failed.isError, true);
  assert.equal(failed.json.failed, "The disk is full. Free some space or choose another disk, then export again.");
});

test("export_video: the tool, its labels and the prompt line", () => {
  assert.ok((TOOL_NAMES as ReadonlyArray<string>).includes("export_video"));
  const tool = mcpTools().find((t) => t.name === "export_video")!;
  assert.deepEqual(Object.keys((tool.inputSchema as any).properties).sort(), ["folder", "fps", "loudness", "motionBlur", "name", "preset", "range", "shortSide"]);
  assert.match(tool.description, /only when the user asks/);
  assert.equal(stepLabel("export_video", { folder: "Desktop" }), "Exported the video to Desktop");
  assert.equal(doingLabel("export_video", {}), "Exporting the video");
  assert.match(SYSTEM_PROMPT, /export_video saves the \.mp4 when asked for an export, never unasked/);
});

// ---- the bundled server ----
type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let server: Server;
let client: Client;
let agent: ReturnType<Client["subscribe"]>;
let exportJobs: ReturnType<Client["subscribe"]>;
let dir = "";
const turns: Array<unknown> = [];
const resultLog = () => join(root, "results.jsonl");
async function send(prompt: string, steps: Array<unknown>, access: "auto" | "ask" = "auto") {
  turns.push(steps);
  writeFileSync(join(root, "plan.json"), JSON.stringify(turns));
  const { turnId } = await client.ok("agent.send", { prompt, access });
  return turnId as string;
}
async function finish(turnId: string, before: number) {
  await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 180000);
  const turn = agent.values.at(-1).turns.find((t: any) => t.id === turnId);
  const results = readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).slice(before).map((l) => JSON.parse(l).result as { isError?: boolean; content: Array<{ text?: string }> });
  return { turn, results };
}
const logged = () => readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).length;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-export-")));
  for (const d of ["projects", "Footage", "Desktop", "Downloads", "bin"]) mkdirSync(join(root, d));
  execFileSync(FFMPEG!, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, "Footage", "Talk.mp4")]);
  symlinkSync(FFMPEG!, join(root, "bin", "ffmpeg"));
  symlinkSync(FFPROBE!, join(root, "bin", "ffprobe"));
  symlinkSync(process.execPath, join(root, "bin", "node"));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(resultLog(), "");
  // The server's home is the test's: "Desktop" is root/Desktop.
  server = await startServer({ env: { HOME: root, PATH: `${join(root, "bin")}:/usr/bin:/bin`, UNCUT_DATA_DIR: join(root, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: join(root, "plan.json"), FAKE_PROMPT_LOG: join(root, "prompts.jsonl"), FAKE_RESULT_LOG: resultLog() } });
  client = await connect(server.ready.port, server.ready.token);
  agent = client.subscribe("agent.subscribe");
  exportJobs = client.subscribe("export.jobs");
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Launch" });
  dir = snap.dir;
  await agent.until((s) => s?.dir === dir);
  const before = logged();
  const id = await send("put the talk on the timeline", [
    { tool: "media_import", args: { path: join(root, "Footage", "Talk.mp4") } },
    { tool: "project_read", args: {} },
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Add the talk", ops: [{ op: "insert_item", track: "main", item: { id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 90 } }] } },
  ]);
  const { turn } = await finish(id, before);
  assert.equal(turn.status, "done", turn.error);
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("export_video on the server: the Desktop the user named, a playable file, an agent job, \" 2\", and a card for another folder", { skip, timeout: 300000 }, async () => {
  const before = logged();
  const id = await send("lets export to desktop", [
    { tool: "export_video", args: { folder: "Desktop", preset: "draft" } },
    { tool: "export_video", args: { folder: "Desktop", preset: "draft" } },
    { tool: "export_video", args: { folder: "Downloads", preset: "draft" } },
    { text: "Saved on your Desktop." },
  ]);
  // The third call asks: a folder the message didn't name. Say no.
  const fits = (s: any) => s?.approval?.turnId === id && s.approval.permission?.tool === "export";
  await agent.until(fits, 180000);
  const card = agent.values.findLast(fits).approval;
  assert.equal(card.permission.target, join(root, "Downloads", "Launch.mp4"));
  await client.ok("agent.approve", { id: card.id, allow: false });
  const { turn, results } = await finish(id, before);
  assert.equal(turn.status, "done", turn.error);
  assert.deepEqual(turn.items.filter((i: any) => i.kind === "step").map((i: any) => i.text), ["Exported the video to Desktop", "Exported the video to Desktop", "Exported the video to Downloads"]);
  const first = JSON.parse(results[0]!.content[0]!.text!);
  assert.equal(results[0]!.isError, undefined, results[0]!.content[0]!.text);
  assert.equal(first.saved, join(root, "Desktop", "Launch.mp4"));
  assert.equal(first.preset, "draft");
  assert.ok(first.seconds > 2.9 && first.seconds < 3.1, String(first.seconds));
  assert.match(first.size, /MB$/);
  assert.equal(JSON.parse(results[1]!.content[0]!.text!).saved, join(root, "Desktop", "Launch 2.mp4"));
  assert.equal(results[2]!.isError, true);
  assert.match(results[2]!.content[0]!.text!, /the user said no/);
  assert.ok(!existsSync(join(root, "Downloads", "Launch.mp4")));
  // A playable file.
  const probe = JSON.parse(execFileSync(FFPROBE!, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name", "-of", "json", first.saved], { encoding: "utf8" }));
  assert.deepEqual(probe.streams.map((s: any) => s.codec_type).sort(), ["audio", "video"]);
  assert.ok(Math.abs(Number(probe.format.duration) - 3) < 0.2, probe.format.duration);
  // The job is the dialog's own, marked agent, so the editor shows it as its export.
  const jobs = exportJobs.values.at(-1) as Array<any>;
  const job = jobs.find((j) => j.output === first.saved);
  assert.equal(job.agent, true);
  assert.equal(job.phase, "done");
  assert.equal(job.projectDir, dir);
});
