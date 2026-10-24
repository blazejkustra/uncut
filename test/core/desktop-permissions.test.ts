// D219: the app window's permissions are deny by default (only the app's own top-level page, only
// what it uses) and the built renderer's CSP shuts plugins, <base> and form posts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { allowPermission, APP_PERMISSIONS } from "../../apps/desktop/src/permissions.ts";

const BUILT = fileURLToPath(new URL("../../apps/web/dist/index.html", import.meta.url));

test("D219: the app's page gets what it uses; nothing else, and nothing for any other frame", () => {
  for (const p of ["media", "display-capture", "clipboard-sanitized-write", "local-fonts", "pointerLock", "fullscreen", "loopback-network"]) {
    assert.equal(allowPermission(p, true), true, p);
    assert.equal(allowPermission(p, false), false, `${p} from a graphic's iframe`);
  }
  for (const p of [
    "geolocation",
    "notifications",
    "midi",
    "midiSysex",
    "hid",
    "usb",
    "serial",
    "clipboard-read",
    "openExternal",
    "idle-detection",
    "window-management",
    "speaker-selection",
    "storage-access",
    "unknown",
  ])
    assert.equal(allowPermission(p, true), false, p);
  assert.ok(APP_PERMISSIONS.size <= 10);
});

test(
  "D219: the built renderer's CSP comes first in <head> and shuts object-src, base-uri and form-action",
  { skip: existsSync(BUILT) ? false : "the web app isn't built (pnpm build)" },
  () => {
    const html = readFileSync(BUILT, "utf8");
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1]?.replace(/&#39;/g, "'");
    assert.ok(csp, "a CSP meta tag");
    for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'none'", "connect-src ws://127.0.0.1:* http://127.0.0.1:*"])
      assert.ok(csp.includes(d), d);
    assert.ok(!/script-src[^;]*unsafe/.test(csp) && !csp.includes("'unsafe-eval'"), "no inline or eval'd scripts");
    assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<script"), "the policy precedes the script");
  },
);
