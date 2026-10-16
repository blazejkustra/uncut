// D259 (#94) without the app: Import from link's link check, yt-dlp arguments (no config, no
// playlist, our own output name, the link last after --), its output lines and errors in plain
// words, the names from the title, where yt-dlp is looked for, and a run of the fake yt-dlp with
// those arguments (title, progress, the file) and its cancel (the whole process group goes, and
// the child it started with it). Never the network, never a real yt-dlp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkLink, formatArgs, linkFileStem, linkMediaName, parseLine, plainYtDlpError, ytDlpArgs } from "../../apps/server/src/media/linkArgs.ts";
import { runYtDlp, ytDlpSearchPath } from "../../apps/server/src/media/linkImport.ts";

const FAKE = resolve("test/helpers/fake-yt-dlp.ts");

test("checkLink: http(s) with a host only; no password; trimmed and normalised", () => {
  assert.deepEqual(checkLink("  https://example.com/watch?v=abc  "), { url: "https://example.com/watch?v=abc" });
  assert.deepEqual(checkLink("http://Example.com"), { url: "http://example.com/" });
  for (const bad of ["", "   ", 42, undefined, "example.com/video", "file:///etc/passwd", "ftp://example.com/a", "javascript:alert(1)", "-o/tmp/x", "--exec=rm", "https://user:pw@example.com/v", `https://example.com/${"a".repeat(3000)}`]) {
    const r = checkLink(bad);
    assert.ok("problem" in r, `refused: ${String(bad).slice(0, 40)}`);
  }
});

test("ytDlpArgs: no config, no playlist, our output name, prints with markers, the link last after --", () => {
  const args = ytDlpArgs({ url: "https://example.com/v?x=1&y=2", kind: "video", quality: "1080", outBase: "/p/media/links/link-abc", ffmpeg: "/opt/homebrew/bin/ffmpeg" });
  assert.ok(args.includes("--ignore-config"));
  assert.ok(args.includes("--no-playlist"));
  assert.ok(args.includes("--no-overwrites"));
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), "https://example.com/v?x=1&y=2");
  assert.equal(args[args.indexOf("-o") + 1], "/p/media/links/link-abc.%(ext)s", "the title never becomes a path");
  assert.equal(args[args.indexOf("--ffmpeg-location") + 1], "/opt/homebrew/bin/ffmpeg");
  assert.ok(args.includes("before_dl:UNCUT_TITLE %(title)s") && args.includes("after_move:UNCUT_FILE %(filepath)s"));
  assert.ok(!args.some((a) => /--exec|--config-location|--batch-file|--load-info|--cookies/.test(a)), "nothing that runs or reads other files");
  assert.equal(args.filter((a) => a === "--").length, 1);
  assert.ok(!ytDlpArgs({ url: "https://e.com", kind: "video", quality: "best", outBase: "/x" }).includes("--ffmpeg-location"));
});

test("formatArgs: video capped by height preferring MP4/H.264; best uncapped; audio as m4a", () => {
  assert.deepEqual(formatArgs("video", "1080"), ["-f", "bv*+ba/b", "-S", "res:1080,vcodec:h264,acodec:aac,ext:mp4:m4a", "--merge-output-format", "mp4"]);
  assert.deepEqual(formatArgs("video", "720").slice(2, 4), ["-S", "res:720,vcodec:h264,acodec:aac,ext:mp4:m4a"]);
  assert.deepEqual(formatArgs("video", "best").slice(2, 4), ["-S", "res,ext:mp4:m4a"]);
  assert.deepEqual(formatArgs("audio", "1080"), ["-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a"]);
});

