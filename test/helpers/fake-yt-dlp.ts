#!/usr/bin/env node
// Stands in for yt-dlp in tests (D259): never the network, never a real yt-dlp.
//   yt-dlp --version: prints 2026.07.04.
//   yt-dlp [options] -- <url>: prints the --print templates (title, final file path) like the real
//   one, progress lines (the --progress-template), and copies $FAKE_YTDLP_VIDEO (or with -x,
//   $FAKE_YTDLP_AUDIO) to the -o template with %(ext)s as mp4 (m4a).
// $FAKE_YTDLP_TITLE: the video's title ("Fake video"). $FAKE_YTDLP_LOG: every run's argv, one JSON
// line each. $FAKE_YTDLP_SLEEP_MS: take that long downloading (progress meanwhile), so a test can
// cancel (a link with "slow" in it: a minute); $FAKE_YTDLP_PID_FILE: where to write the pid of a
// child it starts (like ffmpeg), which a cancel must kill too. $FAKE_YTDLP_ERROR (or a link with
// "unsupported" in it): fail with that ERROR: line instead (exit 1).
import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("2026.07.04");
  process.exit(0);
}
if (process.env.FAKE_YTDLP_LOG) appendFileSync(process.env.FAKE_YTDLP_LOG, `${JSON.stringify({ argv, pid: process.pid, uncutEnv: Object.keys(process.env).filter((k) => k.startsWith("UNCUT_")).length })}\n`);
const dash = argv.indexOf("--");
const url = dash >= 0 ? argv[dash + 1] : argv[argv.length - 1];
const opts = dash >= 0 ? argv.slice(0, dash) : argv;
const values = (name: string) => opts.flatMap((a, i) => (a === name && i + 1 < opts.length ? [opts[i + 1]!] : []));
const template = values("-o")[0];
const audio = opts.includes("-x");
const title = process.env.FAKE_YTDLP_TITLE ?? "Fake video";
const prints = values("--print");
const progressTemplate = values("--progress-template")[0] ?? "download:[download] %(progress._percent_str)s";

if (!url || !/^https?:\/\//.test(url) || !template) {
  console.error("ERROR: fake yt-dlp: no URL or -o");
  process.exit(2);
}
const error = process.env.FAKE_YTDLP_ERROR ?? (url.includes("unsupported") ? `ERROR: Unsupported URL: ${url}` : undefined);
if (error) {
  console.error(`[generic] Extracting URL: ${url}`);
  console.error(error);
  process.exit(1);
}
const fill = (t: string, file: string) => t.replace(/%\(title\)s/g, title).replace(/%\(filepath\)s/g, file).replace(/%\(ext\)s/g, audio ? "m4a" : "mp4");
const out = fill(template, "");
const printFor = (when: string, file: string) => {
  for (const p of prints) if (p.startsWith(`${when}:`)) console.log(fill(p.slice(when.length + 1), file));
};
printFor("before_dl", out);

// A child like the real one's ffmpeg: a cancel must take it down too (the process group).
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
if (process.env.FAKE_YTDLP_PID_FILE) writeFileSync(process.env.FAKE_YTDLP_PID_FILE, String(child.pid));

const sleepMs = url.includes("slow") ? 60000 : Number(process.env.FAKE_YTDLP_SLEEP_MS ?? 0);
const steps = 10;
writeFileSync(`${out}.part`, "partial");
for (let i = 1; i <= steps; i++) {
  if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs / steps));
  const pct = `${((i / steps) * 100).toFixed(1).padStart(5)}%`;
  console.log(progressTemplate.replace(/^download:/, "").replace(/%\(progress\._percent_str\)s/g, pct));
}
copyFileSync(audio ? process.env.FAKE_YTDLP_AUDIO! : process.env.FAKE_YTDLP_VIDEO!, out);
await import("node:fs/promises").then((fs) => fs.rm(`${out}.part`, { force: true }));
if (!audio) console.log(`[Merger] Merging formats into "${out}"`);
else console.log(`[ExtractAudio] Destination: ${out}`);
printFor("after_move", out);
child.kill();
process.exit(0);
