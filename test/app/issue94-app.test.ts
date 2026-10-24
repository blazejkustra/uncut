// Issue #94 (D259), D280 on the packaged app (background window): Import from link through the
// user's own yt-dlp, here the fake one (test/helpers/fake-yt-dlp.ts) on PATH: never the network,
// never a real yt-dlp (UNCUT_SHELL_ENV=off keeps the login shell's PATH and the Homebrew folders
// out). It's a catalog plugin (uncut.link-import), not bundled and not a Labs flag.
// - Not installed: Media's + is the plain file import (no menu), a dropped link does nothing.
// - Installed and allowed (Settings › Plugins): + is a menu with Import from link…; every time, the
//   rights notice; then a link (Video, up to 1080p) is downloaded with progress into media/links/,
//   named after the title, and lands in Media with its source URL.
// - A slow one (Audio only) shows progress and Cancel kills yt-dlp (and the child it started) and
//   leaves no files; one hidden from the dialog shows in Media with its own Cancel; an unsupported
//   link's error is in plain words.
// - A link dropped on the timeline opens the dialog and its media goes there too.
// - Without yt-dlp on PATH: the brew install hint with Copy; Check again finds it once it's there.
// - A second launch (same data folder): still installed and allowed, the menu is there.
// Screenshots: test-output/issue94-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { KeyInput, Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-yt-dlp.ts");
const CARD = "[data-testid=market-card][data-id='uncut.link-import']";
const which = (bin: string) => spawnSync("/usr/bin/which", [bin], { encoding: "utf8" }).stdout.trim() || undefined;
const FFMPEG = which("ffmpeg");
const FFPROBE = which("ffprobe");
const skip = existsSync(APP) ? (FFMPEG && FFPROBE ? false : "needs ffmpeg and ffprobe") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let shim = "";
let bare = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (page: Page, name: string) => page.screenshot({ path: `test-output/issue94-${name}.png` });
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const meta = async (page: Page, key: KeyInput) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};
const project = () =>
  JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as {
    media: Array<{ id: string; name: string; path: string; kind: string; source?: Record<string, unknown> }>;
    tracks: Array<{ id: string; items: Array<{ media?: string; mediaId?: string; [k: string]: unknown }> }>;
  };
