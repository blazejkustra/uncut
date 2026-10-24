// The user's media index (issue #39, D205): captures, imports and generations from every project on
// this Mac, so a take recorded in one project can be found and used in another. Stored in the
// user data dir (media-index.json, posters in media-index/thumbs/), filled from the recent
// projects' project.json files whenever it is read (so media from before this existed is there
// too), and kept for files that still exist after their project leaves the recents.
//
// Importing (D12): a file inside another project's folder (its media/captures, media/generated…) is
// copied into this project's media/imports/ (the other project may be moved or deleted); anything
// else is referenced where it is.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";

import type { MediaRecentEntry, RecentProject } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { writeAtomic } from "../project/atomicWrite.ts";
import { ServerConfig } from "../app/config.ts";
import { Recents } from "../project/recents.ts";
import { Projects } from "../project/projects.ts";
import { thumbDir } from "./media.ts";

/** At most this many entries are kept (newest first). */
export const MAX_INDEXED = 500;
/** media_search and the Media panel return at most this many. */
export const MAX_FOUND = 30;

export type IndexEntry = MediaRecentEntry & { readonly bytes?: number };

type Origin = MediaRecentEntry["origin"];
const KINDS = new Set(["video", "image", "audio"]);
const ORIGINS = new Set(["capture", "import", "generated"]);

export const indexFile = (dataDir: string) => join(dataDir, "media-index.json");
export const indexThumbs = (dataDir: string) => join(dataDir, "media-index", "thumbs");
export const entryId = (path: string) => createHash("sha1").update(path).digest("hex").slice(0, 16);

/** Where a media entry came from, by its source module (D205); undefined: not worth indexing (a bundled library track). */
export function originOf(source: unknown): Origin | undefined {
  const module =
    source && typeof source === "object" && typeof (source as { module?: unknown }).module === "string" ? (source as { module: string }).module : "";
  if (/^(library|music|sfx)\b/.test(module)) return undefined;
  // A file brought in from the index keeps where it first came from.
  const origin = (source as { origin?: unknown } | undefined)?.origin;
  if (module === "media.reuse" && typeof origin === "string" && ORIGINS.has(origin)) return origin as Origin;
  if (/^(capture|argent)\b|\.capture$|^.*\.capture\./.test(module)) return "capture";
  if (/^generate\b/.test(module)) return "generated";
  return "import";
}

const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);

