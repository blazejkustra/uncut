// The Phase 5 exit check's footage (test/app/phase5-exit.test.ts, scripts/phase5-manual-check.ts), made
// on this Mac with macOS `say` and ffmpeg, never taken from ~/Documents/devrel/drone:
// - Talk.mp4: about a minute of real speech (13 sentences, an "um" and an "uh") over SMPTE bars,
//   built from known pieces: each `say` clip trimmed of its own leading and trailing quiet, then
//   joined with silences of known length (short ones that stay, long ones ≥ 1 s to cut). The layout
//   (every piece's start and end in seconds) is returned, so a test knows where every word is.
// - Smooth.mp4, Jittered.mp4, Blurred.mp4: 6 s "drone takes" of the same pan over a still, as in
//   test/analysis/video-analysis.test.ts: steady; with a few pixels of per-frame shake; steady but blurred.
// talkTranscript() turns the layout into the transcript whisper would give (each sentence's words
// spread over its spoken span by length), for the analysis cache.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const FPS = 30;
/** How fast `say` speaks (words per minute). */
const RATE = 140;
/** A pinned voice (Samantha, en_US, on every Mac by default), so where words and pauses fall doesn't
 * depend on this Mac's chosen voice; the system voice if it's missing. */
const VOICE = (() => {
  try {
    return /^Samantha\s/m.test(execFileSync("say", ["-v", "?"], { encoding: "utf8" })) ? ["-v", "Samantha"] : [];
  } catch {
    return [];
  }
})();

/** A piece of the talk: a sentence or a filler (spoken), or a silence. */
export type Piece = { readonly kind: "sentence" | "filler"; readonly text: string } | { readonly kind: "silence"; readonly seconds: number };

/** The sentence the scripted agent cuts out (by its words, found in transcript_read). */
export const CUT_SENTENCE = "I almost deleted that take before I noticed the problem.";

export const TALK: ReadonlyArray<Piece> = [
  { kind: "silence", seconds: 0.3 },
  { kind: "sentence", text: "Welcome back to the channel and thanks for watching this drone review." },
  { kind: "silence", seconds: 0.15 },
  { kind: "filler", text: "um" },
  { kind: "silence", seconds: 0.15 },
  { kind: "sentence", text: "Today we are looking at three takes of the same harbour shot from Croatia." },
  { kind: "silence", seconds: 1.5 },
  { kind: "sentence", text: "The first take was flown on a calm morning with the gimbal locked." },
  { kind: "silence", seconds: 0.2 },
  { kind: "sentence", text: "The second take was flown in strong wind and the picture shakes a lot." },
  { kind: "silence", seconds: 1.2 },
  { kind: "sentence", text: "The third take is soft because the lens was covered in salt spray." },
  { kind: "silence", seconds: 0.2 },
  { kind: "filler", text: "uh" },
  { kind: "silence", seconds: 0.2 },
  { kind: "sentence", text: CUT_SENTENCE },
  { kind: "silence", seconds: 2 },
  { kind: "sentence", text: "Stabilisation in software can hide a little shake but it never fixes blur." },
  { kind: "silence", seconds: 0.25 },
  { kind: "sentence", text: "So the rule is simple and it saves a lot of time in the edit." },
  { kind: "silence", seconds: 1 },
  { kind: "sentence", text: "Always pick the cleanest take first and only then think about colour." },
  { kind: "silence", seconds: 0.2 },
  { kind: "sentence", text: "Check the horizon and the corners of the frame before anything else." },
  { kind: "silence", seconds: 0.2 },
  { kind: "sentence", text: "A shaky corner is easy to miss on a phone but obvious on a big screen." },
  { kind: "silence", seconds: 0.2 },
  { kind: "sentence", text: "The wind on the coast changes every few minutes so fly early in the day." },
  { kind: "silence", seconds: 1.3 },
  { kind: "sentence", text: "Next week we will fly the same route at sunset and compare the light." },
  { kind: "silence", seconds: 0.2 },
  { kind: "sentence", text: "Let me know in the comments which take you would pick." },
  { kind: "silence", seconds: 1 },
];

