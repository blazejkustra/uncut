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

/** An environment (Phase 9, D106): Local, or a remote uncut-server. */
export interface EnvironmentInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: "local" | "remote";
  readonly url?: string;
}
export type EnvironmentTest = { readonly ok: true; readonly version: string; readonly hostname: string } | { readonly ok: false; readonly message: string };

export type MenuCommand =
  | { readonly type: "new-project" | "open-project" | "close-project" | "undo" | "redo" | "open-setup" | "open-settings" | "shortcuts" | "export" | "open-environments" }
  | { readonly type: "open-recent"; readonly dir: string };

/** Recording on this Mac (D114): macOS's answer for the microphone, camera and screen recording. */
export type MediaAccessKind = "microphone" | "camera" | "screen";
export type MediaAccess = "not-determined" | "granted" | "denied" | "restricted" | "unknown";
/** A screen or window to record; a stand-in (tests) has an id starting "standin:". */
export interface CaptureSource {
  readonly id: string;
  readonly name: string;
  readonly kind: "screen" | "window";
  readonly thumbnail: string;
}

export interface UncutBridge {
  readonly getServerConnection: () => Promise<ServerConnection>;
  // Called if the server dies after it started. Returns an unsubscribe function.
  readonly onServerExit: (listener: (reason: string) => void) => () => void;
  readonly appInfo: () => Promise<AppInfo>;
  // A native folder dialog; null when cancelled.
  readonly chooseFolder: (purpose: "parent" | "project" | "plugin" | "brand") => Promise<string | null>;
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
  // Environments (D106): the list and which is active; switching (and removing the active one) reloads the window.
  readonly environments: () => Promise<{ readonly active: string; readonly environments: ReadonlyArray<EnvironmentInfo> }>;
  readonly addEnvironment: (input: { name: string; url: string; token: string }) => Promise<{ readonly id: string } | { readonly problem: string }>;
  readonly testEnvironment: (input: { url: string; token: string } | { id: string }) => Promise<EnvironmentTest>;
  readonly renameEnvironment: (id: string, name: string) => Promise<boolean>;
  readonly removeEnvironment: (id: string) => Promise<boolean>;
  readonly switchEnvironment: (id: string) => Promise<boolean>;
  /** Why the relay last failed to reach the active remote (undefined once it got through). */
  readonly environmentStatus: () => Promise<{ readonly problem?: string | undefined }>;
  /** D109: a remote export saved to a path picked here; null when cancelled. */
  readonly downloadExport: (jobId: string, name: string) => Promise<{ readonly path: string } | { readonly error: string } | null>;
  // Background test runs: the preview plays to no output device (AudioContext sinkId "none").
  readonly silentAudio?: boolean;
  // Recording on this Mac (D114).
  readonly mediaAccess: () => Promise<Record<MediaAccessKind, MediaAccess>>;
  /** Asks macOS (its prompt shows only the first time); the state after. */
  readonly askMediaAccess: (kind: MediaAccessKind) => Promise<MediaAccess>;
  readonly openPrivacySettings: (kind: MediaAccessKind) => Promise<void>;
  readonly captureSources: () => Promise<ReadonlyArray<CaptureSource>>;
  /** The source the next getDisplayMedia records. */
  readonly chooseDisplaySource: (id: string) => Promise<void>;
  /**
   * U12 (D178): the shell holds a window close or a quit (`kind`) until answerClose says "close"
   * (nothing pending, or the user chose to go), "stay" (Cancel) or "asking" (the dialog is up:
   * stop waiting for an answer, the user decides).
   */
  readonly onCloseRequest: (listener: (kind: "window" | "quit") => void) => () => void;
  readonly answerClose: (answer: "close" | "stay" | "asking") => void;
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
  onCloseRequest: () => () => {},
  answerClose: () => {},
  appInfo: () => Promise.resolve({ homeDir: "", defaultParentDir: "" }),
  chooseFolder: () => Promise.resolve(null),
  showInFolder: () => Promise.resolve(),
  setAppState: () => {},
  copyText: (text) => navigator.clipboard.writeText(text),
  chooseMedia: () => Promise.resolve([]),
  chooseSavePath: () => Promise.resolve(null),
  pathForFile: () => "",
  onMenuCommand: () => () => {},
  environments: () => Promise.resolve({ active: "local", environments: [{ id: "local", name: "This Mac", kind: "local" }] }),
  addEnvironment: () => Promise.resolve({ problem: "Not running inside the Uncut desktop app" }),
  testEnvironment: () => Promise.resolve({ ok: false, message: "Not running inside the Uncut desktop app" }),
  renameEnvironment: () => Promise.resolve(false),
  removeEnvironment: () => Promise.resolve(false),
  switchEnvironment: () => Promise.resolve(false),
  environmentStatus: () => Promise.resolve({}),
  downloadExport: () => Promise.resolve(null),
  mediaAccess: () => Promise.resolve({ microphone: "unknown", camera: "unknown", screen: "unknown" }),
  askMediaAccess: () => Promise.resolve("unknown"),
  openPrivacySettings: () => Promise.resolve(),
  captureSources: () => Promise.resolve([]),
  chooseDisplaySource: () => Promise.resolve(),
};
