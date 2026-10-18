// Auto-update (issue #102, D276): the pure rules, no electron import, unit-tested in
// test/core/issue102-updater.test.ts. updater.ts wires them to electron-updater.
//   - Whether this build updates at all: only a packaged app signed with a team identity (a
//     Developer ID release from `pnpm dist:signed`). Squirrel.Mac refuses an update whose
//     signature doesn't match the running app's, so dev runs and ad-hoc builds (`pnpm dist`, CI's
//     fallback without a certificate) never check. Tests (UNCUT_CDP) never check either, unless
//     they point UNCUT_UPDATE_FEED at their own local server.
//   - The feed: GitHub Releases of blazejkustra/uncut (latest-mac.yml of the latest published
//     release), or UNCUT_UPDATE_FEED: a generic feed on this Mac (loopback only, in every build, so
//     a stray variable can't point a release user's app at another host).
//   - When: a first check a little after launch, then every 4 hours; a check that falls due while
//     an export, a recording or an agent turn runs waits until it's over. Installing (Restart to
//     update) is refused while one runs; otherwise the update installs when the app quits.

export const UPDATE_OWNER = "blazejkustra";
export const UPDATE_REPO = "uncut";
/** The first check, after launch (the window, server and project come first). */
export const FIRST_CHECK_MS = 30_000;
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
/** electron-updater's download cache folder name (under ~/Library/Caches, or UNCUT_DATA_DIR/cache). */
export const UPDATER_CACHE_DIR = "uncut-updater";
/**
 * electron-updater sends a per-install random id (x-user-staging-id, kept in userData/.updaterId)
 * with every check. Uncut sends this one fixed id instead, the same on every Mac: a check tells
 * GitHub nothing about who asked (D223's rule: no identifier outside telemetry).
 */
export const NO_STAGING_ID = "00000000-0000-4000-8000-000000000000";

export type Feed = { readonly provider: "github"; readonly owner: string; readonly repo: string } | { readonly provider: "generic"; readonly url: string };

export type UpdatePolicy =
  | { readonly enabled: true; readonly feed: Feed; readonly test: boolean }
  | { readonly enabled: false; readonly reason: "dev" | "unsigned" | "tests" | "off" | "bad-feed"; readonly detail: string };

/** What `codesign -dvv <Uncut.app>` says about the running bundle's signature. */
export interface BundleSignature {
  readonly signed: boolean;
  readonly adHoc: boolean;
  readonly teamId?: string | undefined;
}

/** `codesign -dvv` output (stderr): signed, ad-hoc, and the team. */
export function parseSignature(output: string): BundleSignature {
  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(output)?.[1] ?? "";
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim();
  return {
    signed: /^CodeDirectory /m.test(output) && !/code object is not signed/.test(output),
    adHoc: /^Signature=adhoc$/m.test(output) || flags.split(",").includes("adhoc"),
    teamId: team && team !== "not set" ? team : undefined,
  };
}

