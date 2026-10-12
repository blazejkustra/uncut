// Test runs in the background (UNCUT_TEST_BACKGROUND=1, set by test/helpers/app.ts, honoured only
// together with UNCUT_CDP so a stray variable can't change a release user's app): no dock icon,
// never activated or focused, the window shown inactive and fully transparent, so a test run
// never steals focus or covers what the user is doing. CDP screenshots read the page, not the
// screen. No Electron import here, so the unit tests can check it without opening a window.

export const isTestBackground = (env: NodeJS.ProcessEnv) => Boolean(env.UNCUT_CDP) && env.UNCUT_TEST_BACKGROUND === "1";

/**
 * Chromium switches for a background test window: an inactive, transparent window can count as
 * hidden or occluded, and Chromium would then throttle its timers and requestAnimationFrame (the
 * playback clock) or stop painting it. These keep it running as if it were in front.
 */
export const BACKGROUND_SWITCHES: ReadonlyArray<string> = ["disable-renderer-backgrounding", "disable-background-timer-throttling", "disable-backgrounding-occluded-windows"];
