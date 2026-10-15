// Issue #53: timeline filmstrips. The sprite's layout and ffmpeg arguments, the tile each timeline
// cell shows (in point, speed, loop, hold, zoom), a real sprite made with ffmpeg and read back from
// the cache without running it again, and (with the built server) GET /media/filmstrip/<id>.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { filmstripArgs, generate, intervalFor, isFilmstripFileOf, jpegSize, layoutOf, MAX_TILES, tilesFor } from "../../apps/server/src/media/filmstrips.ts";
import { localInputs } from "../../apps/server/src/media/localInputs.ts";
import { mediaTimeAt, tileAt, visibleCells } from "../../apps/web/src/timeline/filmstripTiles.ts";
import { rgbaOf } from "../helpers/image-compare.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const ffSkip = hasFfmpeg ? false : "needs ffmpeg";
const serverSkip = !existsSync(BUNDLE) || !existsSync(MEDIA) ? "server or media core not built (run pnpm build)" : ffSkip;

let root = "";
const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-film-")));
  if (!hasFfmpeg) return;
  // 12 s of testsrc2 (a moving picture with a running clock), 16:9.
  ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "12", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "long.mp4"));
  // Like a D212 proxy: a keyframe every 10 frames, no B-frames.
  ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "12", "-c:v", "libx264", "-g", "10", "-bf", "0", "-pix_fmt", "yuv420p", join(root, "proxy.mp4"));
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("interval and tiles: half a second, longer for long media, never more than MAX_TILES", () => {
  assert.equal(intervalFor(3), 0.5);
  assert.equal(intervalFor(400), 0.5);
  assert.equal(intervalFor(600), 1);
  assert.equal(intervalFor(7200), 7.5);
  assert.deepEqual(tilesFor(7), { interval: 0.5, count: 14, cols: 10, rows: 2 });
  for (const s of [1, 59.9, 500, 1234, 7200, 36000]) assert.ok(tilesFor(s).count <= MAX_TILES, `${s} s`);
  assert.equal(tilesFor(0.1).count, 1);
});

test("ffmpeg arguments: local inputs only, picture only, a frame per interval tiled into one JPEG", () => {
  const args = localInputs("/opt/bin/ffmpeg", filmstripArgs("/in/a.mp4", "/out/a.jpg", 7));
  const i = args.indexOf("-i");
  assert.deepEqual(args.slice(i - 2, i + 2), ["-protocol_whitelist", "file,pipe", "-i", "/in/a.mp4"]);
  assert.ok(args.indexOf("-an") < i, "no sound is decoded");
  assert.equal(args[args.indexOf("-vf") + 1], "fps=1/0.5,scale=-2:64:flags=bilinear,tile=10x2");
  assert.equal(args.at(-1), "/out/a.jpg");
  assert.ok(!args.includes("-skip_frame"));
  const proxy = filmstripArgs("/p.mp4", "/o.jpg", 7, { keyframesOnly: true });
  assert.ok(proxy.indexOf("-skip_frame") < proxy.indexOf("-i"), "keyframes only (a proxy), as an input option");
});

test("cache file names belong to their id only", () => {
  assert.ok(isFilmstripFileOf("m-a--0123456789ab.jpg", "m-a"));
  assert.ok(isFilmstripFileOf("m-a--0123456789ab.json", "m-a"));
  assert.ok(!isFilmstripFileOf("m-a-b--0123456789ab.jpg", "m-a"));
  assert.ok(!isFilmstripFileOf("m-a--0123456789ab.jpg.tmp-1.jpg", "m-a"));
});

