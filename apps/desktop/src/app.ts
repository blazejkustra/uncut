import { realpathSync } from "node:fs";
import * as path from "node:path";

import { app, clipboard, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

import {
  APP_INFO_CHANNEL,
  APP_STATE_CHANNEL,
  ASK_MEDIA_ACCESS_CHANNEL,
  CAPTURE_SOURCES_CHANNEL,
  CHOOSE_DISPLAY_SOURCE_CHANNEL,
  SYSTEM_AUDIO_CHANNEL,
  CHOOSE_FOLDER_CHANNEL,
  CHOOSE_MEDIA_CHANNEL,
  CHOOSE_SAVE_PATH_CHANNEL,
  CLOSE_ANSWER_CHANNEL,
  COPY_TEXT_CHANNEL,
  CLIPBOARD_PATHS_CHANNEL,
  DOWNLOAD_EXPORT_CHANNEL,
  ENVIRONMENT_ADD_CHANNEL,
  ENVIRONMENT_REMOVE_CHANNEL,
  ENVIRONMENT_RENAME_CHANNEL,
  ENVIRONMENT_STATUS_CHANNEL,
  ENVIRONMENT_SWITCH_CHANNEL,
  ENVIRONMENT_TEST_CHANNEL,
  ENVIRONMENTS_CHANNEL,
  MEDIA_ACCESS_CHANNEL,
  MENU_COMMAND_CHANNEL,
  OPEN_PRIVACY_SETTINGS_CHANNEL,
  PROJECT_WINDOW_CHANNEL,
  SERVER_CONNECTION_CHANNEL,
  SHOW_IN_FOLDER_CHANNEL,
  SILENT_AUDIO_CHANNEL,
  type AppInfo,
  type AppState,
  type CloseAnswer,
  type EnvironmentTest,
  type FolderPurpose,
  type MenuCommand,
  WINDOW_MODE_CHANNEL,
  MINI_RECORDER_ACTION_CHANNEL,
  MINI_RECORDER_CHANNEL,
  type MiniRecorderAction,
  type MiniRecorderState,
  UPDATE_BUSY_CHANNEL,
  UPDATE_CHECK_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATUS_CHANNEL,
  type UpdateStatus,
} from "./ipc.ts";
import { channelOf, productNameFor } from "./channel.ts";
import { BACKGROUND_SWITCHES, privacySettingsUrl, SYSTEM_AUDIO_FEATURES, systemAudioSupport, TEST_MEDIA_SWITCHES } from "./background.ts";
import { setAppMenu, setUpdateMenu, type MenuActions } from "./menu.ts";
import { updateMenuState } from "./updater/policy.ts";
import { checkPendingInstall, startUpdater, type Updater } from "./updater/updater.ts";
import { clipboardPaths } from "./clipboardPaths.ts";
import { LOCAL_ID, makeEnvironmentStore, normalizeServerUrl, parsePairing } from "./environments.ts";
import { pingServer } from "./relay.ts";
import { installCrashReports } from "./crashReports.ts";
import { installOpenFile } from "./openFile.ts";
import { projectDirFromOpenedPath } from "./projectPath.ts";
import { routeProject, windowWithProject, type RoutedWindow } from "./windowRouter.ts";
import { testBackground, mediaTest, testDialogs } from "./app/testMode.ts";
import { currentWindow, environments, setEnvironments, windowOf, windows, type AppWindow } from "./app/state.ts";
import { activeConnection, closeRelay, downloadExport, environmentOf } from "./app/remote.ts";
import { showMini, mini, resendMini } from "./app/miniRecorder.ts";
import { crypt } from "./app/crypt.ts";
import { appInfo, chooseFolder, chooseMedia, chooseSavePath } from "./app/dialogs.ts";
import { mediaAccess, isMediaKind, askMediaAccess, captureSources } from "./app/mediaAccess.ts";
import {
  answerClose,
  beginQuit,
  createWindow,
  dataDir,
  forceClose,
  isAppUrl,
  serversRunning,
  setWindowMode,
  showWindow,
  stopEveryServer,
} from "./app/windows.ts";

// Lets tests drive the window with puppeteer (same switch as the phase 2 spike).
if (process.env.UNCUT_CDP) app.commandLine.appendSwitch("remote-debugging-port", process.env.UNCUT_CDP);

// The nightly (src/channel.ts) is Uncut Nightly: its own name in the menu and its own profile
// (~/Library/Application Support/Uncut Nightly), so it never reads or writes the release's data.
// The packaged package.json still says productName Uncut, so the name is set here, before ready.
if (channelOf(app.getVersion()) === "nightly") {
  app.setName(productNameFor("nightly"));
  app.setPath("userData", path.join(app.getPath("appData"), productNameFor("nightly")));
}

// With UNCUT_DATA_DIR (tests, side-by-side runs) Electron's own profile lives there too, so a
// test never touches the real ~/Library/Application Support/Uncut. Must happen before ready.
if (process.env.UNCUT_DATA_DIR) {
  app.setPath("userData", path.join(process.env.UNCUT_DATA_DIR, "electron"));
  app.setPath("sessionData", path.join(process.env.UNCUT_DATA_DIR, "electron"));
}

// One Uncut per profile: opening it again goes to the running app (its last focused window, or the
// project it was given). The lock is per userData directory, so test runs with their own
// UNCUT_DATA_DIR don't block each other.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
// A ShipIt install of this bundle still under way (Restart to update, then reopened before ShipIt
// swapped the new version in): step aside so it can finish (it reopens the app), or, after a few
// tries, open without the updater so this run can't re-stage the update and break the install.
const pendingUpdate =
  app.isPackaged && process.platform === "darwin" && !process.env.UNCUT_CDP
    ? checkPendingInstall(process.env.UNCUT_DATA_DIR || app.getPath("userData"))
    : "none";
if (pendingUpdate === "step-aside") app.exit(0);
if (testBackground) {
  app.dock?.hide();
  // An accessory app (no dock icon, no menu bar) is never made the active app by showing a window.
  app.setActivationPolicy?.("accessory");
  for (const name of BACKGROUND_SWITCHES) app.commandLine.appendSwitch(name);
}
if (mediaTest) for (const name of TEST_MEDIA_SWITCHES) app.commandLine.appendSwitch(name);
// D210: this Mac's sound in a screen take (getDisplayMedia's loopback audio; Core Audio taps on 14.2+).
else if (process.platform === "darwin") app.commandLine.appendSwitch("enable-features", SYSTEM_AUDIO_FEATURES);

// Tests of the no-WebGPU path (D213), only with UNCUT_CDP: no GPU at all, as on a Mac without a
// usable one (the server's rasteriser gets the same through UNCUT_TEST_NO_GPU).
if (process.env.UNCUT_CDP && process.env.UNCUT_TEST_NO_GPU === "1") app.commandLine.appendSwitch("disable-gpu");

/** The sender's window, when the message comes from its own top-level app page (the server's token, dialogs, Finder). */
function fromAppWindow(event: IpcMainInvokeEvent | IpcMainEvent): AppWindow | undefined {
  const entry = windowOf(event.sender);
  const frame = event.senderFrame;
  return entry && frame !== null && frame.parent === null && isAppUrl(frame.url) ? entry : undefined;
}

/** One name per project folder, however it was reached (symlinks, /var vs /private/var). */
const realDir = (dir: string) => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

// ---- windows, and which one a project opens in ----

const NO_PROJECT_STATE: AppState = { projectOpen: false, recents: [], environments: false };

const routed = (): Array<RoutedWindow> =>
  windows.map((w) => ({ id: w.window.id, local: environmentOf(w).kind === "local", projectDir: w.projectDir, pendingOpen: w.pendingOpen }));
const byId = (id: number) => windows.find((w) => w.window.id === id);

/** The menu shows the focused window's state; its commands go there. */
const refreshMenu = () => setAppMenu(currentWindow()?.appState ?? NO_PROJECT_STATE, menuActions);

function openWindow(options: { envId?: string; pendingOpen?: string } = {}) {
  const entry = createWindow({ ...options, onClosed: () => windowClosed(entry) });
  entry.window.on("focus", refreshMenu);
  return entry;
}

function windowClosed(entry: AppWindow) {
  if (miniOwner === entry) {
    miniOwner = undefined;
    showMini(null);
  }
  updater?.setBusy(windows.some((w) => w.busy));
  if (windows.length) refreshMenu();
}

/** A project from Open Recent, Finder, the Dock or a second launch: the window that has it, an empty focused one, or a new one. */
function openProject(rawDir: string) {
  const dir = realDir(rawDir);
  const route = routeProject(routed(), currentWindow()?.window.id, dir);
  if (route.kind === "new") return void openWindow({ pendingOpen: dir });
  const entry = byId(route.id)!;
  if (route.kind === "open") {
    // A page that hasn't asked yet ignores commands: it takes the project when it asks.
    if (entry.askedOpen) entry.window.webContents.send(MENU_COMMAND_CHANNEL, { type: "open-recent", dir } satisfies MenuCommand);
    else entry.pendingOpen = dir;
  }
  showWindow(entry);
}

function sendMenuCommand(command: MenuCommand) {
  if (command.type === "open-recent") return openProject(command.dir);
  currentWindow()?.window.webContents.send(MENU_COMMAND_CHANNEL, command);
}

const menuActions: MenuActions = { send: sendMenuCommand, newWindow: () => void openWindow() };

app.on("before-quit", beginQuit);
/**
 * Signals: SIGTERM / SIGINT quit without asking. Installed once the app is ready, after Chromium's
 * own handlers, so these replace them (Chromium's would quit through the windows' close, which asks).
 * In tests (UNCUT_CDP) SIGUSR2 closes the focused window as its close button does, which tests can't press.
 */
function installSignals() {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      forceClose();
      app.quit();
    });
  }
  if (process.env.UNCUT_CDP) process.on("SIGUSR2", () => currentWindow()?.window.close());
}

