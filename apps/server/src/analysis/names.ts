// Names in a transcript: whisper hears "Claude Code" as "Cloud Code". The project's brief names
// the products and people the video is about; a run of words that sounds like one of those names
// (a few letters off) is written as the name.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { TranscriptSegment, TranscriptWord } from "../../../../plugins/whisper-transcribe/whisper.ts";
import type { TranscriptPhrase } from "./phrases.ts";

/** Two to three capitalised words in a row ("Claude Code", "DM Sans", "GitHub Actions"). */
const NAME = /\b(?:[A-Z][\w-]*[A-Za-z0-9])(?:\s+[A-Z][\w-]*[A-Za-z0-9]){1,2}\b/g;
const SENTENCE_START = /(?:^|[.!?:;]\s+|"\s*)$/;

const strings = (value: unknown): Array<string> =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : [];

/** The multi-word names a text mentions (not counting a sentence's first word). */
export function namesIn(text: string): Array<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(NAME)) {
    let name = m[0];
    if (SENTENCE_START.test(text.slice(0, m.index))) name = name.split(/\s+/).slice(1).join(" ");
    if (name.includes(" ")) out.add(name);
  }
  return [...out];
}

/** The names in the project's brief.json (none when there's no brief). */
export async function briefNames(projectDir: string): Promise<Array<string>> {
  const raw = await readFile(join(projectDir, "brief.json"), "utf8").catch(() => undefined);
  if (!raw) return [];
  try {
    return [...new Set(strings(JSON.parse(raw)).flatMap(namesIn))];
  } catch {
    return [];
  }
}

const letters = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

/** Whether words sound like the name: the same first letter and at most 1 letter off (2 for names of 8 letters or more). */
function soundsLike(heard: string, name: string) {
  const a = letters(heard);
  const b = letters(name);
  if (!a || a[0] !== b[0]) return false;
  return distance(a, b) <= (b.length >= 8 ? 2 : 1);
}

interface Transcript {
  readonly words: Array<TranscriptWord>;
  readonly segments: Array<TranscriptSegment>;
  readonly phrases?: Array<TranscriptPhrase> | undefined;
}

const LEAD = /^[^\p{L}\p{N}]*/u;
const TAIL = /[^\p{L}\p{N}]*$/u;

/** Writes runs of words that sound like one of `names` as the name (keeping the punctuation around them), in the words and their segments' and phrases' text. */
export function correctNames<T extends Transcript>(transcript: T, names: ReadonlyArray<string>): T {
  if (!names.length || !transcript.words.length) return transcript;
  const words = [...transcript.words];
  const fixes: Array<{ from: string; to: string }> = [];
  for (const name of names) {
    const parts = name.split(/\s+/);
    for (let i = 0; i + parts.length <= words.length; i++) {
      const run = words.slice(i, i + parts.length);
      const heard = run.map((w) => w.text).join(" ");
      const bare = heard.replace(LEAD, "").replace(TAIL, "");
      if (bare === name || !soundsLike(heard, name)) continue;
      run.forEach((w, k) => {
        const lead = k === 0 ? (LEAD.exec(w.text)?.[0] ?? "") : "";
        const tail = k === parts.length - 1 ? (TAIL.exec(w.text)?.[0] ?? "") : "";
        words[i + k] = { ...w, text: `${lead}${parts[k]}${tail}` };
      });
      fixes.push({ from: bare, to: name });
    }
  }
  if (!fixes.length) return transcript;
  const fixText = (text: string) => fixes.reduce((t, f) => t.split(f.from).join(f.to), text);
  return {
    ...transcript,
    words,
    segments: transcript.segments.map((s) => ({ ...s, text: fixText(s.text) })),
    ...(transcript.phrases ? { phrases: transcript.phrases.map((p) => ({ ...p, text: fixText(p.text) })) } : {}),
  };
}