test("parseLine: title, file, progress (template or yt-dlp's own), steps", () => {
  assert.deepEqual(parseLine("UNCUT_TITLE  My video: part 1 "), { title: "My video: part 1" });
  assert.deepEqual(parseLine("UNCUT_FILE /p/media/links/link-abc.mp4"), { file: "/p/media/links/link-abc.mp4" });
  assert.deepEqual(parseLine("UNCUT_PROGRESS  42.5%"), { progress: 0.425 });
  assert.deepEqual(parseLine("[download]  99.9% of ~ 10.00MiB at 1.00MiB/s ETA 00:00"), { progress: 0.999 });
  assert.equal(parseLine("UNCUT_PROGRESS NA"), undefined);
  assert.deepEqual(parseLine('[Merger] Merging formats into "x.mp4"'), { status: "Joining video and sound…" });
  assert.deepEqual(parseLine("[ExtractAudio] Destination: x.m4a"), { status: "Making the m4a…" });
  assert.equal(parseLine("[youtube] abc: Downloading webpage"), undefined);
});

test("plainYtDlpError: yt-dlp's errors in plain words", () => {
  const cases: Array<[string, RegExp]> = [
    ["ERROR: Unsupported URL: https://example.com/", /doesn't know how to import from that site/],
    ["ERROR: [youtube] abc: Private video. Sign in if you've been granted access", /private/],
    ["ERROR: [youtube] abc: Sign in to confirm you're not a bot", /sign in/],
    ["ERROR: [youtube] abc: Video unavailable", /isn't available/],
    ["ERROR: [youtube] abc: Requested format is not available", /quality isn't available/],
    ["ERROR: unable to download video data: HTTP Error 403: Forbidden", /refused.*brew upgrade yt-dlp/],
    ["ERROR: [generic] Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>", /Couldn't reach the site/],
    ["ERROR: You have requested merging of multiple formats but ffmpeg is not installed", /brew install ffmpeg/],
    ["ERROR: ffprobe and ffmpeg not found. Please install or provide the path", /brew install ffmpeg/],
    ["ERROR: [vimeo] 123: Something odd happened", /yt-dlp couldn't import it: Something odd happened/],
  ];
  for (const [stderr, want] of cases) assert.match(plainYtDlpError(stderr, 1), want, stderr);
  assert.match(plainYtDlpError("", 2), /exit 2/);
  assert.match(plainYtDlpError("", null), /stopped before it finished/);
});

test("names: the media name from the title (unique in the project); a safe file stem", () => {
  assert.equal(linkMediaName("  My   trip\nto Kraków "), "My trip to Kraków");
  assert.equal(linkMediaName("Clip", new Set(["Clip", "Clip 2"])), "Clip 3");
  assert.equal(linkMediaName(undefined), "Imported link");
  assert.equal(linkMediaName("!!!"), "Imported link");
  assert.ok(linkMediaName("word ".repeat(40)).length <= 80);
  assert.equal(linkFileStem("../../etc/passwd"), "etc passwd");
  assert.equal(linkFileStem("a/b:c*d?e"), "a b c d e");
  assert.equal(linkFileStem(".hidden"), "hidden");
  assert.equal(linkFileStem("Kraków — day 1 (4K)"), "Kraków day 1 (4K)");
  assert.equal(linkFileStem("///"), "link");
  assert.equal(linkFileStem(undefined), "link");
  assert.ok(linkFileStem("x".repeat(300)).length <= 80);
});

test("ytDlpSearchPath: PATH, then the Homebrew folders; only PATH when the shell lookup is off (tests)", () => {
  assert.equal(ytDlpSearchPath({ PATH: "/a:/b" }), "/a:/b:/opt/homebrew/bin:/usr/local/bin");
  assert.equal(ytDlpSearchPath({ PATH: "/opt/homebrew/bin:/a" }), "/opt/homebrew/bin:/a:/usr/local/bin");
  assert.equal(ytDlpSearchPath({ PATH: "/a", UNCUT_SHELL_ENV: "off" }), "/a");
});

const fakeDir = () => {
  const root = mkdtempSync(join(tmpdir(), "uncut-ytdlp-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "yt-dlp"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(bin, "yt-dlp"), 0o755);
  writeFileSync(join(root, "video.mp4"), "fake mp4 bytes");
  writeFileSync(join(root, "audio.m4a"), "fake m4a bytes");
  mkdirSync(join(root, "out"));
  return root;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the fake yt-dlp with these arguments: title, progress and the file come back", async () => {
  const root = fakeDir();
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { FAKE_YTDLP_VIDEO: join(root, "video.mp4"), FAKE_YTDLP_AUDIO: join(root, "audio.m4a"), FAKE_YTDLP_TITLE: "Sunset: over/the sea", FAKE_YTDLP_LOG: join(root, "log") });
    for (const kind of ["video", "audio"] as const) {
      const lines: Array<ReturnType<typeof parseLine>> = [];
      const args = ytDlpArgs({ url: "https://example.com/v", kind, quality: "720", outBase: join(root, "out", `link-${kind}`) });
      const r = await runYtDlp(join(root, "bin", "yt-dlp"), args, (l) => lines.push(parseLine(l)), new AbortController().signal);
      assert.equal(r.code, 0, r.stderr);
      const ext = kind === "audio" ? "m4a" : "mp4";
      assert.deepEqual(lines.find((l) => l && "title" in l), { title: "Sunset: over/the sea" });
      assert.deepEqual(lines.find((l) => l && "file" in l), { file: join(root, "out", `link-${kind}.${ext}`) });
      const progress = lines.flatMap((l) => (l && "progress" in l ? [l.progress] : []));
      assert.equal(progress.length, 10);
      assert.equal(progress.at(-1), 1);
      assert.equal(readFileSync(join(root, "out", `link-${kind}.${ext}`), "utf8"), kind === "audio" ? "fake m4a bytes" : "fake mp4 bytes");
    }
    const logged = readFileSync(join(root, "log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: Array<string>; uncutEnv: number });
    assert.equal(logged.length, 2);
    for (const { argv, uncutEnv } of logged) {
      assert.ok(argv.includes("--ignore-config") && argv.includes("--no-playlist"));
      assert.equal(argv.at(-1), "https://example.com/v");
      assert.equal(uncutEnv, 0, "yt-dlp gets none of Uncut's own variables");
    }
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancel kills yt-dlp's whole process group (the child it started too)", async () => {
  const root = fakeDir();
  const saved = { ...process.env };
  try {
    const pidFile = join(root, "child.pid");
    Object.assign(process.env, { FAKE_YTDLP_VIDEO: join(root, "video.mp4"), FAKE_YTDLP_SLEEP_MS: "20000", FAKE_YTDLP_PID_FILE: pidFile });
    const controller = new AbortController();
    const args = ytDlpArgs({ url: "https://example.com/v", kind: "video", quality: "1080", outBase: join(root, "out", "link-c") });
    const seen: Array<number> = [];
    const done = runYtDlp(join(root, "bin", "yt-dlp"), args, (l) => {
      const p = parseLine(l);
      if (p && "progress" in p) seen.push(p.progress);
    }, controller.signal);
    const start = Date.now();
    while (!existsSync(pidFile) || seen.length === 0) {
      if (Date.now() - start > 10000) throw new Error("the fake never started");
      await new Promise((r) => setTimeout(r, 50));
    }
    const child = Number(readFileSync(pidFile, "utf8"));
    assert.ok(alive(child));
    controller.abort();
    const r = await done;
    assert.notEqual(r.code, 0);
    for (let i = 0; i < 40 && alive(child); i++) await new Promise((res) => setTimeout(res, 100));
    assert.ok(!alive(child), "the child yt-dlp started is gone too");
    assert.ok(!readdirSync(join(root, "out")).some((f) => f === "link-c.mp4"), "no finished file");
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a yt-dlp error comes back with its stderr, for plainYtDlpError", async () => {
  const root = fakeDir();
  const saved = { ...process.env };
  try {
    process.env.FAKE_YTDLP_ERROR = "ERROR: Unsupported URL: https://example.com/v";
    const r = await runYtDlp(join(root, "bin", "yt-dlp"), ytDlpArgs({ url: "https://example.com/v", kind: "video", quality: "1080", outBase: join(root, "out", "x") }), () => {}, new AbortController().signal);
    assert.equal(r.code, 1);
    assert.match(plainYtDlpError(r.stderr, r.code), /doesn't know how to import from that site/);
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
