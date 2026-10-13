import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

import {
  APP_INFO_CHANNEL,
  APP_STATE_CHANNEL,
  CHOOSE_FOLDER_CHANNEL,
  CHOOSE_MEDIA_CHANNEL,
  CHOOSE_SAVE_PATH_CHANNEL,
  COPY_TEXT_CHANNEL,
  DOWNLOAD_EXPORT_CHANNEL,
  ENVIRONMENT_ADD_CHANNEL,
  ENVIRONMENT_REMOVE_CHANNEL,
  ENVIRONMENT_RENAME_CHANNEL,
  ENVIRONMENT_STATUS_CHANNEL,
  ENVIRONMENT_SWITCH_CHANNEL,
  ENVIRONMENT_TEST_CHANNEL,
  ENVIRONMENTS_CHANNEL,
  MENU_COMMAND_CHANNEL,
  SERVER_CONNECTION_CHANNEL,
  SERVER_EXIT_CHANNEL,
  SHOW_IN_FOLDER_CHANNEL,
  SILENT_AUDIO_CHANNEL,
  type AppInfo,
  type AppState,
  type EnvironmentTest,
  type FolderPurpose,
  type MenuCommand,
} from "./ipc.ts";
import { BACKGROUND_SWITCHES, isTestBackground } from "./background.ts";
import { setAppMenu } from "./menu.ts";
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

// __dirname is apps/desktop/dist in dev and app.asar/dist when packaged.
const repoRoot = path.resolve(__dirname, "../../..");
const resources = app.isPackaged
  ? {
      serverEntry: path.join(process.resourcesPath, "server", "server.mjs"),
      mediaBin: path.join(process.resourcesPath, "bin", "uncut-media"),
      modulesDir: path.join(process.resourcesPath, "modules", "builtin"),
      musicDir: path.join(process.resourcesPath, "music"),
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

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    // Below this an editor has no useful preview; the layout is checked at exactly this size.
    minWidth: 1024,
    minHeight: 640,
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
  win.on("closed", () => (win = undefined));
  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// Only the app's own top-level page may use the bridge (the server's token, dialogs, Finder).
const fromAppWindow = (event: IpcMainInvokeEvent | IpcMainEvent) => {
  const frame = event.senderFrame;
  return win !== undefined && event.sender === win.webContents && frame !== null && frame.parent === null && isAppUrl(frame.url);
};

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (testBackground) return;
  win.show();
  win.focus();
});

app.whenReady().then(() => {
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
  // A background test window plays its preview to no output device (sinkId "none"): no sound, and
  // no device latency (Bluetooth headphones add ~0.25 s) between the clock and what is captured.
  ipcMain.on(SILENT_AUDIO_CHANNEL, (event) => {
    event.returnValue = fromAppWindow(event) && testBackground;
  });
  ipcMain.on(APP_STATE_CHANNEL, (event, state: AppState) => {
    if (fromAppWindow(event)) setAppMenu(state, sendMenuCommand);
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
