// Fonts and brand logos for everything Uncut draws (D198, issue #34, #35). The faces: the bundled
// DM Sans and DM Mono (ServerConfig fontsDir) and the project's brand kit's font files, as data:
// URLs (core FontSource). Graphics get the faces they name inlined where they are read
// (readGraphics, like the bundled libraries of D193), texts and components get the kit's faces in
// the rasteriser's CSS (the bundled ones are in its page already, D77) and in the preview (the
// web loads the kit's files from /media/brand). `available` says whether a family is drawn as
// asked: bundled, in the kit with a file, or installed on this Mac (read from the font files' name
// tables, once per server).
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

import type { BrandKit } from "@uncut/contracts";
import { FONT_FACES, FONT_FORMATS, FONT_MIME, familyKey, fontFaceRules, type FontSource } from "@uncut/core";

import { activeBrand, type BrandDirs } from "../brand/store.ts";

/** The most one kit font file may be to be inlined (bytes). */
export const MAX_KIT_FONT_BYTES = 2 * 1024 * 1024;
/** The most one logo may be to be inlined in a graphic (bytes). */
export const MAX_LOGO_BYTES = 400 * 1024;

const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;

const bundled = new Map<string, Promise<ReadonlyArray<FontSource>>>();
/** DM Sans and DM Mono from the bundled files (a file that can't be read is left out). */
export function bundledFontSources(dir: string): Promise<ReadonlyArray<FontSource>> {
  let hit = bundled.get(dir);
  if (!hit) {
    hit = (async () => {
      const out: Array<FontSource> = [];
      for (const f of FONT_FACES) {
        try {
          out.push({ family: f.family, weight: f.weight, format: "woff2", url: dataUrl("font/woff2", await readFile(join(dir, f.file))) });
        } catch {}
      }
      return out;
    })();
    bundled.set(dir, hit);
  }
  return hit;
}

const fileCache = new Map<string, { key: string; url: string }>();
/** A kit file as a data: URL (cached by size and mtime), or undefined when it can't be read or is over `max`. */
async function fileUrl(path: string, mime: string, max: number): Promise<string | undefined> {
  const st = await stat(path).catch(() => undefined);
  if (!st?.isFile() || st.size > max || st.size === 0) return undefined;
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = fileCache.get(path);
  if (hit?.key === key) return hit.url;
  const bytes = await readFile(path).catch(() => undefined);
  if (!bytes) return undefined;
  const url = dataUrl(mime, bytes);
  fileCache.set(path, { key, url });
  return url;
}

/** The kit's fonts that have a file, as faces (its weight when given, else the whole range). */
export async function kitFontSources(kit: BrandKit | undefined, files: Readonly<Record<string, string>>): Promise<Array<FontSource>> {
  const out: Array<FontSource> = [];
  for (const f of kit?.fonts ?? []) {
    if (!f.file) continue;
    const path = files[f.file];
    const format = FONT_FORMATS[extname(f.file).toLowerCase()];
    if (!path || !format) continue;
    const url = await fileUrl(path, FONT_MIME[format], MAX_KIT_FONT_BYTES);
    if (url) out.push({ family: f.family, ...(f.weight ? { weight: String(f.weight) } : {}), format, url });
  }
  return out;
}

const LOGO_MIME: Readonly<Record<string, string>> = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
/** The kit's logos as data: URLs by slot (for uncut:brand/logo-… in graphics). */
export async function kitLogoUrls(kit: BrandKit | undefined, files: Readonly<Record<string, string>>): Promise<Partial<Record<"light" | "dark" | "mark", string>>> {
  const out: Partial<Record<"light" | "dark" | "mark", string>> = {};
  for (const slot of ["light", "dark", "mark"] as const) {
    const name = kit?.logos[slot];
    const path = name ? files[name] : undefined;
    const mime = name ? LOGO_MIME[extname(name).toLowerCase()] : undefined;
    if (!path || !mime) continue;
    const url = await fileUrl(path, mime, MAX_LOGO_BYTES);
    if (url) out[slot] = url;
  }
  return out;
}

// ---- installed fonts ----

/** Where macOS keeps fonts (UNCUT_FONT_DIRS, colon separated, replaces them; empty: none). */
export const fontDirs = (env: NodeJS.ProcessEnv = process.env) =>
  env.UNCUT_FONT_DIRS !== undefined ? env.UNCUT_FONT_DIRS.split(":").filter(Boolean) : ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", join(homedir(), "Library/Fonts")];

async function readAt(handle: Awaited<ReturnType<typeof open>>, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, offset);
  return buf.subarray(0, bytesRead);
}

