// Makes the bundled CC0 sound-effects pack (D134):
//   node scripts/make-sfx.ts [source dir]
// With a source dir it reads <freesound id>.mp3 from it; without one it downloads each sound's
// Freesound preview (cdn.freesound.org, no key needed) into a temporary folder. The licence of
// every sound below was checked on its Freesound page (CC0 1.0) on the date in `checked`.
// Each one is trimmed when long (with a fade out), peak-normalised to −3 dBFS, encoded AAC 128 kbps
// into assets/sfx/<id>.m4a, and described in assets/sfx/library.json (title, category, length,
// author, source URL, licence).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OUT = resolve("assets/sfx");
const PEAK_DB = -3;

// id, title, category (core SFX_CATEGORIES), author (as on the page), Freesound page, preview URL, longest kept (s).
const SOUNDS = [
  { id: "whoosh-deep", title: "Deep whoosh", category: "whoosh", author: "Kinoton", page: "https://freesound.org/people/Kinoton/sounds/351256/", preview: "https://cdn.freesound.org/previews/351/351256_2247456-hq.mp3" },
  { id: "whoosh-short", title: "Short whoosh", category: "transition", author: "LloydEvans09", page: "https://freesound.org/people/LloydEvans09/sounds/332003/", preview: "https://cdn.freesound.org/previews/332/332003_2567799-hq.mp3" },
  { id: "ui-click", title: "UI click", category: "ui", author: "Ranner", page: "https://freesound.org/people/Ranner/sounds/488534/", preview: "https://cdn.freesound.org/previews/488/488534_5382295-hq.mp3" },
  { id: "pop", title: "Pop", category: "ui", author: "DuffyBro", page: "https://freesound.org/people/DuffyBro/sounds/319107/", preview: "https://cdn.freesound.org/previews/319/319107_5422458-hq.mp3" },
  { id: "impact-boom", title: "Boom impact", category: "impact", author: "XHALE303", page: "https://freesound.org/people/XHALE303/sounds/535592/", preview: "https://cdn.freesound.org/previews/535/535592_9015615-hq.mp3" },
  { id: "bass-boom", title: "Bass boom", category: "meme", author: "LordHannes", page: "https://freesound.org/people/LordHannes/sounds/268084/", preview: "https://cdn.freesound.org/previews/268/268084_3812550-hq.mp3", max: 4 },
  { id: "riser", title: "Riser", category: "riser", author: "Rizzard", page: "https://freesound.org/people/Rizzard/sounds/561207/", preview: "https://cdn.freesound.org/previews/561/561207_10825267-hq.mp3" },
  { id: "notification", title: "Notification", category: "notification", author: "yfjesse", page: "https://freesound.org/people/yfjesse/sounds/235911/", preview: "https://cdn.freesound.org/previews/235/235911_2391840-hq.mp3" },
  { id: "ding", title: "Ding", category: "notification", author: "D.S.G.", page: "https://freesound.org/people/greenvwbeetle/sounds/241288/", preview: "https://cdn.freesound.org/previews/241/241288_3624044-hq.mp3" },
  { id: "applause", title: "Applause", category: "crowd", author: "Sandermotions", page: "https://freesound.org/people/Sandermotions/sounds/277021/", preview: "https://cdn.freesound.org/previews/277/277021_1402315-hq.mp3" },
  { id: "crowd-laugh", title: "Small crowd laughing", category: "crowd", author: "snakebarney", page: "https://freesound.org/people/snakebarney/sounds/138112/", preview: "https://cdn.freesound.org/previews/138/138112_1572282-hq.mp3" },
  { id: "bruh", title: "Bruh", category: "meme", author: "Autellaem", page: "https://freesound.org/people/Autellaem/sounds/534387/", preview: "https://cdn.freesound.org/previews/534/534387_11868930-hq.mp3" },
  { id: "airhorn", title: "DJ airhorn", category: "meme", author: "neopolitansixth", page: "https://freesound.org/people/neopolitansixth/sounds/547020/", preview: "https://cdn.freesound.org/previews/547/547020_7295304-hq.mp3" },
  { id: "record-scratch", title: "Record scratch", category: "meme", author: "musicvision31", page: "https://freesound.org/people/musicvision31/sounds/431773/", preview: "https://cdn.freesound.org/previews/431/431773_817038-hq.mp3" },
  { id: "sad-trombone", title: "Sad trombone", category: "meme", author: "kirbydx", page: "https://freesound.org/people/kirbydx/sounds/175409/", preview: "https://cdn.freesound.org/previews/175/175409_1326576-hq.mp3" },
  { id: "crickets", title: "Crickets", category: "meme", author: "FreethinkerAnon", page: "https://freesound.org/people/FreethinkerAnon/sounds/129678/", preview: "https://cdn.freesound.org/previews/129/129678_2362707-hq.mp3", max: 6 },
  { id: "glitch", title: "Glitch", category: "transition", author: "JacksonMiller0", page: "https://freesound.org/people/JacksonMiller0/sounds/237607/", preview: "https://cdn.freesound.org/previews/237/237607_3717478-hq.mp3" },
] as const;
const CHECKED = "2026-10-14";

