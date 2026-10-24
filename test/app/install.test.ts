// Phase 3 exit check: "the app installs, onboards and opens an empty project", from the real
// .dmg. Mount it, copy Uncut.app out like a drag to Applications (into a temp folder, never
// the real /Applications), detach, and launch the copy with launchd's bare environment (as
// Finder would) and real login-shell PATH resolution. Steps are logged as "# step …".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadModules, validateProject } from "../../packages/core/src/index.ts";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, onInterrupt, unlockApps, type LaunchedApp } from "../helpers/app.ts";
import { DJI_CLIP } from "../helpers/footage.ts";

const DJI = DJI_CLIP;
const dmgs = existsSync("dist")
  ? readdirSync("dist")
      .filter((f) => /^Uncut-.+-arm64\.dmg$/.test(f))
      .map((f) => resolve("dist", f))
  : [];
const DMG = dmgs[0];
const skip = dmgs.length === 0 ? "no dmg built: run pnpm dist" : false;

/** The newest modification time of any source file that ends up in the app. */
function newestSource() {
  let newest = 0;
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else newest = Math.max(newest, statSync(path).mtimeMs);
    }
  };
  for (const parent of ["apps", "packages"]) for (const pkg of existsSync(parent) ? readdirSync(parent) : []) walk(join(parent, pkg, "src"));
  walk("native/media/src");
  walk("plugins");
  return newest;
}

let root: string,
  mountpoint: string,
  mounted = false,
  app: LaunchedApp | undefined;