/** The family names (name ids 1 and 16) of a TrueType / OpenType file or collection. */
export async function fontFileFamilies(path: string): Promise<Array<string>> {
  const out = new Set<string>();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const head = await readAt(handle, 0, 12);
    if (head.length < 12) return [];
    const tag = head.toString("latin1", 0, 4);
    let offsets = [0];
    if (tag === "ttcf") {
      const count = Math.min(head.readUInt32BE(8), 64);
      const table = await readAt(handle, 12, count * 4);
      offsets = Array.from({ length: Math.floor(table.length / 4) }, (_, i) => table.readUInt32BE(i * 4));
    } else if (tag !== "\x00\x01\x00\x00" && tag !== "OTTO" && tag !== "true") return [];
    for (const base of offsets) {
      const dir = await readAt(handle, base, 12);
      if (dir.length < 12) continue;
      const tables = Math.min(dir.readUInt16BE(4), 200);
      const records = await readAt(handle, base + 12, tables * 16);
      let nameAt = -1;
      let nameLength = 0;
      for (let i = 0; i + 16 <= records.length; i += 16) {
        if (records.toString("latin1", i, i + 4) === "name") {
          nameAt = records.readUInt32BE(i + 8);
          nameLength = records.readUInt32BE(i + 12);
        }
      }
      if (nameAt < 0 || nameLength < 6) continue;
      const name = await readAt(handle, nameAt, Math.min(nameLength, 256 * 1024));
      const count = name.readUInt16BE(2);
      const strings = name.readUInt16BE(4);
      for (let i = 0; i < count && 6 + i * 12 + 12 <= name.length; i++) {
        const r = 6 + i * 12;
        const platform = name.readUInt16BE(r);
        const nameId = name.readUInt16BE(r + 6);
        const length = name.readUInt16BE(r + 8);
        const offset = name.readUInt16BE(r + 10);
        if (nameId !== 1 && nameId !== 16) continue;
        const bytes = name.subarray(strings + offset, strings + offset + length);
        let text = "";
        if (platform === 3 || platform === 0) {
          for (let j = 0; j + 1 < bytes.length; j += 2) text += String.fromCharCode(bytes.readUInt16BE(j));
        } else if (platform === 1) text = bytes.toString("latin1");
        text = text.replace(/\0/g, "").trim();
        if (text && !text.startsWith(".")) out.add(text);
      }
    }
  } catch {
    return [...out];
  } finally {
    await handle?.close().catch(() => {});
  }
  return [...out];
}

let installed: Promise<ReadonlySet<string>> | undefined;
let installedFor = "";
/** The families installed on this Mac (familyKey), read once per server (per font folder list). */
export function installedFamilies(env: NodeJS.ProcessEnv = process.env): Promise<ReadonlySet<string>> {
  const dirs = fontDirs(env);
  const key = dirs.join(":");
  if (!installed || installedFor !== key) {
    installedFor = key;
    installed = (async () => {
      const out = new Set<string>();
      for (const dir of dirs) {
        const names = await readdir(dir).catch(() => [] as Array<string>);
        for (const n of names) {
          if (!/\.(ttf|otf|ttc|otc)$/i.test(n)) continue;
          for (const family of await fontFileFamilies(join(dir, n))) out.add(familyKey(family));
        }
      }
      return out;
    })();
  }
  return installed;
}

/** What a project draws with: every face (bundled, then the kit's), the kit's alone as CSS, its logos, and whether a family is there. */
export interface ProjectFonts {
  readonly sources: ReadonlyArray<FontSource>;
  /** @font-face rules for the kit's faces (the rasteriser's page has the bundled ones already). */
  readonly kitCss: string;
  readonly logos: Partial<Record<"light" | "dark" | "mark", string>>;
  readonly available: (family: string) => boolean;
  /** The kit's families that have no file and aren't installed (for the agent's notes). */
  readonly kitMissing: ReadonlyArray<string>;
}

/**
 * `installed`: also read which families this Mac has (the first time, a scan of its font files):
 * only what judges fonts needs it (project_check, the critic, graphic_write, brand_read); drawing
 * (the export, render_frames, the preview route) doesn't, and `available` then knows only the
 * bundled and the kit's families.
 */
export async function projectFonts(fontsDir: string, dirs: BrandDirs, installed = false): Promise<ProjectFonts> {
  const brand = await activeBrand(dirs).catch(() => ({ files: {} as Record<string, string> }) as { kit?: BrandKit; files: Record<string, string> });
  const [base, kit, logos, system] = await Promise.all([bundledFontSources(fontsDir), kitFontSources(brand.kit, brand.files), kitLogoUrls(brand.kit, brand.files), installed ? installedFamilies() : Promise.resolve(new Set<string>())]);
  const have = new Set([...base, ...kit].map((s) => familyKey(s.family)));
  const available = (family: string) => have.has(familyKey(family)) || system.has(familyKey(family));
  return { sources: [...base, ...kit], kitCss: fontFaceRules(kit), logos, available, kitMissing: (brand.kit?.fonts ?? []).map((f) => f.family).filter((f) => !available(f)) };
}
