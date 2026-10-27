// Several projects at once: one window per project, each with its own local server (the server
// keeps one project). A window, its server and its sizes; asking before it closes (U12); stopping
// every server on the way out. macOS's own tabs merge the windows (Window › Merge All Windows).
import * as path from "node:path";

import { app, BrowserWindow, desktopCapturer, Menu, screen, shell, type Session, type WebFrameMain } from "electron";

import { CLOSE_REQUEST_CHANNEL, SERVER_EXIT_CHANNEL, type CloseAnswer } from "../ipc.ts";
import { readWindowSizes, WINDOW_MODES, writeWindowSizes, type WindowMode, type WindowSize } from "../windowState.ts";
import { cascade } from "../windowRouter.ts";
import { centredIn } from "../background.ts";
import { allowFrameNavigation, allowPermission } from "../permissions.ts";
import { textMenu } from "../textMenu.ts";
import { startServer } from "../server.ts";
import { reportServerExit } from "../crashReports.ts";
import { LOCAL_ID } from "../environments.ts";
import { testBackground, mediaTest, devServerUrl, appUrl } from "./testMode.ts";
import { forgetWindow, noteFocused, windows, windowOf, type AppWindow } from "./state.ts";
import { closeRelay, downloads, environmentOf } from "./remote.ts";
import { crypt } from "./crypt.ts";
import { resources } from "./resources.ts";

export const dataDir = () => process.env.UNCUT_DATA_DIR || app.getPath("userData");