test("cells: each shows the frame at its own time, following in, speed, loop, hold and zoom", () => {
  const layout = { version: 1 as const, interval: 0.5, count: 24, cols: 10, rows: 3, tileWidth: 114, tileHeight: 64, seconds: 12 };
  const fps = 30;
  // A 10 s clip from the start, 1000 px wide: x px is x/100 s.
  const plain = { duration: 300 };
  assert.equal(mediaTimeAt(plain, fps, 0, 1000, 12), 0);
  assert.equal(mediaTimeAt(plain, fps, 500, 1000, 12), 5);
  // In at 4 s.
  assert.equal(mediaTimeAt({ in: 120, duration: 150 }, fps, 0, 500, 12), 4);
  // Speed 2: twice the media in the same width.
  assert.equal(mediaTimeAt({ duration: 150, speed: 2 }, fps, 500, 500, 12), 10);
  // Looped: starts over after the media's 12 s; held: stays on the last tile.
  assert.equal(mediaTimeAt({ duration: 600, loop: true }, fps, 700, 1000, 12), 2);
  assert.equal(tileAt(layout, mediaTimeAt({ duration: 600 }, fps, 900, 1000, 12)), 23);
  assert.equal(tileAt(layout, 2.74), 5);
  assert.equal(tileAt(layout, -1), 0);

  // Cells 32 px high are 57 px wide; only those in view (plus one each side) are made.
  const all = visibleCells(plain, fps, layout, 1000, 32, 0, 1000);
  assert.equal(all.width, 57);
  assert.equal(all.cells.length, Math.ceil(1000 / 57));
  const tiles = all.cells.map((c) => c.tile);
  assert.ok(new Set(tiles).size >= 15, `distinct tiles ${tiles}`);
  assert.deepEqual([...tiles].sort((a, b) => a - b), tiles, "in time order");
  const some = visibleCells(plain, fps, layout, 1000, 32, 400, 520);
  assert.ok(some.cells.length <= 5 && some.cells[0]!.index === 6, JSON.stringify(some.cells));
  // Zoomed in 4x: the same time span takes four times the cells (more detail).
  const zoomed = visibleCells(plain, fps, layout, 4000, 32, 0, 4000);
  assert.ok(zoomed.cells.length > all.cells.length * 3);
  // Trimmed to its last 2 s: the cells start at tile 16.
  assert.equal(visibleCells({ in: 240, duration: 60 }, fps, layout, 200, 32, 0, 200).cells[0]!.tile, 16);
});

test("jpegSize reads a JPEG's size; anything else is undefined", { skip: ffSkip }, () => {
  const jpg = join(root, "probe.jpg");
  ff("-f", "lavfi", "-i", "color=red:size=123x45", "-frames:v", "1", jpg);
  assert.deepEqual(jpegSize(readFileSync(jpg)), { width: 123, height: 45 });
  assert.equal(jpegSize(Buffer.from("not a jpeg")), undefined);
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff])), undefined);
});

