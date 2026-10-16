// Issue #63 (D234) on the packaged app, run invisibly: the redesigned Generate tab. The Picture /
// Video / Sound switch shows each type's own models and options; the coming-soon models (Grok
// Imagine, Seedance, Higgsfield, ...) show their real options, all disabled, and can't be run; no
// "free" wording anywhere; and a generation (Claude's SVG, here the scripted stand-in) lands in
// Media, marked Generated. No provider is called: every keyed base URL points at a closed port.
// Screenshots: test-output/issue63-picture.png, issue63-video-soon.png, issue63-sound.png, issue63-media.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const text = (page: Page, selector: string) => page.$eval(selector, (el) => ((el as HTMLElement).innerText ?? "").trim());
const FREE = /\bfree\b/i;

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue63-")));
  mkdirSync(join(root, "projects"));
  writeFileSync(join(root, "prompts.jsonl"), "");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issue #63: the type picker, coming-soon models disabled, no free wording, a generation lands in Media", { skip, timeout: 180000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_PLUGINS_DIR: join(root, "no-user-plugins"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_SVG_SLEEP: "300",
      UNCUT_OPENAI_BASE: "http://127.0.0.1:9",
      UNCUT_GOOGLE_BASE: "http://127.0.0.1:9",
      UNCUT_ELEVENLABS_BASE: "http://127.0.0.1:9",
    },
  });
  apps.add(app);
  const { page } = app;
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor(page, "[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor(page, "[data-testid=editor]");
    await page.click("[data-testid=rail-generate]");
    await waitFor(page, "[data-testid=generator][data-id='generate.gpt-image']");

    // The picker: three types, at the top, each with its own models, prompt hint and button.
    const types = await page.$$eval("[data-testid=generate-types] [role=radio]", (els) => els.map((e) => (e as HTMLElement).innerText.trim()));
    assert.deepEqual(types, ["Picture", "Video", "Sound"]);
    assert.equal(await page.$eval("[data-testid=generate-library] .gen-form > *", (e) => (e as HTMLElement).dataset.testid), "generate-types", "the picker comes first");
    const ui = () =>
      page.evaluate(() => ({
        type: document.querySelector<HTMLElement>("[data-testid=generate-library] .gen-form")!.dataset.type,
        checked: document.querySelector<HTMLElement>("[data-testid=generate-types] [aria-checked=true]")!.innerText.trim(),
        models: [...document.querySelectorAll<HTMLElement>("[data-testid=generator]")].map((e) => ({ id: e.dataset.id!, soon: e.dataset.soon === "true", brand: e.querySelector<HTMLElement>("[data-testid=generator-mark]")?.dataset.brand })),
        placeholder: document.querySelector<HTMLTextAreaElement>("[data-testid=generate-prompt]")!.placeholder,
        button: document.querySelector<HTMLElement>("[data-testid=generate-run]")!.innerText.trim(),
        all: document.querySelector<HTMLElement>("[data-testid=generate-library]")!.innerText,
      }));
    const seen: Record<string, Awaited<ReturnType<typeof ui>>> = {};
    for (const [id, label] of [["image", "Picture"], ["video", "Video"], ["audio", "Sound"]] as const) {
      await page.click(`[data-testid=generate-type-${id}]`);
      await page.waitForFunction((t: string) => document.querySelector<HTMLElement>("[data-testid=generate-library] .gen-form")!.dataset.type === t, {}, id);
      const now = await ui();
      assert.equal(now.checked, label);
      assert.ok(now.models.every((m) => m.brand), `every model has a mark (${id})`);
      seen[id] = now;
      await page.screenshot({ path: `test-output/issue63-${id === "image" ? "picture" : id === "audio" ? "sound" : "video"}.png` });
    }
    const ids = (t: string, soon: boolean) => seen[t]!.models.filter((m) => m.soon === soon).map((m) => m.id);
    assert.deepEqual(ids("image", false), ["generate.svg", "title-card", "generate.gpt-image"]);
    assert.deepEqual(ids("video", false), ["generate.svg", "generate.veo"]);
    assert.deepEqual(ids("audio", false), ["generate.sound"]);
    for (const id of ["soon.grok-video", "soon.seedance", "soon.higgsfield"]) assert.ok(ids("video", true).includes(id), `${id} in Video`);
    assert.ok(ids("image", true).length >= 2 && ids("audio", true).length >= 2, "several coming-soon models for Picture and Sound too");
    assert.ok(!ids("image", true).some((id) => ids("video", true).includes(id)), "each type its own list");
    assert.notEqual(seen.image!.placeholder, seen.video!.placeholder);
    assert.deepEqual([seen.image!.button, seen.video!.button, seen.audio!.button].map((b) => b.replace(/\s*⌘↩$/, "")), ["Generate picture", "Generate video", "Generate sound"]);
    const brand = (id: string) => seen.video!.models.find((m) => m.id === id)!.brand;
    assert.deepEqual([brand("generate.svg"), brand("generate.veo"), brand("soon.grok-video"), brand("soon.seedance"), brand("soon.higgsfield")], ["claude", "google", "xai", "bytedance", "higgsfield"]);

    // Coming soon: Grok Imagine's real options show, every one disabled, and Generate can't run it.
    await page.click("[data-testid=generate-type-video]");
    await waitFor(page, "[data-testid=generator][data-id='soon.grok-video']");
    assert.ok(await page.$("[data-testid=generator][data-id='soon.grok-video'] [data-testid=generator-mark] svg"), "xAI's mark is an SVG");
    assert.match(await text(page, "[data-testid=generator][data-id='soon.higgsfield'] [data-testid=generator-mark]"), /^H$/, "Higgsfield: a monogram");
    await page.click("[data-testid=generator][data-id='soon.grok-video']");
    await waitFor(page, "[data-testid=generate-options][data-model='soon.grok-video'] [data-testid=generate-option]");
    await page.type("[data-testid=generate-prompt]", "a drone over a lake at dawn");
    const grok = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>("[data-testid=generator][data-id='soon.grok-video']")!;
      const options = document.querySelector<HTMLElement>("[data-testid=generate-options]")!;
      return {
        disabled: row.getAttribute("aria-disabled"),
        tag: row.closest("[data-testid=generators]")!.querySelector<HTMLElement>(".gen-group-label")?.innerText.trim(),
        lab: row.querySelector<HTMLElement>("[data-testid=generator-soon]")?.innerText.trim(),
        labels: [...options.querySelectorAll<HTMLElement>("[data-testid=generate-option] .k")].map((k) => k.innerText.trim()),
        text: options.innerText,
        controls: [...options.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")].map((c) => c.disabled),
        run: document.querySelector<HTMLButtonElement>("[data-testid=generate-run]")!.disabled,
        estimate: document.querySelector<HTMLElement>("[data-testid=generate-estimate]")!.innerText.trim(),
      };
    });
    assert.equal(grok.disabled, "true");
    assert.equal(grok.tag, "Coming soon");
    assert.equal(grok.lab, "xAI");
    assert.deepEqual(grok.labels, ["Frames", "Length", "Aspect", "Resolution"]);
    assert.match(grok.text, /First frame[\s\S]*Last frame/);
    assert.ok(grok.controls.length >= 8 && grok.controls.every(Boolean), `every option disabled (${grok.controls})`);
    assert.equal(grok.run, true, "Generate is disabled for a coming-soon model");
    assert.equal(grok.estimate, "Grok Imagine is coming soon");
    await page.screenshot({ path: "test-output/issue63-video-soon.png" });
    // Every coming-soon model, in every type: disabled options, Generate off.
    for (const t of ["image", "video", "audio"]) {
      await page.click(`[data-testid=generate-type-${t}]`);
      for (const id of ids(t, true)) {
        await page.click(`[data-testid=generator][data-id='${id}']`);
        await page.waitForFunction((m: string) => document.querySelector<HTMLElement>("[data-testid=generate-options]")?.dataset.model === m, {}, id);
        const state = await page.evaluate(() => ({
          run: document.querySelector<HTMLButtonElement>("[data-testid=generate-run]")!.disabled,
          controls: [...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("[data-testid=generate-options] button, [data-testid=generate-options] input")].map((c) => c.disabled),
          all: document.querySelector<HTMLElement>("[data-testid=generate-library]")!.innerText,
        }));
        assert.equal(state.run, true, `${id}: Generate disabled`);
        assert.ok(state.controls.length > 0 && state.controls.every(Boolean), `${id}: options shown and disabled`);
        assert.ok(!FREE.test(state.all), `${id}: no "free" wording`);
      }
    }

    // No "free" wording: the subscription is used, never "free".
    for (const t of ["image", "video", "audio"]) assert.ok(!FREE.test(seen[t]!.all), `no "free" in ${t}: ${seen[t]!.all.match(/.{0,30}\bfree\b.{0,30}/i)?.[0]}`);
    await page.click("[data-testid=generate-type-image]");
    await page.click("[data-testid=generator][data-id='generate.svg']");
    assert.equal(await text(page, "[data-testid=generate-estimate]"), "Uses your Claude subscription");
    assert.ok(!/[·•∙⋅*]/.test(await text(page, "[data-testid=generate-library]")), "no dots or stars between words");

    // A (fake) generation lands in Media, marked Generated; the tab has no results list of its own.
    await page.$eval("[data-testid=generate-prompt]", (el) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.type("[data-testid=generate-prompt]", "A red kite on a pale sky");
    await page.click("[data-testid=generate-run]");
    await waitFor(page, "[data-testid=generate-done]", 60000);
    assert.ok(!(await page.$("[data-testid=generate-library] [data-testid=generated-item]")), "no In this project list in the tab");
    assert.ok(!/In this project/.test(await text(page, "[data-testid=generate-library]")));
    await page.click("[data-testid=rail-media]");
    await waitFor(page, "[data-testid=library] [data-testid=generated-item]");
    const item = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("[data-testid=library] [data-testid=generated-item]")!;
      return { badge: !!el.querySelector("[data-testid=generated-badge]"), prompt: el.title.split("\n")[1], by: el.querySelector<HTMLElement>(".gen-by")!.innerText.trim(), section: document.querySelector<HTMLElement>("[data-testid=library] [data-testid=generated] .lib-label")!.innerText.trim() };
    });
    assert.deepEqual(item, { badge: true, prompt: "A red kite on a pale sky", by: "Drawn by Claude, Anthropic", section: "Generated" });
    assert.ok(!FREE.test(await text(page, "[data-testid=library]")), "no free wording in Media");
    await page.screenshot({ path: "test-output/issue63-media.png" });
    const dir = join(root, "projects", readdirSync(join(root, "projects")).find((f) => f.endsWith(".uncut"))!);
    let media = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).media;
    for (let i = 0; i < 50 && media.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 200));
      media = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).media;
    }
    assert.equal(media.length, 1);
    assert.equal(media[0].source.module, "generate.svg");

    // Only Claude's stand-in ran; no key was stored.
    const runs = readFileSync(join(root, "prompts.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(runs.filter((r) => r.oneshot).length, 1);
    assert.ok(!existsSync(join(root, "data", "keys.json")));
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: "test-output/issue63-failure.png" }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});
