// The Import from link plugin's yt-dlp side (D259, D266, D280): finding the user's own yt-dlp,
// its arguments, reading its output lines, its errors in plain words, and one download run with
// cancel. No shell anywhere: these are argv entries for spawn. Uncut never bundles or downloads
// yt-dlp. Self-contained (Node and nothing else): the folder is copied as is when it's installed.
import { spawn, type ChildProcess } from "node:child_process";
import { access, constants, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

export type LinkKind = "video" | "audio";
export type LinkQuality = "best" | "2160" | "1440" | "1080" | "720" | "480";
export const QUALITIES: ReadonlyArray<LinkQuality> = ["best", "2160", "1440", "1080", "720", "480"];

/** Markers on the lines yt-dlp prints for us (--print, --progress-template). */
export const TITLE_MARK = "UNCUT_TITLE ";
export const FILE_MARK = "UNCUT_FILE ";
export const PROGRESS_MARK = "UNCUT_PROGRESS ";
const MAX_URL = 2048;
const STDERR_KEEP = 64 * 1024;
/** The output stem Uncut passes: ours, never the title, never a path ($VARS and ~ can't be in it). */
export const SAFE_STEM = /^[A-Za-z0-9_-]+$/;

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

/** The format choice: best ≤ the height cap, preferring MP4/H.264/AAC (what every part of Uncut reads); audio as m4a. */
export function formatArgs(kind: LinkKind, quality: LinkQuality): Array<string> {
  if (kind === "audio") return ["-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a"];
  const sort = quality === "best" ? "res,ext:mp4:m4a" : `res:${quality},vcodec:h264,acodec:aac,ext:mp4:m4a`;
  return ["-f", "bv*+ba/b", "-S", sort, "--merge-output-format", "mp4"];
}

/**
 * yt-dlp's arguments: no config files, no cookies (nothing signed in), one video (never a
 * playlist), our own output name (the title never becomes a path), title and final file printed
 * with markers, progress as lines, and the link last, after `--`. D266: the output template is
 * only `<stem>.%(ext)s`, relative: yt-dlp runs in the project's media/links folder (runYtDlp's
 * cwd). yt-dlp expands $VARS and ~ in -o and -P, so the project's path must never be in them.
 */
export function ytDlpArgs(o: {
  readonly url: string;
  readonly kind: LinkKind;
  readonly quality: LinkQuality;
  readonly stem: string;
  readonly ffmpeg?: string | undefined;
}): Array<string> {
  if (!SAFE_STEM.test(o.stem)) throw new Error(`not a safe output stem: ${o.stem}`);
  return [
    "--ignore-config",
    "--no-cookies",
    "--no-cookies-from-browser",
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

/** yt-dlp's error output, in plain words. Anything behind a sign-in is refused, never worked around. */
export function plainYtDlpError(stderr: string, code: number | null): string {
  const s = stderr;
  const has = (re: RegExp) => re.test(s);
  if (has(/Unsupported URL/i)) return "yt-dlp doesn't know how to import from that site.";
  if (has(/is not a valid URL|No video formats found|no suitable formats/i)) return "There's no video at that link that yt-dlp can import.";
  if (has(/Private video|members-only|This video is private/i)) return "That video is private, so it can't be imported.";
  if (has(/Sign in to confirm|age-restricted|confirm your age|login required|requires authentication|cookies|log in|logged.in|premium members/i))
    return "The site wants you to sign in for that one, so it can't be imported.";
  if (has(/Video unavailable|has been removed|not available in your country|geo.?restrict/i))
    return "That video isn't available (removed, or blocked where you are).";
  if (has(/Requested format is not available/i)) return "That quality isn't available for this video. Pick another one.";
  if (has(/HTTP Error 404|404: Not Found/i)) return "Nothing was found at that link (404).";
  if (has(/HTTP Error 403|403: Forbidden/i)) return "The site refused the download (403). Updating yt-dlp often fixes this: brew upgrade yt-dlp";
  if (has(/HTTP Error 429|Too Many Requests/i)) return "The site is limiting downloads right now. Try again later.";
  if (has(/ffmpeg (is )?not (found|installed)|ffprobe and ffmpeg not found|ffmpeg-location .* does not exist/i))
    return "yt-dlp needs ffmpeg for this. Install it with: brew install ffmpeg";
  if (
    has(
      /Unable to download webpage|getaddrinfo|Name or service not known|nodename nor servname|Failed to resolve|timed out|Connection refused|Network is unreachable|No route to host/i,
    )
  )
    return "Couldn't reach the site. Check the link and your connection.";
  if (has(/No space left on device/i)) return "The disk is full.";
  if (has(/max-filesize|File is larger than max-filesize/i)) return "The file is too big.";
  const last = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("ERROR:"))
    .pop();
  if (last) {
    const text = last
      .replace(/^ERROR:\s*/, "")
      .replace(/^\[[^\]]+\]\s*[^:]*:\s*/, "")
      .trim();
    if (text) return `yt-dlp couldn't import it: ${text.slice(0, 300)}`;
  }
  return code === null ? "yt-dlp stopped before it finished." : `yt-dlp stopped with an error (exit ${code}).`;
}

/** The first executable `name` in a PATH-like list of folders. */
export async function which(name: string, path: string): Promise<string | undefined> {
  for (const dir of path.split(":")) {
    if (!dir || !dir.startsWith("/")) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}

/** `yt-dlp --version`'s number, if it answers within 10 s. */
export const versionOf = (bin: string, env: NodeJS.ProcessEnv) =>
  new Promise<string | undefined>((resolve) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(bin, ["--version"], { env, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve(undefined);
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.stdout?.on("data", (c: Buffer) => (out = (out + c.toString("utf8")).slice(0, 4096)));
    child.on("error", () => (clearTimeout(timer), resolve(undefined)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? /\d+(?:\.\d+)+[\w.-]*/.exec(out)?.[0]?.slice(0, 32) : undefined);
    });
  });

/** Whether any process of the group led by `pid` is still there. */
const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Every yt-dlp process group running now (killed when the plugin exits, so none is orphaned). */
export const running = new Set<ChildProcess>();

const signalGroup = (child: ChildProcess, s: NodeJS.Signals) => {
  try {
    if (child.pid) process.kill(-child.pid, s);
  } catch {
    try {
      child.kill(s);
    } catch {}
  }
};

/** Kills a detached child's whole process group: TERM, then KILL if it's still there. */
const killTree = (child: ChildProcess) => {
  signalGroup(child, "SIGTERM");
  // The group, not just the leader: an ffmpeg can outlive yt-dlp (D266).
  setTimeout(
    () => ((child.exitCode === null && child.signalCode === null) || (child.pid && groupAlive(child.pid))) && signalGroup(child, "SIGKILL"),
    3000,
  ).unref();
};

/** SIGKILL to every yt-dlp group still running (the plugin is exiting). */
export const killAll = () => {
  for (const child of running) signalGroup(child, "SIGKILL");
};

/** Waits (up to `ms`) for a process group to be gone: yt-dlp's ffmpeg can outlive it and still write. */
const groupGone = async (pid: number | undefined, ms: number) => {
  if (!pid) return;
  const until = Date.now() + ms;
  while (groupAlive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
};

/**
 * Runs yt-dlp in `cwd` (the output folder: its -o is relative), handing each output line to
 * `onLine`; resolves with its exit code and the tail of stderr once its whole process group is
 * gone (D266: an ffmpeg that outlives a cancelled yt-dlp can't leave a .temp after the cleanup).
 */
export const runYtDlp = (
  bin: string,
  args: ReadonlyArray<string>,
  onLine: (line: string) => void,
  signal: AbortSignal,
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
) =>
  new Promise<{ code: number | null; stderr: string; spawnError?: string }>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, [...args], { env, stdio: ["ignore", "pipe", "pipe"], detached: true, ...(cwd ? { cwd } : {}) });
    } catch (e) {
      return resolve({ code: null, stderr: "", spawnError: (e as Error).message });
    }
    running.add(child);
    let stderr = "";
    const lines = (onChunk: (text: string) => void) => {
      let buffer = "";
      return (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const parts = buffer.split(/\r?\n|\r/);
        buffer = parts.pop() ?? "";
        for (const p of parts) onChunk(p);
        if (buffer.length > 16384) buffer = buffer.slice(-16384);
      };
    };
    child.stdout?.on("data", lines(onLine));
    child.stderr?.on(
      "data",
      lines((l) => {
        stderr = (stderr + l + "\n").slice(-STDERR_KEEP);
        onLine(l);
      }),
    );
    const onAbort = () => killTree(child);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.on("error", (e) => {
      signal.removeEventListener("abort", onAbort);
      running.delete(child);
      resolve({ code: null, stderr, spawnError: e.message });
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      // The SIGKILL comes 3 s after a cancel's SIGTERM: a little longer than that.
      void groupGone(child.pid, signal.aborted ? 4000 : 1000).then(() => {
        running.delete(child);
        resolve({ code, stderr });
      });
    });
  });

