import * as path from "node:path";

import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  screen,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebFrameMain,
} from "electron";

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
  CLOSE_REQUEST_CHANNEL,
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
  SERVER_CONNECTION_CHANNEL,
  SERVER_EXIT_CHANNEL,
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
import { readWindowSizes, WINDOW_MODES, writeWindowSizes, type WindowMode, type WindowSize } from "./windowState.ts";
import { BACKGROUND_SWITCHES, centredIn, privacySettingsUrl, SYSTEM_AUDIO_FEATURES, systemAudioSupport, TEST_MEDIA_SWITCHES } from "./background.ts";
import { setAppMenu, setUpdateMenu } from "./menu.ts";
import { updateMenuState } from "./updater/policy.ts";
import { checkPendingInstall, startUpdater, type Updater } from "./updater/updater.ts";
import { clipboardPaths } from "./clipboardPaths.ts";
import { allowFrameNavigation, allowPermission } from "./permissions.ts";
import { textMenu } from "./textMenu.ts";
import { LOCAL_NAME, makeEnvironmentStore, normalizeServerUrl, parsePairing } from "./environments.ts";
import { pingServer } from "./relay.ts";
import { startServer } from "./server.ts";
import { installCrashReports, reportServerExit } from "./crashReports.ts";
import { installOpenFile } from "./openFile.ts";
import { testBackground, mediaTest, devServerUrl, appUrl, testDialogs } from "./app/testMode.ts";
import { win, environments, server, setWin, setEnvironments, setServer } from "./app/state.ts";
import { downloads, activeConnection, closeRelay, relay, downloadExport } from "./app/remote.ts";
import { showMini, mini, resendMini } from "./app/miniRecorder.ts";
import { crypt } from "./app/crypt.ts";
import { resources } from "./app/resources.ts";
import { appInfo, chooseFolder, chooseMedia, chooseSavePath } from "./app/dialogs.ts";
import { mediaAccess, isMediaKind, askMediaAccess, captureSources } from "./app/mediaAccess.ts";

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

// One Uncut per profile: opening it again focuses the running window. The lock is per userData
// directory, so test runs with their own UNCUT_DATA_DIR don't block each other.
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

// Our own page, ignoring query and hash (the dev server reloads itself in place).
const isAppUrl = (raw: string) => {
  try {
    const url = new URL(raw);
    return devServerUrl ? url.origin === appUrl.origin : url.protocol === "file:" && url.pathname === appUrl.pathname;
  } catch {
    return false;
  }
};

/** The http origin of the server the page was last given (SERVER_CONNECTION_CHANNEL), for allowFrameNavigation. */
let connectedServer: string | undefined;

const openIfWeb = (raw: string) => {
  if (/^https?:\/\//i.test(raw)) void shell.openExternal(raw);
};

// ---- leaving with work in progress (U12, D178) ----
// The window's close (its button, ⌘W with no project, and every quit: ⌘Q, the menu, the Dock) is
// held while the renderer looks for pending work: nothing pending answers "close" at once; else it
// answers "asking" and shows its dialog, and later "close" or "stay". A renderer that doesn't answer
// in time, crashed, hung or isn't loaded never keeps the window open. SIGTERM / SIGINT don't ask.
const CLOSE_ANSWER_MS = 2000;
let closeAllowed = false;
let quitting = false;
let closeWait: { readonly timer: ReturnType<typeof setTimeout> | undefined } | undefined;

function goClose() {
  if (closeWait?.timer) clearTimeout(closeWait.timer);
  closeWait = undefined;
  closeAllowed = true;
  if (quitting) app.quit();
  else win?.close();
}

function onWindowClose(event: Electron.Event) {
  const w = win;
  if (closeAllowed || !w) return;
  const contents = w.webContents;
  if (contents.isDestroyed() || contents.isCrashed() || contents.isLoading()) return;
  event.preventDefault();
  // Asked already: a dialog is up (the renderer brings it back), or an answer is due.
  if (!closeWait) closeWait = { timer: setTimeout(goClose, CLOSE_ANSWER_MS) };
  contents.send(CLOSE_REQUEST_CHANNEL, quitting ? "quit" : "window");
}

app.on("before-quit", () => {
  quitting = true;
});
/**
 * Signals: SIGTERM / SIGINT quit without asking. Installed once the app is ready, after Chromium's
 * own handlers, so these replace them (Chromium's would quit through the window's close, which asks).
 * In tests (UNCUT_CDP) SIGUSR2 closes the window as its close button does, which tests can't press.
 */
function installSignals() {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      closeAllowed = true;
      app.quit();
    });
  }
  if (process.env.UNCUT_CDP) process.on("SIGUSR2", () => win?.close());
}