/** UNCUT_UPDATE_FEED: an http(s) URL on this Mac (127.0.0.1, localhost or [::1]); anything else is refused. */
export function feedOverride(raw: string): { readonly url: string } | { readonly problem: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { problem: `UNCUT_UPDATE_FEED is not a URL: ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { problem: "UNCUT_UPDATE_FEED must be an http(s) URL." };
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return { problem: "UNCUT_UPDATE_FEED must be on this Mac (127.0.0.1, localhost or [::1])." };
  return { url: url.href };
}

const isOff = (value: string | undefined) => value !== undefined && /^(0|false|no|off)$/i.test(value.trim());

/**
 * Whether this run checks for updates, and where. `signature` is read only for a packaged app
 * (undefined when codesign couldn't say: treated as unsigned).
 */
export function updatePolicy(env: Record<string, string | undefined>, app: { readonly packaged: boolean; readonly signature?: BundleSignature | undefined }): UpdatePolicy {
  if (isOff(env.UNCUT_AUTO_UPDATE)) return { enabled: false, reason: "off", detail: "UNCUT_AUTO_UPDATE is off" };
  if (!app.packaged) return { enabled: false, reason: "dev", detail: "a development run (not packaged)" };
  const test = Boolean(env.UNCUT_CDP);
  const rawFeed = env.UNCUT_UPDATE_FEED?.trim();
  let feed: Feed = { provider: "github", owner: UPDATE_OWNER, repo: UPDATE_REPO };
  if (rawFeed) {
    const o = feedOverride(rawFeed);
    if ("problem" in o) return { enabled: false, reason: "bad-feed", detail: o.problem };
    feed = { provider: "generic", url: o.url };
  } else if (test) return { enabled: false, reason: "tests", detail: "a test run without UNCUT_UPDATE_FEED" };
  // A test with its own local feed checks on the ad-hoc test build (up to "downloaded": Squirrel
  // then refuses to install it); everything else needs the release signature.
  const s = app.signature;
  const signed = s !== undefined && s.signed && !s.adHoc && s.teamId !== undefined;
  if (!signed && !(test && rawFeed)) return { enabled: false, reason: "unsigned", detail: s?.adHoc ? "an ad-hoc signed build" : "not signed with a Developer ID" };
  return { enabled: true, feed, test };
}

/** Why the menu's Check for Updates… is off, in the menu's sublabel. */
export function disabledLabel(policy: UpdatePolicy): string | undefined {
  if (policy.enabled) return undefined;
  if (policy.reason === "off") return "Turned off (UNCUT_AUTO_UPDATE)";
  if (policy.reason === "bad-feed") return "UNCUT_UPDATE_FEED is not on this Mac";
  return "Only in signed releases";
}

/** The app-update.yml electron-updater reads (it needs one for its cache folder name; the feed is the same). */
export function updaterConfigYaml(feed: Feed): string {
  const lines = feed.provider === "github" ? ["provider: github", `owner: ${feed.owner}`, `repo: ${feed.repo}`] : ["provider: generic", `url: ${JSON.stringify(feed.url)}`];
  return [...lines, `updaterCacheDirName: ${UPDATER_CACHE_DIR}`, ""].join("\n");
}

/**
 * When to check. A check falls due FIRST_CHECK_MS after start, then every CHECK_EVERY_MS after
 * the last one began. One that falls due while busy waits (`waiting`) and runs as soon as busy
 * clears. A manual check (the menu) runs at once, busy or not: checking and downloading don't
 * touch the export or the recording; only installing does, and that's refused while busy.
 */
type Timers = { readonly set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; readonly clear: (t: ReturnType<typeof setTimeout>) => void };
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) };

export class UpdateSchedule {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiting = false;
  private busy = false;
  private stopped = false;
  private readonly check: (manual: boolean) => void;
  private readonly timers: Timers;
  private readonly firstMs: number;
  private readonly everyMs: number;

  constructor(check: (manual: boolean) => void, options: { readonly timers?: Timers; readonly firstMs?: number; readonly everyMs?: number } = {}) {
    this.check = check;
    this.timers = options.timers ?? realTimers;
    this.firstMs = options.firstMs ?? FIRST_CHECK_MS;
    this.everyMs = options.everyMs ?? CHECK_EVERY_MS;
  }

  start() {
    this.arm(this.firstMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  /** The renderer's busy state (an export, a recording, an agent turn). */
  setBusy(busy: boolean) {
    this.busy = busy;
    if (!busy && this.waiting) this.run(false);
  }

  isBusy() {
    return this.busy;
  }

  /** Whether a check is waiting for busy to clear (tests). */
  isWaiting() {
    return this.waiting;
  }

  manual() {
    this.run(true);
  }

  private arm(ms: number) {
    if (this.stopped) return;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      if (this.busy) this.waiting = true;
      else this.run(false);
    }, ms);
  }

  private run(manual: boolean) {
    if (this.stopped) return;
    this.waiting = false;
    this.arm(this.everyMs);
    this.check(manual);
  }
}

/** Whether Restart to update may quit now: never during an export, a recording or an agent turn. */
export const canInstallNow = (busy: boolean) => !busy;

// ---- a reopened app must not break a pending install ----
//
// Restart to update quits the app; Squirrel.Mac's ShipIt then verifies the new bundle (~7 s for
// Uncut's ~300 MB) and swaps it in, and only after that relaunches it. If the app is reopened in
// that gap (it just vanished, nothing on screen), ShipIt waits for it to quit, and the reopened old
// version checks again, re-stages the same update and boots ShipIt out: "App Still Running Error",
// the install is lost, and it repeats on every quit and quick reopen. So at launch, when a ShipIt
// for this very bundle is alive, the app steps aside (quits at once; a detached watcher reopens it
// when ShipIt is done), a few times at most, and otherwise starts without its updater for the run.

/** The bundle identifier (electron-builder.yml appId): ShipIt's launchd label and cache folder are named after it. */
export const BUNDLE_ID = "com.blazejkustra.uncut";
/** At most this many step-asides within STEP_ASIDE_WINDOW_MS; then the app opens and holds its updater. */
export const MAX_STEP_ASIDES = 3;
export const STEP_ASIDE_WINDOW_MS = 10 * 60 * 1000;
/** How long the watcher waits for ShipIt to exit before it reopens the app anyway. */
export const STEP_ASIDE_WAIT_S = 90;

export type PendingInstall = { readonly action: "none" } | { readonly action: "step-aside"; readonly shipItPid: number } | { readonly action: "hold-updates"; readonly shipItPid: number };

/** ShipItState.plist's targetBundleURL (file:///Applications/Uncut.app/) as a path without the trailing slash. */
function targetPath(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const raw = (state as { targetBundleURL?: unknown }).targetBundleURL;
  if (typeof raw !== "string" || !raw.startsWith("file://")) return undefined;
  try {
    return decodeURIComponent(new URL(raw).pathname).replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/**
 * What a launching app does about a ShipIt install. `state` is ShipItState.plist (JSON) or
 * undefined, `shipItPid` the live ShipIt for this bundle id (undefined when none), `stepAsides` the
 * times (ms) this app stepped aside before.
 */
export function pendingInstall(input: { readonly state: unknown; readonly bundlePath: string; readonly shipItPid: number | undefined; readonly stepAsides: readonly number[]; readonly now: number }): PendingInstall {
  const target = targetPath(input.state);
  if (input.shipItPid === undefined || target === undefined) return { action: "none" };
  if (target !== input.bundlePath.replace(/\/+$/, "")) return { action: "none" };
  const recent = input.stepAsides.filter((t) => t <= input.now && input.now - t < STEP_ASIDE_WINDOW_MS).length;
  return recent < MAX_STEP_ASIDES ? { action: "step-aside", shipItPid: input.shipItPid } : { action: "hold-updates", shipItPid: input.shipItPid };
}

/** `pgrep -fl` output: the pid of the ShipIt serving this bundle id (its argv[1] is `<bundle id>.ShipIt`). */
export function shipItPid(pgrepOutput: string, bundleId: string = BUNDLE_ID): number | undefined {
  for (const line of pgrepOutput.split("\n")) {
    const m = /^(\d+)\s+(\S.*)$/.exec(line.trim());
    if (!m) continue;
    const command = `${m[2]!} `;
    if (command.includes(`/ShipIt ${bundleId}.ShipIt `)) return Number(m[1]);
  }
  return undefined;
}

/** The detached watcher: waits (bounded) for ShipIt to exit, then opens the bundle (a no-op focus if ShipIt relaunched it). */
export function stepAsideWatcher(pid: number, bundlePath: string): { readonly file: string; readonly args: readonly string[] } {
  const script = `n=0; while kill -0 "$1" 2>/dev/null && [ "$n" -lt ${STEP_ASIDE_WAIT_S} ]; do sleep 1; n=$((n+1)); done; sleep 1; exec /usr/bin/open "$2"`;
  return { file: "/bin/sh", args: ["-c", script, "uncut-update-wait", String(pid), bundlePath] };
}
