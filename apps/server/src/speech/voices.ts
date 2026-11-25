// The offline voice's voices: Reverb's presets (downloaded with the model, reverbFiles.ts) and the
// ones the user cloned, each a JSON file in <data dir>/voices: the codec codes Reverb speaks from,
// what the clip says, and where it came from, with the user's consent and when it was given.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { VoiceInfo } from "@uncut/contracts";

import { isLanguage, PRESET_VOICES } from "../../../../plugins/reverb-tts/reverb.ts";

/** The line the user confirms before a voice is cloned. */
export const CONSENT_LINE = "I have the right to use this voice";

export interface SavedVoice {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly transcript: string;
  readonly frames: number;
  readonly speech_frames?: number;
  readonly codes: ReadonlyArray<number>;
  readonly source?: string;
  readonly createdAt: string;
  readonly consent: { readonly text: string; readonly at: string };
}

export const voicesDir = (dataDir: string) => join(dataDir, "voices");

const presetInfo = (p: (typeof PRESET_VOICES)[number]): VoiceInfo => ({ id: p.id, name: p.name, language: p.language, preset: true });

export const savedInfo = (v: SavedVoice): VoiceInfo => ({
  id: v.id,
  name: v.name,
  language: v.language,
  preset: false,
  transcript: v.transcript,
  seconds: Number((v.frames / 25).toFixed(2)),
  ...(v.source ? { source: v.source } : {}),
  createdAt: v.createdAt,
});

const isSaved = (v: unknown): v is SavedVoice => {
  const s = v as Partial<SavedVoice> | null;
  return (
    !!s &&
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    isLanguage(s.language) &&
    typeof s.transcript === "string" &&
    Number.isInteger(s.frames) &&
    Array.isArray(s.codes)
  );
};

export class VoiceStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** The user's cloned voices, oldest first; a file that isn't a voice is skipped. */
  async saved(): Promise<ReadonlyArray<SavedVoice>> {
    const names = await readdir(this.dir).catch(() => [] as Array<string>);
    const out: Array<SavedVoice> = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const v = await readFile(join(this.dir, name), "utf8").then(JSON.parse, () => undefined);
      if (isSaved(v)) out.push(v);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** The presets, then the cloned voices. */
  async list(): Promise<ReadonlyArray<VoiceInfo>> {
    return [...PRESET_VOICES.map(presetInfo), ...(await this.saved()).map(savedInfo)];
  }

  path = (id: string) => join(this.dir, `${id}.json`);

  /** A voice by id, else by name (any case); undefined when there's none. */
  async find(wanted: string): Promise<VoiceInfo | undefined> {
    const w = wanted.trim().toLowerCase();
    const all = await this.list();
    return all.find((v) => v.id.toLowerCase() === w) ?? all.find((v) => v.name.toLowerCase() === w);
  }

  /** Saves a voice the runner made (its codes, frames and transcript) with its name and the consent. */
  async save(
    made: Omit<SavedVoice, "id" | "name" | "createdAt" | "consent" | "source">,
    meta: { readonly name: string; readonly source?: string | undefined },
  ) {
    await mkdir(this.dir, { recursive: true });
    const now = new Date().toISOString();
    const voice: SavedVoice = {
      id: `voice-${randomUUID().slice(0, 8)}`,
      name: meta.name,
      language: made.language,
      transcript: made.transcript,
      frames: made.frames,
      ...(made.speech_frames ? { speech_frames: made.speech_frames } : {}),
      codes: made.codes,
      ...(meta.source ? { source: meta.source } : {}),
      createdAt: now,
      consent: { text: CONSENT_LINE, at: now },
    };
    const path = this.path(voice.id);
    await writeFile(`${path}.tmp`, JSON.stringify(voice));
    await rename(`${path}.tmp`, path);
    return voice;
  }

  /** Removes a cloned voice; false when there's none by that id (presets can't be removed). */
  async remove(id: string) {
    const found = (await this.saved()).find((v) => v.id === id);
    if (!found) return false;
    await rm(this.path(id), { force: true });
    return true;
  }
}