function ffmpeg(args: Array<string>) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stderr;
}
const seconds = (path: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" }).trim());
const freesoundId = (page: string) => /\/sounds\/(\d+)\/?$/.exec(page)![1]!;

const given = process.argv[2];
const temp = given ? undefined : mkdtempSync(join(tmpdir(), "uncut-sfx-"));
const source = given ?? temp!;
mkdirSync(OUT, { recursive: true });
const sounds = [];
try {
  for (const s of SOUNDS) {
    const src = join(source, `${freesoundId(s.page)}.mp3`);
    if (!given) {
      const res = await fetch(s.preview, { headers: { "User-Agent": "Uncut make-sfx" } });
      if (!res.ok) throw new Error(`${s.preview}: ${res.status}`);
      writeFileSync(src, Buffer.from(await res.arrayBuffer()));
    }
    const length = seconds(src);
    const max = "max" in s ? s.max : undefined;
    const trimmed = max !== undefined && length > max + 0.5;
    const trim = trimmed ? `atrim=0:${max},afade=t=out:st=${max - 1}:d=1,` : "";
    const peak = Number(/max_volume: (-?[\d.]+) dB/.exec(ffmpeg(["-i", src, "-af", `${trim}volumedetect`, "-f", "null", "-"]))![1]);
    const out = join(OUT, `${s.id}.m4a`);
    ffmpeg(["-y", "-v", "error", "-i", src, "-af", `${trim}volume=${(PEAK_DB - peak).toFixed(2)}dB,aresample=44100`, "-map_metadata", "-1", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out]);
    sounds.push({
      id: s.id,
      file: `${s.id}.m4a`,
      title: s.title,
      category: s.category,
      seconds: Math.round(seconds(out) * 100) / 100,
      bytes: statSync(out).size,
      ...(trimmed ? { trimmed: `First ${max} s of ${length.toFixed(1)} s, faded out over the last 1 s` } : {}),
      author: s.author,
      source: s.page,
      license: "CC0-1.0",
      licenseChecked: CHECKED,
    });
    console.log(`${s.id}: ${length.toFixed(2)} s → ${sounds.at(-1)!.seconds} s, peak ${peak} dB → ${PEAK_DB} dB`);
  }
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true });
}
writeFileSync(
  join(OUT, "library.json"),
  `${JSON.stringify({ description: "Uncut's bundled sound effects (D134): CC0 1.0 (public domain) sounds from Freesound, each licence checked on its page. Peak-normalised to -3 dBFS, AAC 128 kbps. Made by scripts/make-sfx.ts.", sounds }, null, 2)}\n`,
);
