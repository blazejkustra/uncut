// Makes the bundled CC0 sound-effects pack (D134, D208, D250):
//   node scripts/make-sfx.ts [source dir]
//   node scripts/make-sfx.ts --only-synth   (remake only Uncut's own sounds; the rest kept as they are)
// Three sources, all CC0 1.0, each licence checked again on every run:
// - Freesound: the sound's own page must link the CC0 deed (else the run stops); its preview
//   (cdn.freesound.org, no key needed) is the source file. With a source dir, <freesound id>.mp3
//   is read from it instead (the page is still checked).
// - Kenney (kenney.nl): the pack's zip, whose License.txt must say "Creative Commons Zero"; the
//   file inside the pack is the source.
// - Uncut's own synthesiser (scripts/sfx-synth.ts, D250): sounds made from oscillators and seeded
//   noise, no recording or sample in them, released by Uncut as CC0. The meme sound-alikes live
//   here: original sounds tagged with the names people search for, never the clips themselves.
// Each sound is trimmed when long (with a fade out), levelled (integrated loudness to TARGET_LUFS,
// never louder than CEILING_DB sample peak), encoded AAC into assets/sfx/<id>.m4a, and described in
// assets/sfx/library.json (title, category, tags, length, 48 waveform peaks, author, provider,
// source page, licence and how it was checked).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { RATE, SYNTH_SOUNDS, type SynthOut, type SynthSound } from "./sfx-synth.ts";

const OUT = resolve("assets/sfx");
/** Loudness each sound is brought to (EBU R128 integrated, measured with 0.5 s of silence around it). */
const TARGET_LUFS = -20;
/** The highest sample peak allowed after levelling. */
const CEILING_DB = -1;
/** Anything longer is cut here with a 1 s fade (a sound's own `max` can be shorter). */
const LONGEST = 6;
const BITRATE = "112k";
const CHECKED = "2026-10-14";

type Category = "whoosh" | "transition" | "swipe" | "ui" | "pop" | "impact" | "riser" | "notification" | "success" | "glitch" | "typing" | "crowd" | "meme";
interface Freesound {
  readonly id: string;
  readonly title: string;
  readonly category: Category;
  readonly tags: ReadonlyArray<string>;
  readonly author: string;
  readonly page: string;
  readonly max?: number;
}
interface Kenney extends Omit<Freesound, "page" | "author"> {
  readonly pack: "interface-sounds" | "ui-audio" | "digital-audio" | "impact-sounds" | "sci-fi-sounds";
  readonly file: string;
}
type Sound = Freesound | Kenney | SynthSound;
const SYNTH_SOURCE = "https://github.com/blazejkustra/uncut/blob/main/scripts/sfx-synth.ts";

/** Mono or stereo float samples as a 32-bit float WAV file. */
function writeWav(path: string, out: SynthOut) {
  const chs = Array.isArray(out) ? [out[0], out[1]] : [out as Float32Array];
  const frames = Math.min(...chs.map((c) => c.length));
  const samples = new Float32Array(frames * chs.length);
  for (let i = 0; i < frames; i++) for (let c = 0; c < chs.length; c++) samples[i * chs.length + c] = chs[c]![i]!;
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(3, 20); // IEEE float
  head.writeUInt16LE(chs.length, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 4 * chs.length, 28);
  head.writeUInt16LE(4 * chs.length, 32);
  head.writeUInt16LE(32, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([head, data]));
}
const fs = (id: string, title: string, category: Category, author: string, page: string, tags: Array<string>, max?: number): Freesound => ({
  id,
  title,
  category,
  author,
  page,
  tags,
  ...(max ? { max } : {}),
});
const kenney = (id: string, title: string, category: Category, pack: Kenney["pack"], file: string, tags: Array<string>, max?: number): Kenney => ({
  id,
  title,
  category,
  pack,
  file,
  tags,
  ...(max ? { max } : {}),
});
const page = (user: string, n: number) => `https://freesound.org/people/${user}/sounds/${n}/`;

