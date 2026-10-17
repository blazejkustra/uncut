// Templates on disk and filled from the open project (issue #111).
//
//   built-ins                              packages/core/src/templates/builtin.ts (read-only)
//   <dataDir>/templates/<id>.md            the user's own, every project sees them
//
// The fill is deterministic: the project's media (names, lengths, fps, sizes), its brand kit, its
// canvas and length, and the song's tempo and drop when a beat analysis is already cached (nothing
// is analysed here). What the project doesn't have becomes the template's fallback or an honest note.
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { BrandKit } from "@uncut/contracts";
import { TemplateError, type TemplateFilled, type TemplateInfo } from "@uncut/contracts";
import { projectDuration, type PluginSkill } from "@uncut/core";
import { durationSeconds } from "@uncut/core/skills";
import { BUILTIN_TEMPLATE_IDS, BUILTIN_TEMPLATES, fillTemplate, formatTemplate, parseTemplate, TEMPLATE_BODY_MAX, TEMPLATE_ID, templateValues, type Template, type TemplateFacts, type TemplateMedia } from "@uncut/core/templates";
import * as Effect from "effect/Effect";

import { downbeatsOf } from "../agent/agentPlan.ts";
import type { BeatsResult } from "../analysis/beats.ts";
import { cachedFor, targetOf } from "../analysis/analysis.ts";
import { activeBrand, readPlan } from "../brand/store.ts";
import { writeAtomic } from "../project/atomicWrite.ts";

/** A template file's size cap on disk (the body is at most TEMPLATE_BODY_MAX characters, up to 4 bytes each, plus front matter). */
const TEMPLATE_FILE_MAX = TEMPLATE_BODY_MAX * 4 + 4096;

export const templatesDir = (dataDir: string) => join(dataDir, "templates");

const info = (t: Template): TemplateInfo => ({ id: t.id, name: t.name, description: t.description, body: t.body, ...(t.builtin ? { builtin: true } : {}) });

/** The built-ins, then the user's own by name (a file named like a built-in is left out). */
export async function listTemplates(dataDir: string): Promise<Array<TemplateInfo>> {
  const own: Array<Template> = [];
  let names: Array<string> = [];
  try {
    names = (await readdir(templatesDir(dataDir))).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const id = name.endsWith(".md") ? name.slice(0, -3) : "";
    if (!TEMPLATE_ID.test(id) || BUILTIN_TEMPLATE_IDS.has(id)) continue;
    try {
      // Only plain files of a sane size: a symlink (to a key, a huge log) or a folder is skipped.
      const file = join(templatesDir(dataDir), name);
      const st = await lstat(file);
      if (!st.isFile() || st.size > TEMPLATE_FILE_MAX) continue;
      own.push(parseTemplate(await readFile(file, "utf8"), id));
    } catch {
      // unreadable: skipped
    }
  }
  own.sort((a, b) => a.name.localeCompare(b.name));
  return [...BUILTIN_TEMPLATES, ...own].map(info);
}

export async function saveTemplate(dataDir: string, t: TemplateInfo): Promise<void> {
  if (!TEMPLATE_ID.test(t.id)) throw new TemplateError({ reason: "invalid", message: "A template's id is lowercase letters, digits and dashes." });
  if (BUILTIN_TEMPLATE_IDS.has(t.id)) throw new TemplateError({ reason: "builtin", message: "That's one of Uncut's templates, which can't be changed; duplicate it to make your own." });
  if (!t.name.trim()) throw new TemplateError({ reason: "invalid", message: "Give the template a name." });
  if (t.body.length > TEMPLATE_BODY_MAX) throw new TemplateError({ reason: "invalid", message: `A template is at most ${TEMPLATE_BODY_MAX} characters.` });
  await mkdir(templatesDir(dataDir), { recursive: true });
  const file = join(templatesDir(dataDir), `${t.id}.md`);
  // writeAtomic writes through a symlink to its target: a template is never a link to somewhere else.
  const st = await lstat(file).catch(() => undefined);
  if (st && !st.isFile()) throw new TemplateError({ reason: "invalid", message: "A file with that template's name isn't a plain file; rename or remove it in the templates folder first." });
  await writeAtomic(file, formatTemplate({ name: t.name.slice(0, 80), description: t.description.slice(0, 300), body: t.body }));
}

export async function deleteTemplate(dataDir: string, id: string): Promise<void> {
  if (BUILTIN_TEMPLATE_IDS.has(id)) throw new TemplateError({ reason: "builtin", message: "Uncut's own templates can't be deleted." });
  if (!TEMPLATE_ID.test(id)) throw new TemplateError({ reason: "not-found", message: "There's no template with that id." });
  await rm(join(templatesDir(dataDir), `${id}.md`), { force: true });
}

// ---- the project's facts ----

interface MediaEntry {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly path: string;
  readonly probe?: { readonly frames?: number; readonly fps?: number; readonly width?: number; readonly height?: number; readonly hasAudio?: boolean };
}
export interface OpenProjectLike {
  readonly dir: string;
  readonly project: unknown;
}
/** Reads a cached beat analysis of a media file (undefined: none). */
export type BeatsReader = (dir: string, media: MediaEntry, fps: number) => Promise<BeatsResult | undefined>;
const cachedBeats: BeatsReader = async (dir, media, fps) => (await cachedFor(targetOf(dir, media, fps), "beats")) as BeatsResult | undefined;

