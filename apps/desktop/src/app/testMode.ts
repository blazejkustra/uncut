// Test-mode switches read from the environment (only with UNCUT_CDP), and the app page's URL.
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isTestBackground, testMedia } from "../background.ts";

// Tests can't click native dialogs: with UNCUT_TEST_DIALOG (a JSON array of paths, used in
// order; an exhausted queue means "cancelled") the dialogs answer from it instead. Only
// together with UNCUT_CDP, so a stray variable can't change a release user's app. In the
// same mode "Show in Finder" and Copy are logged instead of touching Finder or the clipboard.
// Entries are a path (folder dialogs) or an array of paths (the multi-select media dialog).
export const testDialogs: Array<string | Array<string>> | undefined =
  process.env.UNCUT_CDP && process.env.UNCUT_TEST_DIALOG ? (JSON.parse(process.env.UNCUT_TEST_DIALOG) as Array<string | Array<string>>) : undefined;

// Generator keys in tests (D101): with UNCUT_TEST_KEYS=standin, and only together with UNCUT_CDP,
// keys are wrapped by a reversible stand-in instead of safeStorage, so a packaged-app test that saves
// a key never creates or prompts for a Keychain item. A release user's app always uses safeStorage.
export const testKeys = Boolean(process.env.UNCUT_CDP) && process.env.UNCUT_TEST_KEYS === "standin";

// Tests run in the background (UNCUT_TEST_BACKGROUND=1, only with UNCUT_CDP): no dock icon, and
// the window is shown inactive and fully transparent, so test runs never steal focus or cover what
// the user is doing. CDP screenshots read the page, not the screen, so they are unaffected.
export const testBackground = isTestBackground(process.env);

// Recording on this Mac in tests (D114): fake devices, permission states from the test, a stand-in
// screen source. Never macOS's prompts, never the real camera, microphone or screen.
export const mediaTest = testMedia(process.env);

export const devServerUrl = process.env.VITE_DEV_SERVER_URL;
export const appUrl = devServerUrl ? new URL(devServerUrl) : pathToFileURL(path.join(__dirname, "renderer", "index.html"));
