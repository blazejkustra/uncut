// Phase 5 chunk 3 (D67) on the bundled server: media_rank, media_analyze's video analyzer and
// contact_sheet at "shots", through the scripted stand-in for claude (helpers/fake-claude.ts) and
// the real MCP server. ffmpeg is reached through a shell shim that logs every run and, when told
// to, sleeps first, so the tests can count video runs (their graph has blurdetect) and make one last.
// - media_rank of a folder of three takes (a smooth pan, the same with shake, the same blurred):
//   smooth > shaky > blurred with components and best stretches; by sharpness / stability; the
//   re-ask comes from the cache with no ffmpeg; refusals.
// - A slow take answers "pending" and joins the same job when asked again.
// - media_analyze ["shots"] of a clip with cuts at frames 45 and 100; contact_sheet at "shots".
// All media is made here with ffmpeg's lavfi sources; nothing from the user's footage folder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

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
const skip =
  !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA)
    ? "server bundle or media core not built (run pnpm build)"
    : !FFMPEG || !FFPROBE
      ? "ffmpeg isn't installed"
      : false;
const WAIT_MS = 6000;

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
type Content = Array<{ type: string; text?: string; data?: string }>;
let root = "";
let takes = "";
let more = "";
let shimDir = "";
let server: Server;
let client: Client;
let agent: ReturnType<Client["subscribe"]>;
let dir = "";
const plan = () => join(root, "plan.json");
const resultLog = () => join(root, "results.jsonl");
const callLog = () => join(shimDir, "calls.log");
/** ffmpeg runs of the video analyzer so far. */
const videoRuns = () =>
  existsSync(callLog())
    ? readFileSync(callLog(), "utf8")
        .split("\n")
        .filter((l) => l.includes("blurdetect"))
    : [];
const slow = (pattern: string, seconds: number) => writeFileSync(join(shimDir, "slow"), `${pattern} ${seconds}\n`);
const fast = () => rmSync(join(shimDir, "slow"), { force: true });
const ff = (...args: Array<string>) => execFileSync(FFMPEG!, ["-v", "error", "-y", ...args]);

const turns: Array<unknown> = [];
async function ask(prompt: string, steps: Array<unknown>) {
  turns.push(steps);
  writeFileSync(plan(), JSON.stringify(turns));
  const before = readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).length;
  const { turnId } = await client.ok("agent.send", { prompt });
  await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 180000);
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
const steps = (turn: any) => turn.items.filter((i: any) => i.kind === "step").map((i: any) => i.text);