const links = () => (existsSync(join(dir, "media/links")) ? readdirSync(join(dir, "media/links")) : []);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const launch = async (path: string) => {
  const app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_SHELL_ENV: "off",
      PATH: `${path}:/usr/bin:/bin`,
      UNCUT_TEST_DIALOG: JSON.stringify([dir]),
      FAKE_YTDLP_VIDEO: join(root, "clip.mp4"),
      FAKE_YTDLP_AUDIO: join(root, "sound.m4a"),
      FAKE_YTDLP_TITLE: "Sunset over the sea: 4K/HDR",
      FAKE_YTDLP_LOG: join(root, "ytdlp.log"),
      FAKE_YTDLP_SLEEP_MS: "2500",
      FAKE_YTDLP_PID_FILE: join(root, "child.pid"),
    },
  });
  apps.add(app);
  await waitForWelcome(app.page);
  await app.page.click("[data-testid=open-project]");
  await waitFor(app.page, "[data-testid=editor]");
  await app.page.click("[data-testid=rail-media]").catch(() => {});
  await waitFor(app.page, "[data-testid=library]");
  return app;
};
const openFromMenu = async (page: Page) => {
  await page.click("[data-testid=import-plus]");
  await waitFor(page, "[data-testid=context-menu] [data-testid=menu-import-link]");
  await page.click("[data-testid=menu-import-link]");
  await waitFor(page, "[data-testid=link-import]");
};
const ackNotice = async (page: Page) => {
  await waitFor(page, "[data-testid=link-notice-ok]");
  await page.click("[data-testid=link-notice-ok]");
};
const typeLink = async (page: Page, url: string) => {
  await waitFor(page, "[data-testid=link-url]");
  await page.click("[data-testid=link-url]", { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type("[data-testid=link-url]", url);
};
const dropLink = (page: Page, selector: string, url: string, at?: { x: number; y: number }) =>
  page.$eval(
    selector,
    (el, url, at) => {
      const r = el.getBoundingClientRect();
      const point = at ? { clientX: r.left + at.x, clientY: r.top + at.y } : { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      const data = new DataTransfer();
      data.setData("text/uri-list", url);
      data.setData("text/plain", url);
      for (const type of ["dragenter", "dragover", "drop"])
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, ...point }));
    },
    url,
    at,
  );

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue94-")));
  execFileSync(FFMPEG!, [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=orange:s=640x360:r=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000",
    "-t",
    "3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    join(root, "clip.mp4"),
  ]);
  execFileSync(FFMPEG!, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=550:sample_rate=48000", "-t", "3", "-c:a", "aac", join(root, "sound.m4a")]);
  // PATH for the app: ffmpeg and ffprobe, and (in shim) the fake yt-dlp.
  shim = join(root, "shim");
  bare = join(root, "bare");
  for (const d of [shim, bare]) {
    mkdirSync(d);
    symlinkSync(FFMPEG!, join(d, "ffmpeg"));
    symlinkSync(FFPROBE!, join(d, "ffprobe"));
  }
  writeFileSync(join(shim, "yt-dlp"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(shim, "yt-dlp"), 0o755);
  dir = join(root, "Links.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Links",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [],
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [] },
      ],
    }),
  );
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("#94, D280: Import from link through the user's own yt-dlp (a catalog plugin)", { skip, timeout: 300000 }, async () => {
  let app = await launch(shim);
  let { page } = app;

  // Not installed: + imports files (the test dialog answers nothing), no menu; a dropped link does nothing.
  await page.click("[data-testid=import-plus]");
  await sleep(500);
  assert.equal(await page.$("[data-testid=context-menu]"), null, "no menu while the plugin isn't installed");
  await dropLink(page, "[data-testid=library]", "https://example.com/watch?v=off");
  await sleep(400);
  assert.equal(await page.$("[data-testid=link-import]"), null, "a dropped link does nothing while the plugin isn't installed");
  assert.ok(!(await page.$eval("body", (b) => (b as HTMLElement).innerText)).includes("Import from link"));

  // No Labs flag for it any more.
  await meta(page, "Comma");
  await waitFor(page, "[data-testid=settings-nav-labs]");
  await page.click("[data-testid=settings-nav-labs]");
  await waitFor(page, "[data-testid=labs-settings]");
  assert.equal(await page.$("[data-testid=lab-importFromLink]"), null, "not a Labs flag");

  // Install and allow it from Settings › Plugins (the catalog, off until the user does).
  await page.click("[data-testid=settings-nav-plugins]");
  await waitFor(page, "[data-testid=plugins-market]");
  await waitFor(page, `[data-testid=market-available] ${CARD}[data-state=available]`, 20000);
  const card = await page.$eval(CARD, (el) => (el as HTMLElement).innerText);
  assert.match(card, /Import a video or audio file from a link using your own yt-dlp/);
  assert.doesNotMatch(card, /youtube|instagram|tiktok|vimeo/i, "no site named");
  await shot(page, "plugin-card");
  await page.click("[data-testid='market-install-uncut.link-import']");
  await waitFor(page, "[data-testid=plugin-dialog]", 20000);
  await shot(page, "plugin-allow");
  await page.click("[data-testid=plugin-dialog-allow]");
  await waitFor(page, `[data-testid=market-installed] ${CARD}[data-state=enabled]`, 20000);
  await page.click("[data-testid=settings-close]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=plugins-market]"));

  // + is a menu now; the rights notice first.
  await openFromMenu(page);
  await waitFor(page, "[data-testid=link-notice]");
  assert.match(
    await page.$eval("[data-testid=link-notice]", (el) => (el as HTMLElement).innerText),
    /You need the rights to what you import\. Uncut doesn't check\./,
  );
  await shot(page, "notice");
  await ackNotice(page);
  await waitFor(page, "[data-testid=link-form]");
  assert.equal(await page.evaluate(() => localStorage.getItem("uncut.linkImport.rightsAck")), null, "nothing remembered: it's shown on every import");
  assert.match(await page.$eval("[data-testid=link-rights]", (el) => el.textContent ?? ""), /You need the rights to what you import/);
  assert.match(await page.$eval("[data-testid=link-tool]", (el) => el.textContent ?? ""), /yt-dlp 2026\.07\.04/);
  assert.equal(await page.$eval("[data-testid=link-quality]", (el) => (el as HTMLSelectElement).value), "1080", "best up to 1080p by default");

  // A video: progress, then it's in Media named after the title, with its link.
  await typeLink(page, "https://example.com/watch?v=sunset&list=PL1");
  await shot(page, "form");
  await page.click("[data-testid=link-start]");
  await page.waitForFunction(() => /Downloading… \d+%/.test(document.querySelector("[data-testid=link-status]")?.textContent ?? ""), { timeout: 15000 });
  await page.waitForFunction(() => Number(/(\d+)%/.exec(document.querySelector("[data-testid=link-status]")?.textContent ?? "")?.[1] ?? 0) > 0);
  await shot(page, "progress");
  await page.waitForFunction(
    () => !document.querySelector("[data-testid=link-import]") || document.querySelector("[data-testid=link-job][data-phase=failed]"),
    { timeout: 30000 },
  );
  if (await page.$("[data-testid=link-error]")) {
    await shot(page, "first-failed");
    assert.fail(`the import failed: ${await page.$eval("[data-testid=link-error]", (el) => el.textContent)}`);
  }
  await page.waitForFunction(
    () => [...document.querySelectorAll("[data-testid=media-tile]")].some((t) => (t as HTMLElement).innerText.includes("Sunset over the sea")),
    { timeout: 20000 },
  );
  await shot(page, "in-media");
  let media = project().media;
  assert.equal(media.length, 1);
  assert.equal(media[0]!.name, "Sunset over the sea: 4K/HDR");
  assert.equal(media[0]!.kind, "video");
  assert.equal(media[0]!.path, "media/links/Sunset over the sea 4K HDR.mp4", "a sanitised name in the project's media/links/");
  assert.deepEqual(media[0]!.source, {
    module: "import.link",
    url: "https://example.com/watch?v=sunset&list=PL1",
    title: "Sunset over the sea: 4K/HDR",
    kind: "video",
    quality: "1080",
    tool: "yt-dlp",
  });
  assert.deepEqual(links(), ["Sunset over the sea 4K HDR.mp4"]);
  const runs = () =>
    readFileSync(join(root, "ytdlp.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { argv: Array<string>; uncutEnv: number });
  const first = runs()[0]!;
  assert.ok(first.argv.includes("--ignore-config") && first.argv.includes("--no-playlist"), "no config files, no playlist");
  assert.ok(first.argv.includes("--no-cookies") && first.argv.includes("--no-cookies-from-browser"), "nothing signed in");
  assert.deepEqual(first.argv.slice(-2), ["--", "https://example.com/watch?v=sunset&list=PL1"]);
  assert.ok(first.argv.includes("res:1080,vcodec:h264,acodec:aac,ext:mp4:m4a"));
  assert.equal(first.uncutEnv, 0, "yt-dlp gets none of Uncut's own variables");

  // A slow one, Audio only: the notice again; progress; Cancel kills it and its child, leaves nothing.
  await openFromMenu(page);
  await waitFor(page, "[data-testid=link-notice]");
  await ackNotice(page);
  await waitFor(page, "[data-testid=link-form]");
  await typeLink(page, "https://example.com/slow-audio");
  await page.click("[data-testid=link-kind-audio]");
  assert.equal(await page.$("[data-testid=link-quality]"), null, "no quality for audio");
  rmSync(join(root, "child.pid"), { force: true });
  await page.click("[data-testid=link-start]");
  await page.waitForFunction(() => /Downloading… \d+%/.test(document.querySelector("[data-testid=link-status]")?.textContent ?? ""), { timeout: 15000 });
  for (let i = 0; i < 50 && !existsSync(join(root, "child.pid")); i++) await sleep(100);
  const child = Number(readFileSync(join(root, "child.pid"), "utf8"));
  assert.ok(alive(child));
  await shot(page, "slow");
  await page.click("[data-testid=link-cancel]");
  await waitFor(page, "[data-testid=link-cancelled]");
  for (let i = 0; i < 50 && alive(child); i++) await sleep(100);
  assert.ok(!alive(child), "Cancel killed yt-dlp's process tree");
  await sleep(300);
  assert.deepEqual(links(), ["Sunset over the sea 4K HDR.mp4"], "no partial files left");
  assert.equal(project().media.length, 1, "nothing added");
  assert.ok(runs()[1]!.argv.includes("-x") && runs()[1]!.argv.includes("m4a"), "audio only as m4a");
  await shot(page, "cancelled");

  // Hidden while it downloads: Media shows it with its own Cancel.
  await page.click("[data-testid=link-again]");
  await waitFor(page, "[data-testid=link-form]");
  await page.click("[data-testid=link-start]");
  await waitFor(page, "[data-testid=link-hide]");
  await page.click("[data-testid=link-hide]");
  await waitFor(page, "[data-testid=link-progress]");
  await page.waitForFunction(() => /Downloading/.test(document.querySelector("[data-testid=link-progress]")?.textContent ?? ""), { timeout: 15000 });
  await shot(page, "media-progress");
  await page.click("[data-testid=link-progress-cancel]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=link-progress]"), { timeout: 10000 });
  assert.equal(project().media.length, 1);

  // An unsupported link: the error in plain words; Try again goes back to the form.
  await openFromMenu(page);
  await ackNotice(page);
  await typeLink(page, "https://example.com/unsupported");
  await page.click("[data-testid=link-start]");
  await waitFor(page, "[data-testid=link-job][data-phase=failed]");
  assert.equal(await page.$eval("[data-testid=link-error]", (el) => el.textContent), "yt-dlp doesn't know how to import from that site.");
  await shot(page, "error");
  await page.click("[data-testid=link-close]");

  // Not a link: refused before yt-dlp runs.
  const before = runs().length;
  await openFromMenu(page);
  await ackNotice(page);
  await typeLink(page, "ftp://example.com/file.mp4");
  await page.$eval("[data-testid=link-form]", (f) => (f as HTMLFormElement).requestSubmit());
  await waitFor(page, "[data-testid=link-form] [data-testid=link-error]");
  assert.match(await page.$eval("[data-testid=link-error]", (el) => el.textContent ?? ""), /Only http and https links/);
  assert.equal(runs().length, before, "yt-dlp wasn't run");
  await page.click("[data-testid=link-close]");

  // A link dropped on the timeline: the dialog (prefilled), and the media goes on the timeline too.
  await dropLink(page, "[data-testid=lanes]", "https://example.com/watch?v=drop", { x: 300, y: 40 });
  await waitFor(page, "[data-testid=link-notice]");
  await ackNotice(page);
  await waitFor(page, "[data-testid=link-form]");
  assert.equal(await page.$eval("[data-testid=link-url]", (el) => (el as HTMLInputElement).value), "https://example.com/watch?v=drop");
  assert.match(await page.$eval("[data-testid=link-form]", (el) => (el as HTMLElement).innerText), /on the timeline where you dropped/);
  await page.click("[data-testid=link-start]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=link-import]"), { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 2, { timeout: 20000 });
  media = project().media;
  const dropped = media.find((m) => (m.source as { url?: string } | undefined)?.url === "https://example.com/watch?v=drop");
  assert.ok(dropped, "the dropped link's media is in Media");
  assert.equal(dropped.name, "Sunset over the sea: 4K/HDR 2", "a unique name");
  const placed = project()
    .tracks.flatMap((t) => t.items)
    .filter((i) => Object.values(i).includes(dropped.id));
  assert.equal(placed.length, 1, "and on the timeline");
  await shot(page, "dropped");
  await app.close();
  apps.delete(app);

  // No yt-dlp on PATH: the brew hint with Copy; Check again finds it once it's installed.
  app = await launch(bare);
  page = app.page;
  await openFromMenu(page);
  await waitFor(page, "[data-testid=link-missing]");
  assert.equal(await page.$eval("[data-testid=link-brew] code", (el) => el.textContent), "brew install yt-dlp");
  assert.match(await page.$eval("[data-testid=link-missing]", (el) => (el as HTMLElement).innerText), /Uncut doesn't include it/);
  await page.click("[data-testid=link-copy]");
  await waitFor(page, "[data-testid=link-copy][data-copied]");
  await shot(page, "missing");
  await page.click("[data-testid=link-check-again]");
  await waitFor(page, "[data-testid=link-missing]");
  writeFileSync(join(bare, "yt-dlp"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(bare, "yt-dlp"), 0o755);
  await page.click("[data-testid=link-check-again]");
  await waitFor(page, "[data-testid=link-notice]");
  await shot(page, "notice-again");
});
