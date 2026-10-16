// The Music app's library as a source of the user's own music (D249). Apple keeps the library in
// "Music Library.musiclibrary", whose Library.musicdb is a private binary format; what can be read
// is (1) the XML copy the app writes when "Share Library XML with other applications" is on
// (Music › Settings › Advanced), else (2) the media folder itself (Music/Media.localized/Music, or
// the old iTunes Media folder). Only DRM-free files come through: Apple Music songs (subscription,
// DRM, or not downloaded), protected .m4p files and cloud-only tracks are left out and counted.
// Nothing is copied: like a folder of the user's (folders.ts), a song goes into a project only
// when it is added.
//
// D262: the XML (often tens of MB) is streamed and scanned a track at a time, yielding to the event
// loop between chunks and every few hundred tracks, and stops once the song cap is reached; it is
// never read whole. Every listed song is checked on disk (a few at a time): a deleted one is left
// out and counted. folders.ts reads it again only when the file's size or mtime changes.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FOLDER_AUDIO_EXTENSIONS, type FolderSound } from "@uncut/core/library";

import { inTestContext } from "../generate/providers.ts";

/** The folder id the Music library is listed under. */
export const MUSIC_FOLDER_NAME = "Music library";
const EXTENSIONS = new Set(FOLDER_AUDIO_EXTENSIONS);
/** The most songs listed (the rest: truncated). */
export const MAX_MUSIC_SONGS = 5000;
/** An XML copy larger than this isn't read (a library of ~100k songs). */
const MAX_XML_BYTES = 256 * 1024 * 1024;

/**
 * Where the Music library is looked for: UNCUT_MUSIC_LIBRARY_DIR (the folder that holds Music/ and
 * iTunes/, as ~/Music does), else ~/Music. A test run without that setting has none: tests never
 * read the real library.
 */
export function musicLibraryRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.UNCUT_MUSIC_LIBRARY_DIR) return env.UNCUT_MUSIC_LIBRARY_DIR;
  if (inTestContext(env)) return undefined;
  return join(homedir(), "Music");
}

export const xmlCandidates = (root: string) => [join(root, "Music", "Library.xml"), join(root, "iTunes", "iTunes Music Library.xml"), join(root, "iTunes", "iTunes Library.xml")];
export const mediaCandidates = (root: string) => [join(root, "Music", "Media.localized", "Music"), join(root, "Music", "Media", "Music"), join(root, "Music", "Media.localized"), join(root, "Music", "Media"), join(root, "iTunes", "iTunes Media", "Music"), join(root, "iTunes", "iTunes Music")];

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
/** A character reference's character; one that names no character (past U+10FFFF, a surrogate) is U+FFFD. */
const codePoint = (n: number) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "\uFFFD");
export const decodeXml = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => (e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : codePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))));
const part = (s: string | undefined) => (s ?? "").replace(/[\/\u0000-\u001f]+/g, " ").trim().slice(0, 120);

/** One track of the XML: its keys and values (strings, numbers, booleans). */
export type XmlTrack = Readonly<Record<string, string | number | boolean>>;

/**
 * Reads the tracks of a Library.xml (a plist: Tracks is a dict of flat dicts) from text fed to it a
 * piece at a time (D262): next() gives each complete track, or undefined when it needs more text
 * or the Tracks dict has ended (`ended`).
 */
