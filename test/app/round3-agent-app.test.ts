// User feedback round 3, agent (planning/FEEDBACK.md U1–U6, D181–D185), on the packaged app run
// invisibly and muted, with the stand-in claude:
// - U4: the composer's bottom row: provider (Claude; Codex disabled), a searchable model menu with
//   favourites, effort and access, remembered per project; an attached image shows as a thumbnail
//   and goes with the message (claude gets an image block), then on the turn card.
// - U5: typing @0:01 offers "Moment 0:01"; right-click on the ruler adds a moment, and with In/Out set
//   the range, as timecode chips.
// - U1/U2: no empty thinking rows; the now line says the call streaming in with its target ("Writing
//   graphic s3-enter.html"); a failed call is a ✕ step with its reason.
// - U6: three scene edits in one turn land one by one, each glowing on the timeline as it lands.
// - U4 access: "Ask first" puts a removal on a card; Allow applies it.
// Screenshots: test-output/round3-agent-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test image") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const out = (name: string) => resolve("test-output", `round3-agent-${name}.png`);
const plan = () => join(root, "plan.json");
const turns: Array<unknown> = [];
const nextTurn = (steps: Array<unknown>) => {
  turns.push(steps);
  writeFileSync(plan(), JSON.stringify(turns));
};
const runs = () =>
  readFileSync(join(root, "prompts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-round3-agent-")));
  mkdirSync(join(root, "projects"));
  writeFileSync(plan(), "[]");
  writeFileSync(join(root, "prompts.jsonl"), "");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=orange:s=96x96", "-frames:v", "1", join(root, "logo.png")]);
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const text = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLElement).innerText.trim());

