// IPC between the desktop shell and the renderer. Payload types live in @uncut/contracts'
// neighbour, apps/web/src/state/bridge.ts, which is the renderer's view of the same bridge.
export const SERVER_CONNECTION_CHANNEL = "uncut:server-connection";
export const SERVER_EXIT_CHANNEL = "uncut:server-exit";
export const APP_INFO_CHANNEL = "uncut:app-info";
// Sync, read once by the preload: whether the preview plays to no output device (test background runs).
export const SILENT_AUDIO_CHANNEL = "uncut:silent-audio";
export const CHOOSE_FOLDER_CHANNEL = "uncut:choose-folder";
export const SHOW_IN_FOLDER_CHANNEL = "uncut:show-in-folder";
export const APP_STATE_CHANNEL = "uncut:app-state";
export const MENU_COMMAND_CHANNEL = "uncut:menu-command";
export const COPY_TEXT_CHANNEL = "uncut:copy-text";
export const CHOOSE_MEDIA_CHANNEL = "uncut:choose-media";
export const CHOOSE_SAVE_PATH_CHANNEL = "uncut:choose-save-path";
// Environments (Phase 9, D106).
export const ENVIRONMENTS_CHANNEL = "uncut:environments";
export const ENVIRONMENT_ADD_CHANNEL = "uncut:environment-add";
export const ENVIRONMENT_TEST_CHANNEL = "uncut:environment-test";
export const ENVIRONMENT_RENAME_CHANNEL = "uncut:environment-rename";
export const ENVIRONMENT_REMOVE_CHANNEL = "uncut:environment-remove";
export const ENVIRONMENT_SWITCH_CHANNEL = "uncut:environment-switch";
export const ENVIRONMENT_STATUS_CHANNEL = "uncut:environment-status";
export const DOWNLOAD_EXPORT_CHANNEL = "uncut:download-export";

export type FolderPurpose = "parent" | "project" | "plugin";

export interface AppInfo {
  readonly homeDir: string;
  // Where "New project" suggests saving: ~/Movies if it exists, else home.
  readonly defaultParentDir: string;
}

/** What the renderer tells the shell so the menu and ⌘W match the screen. */
export interface AppState {
  readonly projectOpen: boolean;
  readonly recents: ReadonlyArray<{ readonly name: string; readonly dir: string }>;
}

export interface EnvironmentInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: "local" | "remote";
  readonly url?: string;
}

export type EnvironmentTest = { readonly ok: true; readonly version: string; readonly hostname: string } | { readonly ok: false; readonly message: string };

export type MenuCommand =
  | { readonly type: "new-project" | "open-project" | "close-project" | "undo" | "redo" | "open-setup" | "export" | "open-environments" }
  | { readonly type: "open-recent"; readonly dir: string };
