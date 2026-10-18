// uncutUI Add to chat (the launch film: right-click a clip, Add to chat, the clip's chip in the
// composer, a one-line request about it): the menu part and the composer's and message's chips,
// drawn in the export's rasteriser. The graphic paints green when
// - the menu part has "Add to chat" (⌘L) highlighted, sits where it's mounted, and active moves the highlight;
// - a composer with chips draws "@DJI 0063" as the app's chip (its CSS: a tinted background), typed
//   after it by a typing key, and no chip while "@DJI 0063" is only partly typed;
// - a message and the editor stage's composer (nested props) draw the chip too;
// else a colour naming the check that failed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { graphicDocument, graphicInfo, type Project } from "../../packages/core/src/index.ts";
import { readGraphics } from "../../apps/server/src/export/exporter.ts";
import { loadGraphicLibs } from "../../apps/server/src/export/graphicLibs.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { rgbaOf } from "../helpers/image-compare.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : false;
const W = 540;
const H = 675;
const canvas = { width: W, height: H, fps: 60 };

const DOC = `<div id="host" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></div>
<div id="menu" style="position:absolute;left:40px;top:30px"></div>
<div id="msg" style="position:absolute;left:0;top:0;width:400px"></div>
<div id="stage" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:hidden"></div>
<div id="out" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;z-index:9"></div>
<script src="uncut:lib/ui.js"></script>
<script>
const REQ = "@DJI 0063 make this one slow motion";
window.render = (t) => {
  let fail = 0;
  const check = (ok, code) => { if (!ok) fail = fail || code; };
  const menuHost = document.getElementById("menu");
  let menu = uncutUI.mount(menuHost, "menu");
  const add = uncutUI.find(menu, "addToChat");
  check(add && add.classList.contains("active") && /Add to chat/.test(add.textContent) && /⌘L/.test(add.textContent), 1);
  const box = menu.getBoundingClientRect();
  check(Math.abs(box.left - 40) < 1 && Math.abs(box.top - 30) < 1 && box.height > 200, 2);
  menu = uncutUI.mount(menuHost, "menu", { active: "split" });
  check(!uncutUI.find(menu, "addToChat").classList.contains("active") && menu.querySelector('[data-testid="menu-split"]').classList.contains("active"), 3);
  menuHost.replaceChildren();

  const host = document.getElementById("host");
  const keys = [{ at: -1, piece: "composer", width: 460, props: { text: REQ, chips: ["DJI 0063"], caret: true }, typing: { at: 0, dur: 1, from: 10 } }];
  for (const f of [0, 20, 61]) {
    const b = uncutUI.sequence(host, f / 60, keys);
    const chip = b.el.querySelector(".composer-hl mark.chip");
    check(chip && chip.textContent === "@DJI 0063", 4);
    check(chip && getComputedStyle(chip).backgroundColor !== "rgba(0, 0, 0, 0)", 5);
    const typed = (b.el.querySelector(".composer-hl").textContent || "").replace(/\\u200b/g, "");
    check(f < 61 ? typed.length < REQ.length && typed.startsWith("@DJI 0063 ") : typed === REQ, 6);
  }
  const half = uncutUI.piece(host, "composer", { width: 460, props: { text: "@DJI 00", chips: ["DJI 0063"] } });
  check(!half.querySelector("mark.chip"), 7);
  host.replaceChildren();

  const msgHost = document.getElementById("msg");
  const msg = uncutUI.mount(msgHost, "message", { text: REQ, chips: ["DJI 0063"] });
  check(msg.querySelector("mark.chip") && msg.textContent === REQ, 8);
  msgHost.replaceChildren();

  const stage = document.getElementById("stage");
  const ed = uncutUI.mount(stage, "editor", { scale: 0.25, composer: { text: "@DJI 0063 ", chips: ["DJI 0063"] } });
  check(ed.querySelector(".composer .composer-hl mark.chip"), 9);
  stage.replaceChildren();

  document.getElementById("out").style.background = fail ? "rgb(" + (20 * fail) + ", 0, 0)" : "#0f0";
};
</script>`;

let root: string;
let raster: Rasterizer;
let doc: string;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-ui-chat-")));
  const dir = join(root, "Chat.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "chat.html"), DOC);
  const project = { canvas, tracks: [{ items: [{ type: "graphic", src: "graphics/chat.html", duration: 60 }] }] } as unknown as Project;
  const graphics = await readGraphics(dir, project, await loadGraphicLibs(resolve("assets/graphic-libs")));
  doc = graphicDocument(graphics.get("graphics/chat.html")!, canvas);
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command);
});

after(async () => {
  if (skip) return;
  await raster?.close();
  rmSync(root, { recursive: true, force: true });
});

test("uncutUI Add to chat: the clip menu with Add to chat highlighted, and the clip's chip in the composer, a message and the stage", { skip, timeout: 120000 }, async () => {
  const out = join(root, "f.png");
  await raster.render({ kind: "graphic", width: W, height: H, doc, t: 0, info: graphicInfo({ duration: 60, props: {} }, canvas, 60), out, name: "graphics/chat.html" });
  const px = rgbaOf(out);
  const [r, g] = [px[0]!, px[1]!];
  const why = ["", "Add to chat isn't highlighted with ⌘L", "the menu isn't where it's mounted", "active didn't move the highlight", "no chip in the typed composer", "the chip has no CSS", "the typed text is off the schedule", "a partly typed @label became a chip", "no chip in the message", "no chip in the stage's composer"][Math.round(r / 20)] ?? `pixel ${r},${g}`;
  assert.ok(g > 200 && r < 30, why);
});