/** Where a piece ended up in Talk.mp4 (seconds). */
export interface Placed {
  readonly kind: Piece["kind"];
  readonly text?: string;
  readonly start: number;
  readonly end: number;
}

export interface Fixture {
  readonly folder: string;
  readonly talk: string;
  readonly takes: { readonly smooth: string; readonly jittered: string; readonly blurred: string };
  /** The talk's pieces where they are, and its length (seconds). */
  readonly layout: ReadonlyArray<Placed>;
  readonly seconds: number;
}

const run = (ffmpeg: string, args: Array<string>) => execFileSync(ffmpeg, ["-v", "error", "-y", ...args]);
const durationOf = (ffprobe: string, file: string) => Number(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());

/**
 * Makes the talk and the three takes in `folder` (created; a `work` folder next to them is used and
 * removed). `ffmpeg` / `ffprobe` are paths or names on PATH.
 */
export function makeFixture(folder: string, { ffmpeg = "ffmpeg", ffprobe = "ffprobe" } = {}): Fixture {
  mkdirSync(folder, { recursive: true });
  const work = join(folder, "..", `work-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    // Every piece as 48 kHz mono PCM: speech trimmed of its quiet ends (say pads each clip a little,
    // which would blur where a word starts), silence of exactly its length.
    const files: Array<string> = [];
    const layout: Array<Placed> = [];
    let at = 0;
    TALK.forEach((piece, i) => {
      const wav = join(work, `p${i}.wav`);
      if (piece.kind === "silence") {
        run(ffmpeg, ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", String(piece.seconds), "-c:a", "pcm_s16le", wav]);
      } else {
        const aiff = join(work, `p${i}.aiff`);
        execFileSync("say", [...VOICE, "-r", String(RATE), "-o", aiff, piece.text]);
        const trim = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02";
        run(ffmpeg, ["-i", aiff, "-af", `${trim},areverse,${trim},areverse,aresample=48000`, "-ac", "1", "-c:a", "pcm_s16le", wav]);
      }
      const seconds = durationOf(ffprobe, wav);
      if (piece.kind !== "silence") layout.push({ kind: piece.kind, text: piece.text, start: at, end: at + seconds });
      else layout.push({ kind: "silence", start: at, end: at + seconds });
      at += seconds;
      files.push(wav);
    });
    // Joined sample-exactly (the concat filter), then over bars as a talk-like mp4.
    const audio = join(work, "talk.wav");
    run(ffmpeg, [...files.flatMap((f) => ["-i", f]), "-filter_complex", `${files.map((_, i) => `[${i}:a]`).join("")}concat=n=${files.length}:v=0:a=1`, "-c:a", "pcm_s16le", audio]);
    const seconds = durationOf(ffprobe, audio);
    const talk = join(folder, "Talk.mp4");
    run(ffmpeg, ["-f", "lavfi", "-i", `smptehdbars=size=640x360:rate=${FPS}`, "-i", audio, "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-b:a", "128k", talk]);

    // The takes: a 6 s pan over a textured still, 640×360 at 30 fps.
    const still = join(work, "still.png");
    run(ffmpeg, ["-f", "lavfi", "-i", "testsrc2=s=1600x900:d=1", "-frames:v", "1", still]);
    const pan = (name: string, x: string, y: string, extra = "") => {
      const out = join(folder, name);
      run(ffmpeg, ["-loop", "1", "-framerate", String(FPS), "-i", still, "-t", "6", "-vf", `crop=640:360:x='${x}':y='${y}'${extra}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", out]);
      return out;
    };
    const takes = {
      smooth: pan("Smooth.mp4", "100+t*60", "80+t*20"),
      jittered: pan("Jittered.mp4", "100+t*60+3*sin(n*2.7)+2*sin(n*5.3)", "80+t*20+2*sin(n*3.1)+2*sin(n*7.7)"),
      blurred: pan("Blurred.mp4", "100+t*60", "80+t*20", ",gblur=sigma=4"),
    };
    return { folder, talk, takes, layout, seconds };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The transcript whisper would make of the talk, in the analysis cache's format (D68). */
export function talkTranscript(fixture: Fixture) {
  const words: Array<{ text: string; start: number; end: number; p: number }> = [];
  const segments: Array<{ start: number; end: number; text: string; words: [number, number] }> = [];
  const r3 = (s: number) => Math.round(s * 1000) / 1000;
  for (const piece of fixture.layout) {
    if (piece.kind === "silence") continue;
    const parts = piece.text!.split(" ");
    // Each word's share of the spoken span by its length (+1 for the gap after it).
    const weights = parts.map((w) => w.length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    const first = words.length;
    let t = piece.start;
    parts.forEach((text, i) => {
      const end = i === parts.length - 1 ? piece.end : t + ((piece.end - piece.start) * weights[i]!) / total;
      words.push({ text, start: r3(t), end: r3(end), p: piece.kind === "filler" ? 0.6 : 0.9 });
      t = end;
    });
    segments.push({ start: r3(piece.start), end: r3(piece.end), text: piece.text!, words: [first, words.length] });
  }
  return { hasAudio: true, seconds: r3(fixture.seconds), language: "en", requestedLanguage: "auto", model: "base", segments, words };
}

/**
 * The talk's frames the cut should remove, worked out from the layout by the rules D69 states (not
 * with core's planner): removed words (the fillers and `sentence`) go from the frame they start in
 * to the frame after they end; silences of at least `minPause` seconds go inward (whole frames
 * inside them); `tail` frames stay after every kept word and `head` frames before one (D74: 0.15 s
 * and 0.06 s at 30 fps); with `measured` (the loudness analysis's speech envelope, as the exit
 * test has it) those margins don't reach into removed words' sound; the clip's edges go entirely;
 * touching cuts are one. Returns the cuts as [from, to) frames of the talk.
 */
export function expectedCuts(fixture: Fixture, { sentence = CUT_SENTENCE, minPause = 0.5, head = 2, tail = 5, measured = true, frames }: { sentence?: string; minPause?: number; head?: number; tail?: number; measured?: boolean; frames: number }) {
  const all = fixture.layout;
  const removed = (p: Placed) => p.kind === "filler" || (p.kind === "sentence" && p.text === sentence);
  const spokenBefore = (i: number) => all.slice(0, i).findLast((p) => p.kind !== "silence");
  const spokenAfter = (i: number) => all.slice(i + 1).find((p) => p.kind !== "silence");
  const keptWord = (p: Placed | undefined) => p !== undefined && !removed(p);
  const cuts: Array<[number, number]> = [];
  for (let i = 0; i < all.length; i++) {
    const p = all[i]!;
    if (p.kind === "silence") {
      if (p.end - p.start < minPause) continue;
      const prev = spokenBefore(i);
      const next = spokenAfter(i);
      const from = prev ? Math.ceil(p.start * FPS - 1e-9) + (keptWord(prev) ? tail : 0) : 0;
      const to = next ? Math.floor(p.end * FPS + 1e-9) - (keptWord(next) ? head : 0) : frames;
      if (to > from) cuts.push([from, to]);
      continue;
    }
    if (!removed(p)) continue;
    // A run of removed words: this piece and the removed ones right after it (silences between).
    let j = i;
    for (let k = i + 1; k < all.length; k++) {
      if (all[k]!.kind === "silence") continue;
      if (!removed(all[k]!)) break;
      j = k;
    }
    const prev = spokenBefore(i);
    const next = spokenAfter(j);
    let from = Math.floor(p.start * FPS + 1e-9);
    let to = Math.ceil(all[j]!.end * FPS - 1e-9);
    if (keptWord(prev)) from = Math.max(from, Math.ceil(prev!.end * FPS - 1e-9) + (measured ? 0 : tail));
    if (keptWord(next)) to = Math.min(to, Math.floor(next!.start * FPS + 1e-9) - (measured ? 0 : head));
    if (to > from) cuts.push([from, to]);
    i = j;
  }
  cuts.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const c of cuts) {
    const last = merged.at(-1);
    if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]);
    else merged.push([c[0], c[1]]);
  }
  return merged;
}
