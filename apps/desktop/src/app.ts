import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, screen, safeStorage, shell, systemPreferences, type IpcMainEvent, type IpcMainInvokeEvent, type WebFrameMain } from "electron";

import {
  APP_INFO_CHANNEL,
  APP_STATE_CHANNEL,
  ASK_MEDIA_ACCESS_CHANNEL,
  CAPTURE_SOURCES_CHANNEL,
  CHOOSE_DISPLAY_SOURCE_CHANNEL,
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
  type CaptureSource,
  type CloseAnswer,
  type EnvironmentTest,
  type FolderPurpose,
  type MediaAccess,
  type MediaAccessKind,
  type MenuCommand,
  WINDOW_MODE_CHANNEL,
  MINI_RECORDER_ACTION_CHANNEL,
  MINI_RECORDER_CHANNEL,
  MINI_RECORDER_STATE_CHANNEL,
  type MiniRecorderAction,
  type MiniRecorderState,
} from "./ipc.ts";
import { readWindowSizes, WINDOW_MODES, writeWindowSizes, type WindowMode, type WindowSize } from "./windowState.ts";
import { BACKGROUND_SWITCHES, isTestBackground, privacySettingsUrl, TEST_MEDIA_SWITCHES, testMedia } from "./background.ts";
import { setAppMenu } from "./menu.ts";
import { clipboardPaths } from "./clipboardPaths.ts";
import { LOCAL_ID, makeEnvironmentStore, normalizeServerUrl, parsePairing, type Crypt, type EnvironmentStore } from "./environments.ts";
import { pingServer, startRelay, type Relay } from "./relay.ts";
import { startServer, type ServerProcess } from "./server.ts";

// Lets tests drive the window with puppeteer (same switch as the phase 2 spike).
if (process.env.UNCUT_CDP) app.commandLine.appendSwitch("remote-debugging-port", process.env.UNCUT_CDP);

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

// Tests can't click native dialogs: with UNCUT_TEST_DIALOG (a JSON array of paths, used in
// order; an exhausted queue means "cancelled") the dialogs answer from it instead. Only
// together with UNCUT_CDP, so a stray variable can't change a release user's app. In the
// same mode "Show in Finder" and Copy are logged instead of touching Finder or the clipboard.
// Entries are a path (folder dialogs) or an array of paths (the multi-select media dialog).
const testDialogs: Array<string | Array<string>> | undefined =
  process.env.UNCUT_CDP && process.env.UNCUT_TEST_DIALOG ? (JSON.parse(process.env.UNCUT_TEST_DIALOG) as Array<string | Array<string>>) : undefined;

// Generator keys in tests (D101): with UNCUT_TEST_KEYS=standin, and only together with UNCUT_CDP,
// keys are wrapped by a reversible stand-in instead of safeStorage, so a packaged-app test that saves
// a key never creates or prompts for a Keychain item. A release user's app always uses safeStorage.
const testKeys = Boolean(process.env.UNCUT_CDP) && process.env.UNCUT_TEST_KEYS === "standin";

// Tests run in the background (UNCUT_TEST_BACKGROUND=1, only with UNCUT_CDP): no dock icon, and
// the window is shown inactive and fully transparent, so test runs never steal focus or cover what
// the user is doing. CDP screenshots read the page, not the screen, so they are unaffected.
const testBackground = isTestBackground(process.env);
if (testBackground) {
  app.dock?.hide();
  // An accessory app (no dock icon, no menu bar) is never made the active app by showing a window.
  app.setActivationPolicy?.("accessory");
  for (const name of BACKGROUND_SWITCHES) app.commandLine.appendSwitch(name);
}

// Recording on this Mac in tests (D114): fake devices, permission states from the test, a stand-in
// screen source. Never macOS's prompts, never the real camera, microphone or screen.
const mediaTest = testMedia(process.env);
if (mediaTest) for (const name of TEST_MEDIA_SWITCHES) app.commandLine.appendSwitch(name);