const sendMenuCommand = (command: MenuCommand) => win?.webContents.send(MENU_COMMAND_CHANNEL, command);

// ---- the window's two sizes (D209) ----

const windowDir = () => process.env.UNCUT_DATA_DIR || app.getPath("userData");
let windowMode: WindowMode = "welcome";
let windowSizes: Record<WindowMode, WindowSize> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** The user resized or moved the window: remembered for the mode it's in. */
function rememberWindow() {
  if (!win || !windowSizes || win.isFullScreen() || win.isMaximized() || win.isMinimized()) return;
  const [width, height] = win.getContentSize();
  // A size on the way from one mode to the other isn't this mode's.
  if (width! < WINDOW_MODES[windowMode].minWidth || height! < WINDOW_MODES[windowMode].minHeight) return;
  const [x, y] = win.getPosition();
  windowSizes = { ...windowSizes, [windowMode]: { width: width!, height: height!, x: x!, y: y! } };
  clearTimeout(saveTimer);
  const sizes = windowSizes;
  saveTimer = setTimeout(() => writeWindowSizes(windowDir(), sizes), 300);
}

/** Welcome (compact) or editor (full): the minimum and the remembered size of that mode; its content size. */
function setWindowMode(mode: WindowMode): { width: number; height: number } {
  if (!win) return { width: 0, height: 0 };
  windowSizes ??= readWindowSizes(windowDir());
  if (mode === windowMode || win.isFullScreen()) {
    const [width, height] = win.getContentSize();
    return { width: width!, height: height! };
  }
  // The size the user left this mode at, before switching.
  rememberWindow();
  windowMode = mode;
  const { minWidth, minHeight } = WINDOW_MODES[mode];
  const want = windowSizes[mode];
  if (win.isMaximized()) win.unmaximize();
  win.setMinimumSize(0, 0);
  win.setContentSize(want.width, want.height);
  win.setMinimumSize(minWidth, minHeight);
  const testAt = testWindowAt({ width: win.getSize()[0]!, height: win.getSize()[1]! });
  if (testAt) win.setPosition(testAt.x, testAt.y);
  else if (want.x !== undefined && want.y !== undefined) win.setPosition(want.x, want.y);
  else win.center();
  const [width, height] = win.getContentSize();
  return { width: width!, height: height! };
}

/**
 * D216: in tests (UNCUT_CDP) the window always opens centred on the primary display, not on
 * whichever display macOS picks (the one with the focus); undefined for a release user's app
 * (remembered or macOS's choice). The helper also pins the scale and colour profile (TEST_DISPLAY_ARGS).
 */
const testWindowAt = (size: { width: number; height: number }) => (process.env.UNCUT_CDP ? centredIn(screen.getPrimaryDisplay().workArea, size) : undefined);

