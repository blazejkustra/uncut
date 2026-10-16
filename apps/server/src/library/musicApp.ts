// The Music app's library as a source of the user's own music (D249). Apple keeps the library in
// "Music Library.musiclibrary", whose Library.musicdb is a private binary format; what can be read
// is (1) the XML copy the app writes when "Share Library XML with other applications" is on
// (Music › Settings › Advanced), else (2) the media folder itself (Music/Media.localized/Music, or
// the old iTunes Media folder). Only DRM-free files come through: Apple Music songs (subscription,
// DRM, or not downloaded), protected .m4p files and cloud-only tracks are left out and counted.
// Nothing is copied: like a folder of the user's (folders.ts), a song goes into a project only
// when it is added.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
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
const decode = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => (e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))));
const part = (s: string | undefined) => (s ?? "").replace(/[\/\u0000-\u001f]+/g, " ").trim().slice(0, 120);

/** One track of the XML: its keys and values (strings, numbers, booleans). */
export type XmlTrack = Readonly<Record<string, string | number | boolean>>;

/** The tracks of a Library.xml (a plist: Tracks is a dict of dicts with no nesting). */
export function parseLibraryXml(xml: string): Array<XmlTrack> {
  const start = xml.search(/<key>Tracks<\/key>\s*<dict>/);
  if (start < 0) return [];
  const out: Array<XmlTrack> = [];
  const track = /<key>\d+<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
  track.lastIndex = start + xml.slice(start).indexOf("<dict>") + "<dict>".length;
  const pair = /<key>([^<]*)<\/key>\s*(?:<(string|integer|real|date)>([^<]*)<\/\2>|<(true|false)\s*\/>)/g;
  // Past the Tracks dict (Playlists follow as an array): stop.
  const playlists = xml.indexOf("<key>Playlists</key>", start);
  for (let m = track.exec(xml); m; m = track.exec(xml)) {
    if (playlists >= 0 && m.index > playlists) break;
    const t: Record<string, string | number | boolean> = {};
    for (let p = pair.exec(m[1]!); p; p = pair.exec(m[1]!)) {
      const key = decode(p[1]!);
      if (p[4]) t[key] = p[4] === "true";
      else if (p[2] === "integer" || p[2] === "real") t[key] = Number(p[3]);
      else t[key] = decode(p[3] ?? "");
    }
    pair.lastIndex = 0;
    out.push(t);
  }
  return out;
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
export async function readMusicLibrary(root: string | undefined, folderId: string, walk: (dir: string, id: string) => Promise<{ sounds: Array<FolderSound>; paths: Map<string, string>; truncated: boolean }>): Promise<MusicLibrary> {
  const none: MusicLibrary = { found: false, where: root ?? "", sounds: [], paths: new Map(), skipped: 0, truncated: false };
  if (!root) return none;
  for (const file of xmlCandidates(root)) {
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_XML_BYTES) continue;
    const tracks = parseLibraryXml(await readFile(file, "utf8").catch(() => ""));
    if (!tracks.length) continue;
    const sounds: Array<FolderSound> = [];
    const paths = new Map<string, string>();
    let skipped = 0;
    let truncated = false;
    for (const t of tracks) {
      const why = excluded(t);
      if (why) {
        if (why === "protected") skipped++;
        continue;
      }
      let path: string;
      try {
        path = locationPath(t["Location"] as string);
      } catch {
        skipped++;
        continue;
      }
      const ext = extname(path).slice(1).toLowerCase();
      if (!EXTENSIONS.has(ext)) {
        skipped++;
        continue;
      }
      if (sounds.length >= MAX_MUSIC_SONGS) {
        truncated = true;
        break;
      }
      const size = typeof t["Size"] === "number" && t["Size"] > 0 ? t["Size"] : await stat(path).then((s) => (s.isFile() ? s.size : -1), () => -1);
      if (size <= 0) {
        skipped++;
        continue;
      }
      const id = hash(`${folderId}/${path}`);
      const name = part(String(t["Name"] ?? "")) || basename(path, extname(path));
      // Artist and album are searchable as the "subfolders" of the song (filterFolderSounds).
      const rel = [part(String(t["Artist"] ?? t["Album Artist"] ?? "")), part(String(t["Album"] ?? "")), basename(path)].filter(Boolean).join("/");
      sounds.push({ id, folder: folderId, name, rel, ext, bytes: size });
      paths.set(id, path);
    }
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
