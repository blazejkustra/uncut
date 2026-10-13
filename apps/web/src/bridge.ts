// The renderer's view of the desktop shell (apps/desktop/src/preload.ts and ipc.ts).
import type { ServerConnection } from "@uncut/contracts";

export interface AppInfo {
  readonly homeDir: string;
  readonly defaultParentDir: string;
}

export interface AppState {
  readonly projectOpen: boolean;
  readonly recents: ReadonlyArray<{ readonly name: string; readonly dir: string }>;
}

export type MenuCommand =
  | { readonly type: "new-project" | "open-project" | "close-project" | "undo" | "redo" | "open-setup" | "export" }
  | { readonly type: "open-recent"; readonly dir: string };

export interface UncutBridge {
  readonly getServerConnection: () => Promise<ServerConnection>;
  // Called if the server dies after it started. Returns an unsubscribe function.
  readonly onServerExit: (listener: (reason: string) => void) => () => void;
  readonly appInfo: () => Promise<AppInfo>;
  // A native folder dialog; null when cancelled.
  readonly chooseFolder: (purpose: "parent" | "project") => Promise<string | null>;
  readonly showInFolder: (path: string) => Promise<void>;
  readonly setAppState: (state: AppState) => void;
  readonly copyText: (text: string) => Promise<void>;
  // Native multi-select for media; [] when cancelled.
  readonly chooseMedia: () => Promise<Array<string>>;
  // The native save panel for an export, starting at `defaultPath`; null when cancelled.
  readonly chooseSavePath: (defaultPath: string) => Promise<string | null>;
  // The disk path of a dropped File ("" if it isn't a file on disk).
  readonly pathForFile: (file: File) => string;
  readonly onMenuCommand: (listener: (command: MenuCommand) => void) => () => void;
  // Background test runs: the preview plays to no output device (AudioContext sinkId "none").
  readonly silentAudio?: boolean;
}

declare global {
  interface Window {
    readonly uncut?: UncutBridge;
  }
}

const missing = () => Promise.reject(new Error("Not running inside the Uncut desktop app"));

// Outside Electron (e.g. the Vite page in a browser) everything degrades to "not available".
export const bridge: UncutBridge = window.uncut ?? {
  getServerConnection: missing,
  onServerExit: () => () => {},
  appInfo: () => Promise.resolve({ homeDir: "", defaultParentDir: "" }),
  chooseFolder: () => Promise.resolve(null),
  showInFolder: () => Promise.resolve(),
  setAppState: () => {},
  copyText: (text) => navigator.clipboard.writeText(text),
  chooseMedia: () => Promise.resolve([]),
  chooseSavePath: () => Promise.resolve(null),
  pathForFile: () => "",
  onMenuCommand: () => () => {},
};
