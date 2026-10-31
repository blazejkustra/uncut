// D198 (issue #34): which fonts a graphic asks for, the faces inlined into it, the fonts rule
// (a text, the theme or a graphic asking for a family that isn't there is a finding, not a silent
// fallback), the kit's logos for uncut:brand/ markers, and the graphic bootstrap loading every
// face before the first frame.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  familiesOf,
  fontRule,
  graphicAskedFamilies,
  graphicDocument,
  graphicFontFamilies,
  graphicLogosUsed,
  projectChecks,
  resolveGraphicBrand,
  resolveGraphicFonts,
  textFamily,
  type FontSource,
  type Project,
} from "../../packages/core/src/index.ts";

const face = (family: string, bytes = 40): FontSource => ({ family, format: "woff2", url: `data:font/woff2;base64,${"A".repeat(bytes)}` });

test("the families a graphic asks for: CSS, inline styles, SVG attributes, canvas ctx.font (also in a template literal) and style.fontFamily", () => {
  const html = `<style>h1{font-family:"Kit Sans", 'DM Sans', sans-serif;font-weight:700} .b{font: 600 48px/1.1 Inter, system-ui}</style>
<div style="font-family: 'Brand Serif', serif">x</div>
<svg><text font-family="Mono Brand, monospace">y</text></svg>
<script>
const ctx = c.getContext("2d");
ctx.font = "bold 64px 'Canvas Face', sans-serif";
ctx.font = \`600 \${size}px "Template Face", sans-serif\`;
el.style.fontFamily = "Js Face";
ctx.font = \`\${w} 40px \${family}\`;
</script>`;
  assert.deepEqual(graphicAskedFamilies(html), ["Kit Sans", "Brand Serif", "Mono Brand", "Js Face", "Inter", "Canvas Face", "Template Face"]);
  assert.deepEqual(graphicFontFamilies(html), ["Kit Sans", "DM Sans", "Brand Serif", "Mono Brand", "Js Face", "Inter", "Canvas Face", "Template Face"]);
  assert.deepEqual(familiesOf("var(--f), serif"), [], "an expression ends the list");
  assert.deepEqual(graphicAskedFamilies("<style>p{font-family: system-ui, -apple-system, sans-serif}</style>"), [], "generics are never asked for");
});