// __dirname is apps/desktop/dist in dev and app.asar/dist when packaged.
const repoRoot = path.resolve(__dirname, "../../..");
const resources = app.isPackaged
  ? {
      serverEntry: path.join(process.resourcesPath, "server", "server.mjs"),
      mediaBin: path.join(process.resourcesPath, "bin", "uncut-media"),
      modulesDir: path.join(process.resourcesPath, "modules", "builtin"),
      musicDir: path.join(process.resourcesPath, "music"),
      sfxDir: path.join(process.resourcesPath, "sfx"),
      graphicLibsDir: path.join(process.resourcesPath, "graphic-libs"),
      fontsDir: path.join(process.resourcesPath, "fonts"),
      // Plugins shipped with the app (D97).
      bundledPluginsDir: path.join(process.resourcesPath, "plugins"),
      pluginSdkDir: path.join(process.resourcesPath, "plugin-sdk"),
      renderEntry: undefined,
    }
  : {
      serverEntry: path.join(repoRoot, "apps/server/dist/server.mjs"),
      mediaBin: path.join(repoRoot, "native/media/target/release/uncut-media"),
      modulesDir: path.join(repoRoot, "spec/modules/builtin"),
      musicDir: path.join(repoRoot, "assets/music"),
      sfxDir: path.join(repoRoot, "assets/sfx"),
      graphicLibsDir: path.join(repoRoot, "assets/graphic-libs"),
      fontsDir: path.join(repoRoot, "assets/fonts"),
      bundledPluginsDir: path.join(repoRoot, "plugins"),
      pluginSdkDir: path.join(repoRoot, "packages/plugin-sdk/src"),
      // Under `pnpm dev` the binary is a bare Electron: it needs this bundle to be the rasteriser.
      renderEntry: path.join(__dirname, "main.cjs"),
    };

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const appUrl = devServerUrl ? new URL(devServerUrl) : pathToFileURL(path.join(__dirname, "renderer", "index.html"));

// Our own page, ignoring query and hash (the dev server reloads itself in place).
const isAppUrl = (raw: string) => {
  try {
    const url = new URL(raw);
    return devServerUrl ? url.origin === appUrl.origin : url.protocol === "file:" && url.pathname === appUrl.pathname;
  } catch {
    return false;
  }
};