const kitFacts = (kit: BrandKit, files: Record<string, string>): NonNullable<TemplateFacts["kit"]> => {
  const logos = [kit.logos.light, kit.logos.dark, kit.logos.mark].filter((x): x is string => !!x);
  const fonts = kit.fonts.flatMap((f) => (f.file ? [f.file] : []));
  const fontWords = kit.fonts.map((f) => (f.file ? `${f.family} (${f.file})` : `${f.family} (not in the kit as a file)`));
  const used = new Set([...logos, ...fonts]);
  return {
    name: kit.name,
    logos: [...new Set(logos)],
    fonts: fontWords,
    files: Object.keys(files).filter((n) => !used.has(n)).sort(),
    colors: kit.colors.map((c) => ({ hex: c.hex, role: c.role, ...(c.name ? { name: c.name } : {}) })),
    ...(kit.about ? { about: kit.about } : {}),
    ...(kit.tone ? { tone: kit.tone } : {}),
  };
};

/** What the open project says, as TemplateFacts (none open: no facts). */
export async function projectFacts(dataDir: string, open: OpenProjectLike | undefined, skills: ReadonlyArray<PluginSkill> = [], readBeats: BeatsReader = cachedBeats): Promise<TemplateFacts> {
  if (!open) return { media: [] };
  const p = open.project as { name?: string; canvas?: { width: number; height: number; fps: number }; media?: ReadonlyArray<MediaEntry>; tracks?: ReadonlyArray<unknown> };
  const fps = p.canvas?.fps ?? 30;
  const all = (p.media ?? []).filter((m) => m && typeof m.name === "string" && (m.kind === "video" || m.kind === "image" || m.kind === "audio"));
  const secondsOf = (m: MediaEntry) => (m.probe?.frames ? m.probe.frames / fps : undefined);
  const media: Array<TemplateMedia> = all.map((m) => ({ name: m.name, kind: m.kind as TemplateMedia["kind"], seconds: secondsOf(m), fps: m.probe?.fps, width: m.probe?.width, height: m.probe?.height, hasAudio: m.probe?.hasAudio }));

  const brand = await activeBrand({ dataDir, projectDir: open.dir, skills }).catch(() => undefined);
  const plan = await readPlan(open.dir).catch(() => undefined);
  const briefS = durationSeconds(plan?.brief?.duration);
  const timelineS = p.tracks ? projectDuration(p as never) / fps : 0;

  // The song: an analysed audio file with a steady beat, else the longest audio file.
  const audio = all.filter((m) => m.kind === "audio").sort((a, b) => (secondsOf(b) ?? 0) - (secondsOf(a) ?? 0));
  let song: { media: MediaEntry; beats?: BeatsResult } | undefined;
  for (const m of audio.slice(0, 6)) {
    const beats = await readBeats(open.dir, m, fps).catch(() => undefined);
    if (beats?.hasAudio && typeof beats.bpm === "number") {
      song = { media: m, beats };
      break;
    }
    if (!song) song = { media: m, ...(beats ? { beats } : {}) };
  }
  const songS = song ? secondsOf(song.media) : undefined;
  const length = briefS ? ({ seconds: briefS, from: "brief" } as const) : timelineS > 0 ? ({ seconds: timelineS, from: "timeline" } as const) : songS ? ({ seconds: songS, from: "song" } as const) : undefined;

  let music: TemplateFacts["music"];
  if (song) {
    const b = song.beats;
    const analysed = b?.hasAudio ? b : undefined;
    const steady = analysed && typeof analysed.bpm === "number" && (analysed.beats?.length ?? 0) > 0;
    const span = length?.seconds ?? songS;
    const beatTimes = steady ? (analysed.beats ?? []) : [];
    const { drop } = steady ? downbeatsOf(analysed) : { drop: undefined };
    music = {
      name: song.media.name,
      seconds: songS,
      ...(analysed ? { bpm: steady ? analysed.bpm : null, confidence: analysed.confidence } : {}),
      ...(steady ? { beatCount: span !== undefined ? beatTimes.filter((t) => t < span).length : beatTimes.length, beatSpan: span } : {}),
      ...(drop ? { drop: { seconds: drop.seconds, beat: drop.beat } } : {}),
    };
  }

  return {
    ...(p.name ? { project: p.name } : {}),
    media,
    ...(p.canvas ? { canvas: { width: p.canvas.width, height: p.canvas.height, fps: p.canvas.fps } } : {}),
    ...(length ? { length } : {}),
    ...(brand?.kit ? { kit: kitFacts(brand.kit, brand.files) } : {}),
    ...(music ? { music } : {}),
  };
}

/** A template filled from the open project. */
export async function fillFor(dataDir: string, id: string, open: OpenProjectLike | undefined, skills: ReadonlyArray<PluginSkill> = [], readBeats?: BeatsReader): Promise<TemplateFilled> {
  const t = (await listTemplates(dataDir)).find((x) => x.id === id);
  if (!t) throw new TemplateError({ reason: "not-found", message: "That template isn't there any more." });
  const filled = fillTemplate(t.body, templateValues(await projectFacts(dataDir, open, skills, readBeats)));
  return { text: filled.text.trim(), missing: filled.missing };
}

// ---- the RPCs ----

const failed = (error: unknown) => (error instanceof TemplateError ? error : new TemplateError({ reason: "failed", message: error instanceof Error ? error.message : String(error) }));

export function templatesRpc(dataDir: string, current: Effect.Effect<OpenProjectLike | undefined>, skills: () => ReadonlyArray<PluginSkill> = () => []) {
  const run = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: failed });
  return {
    list: run(() => listTemplates(dataDir)),
    save: (t: TemplateInfo) => run(async () => (await saveTemplate(dataDir, t), listTemplates(dataDir))),
    delete: (id: string) => run(async () => (await deleteTemplate(dataDir, id), listTemplates(dataDir))),
    fill: (id: string) => Effect.flatMap(current, (open) => run(() => fillFor(dataDir, id, open, skills()))),
  };
}