function createWindow() {
  windowSizes = readWindowSizes(windowDir());
  windowMode = "welcome";
  const remembered = windowSizes.welcome;
  const start = { ...remembered, ...testWindowAt(remembered) };
  setWin(
    new BrowserWindow({
      width: start.width,
      height: start.height,
      useContentSize: true,
      ...(start.x !== undefined && start.y !== undefined ? { x: start.x, y: start.y } : {}),
      // D209: compact while no project is open; setWindowMode switches to the editor's size.
      minWidth: WINDOW_MODES.welcome.minWidth,
      minHeight: WINDOW_MODES.welcome.minHeight,
      // Tests (UNCUT_CDP) get the window size they ask for even on a small screen (#89: GitHub's
      // macOS runners have a 1280×800-ish display, which clamped the editor and pushed the timeline's
      // lower tracks off the window). A release user's window stays within the screen.
      enableLargerThanScreen: Boolean(process.env.UNCUT_CDP),
      title: app.name,
      titleBarStyle: "hiddenInset",
      backgroundColor: "#0a0a0a",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        // A background test window is inactive and transparent: keep its timers and frames running.
        backgroundThrottling: !testBackground,
      },
    }),
  );
  if (!win) return;
  const contents = win.webContents;
  // The window only ever shows the app. Web links open in the default browser.
  contents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openIfWeb(url);
  });
  // A frame in the page (a graphic's sandboxed iframe, D78) may only load a graphic's document from
  // Uncut's server: never navigate itself elsewhere (a remote URL carrying a media frame, D290 review).
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame || allowFrameNavigation(event.url, connectedServer)) return;
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    openIfWeb(url);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // D266: a reload (an environment switch) or navigation makes the new page ask for a Finder open again.
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) openFile.rendererReloaded();
  });
  // Issue #49: Cut, Copy, Paste and Select All on selected text and in text fields. Tests log the
  // menu instead of opening it (a native menu would wait for a click nobody makes).
  contents.on("context-menu", (_event, params) => {
    const items = textMenu(params);
    if (!items || !win) return;
    if (process.env.UNCUT_CDP)
      return void console.log(`[test] text menu ${items.map((i) => ("role" in i ? `${i.role}${i.enabled ? "" : ":off"}` : "-")).join(",")}`);
    Menu.buildFromTemplate(items.map((i) => ({ ...i }))).popup({ window: win });
  });
  // The only downloads are the ones downloadExport asked for (D109); anything else is cancelled.
  contents.session.on("will-download", (_event, item) => {
    const wanted = downloads.get(item.getURL());
    if (!wanted) return item.cancel();
    downloads.delete(item.getURL());
    item.setSavePath(wanted.path);
    item.once("done", (_e, state) =>
      wanted.done(
        state === "completed"
          ? { path: wanted.path }
          : { error: state === "cancelled" ? "The download was cancelled." : "The download stopped before the end." },
      ),
    );
  });
  // Camera, microphone and screen (D114), and the few other permissions the app uses (D219,
  // permissions.ts), only for the app's own top-level page: a graphic's sandboxed iframe (D78) or
  // any other page gets none, and nothing else is granted to anyone.
  const session = contents.session;
  session.setPermissionRequestHandler((requester, permission, callback, details) => {
    callback(allowPermission(permission, requester === win?.webContents && details.isMainFrame && isAppUrl(details.requestingUrl ?? "")));
  });
  session.setPermissionCheckHandler((requester, permission, _origin, details) => {
    return allowPermission(
      permission,
      requester !== null && requester === win?.webContents && details.isMainFrame && isAppUrl(details.requestingUrl ?? requester.getURL()),
    );
  });
  // getDisplayMedia records the screen or window the Capture tab picked (chooseDisplaySource just before).
  // D210: with systemAudio, this Mac's sound too ("loopback": the speakers keep playing); for a
  // take of the sound alone the Capture tab asks for "any screen" (getDisplayMedia always has a
  // picture) and records only the audio track.
  session.setDisplayMediaRequestHandler((request, callback) => {
    const wanted = pendingDisplaySource;
    pendingDisplaySource = undefined;
    const frame = request.frame;
    if (!wanted || mediaTest || !frame || !fromAppFrame(frame)) return callback({});
    desktopCapturer
      .getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const source = wanted.id === ANY_SCREEN ? sources.find((s) => s.id.startsWith("screen:")) : sources.find((s) => s.id === wanted.id);
        callback(source ? { video: source, ...(wanted.systemAudio && request.audioRequested ? { audio: "loopback" as const } : {}) } : {});
      })
      .catch(() => callback({}));
  });
  // A graphic item's sandboxed iframe (D78) can't reach anyone over WebRTC either: Chromium honours
  // no CSP webrtc directive, and without a proxy this keeps UDP (STUN) off. The app uses no WebRTC.
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  // A background test run is silent too (D83): the page's audio graph runs and meters as usual,
  // but nothing reaches the speakers.
  if (testBackground) contents.setAudioMuted(true);
  win.once("ready-to-show", () => {
    if (!testBackground) return win?.show();
    win?.setOpacity(0);
    // Invisible must also mean untouchable: the user's clicks pass through to what's behind it.
    // (Puppeteer's input goes straight to the page over CDP, not through the window.)
    win?.setIgnoreMouseEvents(true);
    win?.showInactive();
  });
  win.on("resize", rememberWindow);
  win.on("move", rememberWindow);
  win.on("close", onWindowClose);
  // A renderer that's gone or stuck can't answer: the close goes ahead.
  contents.on("render-process-gone", () => closeWait && goClose());
  win.on("unresponsive", () => closeWait && goClose());
  win.on("closed", () => {
    setWin(undefined);
    showMini(null);
  });
  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// Only the app's own top-level page may use the bridge (the server's token, dialogs, Finder).
