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
  | { readonly type: "new-project" | "open-project" | "close-project" | "undo" | "redo" }
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
  readonly onMenuCommand: (listener: (command: MenuCommand) => void) => () => void;
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
  onMenuCommand: () => () => {},
};
