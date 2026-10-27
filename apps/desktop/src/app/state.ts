// The app's shared mutable state: its windows (one per project, each with its own server) and the
// environments store. Read as live bindings everywhere; `environments` is set only through its setter.
import { BrowserWindow, type WebContents } from "electron";
import type { EnvironmentStore } from "../environments.ts";
import type { AppState } from "../ipc.ts";
import type { Relay } from "../relay.ts";
import type { ServerProcess } from "../server.ts";
import type { WindowMode } from "../windowState.ts";

export interface AppWindow {
  readonly window: BrowserWindow;
  /** Its own local server; undefined once stopped (the window closed, or an update installs). */
  server: ServerProcess | undefined;
  /** The environment the window shows (D106): Local, or one remote. */
  envId: string;
  /** The relay to its remote, while it shows one. */
  relay: { readonly id: string; readonly relay: Relay } | undefined;
  /** The http origin of the server the page was last given, for allowFrameNavigation. */
  connectedServer: string | undefined;
  /** What the renderer last reported (the menu shows the focused window's). */
  appState: AppState | undefined;
  /** The project it shows on This Mac (the renderer's AppState), resolved. */
  projectDir: string | undefined;
  /** D252: a project to open that the page takes when it asks (PENDING_OPEN_CHANNEL). */
  pendingOpen: string | undefined;
  /** The page has asked for its pending project since it last loaded. */
  askedOpen: boolean;
  mode: WindowMode;
  /** U12: its close was allowed (the renderer answered, or nothing may hold it). */
  closeAllowed: boolean;
  closeWait: { readonly timer: ReturnType<typeof setTimeout> | undefined } | undefined;
  /** An export, a recording or an agent turn is running in it (#102: the updater waits). */
  busy: boolean;
  /** The screen or window its next getDisplayMedia records, and whether with this Mac's sound (D210). */
  pendingDisplaySource: { readonly id: string; readonly systemAudio: boolean } | undefined;
}

export const windows: Array<AppWindow> = [];
let lastFocused: AppWindow | undefined;

export let environments: EnvironmentStore | undefined;
export const setEnvironments = (value: EnvironmentStore | undefined) => {
  environments = value;
};

export const windowOf = (contents: WebContents | null | undefined) =>
  contents ? windows.find((w) => !w.window.isDestroyed() && w.window.webContents === contents) : undefined;

export const noteFocused = (entry: AppWindow) => {
  lastFocused = entry;
};

/** The window menu commands go to: the focused one, else the one focused last, else the newest. */
export function currentWindow(): AppWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  return windows.find((w) => w.window === focused) ?? (lastFocused && windows.includes(lastFocused) ? lastFocused : windows.at(-1));
}

export function forgetWindow(entry: AppWindow) {
  const at = windows.indexOf(entry);
  if (at >= 0) windows.splice(at, 1);
  if (lastFocused === entry) lastFocused = undefined;
}
