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

// ---- the display a test window draws for (D216) ----

/**
 * Chromium switches for every packaged-app test run (test/helpers/app.ts passes them on the command
 * line, next to UNCUT_CDP): the renderer draws as on a 2x sRGB screen whichever display the window
 * lands on (the built-in Display P3 one, an external monitor with its own profile or scale), so
 * screenshots compared with the export don't depend on what's plugged in. The colour profile must be
 * real argv: on macOS Chromium reads the display's profile before main.ts runs, so
 * app.commandLine.appendSwitch reached the child processes but not the browser's display list
 * (measured: the page still reported Display P3). The scale goes the same way for simplicity
 * (render.ts's appendSwitch of it does work). A release user's app gets neither.
 */
export const TEST_DISPLAY_ARGS: ReadonlyArray<string> = ["--force-device-scale-factor=2", "--force-color-profile=srgb"];

/** Where a test window goes (D216): centred in the primary display's work area, never on whichever display has the focus. */
export function centredIn(area: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, size: { readonly width: number; readonly height: number }) {
  return { x: Math.round(area.x + Math.max(0, area.width - size.width) / 2), y: Math.round(area.y + Math.max(0, area.height - size.height) / 2) };
}

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

/**
 * D210: whether this Mac can record its own sound (getDisplayMedia's loopback audio, which Chromium
 * takes from ScreenCaptureKit on macOS 13 and Core Audio taps on 14.2 and later). Tests answer from
 * UNCUT_TEST_SYSTEM_AUDIO ("unsupported" plays an older Mac), only together with test media.
 */
export function systemAudioSupport(platform: string, version: string, env: NodeJS.ProcessEnv = {}): { readonly supported: boolean; readonly macos: string; readonly standin?: boolean } {
  // Tests record a stand-in sound drawn in the page (never the real loopback).
  if (testMedia(env)) return env.UNCUT_TEST_SYSTEM_AUDIO === "unsupported" ? { supported: false, macos: "12.7", standin: true } : { supported: true, macos: "15.0", standin: true };
  if (platform !== "darwin") return { supported: false, macos: "" };
  const major = Number(version.split(".")[0]);
  return { supported: Number.isFinite(major) && major >= MIN_SYSTEM_AUDIO_MACOS, macos: version };
}
/** The first macOS that records its own sound for an app (ScreenCaptureKit's audio). */
export const MIN_SYSTEM_AUDIO_MACOS = 13;
/**
 * D210: Chromium's switch for macOS system audio in a screen share (Core Audio taps, macOS 14.2+);
 * an older macOS 13 or 14 uses ScreenCaptureKit's audio without it.
 */
export const SYSTEM_AUDIO_FEATURES = "MacCatapLoopbackAudioForScreenShare";

/** Chromium switches for test media: fake devices, and no permission prompt of Chromium's own. */
export const TEST_MEDIA_SWITCHES: ReadonlyArray<string> = ["use-fake-device-for-media-stream", "use-fake-ui-for-media-stream"];

/** System Settings, Privacy & Security, at the pane for `kind`. */
export const privacySettingsUrl = (kind: MediaAccessKind) =>
  `x-apple.systempreferences:com.apple.preference.security?${kind === "microphone" ? "Privacy_Microphone" : kind === "camera" ? "Privacy_Camera" : "Privacy_ScreenCapture"}`;