test("a real sprite: made once with ffmpeg, the tiles differ, then read from the cache without ffmpeg", { skip: ffSkip, timeout: 60000 }, async () => {
  const folder = join(root, "cache", "filmstrips");
  const input = join(root, "long.mp4");
  const ffmpeg = async () => "ffmpeg";
  const ffprobe = async () => "ffprobe";
  const source = { path: input, key: "0123456789ab", input, proxy: false, seconds: undefined };
  const made = await generate(folder, "m-long", source, { ffmpeg, ffprobe });
  assert.equal(made.kind, "ok");
  if (made.kind !== "ok") return;
  assert.equal(made.from, "decode");
  // 12 s (from ffprobe, the project didn't say): 24 tiles, 10 to a row, 64 px high, 16:9.
  assert.deepEqual(made.layout, { version: 1, interval: 0.5, count: 24, cols: 10, rows: 3, tileWidth: 114, tileHeight: 64, seconds: 12 });
  assert.deepEqual(readdirSync(folder).sort(), ["m-long--0123456789ab.jpg", "m-long--0123456789ab.json"]);
  assert.deepEqual(layoutOf(made.bytes, 12), made.layout);

  // Tiles from different times hold different pictures (testsrc2's moving parts and clock).
  const sprite = join(folder, "m-long--0123456789ab.jpg");
  const rgba = rgbaOf(sprite);
  const W = 10 * 114;
  const tile = (n: number) => {
    const out: Array<number> = [];
    const x0 = (n % 10) * 114;
    const y0 = Math.floor(n / 10) * 64;
    for (let y = y0; y < y0 + 64; y++) for (let x = x0; x < x0 + 114; x++) out.push(rgba[(y * W + x) * 4]!, rgba[(y * W + x) * 4 + 1]!, rgba[(y * W + x) * 4 + 2]!);
    return out;
  };
  const diff = (a: Array<number>, b: Array<number>) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;
  const first = tile(0);
  for (const n of [5, 12, 23]) assert.ok(diff(first, tile(n)) > 2, `tile ${n} differs from tile 0 (${diff(first, tile(n)).toFixed(2)})`);
  // The padding after the last tile (row 3, columns 4–9) is empty.
  assert.ok(diff(tile(27), tile(29)) < 1);

  // Again, with an ffmpeg that can't run: the cache answers.
  const missing = async () => "/nonexistent/ffmpeg";
  const again = await generate(folder, "m-long", source, { ffmpeg: missing, ffprobe: missing });
  assert.equal(again.kind, "ok");
  if (again.kind === "ok") {
    assert.equal(again.from, "cache");
    assert.deepEqual(again.layout, made.layout);
    assert.ok(again.bytes.equals(made.bytes));
  }

  // A new key (the file changed): made again, the old key's files go.
  const remade = await generate(folder, "m-long", { ...source, key: "ba9876543210", seconds: 12 }, { ffmpeg, ffprobe });
  assert.equal(remade.kind, "ok");
  assert.deepEqual(readdirSync(folder).filter((f) => f.startsWith("m-long-")).sort(), ["m-long--ba9876543210.jpg", "m-long--ba9876543210.json"]);

  // From a proxy (keyframes only): the same layout, and still different pictures along it.
  const fromProxy = await generate(folder, "m-proxy", { ...source, input: join(root, "proxy.mp4"), proxy: true, seconds: 12 }, { ffmpeg, ffprobe });
  assert.equal(fromProxy.kind, "ok");
  if (fromProxy.kind === "ok") {
    assert.deepEqual(fromProxy.layout, made.layout);
    const p = rgbaOf(join(folder, "m-proxy--0123456789ab.jpg"));
    const pTile = (n: number) => {
      const o: Array<number> = [];
      for (let y = Math.floor(n / 10) * 64; y < Math.floor(n / 10) * 64 + 64; y++) for (let x = (n % 10) * 114; x < (n % 10) * 114 + 114; x++) o.push(p[(y * W + x) * 4]!, p[(y * W + x) * 4 + 1]!, p[(y * W + x) * 4 + 2]!);
      return o;
    };
    assert.ok(diff(pTile(0), pTile(12)) > 2, "keyframe-only tiles differ");
  }
  // A proxy that's gone by the time ffmpeg runs: made from the original instead.
  const fallback = await generate(folder, "m-fallback", { ...source, input: join(root, "gone-proxy.mp4"), proxy: true, seconds: 12 }, { ffmpeg, ffprobe });
  assert.equal(fallback.kind, "ok");
  if (fallback.kind === "ok") assert.equal(fallback.from, "decode");

  // No ffmpeg and nothing cached: failed (try later), not "none".
  const none = await generate(folder, "m-other", source, { ffmpeg: async () => undefined, ffprobe });
  assert.deepEqual(none, { kind: "failed", why: "ffmpeg isn't installed" });
  // A file ffmpeg can't decode.
  const broken = await generate(folder, "m-bad", { ...source, input: join(root, "nope.mp4"), path: join(root, "nope.mp4"), seconds: 3 }, { ffmpeg, ffprobe });
  assert.equal(broken.kind, "failed");
  assert.ok(!readdirSync(folder).some((f) => f.startsWith("m-bad")), "nothing left behind");
});