/** A job's temporary files in its folder (yt-dlp's parts, fragments and the unrenamed result). */
export const removePartials = async (folder: string, stem: string) => {
  if (!SAFE_STEM.test(stem)) return;
  const files = await readdir(folder).catch(() => [] as Array<string>);
  await Promise.all(files.filter((f) => f.startsWith(`${stem}.`)).map((f) => rm(join(folder, f), { force: true, recursive: true })));
};

export interface DownloadInput {
  readonly url: string;
  readonly kind: LinkKind;
  readonly quality: LinkQuality;
  /** The folder it lands in (Uncut's project media/links, checked by Uncut); yt-dlp runs there. */
  readonly folder: string;
  /** Our output name, `<stem>.<ext>`: [A-Za-z0-9_-] only. */
  readonly stem: string;
  /** Where to look for yt-dlp and ffmpeg (Uncut's PATH plus the Homebrew folders). */
  readonly searchPath: string;
}

export type DownloadResult =
  | { readonly ok: true; readonly file: string; readonly title?: string | undefined }
  | { readonly ok: false; readonly error: string; readonly cancelled?: boolean };

/**
 * One download: yt-dlp with ytDlpArgs into `folder`, progress and steps to `onProgress`; the
 * finished file (only ours, in the folder) and the title. A failure or a cancel removes the
 * partial files once yt-dlp's whole process group is gone.
 */
