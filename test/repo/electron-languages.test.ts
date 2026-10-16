// D293: the packaged app ships only Electron's English localisations (electron-builder's
// electronLanguages), for `pnpm dist` and `pnpm dist:signed` alike.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { dmgBuilderArgs, signedBuilderArgs } from "../../apps/desktop/scripts/signing.ts";

const fromBuilder = createRequire(realpathSync("apps/desktop/node_modules/electron-builder/package.json"));
const yaml = createRequire(realpathSync(fromBuilder.resolve("app-builder-lib")))("js-yaml") as { load: (s: string) => any };
const config = yaml.load(readFileSync("apps/desktop/electron-builder.yml", "utf8"));

const ENGLISH = ["en", "en_GB", "en_FEMININE", "en_MASCULINE", "en_NEUTER", "en_GB_FEMININE", "en_GB_MASCULINE", "en_GB_NEUTER"];

// electron-builder's own rule (app-builder-lib removeUnusedLanguagesIfNeeded): a folder stays when a
// wanted language equals its name or starts with its name and "-" or "_" (case-insensitive).
const kept = (folder: string, wanted: ReadonlyArray<string>) => {
  const lang = folder.replace(/\.lproj$/, "").toLowerCase();
  return wanted.map((w) => w.toLowerCase()).some((w) => w === lang || w.startsWith(`${lang}-`) || w.startsWith(`${lang}_`));
};

test("electronLanguages keeps exactly Electron's English localisations", () => {
  assert.deepEqual(config.electronLanguages, ENGLISH);
  assert.equal(config.mac.electronLanguages, undefined, "no mac override of the list");

  const electron = "node_modules/electron/dist/Electron.app/Contents";
  const framework = join(electron, "Frameworks/Electron Framework.framework/Resources");
  for (const dir of [join(electron, "Resources"), framework]) {
    const folders = readdirSync(dir).filter((f) => f.endsWith(".lproj"));
    assert.ok(folders.length > 50, `${dir} still ships every language before packing`);
    const left = folders.filter((f) => kept(f, ENGLISH)).sort();
    assert.ok(left.every((f) => /^en(_GB)?(_(FEMININE|MASCULINE|NEUTER))?\.lproj$/.test(f)), `only English kept in ${dir}: ${left.join(", ")}`);
    assert.ok(left.includes("en.lproj") && left.includes("en_GB.lproj"), `en (Chromium's en-US) and en_GB kept in ${dir}`);
  }
  // Chromium's en-US strings are en.lproj/locale.pak in the framework.
  assert.ok(existsSync(join(framework, "en.lproj/locale.pak")));
});

test("the signed build packs with the same list and its DMG reuses the trimmed app", () => {
  for (const args of [signedBuilderArgs("A".repeat(40)), dmgBuilderArgs("/s/Uncut.app", "/out")]) {
    assert.ok(args.includes("electron-builder.yml"), "same config file");
    assert.ok(!args.some((a) => a.includes("electronLanguages")), "the list is never overridden on the command line");
  }
  assert.ok(dmgBuilderArgs("/s/Uncut.app", "/out").includes("--prepackaged"), "the DMG is made from the already trimmed, signed app");
});
