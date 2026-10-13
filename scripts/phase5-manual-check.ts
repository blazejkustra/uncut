// Phase 5 exit check, the real-claude half (D72): the same generated footage as
// test/app/phase5-exit.test.ts (a minute of `say` speech with an "um", an "uh" and long pauses, plus a
// smooth, a jittered and a blurred 6 s take), driven by the REAL agent instead of the scripted one.
// Not part of `pnpm test`: it uses your Claude subscription (claude CLI, signed in; Uncut strips
// ANTHROPIC_API_KEY from the agent's environment, D41) and real whisper.cpp transcription.
//
// Run from the repo root (after pnpm build):
//   node scripts/phase5-manual-check.ts                 make the footage, print the steps to do it in the app
//   node scripts/phase5-manual-check.ts --run           do it headlessly: start the bundled server, create a
//                                                       project, send the prompt to the real claude, wait for
//                                                       the turn and print what it did with a pass/check list
//   node scripts/phase5-manual-check.ts --verify <dir>  after a manual --drone run: the drone files are unchanged
//   ... --drone                                         also name a few of your drone takes
//                                                       (~/Documents/devrel/drone/croatia-day-1-kuba/*_MASTER.MP4)
//                                                       in the prompt, by path. They're only referenced:
//                                                       media_import adds them by path and never copies or
//                                                       changes them (test/agent/agent-footage.test.ts checks hashes,
//                                                       mtimes and an empty media/ folder); this script also
//                                                       records their size and mtime and compares them after --run.
//   ... --model tiny.en                                 the speech model (default: the app's, large-v3-turbo-q5_0,
//                                                       574 MB; models are taken from test-output/whisper-models
//                                                       when they're there, else downloaded into the run folder)
//   ... --out <dir>                                     where to put it all (default: a new temp folder)
//   ... --prompt "<text>"                               a different prompt
// Needs: ffmpeg, macOS say, brew install whisper-cpp, the claude CLI signed in.
// Expected: the talk on the main track cut into pieces (fillers and pauses ≥ ~0.5 s gone, about
// 10 s shorter for the default prompt) and Smooth.mp4 appended after it (or, with --drone, the take
// the agent judged cleanest, with its reason in the reply).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { makeFixture } from "../test/helpers/phase5-fixture.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const DRONE_DIR = join(homedir(), "Documents/devrel/drone/croatia-day-1-kuba");

const stamp = (files: Array<string>) => files.map((f) => ({ path: f, size: statSync(f).size, mtimeMs: statSync(f).mtimeMs }));

// --verify <dir>: after a manual run with --drone, the drone files are exactly as they were.
if (flag("--verify")) {
  const dir = option("--verify");
  if (!dir || dir.startsWith("--") || !existsSync(join(resolve(dir), "drone-before.json"))) {
    console.error("Usage: node scripts/phase5-manual-check.ts --verify <dir>  (the --out folder of a --drone run, with drone-before.json in it)");
    process.exit(2);
  }
  const before = JSON.parse(readFileSync(join(resolve(dir), "drone-before.json"), "utf8")) as Array<{ path: string; size: number; mtimeMs: number }>;
  const same = JSON.stringify(stamp(before.map((b) => b.path))) === JSON.stringify(before);
  console.log(same ? `PASS  ${before.length} drone files unchanged (size, mtime)` : "FAIL  a drone file changed");
  process.exit(same ? 0 : 1);
}

const out = resolve(option("--out") ?? realpathSync(mkdtempSync(join(tmpdir(), "uncut-phase5-manual-"))));
// Never write next to the footage.
const droneRoot = resolve(homedir(), "Documents/devrel/drone");
const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
if (`${real(out)}/`.startsWith(`${real(droneRoot)}/`)) {
  console.error(`--out ${out} is inside ${droneRoot}: pick a folder outside your footage.`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });
console.log(`Making the footage in ${out}/Footage …`);
const fixture = makeFixture(join(out, "Footage"));
console.log(`  Talk.mp4 (${fixture.seconds.toFixed(1)} s), Smooth.mp4, Jittered.mp4, Blurred.mp4`);

// Your drone takes: referenced by path only, never opened for writing here.
const drone = flag("--drone")
  ? readdirSync(DRONE_DIR)
      .filter((n) => n.endsWith("_MASTER.MP4"))
      .slice(0, 3)
      .map((n) => join(DRONE_DIR, n))
  : [];
const droneBefore = stamp(drone);
if (drone.length) writeFileSync(join(out, "drone-before.json"), JSON.stringify(droneBefore, null, 2));

const prompt =
  option("--prompt") ??
  [
    `Import ${fixture.folder}${drone.length ? ` and these drone takes: ${drone.join(", ")}` : ""}.`,
    "Put Talk.mp4 on the timeline and cut it tight from its transcript — remove fillers and long pauses (0.5 s or more), and the sentence about almost deleting a take.",
    `Then rank the drone takes (${["Smooth.mp4", "Jittered.mp4", "Blurred.mp4", ...drone.map((d) => d.split("/").pop())].join(", ")}) and append the cleanest one after the talk. Tell me why you picked it.`,
  ].join(" ");