export async function download(input: DownloadInput, signal: AbortSignal, onProgress: (progress: number, status?: string) => void): Promise<DownloadResult> {
  const checked = checkLink(input.url);
  if ("problem" in checked) return { ok: false, error: checked.problem };
  if (input.kind !== "video" && input.kind !== "audio") return { ok: false, error: "Pick Video or Audio only." };
  if (!QUALITIES.includes(input.quality)) return { ok: false, error: "That quality isn't one Uncut offers." };
  if (!SAFE_STEM.test(input.stem)) return { ok: false, error: "Not a safe file name." };
  if (!isAbsolute(input.folder) || !(await stat(input.folder).catch(() => undefined))?.isDirectory())
    return { ok: false, error: "The folder to import into isn't there." };
  const folder = await realpath(input.folder);
  const bin = await which("yt-dlp", input.searchPath);
  if (!bin) return { ok: false, error: "yt-dlp isn't installed. Install it with: brew install yt-dlp" };
  const ffmpeg = await which("ffmpeg", input.searchPath);
  const env = { ...process.env, PATH: input.searchPath };
  let title: string | undefined;
  let printed: string | undefined;
  let last = 0;
  const result = await runYtDlp(
    bin,
    ytDlpArgs({ url: checked.url, kind: input.kind, quality: input.quality, stem: input.stem, ffmpeg }),
    (line) => {
      const read = parseLine(line);
      if (!read) return;
      if ("title" in read) title = read.title;
      else if ("file" in read) printed = read.file;
      else if ("progress" in read) onProgress((last = read.progress));
      else onProgress(last, read.status);
    },
    signal,
    folder,
    env,
  );
  const fail = async (error: string, cancelled = false): Promise<DownloadResult> => {
    await removePartials(folder, input.stem);
    return { ok: false, error, ...(cancelled ? { cancelled } : {}) };
  };
  if (signal.aborted) return fail("Cancelled.", true);
  if (result.spawnError) return fail(`yt-dlp couldn't be started: ${result.spawnError}`);
  if (result.code !== 0) return fail(plainYtDlpError(result.stderr, result.code));
  // The finished file: the one yt-dlp printed (only if it's ours, in the folder), else ours by name.
  const ours = (p: string) => dirname(p) === folder && basename(p).startsWith(`${input.stem}.`) && !/\.(part|ytdl|temp)$/.test(p);
  let made: string | undefined;
  if (printed) {
    const real = await realpath(isAbsolute(printed) ? printed : join(folder, printed)).catch(() => undefined);
    if (real && ours(real) && (await stat(real).catch(() => undefined))?.isFile()) made = real;
  }
  if (!made) {
    const files = (await readdir(folder).catch(() => [] as Array<string>)).filter(
      (f) => f.startsWith(`${input.stem}.`) && !/\.f\d+\./.test(f) && !/\.(part|ytdl|temp)$/.test(f),
    );
    if (files.length === 1) made = join(folder, files[0]!);
  }
  if (!made) return fail("yt-dlp finished but no file came out.");
  return { ok: true, file: made, ...(title ? { title } : {}) };
}
