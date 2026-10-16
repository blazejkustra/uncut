// D259 (#94): the pure parts of Import from link: checking the link, the yt-dlp arguments, its
// output lines and its errors in plain words, and the file and media names from the title.
// No shell anywhere: these are argv entries for spawn.
import type { LinkKind, LinkQuality } from "@uncut/contracts";

/** Where a link's download lands in the project. */
export const LINKS_DIR = "media/links";
/** Markers on the lines yt-dlp prints for us (--print, --progress-template). */
export const TITLE_MARK = "UNCUT_TITLE ";
export const FILE_MARK = "UNCUT_FILE ";
export const PROGRESS_MARK = "UNCUT_PROGRESS ";
const MAX_URL = 2048;

/** The link, checked: http(s) with a host, no password in it, not too long. Else why not, in words. */
export function checkLink(raw: unknown): { readonly url: string } | { readonly problem: string } {
  if (typeof raw !== "string" || !raw.trim()) return { problem: "Paste a link first." };
  const text = raw.trim();
  if (text.length > MAX_URL) return { problem: "That link is too long." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { problem: "That isn't a link. It should start with https://" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: "Only http and https links can be imported." };
  if (!url.hostname) return { problem: "That link has no site in it." };
  if (url.username || url.password) return { problem: "Links with a user name or password in them can't be imported." };
  return { url: url.href };
}

/** D266: link.start runs only with the Labs flag on (the renderer sends it); else why not. */
export const labsRefusal = (request: { readonly labs?: boolean | undefined }): string | undefined =>
  request.labs === true ? undefined : "Import from link is a Labs feature: turn it on in Settings › Labs.";

/** The format choice: best ≤ the height cap, preferring MP4/H.264/AAC (what every part of Uncut reads); audio as m4a. */
export function formatArgs(kind: LinkKind, quality: LinkQuality): Array<string> {
  if (kind === "audio") return ["-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a"];
  const sort = quality === "best" ? "res,ext:mp4:m4a" : `res:${quality},vcodec:h264,acodec:aac,ext:mp4:m4a`;
  return ["-f", "bv*+ba/b", "-S", sort, "--merge-output-format", "mp4"];
}

/**
 * yt-dlp's arguments: no config files, one video (never a playlist), our own output name (the
 * title never becomes a path), title and final file printed with markers, progress as lines, and
 * the link last, after `--`. D266: the output template is only `<stem>.%(ext)s`, relative: yt-dlp
 * runs in the project's media/links folder (runYtDlp's cwd). yt-dlp expands $VARS and ~ in -o and
 * -P, so the project's path (a folder named "$HOME x") must never be in them.
 */
export function ytDlpArgs(o: { readonly url: string; readonly kind: LinkKind; readonly quality: LinkQuality; readonly stem: string; readonly ffmpeg?: string | undefined }): Array<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(o.stem)) throw new Error(`not a safe output stem: ${o.stem}`);
  return [
    "--ignore-config",
    "--no-playlist",
    "--no-overwrites",
    "--no-mtime",
    "--no-color",
    "--newline",
    "--progress",
    "--progress-template",
    `download:${PROGRESS_MARK}%(progress._percent_str)s`,
    "--no-simulate",
    "--print",
    `before_dl:${TITLE_MARK}%(title)s`,
    "--print",
    `after_move:${FILE_MARK}%(filepath)s`,
    ...formatArgs(o.kind, o.quality),
    ...(o.ffmpeg ? ["--ffmpeg-location", o.ffmpeg] : []),
    "-o",
    `${o.stem}.%(ext)s`,
    "--",
    o.url,
  ];
}

export type LinkLine = { readonly title: string } | { readonly file: string } | { readonly progress: number } | { readonly status: string };

