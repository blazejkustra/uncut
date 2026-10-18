// Auto-update (issue #102, D276): electron-updater's MacUpdater against GitHub Releases (or a
// local test feed), behind policy.ts's rules. Checks a little after launch and every 4 hours,
// downloads in the background, tells the renderer (which shows "Uncut X is ready"), and installs
// on Restart to update or when the app quits. A failed check is logged, never shown: while the
// repository is private every check fails, and that must stay silent.
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import { app, autoUpdater as squirrel } from "electron";
import { MacUpdater, type UpdateInfo } from "electron-updater";

import type { UpdateInstallResult, UpdateStatus } from "../ipc.ts";
import { BUNDLE_ID, canInstallNow, NO_STAGING_ID, parseSignature, pendingInstall, shipItPid, stepAsideWatcher, UpdateSchedule, updaterConfigYaml, updatePolicy, type BundleSignature, type PendingInstall, type UpdatePolicy } from "./policy.ts";

const log = (message: string) => console.log(`[updater] ${message}`);

export interface Updater {
  readonly policy: UpdatePolicy;
  /** Uncut › Check for Updates… */
  readonly checkNow: () => void;
  readonly setBusy: (busy: boolean) => void;
  /** Restart to update (the renderer has already asked about unsaved work). */
  readonly install: () => Promise<UpdateInstallResult>;
  /** The last status, for a renderer that (re)loaded after it was sent. */
  readonly status: () => UpdateStatus;
}

/** The running bundle (…/Uncut.app) from the executable (…/Uncut.app/Contents/MacOS/Uncut). */
const bundlePath = () => path.resolve(path.dirname(process.execPath), "../..");

function readSignature(): Promise<BundleSignature | undefined> {
  return new Promise((resolve) => {
    execFile("/usr/bin/codesign", ["-dvv", bundlePath()], { timeout: 5000 }, (_error, stdout, stderr) => {
      const out = `${stdout}${stderr}`;
      resolve(out.trim() ? parseSignature(out) : undefined);
    });
  });
}

/**
 * At launch, before anything else starts: is a ShipIt install of this bundle under way (see
 * policy.ts's pendingInstall)? "step-aside": a detached watcher is started that reopens the app
 * once ShipIt is done, and the caller quits at once. "hold-updates": the caller opens as usual
 * but starts no updater this run (its check would re-stage the update and boot ShipIt out).
 */
export function checkPendingInstall(dataDir: string): PendingInstall["action"] {
  let decision: PendingInstall = { action: "none" };
  try {
    let state: unknown;
    try {
      state = JSON.parse(readFileSync(path.join(homedir(), "Library", "Caches", `${BUNDLE_ID}.ShipIt`, "ShipItState.plist"), "utf8"));
    } catch {
      return "none"; // no install request (or not one we can read): nothing pending
    }
    let pgrep = "";
    try {
      pgrep = execFileSync("/usr/bin/pgrep", ["-fl", `${BUNDLE_ID}.ShipIt`], { encoding: "utf8", timeout: 3000 });
    } catch {
      return "none"; // pgrep exits 1 when nothing matches
    }
    const recordPath = path.join(dataDir, "updater", "step-asides.json");
    let stepAsides: number[] = [];
    try {
      const raw: unknown = JSON.parse(readFileSync(recordPath, "utf8"));
      if (Array.isArray(raw)) stepAsides = raw.filter((t): t is number => typeof t === "number");
    } catch {}
    const now = Date.now();
    decision = pendingInstall({ state, bundlePath: bundlePath(), shipItPid: shipItPid(pgrep), stepAsides, now });
    if (decision.action === "step-aside") {
      mkdirSync(path.dirname(recordPath), { recursive: true });
      writeFileSync(recordPath, JSON.stringify([...stepAsides.filter((t) => now - t < 24 * 60 * 60 * 1000), now]));
      const watcher = stepAsideWatcher(decision.shipItPid, bundlePath());
      spawn(watcher.file, [...watcher.args], { detached: true, stdio: "ignore" }).unref();
      log(`ShipIt (${decision.shipItPid}) is installing an update: quitting until it's done`);
    } else if (decision.action === "hold-updates") {
      log(`ShipIt (${decision.shipItPid}) is still pending after repeated relaunches: no update checks this run`);
    }
  } catch (error) {
    log(`pending install check failed: ${(error as Error).message}`);
    return "none";
  }
  return decision.action;
}

