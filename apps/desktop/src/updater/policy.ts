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