const fromAppWindow = (event: IpcMainInvokeEvent | IpcMainEvent) => {
  const frame = event.senderFrame;
  return win !== undefined && event.sender === win.webContents && frame !== null && frame.parent === null && isAppUrl(frame.url);
};
const fromAppFrame = (frame: WebFrameMain) => win !== undefined && frame.parent === null && frame === win.webContents.mainFrame && isAppUrl(frame.url);

// D252: a .uncut project opened from Finder or the Dock (before ready, so the first open-file isn't missed).
// D266: only on Local; on a remote it's dropped with a notice, never opened later by surprise.
const openFile = installOpenFile({
  isAppWindow: fromAppWindow,
  send: sendMenuCommand,
  show: () => {
    if (testBackground) return;
    win?.show();
    win?.focus();
  },
  isLocal: () => (environments ? environments.active().kind === "local" : undefined),
  notifyRemote: (dir) => {
    const name = path.basename(dir);
    if (testBackground || process.env.UNCUT_CDP) return void console.log(`[test] open-file on a remote: ${name}`);
    const options = {
      type: "info" as const,
      message: `Switch to ${LOCAL_NAME} to open this project`,
      detail: `“${name}” is on this Mac, and Uncut is connected to ${environments?.active().name ?? "a remote environment"}. Switch to ${LOCAL_NAME} in Environments, then open it again.`,
      buttons: ["OK"],
    };
    void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  },
});

// ---- recording on this Mac (D114) ----

