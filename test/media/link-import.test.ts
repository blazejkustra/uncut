// D259 (#94), D280 without the app: Import from link's link check, the yt-dlp arguments (no
// config, no cookies, no playlist, our own output name, the link last after --), its output lines
// and errors in plain words (all the plugin's, plugins/catalog/uncut-link-import/ytdlp.ts), the names
// from the title, where yt-dlp is looked for, and a run of the fake yt-dlp with those arguments
// (title, progress, the file) and its cancel (the whole process group goes, and the child it
// started with it). Then the plugin itself: a catalog plugin (not bundled, no agent tools, a
// neutral description) whose download tool runs through the plugin host. Never the network, never
// a real yt-dlp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkLink, linkFileStem, linkMediaName } from "../../apps/server/src/media/linkArgs.ts";
import { pluginRefusal, ytDlpSearchPath } from "../../apps/server/src/media/linkImport.ts";
import { discoverPlugins, isApproved, PluginHost } from "../../apps/server/src/plugins/plugins.ts";
import { LINK_PLUGIN_ID } from "../../packages/contracts/src/link.ts";
import { checkLink as pluginCheckLink, formatArgs, parseLine, plainYtDlpError, runYtDlp, ytDlpArgs } from "../../plugins/catalog/uncut-link-import/ytdlp.ts";

const FAKE = resolve("test/helpers/fake-yt-dlp.ts");

test("checkLink (Uncut's and the plugin's own): http(s) with a host only; no password; trimmed and normalised", () => {
  for (const check of [checkLink, pluginCheckLink]) {
    assert.deepEqual(check("  https://example.com/watch?v=abc  "), { url: "https://example.com/watch?v=abc" });
    assert.deepEqual(check("http://Example.com"), { url: "http://example.com/" });
    for (const bad of ["", "   ", 42, undefined, "example.com/video", "file:///etc/passwd", "ftp://example.com/a", "javascript:alert(1)", "-o/tmp/x", "--exec=rm", "https://user:pw@example.com/v", `https://example.com/${"a".repeat(3000)}`]) {
      const r = check(bad);
      assert.ok("problem" in r, `refused: ${String(bad).slice(0, 40)}`);
    }
  }
});

test("ytDlpArgs: no config, no playlist, our output name, prints with markers, the link last after --", () => {
  const args = ytDlpArgs({ url: "https://example.com/v?x=1&y=2", kind: "video", quality: "1080", stem: "link-abc", ffmpeg: "/opt/homebrew/bin/ffmpeg" });
  assert.ok(args.includes("--ignore-config"));
  assert.ok(args.includes("--no-cookies") && args.includes("--no-cookies-from-browser"), "nothing signed in");
  assert.ok(args.includes("--no-playlist"));
  assert.ok(args.includes("--no-overwrites"));
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), "https://example.com/v?x=1&y=2");
  assert.equal(args[args.indexOf("-o") + 1], "link-abc.%(ext)s", "the title never becomes a path; no project path (D266: yt-dlp expands $VARS in it)");
  assert.ok(!args.includes("-P") && !args.includes("--paths"));
  assert.throws(() => ytDlpArgs({ url: "https://e.com", kind: "video", quality: "best", stem: "$HOME/x" }));
  assert.equal(args[args.indexOf("--ffmpeg-location") + 1], "/opt/homebrew/bin/ffmpeg");
  assert.ok(args.includes("before_dl:UNCUT_TITLE %(title)s") && args.includes("after_move:UNCUT_FILE %(filepath)s"));
  assert.ok(!args.some((a) => /--exec|--config-location|--batch-file|--load-info|--cookies/.test(a)), "nothing that runs or reads other files");
  assert.equal(args.filter((a) => a === "--").length, 1);
  assert.ok(!ytDlpArgs({ url: "https://e.com", kind: "video", quality: "best", stem: "x" }).includes("--ffmpeg-location"));
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
  assert.equal(parseLine("[generic] abc: Downloading webpage"), undefined);
});

