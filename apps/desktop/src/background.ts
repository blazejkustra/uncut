// Test runs in the background (UNCUT_TEST_BACKGROUND=1, set by test/helpers/app.ts, honoured only
// together with UNCUT_CDP so a stray variable can't change a release user's app): no dock icon,
// never activated or focused, the window shown inactive and fully transparent, so a test run
// never steals focus or covers what the user is doing, and muted (app.ts) so it never plays
// sound. CDP screenshots read the page, not the screen. No Electron import here, so the unit tests can check it without opening a window.

export const isTestBackground = (env: NodeJS.ProcessEnv) => Boolean(env.UNCUT_CDP) && env.UNCUT_TEST_BACKGROUND === "1";

/**
 * Chromium switches for a background test window: an inactive, transparent window can count as
 * hidden or occluded, and Chromium would then throttle its timers and requestAnimationFrame (the
 * playback clock) or stop painting it. These keep it running as if it were in front.
 */
export const BACKGROUND_SWITCHES: ReadonlyArray<string> = ["disable-renderer-backgrounding", "disable-background-timer-throttling", "disable-backgrounding-occluded-windows"];

// ---- recording on this Mac in tests (D114) ----

export type MediaAccessKind = "microphone" | "camera" | "screen";
export type MediaAccess = "not-determined" | "granted" | "denied" | "restricted" | "unknown";
const ACCESS_VALUES: ReadonlyArray<MediaAccess> = ["not-determined", "granted", "denied", "restricted", "unknown"];

/**
 * Test media (UNCUT_TEST_MEDIA=fake, honoured only together with UNCUT_CDP, set by
 * test/helpers/app.ts): Chromium's fake camera and microphone and its fake permission UI, so a test
 * never opens a real device or shows a prompt; permission states come from UNCUT_TEST_MEDIA_ACCESS
 * (JSON, e.g. {"microphone":"denied"}; anything not given is "granted") instead of macOS, and macOS
 * is never asked; screen sources are a stand-in (never desktopCapturer, so no Screen Recording
 * prompt). undefined for a release user's app.
 */
export function testMedia(env: NodeJS.ProcessEnv): { readonly access: Readonly<Record<MediaAccessKind, MediaAccess>> } | undefined {
  if (!env.UNCUT_CDP || env.UNCUT_TEST_MEDIA !== "fake") return undefined;
  let given: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(env.UNCUT_TEST_MEDIA_ACCESS || "{}") as unknown;
    if (parsed && typeof parsed === "object") given = parsed as Record<string, unknown>;
  } catch {}
  const pick = (kind: MediaAccessKind): MediaAccess => (ACCESS_VALUES.includes(given[kind] as MediaAccess) ? (given[kind] as MediaAccess) : "granted");
  return { access: { microphone: pick("microphone"), camera: pick("camera"), screen: pick("screen") } };
}

/** Chromium switches for test media: fake devices, and no permission prompt of Chromium's own. */
export const TEST_MEDIA_SWITCHES: ReadonlyArray<string> = ["use-fake-device-for-media-stream", "use-fake-ui-for-media-stream"];

/** System Settings, Privacy & Security, at the pane for `kind`. */
export const privacySettingsUrl = (kind: MediaAccessKind) =>
  `x-apple.systempreferences:com.apple.preference.security?${kind === "microphone" ? "Privacy_Microphone" : kind === "camera" ? "Privacy_Camera" : "Privacy_ScreenCapture"}`;