// D252: a .uncut project opened from Finder or the Dock (before ready, so the first open-file isn't
// missed). It never opens in a window on a remote environment: a path on this Mac opens in a Local window.
const openFile = installOpenFile({
  route: openProject,
  take: (event) => {
    const entry = fromAppWindow(event);
    if (!entry) throw new Error("not allowed");
    entry.askedOpen = true;
    if (environmentOf(entry).kind !== "local") return null;
    const dir = entry.pendingOpen;
    entry.pendingOpen = undefined;
    return dir ?? null;
  },
});

// A second launch: the projects it was given open as above; with none, the last focused window comes forward.
app.on("second-instance", (_event, argv) => {
  const dirs = argv
    .slice(1)
    .map(projectDirFromOpenedPath)
    .filter((dir): dir is string => dir !== undefined);
  if (!app.isReady()) return;
  if (dirs.length) return dirs.forEach(openProject);
  const entry = currentWindow();
  if (entry) showWindow(entry);
});

// ---- recording on this Mac (D114) ----

// D209: the window whose recording the floating mini recorder shows; its buttons go back there.
let miniOwner: AppWindow | undefined;

function setMini(entry: AppWindow, state: MiniRecorderState | null) {
  if (state) {
    miniOwner = entry;
    return showMini(state);
  }
  if (miniOwner !== entry) return;
  miniOwner = undefined;
  showMini(null);
}

