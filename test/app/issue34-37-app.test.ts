// Issues #34, #35, #37 (D198–D200) on the packaged app run invisibly and muted, with the stand-in
// claude and a home folder of the test's own:
// - #37: paths in the composer are chips; the folders a message names are reported on the turn
//   ("Found 3 files and 1 folder in ~/…"), all of ~/Downloads says why it wasn't listed;
// - #35: the agent's new kit lands in the library with logos imported from a folder, shown as
//   pictures in the Brand tab; its colour change waits on a before / after card (Keep the kit);
// - #34: the kit's font file is loaded in the preview, so a text set in it is drawn in it.
// Screenshots: test-output/issue34-*.png, issue35-*.png, issue37-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const LOGO = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 64"><circle cx="32" cy="32" r="24" fill="#f5a623"/><text x="68" y="44" font-family="Helvetica" font-weight="700" font-size="36" fill="${fill}">argent</text></svg>`;
const FAMILY = "Uncut Kit Mono";

let root = "";
let home = "";
const apps = new Set<LaunchedApp>();
const shot = (name: string) => resolve("test-output", `${name}.png`);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue34-37-")));
  home = join(root, "home");
  mkdirSync(join(home, "Projects"), { recursive: true });
  const clips = join(home, "Videos", "project");
  mkdirSync(join(clips, "takes"), { recursive: true });
  for (const n of ["intro.mp4", "demo.mp4", "frame.png"]) writeFileSync(join(clips, n), "x");
  mkdirSync(join(home, "Videos", "assets"), { recursive: true });
  writeFileSync(join(home, "Videos", "assets", "notes.txt"), "x");
  const brand = join(home, "Downloads", "brand-kit");
  mkdirSync(brand, { recursive: true });
  writeFileSync(join(brand, "argent-logo.svg"), LOGO("#0b1d3a"));
  writeFileSync(join(brand, "argent-logo-white.svg"), LOGO("#ffffff"));
  writeFileSync(join(brand, "argent-mark.png"), PNG);
  writeFileSync(join(home, "Downloads", "KitMono.woff2"), readFileSync(resolve("assets/fonts/DMMono-Regular.woff2")));
  // The test's HOME has no shell profile, so the login shell's PATH may not find this Node: the stand-in runs with it by path.
  writeFileSync(join(root, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(join(root, "results.jsonl"), "");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issues 34, 35, 37: path chips and found folders, a library kit with logo pictures and a diff card, the kit's font in the preview", { skip, timeout: 300000 }, async () => {
  const plan = join(root, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify([
      [
        { tool: "brand_write", args: { name: "Argent", colors: [{ hex: "#0b1d3a", role: "background" }, { hex: "#f5a623", role: "accent" }, { hex: "#ffffff", role: "text" }], import: "~/Downloads/brand-kit", fonts: [{ family: FAMILY, role: "headline", file: "~/Downloads/KitMono.woff2" }] } },
        { tool: "project_read" },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Title", ops: [{ op: "insert_item", track: "text", item: { id: "title", type: "text", text: "Argent 0123 iii", start: 0, duration: 90, style: { font: FAMILY, size: 140, color: "#ffffff" } } }] } },
        { tool: "brand_write", args: { kit: "argent", colors: [{ hex: "#e5484d", role: "error" }, { hex: "#0b1d3a", role: "background" }], style: { source: "reference.mp4", palette: [{ hex: "#e5484d", role: "alert" }], type: "Heavy grotesk", shotLengths: "under 1 s", transitions: "hard cuts", camera: "locked", grain: "none" } } },
        { text: "The kit is in your library, and the reference's style is its own guide." },
      ],
    ]),
  );
  const app = await launchApp({
    command: APP,
    env: { HOME: home, UNCUT_FONT_DIRS: "", UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(home, "Projects")]), UNCUT_CLAUDE: join(root, "claude"), FAKE_PLAN: plan, FAKE_PROMPT_LOG: join(root, "prompts.jsonl"), FAKE_RESULT_LOG: join(root, "results.jsonl"), UNCUT_APPROVAL_MS: "60000" },
  });
  apps.add(app);
  const { page } = app;
  const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor("[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor("[data-testid=agent-panel]");

    // #37: paths in the composer are chips (~, $HOME and a plain one).
    await page.click("[data-testid=agent-input]");
    await page.keyboard.type("Recreate it with the clips in ~/Videos/project and the assets in $HOME/Videos/assets. The brand is in ~/Downloads/brand-kit, more in ~/Downloads.");
    const chips = await page.$$eval(".composer-hl [data-testid=agent-path-chip]", (els) => els.map((el) => (el as HTMLElement).innerText));
    assert.deepEqual(chips, ["~/Videos/project", "$HOME/Videos/assets", "~/Downloads/brand-kit", "~/Downloads"]);
    await page.screenshot({ path: shot("issue37-path-chips") });
    await page.keyboard.press("Enter");

    // #35: the colour change waits on the before / after card.
    await waitFor("[data-testid=agent-approval][data-kind=brand]", 30000);
    assert.equal(await page.$eval("[data-testid=agent-approval] .approval-text", (el) => (el as HTMLElement).innerText.trim()), 'Change the colours of the kit "Argent"?');
    assert.equal((await page.$$("[data-testid=agent-brand-diff-gone]")).length, 2, "the accent and the text colour would go");
    assert.equal((await page.$$("[data-testid=agent-brand-diff-new]")).length, 1, "the reference's red would come in");
    await page.$eval("[data-testid=agent-approval]", (el) => el.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: shot("issue35-diff-card") });
    await page.click("[data-testid=agent-decline]");
    await page.waitForFunction(() => document.querySelector("[data-testid=agent-turn]")?.getAttribute("data-status") === "done", { timeout: 30000 });

    // #37: what was found in each folder, and why ~/Downloads wasn't listed.
    const found = await page.$$eval("[data-testid=agent-turn-folder]", (els) => els.map((el) => (el as HTMLElement).innerText.trim()));
    assert.deepEqual(found, [
      "Found 3 files and 1 folder in ~/Videos/project",
      "Found 1 file in ~/Videos/assets",
      "Found 3 files in ~/Downloads/brand-kit",
      "Didn't list ~/Downloads: it's all of ~/Downloads; paste a folder inside it",
    ]);
    await page.$eval("[data-testid=agent-turn-folders]", (el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: shot("issue37-folders") });

    // The kit kept its colours (Keep the kit) and has its style guide; it lives in the library.
    const kit = JSON.parse(readFileSync(join(root, "data", "brand", "kits", "argent", "kit.json"), "utf8"));
    assert.deepEqual(kit.colors.map((c: { hex: string }) => c.hex), ["#0b1d3a", "#f5a623", "#ffffff"]);
    assert.equal(kit.style.palette[0].hex, "#e5484d");
    assert.deepEqual(kit.logos, { light: "argent-logo.svg", dark: "argent-logo-white.svg", mark: "argent-mark.png" });

    // #34: the kit's font file is loaded in the preview and the title is drawn in it.
    await page.waitForFunction((family) => document.fonts.check(`40px "${family}"`) && [...document.fonts].some((f) => f.family.replace(/"/g, "") === family && f.status === "loaded"), { timeout: 15000 }, FAMILY);
    const title = await page.waitForSelector(".pv-text[data-item=title]", { timeout: 15000 });
    const family = await title!.evaluate((el) => getComputedStyle(el).fontFamily);
    assert.match(family, new RegExp(`^"${FAMILY}"`));
    await page.screenshot({ path: shot("issue34-preview-kit-font") });

    // #35: the Brand tab shows the logos as pictures (the SVGs drawn), the font with its file.
    await page.click("[data-testid=rail-brand]");
    await waitFor("[data-testid=brand-kit-argent]");
    await page.click("[data-testid=brand-kit-argent]");
    await waitFor("[data-testid=brand-kit-editor]");
    for (const slot of ["light", "dark", "mark"]) {
      await page.waitForFunction((s) => {
        const img = document.querySelector<HTMLImageElement>(`[data-testid=brand-logo-${s}-thumb] img`);
        return !!img && img.complete && img.naturalWidth > 0;
      }, { timeout: 10000 }, slot);
    }
    assert.ok(await page.$("[data-testid=brand-font-file-0].on"), "the font has its file");
    await page.screenshot({ path: shot("issue35-brand-kit") });
  } catch (error) {
    await page.screenshot({ path: shot("issue34-37-failure") }).catch(() => {});
    throw error;
  }
});