const openIfWeb = (raw: string) => {
  if (/^https?:\/\//i.test(raw)) void shell.openExternal(raw);
};

let server: ServerProcess | undefined;
let win: BrowserWindow | undefined;

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

const home = homedir();
const appInfo: AppInfo = {
  homeDir: home,
  defaultParentDir: existsSync(path.join(home, "Movies")) ? path.join(home, "Movies") : home,
};

const sendMenuCommand = (command: MenuCommand) => win?.webContents.send(MENU_COMMAND_CHANNEL, command);

const MEDIA_EXTENSIONS = ["mp4", "mov", "m4v", "m4a", "mp3", "wav", "aac", "aif", "aiff", "flac", "png", "jpg", "jpeg", "heic", "gif", "webp", "srt", "vtt"];

/** Native multi-select for footage, music and images; [] when cancelled. */
async function chooseMedia(): Promise<Array<string>> {
  if (testDialogs) {
    const next = testDialogs.shift();
    return Array.isArray(next) ? next : typeof next === "string" ? [next] : [];
  }
  if (!win) return [];
  const result = await dialog.showOpenDialog(win, {
    title: "Import media",
    buttonLabel: "Import",
    defaultPath: appInfo.defaultParentDir,
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Video, audio, images and subtitles", extensions: MEDIA_EXTENSIONS },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
}

/** Where to save an export (or, D109, a remote export's download): the native save panel (it asks before replacing a file); null when cancelled. */
async function chooseSavePath(defaultPath: string, title = "Export video"): Promise<string | null> {
  if (testDialogs) {
    const next = testDialogs.shift();
    return typeof next === "string" ? next : null;
  }
  if (!win) return null;
  const result = await dialog.showSaveDialog(win, {
    title,
    buttonLabel: "Choose",
    defaultPath: typeof defaultPath === "string" && path.isAbsolute(defaultPath) ? defaultPath : path.join(appInfo.defaultParentDir, "Untitled.mp4"),
    filters: [{ name: "MP4 video", extensions: ["mp4"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  return result.canceled || !result.filePath ? null : result.filePath;
}

async function chooseFolder(purpose: FolderPurpose): Promise<string | null> {
  if (testDialogs) {
    const next = testDialogs.shift();
    return typeof next === "string" ? next : null;
  }
  if (!win) return null;
  if (purpose === "brand") {
    const picked = await dialog.showOpenDialog(win, {
      title: "Import into the kit",
      buttonLabel: "Import",
      message: "Choose a logo, a font file or a folder with them.",
      defaultPath: app.getPath("home"),
      properties: ["openFile", "openDirectory"],
    });
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  }
  if (purpose === "sounds") {
    const picked = await dialog.showOpenDialog(win, {
      title: "Add a sound folder",
      buttonLabel: "Add",
      message: "Its sound files appear in the Folders view. Nothing is copied until you add a sound to a project.",
      defaultPath: app.getPath("home"),
      properties: ["openDirectory"],
    });
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  }
  const result = await dialog.showOpenDialog(win, {
    title: purpose === "parent" ? "Choose where to save the project" : purpose === "plugin" ? "Add a plugin" : "Open a project",
    buttonLabel: purpose === "parent" ? "Choose" : purpose === "plugin" ? "Add" : "Open",
    message:
      purpose === "parent"
        ? "The project folder (Name.uncut) is created inside this folder."
        : purpose === "plugin"
          ? "Choose a plugin folder (it has an uncut.module.json). Uncut copies it; you allow it next."
          : "Choose a .uncut project folder.",
    defaultPath: appInfo.defaultParentDir,
    properties: purpose === "parent" ? ["openDirectory", "createDirectory"] : ["openDirectory"],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

// ---- environments (Phase 9, D106) ----

// Generator keys and remote tokens are both wrapped by safeStorage (D99), or by the test stand-in.
const crypt: Crypt = testKeys
  ? {
      encrypt: (text) => `test-standin:${Buffer.from(text, "utf8").toString("base64")}`,
      decrypt: (data) => {
        if (!data.startsWith("test-standin:")) throw new Error("not a test key");
        return Buffer.from(data.slice("test-standin:".length), "base64").toString("utf8");
      },
    }
  : {
      encrypt: (text) => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("This Mac's Keychain isn't available to Uncut.");
        return safeStorage.encryptString(text).toString("base64");
      },
      decrypt: (data) => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("This Mac's Keychain isn't available to Uncut.");
        return safeStorage.decryptString(Buffer.from(data, "base64"));
      },
    };

let environments: EnvironmentStore | undefined;
// The relay to the active remote, if the active environment is one.
let relay: { readonly id: string; readonly relay: Relay } | undefined;
const devOrigins = devServerUrl ? [new URL(devServerUrl).origin] : [];

async function closeRelay() {
  const open = relay;
  relay = undefined;
  await open?.relay.close().catch(() => {});
}

/** The active environment's connection: the local server's, or the relay to the remote one. */
async function activeConnection() {
  if (!environments || !server) throw new Error("the app is quitting");
  const env = environments.active();
  if (env.kind === "local") {
    await closeRelay();
    return { ...(await server.connection), environment: { id: LOCAL_ID, name: env.name, kind: "local" as const } };
  }
  if (relay?.id !== env.id) {
    await closeRelay();
    let secret: { url: string; token: string } | undefined;
    try {
      secret = environments.secret(env.id);
    } catch (error) {
      throw new Error(`Can't read the token for ${env.name}: ${(error as Error).message}`);
    }
    if (!secret) throw new Error(`${env.name} isn't in the environments list any more`);
    relay = { id: env.id, relay: await startRelay({ target: secret.url, token: secret.token, allowedOrigins: devOrigins }) };
  }
  return { url: relay.relay.wsUrl, token: relay.relay.token, environment: { id: env.id, name: env.name, kind: "remote" as const, ...(env.url ? { url: env.url } : {}) } };
}

// Downloads this window asked for (D109), by URL: where each goes and who's waiting.
const downloads = new Map<string, { readonly path: string; readonly done: (result: { path: string } | { error: string }) => void }>();

/** A remote export's video, streamed through the relay to a path the user picks here; null when cancelled. */
async function downloadExport(jobId: string, name: string): Promise<{ path: string } | { error: string } | null> {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) throw new Error("not an export id");
  const open = relay;
  if (!open || !win) return { error: "Downloads are for exports on a remote environment." };
  const base = typeof name === "string" && name ? path.basename(name) : "Export.mp4";
  const target = await chooseSavePath(path.join(appInfo.defaultParentDir, base), "Download export");
  if (!target) return null;
  const url = `${open.relay.httpBase}/api/export/${encodeURIComponent(jobId)}?token=${encodeURIComponent(open.relay.token)}`;
  return new Promise((done) => {
    downloads.set(url, { path: target, done });
    win!.webContents.downloadURL(url);
  });
}

// ---- the floating mini recorder (D209) ----

// While the screen is recorded: a small window over every app with the timer, Pause, Stop and
// Cancel. Left out of screen captures (content protection), so it isn't in the take. In a
// background test run it's created like the main window (invisible, untouchable) and logged.
let mini: BrowserWindow | undefined;
let miniState: MiniRecorderState | null = null;
const MINI_SIZE = { width: 320, height: 64 };

function showMini(state: MiniRecorderState | null) {
  miniState = state;
  if (!state) {
    if (mini) {
      if (testBackground) console.log("[test] mini recorder closed");
      mini.destroy();
      mini = undefined;
    }
    return;
  }
  if (mini) return mini.webContents.send(MINI_RECORDER_STATE_CHANNEL, state);
  const area = screen.getPrimaryDisplay().workArea;
  mini = new BrowserWindow({
    ...MINI_SIZE,
    x: Math.round(area.x + area.width / 2 - MINI_SIZE.width / 2),
    y: area.y + 12,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    transparent: true,
    alwaysOnTop: true,
    show: false,
    title: "Uncut recording",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const w = mini;
  w.setAlwaysOnTop(true, "floating");
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.setContentProtection(true);
  w.webContents.on("will-navigate", (event) => event.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.once("did-finish-load", () => {
    if (mini === w && miniState) w.webContents.send(MINI_RECORDER_STATE_CHANNEL, miniState);
  });
  w.once("ready-to-show", () => {
    if (!testBackground) return w.showInactive();
    w.setOpacity(0);
    w.setIgnoreMouseEvents(true);
    w.showInactive();
  });
  w.on("closed", () => {
    if (mini === w) mini = undefined;
  });
  if (testBackground) console.log(`[test] mini recorder opened: ${state.name}`);
  if (devServerUrl) void w.loadURL(`${devServerUrl}?mini`);
  else void w.loadFile(path.join(__dirname, "renderer", "index.html"), { search: "mini" });
}

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
  if (want.x !== undefined && want.y !== undefined) win.setPosition(want.x, want.y);
  else win.center();
  const [width, height] = win.getContentSize();
  return { width: width!, height: height! };
}

function createWindow() {
  windowSizes = readWindowSizes(windowDir());
  windowMode = "welcome";
  const start = windowSizes.welcome;
  win = new BrowserWindow({
    width: start.width,
    height: start.height,
    useContentSize: true,
    ...(start.x !== undefined && start.y !== undefined ? { x: start.x, y: start.y } : {}),
    // D209: compact while no project is open; setWindowMode switches to the editor's size.
    minWidth: WINDOW_MODES.welcome.minWidth,
    minHeight: WINDOW_MODES.welcome.minHeight,
    title: "Uncut",
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
  });
  const contents = win.webContents;
  // The window only ever shows the app. Web links open in the default browser.
  contents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openIfWeb(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    openIfWeb(url);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // The only downloads are the ones downloadExport asked for (D109); anything else is cancelled.
  contents.session.on("will-download", (_event, item) => {
    const wanted = downloads.get(item.getURL());
    if (!wanted) return item.cancel();
    downloads.delete(item.getURL());
    item.setSavePath(wanted.path);
    item.once("done", (_e, state) => wanted.done(state === "completed" ? { path: wanted.path } : { error: state === "cancelled" ? "The download was cancelled." : "The download stopped before the end." }));
  });
  // Camera, microphone and screen (D114) only for the app's own top-level page: a graphic's
  // sandboxed iframe (D78) or any other page gets none. Other permissions keep Electron's default.
  const session = contents.session;
  const mediaPermission = (permission: string) => permission === "media" || permission === "display-capture";
  session.setPermissionRequestHandler((requester, permission, callback, details) => {
    if (!mediaPermission(permission)) return callback(true);
    callback(requester === win?.webContents && details.isMainFrame && isAppUrl(details.requestingUrl ?? ""));
  });
  session.setPermissionCheckHandler((requester, permission, _origin, details) => {
    if (!mediaPermission(permission)) return true;
    return requester !== null && requester === win?.webContents && details.isMainFrame && isAppUrl(details.requestingUrl ?? requester.getURL());
  });
  // getDisplayMedia records the screen or window the Capture tab picked (chooseDisplaySource just before).
  session.setDisplayMediaRequestHandler((request, callback) => {
    const wanted = pendingDisplaySource;
    pendingDisplaySource = undefined;
    const frame = request.frame;
    if (!wanted || mediaTest || !frame || !fromAppFrame(frame)) return callback({});
    desktopCapturer
      .getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const source = sources.find((s) => s.id === wanted);
        callback(source ? { video: source } : {});
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
    win = undefined;
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

// ---- recording on this Mac (D114) ----

// The screen or window the next getDisplayMedia records (set by the Capture tab just before).
let pendingDisplaySource: string | undefined;
const MEDIA_KINDS: ReadonlyArray<MediaAccessKind> = ["microphone", "camera", "screen"];
const isMediaKind = (x: unknown): x is MediaAccessKind => MEDIA_KINDS.includes(x as MediaAccessKind);

/** macOS's answer for each (tests: the test's states, macOS never asked). */
function mediaAccess(): Record<MediaAccessKind, MediaAccess> {
  if (mediaTest) return { ...mediaTest.access };
  const read = (kind: MediaAccessKind) => {
    try {
      return systemPreferences.getMediaAccessStatus(kind) as MediaAccess;
    } catch {
      return "unknown" as const;
    }
  };
  return { microphone: read("microphone"), camera: read("camera"), screen: read("screen") };
}

/** Asks macOS for the microphone or camera (its prompt shows only while it's "not-determined"); the state after. */
async function askMediaAccess(kind: MediaAccessKind): Promise<MediaAccess> {
  if (mediaTest) return mediaTest.access[kind];
  if (kind === "screen") return mediaAccess().screen;
  if (systemPreferences.getMediaAccessStatus(kind) === "not-determined") await systemPreferences.askForMediaAccess(kind).catch(() => false);
  return mediaAccess()[kind];
}

/** Tests' stand-in screen picture: a 160×100 dark frame with a green block (BGRA). */
function standinThumbnail(): string {
  const width = 160;
  const height = 100;
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const block = x > 30 && x < 70 && y > 35 && y < 75;
      px[i] = block ? 0x80 : 0x20;
      px[i + 1] = block ? 0xde : 0x18;
      px[i + 2] = block ? 0x4a : 0x10;
      px[i + 3] = 0xff;
    }
  return nativeImage.createFromBitmap(px, { width, height }).toDataURL();
}

/** Screens and windows to record, with small pictures; never Uncut's own window. Tests: stand-ins. */
async function captureSources(): Promise<Array<CaptureSource>> {
  if (mediaTest) {
    // D209: the stand-in screen has a picture drawn here (a data: URL like desktopCapturer's), the
    // stand-in window none, so both the picture and the placeholder are on screen in tests.
    return [
      { id: "standin:screen:1", name: "Test screen", kind: "screen", thumbnail: standinThumbnail() },
      { id: "standin:window:1", name: "Test window", kind: "window", thumbnail: "" },
    ];
  }
  const own = win?.getMediaSourceId();
  // thumbnailSize: without one the pictures are 150×150; the app icon is the fallback for a window
  // whose picture is empty (macOS gives none for a minimised one, or before Screen Recording is on).
  const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 480, height: 300 }, fetchWindowIcons: true });
  const url = (image: Electron.NativeImage | null | undefined) => (image && !image.isEmpty() ? image.toDataURL() : "");
  return sources
    .filter((s) => s.id !== own)
    .map((s) => ({ id: s.id, name: s.name, kind: s.id.startsWith("screen:") ? ("screen" as const) : ("window" as const), thumbnail: url(s.thumbnail), ...(url(s.appIcon) ? { icon: url(s.appIcon) } : {}) }));
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (testBackground) return;
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  installSignals();
  environments = makeEnvironmentStore(process.env.UNCUT_DATA_DIR || app.getPath("userData"), crypt);
  server = startServer({
    ...resources,
    // Tests point this at a temp dir so they never touch the real recents.
    dataDir: process.env.UNCUT_DATA_DIR || app.getPath("userData"),
    // The local server going away matters to the window only while it shows Local.
    onExit: (reason) => {
      if (environments?.active().kind !== "remote") win?.webContents.send(SERVER_EXIT_CHANNEL, reason);
    },
    // Generator keys (D99): safeStorage (its own key lives in the macOS Keychain); only the
    // ciphertext reaches the server's keys.json.
    keys: crypt,
  });
  const handle = <A extends Array<unknown>, R>(channel: string, fn: (...args: A) => R) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromAppWindow(event)) throw new Error("not allowed");
      return fn(...(args as A));
    });
  handle(SERVER_CONNECTION_CHANNEL, () => activeConnection());
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
    if (process.env.UNCUT_CDP) return process.env.UNCUT_TEST_CLIPBOARD ? (JSON.parse(process.env.UNCUT_TEST_CLIPBOARD) as Array<string>).filter((p) => typeof p === "string" && path.isAbsolute(p)) : [];
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
  handle(CHOOSE_DISPLAY_SOURCE_CHANNEL, (id: unknown) => {
    if (typeof id !== "string" || id.length > 200) throw new Error("not a source id");
    pendingDisplaySource = id;
  });
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
    if (!mini || event.sender !== mini.webContents || !["stop", "pause", "resume", "cancel"].includes(action)) return;
    if (testBackground) console.log(`[test] mini recorder ${action}`);
    win?.webContents.send(MINI_RECORDER_ACTION_CHANNEL, action);
  });
  // D209: the renderer asks for the editor's size before it shows a project, the compact one after.
  handle(WINDOW_MODE_CHANNEL, (mode: unknown) => {
    if (mode !== "welcome" && mode !== "editor") throw new Error("not a window mode");
    return setWindowMode(mode);
  });
  setAppMenu({ projectOpen: false, recents: [] }, sendMenuCommand);
  createWindow();
});

// One window for now; closing it ends the app (and the server with it).
app.on("window-all-closed", () => app.quit());

app.on("will-quit", (event) => {
  void closeRelay();
  if (!server?.running()) return;
  // Hold the quit until the server is really gone (stop() is bounded: SIGKILL after 1.5 s).
  // Re-quit on a later tick: Electron ignores app.quit() while will-quit is still dispatching.
  event.preventDefault();
  const stopping = server;
  server = undefined;
  void stopping.stop().finally(() => setImmediate(() => app.quit()));
});
