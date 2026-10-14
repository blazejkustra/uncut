// D186: brand kits and skills on disk (store.ts) and the RPCs' project guard (brandRpc.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// effect is the server's dependency (the same module brandRpc.ts loads).
import * as Effect from "../../apps/server/node_modules/effect/dist/Effect.js";
import type { BrandKit } from "../../packages/contracts/src/index.ts";

import { addKitFile, deleteKit, normKit, normSkill, readBrand, saveKit, saveSkill, writeActive, type BrandDirs } from "../../apps/server/src/brand/store.ts";
import { brandRpc } from "../../apps/server/src/brand/brandRpc.ts";

const root = mkdtempSync(join(tmpdir(), "uncut-brand-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
/** A fresh data folder and project folder. */
const dirs = (): Required<BrandDirs> => {
  const base = join(root, `case-${++n}`);
  mkdirSync(join(base, "data"), { recursive: true });
  mkdirSync(join(base, "project"), { recursive: true });
  return { dataDir: join(base, "data"), projectDir: join(base, "project") };
};
const kit = (id: string, scope: BrandKit["scope"], extra: Partial<BrandKit> = {}): BrandKit => ({ id, name: id, scope, logos: {}, colors: [], fonts: [], tone: "", taglines: [], urls: [], dos: [], donts: [], examples: [], ...extra });

test("normKit drops bad colours, files and fonts, and refuses a bad id", () => {
  const k = normKit(
    {
      id: "acme",
      name: "  Acme ",
      colors: [{ hex: "#ABC", role: "primary" }, { hex: "red", role: "accent" }, { hex: "#12345", role: "x" }, { hex: "#00FF00" }],
      fonts: [{ family: "Inter", role: "headline", weight: 750 }, { family: "  ", role: "body" }, { family: "Mono", weight: 50 }],
      logos: { light: "logo.svg", dark: "../escape.svg", mark: 42 },
      examples: ["a.png", "/abs/b.png", "noext"],
      taglines: ["Ship it", "", 3],
    },
    "global",
  )!;
  assert.equal(k.name, "Acme");
  assert.deepEqual(k.colors, [{ hex: "#aabbcc", role: "primary" }, { hex: "#00ff00", role: "accent" }]);
  assert.deepEqual(k.fonts, [{ family: "Inter", role: "headline", weight: 750 }, { family: "Mono", role: "body" }]);
  assert.deepEqual(k.logos, { light: "logo.svg" });
  assert.deepEqual(k.examples, ["a.png"]);
  assert.deepEqual(k.taglines, ["Ship it"]);
  assert.equal(normKit({ id: "Bad Id", name: "x" }, "global"), undefined);
  assert.equal(normKit({ id: "../up", name: "x" }, "global"), undefined);
  assert.equal(normSkill({ id: "-dash" }, "global"), undefined);
  assert.equal(normSkill({ id: "ok", name: "" }, "project")!.name, "ok");
});

test("a kit saved with an invalid id gets a slug of its name", async () => {
  const d = dirs();
  const saved = await saveKit(d, kit("Not An Id!", "global", { name: "Café Brand" }));
  assert.equal(saved.id, "cafe-brand");
  assert.ok(existsSync(join(d.dataDir, "brand", "kits", "cafe-brand", "kit.json")));
  const stored = JSON.parse(readFileSync(join(d.dataDir, "brand", "kits", "cafe-brand", "kit.json"), "utf8"));
  assert.equal(stored.scope, undefined, "the scope is where it lives, not a field");
});

test("a project kit and skill win over the user's with the same id", async () => {
  const d = dirs();
  await saveKit(d, kit("acme", "global", { name: "Global Acme" }));
  await saveKit(d, kit("acme", "project", { name: "Project Acme" }));
  await saveKit(d, kit("other", "global", { name: "Zed" }));
  await saveSkill(d, { id: "promo", name: "Global promo", scope: "global", description: "", body: "g" });
  await saveSkill(d, { id: "promo", name: "Project promo", scope: "project", description: "", body: "p" });
  const state = await readBrand(d);
  assert.deepEqual(state.kits.map((k) => [k.id, k.name, k.scope]), [["acme", "Project Acme", "project"], ["other", "Zed", "global"]]);
  assert.deepEqual(state.skills.map((s) => [s.id, s.scope, s.body]), [["promo", "project", "p"]]);
  // Without the project only the user's are seen.
  const alone = await readBrand({ dataDir: d.dataDir });
  assert.equal(alone.kits.find((k) => k.id === "acme")!.name, "Global Acme");
  assert.deepEqual(alone.active, { kit: null, skills: [] });
});

test("the project's choice drops kits and skills that don't exist", async () => {
  const d = dirs();
  await saveKit(d, kit("acme", "global"));
  await saveSkill(d, { id: "promo", name: "Promo", scope: "global", description: "", body: "" });
  await writeActive(d.projectDir, { kit: "gone", skills: ["promo", "missing", "promo"] });
  assert.deepEqual((await readBrand(d)).active, { kit: null, skills: ["promo"] });
  await writeActive(d.projectDir, { kit: "acme", skills: [] });
  assert.equal((await readBrand(d)).active.kit, "acme");
  // A hand-edited file with junk is read leniently.
  writeFileSync(join(d.projectDir, "brand", "active.json"), JSON.stringify({ kit: "../acme", skills: ["Bad", 3, "promo"] }));
  assert.deepEqual((await readBrand(d)).active, { kit: null, skills: ["promo"] });
});

test("addKitFile refuses other types and picks a free name", async () => {
  const d = dirs();
  await saveKit(d, kit("acme", "global"));
  const src = join(root, `logo-${n}.svg`);
  writeFileSync(src, "<svg/>");
  const txt = join(root, `notes-${n}.txt`);
  writeFileSync(txt, "hi");
  await assert.rejects(addKitFile(d, "acme", "global", txt), /not \.txt/);
  await assert.rejects(addKitFile(d, "acme", "global", join(root, "missing.png")), /isn't a file/);
  await assert.rejects(addKitFile(d, "../x", "global", src), /No such kit/);
  const first = await addKitFile(d, "acme", "global", src);
  const second = await addKitFile(d, "acme", "global", src);
  assert.equal(first, `logo-${n}.svg`);
  assert.equal(second, `logo-${n}-2.svg`);
  const state = await readBrand(d);
  assert.equal(state.files.acme![first], join(d.dataDir, "brand", "kits", "acme", first));
  assert.ok(state.files.acme![second]);
  // A project file needs an open project.
  await assert.rejects(addKitFile({ dataDir: d.dataDir }, "acme", "project", src), /Open a project/);
});

test("moving a kit's scope: saved in the new place, deleted from the old, its files copied", async () => {
  const d = dirs();
  const src = join(root, `mark-${n}.png`);
  writeFileSync(src, "png");
  await saveKit(d, kit("acme", "global"));
  const name = await addKitFile(d, "acme", "global", src);
  await saveKit(d, kit("acme", "global", { logos: { mark: name } }));
  // What the Brand tab does: copy the files across, save there, delete the old one.
  const before = await readBrand(d);
  const copied = await addKitFile(d, "acme", "project", before.files.acme![name]!);
  await saveKit(d, kit("acme", "project", { logos: { mark: copied } }));
  await deleteKit(d, "acme", "global");
  const state = await readBrand(d);
  assert.deepEqual(state.kits.map((k) => [k.id, k.scope, k.logos.mark]), [["acme", "project", copied]]);
  assert.equal(state.files.acme![copied], join(d.projectDir, "brand", "kits", "acme", copied));
  assert.ok(!existsSync(join(d.dataDir, "brand", "kits", "acme")));
});

test("deleteKit removes the kit and its files; bad ids and a missing project are refused", async () => {
  const d = dirs();
  await saveKit(d, kit("acme", "project"));
  await writeActive(d.projectDir, { kit: "acme", skills: [] });
  await deleteKit(d, "acme", "project");
  assert.ok(!existsSync(join(d.projectDir, "brand", "kits", "acme")));
  const state = await readBrand(d);
  assert.deepEqual(state.kits, []);
  assert.equal(state.active.kit, null);
  await assert.rejects(deleteKit(d, "../../etc", "global"), /No such kit/);
  await assert.rejects(deleteKit({ dataDir: d.dataDir }, "acme", "project"), /Open a project/);
  await assert.rejects(saveKit({ dataDir: d.dataDir }, kit("x", "project")), /Open a project/);
});

test("brandRpc: setActive with no project open fails with no-project; get works", async () => {
  const d = dirs();
  const rpc = brandRpc(d.dataDir, Effect.succeed(undefined));
  const error = await Effect.runPromise(Effect.flip(rpc.setActive({ kit: null, skills: [] })));
  assert.equal(error._tag, "BrandError");
  assert.equal(error.reason, "no-project");
  const state = await Effect.runPromise(rpc.get);
  assert.deepEqual(state.active, { kit: null, skills: [] });
  // A failure in the store reads as "failed" with its message.
  const bad = await Effect.runPromise(Effect.flip(rpc.saveKit(kit("x", "project"))));
  assert.equal(bad.reason, "failed");
  assert.match(bad.message, /Open a project/);
  // With a project, the choice is kept.
  const withProject = brandRpc(d.dataDir, Effect.succeed({ dir: d.projectDir } as never));
  await Effect.runPromise(withProject.saveKit(kit("acme", "global")));
  const chosen = await Effect.runPromise(withProject.setActive({ kit: "acme", skills: [] }));
  assert.equal(chosen.active.kit, "acme");
});