const SOUNDS: ReadonlyArray<Sound> = [
  // The D134 pack (ids kept: projects and the agent name them).
  fs("whoosh-deep", "Deep whoosh", "whoosh", "Kinoton", page("Kinoton", 351256), ["whoosh", "swoosh", "deep", "air"]),
  fs("whoosh-short", "Short whoosh", "transition", "LloydEvans09", page("LloydEvans09", 332003), ["whoosh", "swoosh", "short", "transition"]),
  fs("ui-click", "UI click", "ui", "Ranner", page("Ranner", 488534), ["click", "tap", "button", "interface"]),
  fs("pop", "Pop", "pop", "DuffyBro", page("DuffyBro", 319107), ["pop", "bubble", "appear"]),
  fs("impact-boom", "Boom impact", "impact", "XHALE303", page("XHALE303", 535592), ["boom", "impact", "hit", "cinematic"]),
  fs("riser", "Riser", "riser", "Rizzard", page("Rizzard", 561207), ["riser", "build", "tension", "uplifter"]),
  fs("notification", "Notification", "notification", "yfjesse", page("yfjesse", 235911), ["notification", "alert", "message"]),
  fs("ding", "Ding", "notification", "D.S.G.", page("D.S.G.", 241288), ["ding", "bell", "correct"]),
  fs("applause", "Applause", "crowd", "Sandermotions", page("Sandermotions", 277021), ["applause", "clapping", "crowd", "cheer"]),
  fs("crowd-laugh", "Small crowd laughing", "crowd", "snakebarney", page("snakebarney", 138112), ["laugh", "laughter", "crowd", "audience"]),
  fs("bruh", "Bruh", "meme", "Autellaem", page("Autellaem", 534387), ["bruh", "voice", "reaction"]),
  fs("airhorn", "DJ airhorn", "meme", "neopolitansixth", page("neopolitansixth", 547020), ["airhorn", "air horn", "hype"]),
  fs("record-scratch", "Record scratch", "meme", "musicvision31", page("musicvision31", 431773), ["record scratch", "scratch", "vinyl", "stop"]),
  fs("sad-trombone", "Sad trombone", "meme", "kirbydx", page("kirbydx", 175409), ["sad trombone", "wah wah", "fail", "trombone"]),
  fs("crickets", "Crickets", "meme", "FreethinkerAnon", page("FreethinkerAnon", 129678), ["crickets", "silence", "awkward"], 6),
  fs("glitch", "Glitch", "glitch", "JacksonMiller0", page("JacksonMiller0", 237607), ["glitch", "digital", "error", "transition"]),

  // D208: the designed pack for product videos.
  // UI
  kenney("click-soft", "Soft click", "ui", "ui-audio", "click3.ogg", ["click", "tap", "soft", "button"]),
  kenney("tap", "Tap", "ui", "interface-sounds", "click_001.ogg", ["tap", "click", "touch", "button"]),
  kenney("mouse-click", "Mouse click", "ui", "ui-audio", "mouseclick1.ogg", ["mouse", "click", "cursor"]),
  kenney("select", "Select", "ui", "interface-sounds", "select_003.ogg", ["select", "choose", "click", "interface"]),
  kenney("toggle-on", "Toggle on", "ui", "interface-sounds", "toggle_001.ogg", ["toggle", "switch", "on", "enable"]),
  kenney("toggle-off", "Toggle off", "ui", "interface-sounds", "toggle_002.ogg", ["toggle", "switch", "off", "disable"]),
  kenney("switch", "Switch", "ui", "ui-audio", "switch7.ogg", ["switch", "toggle", "click"]),
  kenney("hover", "Hover blip", "ui", "ui-audio", "rollover1.ogg", ["hover", "blip", "rollover", "cursor"]),
  kenney("open", "Open", "ui", "interface-sounds", "open_001.ogg", ["open", "menu", "panel", "appear"]),
  fs("camera-shutter", "Camera shutter", "ui", "Kodack", page("Kodack", 271010), ["camera", "shutter", "screenshot", "photo", "snap"]),
  // Pops
  fs("pop-bright", "Bright pop", "pop", "D.S.G.", page("D.S.G.", 244656), ["pop", "appear", "bubble"]),
  fs("pop-cork", "Cork pop", "pop", "deraj", page("deraj", 202230), ["pop", "cork", "open"]),
  kenney("drop", "Drop", "pop", "interface-sounds", "drop_002.ogg", ["drop", "plop", "pop", "place"]),
  kenney("pluck", "Pluck", "pop", "interface-sounds", "pluck_001.ogg", ["pluck", "pop", "blip"]),
  // Swipes
  fs("swipe-app", "App swipe", "swipe", "LilMati", page("LilMati", 702773), ["swipe", "flick", "slide", "app", "mobile"]),
  fs("swipe-paper", "Paper swipe", "swipe", "Frank1100", page("Frank1100", 147285), ["swipe", "paper", "slide", "wipe"]),
  fs("swipe-fast", "Fast swipe", "swipe", "ParadoxTheSock", page("ParadoxTheSock", 412595), ["swipe", "swoop", "fast", "whoosh"]),
  kenney("expand", "Expand", "swipe", "interface-sounds", "maximize_006.ogg", ["expand", "maximize", "zoom in", "grow"]),
  // Whooshes and transitions
  fs("whoosh-little", "Little whoosh", "whoosh", "ch_ase", page("ch_ase", 423798), ["whoosh", "swish", "fly by"]),
  fs("whoosh-whip", "Whip zoom whoosh", "whoosh", "BennettFilmTeacher", page("BennettFilmTeacher", 486234), ["whoosh", "whip", "zoom", "pan"]),
  fs("whoosh-mid", "Mid whoosh", "whoosh", "DJT4NN3R", page("DJT4NN3R", 449996), ["whoosh", "air", "pass by"]),
  fs("swoosh-quick", "Quick swoosh", "transition", "lesaucisson", page("lesaucisson", 585257), ["swoosh", "whoosh", "quick", "transition"]),
  fs("swoosh-soft", "Soft swoosh", "transition", "D4XX", page("D4XX", 607251), ["swoosh", "soft", "transition"]),
  fs("swoosh-tiny", "Tiny swoosh", "transition", "D4XX", page("D4XX", 658859), ["swoosh", "tiny", "short", "transition"]),
  fs("sweep-fade", "Fading sweep", "transition", "Raclure", page("Raclure", 405553), ["sweep", "fade", "away", "transition"]),
  // Risers
  fs("riser-short", "Short riser", "riser", "syntheffects", page("syntheffects", 685256), ["riser", "build", "noise", "uplifter"]),
  fs("riser-hit", "Riser into hit", "riser", "AudioPapkin", page("AudioPapkin", 511856), ["riser", "hit", "build", "cinematic"]),
  kenney("synth-rise", "Synth rise", "riser", "digital-audio", "phaserUp3.ogg", ["riser", "synth", "rise", "up"]),
  // Impacts
  fs("impact-cinematic", "Cinematic impact", "impact", "AudioPapkin", page("AudioPapkin", 757898), ["impact", "hit", "cinematic", "boom"]),
  fs("impact-blunt", "Blunt impact", "impact", "AudioPapkin", page("AudioPapkin", 823236), ["impact", "hit", "blunt"]),
  fs("thud", "Thud", "impact", "Ambiabstract", page("Ambiabstract", 584731), ["thud", "hit", "low"]),
  kenney("hit-soft", "Soft hit", "impact", "impact-sounds", "impactSoft_heavy_001.ogg", ["hit", "soft", "impact", "thump"]),
  kenney("punch", "Punch", "impact", "impact-sounds", "impactPunch_heavy_000.ogg", ["punch", "hit", "impact"]),
  kenney("low-boom", "Low boom", "impact", "sci-fi-sounds", "lowFrequency_explosion_000.ogg", ["boom", "low", "explosion", "sub"]),
  // Notifications
  fs("chime", "Chime", "notification", "Jofae", page("Jofae", 380482), ["chime", "notification", "alert"]),
  fs("phone-notification", "Phone notification", "notification", "qubodup", page("qubodup", 782969), ["notification", "phone", "message", "alert"]),
  fs("computer-chimes", "Computer chimes", "notification", "marlonnnnnn", page("marlonnnnnn", 351879), ["chime", "computer", "startup", "notification"]),
  kenney("glass-ping", "Glass ping", "notification", "interface-sounds", "glass_002.ogg", ["ping", "glass", "notification", "ding"]),
  kenney("bong", "Bong", "notification", "interface-sounds", "bong_001.ogg", ["bong", "notification", "alert"]),
  kenney("error", "Error", "notification", "interface-sounds", "error_004.ogg", ["error", "wrong", "denied", "fail"]),
  // Success
  fs("success-glock", "Glockenspiel success", "success", "FunWithSound", page("FunWithSound", 456965), ["success", "win", "glockenspiel", "achievement"]),
  fs("success-power-up", "Power up", "success", "GabrielAraujo", page("GabrielAraujo", 242501), ["power up", "success", "collect", "level up"]),
  fs("success-chord", "Success chord", "success", "oysterqueen", page("oysterqueen", 582988), ["success", "chord", "positive", "done"]),
  kenney("confirm", "Confirm", "success", "interface-sounds", "confirmation_001.ogg", ["confirm", "success", "ok", "done"]),
  fs("sparkle", "Sparkle", "success", "Mr._Fritz_", page("Mr._Fritz_", 545238), ["sparkle", "shine", "magic", "twinkle"]),
  fs("magic-sparkle", "Magic sparkle", "success", "MLaudio", page("MLaudio", 511485), ["sparkle", "magic", "wink", "shimmer"]),
  // Glitch
  fs("glitch-digital", "Digital glitch", "glitch", "LookIMadeAThing", page("LookIMadeAThing", 341286), ["glitch", "digital", "noise", "stutter"]),
  fs("glitch-electric", "Electric glitch", "glitch", "Flying_Deer_Fx", page("Flying_Deer_Fx", 369145), ["glitch", "electric", "transmission", "interference"]),
  fs("glitch-noise", "Glitch noise", "glitch", "AmicaSys", page("AmicaSys", 332711), ["glitch", "noise", "static", "distortion"]),
  // Typing
  fs("typing-mechanical", "Mechanical typing", "typing", "BetaFruit", page("BetaFruit", 690655), ["typing", "keyboard", "mechanical", "keys"]),
  fs("typing-fast", "Fast typing", "typing", "Capt.Jack", page("Capt.Jack", 813214), ["typing", "keyboard", "fast", "keys"]),
  fs("typing-keyboard", "Keyboard typing", "typing", "praxis_bard", page("praxis_bard", 380066), ["typing", "keyboard", "computer", "keys"], 3),
  // Meme sound-alikes (only when asked, D207): free recordings, never the copyrighted clips.
  fs("frustrated-yell", "Frustrated yell", "meme", "myfreesoundaccount1998", page("myfreesoundaccount1998", 543252), [
    "yell",
    "shout",
    "frustrated",
    "fail",
    "fahh",
  ]),
  fs("oof", "Oof", "meme", "unfa", page("unfa", 719053), ["oof", "ouch", "pain", "voice"]),
  fs("wow", "Wow", "meme", "ahab2000", page("ahab2000", 398933), ["wow", "voice", "reaction", "amazed"]),
  fs("rimshot", "Rimshot", "meme", "Sajmund", page("Sajmund", 132418), ["rimshot", "ba dum tss", "joke", "drum"]),
  fs("drum-roll", "Drum roll", "meme", "owowowwo", page("owowowwo", 197763), ["drum roll", "drumroll", "reveal", "suspense"]),
  fs("boing", "Boing", "meme", "magnuswaker", page("magnuswaker", 540790), ["boing", "cartoon", "bounce", "spring"]),
  fs("bass-drop", "Bass drop", "meme", "qubodup", page("qubodup", 212768), ["bass drop", "drop", "bass", "wub"], 4),

  // D250: Uncut's own synthesised sounds (scripts/sfx-synth.ts).
  ...SYNTH_SOUNDS,
];

