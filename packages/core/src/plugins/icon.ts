// D281: a plugin's icon (uncut.module.json "icon": an .svg file in its folder). Uncut draws only its
// shape, as a CSS mask filled with the row's text colour, so whatever the file says it can't run or
// load anything; this check refuses anything but plain shapes anyway, so an icon stays an icon.
// Refused, never rewritten: a plugin with a bad icon keeps the generic one and gets a warning.

/** The most an icon file may be (PluginInfo carries it to the renderer on every connect). */
export const MAX_ICON_BYTES = 32 * 1024;

const SVG_NS = "http://www.w3.org/2000/svg";
// Plain shapes and what they're built from; no text (fonts), images, links, <use>, styles or scripts.
const ELEMENTS: ReadonlySet<string> = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs", "lineargradient", "radialgradient", "stop", "mask", "clippath", "title", "desc"]);
const TAG = /<\s*(\/?)\s*([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s=/"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
const NAMED: Readonly<Record<string, string>> = { colon: ":", tab: "", newline: "", lpar: "(", rpar: ")", sol: "/", quot: '"', apos: "'", amp: "&", lt: "<", gt: ">" };
const unentity = (s: string) =>
  s.replace(/&#x([0-9a-f]+);?|&#([0-9]+);?|&([a-z]+);/gi, (m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex || dec) {
      const code = parseInt(hex ?? dec!, hex ? 16 : 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return NAMED[name!.toLowerCase()] ?? m;
  });

export type IconCheck = { readonly dataUrl: string } | { readonly problem: string };

/**
 * A plugin icon's SVG text, checked: at most MAX_ICON_BYTES, an <svg> root with the SVG namespace
 * (Chromium draws a data-URL SVG only with it), only shape elements, no event handlers, links,
 * styles or URLs other than #references. Gives a data: URL to draw it with, or why it's refused.
 */
export function checkPluginIcon(text: string): IconCheck {
  if (Buffer.byteLength(text, "utf8") > MAX_ICON_BYTES) return { problem: `it's bigger than ${MAX_ICON_BYTES / 1024} KB` };
  const body = text
    .replace(/^﻿/, "")
    .replace(/^\s*<\?xml[^?]*\?>/, "")
    .replace(/<!--[^]*?-->/g, "");
  if (/<[!?]/.test(body)) return { problem: "it has a DOCTYPE, an entity or a processing instruction" };
  let first: string | undefined;
  let ns = false;
  for (const m of body.matchAll(TAG)) {
    const name = m[2]!.toLowerCase();
    if (!ELEMENTS.has(name)) return { problem: `it has a <${m[2]}> element, and an icon has only shapes (path, circle, rect, g and the like)` };
    if (m[1]) continue;
    first ??= name;
    for (const a of m[3]!.matchAll(ATTR)) {
      if (!/^[A-Za-z_][\w:.-]*$/.test(a[1]!)) return { problem: "it isn't well-formed SVG" };
      const attr = a[1]!.toLowerCase();
      const value = unentity(unentity((a[2] ?? "").replace(/^["']|["']$/g, ""))).replace(/[\s\u0000-\u001f\u007f]+/g, "");
      if (attr.startsWith("on")) return { problem: `it has an event handler (${a[1]})` };
      if (attr.includes("href")) return { problem: "it has a link (href)" };
      if (attr === "style") return { problem: "it has a style attribute; use presentation attributes (fill, stroke) instead" };
      if (/url\((?!["']?#)/i.test(value) || /[a-z]+script:|data:/i.test(value)) return { problem: `its ${a[1]} points outside the file` };
      if (name === "svg" && attr === "xmlns" && value === SVG_NS) ns = true;
    }
  }
  if (/</.test(body.replace(TAG, ""))) return { problem: "it isn't well-formed SVG" };
  if (first !== "svg") return { problem: "it doesn't start with an <svg> element" };
  if (!ns) return { problem: `its <svg> has no xmlns="${SVG_NS}"` };
  return { dataUrl: `data:image/svg+xml;base64,${Buffer.from(text.trim(), "utf8").toString("base64")}` };
}