test("plainYtDlpError: yt-dlp's errors in plain words", () => {
  const cases: Array<[string, RegExp]> = [
    ["ERROR: Unsupported URL: https://example.com/", /doesn't know how to import from that site/],
    ["ERROR: [generic] abc: Private video. Sign in if you've been granted access", /private/],
    ["ERROR: [generic] abc: Sign in to confirm you're not a bot", /sign in/],
    ["ERROR: [generic] abc: This content requires authentication", /sign in/],
    ["ERROR: [generic] abc: Use --cookies-from-browser or --cookies for the authentication", /sign in/],
    ["ERROR: [generic] abc: Video unavailable", /isn't available/],
    ["ERROR: [generic] abc: Requested format is not available", /quality isn't available/],
    ["ERROR: unable to download video data: HTTP Error 403: Forbidden", /refused.*brew upgrade yt-dlp/],
    ["ERROR: [generic] Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>", /Couldn't reach the site/],
    ["ERROR: You have requested merging of multiple formats but ffmpeg is not installed", /brew install ffmpeg/],
    ["ERROR: ffprobe and ffmpeg not found. Please install or provide the path", /brew install ffmpeg/],
    ["ERROR: [example] 123: Something odd happened", /yt-dlp couldn't import it: Something odd happened/],
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
      const args = ytDlpArgs({ url: "https://example.com/v", kind, quality: "720", stem: `link-${kind}` });
      const r = await runYtDlp(join(root, "bin", "yt-dlp"), args, (l) => lines.push(parseLine(l)), new AbortController().signal, join(root, "out"));
      assert.equal(r.code, 0, r.stderr);
      const ext = kind === "audio" ? "m4a" : "mp4";
      assert.deepEqual(lines.find((l) => l && "title" in l), { title: "Sunset: over/the sea" });
      assert.deepEqual(lines.find((l) => l && "file" in l), { file: `link-${kind}.${ext}` }, "relative to the folder it ran in");
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
    Object.assign(process.env, { FAKE_YTDLP_VIDEO: join(root, "video.mp4"), FAKE_YTDLP_SLEEP_MS: "20000", FAKE_YTDLP_PID_FILE: pidFile, FAKE_YTDLP_TEMP_ON_TERM: "1" });
    const controller = new AbortController();
    const args = ytDlpArgs({ url: "https://example.com/v", kind: "video", quality: "1080", stem: "link-c" });
    const seen: Array<number> = [];
    const done = runYtDlp(join(root, "bin", "yt-dlp"), args, (l) => {
      const p = parseLine(l);
      if (p && "progress" in p) seen.push(p.progress);
    }, controller.signal, join(root, "out"));
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
    // D266: it resolves only once the whole group is gone, so the child's late .temp is already
    // there for the cleanup (removePartials) to take, never written after it.
    assert.ok(!alive(child), "the child yt-dlp started is gone too, before runYtDlp resolves");
    assert.ok(existsSync(join(root, "out", "link-c.mp4.temp")), "the child's last write landed before the resolve");
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
    const r = await runYtDlp(join(root, "bin", "yt-dlp"), ytDlpArgs({ url: "https://example.com/v", kind: "video", quality: "1080", stem: "x" }), () => {}, new AbortController().signal, join(root, "out"));
    assert.equal(r.code, 1);
    assert.match(plainYtDlpError(r.stderr, r.code), /doesn't know how to import from that site/);
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("D266: a project folder with $HOME in its name: the download stays in its media/links", async () => {
  const root = fakeDir();
  const saved = { ...process.env };
  try {
    const links = join(root, "$HOME Launch.uncut", "media", "links");
    mkdirSync(links, { recursive: true });
    Object.assign(process.env, { FAKE_YTDLP_VIDEO: join(root, "video.mp4"), HOME: join(root, "home") });
    mkdirSync(join(root, "home"));
    const lines: Array<ReturnType<typeof parseLine>> = [];
    const r = await runYtDlp(join(root, "bin", "yt-dlp"), ytDlpArgs({ url: "https://example.com/v", kind: "video", quality: "1080", stem: "link-home" }), (l) => lines.push(parseLine(l)), new AbortController().signal, links);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readdirSync(links), ["link-home.mp4"]);
    assert.deepEqual(readdirSync(join(root, "home")), [], "nothing written where $HOME points");
    // The old absolute template would have been expanded by yt-dlp (and the fake does the same).
    await runYtDlp(join(root, "bin", "yt-dlp"), ["-o", `${links}/link-old.%(ext)s`, "--", "https://example.com/v"], () => {}, new AbortController().signal);
    assert.ok(!existsSync(join(links, "link-old.mp4")), "the fake expands $HOME like yt-dlp, so this test can tell");
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("D280: link.start needs the plugin installed and allowed; the words say where", () => {
  assert.equal(pluginRefusal("ready"), undefined);
  assert.match(pluginRefusal(undefined) ?? "", /install it from Settings › Plugins/);
  assert.match(pluginRefusal("needs-approval") ?? "", /allow it in Settings › Plugins/);
  assert.match(pluginRefusal("broken") ?? "", /Settings › Plugins/);
});

const PLUGIN_DIR = resolve("plugins/catalog/uncut-link-import");
const SITES = /youtube|youtu\.be|instagram|tiktok|vimeo|twitter|facebook|twitch|soundcloud|dailymotion|reddit/i;

test("D280: a catalog plugin, not bundled; Uncut calls it, the agent can't; no site named anywhere", async () => {
  const bundled = JSON.parse(readFileSync("plugins/bundled.json", "utf8")) as { bundled: Array<string> };
  assert.ok(!bundled.bundled.includes(LINK_PLUGIN_ID), "not bundled: the user installs and allows it");
  const found = await discoverPlugins([{ source: "user", dir: resolve("plugins/catalog") }], { moduleIds: new Set(), toolNames: new Set() });
  const plugin = found.plugins.find((p) => p.id === LINK_PLUGIN_ID);
  assert.ok(plugin, JSON.stringify(found.broken));
  assert.equal(plugin.dir, PLUGIN_DIR);
  assert.equal(plugin.kind, "importer");
  assert.deepEqual(plugin.tools, [], "no agent tools: the agent can't trigger it");
  assert.deepEqual(plugin.warnings, [], "an importer without agent tools isn't warned about");
  assert.ok(plugin.runs);
  assert.equal(isApproved(plugin, undefined), false, "off until the user allows it");
  assert.match(plugin.description ?? "", /^Import a video or audio file from a link using your own yt-dlp\./);
  for (const file of readdirSync(PLUGIN_DIR)) assert.doesNotMatch(readFileSync(join(PLUGIN_DIR, file), "utf8"), SITES, `no site named in ${file}`);
  for (const file of ["apps/web/src/panels/library/ImportLinkDialog.tsx", "apps/web/src/panels/library/linkImport.ts", "apps/server/src/media/linkImport.ts", "apps/server/src/media/linkArgs.ts", "packages/contracts/src/link.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), SITES, `no site named in ${file}`);
  }
  assert.doesNotMatch(readFileSync("README.md", "utf8"), /yt-dlp|import from (a )?link/i, "the README doesn't mention it");
  assert.equal(readdirSync(PLUGIN_DIR).filter((f) => !/\.(ts|json)$/.test(f) && f !== "icon.svg").length, 0, "top-level .ts and .json only, and its icon (what the app ships of a plugin)");
});

test("D280: the plugin's download through the plugin host: progress with steps, the file, and a cancel that leaves nothing", async () => {
  const root = fakeDir();
  const saved = { ...process.env };
  const host = new PluginHost();
  try {
    Object.assign(process.env, { FAKE_YTDLP_VIDEO: join(root, "video.mp4"), FAKE_YTDLP_AUDIO: join(root, "audio.m4a"), FAKE_YTDLP_TITLE: "Sunset", FAKE_YTDLP_SLEEP_MS: "600", FAKE_YTDLP_PID_FILE: join(root, "child.pid"), UNCUT_SECRET_THING: "x" });
    const found = await discoverPlugins([{ source: "user", dir: resolve("plugins/catalog") }], { moduleIds: new Set(), toolNames: new Set() });
    const plugin = found.plugins.find((p) => p.id === LINK_PLUGIN_ID)!;
    const searchPath = `${join(root, "bin")}:/usr/bin:/bin`;
    const checked = await host.call(plugin.spec, "check", { searchPath }, undefined, undefined, undefined, { timeoutMs: 20000 });
    assert.deepEqual(checked.structured, { found: true, path: join(root, "bin", "yt-dlp"), version: "2026.07.04" });
    const missing = await host.call(plugin.spec, "check", { searchPath: "/usr/bin:/bin" }, undefined, undefined, undefined, { timeoutMs: 20000 });
    assert.deepEqual(missing.structured, { found: false });

    const out = realpathSync(join(root, "out"));
    const seen: Array<{ p: number; message?: string | undefined }> = [];
    const r = await host.call(plugin.spec, "download", { url: "https://example.com/v", kind: "video", quality: "720", folder: out, stem: "link-plug", searchPath }, undefined, undefined, undefined, {
      timeoutMs: 30000,
      onProgress: (p, _total, message) => seen.push({ p, message }),
    });
    assert.equal(r.isError, undefined, JSON.stringify(r.content));
    assert.deepEqual(r.structured, { file: join(out, "link-plug.mp4"), title: "Sunset" });
    assert.equal(seen.filter((s) => !s.message).at(-1)?.p, 1);
    assert.ok(seen.some((s) => s.message === "Joining video and sound…"), "a step comes as the progress message");

    // A bad link or stem is refused by the plugin too, before yt-dlp runs.
    for (const args of [{ url: "ftp://example.com/v", stem: "x" }, { url: "https://example.com/v", stem: "$HOME/x" }]) {
      const bad = await host.call(plugin.spec, "download", { kind: "video", quality: "720", folder: out, searchPath, ...args }, undefined, undefined, undefined, { timeoutMs: 10000 });
      assert.equal(bad.isError, true);
    }
    const failedRun = await host.call(plugin.spec, "download", { url: "https://example.com/unsupported", kind: "video", quality: "720", folder: out, stem: "link-bad", searchPath }, undefined, undefined, undefined, { timeoutMs: 10000 });
    assert.equal(failedRun.isError, true);
    assert.match(JSON.stringify(failedRun.content), /doesn't know how to import from that site/);

    // Cancel: the call's signal aborts; the plugin kills yt-dlp's group and removes the partial files.
    rmSync(join(root, "child.pid"), { force: true });
    const controller = new AbortController();
    const slow = host.call(plugin.spec, "download", { url: "https://example.com/slow", kind: "audio", quality: "best", folder: out, stem: "link-slow", searchPath }, controller.signal, undefined, undefined, { timeoutMs: 60000 });
    for (let i = 0; i < 100 && !existsSync(join(root, "child.pid")); i++) await new Promise((res) => setTimeout(res, 50));
    const child = Number(readFileSync(join(root, "child.pid"), "utf8"));
    assert.ok(alive(child));
    controller.abort();
    const cancelled = await slow;
    assert.equal(cancelled.isError, true);
    for (let i = 0; i < 100 && (alive(child) || readdirSync(out).some((f) => f.startsWith("link-slow."))); i++) await new Promise((res) => setTimeout(res, 50));
    assert.ok(!alive(child), "yt-dlp's child is gone");
    assert.deepEqual(readdirSync(out).filter((f) => f.startsWith("link-slow.")), [], "no partial files left");
  } finally {
    await host.stopAll();
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