const KENNEY_PAGES: Readonly<Record<Kenney["pack"], string>> = {
  "interface-sounds": "https://kenney.nl/assets/interface-sounds",
  "ui-audio": "https://kenney.nl/assets/ui-audio",
  "digital-audio": "https://kenney.nl/assets/digital-audio",
  "impact-sounds": "https://kenney.nl/assets/impact-sounds",
  "sci-fi-sounds": "https://kenney.nl/assets/sci-fi-sounds",
};

function ffmpeg(args: Array<string>) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stderr;
}
const seconds = (path: string) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" }).trim());
const freesoundId = (url: string) => /\/sounds\/(\d+)\/?$/.exec(url)![1]!;
const get = async (url: string) => {
  const res = await fetch(url, { headers: { "User-Agent": "Uncut make-sfx (https://github.com/blazejkustra/uncut)" } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res;
};

/** The sound's Freesound page links the CC0 1.0 deed as its licence; its hq preview URL. */
async function checkFreesound(s: Freesound): Promise<string> {
  const html = await (await get(s.page)).text();
  const licence =
    /href="https?:\/\/creativecommons\.org\/([^"]+)"[^>]*title="Go to the full license text"|title="Go to the full license text" href="https?:\/\/creativecommons\.org\/([^"]+)"/.exec(
      html,
    );
  const deed = licence?.[1] ?? licence?.[2];
  if (deed !== "publicdomain/zero/1.0/") throw new Error(`${s.id}: ${s.page} isn't CC0 (${deed ?? "no licence found"})`);
  const preview = new RegExp(`https://cdn\\.freesound\\.org/previews/\\d+/${freesoundId(s.page)}_\\d+-hq\\.mp3`).exec(html)?.[0];
  if (!preview) throw new Error(`${s.id}: no preview on ${s.page}`);
  return preview;
}

/** A Kenney pack unpacked into `dir`, its License.txt saying CC0. */
const packs = new Map<string, string>();
async function kenneyPack(pack: Kenney["pack"], dir: string): Promise<string> {
  const known = packs.get(pack);
  if (known) return known;
  const target = join(dir, pack);
  if (!existsSync(join(target, "License.txt"))) {
    const html = await (await get(KENNEY_PAGES[pack])).text();
    const zip = new RegExp(`https://kenney\\.nl/media/pages/assets/${pack}/[^'"]+\\.zip`).exec(html)?.[0];
    if (!zip) throw new Error(`${pack}: no download on ${KENNEY_PAGES[pack]}`);
    mkdirSync(target, { recursive: true });
    const file = join(dir, `${pack}.zip`);
    writeFileSync(file, Buffer.from(await (await get(zip)).arrayBuffer()));
    execFileSync("unzip", ["-oq", file, "-d", target]);
  }
  const licence = readFileSync(join(target, "License.txt"), "utf8");
  if (!/Creative Commons Zero, CC0/.test(licence) || !/publicdomain\/zero\/1\.0/.test(licence)) throw new Error(`${pack}: License.txt isn't CC0`);
  packs.set(pack, target);
  return target;
}

/** EBU R128 integrated loudness (LUFS), measured with 0.5 s of silence on each side (short sounds need a 400 ms window). */
function loudness(src: string, trim: string) {
  const log = ffmpeg(["-i", src, "-af", `${trim}aresample=48000,adelay=500|500,apad=pad_dur=0.5,ebur128`, "-f", "null", "-"]);
  const i = /I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/.exec(log.slice(log.lastIndexOf("Summary")));
  return i ? Number(i[1]) : -70;
}

/** 48 peaks (0–100) of the encoded file, for the list's waveform before it's played. */
function peaksOf(path: string): Array<number> {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-ac", "1", "-ar", "8000", "-f", "f32le", "-"], { maxBuffer: 1 << 26 });
  const data = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  const bins = 48;
  const size = Math.max(1, Math.floor(data.length / bins));
  const out: Array<number> = [];
  for (let b = 0; b < bins; b++) {
    let max = 0;
    for (let i = b * size; i < Math.min(data.length, (b + 1) * size); i++) max = Math.max(max, Math.abs(data[i]!));
    out.push(max);
  }
  const top = Math.max(...out, 1e-6);
  return out.map((v) => Math.round((v / top) * 100));
}

const onlySynth = process.argv.includes("--only-synth");
const given = process.argv.slice(2).find((a) => !a.startsWith("--"));
const kept = onlySynth
  ? new Map((JSON.parse(readFileSync(join(OUT, "library.json"), "utf8")) as { sounds: Array<{ id: string; file: string }> }).sounds.map((x) => [x.id, x]))
  : new Map<string, { id: string; file: string }>();
const temp = mkdtempSync(join(tmpdir(), "uncut-sfx-"));
mkdirSync(OUT, { recursive: true });
if (new Set(SOUNDS.map((s) => s.id)).size !== SOUNDS.length) throw new Error("duplicate ids");
const sounds = [];
try {
  for (const s of SOUNDS) {
    let src: string;
    let meta: { author: string; provider: "freesound" | "kenney" | "uncut"; source: string; sourceFile?: string; licenseProof: string };
    if (onlySynth && !("make" in s)) {
      const before = kept.get(s.id);
      if (!before) throw new Error(`${s.id}: not in library.json yet; run without --only-synth`);
      sounds.push(before);
      continue;
    }
    if ("make" in s) {
      src = join(temp, `${s.id}.wav`);
      writeWav(src, s.make());
      meta = {
        author: "Uncut",
        provider: "uncut",
        source: SYNTH_SOURCE,
        licenseProof:
          "Synthesised by scripts/sfx-synth.ts from oscillators and seeded noise (no recording or sample in it); made by Uncut and released as CC0 1.0",
      };
    } else if ("page" in s) {
      const preview = await checkFreesound(s);
      src = given ? join(given, `${freesoundId(s.page)}.mp3`) : join(temp, `${freesoundId(s.page)}.mp3`);
      if (!given) writeFileSync(src, Buffer.from(await (await get(preview)).arrayBuffer()));
      meta = {
        author: s.author,
        provider: "freesound",
        source: s.page,
        licenseProof: "The sound's Freesound page links the CC0 1.0 deed (Creative Commons 0)",
      };
    } else {
      const dir = await kenneyPack(s.pack, given ?? temp);
      src = join(dir, "Audio", s.file);
      meta = {
        author: "Kenney",
        provider: "kenney",
        source: KENNEY_PAGES[s.pack],
        sourceFile: `Audio/${s.file}`,
        licenseProof: "The pack's License.txt: Creative Commons Zero, CC0 (creativecommons.org/publicdomain/zero/1.0)",
      };
    }
    const length = seconds(src);
    if (!(length >= 0.05)) throw new Error(`${s.id}: ${length} s is too short to use`);
    const max = Math.min(("max" in s ? s.max : undefined) ?? LONGEST, LONGEST);
    const trimmed = length > max + 0.5;
    const trim = trimmed ? `atrim=0:${max},afade=t=out:st=${max - 1}:d=1,` : "";
    const peak = Number(/max_volume: (-?[\d.]+) dB/.exec(ffmpeg(["-i", src, "-af", `${trim}volumedetect`, "-f", "null", "-"]))![1]);
    const lufs = loudness(src, trim);
    const gain = Math.min(CEILING_DB - peak, TARGET_LUFS - lufs);
    const out = join(OUT, `${s.id}.m4a`);
    ffmpeg([
      "-y",
      "-v",
      "error",
      "-i",
      src,
      "-af",
      `${trim}volume=${gain.toFixed(2)}dB,aresample=44100`,
      "-map_metadata",
      "-1",
      "-c:a",
      "aac",
      "-b:a",
      BITRATE,
      "-movflags",
      "+faststart",
      out,
    ]);
    sounds.push({
      id: s.id,
      file: `${s.id}.m4a`,
      title: s.title,
      category: s.category,
      tags: s.tags,
      seconds: Math.round(seconds(out) * 100) / 100,
      bytes: statSync(out).size,
      ...(trimmed ? { trimmed: `First ${max} s of ${length.toFixed(1)} s, faded out over the last 1 s` } : {}),
      lufs: Math.round((lufs + gain) * 10) / 10,
      peakDb: Math.round((peak + gain) * 10) / 10,
      peaks: peaksOf(out),
      ...meta,
      license: "CC0-1.0",
      licenseChecked: "make" in s ? "2026-10-16" : CHECKED,
    });
    console.log(`${s.id}: ${length.toFixed(2)} s, ${lufs.toFixed(1)} LUFS / peak ${peak} dB, gain ${gain.toFixed(1)} dB`);
    if (!given && "page" in s) await new Promise((r) => setTimeout(r, 400));
  }
} finally {
  // rm -rf: unzipped packs can trip rmSync with ENOTEMPTY on macOS.
  spawnSync("rm", ["-rf", temp]);
}
writeFileSync(
  join(OUT, "library.json"),
  `${JSON.stringify(
    {
      description: `Uncut's bundled sound effects (D134, D208, D250): CC0 1.0 (public domain) sounds from Freesound and Kenney, each licence checked when the pack is made (the Freesound page's licence link, the Kenney pack's License.txt), and Uncut's own synthesised sounds (scripts/sfx-synth.ts). Levelled to ${TARGET_LUFS} LUFS integrated, sample peak at most ${CEILING_DB} dBFS, AAC ${BITRATE}. Made by scripts/make-sfx.ts.`,
      sounds,
    },
    null,
    2,
  )}\n`,
);
// Files of sounds no longer in the pack go.
for (const f of readdirSync(OUT)) if (f.endsWith(".m4a") && !sounds.some((s) => s.file === f)) rmSync(join(OUT, f));
