const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;
const WEB_LINK = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const MARKUP = /[@<>`[\]!|]/g;
const EM_DASH = new RegExp(`\\s*${String.fromCodePoint(0x2014)}\\s*`, "g");

function clamp(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

/** One line of untrusted text that can be posted without mentioning anyone or rendering markup. */
export function plainLine(text: string, max: number) {
  const flat = text.replace(WEB_LINK, "(link removed)").replace(MARKUP, "").replace(EM_DASH, ", ").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return clamp(flat, max);
}

export function slugOf(title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug || "issue";
}

export function tail(text: string, max: number) {
  return text.length > max ? text.slice(-max) : text;
}

/** The first `{` through the last `}`, so prose or a fence around the JSON is harmless. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
