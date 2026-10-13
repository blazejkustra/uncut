// What the phase 6 exit check (D93) found (D94–D96) missing and added: clips that hold their media's last frame
// (hold), the agent log and compare table components, and footnotes not counting as crowding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { agentLogState, audibleAt, componentDefaults, componentHtml, heldPast, loadModules, MAX_RASTER_STATES, planDeviceFrame, sourceAt, timelineProblems, validateProject, visualsAt, layout, type Item, type Project } from "../../packages/core/src/index.ts";
import { describeOp } from "../../packages/core/src/timeline/edit-log.ts";
import { exportCommand, planExport, silentFailure } from "../../apps/server/src/export/exportPlan.ts";
import { planTrim } from "../../apps/web/src/timeline/edit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const modules = await loadModules(join(here, "../../spec/modules/builtin"));
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const target = { canvas: { width: 1920, height: 1080 }, theme: undefined } as unknown as Parameters<typeof componentHtml>[1];

const project = (items: Array<Item>, frames = 60): Project => ({
  format: "uncut/0",
  name: "Hold",
  canvas: { width: 640, height: 360, fps: 30 },
  media: [{ id: "m", kind: "video", name: "short.mp4", path: "/tmp/short.mp4", probe: { frames, fps: 30, width: 320, height: 240, hasAudio: false } }],
  tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items }],
});

test("hold: a clip longer than its media shows the last frame (no media-range problem), loop wins, it is silent past the end (audibleAt, the export's audio, ducking)", () => {
  const held: Item = { id: "c", type: "clip", media: "m", in: 20, duration: 90, hold: true };
  assert.deepEqual(timelineProblems(project([held])), []);
  assert.deepEqual(timelineProblems(project([{ ...held, hold: undefined }])).map((p) => p.code), ["media-range"]);
  assert.deepEqual(validateProject(project([held]), modules), []);
  const p = project([held]);
  // Source time: 20 + local until the media's 60 frames end, then its last frame (59).
  assert.equal(sourceAt(p, held, 10), 30 / 30);
  assert.equal(sourceAt(p, held, 39), 59 / 30);
  assert.equal(sourceAt(p, held, 40), 59 / 30);
  assert.equal(sourceAt(p, held, 89), 59 / 30);
  assert.equal(heldPast(p, held, 39), false);
  assert.equal(heldPast(p, held, 40), true);
  // Loop wins over hold.
  assert.equal(sourceAt(p, { ...held, loop: true }, 45), 5 / 30);
  assert.equal(heldPast(p, { ...held, loop: true }, 45), false);
  // visualsAt draws it there (the preview and render_frames).
  const v = visualsAt(p, layout(p).starts, 70).find((x) => x.item.id === "c")!;
  assert.equal(v.source, 59 / 30);
  // Silent past the end: audibleAt (the preview's mix) drops it, the export plans no sound for a piece wholly there.
  const loud: Project = { ...p, media: p.media.map((m) => ({ ...m, probe: { ...m.probe!, hasAudio: true } })) };
  assert.equal(audibleAt(loud, layout(loud).starts, 30).length, 1);
  assert.equal(audibleAt(loud, layout(loud).starts, 50).length, 0);
  const split: Project = { ...loud, tracks: [{ ...loud.tracks[0]!, items: [{ id: "c1", type: "clip", media: "m", in: 20, duration: 50, hold: true }, { id: "c2", type: "clip", media: "m", in: 70, duration: 40, hold: true }] }] };
  assert.deepEqual(timelineProblems(split), []);
  const sp = planExport(split, { mediaPath: (m) => m.path, width: 640, height: 360 }) as Exclude<ReturnType<typeof planExport>, { problem: string }>;
  assert.deepEqual(sp.audio.map((a) => a.item.id), ["c1"], "the wholly held piece has no sound (no blip at its start)");
  assert.deepEqual(sp.visuals.filter((v) => v.kind === "video").map((v) => [v.item.id, (v as { source: number }).source]), [["c1", 20 / 30], ["c2", 59 / 30]]);
  // Its words in the edit log.
  assert.match(describeOp({ op: "update_item", item: "c", set: { hold: true } }, p), /holding its last frame/);
});