/** A 6 s pan over a still at 30 fps (crop x/y expressions), then extra filters. */
const pan = (out: string, x: string, y: string, extra = "") =>
  ff(
    "-loop",
    "1",
    "-framerate",
    "30",
    "-i",
    join(root, "still.png"),
    "-t",
    "6",
    "-vf",
    `crop=640:360:x='${x}':y='${y}'${extra}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "30",
    out,
  );

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-video-")));
  mkdirSync(join(root, "projects"));
  takes = join(root, "Takes");
  more = join(root, "More");
  mkdirSync(takes);
  mkdirSync(more);
  ff("-f", "lavfi", "-i", "testsrc2=s=1600x900:d=1", "-frames:v", "1", join(root, "still.png"));
  pan(join(takes, "Smooth.mp4"), "100+t*60", "80+t*20");
  pan(join(takes, "Shaky.mp4"), "100+t*60+3*sin(n*2.7)+2*sin(n*5.3)", "80+t*20+2*sin(n*3.1)+2*sin(n*7.7)");
  pan(join(takes, "Blurred.mp4"), "100+t*60", "80+t*20", ",gblur=sigma=4");
  pan(join(more, "Late.mp4"), "300-t*40", "60+t*10");
  pan(join(more, "Pan2.mp4"), "200+t*30", "100");
  // Cuts at frames 45 and 100 (test pattern, bars, a fractal), 5 s at 30 fps.
  ff(
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=640x360:r=30:d=1.5",
    "-f",
    "lavfi",
    "-i",
    "smptehdbars=s=640x360:r=30:d=1.8333333",
    "-f",
    "lavfi",
    "-i",
    "mandelbrot=s=640x360:r=30",
    "-filter_complex",
    "[2]trim=end_frame=50,setpts=PTS-STARTPTS[m];[0][1][m]concat=n=3:v=1:a=0,format=yuv420p",
    "-c:v",
    "libx264",
    "-g",
    "300",
    join(more, "Cuts.mp4"),
  );
  ff("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-c:a", "pcm_s16le", join(more, "Tone.wav"));
  // The shim: logs, sleeps when its arguments contain the pattern in ./slow, then runs ffmpeg.
  shimDir = join(root, "bin");
  mkdirSync(shimDir);
  writeFileSync(
    join(shimDir, "ffmpeg"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${callLog()}"\nif [ -f "${shimDir}/slow" ]; then\n  read pat secs < "${shimDir}/slow"\n  case "$*" in *"$pat"*) sleep "$secs";; esac\nfi\nexec "${FFMPEG}" "$@"\n`,
  );
  chmodSync(join(shimDir, "ffmpeg"), 0o755);
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(resultLog(), "");
  server = await startServer({
    env: {
      PATH: `${shimDir}:${dirname(FFMPEG!)}:${process.env.PATH}`,
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_CLAUDE: FAKE,
      UNCUT_ANALYZE_WAIT_MS: String(WAIT_MS),
      FAKE_PLAN: plan(),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_RESULT_LOG: resultLog(),
    },
  });
  client = await connect(server.ready.port, server.ready.token);
  agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Video test" });
  dir = snap.dir;
  await agent.until((s) => s?.dir === dir);
  const { turn, results } = await ask("import the footage", [
    { tool: "media_import", args: { path: takes } },
    { tool: "media_import", args: { path: more } },
  ]);
  assert.equal(turn.status, "done", turn.error);
  assert.deepEqual(
    results.flatMap((r) => jsonOf(r).imported.map((m: any) => m.id)),
    ["m-blurred", "m-shaky", "m-smooth", "m-cuts", "m-late", "m-pan2", "m-tone"],
  );
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "media_rank of a folder: smooth > shaky > blurred with components and best stretches; by a component; the re-ask is cached; refusals",
  { skip, timeout: 240000 },
  async () => {
    const runsBefore = videoRuns().length;
    const { turn, results } = await ask("which take is the clean one?", [
      { tool: "media_rank", args: { folder: takes } },
      { tool: "media_rank", args: { media: ["m-smooth", "m-shaky", "m-blurred"], by: "sharpness" } },
      { tool: "media_rank", args: { media: ["m-blurred", "m-smooth", "m-shaky"], by: "stability", window: 3 } },
      { tool: "media_rank", args: { media: ["m-smooth", "m-tone"] } },
      { tool: "media_rank", args: { media: ["m-nope"] } },
      { tool: "media_rank", args: { media: ["m-smooth"], by: "vibes" } },
      { tool: "media_rank", args: { folder: join(root, "Elsewhere") } },
      { tool: "media_rank", args: { media: ["m-smooth"], folder: takes } },
    ]);
    assert.equal(turn.status, "done", turn.error);
    assert.deepEqual(steps(turn), [
      "Ranked the takes from Takes",
      "Ranked 3 takes",
      "Ranked 3 takes",
      "Ranked 2 takes",
      "Scored the take nope",
      "Scored the take Smooth.mp4",
      "Ranked the takes from Elsewhere",
      "Scored the take Smooth.mp4",
    ]);
    const [folder, sharp, stable, mixed, nope, badBy, elsewhere, both] = results;
    assert.ok(both!.isError);
    assert.match(textOf(both!), /Pass media or folder, not both/);

    assert.ok(!folder!.isError, textOf(folder!));
    const out = jsonOf(folder!);
    assert.equal(out.by, "clean");
    assert.deepEqual(
      out.ranked.map((r: any) => r.media),
      ["m-smooth", "m-shaky", "m-blurred"],
      JSON.stringify(out.ranked),
    );
    assert.deepEqual(
      out.ranked.map((r: any) => r.rank),
      [1, 2, 3],
    );
    const [smooth, shaky, blurred] = out.ranked;
    assert.ok(
      smooth.cleanScore - shaky.cleanScore > 0.15 && shaky.cleanScore - blurred.cleanScore > 0.1,
      JSON.stringify(out.ranked.map((r: any) => r.cleanScore)),
    );
    // The components say why: shake for the shaky one, blur for the blurred one.
    assert.ok(shaky.stability < 0.5 && smooth.stability > 0.8 && blurred.stability > 0.8, JSON.stringify(out.ranked));
    assert.ok(blurred.sharpness < 0.4 && smooth.sharpness > 0.85 && shaky.sharpness > 0.85, JSON.stringify(out.ranked));
    for (const r of out.ranked) {
      assert.equal(r.cached, false);
      assert.equal(r.shots, 1);
      assert.equal(typeof r.measures.shakePercent, "number");
      // The best 5 s, in project frames of the media (30 fps, 180 frames long).
      assert.equal(r.best.end - r.best.start, 150, JSON.stringify(r.best));
      assert.ok(r.best.start >= 0 && r.best.end <= 180);
      assert.equal(r.best.start, Math.max(0, Math.ceil(r.best.startSeconds * 30 - 1e-6)));
    }
    assert.match(out.note, /best is the cleanest 5 s inside one shot/);
    assert.equal(videoRuns().length, runsBefore + 3, "one ffmpeg run per take");
    assert.ok(
      videoRuns().every((l) => l.includes("-map 0:V:0")),
      "the first video stream (not a cover picture), mapped explicitly",
    );

    // By sharpness the blurred take is last; by stability the shaky one. Both from the cache.
    assert.equal(jsonOf(sharp!).ranked.at(-1).media, "m-blurred");
    assert.ok(jsonOf(sharp!).ranked.every((r: any) => r.cached === true));
    const byStability = jsonOf(stable!);
    assert.equal(byStability.ranked.at(-1).media, "m-shaky");
    assert.ok(
      byStability.ranked.every((r: any) => r.best.end - r.best.start === 90),
      "window 3 s",
    );
    assert.equal(videoRuns().length, runsBefore + 3, "no ffmpeg for the cached re-asks");

    // A sound file isn't a take: skipped with why.
    const m = jsonOf(mixed!);
    assert.deepEqual(
      m.ranked.map((r: any) => r.media),
      ["m-smooth"],
    );
    assert.deepEqual(m.skipped, [{ media: "m-tone", reason: "A sound file, with no picture." }]);
    assert.ok(nope!.isError);
    assert.match(textOf(nope!), /There's no media "m-nope"/);
    assert.ok(badBy!.isError);
    assert.match(textOf(badBy!), /by must be one of clean, best, stability, sharpness, exposure/);
    assert.ok(elsewhere!.isError);
    assert.match(textOf(elsewhere!), /No media in this project is from .*Elsewhere\. Import the takes first/);
  },
);

