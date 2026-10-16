// #80 (D252): the packaged app's Info.plist declares .uncut folders a document package owned by Uncut,
// with the project icon in Contents/Resources. What Finder draws (one item, the icon) and the
// double-click open (app.ts's open-file hook) need a manual check on a registered build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const BUNDLE = resolve("dist/mac-arm64/Uncut.app");
const UTI = "com.blazejkustra.uncut.project";

test("Info.plist: the .uncut UTI is exported as a package and Uncut owns it", { skip: !existsSync(BUNDLE) && "no packaged app (pnpm dist)" }, () => {
  const plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", `${BUNDLE}/Contents/Info.plist`], { encoding: "utf8" }));
  const exported = plist.UTExportedTypeDeclarations as Array<Record<string, any>>;
  const type = exported.find((t) => t.UTTypeIdentifier === UTI);
  assert.ok(type, "the project UTI is exported");
  assert.ok(type.UTTypeConformsTo.includes("com.apple.package"));
  assert.deepEqual(type.UTTypeTagSpecification["public.filename-extension"], ["uncut"]);
  assert.equal(type.UTTypeIconFile, "project.icns");

  const docs = (plist.CFBundleDocumentTypes as Array<Record<string, any>>).filter((d) => d.LSItemContentTypes?.includes(UTI));
  assert.equal(docs.length, 1, "one document type for projects");
  assert.equal(docs[0]!.LSTypeIsPackage, true);
  assert.equal(docs[0]!.LSHandlerRank, "Owner");
  assert.equal(docs[0]!.CFBundleTypeRole, "Editor");
  assert.equal(docs[0]!.CFBundleTypeIconFile, "project.icns");
  // No second, extension-only entry from electron-builder's fileAssociations.
  assert.equal((plist.CFBundleDocumentTypes as Array<unknown>).length, 1);

  const icon = `${BUNDLE}/Contents/Resources/project.icns`;
  assert.ok(existsSync(icon), "Contents/Resources/project.icns");
  assert.equal(readFileSync(icon).subarray(0, 4).toString("latin1"), "icns");
  // The app icon is still the app's own.
  assert.equal(plist.CFBundleIconFile, "icon.icns");
});
