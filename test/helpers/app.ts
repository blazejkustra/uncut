// Launches an Uncut desktop build with DevTools exposed and connects puppeteer to its window.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// node --test runs test files in parallel. Several packaged apps starting at once can starve
// each other on a busy machine, so the Electron test files
// take turns: each holds a lock from its before() to its after(). Hooks have no timeout, so
// waiting doesn't eat into any test's own timeout; the wait itself gives up after 10 minutes.
//
// The lock is one file created atomically (open "wx") holding the owner's pid and process
// start time. It is stale when that process is gone (EPERM counts as alive), when the pid now
// belongs to a different process (start time differs), or when it can't be read and is older
// than a short grace period (a writer that died mid-write). A stale lock is renamed away to a
// unique name before deletion, and we only own the lock if our own create succeeds.
const LOCK = "test-output/.app-lock";
const GRACE_MS = 5000;

const startTimeOf = (pid: number) => {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const myStart = startTimeOf(process.pid);

/** Who holds the lock and whether that holder is gone. Exported for the lock's own tests. */
export interface LockHolder {
  pid: number;
  start?: string;
}

export function inspectLock(path = LOCK): { exists: false; holder?: undefined; stale?: undefined } | { exists: true; holder: LockHolder | undefined; stale: boolean } {
  let text: string;
  let mtime: number;
  try {
    text = readFileSync(path, "utf8");
    mtime = statSync(path).mtimeMs;
  } catch {
    return { exists: false };
  }
  let holder: LockHolder | undefined;
  try {
    holder = JSON.parse(text);
  } catch {}
  if (!holder || !Number.isInteger(holder.pid)) return { exists: true, holder: undefined, stale: Date.now() - mtime > GRACE_MS };
  const stale = !alive(holder.pid) || (holder.start !== undefined && startTimeOf(holder.pid) !== holder.start);
  return { exists: true, holder, stale };
}

// Ctrl-C or a kill during a test run must not leave apps, mounts or temp files behind: every
// spawned app is tracked from the moment it starts, test files register their own cleanups,
// and SIGINT/SIGTERM runs all of it (synchronously) before exiting.
const launched = new Set<ChildProcess>();
const cleanups = new Set<() => void>();
let handlersInstalled = false;
/** Run `fn` (synchronously) if the test process is interrupted. Returns an unregister function. */
export function onInterrupt(fn: () => void) {
  installInterruptHandlers();
  cleanups.add(fn);
  return () => cleanups.delete(fn);
}
function installInterruptHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      for (const proc of launched) {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
      for (const fn of cleanups) {
        try {
          fn();
        } catch {}
      }
      unlockApps();
      process.exit(130);
    });
  }
}

export async function lockApps({ path = LOCK, timeoutMs = 10 * 60 * 1000 } = {}) {
  installInterruptHandlers();
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, start: myStart }));
      closeSync(fd);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const lock = inspectLock(path);
    if (lock.exists && lock.stale) {
      const aside = `${path}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
      try {
        renameSync(path, aside);
        rmSync(aside, { force: true });
      } catch {}
      continue;
    }
    if (Date.now() > deadline) {
      const who = lock.holder ? `pid ${lock.holder.pid} (started ${lock.holder.start ?? "?"})` : "an unknown process";
      throw new Error(`Waited ${Math.round(timeoutMs / 1000)} s for the Electron test lock (${path}) held by ${who}. Remove the file if that process is not a test run.`);
    }
    await sleep(200);
  }
}

export function unlockApps({ path = LOCK } = {}) {
  const lock = inspectLock(path);
  if (lock.holder?.pid === process.pid && lock.holder.start === myStart) rmSync(path, { force: true });
}

/**
 * `firstLaunch`: leave onboarding to show (otherwise a fresh UNCUT_DATA_DIR is marked as
 * onboarded, so tests about other screens aren't covered by the wizard).
 * `cleanEnv`: start from only `env` (what launchd gives a Finder-launched app), not the test's environment.
 */
/** A TCP port nothing is listening on right now (the OS picks it). */
export const freePort = () =>
  new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolvePort(port));
    });
  });

/** The pid listening on a local TCP port, if any. */
const listenerPid = (port: number) => {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  return r.stdout.trim().split("\n").filter(Boolean).map(Number);
};

export interface LaunchOptions {
  command: string;
  args?: ReadonlyArray<string>;
  env?: NodeJS.ProcessEnv;
  port?: number;
  firstLaunch?: boolean;
  cleanEnv?: boolean;
}

export interface LaunchedApp {
  page: Page;
  browser: Browser;
  proc: ChildProcess;
  errors: Array<string>;
  close: () => Promise<void>;
  exited: Promise<unknown>;
  output: () => string;
}

/** Why a launch failed before the app's window was there, and whether trying once more makes sense. */
class LaunchFailure extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

// How long the app may take to open its DevTools port: a loaded machine (a full test run, an
// export in another test) can take well over the old 20 s.
const CONNECT_TIMEOUT_MS = Number(process.env.UNCUT_TEST_LAUNCH_MS ?? 60000);

/**
 * Starts the packaged app and attaches to its window. When it fails, the error says why: the exit
 * code or signal and how soon, or that the DevTools port never opened (and the process is still
 * running), with what it printed. A launch is tried again once, and only when no window ever
 * opened and it didn't crash (it timed out, or quit cleanly before a window, e.g. while another
 * test's app was still letting go of the single-instance lock); a crash is reported at once.
 */
export async function launchApp(options: LaunchOptions): Promise<LaunchedApp> {
  try {
    return await launchOnce(options);
  } catch (error) {
    if (!(error instanceof LaunchFailure) || !error.retryable) throw error;
    console.log(`# launchApp: trying once more (${error.message.split("\n")[0]})`);
    await sleep(1000);
    try {
      return await launchOnce(options);
    } catch (again) {
      if (again instanceof Error) again.message = `${again.message}\n(the first try: ${error.message.split("\n")[0]})`;
      throw again;
    }
  }
}