/** Our own page, ignoring query and hash (the dev server reloads itself in place). */
export const isAppUrl = (raw: string) => {
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

/** The window whose top-level app page this frame is. */
export const windowOfFrame = (frame: WebFrameMain) =>
  windows.find((w) => frame.parent === null && frame === w.window.webContents.mainFrame && isAppUrl(frame.url));

/** D210: any screen (a take of this Mac's sound alone: the picture isn't kept). */
export const ANY_SCREEN = "screen:any";

// ---- leaving with work in progress (U12, D178) ----
// A window's close (its button, ⌘W with no project, and every quit: ⌘Q, the menu, the Dock) is held
// while its renderer looks for pending work: nothing pending answers "close" at once; else it
// answers "asking" and shows its dialog, and later "close" or "stay". A renderer that doesn't answer
// in time, crashed, hung or isn't loaded never keeps its window open. A quit asks each window with
// work in progress once; "stay" in any of them keeps the app open. SIGTERM / SIGINT don't ask.
const CLOSE_ANSWER_MS = 2000;
let quitting = false;
/** Nothing may hold a close any more (a signal, or an update about to install). */
let closeForced = false;

export const beginQuit = () => {
  quitting = true;
};
export const forceClose = () => {
  closeForced = true;
};

function goClose(entry: AppWindow) {
  if (entry.closeWait?.timer) clearTimeout(entry.closeWait.timer);
  entry.closeWait = undefined;
  entry.closeAllowed = true;
  if (quitting) app.quit();
  else if (!entry.window.isDestroyed()) entry.window.close();
}

function onWindowClose(entry: AppWindow, event: Electron.Event) {
  if (closeForced || entry.closeAllowed) return;
  const contents = entry.window.webContents;
  if (contents.isDestroyed() || contents.isCrashed() || contents.isLoading()) return;
  event.preventDefault();
  // Asked already: a dialog is up (the renderer brings it back), or an answer is due.
  if (!entry.closeWait) entry.closeWait = { timer: setTimeout(() => goClose(entry), CLOSE_ANSWER_MS) };
  contents.send(CLOSE_REQUEST_CHANNEL, quitting ? "quit" : "window");
}

export function answerClose(entry: AppWindow, answer: CloseAnswer) {
  if (!entry.closeWait) return;
  if (answer === "close") return goClose(entry);
  if (entry.closeWait.timer) clearTimeout(entry.closeWait.timer);
  if (answer === "asking") entry.closeWait = { timer: undefined };
  else {
    // Cancel: the quit (if it was one) is off; the next close asks again.
    entry.closeWait = undefined;
    quitting = false;
  }
}

// ---- every window's server ----

const stopping = new Set<Promise<void>>();

function stopServerOf(entry: AppWindow) {
  const server = entry.server;
  entry.server = undefined;
  if (!server?.running()) return;
  const done = server.stop().finally(() => stopping.delete(done));
  stopping.add(done);
}

/** Some window's server is still running or stopping. */
export const serversRunning = () => stopping.size > 0 || windows.some((w) => w.server?.running());

/** Stops every window's server and relay; resolves once all are gone (each stop is bounded: SIGKILL after 1.5 s). */
export async function stopEveryServer() {
  for (const entry of windows) stopServerOf(entry);
  await Promise.allSettled([...stopping, ...windows.map(closeRelay)]);
}

function startWindowServer(entry: AppWindow) {
  return startServer({
    ...resources,
    // Tests point this at a temp dir so they never touch the real recents.
    dataDir: dataDir(),
    // A window's local server going away matters to it only while it shows Local.
    onExit: (reason) => {
      reportServerExit(dataDir(), reason);
      if (entry.window.isDestroyed() || environmentOf(entry).kind === "remote") return;
      entry.window.webContents.send(SERVER_EXIT_CHANNEL, reason);
    },
    // Generator keys (D99): safeStorage (its own key lives in the macOS Keychain); only the
    // ciphertext reaches the server's keys.json.
    keys: crypt,
  });
}

// ---- the window's two sizes (D209) ----

let windowSizes: Record<WindowMode, WindowSize> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** The user resized or moved a window: remembered for the mode it's in (new windows start there). */
function rememberWindow(entry: AppWindow) {
  const win = entry.window;
  if (!windowSizes || win.isFullScreen() || win.isMaximized() || win.isMinimized()) return;
  const [width, height] = win.getContentSize();
  // A size on the way from one mode to the other isn't this mode's.
  if (width! < WINDOW_MODES[entry.mode].minWidth || height! < WINDOW_MODES[entry.mode].minHeight) return;
  const [x, y] = win.getPosition();
  windowSizes = { ...windowSizes, [entry.mode]: { width: width!, height: height!, x: x!, y: y! } };
  clearTimeout(saveTimer);
  const sizes = windowSizes;
  saveTimer = setTimeout(() => writeWindowSizes(dataDir(), sizes), 300);
}

/**
 * D216: in tests (UNCUT_CDP) a window opens centred on the primary display, not on whichever
 * display macOS picks (the one with the focus); undefined for a release user's app (remembered or
 * macOS's choice). The helper also pins the scale and colour profile (TEST_DISPLAY_ARGS).
 */
const testWindowAt = (size: { width: number; height: number }) => (process.env.UNCUT_CDP ? centredIn(screen.getPrimaryDisplay().workArea, size) : undefined);

/** Where the other windows' top left corners are, for the cascade. */
const otherCorners = (entry: AppWindow | undefined) =>
  windows
    .filter((w) => w !== entry && !w.window.isDestroyed())
    .map((w) => {
      const [x, y] = w.window.getPosition();
      return { x: x!, y: y! };
    });

/** Welcome (compact) or editor (full): the minimum and the remembered size of that mode; its content size. */
export function setWindowMode(entry: AppWindow, mode: WindowMode): { width: number; height: number } {
  const win = entry.window;
  windowSizes ??= readWindowSizes(dataDir());
  if (mode === entry.mode || win.isFullScreen()) {
    const [width, height] = win.getContentSize();
    return { width: width!, height: height! };
  }
  // The size the user left this mode at, before switching.
  rememberWindow(entry);
  entry.mode = mode;
  const { minWidth, minHeight } = WINDOW_MODES[mode];
  const want = windowSizes[mode];
  if (win.isMaximized()) win.unmaximize();
  win.setMinimumSize(0, 0);
  win.setContentSize(want.width, want.height);
  win.setMinimumSize(minWidth, minHeight);
  const at =
    testWindowAt({ width: win.getSize()[0]!, height: win.getSize()[1]! }) ??
    (want.x !== undefined && want.y !== undefined ? { x: want.x, y: want.y } : undefined);
  if (at) {
    const free = cascade(at, otherCorners(entry));
    win.setPosition(free.x, free.y);
  } else win.center();
  const [width, height] = win.getContentSize();
  return { width: width!, height: height! };
}

/** A new window's welcome size and place: remembered (tests: centred), stepped off the windows already open. */
function startBounds(): { width: number; height: number; x?: number; y?: number } {
  windowSizes = readWindowSizes(dataDir());
  const remembered = windowSizes.welcome;
  const at = testWindowAt(remembered) ?? (remembered.x !== undefined && remembered.y !== undefined ? { x: remembered.x, y: remembered.y } : undefined);
  const others = otherCorners(undefined);
  const corner = at ?? others.at(-1);
  return { width: remembered.width, height: remembered.height, ...(corner ? cascade(corner, others) : {}) };
}

// ---- the session all windows share ----

let sessionReady = false;

function installSessionHandlers(session: Session) {
  if (sessionReady) return;
  sessionReady = true;
  // The only downloads are the ones downloadExport asked for (D109); anything else is cancelled.
  session.on("will-download", (_event, item) => {
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
  // permissions.ts), only for an app window's own top-level page: a graphic's sandboxed iframe
  // (D78) or any other page gets none, and nothing else is granted to anyone.
  session.setPermissionRequestHandler((requester, permission, callback, details) => {
    callback(allowPermission(permission, windowOf(requester) !== undefined && details.isMainFrame && isAppUrl(details.requestingUrl ?? "")));
  });
  session.setPermissionCheckHandler((requester, permission, _origin, details) => {
    return allowPermission(permission, windowOf(requester) !== undefined && details.isMainFrame && isAppUrl(details.requestingUrl ?? requester!.getURL()));
  });
  // getDisplayMedia records the screen or window the asking window's Capture tab picked
  // (chooseDisplaySource just before). D210: with systemAudio, this Mac's sound too ("loopback":
  // the speakers keep playing); for a take of the sound alone the Capture tab asks for "any
  // screen" (getDisplayMedia always has a picture) and records only the audio track.
  session.setDisplayMediaRequestHandler((request, callback) => {
    const entry = request.frame ? windowOfFrame(request.frame) : undefined;
    const wanted = entry?.pendingDisplaySource;
    if (entry) entry.pendingDisplaySource = undefined;
    if (!wanted || mediaTest) return callback({});
    desktopCapturer
      .getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const source = wanted.id === ANY_SCREEN ? sources.find((s) => s.id.startsWith("screen:")) : sources.find((s) => s.id === wanted.id);
        callback(source ? { video: source, ...(wanted.systemAudio && request.audioRequested ? { audio: "loopback" as const } : {}) } : {});
      })
      .catch(() => callback({}));
  });
}

// ---- a window ----

export interface WindowOptions {
  /** The environment it shows (new windows: Local). */
  readonly envId?: string;
  /** A project for the page to open as soon as it asks. */
  readonly pendingOpen?: string;
  /** Its server stopped and it's gone (the menu follows the next focused window). */
  readonly onClosed?: () => void;
}

export function createWindow(options: WindowOptions = {}): AppWindow {
  const start = startBounds();
  const win = new BrowserWindow({
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
    // Window › Merge All Windows puts the projects in one window's tabs.
    tabbingIdentifier: "uncut",
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
  const entry: AppWindow = {
    window: win,
    server: undefined,
    envId: options.envId ?? LOCAL_ID,
    relay: undefined,
    connectedServer: undefined,
    appState: undefined,
    projectDir: undefined,
    pendingOpen: options.pendingOpen,
    askedOpen: false,
    mode: "welcome",
    closeAllowed: false,
    closeWait: undefined,
    busy: false,
    pendingDisplaySource: undefined,
  };
  windows.push(entry);
  noteFocused(entry);
  entry.server = startWindowServer(entry);
  const contents = win.webContents;
  installSessionHandlers(contents.session);
  // The window only ever shows the app. Web links open in the default browser.
  contents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openIfWeb(url);
  });
  // A frame in the page (a graphic's sandboxed iframe, D78) may only load a graphic's document from
  // Uncut's server: never navigate itself elsewhere (a remote URL carrying a media frame, D290 review).
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame || allowFrameNavigation(event.url, entry.connectedServer)) return;
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    openIfWeb(url);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // D266: a reload (an environment switch) or navigation makes the new page ask for its pending project again.
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) entry.askedOpen = false;
  });
  // Issue #49: Cut, Copy, Paste and Select All on selected text and in text fields. Tests log the
  // menu instead of opening it (a native menu would wait for a click nobody makes).
  contents.on("context-menu", (_event, params) => {
    const items = textMenu(params);
    if (!items || win.isDestroyed()) return;
    if (process.env.UNCUT_CDP)
      return void console.log(`[test] text menu ${items.map((i) => ("role" in i ? `${i.role}${i.enabled ? "" : ":off"}` : "-")).join(",")}`);
    Menu.buildFromTemplate(items.map((i) => ({ ...i }))).popup({ window: win });
  });
  // A graphic item's sandboxed iframe (D78) can't reach anyone over WebRTC either: Chromium honours
  // no CSP webrtc directive, and without a proxy this keeps UDP (STUN) off. The app uses no WebRTC.
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  // A background test run is silent too (D83): the page's audio graph runs and meters as usual,
  // but nothing reaches the speakers.
  if (testBackground) contents.setAudioMuted(true);
  win.once("ready-to-show", () => {
    if (!testBackground) return win.show();
    win.setOpacity(0);
    // Invisible must also mean untouchable: the user's clicks pass through to what's behind it.
    // (Puppeteer's input goes straight to the page over CDP, not through the window.)
    win.setIgnoreMouseEvents(true);
    win.showInactive();
  });
  win.on("focus", () => noteFocused(entry));
  win.on("resize", () => rememberWindow(entry));
  win.on("move", () => rememberWindow(entry));
  win.on("close", (event) => onWindowClose(entry, event));
  // A renderer that's gone or stuck can't answer: the close goes ahead.
  contents.on("render-process-gone", () => entry.closeWait && goClose(entry));
  win.on("unresponsive", () => entry.closeWait && goClose(entry));
  win.on("closed", () => {
    forgetWindow(entry);
    stopServerOf(entry);
    void closeRelay(entry);
    options.onClosed?.();
  });
  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return entry;
}

/** Brings a window forward (a background test window stays where it is, and says so). */
export function showWindow(entry: AppWindow) {
  const win = entry.window;
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  noteFocused(entry);
  if (process.env.UNCUT_CDP) console.log(`[test] window forward: ${entry.projectDir ?? "no project"}`);
  if (testBackground) return;
  win.show();
  win.focus();
}