/** The .uncut project folder (with a project.json) a path is inside, if any. */
export async function projectFolderOf(path: string): Promise<string | undefined> {
  let dir = dirname(path);
  for (let i = 0; i < 40; i++) {
    if (/\.uncut$/i.test(dir)) {
      try {
        await stat(join(dir, "project.json"));
        return dir;
      } catch {
        return undefined;
      }
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

const real = async (path: string) => {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
};

/**
 * D205/D12: what importing `path` into `projectDir` uses: a copy in media/imports/ when the file
 * lives inside another project's folder, else the file itself. The copy keeps the file's name
 * ("take 2.mp4" when taken); an identical copy already there is reused.
 */
export async function importablePath(path: string, projectDir: string): Promise<{ path: string; copied: boolean }> {
  const file = await real(path);
  const other = await projectFolderOf(file);
  const here = await real(projectDir);
  if (!other || (await real(other)) === here) return { path: file, copied: false };
  const folder = join(here, "media", "imports");
  await mkdir(folder, { recursive: true });
  const size = (await stat(file)).size;
  const ext = extname(file);
  const stem = basename(file, ext);
  for (let n = 1; n < 1000; n++) {
    const target = join(folder, n === 1 ? `${stem}${ext}` : `${stem} ${n}${ext}`);
    try {
      const s = await stat(target);
      if (s.size === size) return { path: target, copied: true };
    } catch {
      await copyFile(file, target);
      return { path: target, copied: true };
    }
  }
  throw new Error("Too many copies with that name in media/imports.");
}

/** The index entries one project's media gives (files that exist), with their posters copied into the index. */
export async function entriesOf(project: { dir: string; name: string }, dataDir: string): Promise<Array<IndexEntry>> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(join(project.dir, "project.json"), "utf8"));
  } catch {
    return [];
  }
  const doc = (json && typeof json === "object" ? json : {}) as { name?: unknown; media?: unknown; canvas?: { fps?: unknown } };
  const fps = typeof doc.canvas?.fps === "number" && doc.canvas.fps > 0 ? doc.canvas.fps : 30;
  const name = str(doc.name) ?? project.name;
  const media = Array.isArray(doc.media) ? doc.media : [];
  let posters: Array<string> = [];
  try {
    posters = await readdir(thumbDir(project.dir));
  } catch {}
  const out: Array<IndexEntry> = [];
  for (const raw of media) {
    const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const path = str(m.path);
    const kind = str(m.kind);
    const id = str(m.id);
    if (!path || !kind || !KINDS.has(kind) || !id) continue;
    const origin = originOf(m.source);
    if (!origin) continue;
    const abs = isAbsolute(path) ? path : resolve(project.dir, path);
    let s;
    try {
      s = await stat(abs);
      if (!s.isFile()) continue;
    } catch {
      continue;
    }
    const source = (m.source && typeof m.source === "object" ? m.source : {}) as Record<string, unknown>;
    const probe = (m.probe && typeof m.probe === "object" ? m.probe : {}) as { frames?: unknown; fps?: unknown; width?: unknown; height?: unknown };
    const frames = typeof probe.frames === "number" ? probe.frames : undefined;
    const eid = entryId(abs);
    // The project's poster for it (the newest file named <media id>--<key>.jpg), copied once.
    const poster = posters.filter((f) => f.startsWith(`${id}--`) && f.endsWith(".jpg")).at(-1);
    let thumb = false;
    if (poster) {
      const to = join(indexThumbs(dataDir), `${eid}.jpg`);
      try {
        await stat(to);
        thumb = true;
      } catch {
        try {
          await mkdir(indexThumbs(dataDir), { recursive: true });
          await copyFile(join(thumbDir(project.dir), poster), to);
          thumb = true;
        } catch {}
      }
    }
    const created = str(source.recordedAt) ?? str(source.createdAt) ?? str(source.at) ?? new Date(s.birthtimeMs || s.mtimeMs).toISOString();
    const device = str(source.device) ?? str(source.deviceName);
    const app = str(source.bundleId) ?? str(source.app);
    out.push({
      id: eid,
      path: abs,
      name: str(m.name) ?? basename(abs),
      kind: kind as IndexEntry["kind"],
      origin,
      ...(frames ? { seconds: Number((frames / fps).toFixed(2)) } : {}),
      ...(typeof probe.width === "number" ? { width: probe.width } : {}),
      ...(typeof probe.height === "number" ? { height: probe.height } : {}),
      project: { dir: project.dir, name },
      ...(device ? { device } : {}),
      ...(app ? { app } : {}),
      created,
      ...(thumb ? { thumb: true } : {}),
      ...(abs.startsWith(project.dir + sep) ? { copies: true } : {}),
      bytes: s.size,
    });
  }
  return out;
}

const isEntry = (x: unknown): x is IndexEntry => {
  const e = x as IndexEntry;
  return (
    !!e &&
    typeof e === "object" &&
    typeof e.id === "string" &&
    typeof e.path === "string" &&
    typeof e.name === "string" &&
    KINDS.has(e.kind) &&
    ORIGINS.has(e.origin) &&
    !!e.project &&
    typeof e.project.dir === "string" &&
    typeof e.created === "string"
  );
};

/** The words a search matches against. */
const haystack = (e: IndexEntry) =>
  [
    e.name,
    basename(e.path),
    e.project.name,
    e.device ?? "",
    e.app ?? "",
    e.origin,
    e.kind,
    e.origin === "capture" ? "recording take screen simulator emulator" : e.origin === "generated" ? "generation" : "",
  ]
    .join(" ")
    .toLowerCase();

/**
 * Entries matching `query` (every word somewhere in the name, file, project, device, app or
 * origin) and `kind` (video, image, audio, or capture, import, generated), newest first, with
 * another project's copy of the same file (same name and size) shown once. `exclude`: the open
 * project's folder and its media's paths (it has them already).
 */
