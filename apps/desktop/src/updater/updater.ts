// Auto-update (issue #102, D276): electron-updater's MacUpdater against GitHub Releases (or a
// local test feed), behind policy.ts's rules. Checks a little after launch and every 4 hours,
// downloads in the background, tells the renderer (which shows "Uncut X is ready"), and installs
// on Restart to update or when the app quits. A failed check is logged, never shown: while the
// repository is private every check fails, and that must stay silent.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import { app, autoUpdater as squirrel } from "electron";
import { MacUpdater, type UpdateInfo } from "electron-updater";

import type { UpdateInstallResult, UpdateStatus } from "../ipc.ts";
import { canInstallNow, NO_STAGING_ID, parseSignature, UpdateSchedule, updaterConfigYaml, updatePolicy, type BundleSignature, type UpdatePolicy } from "./policy.ts";

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
    execFile("codesign", ["-dvv", bundlePath()], { timeout: 5000 }, (_error, stdout, stderr) => {
      const out = `${stdout}${stderr}`;
      resolve(out.trim() ? parseSignature(out) : undefined);
    });
  });
}

export async function startUpdater(options: {
  readonly dataDir: string;
  readonly send: (status: UpdateStatus) => void;
  /** Stops the server and lets the window close without asking again, before Squirrel quits the app. */
  readonly beforeInstall: () => Promise<void>;
  /** Called when the policy is known (the menu's Check for Updates… follows it). */
  readonly onPolicy: (policy: UpdatePolicy) => void;
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
  let downloaded: string | undefined;
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
  // it. Restart to update waits for its answer: quitting before Squirrel is ready would install
  // nothing (and the server would already be stopped). Its refusal is logged, as any failure.
  let staged: Promise<boolean> | undefined;
  const watchSquirrel = () =>
    new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        squirrel.off("update-downloaded", onReady);
        squirrel.off("error", onError);
        if (!ok) log("Squirrel.Mac could not stage the update (Restart to update will say so)");
        resolve(ok);
      };
      const onReady = () => done(true);
      const onError = () => done(false);
      squirrel.on("update-downloaded", onReady);
      squirrel.on("error", onError);
    });
  updater.on("update-downloaded", (info: UpdateInfo) => {
    staged ??= watchSquirrel();
    downloaded = versionOf(info);
    log(`downloaded ${downloaded}; installs on Restart to update or at quit`);
    send({ kind: "downloaded", version: downloaded });
  });
  // Every failure (no network, the private repository's 404, Squirrel refusing a bundle) is only
  // logged: the toast goes away as if nothing happened. Without this listener an error would throw.
  updater.on("error", (error: Error) => {
    log(`check failed (not shown): ${error?.message?.split("\n")[0] ?? String(error)}`);
    if (!downloaded) send({ kind: "idle" });
  });

  const check = (asked: boolean) => {
    // A downloaded update is ready: no need to look again (the menu shows the toast again).
    if (downloaded) return void (asked && send({ kind: "downloaded", version: downloaded }));
    manual = asked;
    updater.checkForUpdates().catch(() => {}); // reported through "error"
  };
  const schedule = new UpdateSchedule(check, policy.test && process.env.UNCUT_UPDATE_FIRST_CHECK_MS ? { firstMs: Number(process.env.UNCUT_UPDATE_FIRST_CHECK_MS) } : {});
  schedule.start();
  log(`on: ${policy.feed.provider === "github" ? `github ${policy.feed.owner}/${policy.feed.repo}` : policy.feed.url}`);

  return {
    policy,
    checkNow: () => schedule.manual(),
    setBusy: (busy) => schedule.setBusy(busy),
    status: () => status,
    install: async () => {
      if (!downloaded) return "not-ready";
      if (!canInstallNow(schedule.isBusy())) return "busy";
      // Squirrel's answer, if it hasn't come yet (bounded: a stuck Squirrel never holds the click).
      const ready = await Promise.race([staged ?? Promise.resolve(false), new Promise<boolean>((r) => setTimeout(() => r(false), 120_000))]);
      if (!ready) {
        log(`not installing ${downloaded}: Squirrel.Mac has not staged it`);
        return "not-ready";
      }
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
