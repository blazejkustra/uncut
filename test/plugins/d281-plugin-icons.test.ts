// D281: a plugin's own icon (uncut.module.json "icon": an .svg at the top of its folder).
// - checkPluginIcon: plain shapes pass and come back as a data: URL; scripts, handlers, links,
//   images, styles, outside URLs, DOCTYPEs, a missing xmlns and oversized files are refused;
// - the schema takes a file name only (no folders, no ..);
// - discovery attaches the checked icon; a bad, missing or linked-out one is a warning and no icon,
//   never a skipped plugin; pluginInfos passes it on;
// - every repo plugin (bundled and catalog) has an icon that passes, and the packaged app ships it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPluginIcon, MAX_ICON_BYTES, validateModule } from "../../packages/core/src/index.ts";
import { discoverPlugins } from "../../apps/server/src/plugins/plugins.ts";
import { pluginInfos } from "../../apps/server/src/plugins/discovery/infos.ts";
import { shippedFiles, REPO_PLUGINS } from "../../scripts/plugin-bundle.ts";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const ok = (svg: string) => {
  const r = checkPluginIcon(svg);
  assert.ok("dataUrl" in r, `refused: ${"problem" in r ? r.problem : ""}\n${svg}`);
  return r.dataUrl;
};
const refused = (svg: string, why: RegExp) => {
  const r = checkPluginIcon(svg);
  assert.ok("problem" in r, `accepted: ${svg}`);
  assert.match(r.problem, why);
};

const roots: Array<string> = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const tmp = () => {
  const r = realpathSync(mkdtempSync(join(tmpdir(), "uncut-icons-")));
  roots.push(r);
  return r;
};
const plugin = (parent: string, folder: string, icon: string | undefined, files: Record<string, string> = {}) => {
  const dir = join(parent, folder);
  mkdirSync(dir, { recursive: true });
  const id = `acme.${folder}`;
  writeFileSync(
    join(dir, "uncut.module.json"),
    JSON.stringify({
      manifest: "uncut.module/0",
      id,
      kind: "pack",
      name: folder,
      version: "1.0.0",
      ...(icon ? { icon } : {}),
      runtime: { type: "data" },
      contributes: { looks: [{ id: `${id}.card`, name: "Card", look: { size: 0.05, weight: 600, x: 0.5, y: 0.5 } }] },
    }),
  );
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return realpathSync(dir);
};

test("checkPluginIcon: plain shapes pass as a base64 data URL", () => {
  const svg = `<?xml version="1.0"?>\n<!-- a comment -->\n<svg ${NS} viewBox="0 0 24 24"><defs><mask id="m"><rect width="24" height="24" fill="#fff"/></mask><linearGradient id="g"><stop offset="0"/></linearGradient></defs><g mask="url(#m)" fill="url(#g)"><path d="M0 0h24v24z"/><circle cx="1" cy="1" r="1"/></g><title>Mark</title></svg>`;
  const url = ok(svg);
  assert.match(url, /^data:image\/svg\+xml;base64,/);
  assert.equal(Buffer.from(url.split(",")[1]!, "base64").toString("utf8"), svg.trim());
});

test("checkPluginIcon: scripts, handlers, links, images, styles, outside URLs and DOCTYPEs are refused", () => {
  refused(`<svg ${NS}><script>alert(1)</script></svg>`, /<script>/);
  refused(`<svg ${NS} onload="alert(1)"><path d="M0 0"/></svg>`, /event handler/);
  refused(`<svg ${NS}><path ONCLICK='x()' d="M0 0"/></svg>`, /event handler/);
  refused(`<svg ${NS}><image href="https://example.com/x.png"/></svg>`, /<image>/);
  refused(`<svg ${NS}><use href="#a"/></svg>`, /<use>/);
  refused(`<svg ${NS}><a xlink:href="javascript:alert(1)"><path d="M0 0"/></a></svg>`, /<a>/);
  refused(`<svg ${NS}><path xlink:href="#x" d="M0 0"/></svg>`, /link/);
  refused(`<svg ${NS}><foreignObject><div/></foreignObject></svg>`, /foreignObject/);
  refused(`<svg ${NS}><style>@import url(https://x)</style></svg>`, /<style>/);
  refused(`<svg ${NS}><path style="fill:red" d="M0 0"/></svg>`, /style attribute/);
  refused(`<svg ${NS}><path fill="url(https://example.com/x)" d="M0 0"/></svg>`, /outside/);
  refused(`<svg ${NS}><path fill="url(&#104;ttps://x)" d="M0 0"/></svg>`, /outside/);
  refused(`<svg ${NS}><path filter="url( 'data:x' )" d="M0 0"/></svg>`, /outside/);
  refused(`<svg ${NS}><text>Hi</text></svg>`, /<text>/);
  refused(`<!DOCTYPE svg [<!ENTITY x "y">]><svg ${NS}><path d="M0 0"/></svg>`, /DOCTYPE/);
  refused(`<svg ${NS}><![CDATA[x]]></svg>`, /DOCTYPE/);
  refused(`<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>`, /xmlns/);
  refused(`<g ${NS}><path d="M0 0"/></g>`, /start with an <svg>/);
  refused(`<svg ${NS}><path d="M0 0"/ < /svg>`, /well-formed|element/);
  refused(`<svg ${NS}><path d="${"M0 0 ".repeat(MAX_ICON_BYTES / 4)}"/></svg>`, /bigger than 32 KB/);
});

