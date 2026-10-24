// D212: automatic preview proxies (issue #12).
// - Which footage gets one (4K, HEVC, long-GOP above 30 Mb/s) and how it is encoded.
// - The queue in process with the real ffmpeg: a proxy keyed like the posters (id--key.mp4), 1280 px,
//   the original's frame count; a changed original makes it stale at once and gets a new one (the
//   old file goes); nothing starts while an export is busy; light footage gets none.
// - On the bundled server: media.proxies reports it, GET /media/proxy serves it (token, 404 for
//   the rest), and the export reads the original even when the proxy is replaced by red frames.
// - Only the preview route reads proxies: export, render_frames and analysis never import them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ProxyState } from "../../packages/contracts/src/index.ts";
import { needsProxy, PROXY_GOP, proxyArgs, proxyDir, ProxyQueue } from "../../apps/server/src/media/proxies.ts";
import { posterKey } from "../../apps/server/src/media/media.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const ffmpegPath = hasFfmpeg ? execFileSync("/bin/sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim() : "";
const ffprobePath = hasFfmpeg ? execFileSync("/bin/sh", ["-c", "command -v ffprobe"], { encoding: "utf8" }).trim() : "";
const hasVt = hasFfmpeg && /\bh264_videotoolbox\b/.test(execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }));
const skipFf = hasFfmpeg ? false : "needs ffmpeg";

const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
/** A 4K long-GOP H.264 clip (keyframe every 120 frames) of `seconds`, picture `src` (a lavfi source). */
const make4k = (file: string, seconds = 1, src = "testsrc2") =>
  ff(
    "-f",
    "lavfi",
    "-i",
    `${src}=size=3840x2160:rate=30`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    String(seconds),
    "-c:v",
    hasVt ? "h264_videotoolbox" : "libx264",
    ...(hasVt ? ["-b:v", "20M"] : ["-preset", "ultrafast"]),
    "-g",
    "120",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    file,
  );
const probe = (file: string) =>
  JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "json", file],
      { encoding: "utf8" },
    ),
  ).streams[0] as { codec_name: string; width: number; height: number; nb_read_frames: string };

test("D212: 4K, HEVC and heavy long-GOP footage gets a proxy; light or intra footage doesn't", () => {
  assert.equal(needsProxy({ codec: "h264", width: 3840, height: 2160, bitrate: 50e6 }), true);
  assert.equal(needsProxy({ codec: "h264", width: 2160, height: 3840 }), true, "portrait 4K");
  assert.equal(needsProxy({ codec: "hevc", width: 1920, height: 1080, bitrate: 8e6 }), true, "HEVC at 1080p");
  assert.equal(needsProxy({ codec: "h264", width: 1920, height: 1080, bitrate: 45e6 }), true, "long-GOP above 30 Mb/s");
  assert.equal(needsProxy({ codec: "h264", width: 1920, height: 1080, bitrate: 12e6 }), false);
  assert.equal(needsProxy({ codec: "prores", width: 1920, height: 1080, bitrate: 150e6 }), false, "intra frames seek fast");
  assert.equal(needsProxy({ codec: "h264", width: 1280, height: 720 }), false);
  const args = proxyArgs("/in.MP4", "/out.mp4", "hardware");
  const arg = (flag: string) => args[args.indexOf(flag) + 1];
  assert.deepEqual([arg("-c:v"), arg("-g"), arg("-bf"), arg("-fps_mode")], ["h264_videotoolbox", String(PROXY_GOP), "0", "passthrough"]);
  assert.match(arg("-vf")!, /scale=w=1280:h=1280:force_original_aspect_ratio=decrease/);
  assert.equal(proxyArgs("/in.MP4", "/out.mp4", "software")[proxyArgs("/in.MP4", "/out.mp4", "software").indexOf("-c:v") + 1], "libx264");
});

test("D212: only the preview reads proxies: export, render_frames and analysis use the original", () => {
  // graphicMediaRoute.ts is the preview's route for graphics' footage (a playing preview's asks may
  // be answered from a proxy, which graphicMedia.ts reads when given a proxyPath); the export's and
  // render_frames' media sources are never given one.
  const preview = new Set(["apps/server/src/export/graphicMediaRoute.ts", "apps/server/src/export/graphicMedia.ts"]);
  for (const dir of ["apps/server/src/export", "apps/server/src/export/exporter", "apps/server/src/agent", "apps/server/src/analysis"]) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const text = readFileSync(join(dir, f), "utf8");
      if (!preview.has(`${dir}/${f}`)) assert.doesNotMatch(text, /proxies\.ts|proxyDir|\.cache\/proxies|PROXY_PATH|proxyPath/, `${dir}/${f}`);
    }
  }
  for (const f of ["apps/server/src/export/exporter/runJob.ts", "apps/server/src/export/exporter/frames.ts"])
    assert.match(
      readFileSync(f, "utf8"),
      /graphicMediaSource\(\{ bin, media: \(\) => project\.media, mediaPath, videotoolbox: caps\.videotoolboxDecode \}\)/,
      `${f}: its graphics' media from the originals`,
    );
});