test("resolveGraphicFonts declares the faces of the families a graphic names, before it, and nothing else; a face over the budget is a comment", () => {
  const html = `<canvas></canvas><script>ctx.font = "40px 'Kit Mono'";</script>`;
  const out = resolveGraphicFonts(html, [face("DM Sans"), face("Kit Mono"), face("Other")]);
  assert.match(
    out,
    /^<style data-uncut-fonts>@font-face\{font-family:"Kit Mono";font-style:normal;font-weight:100 1000;src:url\(data:font\/woff2;base64,A+\) format\("woff2"\)\}<\/style>\n/,
  );
  assert.ok(!out.includes('"DM Sans"') && !out.includes('"Other"'), "only the families it names");
  assert.ok(out.endsWith(html), "the author's HTML is unchanged after it");
  assert.equal(resolveGraphicFonts("<div>no fonts</div>", [face("Kit Mono")]), "<div>no fonts</div>");
  const tight = resolveGraphicFonts(`<style>p{font-family:"A"}b{font-family:"B"}</style>`, [face("A", 100), face("B", 100)], 160);
  assert.match(tight, /font-family:"A"/);
  assert.match(tight, /<!-- uncut: the font B left out: the graphic's fonts are over 0 KB -->/);
  assert.ok(!/font-family:"B";font-style/.test(tight));
});

test("the graphic's bootstrap loads every declared face before calling render (canvas text doesn't wait for a font)", () => {
  const doc = graphicDocument("<p>x</p>", { width: 100, height: 100 });
  const at = doc.indexOf("await fontsReady();");
  assert.ok(at > 0 && at < doc.indexOf("await window.render(at,"), "fonts first, then render");
  assert.match(doc, /\[\.\.\.document\.fonts\]\.map\(\(f\) => f\.load\(\)/);
});

test("kit logos for uncut:brand/logo-… markers: data: URLs, a missing one a blank pixel", () => {
  const html = `<img src="uncut:brand/logo-light"><div style="background:url(uncut:brand/logo-mark)"></div><img src="uncut:brand/logo-dark">`;
  assert.deepEqual(graphicLogosUsed(html), ["light", "mark", "dark"]);
  const out = resolveGraphicBrand(html, { light: "data:image/svg+xml;base64,PHN2Zz4=", mark: "data:image/png;base64,iVBO" });
  assert.match(out, /<img src="data:image\/svg\+xml;base64,PHN2Zz4=">/);
  assert.match(out, /url\(data:image\/png;base64,iVBO\)/);
  assert.match(out, /<img src="data:image\/gif;base64,R0lGOD/);
});

test("the fonts rule: a text, the theme or a graphic asking for a family that isn't bundled, in the kit or installed is a finding", () => {
  const project = {
    format: "uncut",
    version: 1,
    canvas: { width: 1920, height: 1080, fps: 30 },
    theme: { fonts: { display: "Missing Display" } },
    media: [],
    tracks: [
      {
        id: "t",
        kind: "text",
        items: [
          { id: "a", type: "text", text: "Kit font", start: 0, duration: 60, style: { font: "Kit Mono" } },
          { id: "b", type: "text", text: "Nope", start: 60, duration: 60, style: { font: "Ghost Grotesk" } },
          { id: "c", type: "text", text: "Default", start: 120, duration: 60 },
          { id: "d", type: "text", text: "Theme", start: 180, duration: 60, style: { font: "display" } },
        ],
      },
      { id: "v", kind: "video", items: [{ id: "g", type: "graphic", src: "graphics/g.html", start: 30, duration: 60 }] },
    ],
  } as unknown as Project;
  const have = new Set(["kit mono", "dm sans", "helvetica"]);
  const graphics = new Map([["graphics/g.html", `<script>ctx.font = "40px 'Phantom Face', sans-serif"; ctx.font = "20px Helvetica";</script>`]]);
  const found = projectChecks(project, { rules: [fontRule((f) => have.has(f.toLowerCase()), graphics)] }).filter((c) => c.id === "font-missing");
  const keys = found.map((c) => c.key).sort();
  assert.deepEqual(keys, ["font-missing:b", "font-missing:graphics/g.html", "font-missing:theme:display"]);
  const g = found.find((c) => c.key === "font-missing:graphics/g.html")!;
  assert.match(g.message, /"Phantom Face"/);
  assert.ok(!g.message.includes("Helvetica"));
  assert.deepEqual(g.itemIds, ["g"]);
  assert.equal(g.frame, 30);
  assert.equal(textFamily(project, { style: { font: "display" } } as never), "Missing Display");
  assert.equal(textFamily(project, {} as never), undefined, "sans: the default stack");
});

test("readGraphics gives the fonts only what's left under the document cap after three.js and the author's file", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { readGraphics } = await import("../../apps/server/src/export/exporter.ts");
  const { loadGraphicLibs } = await import("../../apps/server/src/export/graphicLibs.ts");
  const { MAX_GRAPHIC_DOC_BYTES } = await import("../../packages/core/src/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "uncut-font-cap-"));
  try {
    mkdirSync(join(dir, "graphics"));
    const html = `<script src="uncut:lib/three.js"></script><style>p{font-family:"Big Kit"}</style><!--${"x".repeat(250_000)}-->`;
    writeFileSync(join(dir, "graphics", "g.html"), html);
    const project = {
      canvas: { width: 100, height: 100, fps: 30 },
      tracks: [{ items: [{ type: "graphic", src: "graphics/g.html", duration: 30 }] }],
    } as unknown as Project;
    const doc = (await readGraphics(dir, project, await loadGraphicLibs(resolve("assets/graphic-libs")), { fonts: [face("Big Kit", 590_000)] })).get(
      "graphics/g.html",
    )!;
    assert.ok(Buffer.byteLength(graphicDocument(doc, project.canvas)) < MAX_GRAPHIC_DOC_BYTES, `${Buffer.byteLength(doc)} bytes`);
    assert.match(doc, /<!-- uncut: the font Big Kit left out/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a family a canvas font gets from a constant is declared too (the launch-film rehearsal fell back to Helvetica)", () => {
  // As launch-film-8.html wrote it: the family only in a constant, ctx.font built in a template literal.
  const html = `<canvas></canvas><script>
const SANS = "'DM Sans', sans-serif", MONO = "'DM Mono', monospace";
function font(w, s, fam) { ctx.font = \`\${w} \${s}px \${fam || SANS}\`; }
</script>`;
  assert.deepEqual(graphicFontFamilies(html), [], "no declaration names it");
  const out = resolveGraphicFonts(html, [face("DM Sans"), face("DM Mono"), face("Kit Sans"), face("Sans")]);
  assert.match(out, /@font-face\{font-family:"DM Sans"/);
  assert.match(out, /@font-face\{font-family:"DM Mono"/);
  assert.ok(!out.includes('font-family:"Kit Sans"'), "a family it never names isn't added");
  assert.ok(out.endsWith(html));
  // Named outright goes in first when the budget is tight.
  const tight = resolveGraphicFonts(
    `<script>const F = "Kit Sans";</script><style>p{font-family:"DM Mono"}</style>`,
    [face("Kit Sans", 100), face("DM Mono", 100)],
    160,
  );
  assert.match(tight, /font-family:"DM Mono";font-style/);
  assert.match(tight, /the font Kit Sans left out/);
});

test("a family the graphic declares itself (@font-face with a data: URL) isn't missing; one with an outside URL still is", () => {
  const project = {
    format: "uncut/0",
    name: "P",
    canvas: { width: 100, height: 100, fps: 30 },
    media: [],
    tracks: [
      {
        id: "v",
        kind: "video",
        items: [
          { id: "g", type: "graphic", src: "graphics/g.html", start: 0, duration: 30 },
          { id: "h", type: "graphic", src: "graphics/h.html", start: 0, duration: 30 },
        ],
      },
    ],
  } as unknown as Project;
  const graphics = new Map([
    [
      "graphics/g.html",
      `<style>@font-face{font-family:"Geist";font-weight:100 900;src:url(data:font/woff2;base64,AAAA) format("woff2")}</style><script>ctx.font = "600 40px 'Geist', sans-serif";</script>`,
    ],
    [
      "graphics/h.html",
      `<style>@font-face { font-family: 'Archivo'; src: url("https://fonts.example/archivo.woff2") }</style><script>ctx.font = "40px Archivo";</script>`,
    ],
  ]);
  const found = projectChecks(project, { rules: [fontRule(() => false, graphics)] }).filter((c) => c.id === "font-missing");
  assert.deepEqual(
    found.map((c) => c.key),
    ["font-missing:graphics/h.html"],
  );
});

test("a project's fonts folder: faces by the file's name before its first dash, with a weight word or the whole range", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { projectFontSources, projectFonts } = await import("../../apps/server/src/export/fonts.ts");
  const dir = mkdtempSync(join(tmpdir(), "uncut-project-fonts-"));
  try {
    mkdirSync(join(dir, "fonts"));
    writeFileSync(join(dir, "fonts", "Geist-Variable.woff2"), Buffer.from("wOF2fake"));
    writeFileSync(join(dir, "fonts", "Archivo-Bold.woff2"), Buffer.from("wOF2fake"));
    writeFileSync(join(dir, "fonts", "notes.txt"), "x");
    const faces = await projectFontSources(dir);
    assert.deepEqual(
      faces.map((f) => [f.family, f.weight]),
      [
        ["Archivo", "700"],
        ["Geist", undefined],
      ],
    );
    const fonts = await projectFonts("assets/fonts", { dataDir: join(dir, "data"), projectDir: dir });
    assert.ok(fonts.available("Geist") && fonts.available("archivo"));
    assert.match(fonts.kitCss, /font-family:"Geist"/, "text items get them in the rasteriser's CSS too");
    assert.match(resolveGraphicFonts(`<script>ctx.font = "40px Geist";</script>`, fonts.sources), /@font-face\{font-family:"Geist"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