export class LibraryXmlScanner {
  private buf = "";
  private pos = 0;
  private inTracks = false;
  ended = false;
  /** Tracks read so far. */
  count = 0;
  feed(text: string) {
    this.buf = this.buf.slice(this.pos) + text;
    this.pos = 0;
  }
  next(): XmlTrack | undefined {
    if (this.ended) return undefined;
    if (!this.inTracks) {
      const tracks = /<key>Tracks<\/key>\s*<dict>/g;
      tracks.lastIndex = this.pos;
      const m = tracks.exec(this.buf);
      // Not yet: keep only a tail that could hold the start of the marker.
      if (!m) return void (this.pos = Math.max(this.pos, this.buf.length - 64));
      this.pos = m.index + m[0].length;
      this.inTracks = true;
    }
    const head = /\s*(?:(<\/dict>)|<key>[^<]*<\/key>\s*<dict>)/y;
    head.lastIndex = this.pos;
    const h = head.exec(this.buf);
    if (!h) {
      // Something else than a track here: a broken file (past a few kB of it), else more text is needed.
      if (this.buf.length - this.pos > 4096) this.ended = true;
      return undefined;
    }
    // The end of the Tracks dict (Playlists follow as an array): done.
    if (h[1]) return void (this.ended = true);
    const body = this.pos + h[0].length;
    const close = this.buf.indexOf("</dict>", body);
    if (close < 0) return undefined;
    const t: Record<string, string | number | boolean> = {};
    const pair = /<key>([^<]*)<\/key>\s*(?:<(string|integer|real|date)>([^<]*)<\/\2>|<(true|false)\s*\/>)/g;
    const text = this.buf.slice(body, close);
    for (let p = pair.exec(text); p; p = pair.exec(text)) {
      const key = decodeXml(p[1]!);
      if (p[4]) t[key] = p[4] === "true";
      else if (p[2] === "integer" || p[2] === "real") t[key] = Number(p[3]);
      else t[key] = decodeXml(p[3] ?? "");
    }
    this.pos = close + "</dict>".length;
    this.count++;
    return t;
  }
}

/** The tracks of a whole Library.xml in memory (tests; the app streams it: scanLibraryXml). */
export function parseLibraryXml(xml: string): Array<XmlTrack> {
  const scanner = new LibraryXmlScanner();
  scanner.feed(xml);
  const out: Array<XmlTrack> = [];
  for (let t = scanner.next(); t; t = scanner.next()) out.push(t);
  return out;
}

/** Tracks read at most between two yields to the event loop. */
export const SCAN_SLICE = 250;
/**
 * Streams a Library.xml and calls `visit` with each track until it returns false or the tracks end
 * (D262): read in chunks (the file is never held whole), yielding between chunks and every
 * SCAN_SLICE tracks so the server keeps answering. Returns how many tracks were read.
 */
export async function scanLibraryXml(file: string, visit: (t: XmlTrack) => boolean, opts: { readonly chunkBytes?: number; readonly onSlice?: (ms: number) => void } = {}): Promise<number> {
  const scanner = new LibraryXmlScanner();
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: opts.chunkBytes ?? 256 * 1024 });
  let from = 0;
  // Each run of work between two yields is timed for the tests (onSlice).
  const breath = () => {
    opts.onSlice?.(performance.now() - from);
    return new Promise<void>((resolve) => setImmediate(resolve)).then(() => void (from = performance.now()));
  };
  try {
    for await (const chunk of stream) {
      from = performance.now();
      scanner.feed(chunk as string);
      let n = 0;
      for (let t = scanner.next(); t; t = scanner.next()) {
        if (!visit(t)) return scanner.count;
        if (++n % SCAN_SLICE === 0) await breath();
      }
      opts.onSlice?.(performance.now() - from);
      if (scanner.ended) break;
    }
  } finally {
    stream.destroy();
  }
  return scanner.count;
}

/** `run` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<A, B>(items: ReadonlyArray<A>, limit: number, run: (a: A) => Promise<B>): Promise<Array<B>> {
  const out = new Array<B>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * What the XML copies look like now (size and mtime of each candidate), so an unchanged library is
 * never read again (D262); "" when there is no XML (the media folder is walked instead).
 */
export async function musicLibraryStamp(root: string | undefined): Promise<string> {
  if (!root) return "";
  const parts = await Promise.all(xmlCandidates(root).map((f) => stat(f).then((s) => (s.isFile() ? `${s.size}:${s.mtimeMs}` : "-"), () => "-")));
  return parts.every((p) => p === "-") ? "" : parts.join("|");
}

/** Why a track is left out: undefined when it's a plain audio file on this Mac. */
export function excluded(t: XmlTrack): "protected" | "skip" | undefined {
  if (t["Has Video"] === true || t["Movie"] === true || t["TV Show"] === true || t["Podcast"] === true) return "skip";
  if (t["Protected"] === true || t["Apple Music"] === true || /protected/i.test(String(t["Kind"] ?? ""))) return "protected";
  if (t["Track Type"] !== undefined && t["Track Type"] !== "File") return "protected";
  const loc = t["Location"];
  if (typeof loc !== "string" || !loc.startsWith("file://")) return "protected";
  if (/\.m4p$/i.test(loc)) return "protected";
  return undefined;
}

