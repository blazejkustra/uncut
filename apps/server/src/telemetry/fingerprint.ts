// Crash fingerprints (issue #13, D223): the same crash on every machine gets the same 16 hex,
// and nothing in it identifies the user. Only the top 8 stack frames count, each reduced to its
// function name and the file's base name with line and column (bundles are minified, so the
// position is what tells frames apart); folders, the home path, URLs' hosts and queries, and the
// error's message never go into the hash. Shared with the desktop's main process (crashReports.ts).
import { createHash } from "node:crypto";

const FRAMES = 8;

/** One V8 stack line ("    at fn (file:line:col)" / "    at file:line:col") or a Safari/Firefox one ("fn@file:line:col"), de-identified. */
export function frameOf(line: string): string | undefined {
  const v8 = /^\s*at\s+(?:(.*?)\s+\()?(.*?)\)?\s*$/.exec(line);
  const gecko = v8 ? undefined : /^\s*([^@\s]*)@(\S+)$/.exec(line);
  const m = v8 ?? gecko;
  if (!m) return undefined;
  const fn = (m[1] ?? "")
    .replace(/^async\s+/, "")
    .replace(/[^\w.$<>[\]-]/g, "")
    .slice(0, 80);
  const where = m[2] ?? "";
  // file:line:col, possibly a URL with a query or hash; keep the base name and the position.
  const pos = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(where.replace(/[?#][^:]*/, ""));
  const file =
    (pos?.[1] ?? "")
      .split(/[\\/]/)
      .pop()
      ?.replace(/[^\w.-]/g, "")
      .slice(0, 80) ?? "";
  if (!fn && !file) return undefined;
  return `${fn}@${file}:${pos?.[2] ?? ""}:${pos?.[3] ?? ""}`;
}

/** SHA-256 over the error's name and its top de-identified frames, as 16 hex. */
export function crashFingerprint(name: string, stack: string | undefined): string {
  const lines = (stack ?? "").split("\n");
  // A V8 stack starts with the message (which may span lines): only its "at" lines are frames.
  const v8 = lines.some((l) => /^\s*at\s/.test(l));
  const frames = lines
    .filter((l) => (v8 ? /^\s*at\s/.test(l) : l.includes("@")))
    .map(frameOf)
    .filter((f): f is string => f !== undefined)
    .slice(0, FRAMES);
  return createHash("sha256")
    .update([name, ...frames].join("\n"))
    .digest("hex")
    .slice(0, 16);
}

/** An error's class name, safe to send: the constructor's name if it is a plain identifier, else "Error". */
export function errorNameOf(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) ? name : "Error";
}

/** err.code when it's a plain code (ENOENT, ERR_...), never anything longer. */
export function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : undefined;
}
