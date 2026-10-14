// D201: what Finder put on the clipboard when the user copied files or folders, as absolute paths.
// macOS keeps the first item as a `public.file-url` and every item in the legacy
// `NSFilenamesPboardType` property list; both are read, each path once, in order.
import { fileURLToPath } from "node:url";

/** The plist's <string> entries (XML-unescaped). */
const plistStrings = (xml: string) =>
  [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"));

/** The absolute paths from file URLs (one a line) and an NSFilenamesPboardType plist (either may be ""). */
export function pastedPaths(fileUrl: string, filenames: string): Array<string> {
  const out: Array<string> = [];
  const add = (p: string) => {
    const clean = p.length > 1 ? p.replace(/\/+$/, "") : p;
    if (clean.startsWith("/") && !out.includes(clean)) out.push(clean);
  };
  for (const p of plistStrings(filenames)) add(p);
  for (const line of fileUrl.split(/[\r\n\0]+/)) {
    const url = line.trim();
    if (!url.startsWith("file://")) continue;
    try {
      add(fileURLToPath(url));
    } catch {}
  }
  return out;
}

/** A clipboard entry as Electron 44's clipboard.read() gives it (W3C-like, async). */
interface Entry {
  readonly types: ReadonlyArray<string>;
  getType(type: string): Promise<unknown>;
}
const raw = (format: string) => `electron application/osclipboard;format="${format}"`;

/** Finder's copied files from the clipboard's entries: each one's file URL (raw `public.file-url` or text/uri-list) and the filenames plist. */
export async function clipboardPaths(entries: ReadonlyArray<Entry>): Promise<Array<string>> {
  const text = async (entry: Entry, type: string) => {
    try {
      const got = await entry.getType(type);
      return typeof got === "string" ? got : got && typeof (got as Blob).text === "function" ? await (got as Blob).text() : "";
    } catch {
      return "";
    }
  };
  let urls = "";
  let filenames = "";
  for (const entry of entries) {
    urls += `\n${await text(entry, raw("public.file-url"))}`;
    if (entry.types.includes("text/uri-list")) urls += `\n${await text(entry, "text/uri-list")}`;
    filenames += await text(entry, raw("NSFilenamesPboardType"));
  }
  return pastedPaths(urls, filenames);
}
