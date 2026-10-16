// D252: .uncut project folders are a macOS document package with Uncut's project icon. Checks the
// Info.plist extras electron-builder.yml declares (read with electron-builder's own YAML parser), the
// icon it copies, the Open panel accepting packages, and the parser for paths Finder hands over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";

import { PROJECT_UTI, projectDirFromOpenedPath } from "../../apps/desktop/src/projectPath.ts";

const root = new URL("../../", import.meta.url);
const desktop = new URL("apps/desktop/", root);

// js-yaml is what electron-builder reads its config with (electron-builder → app-builder-lib → js-yaml).
function loadYaml(text: string): any {
  // pnpm links packages from .pnpm; resolve from their real paths to see their own dependencies.
  const fromBuilder = createRequire(realpathSync(new URL("node_modules/electron-builder/package.json", desktop)));
  const fromLib = createRequire(realpathSync(fromBuilder.resolve("app-builder-lib")));
  return fromLib("js-yaml").load(text);
}
const config = loadYaml(readFileSync(new URL("electron-builder.yml", desktop), "utf8"));
const info = config.mac.extendInfo;

test("Info.plist exports the .uncut UTI as a package with the project icon", () => {
  const types = info.UTExportedTypeDeclarations;
  assert.equal(types.length, 1);
  const [type] = types;
  assert.equal(type.UTTypeIdentifier, PROJECT_UTI);
  assert.ok(type.UTTypeConformsTo.includes("com.apple.package"), "conforms to com.apple.package");
  assert.deepEqual(type.UTTypeTagSpecification["public.filename-extension"], ["uncut"]);
  assert.equal(type.UTTypeIconFile, "project.icns");
  assert.ok(type.UTTypeDescription);
});

test("Info.plist makes Uncut the owner and editor of that type", () => {
  const docs = info.CFBundleDocumentTypes;
  assert.equal(docs.length, 1);
  const [doc] = docs;
  assert.deepEqual(doc.LSItemContentTypes, [PROJECT_UTI]);
  assert.equal(doc.LSTypeIsPackage, true);
  assert.equal(doc.CFBundleTypeRole, "Editor");
  assert.equal(doc.LSHandlerRank, "Owner");
  assert.equal(doc.CFBundleTypeIconFile, "project.icns");
  // fileAssociations would add a second, extension-only document type next to this one.
  assert.equal(config.fileAssociations, undefined);
});

test("the project icon is built and copied to Contents/Resources", () => {
  const entry = config.extraResources.find((r: { from?: string }) => r.from === "build/project.icns");
  assert.ok(entry, "extraResources copies build/project.icns");
  assert.equal(entry.to, "project.icns");
  const icns = readFileSync(new URL("build/project.icns", desktop));
  assert.equal(icns.subarray(0, 4).toString("latin1"), "icns");
  assert.ok(existsSync(new URL("scripts/make-project-icon.ts", desktop)));
});

test("the Open panel can pick a .uncut package as well as a plain folder", () => {
  const src = readFileSync(new URL("src/app/dialogs.ts", desktop), "utf8");
  assert.match(src, /purpose === "project" \? \["openFile", "openDirectory"\]/);
  assert.match(src, /extensions: \["uncut"\]/);
});

test("projectDirFromOpenedPath: the .uncut folder Finder opened", () => {
  assert.equal(projectDirFromOpenedPath("/Users/me/Movies/Launch.uncut"), "/Users/me/Movies/Launch.uncut");
  assert.equal(projectDirFromOpenedPath("/Users/me/Movies/Launch.uncut/"), "/Users/me/Movies/Launch.uncut");
  assert.equal(projectDirFromOpenedPath("/Users/me/Movies/Launch.UNCUT"), "/Users/me/Movies/Launch.UNCUT");
  assert.equal(projectDirFromOpenedPath("/Users/me/My Videos/a b.uncut"), "/Users/me/My Videos/a b.uncut");
  assert.equal(projectDirFromOpenedPath("/Users/me//Movies/./Launch.uncut"), "/Users/me/Movies/Launch.uncut");
});

test("projectDirFromOpenedPath: a path inside a project means that project", () => {
  assert.equal(projectDirFromOpenedPath("/Users/me/Launch.uncut/project.json"), "/Users/me/Launch.uncut");
  assert.equal(projectDirFromOpenedPath("/Users/me/Launch.uncut/media/clip.mp4"), "/Users/me/Launch.uncut");
  // The nearest one, if a project ever sits inside another.
  assert.equal(projectDirFromOpenedPath("/a/Outer.uncut/media/Inner.uncut/project.json"), "/a/Outer.uncut/media/Inner.uncut");
});

test("projectDirFromOpenedPath: anything else is not a project", () => {
  for (const p of ["/Users/me/clip.mp4", "/Users/me/Movies", "/", "", "Launch.uncut", "relative/Launch.uncut", "/Users/me/.uncut", "/x/Launch.uncut.bak", "/x/../Launch.uncut", undefined, 42]) {
    assert.equal(projectDirFromOpenedPath(p), undefined, String(p));
  }
});
