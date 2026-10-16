// Issue #103 (D278): a follow handle's brand mark is locked to its official colour or plain white /
// black. Whatever `color` asks for, no brand mark (or its circle, or the solid pill) takes it; the
// generic glyphs still do.
import { test } from "node:test";
import assert from "node:assert/strict";

import { componentHtml, type Item } from "../../packages/core/src/index.ts";
import { BRAND_ICONS } from "../../packages/core/src/visual/brandIcons.ts";

const target = { canvas: { width: 1920, height: 1080 } };
const draw = (props: Record<string, unknown>) => componentHtml({ id: "e1", type: "component", component: "component.follow", duration: 300, props } as Item, target, 60, { fps: 30 });

test("brand marks keep their own colour, or white / black, whatever colour is asked for", () => {
  for (const [id, b] of Object.entries(BRAND_ICONS)) {
    for (const style of ["pill", "solid", "minimal"]) {
      const out = draw({ handle: "@me", platform: id, style, color: "#123456" });
      assert.ok(!out.includes("#123456"), `${id} ${style}: no custom colour anywhere`);
      const fill = new RegExp(`<path fill="([^"]+)" d="${b.path.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(out)?.[1];
      assert.ok(fill, `${id} ${style}: draws its mark`);
      assert.ok([b.hex, "#FFFFFF", "#000000"].includes(fill!), `${id} ${style}: mark in ${fill}`);
      if (style !== "solid") assert.ok(out.includes(`background:${b.hex}`), `${id} ${style}: circle in ${b.hex}`);
    }
  }
  assert.ok(!draw({ handle: "@me", platform: "linkedin", color: "#123456" }).includes("#123456"), "LinkedIn's blue is locked too");
});

test("the generic glyphs still take the colour", () => {
  for (const platform of ["web", "mail", "video", "podcast"]) assert.ok(draw({ handle: "@me", platform, color: "#123456" }).includes("#123456"), platform);
});
