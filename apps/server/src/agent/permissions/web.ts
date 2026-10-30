// D219: secret-looking strings in web addresses.
/** A secret-looking string: 20+ letters, digits and token characters, with both letters and digits. */
export const SECRETISH = /(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{20,}/;

/** D219: well-known credential shapes (API keys, tokens, JWTs, private keys). */
const KNOWN_SECRET =
  /(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}|-----BEGIN|ssh-(?:rsa|ed25519) AAAA)/;

/**
 * D311: a secret's value on a card. It ends at any shell metacharacter, so a card never hides a
 * pipe, redirect or next command, and never starts with @ or - (a file to upload, a flag).
 */
const METACHARACTERS = String.raw`\s"'&;|<>()$\x60\\`;
const VALUE = `[^${METACHARACTERS}@-][^${METACHARACTERS}]*`;
const AUTH_HEADER = new RegExp(String.raw`\b(authorization["']?\s*[:=]\s*["']?(?:[A-Za-z][\w-]*\s+)?)${VALUE}`, "gi");
const NAMED_SECRET = new RegExp(
  String.raw`(?<![\w-])([\w-]*(?:api[-_]?key|access[-_]?key|secret(?:[-_]?key)?|token|passw(?:or)?d)["']?\s*[:=]\s*["']?)${VALUE}`,
  "gi",
);
const CURL_USER = new RegExp(String.raw`(\bcurl\b[^;|\n]*?\s(?:-[a-zA-Z]*u\s*|--user[\s=]+)["']?[^\s:"']+:)${VALUE}`, "g");
/** Not inside a word or a path, and not where a command's name goes. */
const SHOWN_SECRET = new RegExp(String.raw`(?<![\w./-]|[;|&(\x60]\s*|^\s*)(?:sk_[A-Za-z0-9]{16,}|${KNOWN_SECRET.source})`, "gm");

/** D311: text for a card with what looks like a key hidden; the command claude runs stays whole. */
export const hideSecrets = (text: string) =>
  text.replace(AUTH_HEADER, "$1•••").replace(NAMED_SECRET, "$1•••").replace(CURL_USER, "$1•••").replace(SHOWN_SECRET, "•••");

/**
 * D219: a run that reads as encoded data: 40+ token characters (between slashes, dots and the
 * like) mixing upper case, lower case and digits, with few dashes. Hex (a commit SHA), UUIDs and
 * slugs ("React-Native-0-74-Release-Notes") aren't.
 */
const encodedRun = (text: string) =>
  (text.match(/[A-Za-z0-9+=_-]{40,}/g) ?? []).some(
    (run) => /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) && !/^[0-9a-f-]+$/i.test(run) && (run.match(/-/g)?.length ?? 0) <= run.length / 8,
  );

/**
 * D219: why a WebFetch address may carry data out (a card), or undefined for an ordinary page. Only
 * what's sent counts (host, path and query; not the #fragment), decoded: longer than 200
 * characters, a credential-shaped string, a run of encoded data (a commit SHA, a UUID or a
 * slug isn't one), or a host name with a long encoded label (DNS exfiltration). Docs, repos,
 * videos and package pages pass.
 */
export function webAddressProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      return s;
    }
  };
  const sent = `${url.host}${url.pathname}${url.search}`;
  const text = decode(`${url.pathname}${url.search}`);
  if (sent.length > 200) return "The address is unusually long; it could carry data out.";
  if (KNOWN_SECRET.test(text) || KNOWN_SECRET.test(sent)) return "The address carries a secret-looking string.";
  // A Google Docs/Drive/Sheets file id (/d/<44 characters>/) is an id, not data (the query still counts).
  const ids = /(^|\.)google\.com$/i.test(url.hostname) ? decode(url.pathname).replace(/\/d\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/d/id") + decode(url.search) : text;
  if (encodedRun(ids)) return "The address carries a long run of encoded data.";
  const labels = url.hostname.split(".").slice(0, -2);
  // A long label of letters and digits (hex, base32), not a dashed name like my-bucket-2024-prod.
  if (labels.some((l) => l.length >= 40 || (l.length >= 24 && !l.includes("-") && /\d/.test(l) && /[a-z]/i.test(l))))
    return "The address's host name carries a long encoded part.";
  return undefined;
}