test("a slow take is pending and the agent asks again: it joins the same job, one ffmpeg run", { skip, timeout: 120000 }, async () => {
  const runsBefore = videoRuns().length;
  slow("blurdetect", 9);
  try {
    const t0 = Date.now();
    const { results } = await ask("rank the late take", [{ tool: "media_rank", args: { media: ["m-late", "m-smooth"] } }]);
    assert.ok(Date.now() - t0 >= WAIT_MS - 200, "it waited");
    const out = jsonOf(results[0]!);
    assert.deepEqual(
      out.ranked.map((r: any) => r.media),
      ["m-smooth"],
      "the cached take is ranked at once",
    );
    assert.equal(out.pending.length, 1, JSON.stringify(out));
    assert.equal(out.pending[0].media, "m-late");
    assert.equal(out.pending[0].state, "running");
    assert.match(out.note, /call media_rank again with the same arguments/);
    const { results: again } = await ask("and now?", [{ tool: "media_rank", args: { media: ["m-late", "m-smooth"] } }]);
    const done = jsonOf(again[0]!);
    assert.deepEqual(done.ranked.map((r: any) => r.media).sort(), ["m-late", "m-smooth"], JSON.stringify(done));
    assert.equal(done.pending, undefined);
    assert.equal(videoRuns().length, runsBefore + 1, "one run, joined");
  } finally {
    fast();
  }
});

test(
  "media_analyze loudness + video while video is still running: the finished loudness result and its note come back too",
  { skip, timeout: 120000 },
  async () => {
    slow("blurdetect", 9);
    try {
      const { results } = await ask("sound and picture of the second pan", [
        { tool: "media_analyze", args: { media: "m-pan2", analyzers: ["loudness", "video"] } },
      ]);
      const out = jsonOf(results[0]!);
      assert.equal(out.loudness.state, "done", JSON.stringify(out));
      assert.equal(out.loudness.hasAudio, false);
      assert.equal(out.video.state, "running", JSON.stringify(out));
      assert.match(out.note, /^Still analysing after 6 s\. Call media_analyze again/);
      assert.match(out.note, / loudness: silences are where/);
      assert.doesNotMatch(out.note, /video: Scores/);
    } finally {
      fast();
    }
  },
);