test("hold: insert_device_frame's footage shorter than the frame holds instead of looping when asked", () => {
  const p: Project = { ...project([{ id: "bg", type: "component", component: "component.solid", duration: 120, props: { color: "#000" } }]), canvas: { width: 1920, height: 1080, fps: 30 } };
  const plan = planDeviceFrame(p, { media: "m", start: 0, duration: 120, in: 10, hold: true, frameId: "f", clipId: "s" });
  assert.ok(!("problem" in plan));
  const clip = (plan as { ops: Array<{ op: string; item?: Item }> }).ops.find((o) => o.item?.id === "s")!.item!;
  assert.equal(clip.hold, true);
  assert.equal(clip.loop, undefined);
  const looped = planDeviceFrame(p, { media: "m", start: 0, duration: 120, frameId: "f", clipId: "s" }) as { ops: Array<{ item?: Item }> };
  assert.equal(looped.ops.find((o) => o.item?.id === "s")!.item!.loop, true);
});

test("hold: the export keeps the last frame on screen past the media's end (ffmpeg)", { skip: hasFfmpeg ? false : "needs ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-hold-"));
  try {
    // 2 s of a counter (each frame's luma rises), then the clip runs 1 s past it.
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=2,geq=lum='N*2':cb=128:cr=128", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "short.mp4")]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=1", "-frames:v", "1", join(dir, "bg.png")]);
    const p = project([{ id: "c", type: "clip", media: "m", in: 30, duration: 60, hold: true, transform: { x: 160, y: 60, w: 320, h: 240 } }]);
    const withPath: Project = { ...p, media: p.media.map((m) => ({ ...m, path: join(dir, "short.mp4") })) };
    const plan = planExport(withPath, { mediaPath: (m) => m.path, width: 640, height: 360 });
    assert.ok(!("problem" in plan), JSON.stringify(plan));
    const out = join(dir, "o.mp4");
    const cmd = exportCommand(plan as Exclude<typeof plan, { problem: string }>, { background: join(dir, "bg.png"), rasters: new Map(), caps: { encoders: new Set(["libx264"]), videotoolboxDecode: false, major: 8 }, quality: "draft", output: out });
    writeFileSync(join(dir, "graph.txt"), cmd.graph);
    const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...cmd.inputs, "-/filter_complex", join(dir, "graph.txt"), ...cmd.outputArgs], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr.slice(-600));
    assert.equal(silentFailure(r.stderr), undefined);
    const luma = (n: number) => {
      const b = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-vf", `select=eq(n\\,${n}),format=gray,crop=200:150:220:105`, "-frames:v", "1", "-f", "rawvideo", "-"]);
      return b.reduce((s, v) => s + v, 0) / b.length;
    };
    const [a, b, c, d] = [luma(10), luma(29), luma(40), luma(59)];
    console.log(`  held export luma: frame 10 ${a.toFixed(1)}, 29 ${b.toFixed(1)}, 40 ${c.toFixed(1)}, 59 ${d.toFixed(1)}`);
    assert.ok(b > a + 20, "the counter rises while the media plays");
    assert.ok(Math.abs(c - b) < 4 && Math.abs(d - b) < 4, "past the end, the last frame stays");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent log: the clock runs from runStart at the recording's speed and stops at the run's length; tokens and lines arrive by source time", () => {
  const props = { model: "Model A", speed: 8, srcAt: 2, runStart: 4, durationMs: 100000, doneLabel: "Passed", tokenLabel: "tokens without\ncache reads", lines: [{ t: 5, text: "hello" }, { t: 30, tool: "describe", text: "read the screen" }], tokens: [{ t: 5, cum: 1000 }, { t: 50, cum: 20000 }] };
  const at = (seconds: number) => agentLogState(props, seconds * 30, 30);
  assert.deepEqual(at(0), { src: 2, clock: 0, tokens: 0, lines: 0, done: false });
  assert.deepEqual(at(1), { src: 10, clock: 6, tokens: 1000, lines: 1, done: false });
  assert.deepEqual(at(6), { src: 50, clock: 46, tokens: 20000, lines: 2, done: false });
  assert.deepEqual(at(13), { src: 106, clock: 100, tokens: 20000, lines: 2, done: true });
  const html = (s: number) => componentHtml({ id: "l", type: "component", component: "component.agent-log", duration: 600, props }, target, s * 30);
  assert.match(html(1), /Model A/);
  assert.match(html(1), /tokens without<br>cache reads/);
  assert.doesNotMatch(html(1), /Passed/);
  assert.match(html(13), /Passed/);
  assert.match(html(13), /read the screen/);
  // A 25 s race of a 170 s run at 8×, a line every 2 s and tokens every 5 s: its distinct looks stay under the export's cap.
  const long = { ...componentDefaults("component.agent-log"), speed: 8, srcAt: 2, runStart: 4, durationMs: 169660, lines: Array.from({ length: 85 }, (_, i) => ({ t: 6 + 2 * i, text: `line ${i}` })), tokens: Array.from({ length: 34 }, (_, i) => ({ t: 6 + 5 * i, cum: 30000 + 3000 * i })) };
  const looks = new Set(Array.from({ length: 769 }, (_, f) => componentHtml({ id: "l", type: "component", component: "component.agent-log", duration: 769, props: long }, target, f)));
  console.log(`  agent log: ${looks.size} distinct looks over 769 frames (cap ${MAX_RASTER_STATES})`);
  assert.ok(looks.size < MAX_RASTER_STATES, `${looks.size} looks`);
});