test("round 3 agent: composer choices and images, moments, live status, failed steps, scene by scene, ask before big changes", { skip, timeout: 300000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan(), FAKE_PROMPT_LOG: join(root, "prompts.jsonl"), UNCUT_APPROVAL_MS: "60000" },
  });
  apps.add(app);
  const { page } = app;
  const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor("[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor("[data-testid=agent-panel]");

    // ---- U4: provider, model (search, favourite), effort, access ----
    await page.click("[data-testid=agent-provider]");
    await waitFor("[data-testid=agent-provider-menu]");
    assert.equal(await page.$eval("[data-testid=agent-provider-codex]", (el) => (el as HTMLButtonElement).disabled), true, "Codex is there, not yet usable");
    await page.click("[data-testid=agent-provider]");
    await page.click("[data-testid=agent-model]");
    await waitFor("[data-testid=agent-model-menu]");
    assert.deepEqual(await page.$$eval("[data-testid=agent-model-option]", (els) => els.map((e) => (e as HTMLElement).dataset.model)), ["", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-5-5"]);
    await page.type("[data-testid=agent-model-search]", "son");
    assert.deepEqual(await page.$$eval("[data-testid=agent-model-option]", (els) => els.map((e) => (e as HTMLElement).dataset.model)), ["claude-sonnet-5-5"]);
    await page.click("[data-testid=agent-model-option] [data-testid=agent-model-star]");
    await page.click("[data-testid=agent-model-search]", { clickCount: 3 });
    await page.keyboard.press("Backspace");
    // The favourite comes first.
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=agent-model-option]").length === 5);
    assert.equal(await page.$eval("[data-testid=agent-model-option]", (el) => (el as HTMLElement).dataset.model), "claude-sonnet-5-5");
    await page.screenshot({ path: out("model-menu") });
    await page.click("[data-testid=agent-model-option][data-model='claude-sonnet-5-5']");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-model]")!.dataset.model === "claude-sonnet-5-5");
    await page.click("[data-testid=agent-effort]");
    await page.click("[data-testid=agent-effort-option][data-effort=high]");
    await page.click("[data-testid=agent-access]");
    await waitFor("[data-testid=agent-access-menu]");
    await page.screenshot({ path: out("access-menu") });
    await page.click("[data-testid=agent-access-option][data-access=ask]");
    const label = (sel: string) => page.$eval(`${sel} .choice-label`, (el) => el.textContent);
    assert.equal(await label("[data-testid=agent-model]"), "Sonnet 5.5");
    assert.equal(await label("[data-testid=agent-effort]"), "High");
    assert.equal(await label("[data-testid=agent-access]"), "Ask first");

    // ---- U4: an attached image ----
    const file = await page.$("[data-testid=agent-attach-input]");
    await (file as unknown as { uploadFile: (p: string) => Promise<void> }).uploadFile(join(root, "logo.png"));
    await waitFor("[data-testid=agent-attachment] img");

    // ---- U5: @0:01 offers the moment ----
    await page.click("[data-testid=agent-input]");
    await page.keyboard.type("build three scenes from @0:01");
    await waitFor("[data-testid=mention-option][data-kind=moment]");
    assert.match(await text(page, "[data-testid=mention-option][data-kind=moment]"), /^0:01\s*Moment, frame 30$/);
    await page.screenshot({ path: out("composer") });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[data-testid=agent-input]")!.value === "build three scenes from @0:01 ");

    // ---- U1/U2/U6: one turn: empty thinking, a missing tool, a graphic streaming in, three scenes ----
    const html = `<style>html,body{margin:0}</style><div id="a"></div><script>window.render=function(t){document.getElementById("a").textContent=String(t)}</script><!--${"x".repeat(3000)}-->`;
    const scene = (n: number) => [
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: `Scene ${n}`, ops: [{ op: "insert_item", track: "text", item: { id: `scene-${n}`, type: "text", start: (n - 1) * 45, duration: 45, text: `Scene ${n}` } }] } },
      { tool: "ui_show", args: { frame: (n - 1) * 45 } },
      { sleep: 1200 },
    ];
    nextTurn([{ think: "" }, { missing: "graphic_write", args: { name: "s1-hook.html", html: "<div></div>" } }, { tool: "graphic_write", args: { name: "s3-enter.html", html }, slowInput: 900 }, ...scene(1), ...scene(2), ...scene(3)]);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /Writing graphic s3-enter\.html/.test(document.querySelector("[data-testid=agent-now]")?.textContent ?? ""), { timeout: 15000 });
    assert.equal(await page.$$eval("[data-testid=agent-thinking]", (els) => els.length), 0, "no empty thinking row");
    await page.screenshot({ path: out("now-line") });
    // Each scene glows as it lands, one after another.
    for (const n of [1, 2, 3]) {
      await page.waitForFunction((id) => document.querySelector(`[data-testid=timeline-item][data-item='${id}']`)?.classList.contains("agent-flash"), { timeout: 15000 }, `scene-${n}`);
      const count = await page.$$eval("[data-testid=timeline-item]", (els) => els.length);
      assert.equal(count, n, `scene ${n} landed alone`);
      if (n === 2) await page.screenshot({ path: out("flash") });
    }
    await page.waitForFunction(() => document.querySelector("[data-testid=agent-turn]")?.getAttribute("data-status") === "done", { timeout: 30000 });
    // The failed call: ✕ with claude's reason, in the opened work log.
    await waitFor("[data-testid=agent-step-error]");
    assert.equal(await text(page, "[data-testid=agent-step-error]"), "Error: No such tool available: graphic_write");
    assert.equal(await page.$$eval("[data-testid=agent-step][data-status=error]", (els) => els.length), 1);
    assert.equal(await page.$$eval("[data-testid=agent-thinking]", (els) => els.length), 0);
    await waitFor("[data-testid=agent-turn-image]");
    assert.match(await text(page, ".turn-status"), /^Sonnet 5\.5, \d+ s$/);
    await page.screenshot({ path: out("failed-step") });
    const first = runs()[0];
    const flag = (f: string) => (first.argv.includes(f) ? first.argv[first.argv.indexOf(f) + 1] : undefined);
    assert.equal(flag("--model"), "claude-sonnet-5-5");
    assert.equal(flag("--effort"), "high");
    assert.equal(flag("--setting-sources"), "");
    assert.equal(flag("--thinking-display"), "summarized");
    assert.equal(first.images.length, 1);
    assert.equal(first.images[0].media_type, "image/png");
    assert.match(first.prompt, /@0:01 = the moment at frame 30 \(1\.00 s\)/);
    assert.match(first.prompt, /Access: Ask first\./);

    // ---- U5: right-click the ruler: a moment, then the In/Out range ----
    const ruler = await page.$eval("[data-testid=ruler]", (el) => el.getBoundingClientRect().toJSON());
    await page.mouse.click(ruler.left + 60, ruler.top + ruler.height / 2, { button: "right" });
    await waitFor("[data-testid=menu-add-moment-to-chat]");
    assert.equal(await page.$("[data-testid=menu-add-range-to-chat]"), null, "no range without In/Out");
    await page.click("[data-testid=menu-add-moment-to-chat]");
    await page.waitForFunction(() => /@\d+:\d\d(\.\d)? $/.test(document.querySelector<HTMLTextAreaElement>("[data-testid=agent-input]")!.value));
    // In and Out on the ruler (I and O with the playhead there).
    await page.mouse.click(ruler.left + 30, ruler.top + ruler.height / 2);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("i");
    await page.mouse.click(ruler.left + 120, ruler.top + ruler.height / 2);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("o");
    await waitFor("[data-testid=marks]");
    await page.mouse.click(ruler.left + 200, ruler.top + ruler.height / 2, { button: "right" });
    await page.click("[data-testid=menu-add-range-to-chat]");
    await page.waitForFunction(() => /@\d+:\d\d(\.\d)?–\d+:\d\d(\.\d)? $/.test(document.querySelector<HTMLTextAreaElement>("[data-testid=agent-input]")!.value));
    assert.equal(await page.$$eval(".composer-hl mark.chip", (els) => els.length), 2, "two timecode chips");
    await page.screenshot({ path: out("moments") });

    // ---- U4 access: a removal waits for Allow ----
    await page.click("[data-testid=agent-input]");
    await page.keyboard.down("Meta");
    await page.keyboard.press("a");
    await page.keyboard.up("Meta");
    await page.keyboard.type("remove scene 1");
    nextTurn([{ tool: "project_read" }, { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Remove scene 1", ops: [{ op: "delete_item", item: "scene-1" }] } }]);
    await page.keyboard.press("Enter");
    await waitFor("[data-testid=agent-approval][data-kind=edit]");
    assert.equal(await text(page, "[data-testid=agent-approval] .approval-text"), 'Apply "Remove scene 1" (1 change)?');
    assert.match(await text(page, "[data-testid=agent-approval-lines]"), /Scene 1/);
    await page.screenshot({ path: out("ask") });
    await page.click("[data-testid=agent-allow]");
    await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=agent-turn]")].at(-1)?.getAttribute("data-status") === "done", { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 2);

    // The choices stay with the project.
    await page.reload();
    await waitFor("[data-testid=agent-model]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-model]")?.dataset.model === "claude-sonnet-5-5");
    assert.equal(await page.$eval("[data-testid=agent-access]", (el) => (el as HTMLElement).dataset.access), "ask");
    assert.equal(await page.$eval("[data-testid=agent-effort]", (el) => (el as HTMLElement).dataset.effort), "high");

    // The composer's bottom row is one row at every panel width: labels give way to icons (with
    // tooltips) as it narrows, nothing wraps or is cut off.
    for (const [name, side] of [["default", undefined], ["wide", 520], ["min", 240]] as const) {
      await page.evaluate((w) => {
        if (w === undefined) localStorage.removeItem("uncut.layout");
        else localStorage.setItem("uncut.layout", JSON.stringify({ side: w }));
      }, side);
      await page.reload();
      await waitFor("[data-testid=agent-model]");
      const row = await page.evaluate(() => {
        const foot = document.querySelector(".composer-foot")!.getBoundingClientRect();
        const buttons = [...document.querySelectorAll(".composer-foot button")].map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0);
        const cut = [...document.querySelectorAll(".composer-choices .choice")].some((b) => b.scrollWidth > b.clientWidth + 1 && !b.classList.contains("model"));
        return { width: foot.width, spread: Math.max(...buttons.map((r) => r.top + r.height / 2)) - Math.min(...buttons.map((r) => r.top + r.height / 2)), right: Math.max(...buttons.map((r) => r.right)), footRight: foot.right, cut, titles: [...document.querySelectorAll(".composer-choices .choice")].map((b) => (b as HTMLElement).title) };
      });
      assert.ok(row.spread <= 3, `${name}: one row (${row.width} px wide, centres ${row.spread} px apart)`);
      assert.ok(row.right <= row.footRight + 0.5, `${name}: nothing past the right edge`);
      assert.ok(!row.cut, `${name}: no clipped label`);
      assert.ok(row.titles.every(Boolean), "every choice has a tooltip");
      await page.screenshot({ path: out(`footer-${name}`) });
    }
  } catch (error) {
    await page.screenshot({ path: out("failure") }).catch(() => {});
    throw error;
  }
});