export function searchEntries(
  entries: ReadonlyArray<IndexEntry>,
  opts: {
    readonly query?: string | undefined;
    readonly kind?: string | undefined;
    readonly limit?: number | undefined;
    readonly excludeDir?: string | undefined;
    readonly excludePaths?: ReadonlySet<string> | undefined;
  },
) {
  const words = (opts.query ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
  const kind = opts.kind?.toLowerCase();
  const seen = new Set<string>();
  const out: Array<IndexEntry> = [];
  const sorted = [...entries].sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  // Oldest first to keep the original of a copied file, then newest first for the answer.
  for (const e of sorted) {
    const key = `${e.name}\0${e.bytes ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (opts.excludeDir && (e.project.dir === opts.excludeDir || e.path.startsWith(opts.excludeDir + sep))) continue;
    if (opts.excludePaths?.has(e.path)) continue;
    if (kind && e.kind !== kind && e.origin !== kind) continue;
    const hay = haystack(e);
    if (words.length && !words.every((w) => hay.includes(w))) continue;
    out.push(e);
  }
  return out.reverse().slice(0, Math.max(1, Math.min(opts.limit ?? MAX_FOUND, 100)));
}

/** An entry as the agent and the panel get it (without the size kept for de-duplication). */
export const shownEntry = ({ bytes: _bytes, ...e }: IndexEntry): MediaRecentEntry => e;

export interface MediaIndexShape {
  /** The index refreshed from the recent projects (and the open one), newest first. */
  readonly entries: Effect.Effect<ReadonlyArray<IndexEntry>>;
  /** Matches from other projects than the open one (see searchEntries). */
  readonly search: (opts: {
    readonly query?: string | undefined;
    readonly kind?: string | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ReadonlyArray<IndexEntry>>;
  readonly get: (id: string) => Effect.Effect<IndexEntry | undefined>;
}

export class MediaIndex extends Context.Service<MediaIndex, MediaIndexShape>()("uncut/MediaIndex") {}

export const layer = Layer.effect(
  MediaIndex,
  Effect.gen(function* () {
    const { dataDir } = yield* ServerConfig;
    const recents = yield* Recents;
    const projects = yield* Projects;
    const lock = yield* Semaphore.make(1);
    const file = indexFile(dataDir);

    const read = async (): Promise<Array<IndexEntry>> => {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as { entries?: unknown };
        return Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [];
      } catch {
        return [];
      }
    };

    const refresh = (list: ReadonlyArray<RecentProject>, open: string | undefined) =>
      Effect.promise(async () => {
        const known = await read();
        const dirs = new Map<string, { dir: string; name: string }>();
        for (const r of list) dirs.set(r.dir, { dir: r.dir, name: r.name });
        if (open && !dirs.has(open)) dirs.set(open, { dir: open, name: basename(open).replace(/\.uncut$/i, "") });
        const fresh = new Map<string, IndexEntry>();
        for (const p of dirs.values()) for (const e of await entriesOf(p, dataDir)) if (!fresh.has(e.id)) fresh.set(e.id, e);
        // Entries from projects no longer listed stay while their file exists.
        for (const e of known) {
          if (fresh.has(e.id) || dirs.has(e.project.dir)) continue;
          try {
            await stat(e.path);
            fresh.set(e.id, e);
          } catch {}
        }
        const entries = [...fresh.values()].sort((a, b) => Date.parse(b.created) - Date.parse(a.created)).slice(0, MAX_INDEXED);
        try {
          await mkdir(dataDir, { recursive: true });
          const text = `${JSON.stringify({ version: 1, entries }, null, 1)}\n`;
          const before = await readFile(file, "utf8").catch(() => "");
          if (before !== text) await writeAtomic(file, text);
        } catch (error) {
          console.error(`[uncut] can't save the media index: ${(error as Error).message}`);
        }
        return entries;
      });

    const entries = lock.withPermits(1)(
      Effect.gen(function* () {
        const list = yield* recents.list;
        const open = yield* projects.currentDir;
        return yield* refresh(list, open ?? undefined);
      }),
    );

    return MediaIndex.of({
      entries,
      search: (opts) =>
        Effect.gen(function* () {
          const all = yield* entries;
          const open = yield* projects.current;
          const dir = open?.dir ? yield* Effect.promise(() => real(open.dir)) : undefined;
          const paths = new Set<string>();
          for (const m of (open?.project as { media?: ReadonlyArray<{ path?: unknown }> } | undefined)?.media ?? [])
            if (typeof m.path === "string" && dir) paths.add(isAbsolute(m.path) ? m.path : resolve(dir, m.path));
          return searchEntries(all, { ...opts, ...(dir ? { excludeDir: dir } : {}), excludePaths: paths });
        }),
      get: (id) => Effect.map(entries, (all) => all.find((e) => e.id === id)),
    });
  }),
);
