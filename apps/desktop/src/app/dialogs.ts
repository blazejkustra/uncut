// The native open and save dialogs (tests: answers from UNCUT_TEST_DIALOG).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { dialog, app } from "electron";
import type { AppInfo, FolderPurpose } from "../ipc.ts";
import { testDialogs } from "./testMode.ts";
import { win } from "./state.ts";

const home = homedir();
export const appInfo: AppInfo = {
  homeDir: home,
  defaultParentDir: existsSync(path.join(home, "Movies")) ? path.join(home, "Movies") : home,
};

const MEDIA_EXTENSIONS = ["mp4", "mov", "m4v", "m4a", "mp3", "wav", "aac", "aif", "aiff", "flac", "png", "jpg", "jpeg", "heic", "gif", "webp", "srt", "vtt"];

/** Native multi-select for footage, music and images; [] when cancelled. */
export async function chooseMedia(): Promise<Array<string>> {
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
export async function chooseSavePath(defaultPath: string, title = "Export video"): Promise<string | null> {
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

export async function chooseFolder(purpose: FolderPurpose): Promise<string | null> {
  if (testDialogs) {
    const next = testDialogs.shift();
    return typeof next === "string" ? next : null;
  }
  if (!win) return null;
  if (purpose === "brand") {
    const picked = await dialog.showOpenDialog(win, {
      title: "Import into the kit",
      buttonLabel: "Import",
      message: "Choose a logo, a font file or a folder with them.",
      defaultPath: app.getPath("home"),
      properties: ["openFile", "openDirectory"],
    });
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  }
  if (purpose === "sounds") {
    const picked = await dialog.showOpenDialog(win, {
      title: "Add a sound folder",
      buttonLabel: "Add",
      message: "Its sound files appear in the Folders view. Nothing is copied until you add a sound to a project.",
      defaultPath: app.getPath("home"),
      properties: ["openDirectory"],
    });
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  }
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