app.whenReady().then(() => {
  installSignals();
  // D223: main's crashes go to the server's telemetry spool.
  installCrashReports(dataDir());
  setEnvironments(makeEnvironmentStore(dataDir(), crypt));
  const handle = <A extends Array<unknown>, R>(channel: string, fn: (entry: AppWindow, ...args: A) => R) =>
    ipcMain.handle(channel, (event, ...args) => {
      const entry = fromAppWindow(event);
      if (!entry) throw new Error("not allowed");
      return fn(entry, ...(args as A));
    });
  handle(SERVER_CONNECTION_CHANNEL, (entry) =>
    activeConnection(entry).then((c) => {
      // The server the page talks to (local or the relay, both on 127.0.0.1): its graphics' documents load in frames.
      entry.connectedServer = c.url.replace(/^ws/, "http");
      return c;
    }),
  );
  handle(ENVIRONMENTS_CHANNEL, (entry) => ({ ...environments!.list(), active: environmentOf(entry).id }));
  handle(ENVIRONMENT_ADD_CHANNEL, (_entry, input: { name?: unknown; url?: unknown; token?: unknown }) => {
    if (typeof input?.url !== "string" || typeof input.token !== "string" || typeof input.name !== "string") throw new Error("not an environment");
    try {
      return environments!.add({ name: input.name, url: input.url, token: input.token });
    } catch (error) {
      return { problem: `Couldn't keep the token safely: ${(error as Error).message}` };
    }
  });
  handle(ENVIRONMENT_TEST_CHANNEL, async (_entry, input: { url?: unknown; token?: unknown; id?: unknown }): Promise<EnvironmentTest> => {
    let target: { url: string; token: string } | undefined;
    if (typeof input?.id === "string") {
      try {
        target = environments!.secret(input.id);
      } catch (error) {
        return { ok: false, message: `Can't read the stored token: ${(error as Error).message}` };
      }
      if (!target) return { ok: false, message: "That environment isn't in the list any more." };
    } else if (typeof input?.url === "string" && typeof input.token === "string") {
      const pairing = parsePairing(input.url);
      const normal = normalizeServerUrl(pairing?.url ?? input.url);
      if ("problem" in normal) return { ok: false, message: normal.problem };
      target = { url: normal.url, token: (pairing?.token ?? input.token).trim() };
    } else throw new Error("nothing to test");
    return pingServer(target.url, target.token);
  });
  handle(
    ENVIRONMENT_RENAME_CHANNEL,
    (_entry, id: unknown, name: unknown) => typeof id === "string" && typeof name === "string" && environments!.rename(id, name),
  );
  handle(ENVIRONMENT_REMOVE_CHANNEL, async (_entry, id: unknown) => {
    if (typeof id !== "string" || !environments!.remove(id)) return false;
    // Each window showing the removed one goes back to Local.
    for (const shown of windows.filter((w) => w.envId === id)) {
      shown.envId = LOCAL_ID;
      await closeRelay(shown);
      shown.window.webContents.reload();
    }
    return true;
  });
  handle(ENVIRONMENT_SWITCH_CHANNEL, async (entry, id: unknown) => {
    if (typeof id !== "string") return false;
    // A remote shows in one window (its server keeps one project): that window comes forward.
    const showing = id === LOCAL_ID ? undefined : windows.find((w) => w !== entry && w.envId === id);
    if (showing) {
      showWindow(showing);
      return false;
    }
    // Remembered for the next launch's first window.
    if (!environments!.setActive(id)) return false;
    entry.envId = id;
    // A fresh page for the other environment: nothing of one server's projects carries over (D106).
    await closeRelay(entry);
    entry.window.webContents.reload();
    return true;
  });
  handle(ENVIRONMENT_STATUS_CHANNEL, (entry) => ({ problem: entry.relay?.relay.problem() }));
  handle(DOWNLOAD_EXPORT_CHANNEL, (entry, jobId: string, name: string) => downloadExport(entry, jobId, name));
  handle(APP_INFO_CHANNEL, (): AppInfo => appInfo);
  handle(CHOOSE_FOLDER_CHANNEL, (entry, purpose: FolderPurpose) => chooseFolder(entry.window, purpose));
  handle(CHOOSE_MEDIA_CHANNEL, (entry) => chooseMedia(entry.window));
  handle(CHOOSE_SAVE_PATH_CHANNEL, (entry, defaultPath: string) => chooseSavePath(entry.window, defaultPath));
  handle(SHOW_IN_FOLDER_CHANNEL, (_entry, target: string) => {
    if (typeof target !== "string" || !path.isAbsolute(target)) throw new Error("not an absolute path");
    if (testDialogs) console.log(`[test] showItemInFolder ${target}`);
    else shell.showItemInFolder(target);
  });
  handle(COPY_TEXT_CHANNEL, (_entry, text: string) => {
    if (typeof text !== "string") throw new Error("not text");
    // Tests shouldn't overwrite the clipboard of whoever runs them.
    if (testDialogs) console.log(`[test] copied ${text}`);
    else clipboard.writeText(text);
  });
  // D201: files and folders copied in Finder, as paths (the composer pastes them as path chips).
  // Tests answer from UNCUT_TEST_CLIPBOARD (a JSON array of paths, only with UNCUT_CDP), so a run
  // never reads whatever the person running it copied.
  handle(CLIPBOARD_PATHS_CHANNEL, () => {
    if (process.env.UNCUT_CDP)
      return process.env.UNCUT_TEST_CLIPBOARD
        ? (JSON.parse(process.env.UNCUT_TEST_CLIPBOARD) as Array<string>).filter((p) => typeof p === "string" && path.isAbsolute(p))
        : [];
    if (process.platform !== "darwin") return [];
    return clipboard.read().then(clipboardPaths, () => []);
  });
  handle(MEDIA_ACCESS_CHANNEL, () => mediaAccess());
  handle(ASK_MEDIA_ACCESS_CHANNEL, (_entry, kind: unknown) => {
    if (!isMediaKind(kind)) throw new Error("not a media kind");
    return askMediaAccess(kind);
  });
  handle(OPEN_PRIVACY_SETTINGS_CHANNEL, (_entry, kind: unknown) => {
    if (!isMediaKind(kind)) throw new Error("not a media kind");
    const url = privacySettingsUrl(kind);
    if (mediaTest) console.log(`[test] open ${url}`);
    else void shell.openExternal(url);
  });
  handle(CAPTURE_SOURCES_CHANNEL, () => captureSources());
  handle(CHOOSE_DISPLAY_SOURCE_CHANNEL, (entry, id: unknown, options: unknown) => {
    if (typeof id !== "string" || id.length > 200) throw new Error("not a source id");
    const systemAudio = Boolean(options && typeof options === "object" && (options as { systemAudio?: unknown }).systemAudio === true);
    entry.pendingDisplaySource = { id, systemAudio };
  });
  handle(SYSTEM_AUDIO_CHANNEL, () => systemAudioSupport(process.platform, process.getSystemVersion(), process.env));
  // Several projects at once: opening a project another window has brings that window forward instead.
  handle(PROJECT_WINDOW_CHANNEL, (entry, dir: unknown) => {
    if (typeof dir !== "string" || !path.isAbsolute(dir) || environmentOf(entry).kind !== "local") return false;
    const other = windowWithProject(routed(), entry.window.id, realDir(dir));
    if (!other) return false;
    showWindow(byId(other.id)!);
    return true;
  });
  // A background test window plays its preview to no output device (sinkId "none"): no sound, and
  // no device latency (Bluetooth headphones add ~0.25 s) between the clock and what is captured.
  ipcMain.on(SILENT_AUDIO_CHANNEL, (event) => {
    event.returnValue = fromAppWindow(event) !== undefined && testBackground;
  });
  ipcMain.on(CLOSE_ANSWER_CHANNEL, (event, answer: CloseAnswer) => {
    const entry = fromAppWindow(event);
    if (entry) answerClose(entry, answer);
  });
  ipcMain.on(APP_STATE_CHANNEL, (event, state: AppState) => {
    const entry = fromAppWindow(event);
    if (!entry) return;
    entry.appState = state;
    entry.projectDir = typeof state?.projectDir === "string" && path.isAbsolute(state.projectDir) ? realDir(state.projectDir) : undefined;
    if (entry === currentWindow()) refreshMenu();
  });
  // D209: the mini recorder's state comes from the window recording; its buttons go back there.
  ipcMain.on(MINI_RECORDER_CHANNEL, (event, state: MiniRecorderState | null) => {
    const entry = fromAppWindow(event);
    if (entry) setMini(entry, state && typeof state === "object" && typeof state.name === "string" ? state : null);
  });
  ipcMain.on(MINI_RECORDER_ACTION_CHANNEL, (event, action: MiniRecorderAction) => {
    if (!mini || event.sender !== mini.webContents) return;
    if (action === "ready") return resendMini();
    if (!["stop", "pause", "resume", "cancel"].includes(action)) return;
    if (testBackground) console.log(`[test] mini recorder ${action}`);
    miniOwner?.window.webContents.send(MINI_RECORDER_ACTION_CHANNEL, action);
  });
  // D209: the renderer asks for the editor's size before it shows a project, the compact one after.
  handle(WINDOW_MODE_CHANNEL, (entry, mode: unknown) => {
    if (mode !== "welcome" && mode !== "editor") throw new Error("not a window mode");
    return setWindowMode(entry, mode);
  });
  // The first window shows the environment the last one switched to; new ones start on Local.
  openWindow({ envId: environments!.active().id });
  refreshMenu();
  openFile.ready();
  installUpdates();
});

