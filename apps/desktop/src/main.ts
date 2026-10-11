import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from "electron";

import { SERVER_CONNECTION_CHANNEL, SERVER_EXIT_CHANNEL } from "./ipc.ts";
import { startServer, type ServerProcess } from "./server.ts";

// Lets tests drive the window with puppeteer (same switch as the phase 2 spike).
if (process.env.UNCUT_CDP) app.commandLine.appendSwitch("remote-debugging-port", process.env.UNCUT_CDP);

// __dirname is apps/desktop/dist in dev and app.asar/dist when packaged.
const repoRoot = path.resolve(__dirname, "../../..");
const resources = app.isPackaged
  ? {
      serverEntry: path.join(process.resourcesPath, "server", "server.mjs"),
      mediaBin: path.join(process.resourcesPath, "bin", "uncut-media"),
    }
  : {
      serverEntry: path.join(repoRoot, "apps/server/dist/server.mjs"),
      mediaBin: path.join(repoRoot, "native/media/target/release/uncut-media"),
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

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
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

// Only the app's own top-level page may learn the server's address and token.
const fromAppWindow = (event: IpcMainInvokeEvent) => {
  const frame = event.senderFrame;
  return win !== undefined && event.sender === win.webContents && frame !== null && frame.parent === null && isAppUrl(frame.url);
};

app.whenReady().then(() => {
  server = startServer({
    ...resources,
    onExit: (reason) => win?.webContents.send(SERVER_EXIT_CHANNEL, reason),
  });
  ipcMain.handle(SERVER_CONNECTION_CHANNEL, (event) => {
    if (!fromAppWindow(event)) throw new Error("not allowed");
    if (!server) throw new Error("the app is quitting");
    return server.connection;
  });
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
