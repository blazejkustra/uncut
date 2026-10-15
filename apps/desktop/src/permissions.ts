// D219: the web permissions the app window grants, deny by default (like t3code's preview sessions,
// ALLOWED_PREVIEW_PERMISSIONS): only the app's own top-level page gets any, and only what it uses.
// A graphic's sandboxed iframe (D78) or any other page gets none.

/** What the app's page uses, each with where. */
export const APP_PERMISSIONS: ReadonlySet<string> = new Set([
  // The Capture tab (D114, D210, D211): camera, microphone, screen and this Mac's sound.
  "media",
  "display-capture",
  // Copy buttons (the bridge's copyText: navigator.clipboard.writeText).
  "clipboard-sanitized-write",
  // The font picker (queryLocalFonts).
  "local-fonts",
  // Scrubbable numbers (D209: requestPointerLock while dragging).
  "pointerLock",
  // The preview's full screen (requestFullscreen).
  "fullscreen",
  // The page (file://, or the dev server) talks to Uncut's server on 127.0.0.1: Chromium's Local
  // Network Access may ask for that.
  "local-network-access",
  "local-network",
  "loopback-network",
]);

/** Whether a permission is granted: one the app uses, asked by the app's own top-level page. */
export const allowPermission = (permission: string, fromAppPage: boolean): boolean => fromAppPage && APP_PERMISSIONS.has(permission);
