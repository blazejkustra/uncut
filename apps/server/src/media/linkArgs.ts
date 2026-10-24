// D259 (#94), D280: Uncut's side of Import from link: checking the link before the plugin runs
// and the file and media names from the title. yt-dlp's arguments, output and errors are the
// plugin's (plugins/catalog/uncut-link-import/ytdlp.ts), which checks the link again.

/** Where a link's download lands in the project. */
export const LINKS_DIR = "media/links";
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

/** The media's name: the title, tidied and cut near 80 characters; " 2", " 3" when the project has it. */
export function linkMediaName(title: string | undefined, taken: ReadonlySet<string> = new Set(), fallback = "Imported link"): string {
  let base = (title ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    .replace(/[^\p{L}\p{N} ._()-]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.-]+/, "")
    .trim()
    .slice(0, 80)
    .replace(/[\s.]+$/, "");
  return /[\p{L}\p{N}]/u.test(stem) ? stem : "link";
}