async function launchOnce({ command, args = [], env: extra = {}, port: requested, firstLaunch = false, cleanEnv = false }: LaunchOptions): Promise<LaunchedApp> {
  const port = requested ?? (await freePort());
  // Background by default so test runs don't pop windows over the user's work; UNCUT_TEST_VISIBLE=1 to watch.
  const background = process.env.UNCUT_TEST_VISIBLE === "1" ? {} : { UNCUT_TEST_BACKGROUND: "1" };
  const env: NodeJS.ProcessEnv = { ...(cleanEnv ? {} : process.env), ...background, ...extra, UNCUT_CDP: String(port) };
  if (extra.UNCUT_DATA_DIR && !firstLaunch && !existsSync(join(extra.UNCUT_DATA_DIR, "settings.json"))) {
    mkdirSync(extra.UNCUT_DATA_DIR, { recursive: true });
    writeFileSync(join(extra.UNCUT_DATA_DIR, "settings.json"), JSON.stringify({ onboarded: true }));
  }
  delete env.VITE_DEV_SERVER_URL;
  installInterruptHandlers();
  const startedAt = Date.now();
  const proc = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  launched.add(proc);
  proc.once("exit", () => launched.delete(proc));
  let ended: { code: number | null; signal: NodeJS.Signals | null; at: number } | undefined;
  let spawnError: Error | undefined;
  const exited = new Promise((r) =>
    proc.once("exit", (code, signal) => {
      ended = { code, signal, at: Date.now() };
      r(ended);
    }),
  );
  proc.once("error", (error) => (spawnError = error));
  let output = "";
  proc.stdout.on("data", (d) => (output += d));
  proc.stderr.on("data", (d) => (output += d));
  let browser: Browser | null | undefined;
  const kill = async () => {
    await browser?.disconnect().catch(() => {});
    if (proc.exitCode === null && proc.signalCode === null && !spawnError) proc.kill();
    // A quit that hangs is a bug the tests should see, not wait on forever.
    const timer = setTimeout(() => proc.kill("SIGKILL"), 10000);
    if (!spawnError) await exited;
    clearTimeout(timer);
  };
  const printed = () => {
    const text = output.trim();
    return text ? `\nIt printed:\n${text.slice(-4000)}` : "\nIt printed nothing.";
  };
  try {
    while (!browser) {
      if (spawnError) throw new LaunchFailure(`Uncut didn't start: ${command} couldn't be run (${spawnError.message}).`, false);
      if (ended) {
        const after = `${((ended.at - startedAt) / 1000).toFixed(1)} s after it started, before its window opened`;
        const how = ended.signal ? `it was killed by ${ended.signal}` : `it exited with code ${ended.code}`;
        // A clean quit before any window (no crash) may be the single-instance lock of an app
        // that's still quitting: worth one more try. A non-zero exit or a signal is a crash.
        throw new LaunchFailure(`Uncut didn't start: ${how} ${after}.${printed()}`, ended.code === 0 && !ended.signal);
      }
      if (Date.now() - startedAt > CONNECT_TIMEOUT_MS) {
        throw new LaunchFailure(`Uncut didn't start: no DevTools port ${port} after ${CONNECT_TIMEOUT_MS / 1000} s, and it's still running (pid ${proc.pid}).${printed()}`, true);
      }
      await sleep(200);
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }).catch(() => null);
    }
    // Make sure we attached to *this* app: the DevTools port must belong to the process we spawned.
    const owners = listenerPid(port);
    if (!owners.includes(proc.pid!)) throw new Error(`DevTools port ${port} belongs to pid ${owners.join(",") || "?"}, not the app we started (${proc.pid})`);
    let page: Page | undefined;
    for (let i = 0; i < 100 && !page; i++) {
      page = (await browser.pages()).find((p) => p.url().endsWith("index.html"));
      if (!page) await sleep(100);
    }
    if (!page) throw new Error(`no index.html page; pages: ${(await browser.pages()).map((p) => p.url())}${printed()}`);
    // The background window is never key, so tell Chromium the page has focus anyway (keyboard,
    // :focus and document.hasFocus() behave as for a window the user is typing into).
    if (env.UNCUT_TEST_BACKGROUND === "1") await (await page.createCDPSession()).send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const errors: Array<string> = [];
    page.on("pageerror", (e) => errors.push((e as Error).message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.waitForFunction(() => document.body.dataset.ready, { timeout: 45000 });
    return { page, browser, proc, errors, close: kill, exited, output: () => output };
  } catch (error) {
    await kill();
    throw error;
  }
}