export async function startUpdater(options: {
  readonly dataDir: string;
  readonly send: (status: UpdateStatus) => void;
  /** Stops the server and lets the window close without asking again, before Squirrel quits the app. */
  readonly beforeInstall: () => Promise<void>;
  /** Called when the policy is known (the menu's Check for Updates… follows it). */
  readonly onPolicy: (policy: UpdatePolicy) => void;
  /** A ShipIt install is pending (checkPendingInstall's "hold-updates"): no checks this run. */
  readonly hold?: boolean;
}): Promise<Updater> {
  const signature = app.isPackaged && process.platform === "darwin" ? await readSignature() : undefined;
  const policy = process.platform === "darwin" ? updatePolicy(process.env, { packaged: app.isPackaged, signature }) : ({ enabled: false, reason: "dev", detail: "macOS only" } as const);
  options.onPolicy(policy);
  let status: UpdateStatus = { kind: "idle" };
  const send = (next: UpdateStatus) => {
    status = next;
    options.send(next);
  };
  if (!policy.enabled) {
    log(`off: ${policy.detail}`);
    return { policy, checkNow: () => {}, setBusy: () => {}, install: async () => "not-ready", status: () => status };
  }
  if (options.hold) {
    log("held: a pending ShipIt install finishes when the app quits");
    return { policy, checkNow: () => log("held: quit Uncut to finish the pending update"), setBusy: () => {}, install: async () => "not-ready", status: () => status };
  }

  const cacheBase = process.env.UNCUT_DATA_DIR ? path.join(process.env.UNCUT_DATA_DIR, "cache") : path.join(homedir(), "Library", "Caches");
  const configDir = path.join(options.dataDir, "updater");
  mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "app-update.yml");
  writeFileSync(configPath, updaterConfigYaml(policy.feed));

  // electron-updater's own app adapter (a custom one leaves it without its HTTP client). Its
  // app-update.yml is the one written above (a release has none in Resources: electron-builder's
  // publish stays null); its download cache is ~/Library/Caches/uncut-updater, or under
  // UNCUT_DATA_DIR (tests, side-by-side runs) like Electron's profile.
  const updater = new MacUpdater();
  updater.updateConfigPath = configPath;
  if (process.env.UNCUT_DATA_DIR) Object.defineProperty((updater as unknown as { app: object }).app, "baseCachePath", { value: cacheBase });
  updater.setFeedURL(policy.feed);
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  // No per-install id with the checks (see NO_STAGING_ID); the field is electron-updater's own.
  Object.assign(updater, { stagingUserIdPromise: { value: Promise.resolve(NO_STAGING_ID) } });
  updater.logger = {
    info: (m?: unknown) => log(String(m)),
    warn: (m?: unknown) => log(`warn: ${String(m)}`),
    error: (m?: unknown) => log(`error: ${String(m)}`),
  };

  // Whether the running check was asked for by the user (shows checking / up to date / progress).
  let manual = false;
  // The version Squirrel has staged (ready to install), and whether Restart to update is under way.
  let downloaded: string | undefined;
  let installing = false;
  const versionOf = (info: UpdateInfo) => info.version;

  updater.on("checking-for-update", () => {
    if (!downloaded) send({ kind: "checking", manual });
  });
  updater.on("update-not-available", (info: UpdateInfo) => {
    if (!downloaded) send({ kind: "none", manual, version: app.getVersion() });
    log(`up to date (${app.getVersion()}; the feed has ${versionOf(info)})`);
  });
  updater.on("update-available", (info: UpdateInfo) => {
    log(`update available: ${versionOf(info)}`);
    if (!downloaded) send({ kind: "downloading", manual, version: versionOf(info), percent: 0 });
  });
  updater.on("download-progress", (p: { percent: number }) => {
    if (status.kind === "downloading") send({ ...status, manual, percent: Math.max(0, Math.min(100, Math.round(p.percent))) });
  });
  // Squirrel.Mac's own step after electron-updater's download: it fetches the zip from
  // electron-updater's local proxy, checks the new bundle's signature against this app's and stages
  // it. Only then is the update "ready" (the toast, Restart to update): a refusal is logged, the
  // toast goes away and a later check tries again. Tests on the ad-hoc build (whose Squirrel must
  // never stage anything) take electron-updater's download as staged: UNCUT_TEST_UPDATE_STAGED=1.
  const testStaged = policy.test && process.env.UNCUT_TEST_UPDATE_STAGED === "1";
  let staging: string | undefined;
  const onSquirrelReady = () => {
    if (!staging) return;
    downloaded = staging;
    staging = undefined;
    log(`downloaded ${downloaded}; installs on Restart to update or at quit`);
    send({ kind: "downloaded", version: downloaded });
  };
  const onSquirrelError = (error: Error) => {
    if (!staging || testStaged) return;
    log(`Squirrel.Mac could not stage ${staging} (not shown; a later check tries again): ${error?.message?.split("\n")[0] ?? String(error)}`);
    staging = undefined;
    send({ kind: "idle" });
  };
  squirrel.on("update-downloaded", onSquirrelReady);
  squirrel.on("error", onSquirrelError);
  updater.on("update-downloaded", (info: UpdateInfo) => {
    staging = versionOf(info);
    log(`fetched ${staging}; Squirrel.Mac is staging it`);
    if (testStaged) onSquirrelReady();
  });
  // Every failure (no network, the private repository's 404, Squirrel refusing a bundle) is only
  // logged: the toast goes away as if nothing happened. Without this listener an error would throw.
  updater.on("error", (error: Error) => {
    log(`check failed (not shown): ${error?.message?.split("\n")[0] ?? String(error)}`);
    if (!downloaded && !staging) send({ kind: "idle" });
  });

  const check = (asked: boolean) => {
    // A staged update is ready: no need to look again (the menu shows the toast again).
    if (downloaded) return void (asked && send({ kind: "downloaded", version: downloaded }));
    if (staging) return;
    manual = asked;
    // Both the check and its download report failures through "error".
    updater.checkForUpdates().then((r) => void r?.downloadPromise?.catch(() => {}), () => {});
  };
  const schedule = new UpdateSchedule(check, policy.test && process.env.UNCUT_UPDATE_FIRST_CHECK_MS ? { firstMs: Number(process.env.UNCUT_UPDATE_FIRST_CHECK_MS) } : {});
  schedule.start();
  log(`on: ${policy.feed.provider === "github" ? `github ${policy.feed.owner}/${policy.feed.repo}` : policy.feed.url}`);

  return {
    policy,
    checkNow: () => schedule.manual(),
    setBusy: (busy) => schedule.setBusy(busy),
    status: () => status,
    // Restart to update: the renderer has just asked about unsaved work (confirmLeave). Immediate (no
    // waiting: the toast only shows once Squirrel has staged the update), refused while busy, once.
    install: async () => {
      if (!downloaded) return "not-ready";
      if (!canInstallNow(schedule.isBusy())) return "busy";
      if (installing) return "installing";
      installing = true;
      log(`restarting to install ${downloaded}`);
      if (policy.test) {
        // A test build: Squirrel can't install it; say what would happen and stop there.
        log("test run: quitAndInstall skipped");
        return "installing";
      }
      await options.beforeInstall();
      updater.quitAndInstall();
      return "installing";
    },
  };
}