const until = async (check: () => boolean, ms = 60000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("D212: the queue makes a keyed proxy, replaces it when the original changes, and waits for exports", { skip: skipFf, timeout: 180000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-proxies-")));
  try {
    mkdirSync(join(dir, "media"));
    const big = join(dir, "media", "Big.MP4");
    const small = join(dir, "media", "Small.mp4");
    make4k(big);
    ff("-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", small);
    let states: ReadonlyArray<ProxyState> = [];
    let busy = false;
    let runs = 0;
    const queue = new ProxyQueue({
      ffmpeg: async () => (runs++, ffmpegPath),
      ffprobe: async () => ffprobePath,
      exportBusy: () => busy,
      onChange: (s) => (states = s),
      hardware: async () => hasVt,
    });
    const media = [
      { id: "m-big", kind: "video", path: "media/Big.MP4" },
      { id: "m-small", kind: "video", path: small },
    ];
    await queue.sync(dir, media);
    await queue.idle();
    assert.deepEqual(
      states.map((s) => [s.mediaId, s.phase]),
      [["m-big", "done"]],
      "the light clip has no proxy",
    );
    const key = (await posterKey(big))!;
    assert.equal(states[0]!.key, key);
    const file = join(proxyDir(dir), `m-big--${key}.mp4`);
    assert.equal(await queue.proxyFor("m-big"), file);
    assert.deepEqual(readdirSync(proxyDir(dir)), [`m-big--${key}.mp4`], "no .part left");
    const p = probe(file);
    assert.deepEqual([p.codec_name, p.width, p.height], ["h264", 1280, 720]);
    assert.equal(p.nb_read_frames, probe(big).nb_read_frames, "frame for frame");

    // The same project again: nothing to make (one ffmpeg run so far).
    const before = runs;
    await queue.sync(dir, media);
    await queue.idle();
    assert.equal(runs, before);

    // The original changes in place: the proxy is stale at once, then replaced; the old file goes.
    await new Promise((r) => setTimeout(r, 20));
    make4k(big, 1, "mandelbrot");
    assert.equal(await queue.proxyFor("m-big"), undefined, "a stale proxy is never served");
    await queue.idle();
    await until(() => states[0]?.phase === "done" && states[0].key !== key);
    const key2 = (await posterKey(big))!;
    assert.equal(states[0]!.key, key2);
    assert.deepEqual(readdirSync(proxyDir(dir)), [`m-big--${key2}.mp4`]);

    // While an export is busy, a new proxy waits (and says so), then starts when it's over.
    busy = true;
    const other = join(dir, "media", "Other.MP4");
    make4k(other);
    await queue.sync(dir, [...media, { id: "m-other", kind: "video", path: other }]);
    queue.setExportBusy(true);
    await new Promise((r) => setTimeout(r, 300));
    const waiting = states.find((s) => s.mediaId === "m-other");
    assert.deepEqual([waiting?.phase, waiting?.waiting], ["queued", "export"]);
    busy = false;
    queue.setExportBusy(false);
    await queue.idle();
    assert.equal(states.find((s) => s.mediaId === "m-other")?.phase, "done");

    // Another project: the states go.
    await queue.sync(undefined, []);
    assert.deepEqual(states, []);
    queue.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- on the server ----

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const skipServer = !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(DESKTOP) ? "server, desktop or media core not built (run pnpm build)" : skipFf;

let root = "";
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let client: Awaited<ReturnType<typeof connect>> | undefined;

before(async () => {
  if (skipServer) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-proxies-server-")));
  mkdirSync(join(root, "out"));
  mkdirSync(join(root, "tmp"));
  server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), TMPDIR: join(root, "tmp"), UNCUT_PROXIES: "on" } });
  client = await connect(server.ready.port, server.ready.token);
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("D212 on the server: the proxy is reported and served for the preview; the export reads the original", { skip: skipServer, timeout: 180000 }, async () => {
  const clip = join(root, "Drone.MP4");
  make4k(clip, 2);
  const states = client!.subscribe("media.proxies");
  await client!.ok("project.create", { parentDir: root, name: "Proxies" });
  const { dir } = (await client!.ok("project.get", {})) as { dir: string };
  await client!.ok("media.import", { paths: [clip] });
  await states.until((list: ReadonlyArray<ProxyState>) => list.some((s) => s.phase === "done"), 120000);
  const done = states.values.at(-1)!.find((s: ProxyState) => s.phase === "done") as ProxyState;
  const base = `http://127.0.0.1:${server!.ready.port}`;
  const token = encodeURIComponent(server!.ready.token);
  assert.equal((await fetch(`${base}/media/proxy/${done.mediaId}`)).status, 401);
  assert.equal((await fetch(`${base}/media/proxy/m-nothing?token=${token}`)).status, 404);
  const served = await fetch(`${base}/media/proxy/${done.mediaId}?token=${token}`, { headers: { range: "bytes=0-" } });
  assert.equal(served.status, 206);
  const local = join(root, "served.mp4");
  writeFileSync(local, Buffer.from(await served.arrayBuffer()));
  assert.deepEqual([probe(local).width, probe(local).height], [1280, 720]);

  // The proxy replaced by red frames: an export of the clip still shows the original picture.
  const file = join(proxyDir(dir), `${done.mediaId}--${done.key}.mp4`);
  ff("-f", "lavfi", "-i", "color=c=red:size=1280x720:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", file);
  await client!.ok("project.edit", { ops: [{ op: "insert_item", track: "main", item: { id: "c1", type: "clip", media: done.mediaId, in: 0, duration: 30 } }] });
  const jobs = client!.subscribe("export.jobs");
  const output = join(root, "out", "Original.mp4");
  const { jobId } = await client!.ok("export.start", { output, quality: "draft", loudness: "off" });
  await jobs.until((list: ReadonlyArray<{ id: string; phase: string }>) => list.some((j) => j.id === jobId && ["done", "failed"].includes(j.phase)), 120000);
  assert.equal(jobs.values.at(-1)!.find((j: { id: string }) => j.id === jobId).phase, "done");
  const rgb = [
    ...execFileSync("ffmpeg", ["-v", "error", "-ss", "0.5", "-i", output, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]),
  ];
  assert.ok(!(rgb[0]! > 200 && rgb[1]! < 60 && rgb[2]! < 60), `the export is not the red proxy: ${rgb}`);
});
