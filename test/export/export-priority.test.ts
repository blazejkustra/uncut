// Item 2 (2026-10-27): an export never takes the app down. Its helpers run at a lower priority, its
// encoder leaves two cores free and each input decodes with two threads (30 layers held 4.8 GB).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXPORT_NICE, boundedDecoders, encodeArgs, encoderThreads, run } from "../../apps/server/src/export/exporter/ffmpeg.ts";
import { exportProject, makeExportFixture, writeProject } from "../helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skipServer = !existsSync(BUNDLE) || !existsSync(MEDIA) ? "server or media core not built (run pnpm build)" : !hasFfmpeg ? "needs ffmpeg" : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const niceOf = (pid: string) => Number(spawnSync("ps", ["-o", "nice=", "-p", pid], { encoding: "utf8" }).stdout.trim());

test("a High (software) export runs below the app's priority and the server keeps answering", { skip: skipServer, timeout: 180000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-export-priority-")));
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data") } });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    const media = join(root, "media");
    makeExportFixture(media);
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1920x1080:rate=30",
      "-t",
      "40",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      join(media, "Long.mp4"),
    ]);
    const base = exportProject(media);
    const long = {
      ...base,
      media: [
        ...base.media,
        {
          id: "m-long",
          kind: "video" as const,
          name: "Long.mp4",
          path: join(media, "Long.mp4"),
          probe: { frames: 1200, fps: 30, width: 1920, height: 1080, hasAudio: false },
        },
      ],
      tracks: base.tracks.map((t) => (t.id === "main" ? { ...t, items: [{ id: "long", type: "clip" as const, media: "m-long", in: 0, duration: 1200 }] } : t)),
    };
    await client.ok("project.open", { dir: writeProject(root, "Long", long) });
    const jobs = client.subscribe("export.jobs");
    const { jobId } = await client.ok("export.start", { output: join(root, "Long.mp4"), quality: "high", loudness: "off" });
    await jobs.until((list) => list.some((j: any) => j.id === jobId && j.phase === "rendering" && j.progress > 0.05), 120000);

    const kids = spawnSync("pgrep", ["-P", String(server.proc.pid)], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .filter(Boolean);
    assert.ok(kids.length >= 1, "ffmpeg runs as the server's child");
    for (const pid of kids) assert.equal(niceOf(pid), EXPORT_NICE, `pid ${pid} runs at the export's priority`);
    const waits: Array<number> = [];
    for (let i = 0; i < 10; i++) {
      const asked = Date.now();
      await client.ok("server.hello");
      waits.push(Date.now() - asked);
      await sleep(200);
    }
    assert.ok(Math.max(...waits) < 1000, `the server answers while it exports: ${waits.join(", ")} ms`);
    await client.ok("export.cancel", { jobId });
    await jobs.until((list) => list.some((j: any) => j.id === jobId && j.phase === "cancelled"), 20000);
  } finally {
    client.close();
    await server.stop();
    killAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("export helpers run at the export's lower priority", { skip: process.platform === "win32" }, async () => {
  const r = await run("/bin/sh", ["-c", "sleep 0.2; ps -o nice= -p $$"], undefined);
  assert.equal(r.code, 0);
  assert.equal(Number(r.stdout.trim()), EXPORT_NICE);
});

test("the encoder leaves two cores to the app, and always has one", () => {
  assert.equal(encoderThreads(12), 10);
  assert.equal(encoderThreads(4), 2);
  assert.equal(encoderThreads(2), 1);
  assert.equal(encoderThreads(1), 1);
});

test("every input decodes with two threads, whatever comes before its -i", () => {
  const inputs = ["-i", "bg.png", "-hwaccel", "videotoolbox", "-ss", "4", "-t", "19", "-i", "camera.mp4", "-f", "srt", "-i", "subs.srt"];
  assert.deepEqual(boundedDecoders(inputs), [
    "-threads",
    "2",
    "-i",
    "bg.png",
    "-hwaccel",
    "videotoolbox",
    "-ss",
    "4",
    "-t",
    "19",
    "-threads",
    "2",
    "-i",
    "camera.mp4",
    "-f",
    "srt",
    "-threads",
    "2",
    "-i",
    "subs.srt",
  ]);
});

test("the encode's arguments: bounded inputs, then the graph, the encoder's threads and the output", () => {
  const args = encodeArgs(
    { inputs: ["-i", "a.mp4"], outputArgs: ["-map", "[vout]", "-c:v", "libx264", "out.mp4"] },
    ["-filter_complex_script", "graph.txt"],
    8,
  );
  assert.deepEqual(args.slice(args.indexOf("-threads")), [
    "-threads",
    "2",
    "-i",
    "a.mp4",
    "-filter_complex_script",
    "graph.txt",
    "-threads:v",
    "6",
    "-map",
    "[vout]",
    "-c:v",
    "libx264",
    "out.mp4",
  ]);
  assert.deepEqual(args.slice(0, 2), ["-hide_banner", "-nostdin"]);
  assert.ok(args.includes("-progress"));
});
