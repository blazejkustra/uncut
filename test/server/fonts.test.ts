// D198 (issue #34): what the server draws with. Installed families come from the font files' own
// name tables (a collection too), the bundled DM faces and the chosen kit's font files become
// data: URL faces, and `available` says whether a family is drawn as asked.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { BrandKit } from "../../packages/contracts/src/index.ts";
import { fontFileFamilies, installedFamilies, projectFonts } from "../../apps/server/src/export/fonts.ts";
import { saveKit, writeActive } from "../../apps/server/src/brand/store.ts";

const root = mkdtempSync(join(tmpdir(), "uncut-fonts-"));
after(() => rmSync(root, { recursive: true, force: true }));
const SYSTEM = "/System/Library/Fonts";
const onMac = existsSync(join(SYSTEM, "Helvetica.ttc")) ? false : "needs macOS's Helvetica.ttc";

test("a font file's families from its name table (a .ttc collection too); not a font: none", { skip: onMac }, async () => {
  const families = await fontFileFamilies(join(SYSTEM, "Helvetica.ttc"));
  assert.ok(families.includes("Helvetica"), families.join(", "));
  const notFont = join(root, "x.ttf");
  writeFileSync(notFont, "not a font at all");
  assert.deepEqual(await fontFileFamilies(notFont), []);
});

test("installed families: read from the font folders (UNCUT_FONT_DIRS replaces them; empty: none)", { skip: onMac }, async () => {
  const some = await installedFamilies({ UNCUT_FONT_DIRS: SYSTEM });
  assert.ok(some.has("helvetica") && some.has("menlo"), [...some].slice(0, 20).join(", "));
  assert.ok(!some.has("dm sans"), "DM Sans isn't installed here (it's bundled)");
  assert.equal((await installedFamilies({ UNCUT_FONT_DIRS: "" })).size, 0);
});

test("a project's fonts: the bundled faces, the kit's font files as faces and CSS, its logos, and which families are there", async () => {
  const dataDir = join(root, "data");
  const projectDir = join(root, "project");
  mkdirSync(join(dataDir, "brand", "kits", "acme"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(dataDir, "brand", "kits", "acme", "KitMono.woff2"), readFileSync(resolve("assets/fonts/DMMono-Regular.woff2")));
  writeFileSync(join(dataDir, "brand", "kits", "acme", "logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg"/>`);
  const kit: BrandKit = { id: "acme", name: "Acme", scope: "global", logos: { light: "logo.svg" }, colors: [], fonts: [{ family: "Uncut Kit Mono", role: "headline", file: "KitMono.woff2" }, { family: "Acme Display", role: "body" }], tone: "", taglines: [], urls: [], dos: [], donts: [], examples: [] };
  await saveKit({ dataDir }, kit);
  await writeActive(projectDir, { kit: "acme", skills: [] });
  const fonts = await projectFonts(resolve("assets/fonts"), { dataDir, projectDir }, true);
  assert.deepEqual(fonts.sources.map((s) => s.family), ["DM Sans", "DM Mono", "DM Mono", "Uncut Kit Mono"]);
  assert.match(fonts.sources.at(-1)!.url, /^data:font\/woff2;base64,d09GMg/, "the kit's file as a data: URL (wOF2)");
  assert.match(fonts.kitCss, /^@font-face\{font-family:"Uncut Kit Mono";font-style:normal;font-weight:100 1000;src:url\(data:font\/woff2;base64,/);
  assert.ok(!fonts.kitCss.includes('"DM Sans"'), "the rasteriser's page has the bundled faces already");
  assert.ok(fonts.available("DM Sans") && fonts.available("uncut kit mono"));
  assert.ok(!fonts.available("Ghost Grotesk"));
  assert.deepEqual(fonts.kitMissing, ["Acme Display"], "a kit family with no file that isn't installed");
  assert.match(fonts.logos.light!, /^data:image\/svg\+xml;base64,/);
});