test(
  "media_analyze shots: cuts at frames 45 and 100 (±1), the frozen bars, per-second scores; contact_sheet at shots shows one frame per shot",
  { skip, timeout: 180000 },
  async () => {
    const runsBefore = videoRuns().length;
    const { turn, results } = await ask("where are the cuts?", [
      { tool: "media_analyze", args: { media: "m-cuts", analyzers: ["shots"] } },
      { tool: "contact_sheet", args: { media: "m-cuts", at: "shots" } },
      { tool: "contact_sheet", args: { media: "m-cuts", at: "shots", range: { start: 50, end: 150 } } },
      { tool: "contact_sheet", args: { at: "shots" } },
      { tool: "media_analyze", args: { media: "m-tone", analyzers: ["stability"] } },
    ]);
    assert.equal(turn.status, "done", turn.error);
    assert.deepEqual(steps(turn), [
      "Found the shots in Cuts.mp4",
      "Looked over the shots of Cuts.mp4",
      "Looked over the shots of Cuts.mp4 (frames 50–150)",
      "Looked over the shots",
      "Measured the camera motion of Tone.wav",
    ]);
    const [analyzed, sheet, ranged, noMedia, tone] = results;
    assert.ok(!analyzed!.isError, textOf(analyzed!));
    const v = jsonOf(analyzed!).video;
    assert.equal(v.state, "done");
    assert.equal(v.hasVideo, true);
    assert.equal(v.shots, 3);
    assert.equal(v.cuts.count, 2);
    const [c1, c2] = v.cuts.list;
    assert.ok(Math.abs(c1.frame - 45) <= 1 && Math.abs(c2.frame - 100) <= 1, JSON.stringify(v.cuts));
    assert.equal(v.frozen.length, 1);
    assert.ok(Math.abs(v.frozen[0].start - 45) <= 2 && Math.abs(v.frozen[0].end - 100) <= 2, JSON.stringify(v.frozen));
    assert.equal(v.perSecond.cleanScore.length, 5);
    assert.ok(v.stretches.length >= 1 && v.stretches.every((s: any) => ["good", "fair", "poor"].includes(s.quality)));
    assert.match(jsonOf(analyzed!).note, /^video: Scores are 0–1/);
    assert.equal(videoRuns().length, runsBefore + 1);

    // One cell per shot, at its middle: frames 22, 72, 124 (shots 0–45, 45–100, 100–150).
    assert.ok(!sheet!.isError, textOf(sheet!));
    const text = textOf(sheet!);
    assert.match(text, /^Contact sheet of m-cuts \(Cuts\.mp4\), 3 cells in 3 columns/);
    assert.match(text, /3 shots; each cell is the middle frame of its shot/);
    const lines = text.split("\n").filter((l) => /^\d+: frame/.test(l));
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /^1: frame 22 \(0:00\.73\), shot frames 0–45 /);
    assert.match(lines[1]!, /^2: frame 72 \(0:02\.40\), shot frames 45–100 /);
    assert.match(lines[2]!, /^3: frame 124 \(0:04\.13\), shot frames 100–150 /);
    assert.ok(sheet!.content.some((c) => c.type === "image" && c.data!.length > 1000));
    // A range keeps the shots that overlap it.
    assert.match(textOf(ranged!), /its middle frame can lie outside the range/);
    assert.deepEqual(
      textOf(ranged!)
        .split("\n")
        .filter((l) => /^\d+: frame/.test(l))
        .map((l) => /shot frames (\d+–\d+)/.exec(l)![1]),
      ["45–100", "100–150"],
    );
    assert.equal(videoRuns().length, runsBefore + 1, "the sheets reuse the cached analysis");
    assert.ok(noMedia!.isError);
    assert.match(textOf(noMedia!), /at "shots" needs media/);
    // A sound file has no picture: answered without a job.
    assert.equal(jsonOf(tone!).video.hasVideo, false);
    assert.equal(videoRuns().length, runsBefore + 1);
  },
);
