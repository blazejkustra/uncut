// Bringing logos and fonts into a brand kit (D198, issue #35): from a file, a folder or a web
// address. A path may start with ~ or $HOME (paths.ts expandHome). A folder gives its logo pictures
// and font files (not hidden ones, not its subfolders, at most MAX_FOLDER_FILES); a web address goes
// through media_download's guarded GET (agentDownload.ts: https and public addresses only, every
// redirect checked, the bytes must be the format's own, an SVG must be plain drawing) into a temp
// folder first. Each file is copied into the kit's folder under a free name (addKitFile). Logos get
// the slot their name suggests (mark, dark or light); SVG stays SVG (graphics draw it as vector,
// brand_read shows the agent a rasterised PNG of it).
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import type { BrandScope } from "@uncut/contracts";

import { BRAND_DOWNLOAD_TYPES, downloadToFolder, sniff } from "../agent/agentDownload.ts";
import { expandHome } from "../paths.ts";
import { addKitFile, FONT_EXT, LOGO_EXT, type BrandDirs } from "./store.ts";

export type LogoSlot = "light" | "dark" | "mark";
export interface ImportedFile {
  /** Its name in the kit's folder. */
  readonly name: string;
  readonly kind: "logo" | "font";
  /** For a logo: the slot its name suggests. */
  readonly slot?: LogoSlot;
  /** For a font: the family its name suggests ("Inter" from Inter-Bold.woff2). */
  readonly family?: string;
}

/** The most files one folder import takes. */
export const MAX_FOLDER_FILES = 24;
/** The most a downloaded kit file may be (bytes). */
const MAX_DOWNLOAD = 50 * 1024 * 1024;

/** The slot a logo's file name suggests: a mark (icon, symbol, favicon), the version for dark backgrounds (white, inverse), else the one for light ones. */
export function logoSlot(name: string): LogoSlot {
  const n = basename(name, extname(name)).toLowerCase();
  if (/(^|[^a-z])(mark|logomark|icon|symbol|glyph|favicon|avatar|monogram)([^a-z]|$)/.test(n)) return "mark";
  if (/(^|[^a-z])(dark|white|inverse|inverted|negative|reversed|knockout|on-?dark|for-?dark)([^a-z]|$)/.test(n)) return "dark";
  return "light";
}

/** The family a font file's name suggests: "Inter-SemiBold.woff2" → "Inter", "dm_sans_regular.ttf" → "Dm Sans". */
export function fontFamilyOf(name: string): string {
  const stem = basename(name, extname(name))
    .replace(/[-_ ](thin|hairline|extra-?light|ultra-?light|light|regular|book|normal|medium|semi-?bold|demi-?bold|bold|extra-?bold|ultra-?bold|black|heavy|italic|oblique|variable|vf|var|wght|\d{3})([-_ ].*)?$/i, "")
    .replace(/\[.*\]$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
  return stem
    .split(/\s+/)
    .map((w) => (w.length <= 2 && w === w.toLowerCase() ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ")
    .slice(0, 80);
}

const kindOf = (name: string): ImportedFile["kind"] | undefined => {
  const ext = extname(name).toLowerCase();
  return LOGO_EXT.has(ext) ? "logo" : FONT_EXT.has(ext) ? "font" : undefined;
};

const described = (name: string): ImportedFile => {
  const kind = kindOf(name)!;
  return kind === "logo" ? { name, kind, slot: logoSlot(name) } : { name, kind, family: fontFamilyOf(name) };
};

/**
 * Copies the logos and fonts `source` points at (a path, a folder or an https address) into the
 * kit's folder; the files as named there, or why nothing came in.
 */
export async function importIntoKit(dirs: BrandDirs, kitId: string, scope: BrandScope, source: string, signal: AbortSignal = new AbortController().signal): Promise<{ readonly files: ReadonlyArray<ImportedFile> } | { readonly problem: string }> {
  const raw = source.trim();
  if (!raw) return { problem: "Give a file, a folder or a web address." };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // http only gets as far as the guarded GET, which takes https alone outside tests (net.ts urlProblem).
    if (!/^https?:\/\//i.test(raw)) return { problem: `${raw.slice(0, 120)} isn't an https address.` };
    const temp = await mkdtemp(join(tmpdir(), "uncut-brand-"));
    try {
      const got = await downloadToFolder(raw, temp, undefined, signal, MAX_DOWNLOAD, BRAND_DOWNLOAD_TYPES);
      if ("problem" in got) return { problem: got.problem };
      return { files: [described(await addKitFile(dirs, kitId, scope, got.path))] };
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => {});
    }
  }
  const path = expandHome(raw);
  if (!path.startsWith("/")) return { problem: `"${raw.slice(0, 200)}" isn't a full path. Pass one like ~/Downloads/logo.svg or /Users/you/brand.` };
  const info = await stat(path).catch(() => undefined);
  if (!info) return { problem: `There's nothing at ${raw.slice(0, 200)}.` };
  const take = async (file: string) => {
    if (extname(file).toLowerCase() === ".svg") {
      const wrong = await sniff(file, ".svg");
      if (wrong) throw new Error(`${basename(file)}: ${wrong}`);
    }
    return described(await addKitFile(dirs, kitId, scope, file));
  };
  try {
    if (info.isFile()) {
      if (!kindOf(path)) return { problem: `${basename(path)} isn't a logo picture (SVG, PNG, JPEG, WebP, GIF) or a font file (WOFF2, WOFF, TTF, OTF).` };
      return { files: [await take(path)] };
    }
    if (!info.isDirectory()) return { problem: `${raw.slice(0, 200)} isn't a file or a folder.` };
    const names = (await readdir(path)).filter((n) => !n.startsWith(".") && kindOf(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!names.length) return { problem: `${raw.slice(0, 200)} has no logo pictures or font files.` };
    const files: Array<ImportedFile> = [];
    for (const n of names.slice(0, MAX_FOLDER_FILES)) {
      const st = await stat(join(path, n)).catch(() => undefined);
      if (!st?.isFile()) continue;
      files.push(await take(join(path, n)));
    }
    return { files };
  } catch (error) {
    return { problem: (error as Error).message };
  }
}

/** Fills empty logo slots from imported logos (the first that suggests each slot; a lone logo takes "light"). */
export function fillLogos(logos: Partial<Record<LogoSlot, string>>, files: ReadonlyArray<ImportedFile>): Partial<Record<LogoSlot, string>> {
  const out = { ...logos };
  for (const f of files) if (f.kind === "logo" && f.slot && !out[f.slot]) out[f.slot] = f.name;
  return out;
}