test("compare table: rows come in one by one, bars grow to value ÷ the row's largest, values appear as the bars finish", () => {
  const props = { names: ["A", "B"], rows: [{ label: "Time", values: [100, 50], text: ["1:40", "0:50"] }, { label: "Cost", values: [0, 2], text: ["$0", "$2"] }], start: 0.5, step: 1, grow: 1, size: 24 };
  const html = (frame: number) => componentHtml({ id: "t", type: "component", component: "component.compare-table", duration: 300, props }, target, frame);
  // Before the first row: every row hidden, every bar empty.
  assert.equal([...html(0).matchAll(/opacity:0;transform/g)].length, 2);
  assert.equal([...html(0).matchAll(/width:0%/g)].length, 4);
  // Long after: full bars at 100 % and 50 % (row 1), 0 % and 100 % (row 2), values shown.
  const done = html(200);
  assert.deepEqual([...done.matchAll(/<i style="display:block;height:100%;width:([\d.]+)%/g)].map((m) => Number(m[1])), [100, 50, 0, 100]);
  for (const v of ["1:40", "0:50", "$0", "$2"]) assert.ok(done.includes(v), v);
  assert.doesNotMatch(done, /opacity:0[;"]/);
  // Mid-way: the first row in, the second not yet.
  const mid = html(45);
  assert.equal([...mid.matchAll(/opacity:0;transform/g)].length, 1);
});

test("hold: a held clip can be dragged longer on the timeline (not past its media when a transition out of it needs a handle)", () => {
  const p = project([{ id: "c", type: "clip", media: "m", in: 20, duration: 30, hold: true }, { id: "d", type: "clip", media: "m", in: 0, duration: 30 }]);
  const grown = planTrim(p, "c", "end", 100) as { duration: number };
  assert.equal(grown.duration, 130);
  assert.equal((planTrim({ ...p, tracks: [{ ...p.tracks[0]!, items: [{ ...p.tracks[0]!.items[0]!, hold: undefined }, p.tracks[0]!.items[1]!] }] }, "c", "end", 100) as { duration: number }).duration, 40, "without hold: up to the media's end");
  const withFade = project([{ id: "c", type: "clip", media: "m", in: 20, duration: 30, hold: true }, { id: "d", type: "clip", media: "m", in: 10, duration: 30, transitionIn: { module: "transition.crossfade", duration: 10 } }]);
  assert.equal((planTrim(withFade, "c", "end", 100) as { duration: number }).duration, 35, "a crossfade out needs 5 frames of media after the cut");
});

test("hold: after a wipe into a held clip whose media ends during the wipe, the export still shows its last frame (ffmpeg)", { skip: hasFfmpeg ? false : "needs ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-hold-wipe-"));
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "a.mp4")]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=320x240:r=30:d=0.667", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "s.mp4")]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=1", "-frames:v", "1", join(dir, "bg.png")]);
    const p: Project = {
      format: "uncut/0",
      name: "Wipe into hold",
      canvas: { width: 640, height: 360, fps: 30 },
      media: [
        { id: "a", kind: "video", name: "a.mp4", path: join(dir, "a.mp4"), probe: { frames: 120, fps: 30, width: 320, height: 240, hasAudio: false } },
        { id: "m", kind: "video", name: "s.mp4", path: join(dir, "s.mp4"), probe: { frames: 20, fps: 30, width: 320, height: 240, hasAudio: false } },
      ],
      tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c1", type: "clip", media: "a", in: 0, duration: 60 }, { id: "c2", type: "clip", media: "m", in: 15, duration: 90, hold: true, transitionIn: { module: "transition.wipe", duration: 30 } }] }],
    };
    assert.deepEqual(timelineProblems(p), []);
    const plan = planExport(p, { mediaPath: (m) => m.path, width: 640, height: 360 }) as Exclude<ReturnType<typeof planExport>, { problem: string }>;
    const out = join(dir, "o.mp4");
    const cmd = exportCommand(plan, { background: join(dir, "bg.png"), rasters: new Map(), caps: { encoders: new Set(["libx264"]), videotoolboxDecode: false, major: 8 }, quality: "draft", output: out });
    writeFileSync(join(dir, "graph.txt"), cmd.graph);
    const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...cmd.inputs, "-/filter_complex", join(dir, "graph.txt"), ...cmd.outputArgs], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr.slice(-600));
    const centre = (n: number) => [...execFileSync("ffmpeg", ["-v", "error", "-i", out, "-vf", `select=eq(n\\,${n}),format=gray,crop=100:100:270:130,scale=1:1`, "-frames:v", "1", "-f", "rawvideo", "-"])][0]!;
    const lumas = [80, 100, 140].map(centre);
    console.log(`  after the wipe: centre luma at 80, 100, 140: ${lumas.join(", ")}`);
    for (const l of lumas) assert.ok(l > 200, `the held white frame, not black: ${lumas}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent log: only the lines that can show go into its HTML, so a long log plans fast", () => {
  const props = { model: "M", speed: 100, srcAt: 0, runStart: 0, durationMs: 1e9, lines: Array.from({ length: 400 }, (_, i) => ({ t: i * 10, tool: "describe", text: "x".repeat(300) })), tokens: Array.from({ length: 1000 }, (_, i) => ({ t: i, cum: i * 100 })) };
  const item: Item = { id: "log", type: "component", component: "component.agent-log", start: 0, duration: 9000, props, transform: { x: 450, y: 200, w: 470, h: 739 } };
  const html = componentHtml(item, target, 8999);
  assert.ok(html.length < 30000, `${html.length} bytes at the end of a 400-line log`);
  // The last line is there, the first isn't.
  assert.equal((html.match(/describe/g) ?? []).length < 40, true);
  const p: Project = { format: "uncut/0", name: "Log", canvas: { width: 1920, height: 1080, fps: 30 }, media: [], tracks: [{ id: "v", kind: "video", name: "V", items: [item] }, { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 9000, props: { color: "#000" } }] }] };
  const t0 = Date.now();
  const plan = planExport(p, { mediaPath: () => "", width: 1920, height: 1080 });
  const ms = Date.now() - t0;
  console.log(`  5 min of agent log planned in ${ms} ms, ${html.length} bytes of HTML a frame`);
  assert.ok(!("problem" in plan));
  assert.ok(ms < 5000, `planned in ${ms} ms`);
});
