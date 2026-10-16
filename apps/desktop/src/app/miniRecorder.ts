// The floating mini recorder window shown while the screen is recorded (D209).
import * as path from "node:path";
import { BrowserWindow, screen } from "electron";
import { type MiniRecorderState, MINI_RECORDER_STATE_CHANNEL } from "../ipc.ts";
import { testBackground, devServerUrl } from "./testMode.ts";

// ---- the floating mini recorder (D209) ----

// While the screen is recorded: a small window over every app with the timer, Pause, Stop and
// Cancel. Left out of screen captures (content protection), so it isn't in the take. In a
// background test run it's created like the main window (invisible, untouchable) and logged.
export let mini: BrowserWindow | undefined;
let miniState: MiniRecorderState | null = null;
const MINI_SIZE = { width: 320, height: 64 };

/** D267: the mini window says it's listening; it gets the latest state (a take that started at once may have sent it before the page subscribed). */
export function resendMini() {
  if (mini && miniState) mini.webContents.send(MINI_RECORDER_STATE_CHANNEL, miniState);
}

export function showMini(state: MiniRecorderState | null) {
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