if (!flag("--run")) {
  console.log(`
Manual check in the app (pnpm dev, or dist/mac-arm64/Uncut.app):
  1. New project (anywhere), open the Agent tab. Claude Code must show as signed in.
  2. Send this prompt:

${prompt}

  3. Expect: media_import, media_analyze (transcript; the first one downloads the speech model in
     Setup if it isn't there), transcript_read, one transcript_edit, media_rank, timeline_edit; the
     main track = the talk in pieces (about ${(fixture.seconds - 10.7).toFixed(0)} s), then Smooth.mp4${drone.length ? " or the drone take it argues for" : ""}.
  4. Check: the Transcript tab has no "um"/"uh" or the "almost deleted" sentence; Remove pauses
     shows 0; one Undo turn on the card restores the project as it was before the prompt; History
     lists the turn; quit, reopen from Recents, ⌘Z / ⇧⌘Z still work.
  5. Export (Draft) and watch the join between the talk and the take.
${drone.length ? `  6. After: node scripts/phase5-manual-check.ts --verify ${out}  (the drone files' size and mtime are unchanged)\n` : ""}
Or run it headlessly: node scripts/phase5-manual-check.ts --run${drone.length ? " --drone" : ""}
`);
  process.exit(0);
}

// --run: the bundled server (plain node), the real claude found on PATH, a data folder of its own.
const { BUNDLE, MEDIA, connect, startServer } = await import("../test/helpers/server.ts");
for (const built of [BUNDLE, resolve("apps/server/dist/mcp.mjs"), MEDIA]) if (!existsSync(built)) throw new Error(`${built} isn't built: run pnpm build (from the repo root)`);
const model = option("--model");
const data = join(out, "data");
mkdirSync(join(data, "models"), { recursive: true });
writeFileSync(join(data, "settings.json"), JSON.stringify({ onboarded: true, ...(model ? { whisperModel: model } : {}) }));
const cached = resolve("test-output/whisper-models");
if (existsSync(cached)) for (const f of readdirSync(cached)) if (f.endsWith(".bin") && !existsSync(join(data, "models", f))) symlinkSync(join(cached, f), join(data, "models", f));

// The server gets this terminal's environment (PATH with claude, whisper-cli, ffmpeg); UNCUT_CLAUDE unset = the real claude.
const env: NodeJS.ProcessEnv = { UNCUT_DATA_DIR: data };
delete process.env.UNCUT_CLAUDE;
const server = await startServer({ env });
const client = await connect(server.ready.port, server.ready.token);
try {
  const agent = client.subscribe("agent.subscribe");
  mkdirSync(join(out, "projects"), { recursive: true });
  const snap = await client.ok("project.create", { parentDir: join(out, "projects"), name: "Phase 5 manual" });
  await agent.until((s) => s?.dir === snap.dir, 20000);
  console.log(`\nProject ${snap.dir}\nPrompt: ${prompt}\n\nWaiting for the turn (up to 20 min) …`);
  const t0 = Date.now();
  const { turnId } = await client.ok("agent.send", { prompt });
  let shown = 0;
  const timer = setInterval(() => {
    const turn = agent.values.at(-1)?.turns?.find((t: any) => t.id === turnId);
    const steps = (turn?.items ?? []).filter((i: any) => i.kind === "step");
    for (const s of steps.slice(shown)) console.log(`  · ${s.text} (${s.status})`);
    shown = steps.length;
  }, 1000);
  await agent.until((s) => s?.turns?.some((t: any) => t.id === turnId && t.status !== "running"), 20 * 60 * 1000);
  clearInterval(timer);
  const turn = agent.values.at(-1).turns.find((t: any) => t.id === turnId);
  console.log(`\nTurn ${turn.status} in ${((Date.now() - t0) / 1000).toFixed(0)} s${turn.error ? `: ${turn.error}` : ""}`);
  for (const i of turn.items) if (i.kind === "text") console.log(`  claude: ${i.text}`);
  for (const e of turn.edits ?? []) console.log(`  edit: ${e.summary}\n${(e.lines ?? []).map((l: string) => `      ${l}`).join("\n")}`);

  const project = (await client.ok("project.get", {})).project;
  const main = project.tracks.find((t: any) => t.role === "main").items;
  const mediaName = (id: string) => project.media.find((m: any) => m.id === id)?.name ?? id;
  console.log(`\nMain track: ${main.map((i: any) => `${mediaName(i.media)} [${i.in ?? 0}+${i.duration}]`).join(", ")}`);
  const talk = main.filter((i: any) => mediaName(i.media) === "Talk.mp4");
  const talkFrames = talk.reduce((s: number, i: any) => s + i.duration, 0);
  const fps = project.canvas.fps;
  const last = main.at(-1);
  const checks: Array<[string, boolean]> = [
    ["the turn finished", turn.status === "done"],
    ["the talk is on the main track, cut into pieces", talk.length > 1],
    [`the talk is shorter (${(talkFrames / fps).toFixed(1)} s of ${fixture.seconds.toFixed(1)} s)`, talkFrames / fps < fixture.seconds - 5],
    ["no piece under 3 frames", main.every((i: any) => i.duration >= 3)],
    [`a take is appended after the talk (${last ? mediaName(last.media) : "none"})`, !!last && mediaName(last.media) !== "Talk.mp4"],
    ["without --drone, it's Smooth.mp4", drone.length > 0 || (!!last && mediaName(last.media) === "Smooth.mp4")],
    ["Undo turn is available", turn.undo?.state === "available"],
    ["nothing copied into the project's media folder", !existsSync(join(snap.dir, "media")) || readdirSync(join(snap.dir, "media")).length === 0],
  ];
  if (drone.length) checks.push(["the drone takes are unchanged (size, mtime)", JSON.stringify(stamp(drone)) === JSON.stringify(droneBefore)]);
  console.log("");
  for (const [what, ok] of checks) console.log(`  ${ok ? "PASS " : "CHECK"} ${what}`);
  console.log(`\nOpen ${snap.dir} in Uncut to look at it (Transcript tab, History, Export).`);
} finally {
  client.close();
  await server.stop();
}

