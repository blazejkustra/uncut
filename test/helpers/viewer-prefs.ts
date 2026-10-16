// This viewer's preview choices (localStorage, read once when the renderer loads), for app tests
// that measure one path: D273 made the GPU compositor and the loudness preview's At target the
// defaults, so a test of the DOM path or of the mix as it is opts out here. Call it on the Welcome
// screen: it stores the choices and reloads the window, back on Welcome.
import type { Page } from "puppeteer-core";
import { waitForWelcome } from "./app.ts";

export async function viewerPrefs(page: Page, prefs: { gpu?: boolean; atTarget?: boolean }) {
  await page.evaluate((p) => {
    if (p.gpu !== undefined) localStorage.setItem("uncut.preview.gpu", p.gpu ? "on" : "off");
    if (p.atTarget !== undefined) localStorage.setItem("uncut.previewAtTarget", p.atTarget ? "1" : "0");
  }, prefs);
  await page.reload();
  await waitForWelcome(page);
}
