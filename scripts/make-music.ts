// Makes the bundled CC0 music library (D91) from the studio's checked tracks:
//   node scripts/make-music.ts [source dir]   (default ~/Documents/devrel/video-editor/studio/library/music)
// Reads cozy-1…5.mp3 (never changes them), trims the long ones to 2 min with a 3 s fade out,
// normalises each to −16 LUFS integrated (two-pass loudnorm, true peak −1.5 dBTP), encodes AAC
// 128 kbps into assets/music/<file>.m4a, then measures every result (duration, loudness, tempo with
// the beats analyzer) and writes assets/music/library.json, licence details included.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { beatsFromSamples, SAMPLE_RATE } from "../apps/server/src/beats.ts";

const SOURCE = process.argv[2] ?? join(homedir(), "Documents/devrel/video-editor/studio/library/music");
const OUT = resolve("assets/music");
const TARGET_LUFS = -16;
const MAX_SECONDS = 120;

// Titles, authors and URLs from the source folder's licence table (each checked on its Freesound page).
const TRACKS = [
  { id: "cozy-1", title: "Chill Lofi - lost stars", author: "noel.wav", url: "https://freesound.org/people/noel.wav/sounds/680400/", moods: ["chill", "lo-fi", "warm"], checked: "2026-10-07" },
  { id: "cozy-2", title: "Dusty rhodes neo soul loop", author: "modcam.music", url: "https://freesound.org/people/modcam.music/sounds/676586/", moods: ["warm", "rhodes", "soul"], bpm: 75, checked: "2026-10-07" },
  { id: "cozy-3", title: "Lofi Vinyl E-Piano Loop", author: "holizna", url: "https://freesound.org/people/holizna/sounds/629176/", moods: ["lo-fi", "keys", "upbeat"], bpm: 95, checked: "2026-10-07" },
  { id: "cozy-4", title: "Sleepy Upright Piano Seamless Loop", author: "blankie.rest", url: "https://freesound.org/people/blankie.rest/sounds/859607/", moods: ["calm", "piano", "soft"], checked: "2026-10-07" },
  { id: "cozy-5", title: "Lofi - keepin the pace", author: "noel.wav", url: "https://freesound.org/people/noel.wav/sounds/680399/", moods: ["lo-fi", "steady", "upbeat"], checked: "2026-10-07" },
] as const;

/** Runs ffmpeg and returns its stderr (where loudnorm and ebur128 print), throwing it on failure. */
function ffmpeg(args: Array<string>) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stderr;
}
const seconds = (path: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" }).trim());

mkdirSync(OUT, { recursive: true });
const library = [];
for (const t of TRACKS) {
  const src = join(SOURCE, `${t.id}.mp3`);
  const out = join(OUT, `${t.id}.m4a`);
  const length = seconds(src);
  const trimmed = length > MAX_SECONDS + 5;
  const trim = trimmed ? `atrim=0:${MAX_SECONDS},afade=t=out:st=${MAX_SECONDS - 3}:d=3,` : "";
  // Pass 1: measure; pass 2: normalise linearly with the measured values.
  const pass1 = ffmpeg(["-i", src, "-af", `${trim}loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"]);
  const m = JSON.parse(pass1.slice(pass1.lastIndexOf("{"), pass1.lastIndexOf("}") + 1)) as Record<string, string>;
  const norm = `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  ffmpeg(["-y", "-v", "error", "-i", src, "-af", `${trim}${norm},aresample=44100`, "-map_metadata", "-1", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out]);
  // Measure what ships.
  const ebur = ffmpeg(["-i", out, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(ebur.slice(ebur.lastIndexOf("Summary")))?.[1]);
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"], { maxBuffer: 1 << 28 });
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
  const beats = beatsFromSamples(samples);
  const measured = beats.bpm ?? undefined;
  // The title's tempo wins when it has one; else the measured one, folded into 60–140.
  let bpm = "bpm" in t ? t.bpm : measured;
  if (bpm !== undefined) {
    while (bpm > 140) bpm /= 2;
    while (bpm < 60) bpm *= 2;
  }
  const entry = {
    id: t.id,
    file: `${t.id}.m4a`,
    title: t.title,
    moods: t.moods,
    bpm: bpm === undefined ? null : Math.round(bpm),
    seconds: Math.round(seconds(out) * 1000) / 1000,
    lufs: Math.round(lufs * 10) / 10,
    bytes: statSync(out).size,
    ...(trimmed ? { trimmed: `First ${MAX_SECONDS} s of ${Math.round(length)} s, faded out over the last 3 s` } : {}),
    author: t.author,
    source: t.url,
    license: "CC0-1.0",
    licenseChecked: t.checked,
  };
  console.log(`${t.id}: ${entry.seconds} s, ${entry.lufs} LUFS, ${entry.bpm} bpm (measured ${measured?.toFixed(1)}, confidence ${beats.confidence}), ${(entry.bytes / 1024).toFixed(0)} KB`);
  library.push(entry);
}
const doc = {
  description: "Uncut's bundled music (D91): CC0 1.0 (public domain) tracks from Freesound, each licence checked on its page. Normalised to -16 LUFS, AAC 128 kbps. Made by scripts/make-music.ts.",
  tracks: library,
};
writeFileSync(join(OUT, "library.json"), `${JSON.stringify(doc, null, 2)}\n`);