export const locationPath = (loc: string) => fileURLToPath(loc.replace(/^file:\/\/localhost\//, "file:///"));

export interface MusicLibrary {
  readonly found: boolean;
  /** What was read: the XML file or the media folder. */
  readonly where: string;
  readonly sounds: Array<FolderSound>;
  readonly paths: Map<string, string>;
  readonly skipped: number;
  readonly truncated: boolean;
}

/**
 * The library's DRM-free songs under the folder id `folderId`: from the XML when there is one, else
 * the media folder walked with `walk` (folders.ts; Apple Music's own folder left out).
 */
export async function readMusicLibrary(root: string | undefined, folderId: string, walk: (dir: string, id: string) => Promise<{ sounds: Array<FolderSound>; paths: Map<string, string>; truncated: boolean }>, onSlice?: (ms: number) => void): Promise<MusicLibrary> {
  const none: MusicLibrary = { found: false, where: root ?? "", sounds: [], paths: new Map(), skipped: 0, truncated: false };
  if (!root) return none;
  for (const file of xmlCandidates(root)) {
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_XML_BYTES) continue;
    // The songs that qualify, up to one past the cap (to know it was reached); the scan stops there.
    const picked: Array<{ t: XmlTrack; path: string; ext: string }> = [];
    let skipped = 0;
    let read: number;
    try {
      read = await scanLibraryXml(file, (t) => {
        const why = excluded(t);
        if (why) {
          if (why === "protected") skipped++;
          return true;
        }
        let path: string;
        try {
          path = locationPath(t["Location"] as string);
        } catch {
          skipped++;
          return true;
        }
        const ext = extname(path).slice(1).toLowerCase();
        if (!EXTENSIONS.has(ext)) {
          skipped++;
          return true;
        }
        picked.push({ t, path, ext });
        return picked.length <= MAX_MUSIC_SONGS;
      }, onSlice ? { onSlice } : {});
    } catch {
      continue;
    }
    if (!read) continue;
    const truncated = picked.length > MAX_MUSIC_SONGS;
    // Each song checked on disk, a few at a time: one deleted since the XML was written is left out and counted.
    const sizes = await mapLimit(picked.slice(0, MAX_MUSIC_SONGS), 16, ({ path }) => stat(path).then((s) => (s.isFile() ? s.size : -1), () => -1));
    const sounds: Array<FolderSound> = [];
    const paths = new Map<string, string>();
    picked.slice(0, MAX_MUSIC_SONGS).forEach(({ t, path, ext }, i) => {
      const size = sizes[i]!;
      if (size <= 0) {
        skipped++;
        return;
      }
      const id = hash(`${folderId}/${path}`);
      const name = part(String(t["Name"] ?? "")) || basename(path, extname(path));
      // Artist and album are searchable as the "subfolders" of the song (filterFolderSounds).
      const rel = [part(String(t["Artist"] ?? t["Album Artist"] ?? "")), part(String(t["Album"] ?? "")), basename(path)].filter(Boolean).join("/");
      sounds.push({ id, folder: folderId, name, rel, ext, bytes: size });
      paths.set(id, path);
    });
    return { found: true, where: file, sounds, paths, skipped, truncated };
  }
  for (const dir of mediaCandidates(root)) {
    if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) continue;
    const walked = await walk(dir, folderId);
    const sounds = walked.sounds.filter((s) => !/^Apple Music\//.test(s.rel) && s.ext !== "m4p");
    const keep = new Set(sounds.map((s) => s.id));
    const paths = new Map([...walked.paths].filter(([id]) => keep.has(id)));
    return { found: true, where: dir, sounds: sounds.slice(0, MAX_MUSIC_SONGS), paths, skipped: walked.sounds.length - sounds.length, truncated: walked.truncated || sounds.length > MAX_MUSIC_SONGS };
  }
  return none;
}
