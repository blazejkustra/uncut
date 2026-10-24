// D198 (issue #35): kits live in the user's library (a kit made in a project before is copied
// there once, the project's copy still winning; a kit pinned since stays pinned), logos and fonts
// come in from a file, a folder (~ works) or a web address (media_download's guard), SVG kept as
// it is but refused with scripts, slots and families guessed from names, and the agent's changes to
// a kit's colours and fonts listed before and after for the approval card.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { BrandKit } from "../../packages/contracts/src/index.ts";
import { migrateProjectKits, normKit, readBrand, saveKit, type BrandDirs } from "../../apps/server/src/brand/store.ts";
import { fillLogos, fontFamilyOf, importIntoKit, logoSlot } from "../../apps/server/src/brand/importer.ts";
import { kitChanges, mergeKit } from "../../apps/server/src/agent/agentPlan.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-brand-library-")));
let server: Server;
let port = 0;
before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/logo.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#f80"/></svg>`);
    }
    if (req.url === "/font.woff2") {
      res.writeHead(200, { "content-type": "font/woff2" });
      return res.end(readFileSync(resolve("assets/fonts/DMMono-Regular.woff2")));
    }
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html></html>");
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as { port: number }).port;
});
after(() => {
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
const dirs = (): Required<Omit<BrandDirs, "skills">> => {
  const base = join(root, `case-${++n}`);
  mkdirSync(join(base, "data"), { recursive: true });
  mkdirSync(join(base, "project"), { recursive: true });
  return { dataDir: join(base, "data"), projectDir: join(base, "project") };
};
const kit = (id: string, scope: BrandKit["scope"], extra: Partial<BrandKit> = {}): BrandKit => ({
  id,
  name: id,
  scope,
  logos: {},
  colors: [],
  fonts: [],
  tone: "",
  taglines: [],
  urls: [],
  dos: [],
  donts: [],
  examples: [],
  ...extra,
});
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#0b1d3a"/></svg>`;

test("a kit made in a project before D198 is copied into the library once (with its files); the project's copy keeps winning there; a pinned one stays", async () => {
  const d = dirs();
  const old = join(d.projectDir, "brand", "kits", "argent");
  mkdirSync(old, { recursive: true });
  writeFileSync(
    join(old, "kit.json"),
    JSON.stringify({ id: "argent", name: "Argent", colors: [{ hex: "#0b1d3a", role: "background" }], logos: { light: "logo.svg" } }),
  );
  writeFileSync(join(old, "logo.svg"), SVG);
  // A kit pinned to the project since (saved with scope project) isn't copied.
  await saveKit(d, kit("pinned", "project"));
  assert.equal(JSON.parse(readFileSync(join(d.projectDir, "brand", "kits", "pinned", "kit.json"), "utf8")).pinned, true);

  const state = await readBrand(d);
  assert.ok(existsSync(join(d.dataDir, "brand", "kits", "argent", "kit.json")), "copied into the library");
  assert.equal(readFileSync(join(d.dataDir, "brand", "kits", "argent", "logo.svg"), "utf8"), SVG, "with its files");
  assert.ok(!existsSync(join(d.dataDir, "brand", "kits", "pinned")), "a pinned kit stays pinned");
  assert.equal(state.kits.find((k) => k.id === "argent")!.scope, "project", "this project still sees its own copy");
  assert.deepEqual(JSON.parse(readFileSync(join(d.projectDir, "brand", "migrated.json"), "utf8")).kits, ["argent"]);

  // Another project (same data folder) can pick it now.
  const other = { dataDir: d.dataDir, projectDir: join(root, `other-${n}`) };
  mkdirSync(other.projectDir, { recursive: true });
  const seen = await readBrand(other);
  assert.deepEqual(
    seen.kits.map((k) => [k.id, k.scope]),
    [["argent", "global"]],
  );
  assert.match(seen.files.argent!["logo.svg"]!, /data\/brand\/kits\/argent\/logo\.svg$/);

  // Deleted from the library by the user: not brought back.
  rmSync(join(d.dataDir, "brand", "kits", "argent"), { recursive: true });
  assert.deepEqual(await migrateProjectKits(d), []);
  assert.ok(!existsSync(join(d.dataDir, "brand", "kits", "argent")));
});

test("a kit font keeps its file (a kit file name of a font type); anything else is dropped", () => {
  const k = normKit(
    {
      id: "x",
      fonts: [
        { family: "Kit Mono", role: "body", file: "KitMono.woff2" },
        { family: "Bad", role: "body", file: "../x.woff2" },
        { family: "Pic", role: "body", file: "logo.png" },
      ],
    },
    "global",
  )!;
  assert.deepEqual(k.fonts, [
    { family: "Kit Mono", role: "body", file: "KitMono.woff2" },
    { family: "Bad", role: "body" },
    { family: "Pic", role: "body" },
  ]);
});

test("logo slots and font families from file names", () => {
  assert.equal(logoSlot("argent-logo.svg"), "light");
  assert.equal(logoSlot("argent-logo-white.svg"), "dark");
  assert.equal(logoSlot("Logo_Dark.png"), "dark");
  assert.equal(logoSlot("favicon.png"), "mark");
  assert.equal(logoSlot("argent-mark.svg"), "mark");
  assert.equal(logoSlot("landmark.svg"), "light", "a word that only contains mark");
  assert.equal(fontFamilyOf("Inter-SemiBold.woff2"), "Inter");
  assert.equal(fontFamilyOf("DMSans-Variable.ttf"), "DM Sans");
  assert.equal(fontFamilyOf("space_grotesk_regular.otf"), "Space Grotesk");
  assert.deepEqual(
    fillLogos({ light: "a.svg" }, [
      { name: "b.svg", kind: "logo", slot: "light" },
      { name: "w.svg", kind: "logo", slot: "dark" },
    ]),
    { light: "a.svg", dark: "w.svg" },
  );
});

test("importing into a kit: a file with ~, a folder (logos and fonts, not hidden files), a web address through the guard; an SVG with a script and a web page are refused", async () => {
  const d = dirs();
  await saveKit(d, kit("acme", "global"));
  const home = join(root, `home-${n}`);
  const brand = join(home, "Brand stuff");
  mkdirSync(brand, { recursive: true });
  writeFileSync(join(brand, "acme-logo.svg"), SVG);
  writeFileSync(join(brand, "acme-logo-white.svg"), SVG.replace("#0b1d3a", "#ffffff"));
  writeFileSync(
    join(brand, "acme-mark.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
  );
  writeFileSync(join(brand, "AcmeSans-Bold.woff2"), readFileSync(resolve("assets/fonts/DMMono-Medium.woff2")));
  writeFileSync(join(brand, ".hidden.svg"), SVG);
  writeFileSync(join(brand, "notes.txt"), "x");
  writeFileSync(join(home, "bad.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);

  const was = process.env.HOME;
  process.env.HOME = home;
  try {
    const one = await importIntoKit(d, "acme", "global", "~/Brand stuff/acme-logo.svg");
    assert.ok("files" in one, JSON.stringify(one));
    assert.deepEqual(one.files, [{ name: "acme-logo.svg", kind: "logo", slot: "light" }]);
    const folder = await importIntoKit(d, "acme", "global", "$HOME/Brand\\ stuff");
    assert.ok("files" in folder, JSON.stringify(folder));
    assert.deepEqual(
      folder.files.map((f) => [f.name, f.kind, f.slot ?? f.family]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
      [
        ["acme-logo-2.svg", "logo", "light"],
        ["acme-logo-white.svg", "logo", "dark"],
        ["acme-mark.png", "logo", "mark"],
        ["AcmeSans-Bold.woff2", "font", "Acme Sans"],
      ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
    );
    const bad = await importIntoKit(d, "acme", "global", "~/bad.svg");
    assert.ok("problem" in bad && /scripts or outside references/.test(bad.problem), JSON.stringify(bad));
  } finally {
    process.env.HOME = was;
  }
  const web = await importIntoKit(d, "acme", "global", `http://127.0.0.1:${port}/logo.svg`);
  assert.ok("files" in web, JSON.stringify(web));
  assert.equal(web.files[0]!.kind, "logo");
  const font = await importIntoKit(d, "acme", "global", `http://127.0.0.1:${port}/font.woff2`);
  assert.ok("files" in font && font.files[0]!.kind === "font", JSON.stringify(font));
  const page = await importIntoKit(d, "acme", "global", `http://127.0.0.1:${port}/page`);
  assert.ok("problem" in page && /web page/.test(page.problem), JSON.stringify(page));
  const files = (await readBrand(d)).files.acme!;
  assert.ok(files["acme-logo.svg"] && files["AcmeSans-Bold.woff2"] && files["logo.svg"] && files["font.woff2"], Object.keys(files).join(", "));
});

test("brand_write's merge: a font keeps its file unless another is given; colour and font changes listed before and after, a field the kit had nothing in isn't one", () => {
  const base = kit("acme", "global", {
    colors: [
      { hex: "#0b1d3a", role: "background" },
      { hex: "#f5a623", role: "accent" },
    ],
    fonts: [{ family: "Acme Sans", role: "headline", file: "AcmeSans.woff2" }],
  });
  const merged = mergeKit(base, {
    fonts: [
      { family: "Acme Sans", role: "headline" },
      { family: "Acme Mono", role: "mono", file: "~/x.woff2" },
    ],
  });
  assert.ok(!("problem" in merged));
  assert.deepEqual(merged.fonts, [
    { family: "Acme Sans", role: "headline", file: "AcmeSans.woff2" },
    { family: "Acme Mono", role: "mono", file: "~/x.woff2" },
  ]);
  const reference = mergeKit(base, {
    colors: [
      { hex: "#e5484d", role: "error" },
      { hex: "#0b1d3a", role: "background" },
    ],
  }) as BrandKit;
  assert.deepEqual(kitChanges(base, reference), [
    { field: "Colours", before: ["#0b1d3a background", "#f5a623 accent"], after: ["#e5484d error", "#0b1d3a background"] },
  ]);
  assert.deepEqual(
    kitChanges(base, { ...base, fonts: [{ family: "Acme Sans", role: "headline", file: "Other.woff2" }] }),
    [],
    "a file for the same font isn't a change",
  );
  assert.deepEqual(
    kitChanges(kit("empty", "global"), { ...kit("empty", "global"), colors: [{ hex: "#000000", role: "text" }] }),
    [],
    "a first colour isn't a change",
  );
  assert.deepEqual(
    kitChanges(
      base,
      mergeKit(base, { style: { palette: [{ hex: "#e5484d" }], type: "", shotLengths: "", transitions: "", camera: "", grain: "" } }) as BrandKit,
    ),
    [],
    "a style guide never changes the kit",
  );
});