/** One line of yt-dlp's stdout, read: our markers, or a step worth saying. */
export function parseLine(line: string): LinkLine | undefined {
  const l = line.replace(/\r/g, "").trim();
  if (l.startsWith(TITLE_MARK)) return { title: l.slice(TITLE_MARK.length).trim() };
  if (l.startsWith(FILE_MARK)) return { file: l.slice(FILE_MARK.length).trim() };
  if (l.startsWith(PROGRESS_MARK) || l.startsWith("[download]")) {
    const m = /(\d+(?:\.\d+)?)%/.exec(l);
    if (!m) return undefined;
    const p = Math.round(Number(m[1]) * 10) / 1000;
    return Number.isFinite(p) ? { progress: Math.max(0, Math.min(1, p)) } : undefined;
  }
  if (l.startsWith("[Merger]")) return { status: "Joining video and sound…" };
  if (l.startsWith("[ExtractAudio]")) return { status: "Making the m4a…" };
  if (l.startsWith("[VideoConvertor]") || l.startsWith("[FixupM3u8]") || l.startsWith("[Fixup")) return { status: "Finishing the file…" };
  return undefined;
}

/** yt-dlp's error output, in plain words. */
export function plainYtDlpError(stderr: string, code: number | null): string {
  const s = stderr;
  const has = (re: RegExp) => re.test(s);
  if (has(/Unsupported URL/i)) return "yt-dlp doesn't know how to import from that site.";
  if (has(/is not a valid URL|No video formats found|no suitable formats/i)) return "There's no video at that link that yt-dlp can import.";
  if (has(/Private video|members-only|This video is private/i)) return "That video is private, so it can't be imported.";
  if (has(/Sign in to confirm|age-restricted|confirm your age|login required|requires authentication|cookies/i)) return "The site wants you to sign in for that one, so it can't be imported.";
  if (has(/Video unavailable|has been removed|not available in your country|geo.?restrict/i)) return "That video isn't available (removed, or blocked where you are).";
  if (has(/Requested format is not available/i)) return "That quality isn't available for this video. Pick another one.";
  if (has(/HTTP Error 404|404: Not Found/i)) return "Nothing was found at that link (404).";
  if (has(/HTTP Error 403|403: Forbidden/i)) return "The site refused the download (403). Updating yt-dlp often fixes this: brew upgrade yt-dlp";
  if (has(/HTTP Error 429|Too Many Requests/i)) return "The site is limiting downloads right now. Try again later.";
  if (has(/ffmpeg (is )?not (found|installed)|ffprobe and ffmpeg not found|ffmpeg-location .* does not exist/i)) return "yt-dlp needs ffmpeg for this. Install it with: brew install ffmpeg";
  if (has(/Unable to download webpage|getaddrinfo|Name or service not known|nodename nor servname|Failed to resolve|timed out|Connection refused|Network is unreachable|No route to host/i)) return "Couldn't reach the site. Check the link and your connection.";
  if (has(/No space left on device/i)) return "The disk is full.";
  if (has(/max-filesize|File is larger than max-filesize/i)) return "The file is too big.";
  const last = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("ERROR:"))
    .pop();
  if (last) {
    const text = last.replace(/^ERROR:\s*/, "").replace(/^\[[^\]]+\]\s*[^:]*:\s*/, "").trim();
    if (text) return `yt-dlp couldn't import it: ${text.slice(0, 300)}`;
  }
  return code === null ? "yt-dlp stopped before it finished." : `yt-dlp stopped with an error (exit ${code}).`;
}

/** The media's name: the title, tidied and cut near 80 characters; " 2", " 3" when the project has it. */
export function linkMediaName(title: string | undefined, taken: ReadonlySet<string> = new Set(), fallback = "Imported link"): string {
  let base = (title ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (base.length > 80) {
    const cut = base.slice(0, 80);
    base = cut.includes(" ", 40) ? cut.slice(0, cut.lastIndexOf(" ")) : cut;
  }
  if (!/[\p{L}\p{N}]/u.test(base)) base = fallback;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  return name;
}

/** A file name stem from the title: letters, digits, spaces, dots, dashes, underscores and brackets; never hidden, never a path. */
export function linkFileStem(title: string | undefined): string {
  const stem = (title ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ._()\-]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.\-]+/, "")
    .trim()
    .slice(0, 80)
    .replace(/[\s.]+$/, "");
  return /[\p{L}\p{N}]/u.test(stem) ? stem : "link";
}