const step = (text: string) => console.log(`# step: ${text}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = (page: Page, selector: string, timeout = 30000) => page.waitForSelector(selector, { timeout });
const text = (page: Page, id: string) => page.$eval(`[data-testid=${id}]`, (el) => el.textContent.trim());
const row = (page: Page, id: string) =>
  page.$eval(`[data-testid=check-${id}]`, (el) => `${el.querySelector(".wiz-chip")!.textContent}, ${el.querySelector(".wiz-sub")!.textContent}`);
const detach = () => {
  if (!mounted) return;
  const r = spawnSync("hdiutil", ["detach", mountpoint], { encoding: "utf8" });
  if (r.status !== 0) spawnSync("hdiutil", ["detach", "-force", mountpoint]);
  mounted = false;
};

// What launchd gives an app opened from Finder: no Homebrew, nvm or ~/.local/bin on PATH.
const finderEnv = (extra: NodeJS.ProcessEnv) => ({
  HOME: homedir(),
  USER: process.env.USER,
  LOGNAME: process.env.USER,
  TMPDIR: process.env.TMPDIR,
  SHELL: process.env.SHELL || "/bin/zsh",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  ...extra,
});

before(async () => {
  if (skip) return;
  await lockApps();
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-install-")));
  // Interrupted (Ctrl-C, a kill): detach the image and remove the temp folder; the helper kills
  // any app it launched and releases the lock.
  onInterrupt(() => {
    detach();
    rmSync(root, { recursive: true, force: true });
  });
  mountpoint = join(root, "volume");
  mkdirSync(mountpoint);
  mkdirSync(join(root, "Applications"));
  mkdirSync(join(root, "Projects"));
});
after(async () => {
  await app?.close().catch(() => {});
  detach();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("installs from the dmg, onboards, opens an empty project, imports, and remembers it after a relaunch", { skip, timeout: 300000 }, async () => {
  assert.equal(dmgs.length, 1, `expected one dmg in dist/, found ${dmgs.map((d) => d.split("/").pop()).join(", ")}`);
  assert.ok(statSync(DMG).mtimeMs >= newestSource(), "dist is stale, run pnpm dist");
  step(`mount ${DMG.split("/").pop()}`);
  execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountpoint, DMG], { stdio: "ignore" });
  mounted = true;
  assert.ok(existsSync(join(mountpoint, "Uncut.app")), "the volume has Uncut.app");
  assert.ok(lstatSync(join(mountpoint, "Applications")).isSymbolicLink(), "the volume has an Applications link");
  assert.equal(readlinkSync(join(mountpoint, "Applications")), "/Applications");

  step("copy Uncut.app out (ditto, like a drag to Applications), then detach");
  const installed = join(root, "Applications", "Uncut.app");
  execFileSync("ditto", [join(mountpoint, "Uncut.app"), installed]);
  detach();
  assert.equal(spawnSync("codesign", ["--verify", "--deep", "--strict", installed]).status, 0, "the copy is validly (ad-hoc) signed");
  assert.ok(!execFileSync("xattr", [installed], { encoding: "utf8" }).includes("com.apple.quarantine"), "copied locally, so not quarantined");
  assert.deepEqual(readFileSync(join(installed, "Contents/Resources/icon.icns")), readFileSync(resolve("apps/desktop/build/icon.icns")), "Uncut's own icon");
  // Help › Licence and Third-Party Notices open these; Electron's and Chromium's licences ship too (D112).
  assert.ok(readFileSync(join(installed, "Contents/Resources/LICENSE.txt")).equals(readFileSync(resolve("LICENSE"))), "LICENSE shipped");
  assert.ok(
    readFileSync(join(installed, "Contents/Resources/THIRD_PARTY_NOTICES.txt")).equals(readFileSync(resolve("THIRD_PARTY_NOTICES"))),
    "notices shipped",
  );
  assert.ok(existsSync(join(installed, "Contents/Resources/licenses/LICENSES.chromium.html")), "Chromium's licences shipped");
  // No bundled music (D274).
  assert.ok(!existsSync(join(installed, "Contents/Resources/music")), "no music shipped");
  // The bundled CC0 sound-effects pack (D134) too, the same files as assets/sfx.
  const sfx = JSON.parse(readFileSync(join(installed, "Contents/Resources/sfx/library.json"), "utf8")) as { sounds: Array<{ file: string; license: string }> };
  assert.equal(sfx.sounds.length, (JSON.parse(readFileSync(resolve("assets/sfx/library.json"), "utf8")) as { sounds: Array<unknown> }).sounds.length);
  for (const t of sfx.sounds) {
    assert.equal(t.license, "CC0-1.0");
    assert.ok(readFileSync(join(installed, "Contents/Resources/sfx", t.file)).equals(readFileSync(resolve("assets/sfx", t.file))), t.file);
  }
  // The Argent capture plugin ships as a bundled plugin (D98): its manifest, server and icon (D281), no tests or notes.
  const shipped = join(installed, "Contents/Resources/plugins/argent-capture");
  assert.deepEqual(readFileSync(join(shipped, "uncut.module.json")), readFileSync(resolve("plugins/argent-capture/uncut.module.json")));
  assert.ok(readFileSync(join(shipped, "server.ts")).equals(readFileSync(resolve("plugins/argent-capture/server.ts"))));
  assert.deepEqual(readdirSync(shipped).sort(), ["icon.svg", "server.ts", "uncut.module.json"]);
  assert.ok(readFileSync(join(shipped, "icon.svg")).equals(readFileSync(resolve("plugins/argent-capture/icon.svg"))));
  // So does the Whisper plugin (D100): manifest, server, its whisper.ts and icon (D281).
  const whisper = join(installed, "Contents/Resources/plugins/whisper-transcribe");
  assert.deepEqual(readdirSync(whisper).sort(), ["icon.svg", "server.ts", "uncut.module.json", "whisper.ts"]);
  for (const f of readdirSync(whisper)) assert.ok(readFileSync(join(whisper, f)).equals(readFileSync(resolve("plugins/whisper-transcribe", f))), f);
  assert.deepEqual(readdirSync(join(installed, "Contents/Resources/plugins")).sort(), [
    "argent-capture",
    "catalog",
    "uncut-elevenlabs",
    "uncut-skills",
    "whisper-transcribe",
  ]);
  // The catalog (D103): every plugin in plugins/catalog, as in the repo, off until enabled.
  const catalog = join(installed, "Contents/Resources/plugins/catalog");
  assert.deepEqual(
    readdirSync(catalog).sort(),
    readdirSync(resolve("plugins/catalog"))
      .filter((n) => !n.startsWith(".") && !n.startsWith("_"))
      .sort(),
  );
  for (const name of readdirSync(catalog))
    for (const f of readdirSync(join(catalog, name)))
      assert.ok(readFileSync(join(catalog, name, f)).equals(readFileSync(resolve("plugins/catalog", name, f))), `${name}/${f}`);
  // The plugin SDK (D102): plugins on the app's Node import "@uncut/plugin-sdk" from here.
  const sdk = join(installed, "Contents/Resources/plugin-sdk");
  assert.deepEqual(readdirSync(sdk).sort(), ["index.ts", "register.ts"]);
  for (const f of readdirSync(sdk)) assert.ok(readFileSync(join(sdk, f)).equals(readFileSync(resolve("packages/plugin-sdk/src", f))), f);

  const data = join(root, "data");
  const projects = join(root, "Projects");
  const binary = join(installed, "Contents/MacOS/Uncut");
  // A tool only the login shell knows about: a zsh profile (via ZDOTDIR) puts a temp bin first
  // on PATH, holding an "argent" with a version nothing else has. If onboarding shows it, the
  // app really used the login shell's PATH (the usual install folders are only a fallback).
  const zdotdir = join(root, "zdotdir");
  const shellBin = join(root, "shell-only-bin");
  mkdirSync(zdotdir);
  mkdirSync(shellBin);
  writeFileSync(join(zdotdir, ".zprofile"), `export PATH="${shellBin}:$PATH"\n`);
  writeFileSync(join(shellBin, "argent"), "#!/bin/sh\necho 9.9.9-shellenv\n");
  chmodSync(join(shellBin, "argent"), 0o755);
  const launch = (dialogs: Array<unknown>) =>
    launchApp({
      command: binary,
      cleanEnv: true,
      firstLaunch: true,
      env: finderEnv({ SHELL: "/bin/zsh", ZDOTDIR: zdotdir, UNCUT_DATA_DIR: data, UNCUT_TEST_DIALOG: JSON.stringify(dialogs) }),
    });

  step("first launch with Finder's environment: onboarding with real statuses");
  app = await launch([projects, [DJI]]);
  let { page } = app;
  await waitFor(page, "[data-testid=onboarding]");
  await waitFor(page, "[data-testid=check-claude]");
  const claude = await page.$eval("[data-testid=check-claude]", (el) => (el as HTMLElement).dataset.status);
  // Machine-specific: whatever is true here is recorded; only a local claude must look sane.
  step(`Claude Code: ${await row(page, "claude")}`);
  if (claude === "error" || claude === "missing") step("note: Claude Code isn't usable on this machine; continuing");
  else if (existsSync(join(homedir(), ".local/bin/claude"))) assert.ok(["ready", "needs-login", "warning"].includes(claude!), claude);
  await page.click("[data-testid=wizard-continue]");
  await waitFor(page, "[data-testid=check-argent]");
  step(`Argent (shell-only stub): ${await row(page, "argent")}`);
  assert.match(await row(page, "argent"), /^Ready, Version 9\.9\.9-shellenv\. /, "the stub that only the login shell's PATH can find");
  const ffmpeg = await page.$eval("[data-testid=check-ffmpeg]", (el) => (el as HTMLElement).dataset.status);
  step(`ffmpeg: ${await row(page, "ffmpeg")}`);
  const hasFfmpeg = ffmpeg === "ready";

  step("First video, New project into a temp folder");
  await page.click("[data-testid=wizard-continue]");
  await page.click("[data-testid=wizard-new-project]");
  await waitFor(page, "[data-testid=new-project-form]");
  await page.click("[data-testid=project-name]", { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type("[data-testid=project-name]", "Install Check");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction((dir: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === dir, {}, projects);
  await page.click("[data-testid=create]");
  await waitFor(page, "[data-testid=editor]");
  assert.equal(await text(page, "project-title"), "Install Check");
  assert.equal(await text(page, "canvas-info"), "1920×1080, 30 fps");
  assert.deepEqual(await page.$$eval("[data-testid=track]", (els) => (els as Array<HTMLElement>).map((e) => e.dataset.kind)), ["text", "video", "audio"]);

  step("project.json on disk validates with @uncut/core");
  const dir = join(projects, "Install Check.uncut");
  const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  assert.deepEqual(validateProject(project, await loadModules(resolve("spec/modules/builtin"))), []);

  const withMedia = existsSync(DJI) && hasFfmpeg;
  if (!hasFfmpeg) step("skip the import: ffmpeg isn't installed here, so there'd be no thumbnail to check");
  else if (!existsSync(DJI)) step(`skip the import: ${DJI} isn't here`);
  if (withMedia) {
    step("import the DJI clip");
    await page.click("[data-testid=import]");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 1, { timeout: 60000 });
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("[data-testid=thumb]")].some((i) => i.complete && i.naturalWidth > 0), {
      timeout: 60000,
    });
    assert.equal(await page.$eval("[data-testid=tile-meta]", (el) => el.textContent), "3840×2160, 59.94 fps");
  }
  assert.deepEqual(app.errors, []);

  step("quit");
  await app.close();
  assert.notEqual(app.proc.signalCode, "SIGKILL", "quit cleanly");
  app = undefined;

  step("relaunch the installed copy: no onboarding, the project is in Recent");
  app = await launch([]);
  page = app.page;
  await waitFor(page, "[data-testid=recent]");
  await sleep(500);
  assert.equal(await page.$("[data-testid=onboarding]"), null);
  assert.deepEqual(await page.$$eval("[data-testid=recent] .wiz-name", (e) => (e as Array<HTMLElement>).map((x) => x.textContent)), ["Install Check"]);
  await page.click("[data-testid=recent]");
  await waitFor(page, "[data-testid=editor]");
  assert.equal(await text(page, "project-title"), "Install Check");
  if (withMedia) {
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 1);
    step("the media tile is there");
  }
  assert.deepEqual(app.errors, []);
  await app.close();
  app = undefined;
  step("done");
});