// The screen or window the next getDisplayMedia records (set by the Capture tab just before), and
// whether with this Mac's sound (D210).
let pendingDisplaySource: { readonly id: string; readonly systemAudio: boolean } | undefined;
/** D210: any screen (a take of this Mac's sound alone: the picture isn't kept). */
const ANY_SCREEN = "screen:any";

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (testBackground) return;
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  installSignals();
  // D223: main's crashes go to the server's telemetry spool.
  installCrashReports(process.env.UNCUT_DATA_DIR || app.getPath("userData"));
  setEnvironments(makeEnvironmentStore(process.env.UNCUT_DATA_DIR || app.getPath("userData"), crypt));
  openFile.environmentsReady();
  setServer(
    startServer({
      ...resources,
      // Tests point this at a temp dir so they never touch the real recents.
      dataDir: process.env.UNCUT_DATA_DIR || app.getPath("userData"),
      // The local server going away matters to the window only while it shows Local.
      onExit: (reason) => {
        reportServerExit(process.env.UNCUT_DATA_DIR || app.getPath("userData"), reason);
        if (environments?.active().kind !== "remote") win?.webContents.send(SERVER_EXIT_CHANNEL, reason);
      },
      // Generator keys (D99): safeStorage (its own key lives in the macOS Keychain); only the
      // ciphertext reaches the server's keys.json.
      keys: crypt,
    }),
  );
  const handle = <A extends Array<unknown>, R>(channel: string, fn: (...args: A) => R) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromAppWindow(event)) throw new Error("not allowed");
      return fn(...(args as A));
    });
  handle(SERVER_CONNECTION_CHANNEL, () =>
    activeConnection().then((c) => {
      // The server the page talks to (local or the relay, both on 127.0.0.1): its graphics' documents load in frames.
      connectedServer = c.url.replace(/^ws/, "http");
      return c;
    }),
  );
  handle(ENVIRONMENTS_CHANNEL, () => environments!.list());
  handle(ENVIRONMENT_ADD_CHANNEL, (input: { name?: unknown; url?: unknown; token?: unknown }) => {
    if (typeof input?.url !== "string" || typeof input.token !== "string" || typeof input.name !== "string") throw new Error("not an environment");
    try {
      return environments!.add({ name: input.name, url: input.url, token: input.token });
    } catch (error) {
      return { problem: `Couldn't keep the token safely: ${(error as Error).message}` };
    }
  });
  handle(ENVIRONMENT_TEST_CHANNEL, async (input: { url?: unknown; token?: unknown; id?: unknown }): Promise<EnvironmentTest> => {
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
  handle(ENVIRONMENT_RENAME_CHANNEL, (id: unknown, name: unknown) => typeof id === "string" && typeof name === "string" && environments!.rename(id, name));
  handle(ENVIRONMENT_REMOVE_CHANNEL, async (id: unknown) => {
    if (typeof id !== "string") return false;
    const wasActive = environments!.active().id === id;
    const removed = environments!.remove(id);
    // Removing the one on screen goes back to Local.
    if (removed && wasActive) {
      await closeRelay();
      win?.webContents.reload();
    }
    return removed;
  });
  handle(ENVIRONMENT_SWITCH_CHANNEL, async (id: unknown) => {
    if (typeof id !== "string" || !environments!.setActive(id)) return false;
    // A fresh page for the other environment: nothing of one server's projects carries over (D106).
    await closeRelay();
    win?.webContents.reload();
    return true;
  });
  handle(ENVIRONMENT_STATUS_CHANNEL, () => ({ problem: relay?.relay.problem() }));
  handle(DOWNLOAD_EXPORT_CHANNEL, (jobId: string, name: string) => downloadExport(jobId, name));
  handle(APP_INFO_CHANNEL, (): AppInfo => appInfo);
  handle(CHOOSE_FOLDER_CHANNEL, (purpose: FolderPurpose) => chooseFolder(purpose));
  handle(CHOOSE_MEDIA_CHANNEL, () => chooseMedia());
  handle(CHOOSE_SAVE_PATH_CHANNEL, (defaultPath: string) => chooseSavePath(defaultPath));
  handle(SHOW_IN_FOLDER_CHANNEL, (target: string) => {
    if (typeof target !== "string" || !path.isAbsolute(target)) throw new Error("not an absolute path");
    if (testDialogs) console.log(`[test] showItemInFolder ${target}`);
    else shell.showItemInFolder(target);
  });
  handle(COPY_TEXT_CHANNEL, (text: string) => {
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
  handle(ASK_MEDIA_ACCESS_CHANNEL, (kind: unknown) => {
    if (!isMediaKind(kind)) throw new Error("not a media kind");
    return askMediaAccess(kind);
  });
  handle(OPEN_PRIVACY_SETTINGS_CHANNEL, (kind: unknown) => {
    if (!isMediaKind(kind)) throw new Error("not a media kind");
    const url = privacySettingsUrl(kind);
    if (mediaTest) console.log(`[test] open ${url}`);
    else void shell.openExternal(url);
  });
  handle(CAPTURE_SOURCES_CHANNEL, () => captureSources());
  handle(CHOOSE_DISPLAY_SOURCE_CHANNEL, (id: unknown, options: unknown) => {
    if (typeof id !== "string" || id.length > 200) throw new Error("not a source id");
    const systemAudio = Boolean(options && typeof options === "object" && (options as { systemAudio?: unknown }).systemAudio === true);
    pendingDisplaySource = { id, systemAudio };
  });
  handle(SYSTEM_AUDIO_CHANNEL, () => systemAudioSupport(process.platform, process.getSystemVersion(), process.env));
  // A background test window plays its preview to no output device (sinkId "none"): no sound, and
  // no device latency (Bluetooth headphones add ~0.25 s) between the clock and what is captured.
  ipcMain.on(SILENT_AUDIO_CHANNEL, (event) => {
    event.returnValue = fromAppWindow(event) && testBackground;
  });
  ipcMain.on(CLOSE_ANSWER_CHANNEL, (event, answer: CloseAnswer) => {
    if (!fromAppWindow(event) || !closeWait) return;
    if (answer === "close") return goClose();
    if (closeWait.timer) clearTimeout(closeWait.timer);
    if (answer === "asking") closeWait = { timer: undefined };
    else {
      // Cancel: the quit (if it was one) is off; the next close asks again.
      closeWait = undefined;
      quitting = false;
    }
  });
  ipcMain.on(APP_STATE_CHANNEL, (event, state: AppState) => {
    if (fromAppWindow(event)) setAppMenu(state, sendMenuCommand);
  });
  // D209: the mini recorder's state comes from the app window; its buttons go back there.
  ipcMain.on(MINI_RECORDER_CHANNEL, (event, state: MiniRecorderState | null) => {
    if (!fromAppWindow(event)) return;
    showMini(state && typeof state === "object" && typeof state.name === "string" ? state : null);
  });
  ipcMain.on(MINI_RECORDER_ACTION_CHANNEL, (event, action: MiniRecorderAction) => {
    if (!mini || event.sender !== mini.webContents) return;
    if (action === "ready") return resendMini();
    if (!["stop", "pause", "resume", "cancel"].includes(action)) return;
    if (testBackground) console.log(`[test] mini recorder ${action}`);
    win?.webContents.send(MINI_RECORDER_ACTION_CHANNEL, action);
  });
  // D209: the renderer asks for the editor's size before it shows a project, the compact one after.
  handle(WINDOW_MODE_CHANNEL, (mode: unknown) => {
    if (mode !== "welcome" && mode !== "editor") throw new Error("not a window mode");
    return setWindowMode(mode);
  });
  setAppMenu({ projectOpen: false, recents: [], environments: false }, sendMenuCommand);
  createWindow();
  installUpdates();
});

// ---- auto-update (#102, D276) ----

let updater: Updater | undefined;
// What the renderer last said (an export, a recording or an agent turn running), kept until the updater is up.
let updateBusy = false;

function installUpdates() {
  void startUpdater({
    dataDir: process.env.UNCUT_DATA_DIR || app.getPath("userData"),
    send: (status) => win?.webContents.send(UPDATE_STATUS_CHANNEL, status),
    // The renderer asked about pending work before it called install; now nothing may hold the quit:
    // the server is stopped first (will-quit then has nothing to wait for) and the close isn't asked again.
    beforeInstall: async () => {
      closeAllowed = true;
      const stopping = server;
      setServer(undefined);
      await Promise.allSettled([stopping?.stop(), closeRelay()]);
    },
    onPolicy: (policy) => setUpdateMenu({ ...updateMenuState(policy, pendingUpdate === "hold-updates"), check: () => updater?.checkNow() }),
    hold: pendingUpdate === "hold-updates",
  }).then(
    (u) => {
      updater = u;
      u.setBusy(updateBusy);
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
  ipcMain.on(UPDATE_BUSY_CHANNEL, (event, busy: unknown) => {
    if (!fromAppWindow(event)) return;
    updateBusy = busy === true;
    updater?.setBusy(updateBusy);
  });
}

// One window for now; closing it ends the app (and the server with it).
app.on("window-all-closed", () => app.quit());

app.on("will-quit", (event) => {
  void closeRelay();
  if (!server?.running()) return;
  // Hold the quit until the server is really gone (stop() is bounded: SIGKILL after 1.5 s).
  // Re-quit on a later tick: Electron ignores app.quit() while will-quit is still dispatching.
  event.preventDefault();
  const stopping = server;
  setServer(undefined);
  void stopping.stop().finally(() => setImmediate(() => app.quit()));
});
