// App tests run in the background (test/helpers/app.ts sets UNCUT_TEST_BACKGROUND=1): the app must
// not steal focus or cover the user's work. Checked without opening a window: the switch, the
// helper that sets it, and that every show/focus call in the desktop shell is guarded by it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { BACKGROUND_SWITCHES, centredIn, isTestBackground, TEST_DISPLAY_ARGS } from "../../apps/desktop/src/background.ts";

const source = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** The desktop shell: app.ts and the modules split out of it (apps/desktop/src/app/, #54). */
const desktopApp = () =>
  [
    "../../apps/desktop/src/app.ts",
    ...readdirSync(new URL("../../apps/desktop/src/app/", import.meta.url))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `../../apps/desktop/src/app/${f}`),
  ]
    .map(source)
    .join("\n");

test("background mode needs UNCUT_TEST_BACKGROUND=1 together with UNCUT_CDP", () => {
  assert.equal(isTestBackground({ UNCUT_CDP: "9222", UNCUT_TEST_BACKGROUND: "1" }), true);
  assert.equal(isTestBackground({ UNCUT_TEST_BACKGROUND: "1" }), false, "a stray variable can't change a release user's app");
  assert.equal(isTestBackground({ UNCUT_CDP: "9222" }), false);
  assert.equal(isTestBackground({ UNCUT_CDP: "9222", UNCUT_TEST_BACKGROUND: "0" }), false);
  assert.equal(isTestBackground({ UNCUT_CDP: "", UNCUT_TEST_BACKGROUND: "1" }), false, "an empty UNCUT_CDP is off");
  assert.deepEqual(
    [...BACKGROUND_SWITCHES],
    ["disable-renderer-backgrounding", "disable-background-timer-throttling", "disable-backgrounding-occluded-windows"],
  );
  // The module stays loadable without Electron (this test imports it on plain Node).
  assert.doesNotMatch(source("../../apps/desktop/src/background.ts"), /from "electron"/);
});

test("D216: tests draw as on a 2x sRGB screen on the primary display; a release user's app follows its display", () => {
  assert.deepEqual([...TEST_DISPLAY_ARGS], ["--force-device-scale-factor=2", "--force-color-profile=srgb"]);
  // Real argv from the helper (appendSwitch is too late for the browser's display on macOS), never from the app itself.
  assert.match(source("../helpers/app.ts"), /spawn\(command, \[\.\.\.TEST_DISPLAY_ARGS, "--force-prefers-no-reduced-motion", \.\.\.args\]/);
  assert.doesNotMatch(desktopApp(), /appendSwitch\("force-(color-profile|device-scale-factor)/);
  assert.deepEqual(centredIn({ x: 0, y: 33, width: 1512, height: 949 }, { width: 760, height: 720 }), { x: 376, y: 148 });
  assert.deepEqual(
    centredIn({ x: -211, y: -1050, width: 1920, height: 1050 }, { width: 2000, height: 1200 }),
    { x: -211, y: -1050 },
    "bigger than the area: its corner",
  );
  assert.match(source("../../apps/desktop/src/app.ts"), /process\.env\.UNCUT_CDP \? centredIn\(screen\.getPrimaryDisplay\(\)\.workArea/);
});

test("the test helper launches apps in the background unless UNCUT_TEST_VISIBLE=1, and emulates focus", () => {
  const helper = source("../helpers/app.ts");
  assert.match(helper, /UNCUT_TEST_VISIBLE === "1" \? \{\} : \{ UNCUT_TEST_BACKGROUND: "1" \}/);
  assert.equal(helper.match(/Emulation\.setFocusEmulationEnabled/g)?.length, 1, "focus emulation is turned on once");
  assert.match(helper, /if \(env\.UNCUT_TEST_BACKGROUND === "1"\)[^\n]*Emulation\.setFocusEmulationEnabled/);
});

test("the desktop shell never shows, focuses or activates in background mode", () => {
  const app = desktopApp();
  assert.doesNotMatch(app, /app\.focus\(/, "never app.focus()");
  assert.match(app, /if \(testBackground\) \{\s*app\.dock\?\.hide\(\);\s*\/\/[^\n]*\n\s*app\.setActivationPolicy\?\.\("accessory"\);/);
  assert.match(app, /backgroundThrottling: !testBackground/);
  // The window: shown inactive, transparent and click-through in the background; show() only otherwise.
  assert.match(
    app,
    /if \(!testBackground\) return win\?\.show\(\);\s*win\?\.setOpacity\(0\);[\s\S]*?win\?\.setIgnoreMouseEvents\(true\);\s*win\?\.showInactive\(\);/,
  );
  // Every other show()/focus() sits after a background guard in the same handler.
  const calls = [...app.matchAll(/win\.(show|focus)\(\)/g)];
  for (const call of calls) {
    const before = app.slice(Math.max(0, call.index! - 200), call.index);
    assert.match(before, /if \(testBackground\) return;/, `win.${call[1]}() at offset ${call.index} is guarded`);
  }
  const render = source("../../apps/desktop/src/render.ts");
  assert.match(render, /app\.dock\?\.hide\(\);/);
  assert.match(render, /show: false/);
});