test("the schema: icon is a .svg file name at the top of the plugin's folder", () => {
  const base = { manifest: "uncut.module/0", id: "acme.x", kind: "pack", name: "X", version: "1.0.0", runtime: { type: "data" } };
  assert.deepEqual(validateModule({ ...base, icon: "icon.svg" }), []);
  for (const bad of ["../icon.svg", "icons/icon.svg", "/tmp/icon.svg", ".icon.svg", "icon.png", "icon.svg.js", ""])
    assert.ok(validateModule({ ...base, icon: bad }).length > 0, `${JSON.stringify(bad)} accepted`);
});

test("discovery: a good icon comes through to PluginInfo; a bad, missing or linked-out one is a warning, not a skip", async () => {
  const root = tmp();
  const outside = tmp();
  writeFileSync(join(outside, "icon.svg"), `<svg ${NS}><path d="M0 0h1v1z"/></svg>`);
  plugin(root, "good", "icon.svg", { "icon.svg": `<svg ${NS} viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>` });
  plugin(root, "script", "icon.svg", { "icon.svg": `<svg ${NS}><script>alert(1)</script></svg>` });
  plugin(root, "missing", "icon.svg");
  const linked = plugin(root, "linked", "icon.svg");
  symlinkSync(join(outside, "icon.svg"), join(linked, "icon.svg"));
  plugin(root, "big", "icon.svg", { "icon.svg": `<svg ${NS}>${" ".repeat(MAX_ICON_BYTES)}</svg>` });
  plugin(root, "none", undefined);
  const found = await discoverPlugins([{ source: "user", dir: root }], { moduleIds: new Set(), toolNames: new Set() });
  assert.deepEqual(found.broken, [], "no plugin skipped over its icon");
  const by = new Map(found.plugins.map((p) => [p.name, p]));
  assert.match(by.get("good")!.icon!, /^data:image\/svg\+xml;base64,/);
  assert.deepEqual(by.get("good")!.warnings, []);
  for (const [name, why] of [
    ["script", /<script>/],
    ["missing", /can't read it/],
    ["linked", /outside the plugin's folder/],
    ["big", /bigger than 32 KB/],
  ] as const) {
    assert.equal(by.get(name)!.icon, undefined, `${name} has no icon`);
    assert.ok(
      by.get(name)!.warnings.some((w) => w.startsWith("Its icon icon.svg is left out: ") && why.test(w)),
      `${name}: ${by.get(name)!.warnings.join(" | ")}`,
    );
  }
  assert.equal(by.get("none")!.icon, undefined);
  assert.deepEqual(by.get("none")!.warnings, []);
  const infos = new Map(pluginInfos(found, {}).map((p) => [p.name, p]));
  assert.equal(infos.get("good")!.icon, by.get("good")!.icon);
  assert.equal("icon" in infos.get("none")!, false);
});

test("every repo plugin, bundled and catalog, has an icon that passes, and the packaged app ships it", async () => {
  const found = await discoverPlugins(
    [
      { source: "bundled", dir: REPO_PLUGINS },
      { source: "user", dir: join(REPO_PLUGINS, "catalog") },
    ],
    { moduleIds: new Set(), toolNames: new Set() },
  );
  assert.deepEqual(found.broken, []);
  const ids = found.plugins.map((p) => p.id).sort();
  for (const id of ["argent.capture", "uncut.skills", "whisper.transcribe", "uncut.link-import", "uncut.example-kit", "typegpu.effects", "taste.extra"])
    assert.ok(ids.includes(id), `${id} found`);
  for (const p of found.plugins) {
    assert.match(p.icon ?? "", /^data:image\/svg\+xml;base64,/, `${p.id} has an icon`);
    assert.ok(!p.warnings.some((w) => /icon/.test(w)), `${p.id}: ${p.warnings.join(" | ")}`);
    assert.ok(shippedFiles(p.dir).includes(p.manifest.icon as string), `${p.id}'s icon ships`);
  }
  // The templates too (they don't ship, but a new plugin starts from them).
  for (const t of readdirSync(join(REPO_PLUGINS, "catalog")).filter((n) => n.startsWith("_"))) {
    const dir = join(REPO_PLUGINS, "catalog", t);
    const m = JSON.parse(readFileSync(join(dir, "uncut.module.json"), "utf8")) as { icon?: string };
    assert.ok(m.icon && "dataUrl" in checkPluginIcon(readFileSync(join(dir, m.icon), "utf8")), `${t} has a good icon`);
  }
});
