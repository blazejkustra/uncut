import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

import {
  APP_INFO_CHANNEL,
  APP_STATE_CHANNEL,
  CHOOSE_FOLDER_CHANNEL,
  COPY_TEXT_CHANNEL,
  MENU_COMMAND_CHANNEL,
  SERVER_CONNECTION_CHANNEL,
  SERVER_EXIT_CHANNEL,
  SHOW_IN_FOLDER_CHANNEL,
  type AppInfo,
  type AppState,
  type FolderPurpose,
  type MenuCommand,
} from "./ipc.ts";
import { setAppMenu } from "./menu.ts";
import { startServer, type ServerProcess } from "./server.ts";

// Lets tests drive the window with puppeteer (same switch as the phase 2 spike).
if (process.env.UNCUT_CDP) app.commandLine.appendSwitch("remote-debugging-port", process.env.UNCUT_CDP);

// Tests can't click native dialogs: with UNCUT_TEST_DIALOG (a JSON array of paths, used in
// order; an exhausted queue means "cancelled") the dialogs answer from it instead. Only
// together with UNCUT_CDP, so a stray variable can't change a release user's app. In the
// same mode "Show in Finder" and Copy are logged instead of touching Finder or the clipboard.
const testDialogs: Array<string> | undefined =
  process.env.UNCUT_CDP && process.env.UNCUT_TEST_DIALOG ? (JSON.parse(process.env.UNCUT_TEST_DIALOG) as Array<string>) : undefined;

// __dirname is apps/desktop/dist in dev and app.asar/dist when packaged.
const repoRoot = path.resolve(__dirname, "../../..");
const resources = app.isPackaged
  ? {
      serverEntry: path.join(process.resourcesPath, "server", "server.mjs"),
      mediaBin: path.join(process.resourcesPath, "bin", "uncut-media"),
      modulesDir: path.join(process.resourcesPath, "modules", "builtin"),
    }
  : {
      serverEntry: path.join(repoRoot, "apps/server/dist/server.mjs"),
      mediaBin: path.join(repoRoot, "native/media/target/release/uncut-media"),
      modulesDir: path.join(repoRoot, "spec/modules/builtin"),
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

async function chooseFolder(purpose: FolderPurpose): Promise<string | null> {
  if (testDialogs) return testDialogs.shift() ?? null;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: purpose === "parent" ? "Choose where to save the project" : "Open a project",
    buttonLabel: purpose === "parent" ? "Choose" : "Open",
    message: purpose === "parent" ? "The project folder (Name.uncut) is created inside this folder." : "Choose a .uncut project folder.",
    defaultPath: appInfo.defaultParentDir,
    properties: purpose === "parent" ? ["openDirectory", "createDirectory"] : ["openDirectory"],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
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
  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => (win = undefined));
  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// Only the app's own top-level page may use the bridge (the server's token, dialogs, Finder).
const fromAppWindow = (event: IpcMainInvokeEvent | IpcMainEvent) => {
  const frame = event.senderFrame;
  return win !== undefined && event.sender === win.webContents && frame !== null && frame.parent === null && isAppUrl(frame.url);
};

app.whenReady().then(() => {
  server = startServer({
    ...resources,
    // Tests point this at a temp dir so they never touch the real recents.
    dataDir: process.env.UNCUT_DATA_DIR || app.getPath("userData"),
    onExit: (reason) => win?.webContents.send(SERVER_EXIT_CHANNEL, reason),
  });
  const handle = <A extends Array<unknown>, R>(channel: string, fn: (...args: A) => R) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromAppWindow(event)) throw new Error("not allowed");
      return fn(...(args as A));
    });
  handle(SERVER_CONNECTION_CHANNEL, () => {
    if (!server) throw new Error("the app is quitting");
    return server.connection;
  });
  handle(APP_INFO_CHANNEL, (): AppInfo => appInfo);
  handle(CHOOSE_FOLDER_CHANNEL, (purpose: FolderPurpose) => chooseFolder(purpose));
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
  ipcMain.on(APP_STATE_CHANNEL, (event, state: AppState) => {
    if (fromAppWindow(event)) setAppMenu(state, sendMenuCommand);
  });
  setAppMenu({ projectOpen: false, recents: [] }, sendMenuCommand);
  createWindow();
});

// One window for now; closing it ends the app (and the server with it).
app.on("window-all-closed", () => app.quit());

app.on("will-quit", (event) => {
  if (!server?.running()) return;
  // Hold the quit until the server is really gone (stop() is bounded: SIGKILL after 1.5 s).
  // Re-quit on a later tick: Electron ignores app.quit() while will-quit is still dispatching.
  event.preventDefault();
  const stopping = server;
  server = undefined;
  void stopping.stop().finally(() => setImmediate(() => app.quit()));
});