test("GET /media/filmstrip/<id>: token, videos of the open project only, made then cached, CORS with the layout header", { skip: serverSkip, timeout: 90000 }, async () => {
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data") } });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    const base = `http://127.0.0.1:${server.ready.port}`;
    const get = (path: string, auth: string | null = server.ready.token) => fetch(`${base}${path}${auth === null ? "" : `?token=${encodeURIComponent(auth)}`}`);
    assert.equal((await get("/media/filmstrip/m-long")).status, 404, "nothing open yet");
    ff("-f", "lavfi", "-i", "color=blue:size=64x64", "-frames:v", "1", join(root, "still.png"));
    const snapshot = await client.ok("project.create", { parentDir: root, name: "Film" });
    const dir = (snapshot as { dir: string }).dir;
    await client.ok("project.edit", {
      ops: [
        { op: "add_media", media: { id: "m-long", kind: "video", name: "long.mp4", path: join(root, "long.mp4"), probe: { frames: 360, fps: 30, width: 320, height: 180, hasAudio: false } } },
        { op: "add_media", media: { id: "m-still", kind: "image", name: "still.png", path: join(root, "still.png"), probe: { width: 64, height: 64 } } },
        { op: "add_media", media: { id: "m-gone", kind: "video", name: "gone.mp4", path: join(root, "gone.mp4"), probe: { frames: 30, fps: 30 } } },
      ],
    });
    assert.equal((await get("/media/filmstrip/m-long", null)).status, 401, "no token");
    assert.equal((await get("/media/filmstrip/m-long", "wrong")).status, 401, "bad token");
    assert.equal((await get("/media/filmstrip/m-nope")).status, 404, "unknown id");
    assert.equal((await get("/media/filmstrip/..%2Fsecret")).status, 404, "not an id");
    assert.equal((await get("/media/filmstrip/m-still")).status, 404, "a still keeps its poster");
    assert.equal((await get("/media/filmstrip/m-gone")).status, 404, "a file that isn't there");

    const [first, again] = await Promise.all([get("/media/filmstrip/m-long"), get("/media/filmstrip/m-long")]);
    assert.equal(first.status, 200);
    assert.equal(again.status, 200);
    assert.equal(first.headers.get("x-uncut-filmstrip"), "decode");
    assert.equal(first.headers.get("content-type"), "image/jpeg");
    assert.equal(first.headers.get("access-control-allow-origin"), "*");
    assert.match(first.headers.get("access-control-expose-headers") ?? "", /x-uncut-filmstrip-layout/);
    const layout = JSON.parse(first.headers.get("x-uncut-filmstrip-layout")!);
    assert.deepEqual(layout, { version: 1, interval: 0.5, count: 24, cols: 10, rows: 3, tileWidth: 114, tileHeight: 64, seconds: 12 });
    const bytes = Buffer.from(await first.arrayBuffer());
    assert.ok(Buffer.from(await again.arrayBuffer()).equals(bytes), "two requests share one run");
    const files = readdirSync(join(dir, ".cache", "filmstrips"));
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => /^m-long--[0-9a-f]{12}\.(jpg|json)$/.test(f)), files.join());

    const cached = await get("/media/filmstrip/m-long");
    assert.equal(cached.headers.get("x-uncut-filmstrip"), "cache");
    assert.ok(Buffer.from(await cached.arrayBuffer()).equals(bytes));

    // The file changes: a new strip under a new key, the old files go.
    ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "long.mp4"));
    utimesSync(join(root, "long.mp4"), new Date(), new Date(Date.now() + 5000));
    const changed = await get("/media/filmstrip/m-long");
    assert.equal(changed.headers.get("x-uncut-filmstrip"), "decode");
    await changed.arrayBuffer();
    const after = readdirSync(join(dir, ".cache", "filmstrips"));
    assert.equal(after.length, 2);
    assert.notDeepEqual(after.sort(), files.sort());
  } finally {
    client.close();
    await server.stop();
  }
});
