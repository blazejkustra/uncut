import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

import {
  APP_INFO_CHANNEL,
  APP_STATE_CHANNEL,
  ASK_MEDIA_ACCESS_CHANNEL,
  CAPTURE_SOURCES_CHANNEL,
  CHOOSE_DISPLAY_SOURCE_CHANNEL,
  SYSTEM_AUDIO_CHANNEL,
  CHOOSE_FOLDER_CHANNEL,
  CHOOSE_MEDIA_CHANNEL,
  CHOOSE_SAVE_PATH_CHANNEL,
  CLOSE_ANSWER_CHANNEL,
  CLOSE_REQUEST_CHANNEL,
  COPY_TEXT_CHANNEL,
  CLIPBOARD_PATHS_CHANNEL,
  DOWNLOAD_EXPORT_CHANNEL,
  ENVIRONMENT_ADD_CHANNEL,
  ENVIRONMENT_REMOVE_CHANNEL,
  ENVIRONMENT_RENAME_CHANNEL,
  ENVIRONMENT_STATUS_CHANNEL,
  ENVIRONMENT_SWITCH_CHANNEL,
  ENVIRONMENT_TEST_CHANNEL,
  ENVIRONMENTS_CHANNEL,
  MEDIA_ACCESS_CHANNEL,
  MENU_COMMAND_CHANNEL,
  OPEN_PRIVACY_SETTINGS_CHANNEL,
  SERVER_CONNECTION_CHANNEL,
  SERVER_EXIT_CHANNEL,
  SHOW_IN_FOLDER_CHANNEL,
  SILENT_AUDIO_CHANNEL,
  type AppState,
  type CloseAnswer,
  type FolderPurpose,
  type MediaAccessKind,
  type MenuCommand,
  type MiniRecorderAction,
  type MiniRecorderState,
  MINI_RECORDER_ACTION_CHANNEL,
  MINI_RECORDER_CHANNEL,
  MINI_RECORDER_STATE_CHANNEL,
  WINDOW_MODE_CHANNEL,
} from "./ipc.ts";

const subscribe = <A>(channel: string, listener: (value: A) => void) => {
  const handler = (_event: IpcRendererEvent, value: A) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.off(channel, handler);
};

// Everything the renderer may ask of the desktop shell. The server's address and token
// resolve once it is up, or reject with the reason it failed to start.
contextBridge.exposeInMainWorld("uncut", {
  getServerConnection: () => ipcRenderer.invoke(SERVER_CONNECTION_CHANNEL),
  onServerExit: (listener: (reason: string) => void) => subscribe(SERVER_EXIT_CHANNEL, listener),
  appInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  chooseFolder: (purpose: FolderPurpose) => ipcRenderer.invoke(CHOOSE_FOLDER_CHANNEL, purpose),
  showInFolder: (path: string) => ipcRenderer.invoke(SHOW_IN_FOLDER_CHANNEL, path),
  setAppState: (state: AppState) => ipcRenderer.send(APP_STATE_CHANNEL, state),
  copyText: (text: string) => ipcRenderer.invoke(COPY_TEXT_CHANNEL, text),
  // D201: the files and folders copied in Finder, as absolute paths ([] when there are none).
  clipboardPaths: () => ipcRenderer.invoke(CLIPBOARD_PATHS_CHANNEL),
  chooseMedia: () => ipcRenderer.invoke(CHOOSE_MEDIA_CHANNEL),
  chooseSavePath: (defaultPath: string) => ipcRenderer.invoke(CHOOSE_SAVE_PATH_CHANNEL, defaultPath),
  // The disk path of a dropped File ("" for files that don't come from disk).
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  onMenuCommand: (listener: (command: MenuCommand) => void) => subscribe(MENU_COMMAND_CHANNEL, listener),
  // U12 (D178): asked before the window closes or the app quits.
  onCloseRequest: (listener: (kind: "window" | "quit") => void) => subscribe(CLOSE_REQUEST_CHANNEL, listener),
  answerClose: (answer: CloseAnswer) => ipcRenderer.send(CLOSE_ANSWER_CHANNEL, answer),
  // Environments (Phase 9, D106): Local and the remote servers; switching reloads the window.
  environments: () => ipcRenderer.invoke(ENVIRONMENTS_CHANNEL),
  addEnvironment: (input: { name: string; url: string; token: string }) => ipcRenderer.invoke(ENVIRONMENT_ADD_CHANNEL, input),
  testEnvironment: (input: { url: string; token: string } | { id: string }) => ipcRenderer.invoke(ENVIRONMENT_TEST_CHANNEL, input),
  renameEnvironment: (id: string, name: string) => ipcRenderer.invoke(ENVIRONMENT_RENAME_CHANNEL, id, name),
  removeEnvironment: (id: string) => ipcRenderer.invoke(ENVIRONMENT_REMOVE_CHANNEL, id),
  switchEnvironment: (id: string) => ipcRenderer.invoke(ENVIRONMENT_SWITCH_CHANNEL, id),
  environmentStatus: () => ipcRenderer.invoke(ENVIRONMENT_STATUS_CHANNEL),
  // A remote export, saved where the user picks on this Mac (D109).
  downloadExport: (jobId: string, name: string) => ipcRenderer.invoke(DOWNLOAD_EXPORT_CHANNEL, jobId, name),
  // Recording on this Mac (D114).
  mediaAccess: () => ipcRenderer.invoke(MEDIA_ACCESS_CHANNEL),
  askMediaAccess: (kind: MediaAccessKind) => ipcRenderer.invoke(ASK_MEDIA_ACCESS_CHANNEL, kind),
  openPrivacySettings: (kind: MediaAccessKind) => ipcRenderer.invoke(OPEN_PRIVACY_SETTINGS_CHANNEL, kind),
  captureSources: () => ipcRenderer.invoke(CAPTURE_SOURCES_CHANNEL),
  chooseDisplaySource: (id: string, options?: { systemAudio?: boolean }) => ipcRenderer.invoke(CHOOSE_DISPLAY_SOURCE_CHANNEL, id, options),
  systemAudio: () => ipcRenderer.invoke(SYSTEM_AUDIO_CHANNEL),
  // D209: the compact welcome window or the editor's; resolves with the content size.
  windowMode: (mode: "welcome" | "editor") => ipcRenderer.invoke(WINDOW_MODE_CHANNEL, mode),
  // D209: the floating mini recorder. The app window sends its state (null closes it) and hears its
  // buttons; the mini window hears the state and sends the buttons.
  miniRecorder: (state: MiniRecorderState | null) => ipcRenderer.send(MINI_RECORDER_CHANNEL, state),
  onMiniRecorderAction: (listener: (action: MiniRecorderAction) => void) => subscribe(MINI_RECORDER_ACTION_CHANNEL, listener),
  onMiniRecorderState: (listener: (state: MiniRecorderState | null) => void) => subscribe(MINI_RECORDER_STATE_CHANNEL, listener),
  miniRecorderAction: (action: MiniRecorderAction) => ipcRenderer.send(MINI_RECORDER_ACTION_CHANNEL, action),
  // True only in a background test run: the preview's audio goes to no device.
  silentAudio: ipcRenderer.sendSync(SILENT_AUDIO_CHANNEL) === true,
});