// ---- auto-update (#102, D276) ----

let updater: Updater | undefined;

function installUpdates() {
  void startUpdater({
    dataDir: dataDir(),
    send: (status) => {
      for (const entry of windows) entry.window.webContents.send(UPDATE_STATUS_CHANNEL, status);
    },
    // The renderer asked about pending work before it called install (and install is refused while
    // any window is busy); now nothing may hold the quit: every server is stopped first (will-quit
    // then has nothing to wait for) and no window's close is asked again.
    beforeInstall: async () => {
      forceClose();
      await stopEveryServer();
    },
    onPolicy: (policy) => setUpdateMenu({ ...updateMenuState(policy, pendingUpdate === "hold-updates"), check: () => updater?.checkNow() }),
    hold: pendingUpdate === "hold-updates",
  }).then(
    (u) => {
      updater = u;
      u.setBusy(windows.some((w) => w.busy));
    },
    (error: Error) => console.log(`[updater] not started: ${error.message}`),
  );
  ipcMain.handle(UPDATE_STATUS_CHANNEL, (event): UpdateStatus => {
    if (!fromAppWindow(event)) throw new Error("not allowed");
    return updater?.status() ?? { kind: "idle" };
  });
  ipcMain.handle(UPDATE_CHECK_CHANNEL, (event) => {
    if (!fromAppWindow(event)) throw new Error("not allowed");
    updater?.checkNow();
  });
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, (event) => {
    if (!fromAppWindow(event)) throw new Error("not allowed");
    return updater?.install() ?? "not-ready";
  });
  // What each renderer last said (an export, a recording or an agent turn running): busy while any window is.
  ipcMain.on(UPDATE_BUSY_CHANNEL, (event, busy: unknown) => {
    const entry = fromAppWindow(event);
    if (!entry) return;
    entry.busy = busy === true;
    updater?.setBusy(windows.some((w) => w.busy));
  });
}

// Closing the last window ends the app (and every server with it).
app.on("window-all-closed", () => app.quit());

app.on("will-quit", (event) => {
  if (!serversRunning()) return;
  // Hold the quit until every server is really gone (each stop is bounded: SIGKILL after 1.5 s).
  // Re-quit on a later tick: Electron ignores app.quit() while will-quit is still dispatching.
  event.preventDefault();
  void stopEveryServer().finally(() => setImmediate(() => app.quit()));
});
