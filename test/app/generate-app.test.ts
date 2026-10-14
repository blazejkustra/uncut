// Phase 7 chunk B (D99) on the packaged app, run invisibly: the Generate tab. The SVG generator
// (no key: Claude, here the scripted stand-in, writes the picture on the subscription) makes a
// picture with progress, it lands in Media › Generated with its prompt, and "Add at playhead" puts
// it on the timeline. A keyed generator without its key says "Needs your OpenAI key" with a link
// that opens Settings at Keys. No provider is called and no key is stored.
// D145 (the redesign): the prompt first, the type switch (Picture, Video, Sound, Title card) with the
// models for each (price per item, key set or not), a key field right there for a missing key,
// size and length chips, results as a grid.
// Screenshots: test-output/generate-tab.png, generate-video.png, generate-needs-key.png.
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

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-generate-app-")));
  mkdirSync(join(root, "projects"));
  writeFileSync(join(root, "prompts.jsonl"), "");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the Generate tab: an SVG picture into Media › Generated, Add at playhead, and a keyed generator that needs its key", { skip, timeout: 180000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_PLUGINS_DIR: join(root, "no-user-plugins"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_SVG_SLEEP: "800",
      // Nothing may reach a real provider: any call would go to a closed port.
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

    // The Generate tab (D145): the prompt box first, then the type switch, then the models for it.
    await page.click("[data-testid=rail-generate]");
    await waitFor(page, "[data-testid=generator][data-id='generate.gpt-image']");
    const firsts = await page.$$eval("[data-testid=generate-library] .gen-form > *", (els) => els.slice(0, 3).map((e) => (e as HTMLElement).dataset.testid));
    assert.deepEqual(firsts, ["generate-prompt", "generate-types", "generators"]);
    const models = () => page.$$eval("[data-testid=generator]", (els) => els.map((e) => ({ id: (e as HTMLElement).dataset.id, ready: (e as HTMLElement).dataset.ready, text: (e as HTMLElement).innerText })));
    let rows = await models();
    assert.deepEqual(rows.map((r) => [r.id, r.ready]), [["generate.svg", "true"], ["generate.gpt-image", "false"]]);
    assert.match(rows[0]!.text, /Drawn by Claude \(SVG\)\s*On your Claude subscription\s*Free/);
    assert.match(rows[1]!.text, /Needs your OpenAI key\s*About \$0\.05 each/);
    await page.click("[data-testid=generate-type-video]");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=generator]").length === 2 && !!document.querySelector("[data-testid=generator][data-id='generate.veo']"));
    rows = await models();
    assert.deepEqual(rows.map((r) => r.id), ["generate.svg", "generate.veo"]);
    assert.match(rows[0]!.text, /Animation by Claude/);
    assert.match(rows[1]!.text, /Needs your Google key\s*\$0\.40 a second/);
    await page.click("[data-testid=generator][data-id='generate.veo']");
    await waitFor(page, "[data-testid=generate-seconds-8]");
    await page.click("[data-testid=generate-seconds-8]");
    await page.click("[data-testid='generate-size-9:16']");
    assert.match(await text(page, "[data-testid=generate-estimate]"), /About \$3\.20, billed to your Google key/);
    await page.screenshot({ path: "test-output/generate-video.png" });
    await page.click("[data-testid=generate-type-audio]");
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>("[data-testid=generator]")].map((e) => e.dataset.id).join() === "generate.sound");
    await page.click("[data-testid=generate-type-title]");
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>("[data-testid=generator]")].map((e) => e.dataset.id).join() === "generate.svg");
    assert.match(await text(page, "[data-testid=generator]"), /Title card by Claude/);
    await page.click("[data-testid=generate-type-image]");

    // GPT Image without its key: the line with a key field right there, Generate disabled, and the
    // link to Settings › Keys. (No key is typed: none is stored in this test.)
    await page.click("[data-testid=generator][data-id='generate.gpt-image']");
    await waitFor(page, "[data-testid=generate-needs]");
    assert.match(await text(page, "[data-testid=generate-needs]"), /Needs your OpenAI key\./);
    assert.equal(await page.$eval("[data-testid=generate-key-input]", (el) => (el as HTMLInputElement).type), "password");
    assert.equal(await page.$eval("[data-testid=generate-key-save]", (b) => (b as HTMLButtonElement).disabled), true);
    assert.deepEqual(await page.$$eval("[data-testid=generate-sizes] button", (els) => els.map((e) => e.textContent)), ["Landscape", "Square", "Portrait"]);
    await page.type("[data-testid=generate-prompt]", "a phone on a desk");
    assert.equal(await page.$eval("[data-testid=generate-run]", (b) => (b as HTMLButtonElement).disabled), true);
    await page.screenshot({ path: "test-output/generate-needs-key.png" });
    await page.click("[data-testid=generate-open-keys]");
    await waitFor(page, "[data-testid=onboarding] [data-testid=key-openai][data-set=false]");
    assert.ok(await page.$("[data-testid=key-input-openai]"), "a field to paste the key into");
    assert.match(await text(page, "[data-testid=keys]"), /never goes to the agent/);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-testid=onboarding]"), { timeout: 10000 });

    // The SVG generator: a prompt, Generate, progress, then the picture in Media › Generated.
    await page.click("[data-testid=generator][data-id='generate.svg']");
    // Clear the field the way typing would (React reads the input event).
    await page.$eval("[data-testid=generate-prompt]", (el) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.type("[data-testid=generate-prompt]", "A yellow sun over a navy sea");
    assert.match(await text(page, "[data-testid=generate-estimate]"), /Free on your Claude subscription/);
    await page.click("[data-testid=generate-run]");
    await waitFor(page, "[data-testid=generate-progress]", 10000);
    assert.match(await text(page, "[data-testid=generate-progress]"), /Claude is drawing it|Starting/);
    await waitFor(page, "[data-testid=generate-done]", 60000);
    assert.match(await text(page, "[data-testid=generate-done]"), /^Yellow sun over a navy sea is in Media\./);
    await waitFor(page, "[data-testid=generated-item]");
    assert.match(await text(page, "[data-testid=generated-item] [data-testid=generated-prompt]"), /A yellow sun over a navy sea/);
    await page.waitForFunction(() => (document.querySelector<HTMLImageElement>("[data-testid=generated-item] img")?.naturalWidth ?? 0) > 0, { timeout: 10000 });
    assert.ok(!/[·•∙⋅*]/.test(await text(page, "[data-testid=generate-library]")), "no dots or stars between words");

    // Add at playhead: on a new video track above the main one, at the playhead, 5 s.
    assert.equal(await page.$$eval(".gen-grid [data-testid=generated-item]", (els) => els.length), 1, "a grid tile");
    await page.click("[data-testid=generated-item] [data-testid=generated-add]");
    const dir = join(root, "projects", readdirSync(join(root, "projects")).find((f) => f.endsWith(".uncut"))!);
    const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    let project = onDisk();
    for (let i = 0; i < 50 && !project.tracks.some((t: any) => t.items.length); i++) {
      await new Promise((r) => setTimeout(r, 200));
      project = onDisk();
    }
    const media = project.media[0];
    assert.match(media.path, /^media\/generated\/a-yellow-sun-over-a \d{8}-\d{6}\.svg$/);
    assert.equal(media.name, "Yellow sun over a navy sea", "a pleasant display name; the file keeps its unique name");
    assert.deepEqual(media.source, { module: "generate.svg", prompt: "A yellow sun over a navy sea", model: "claude", kind: "image", size: "canvas" });
    const track = project.tracks.find((t: any) => t.items.some((i: any) => i.media === media.id));
    assert.ok(track, "the picture is on the timeline");
    assert.equal(track.kind, "video");
    assert.notEqual(track.role, "main");
    assert.ok(project.tracks.indexOf(track) < project.tracks.findIndex((t: any) => t.role === "main"), "above the main track");
    // The tab after the add: the form, the result under Generated and the clip on the timeline.
    await page.$eval("[data-testid=generate-library]", (el) => el.scrollTo(0, el.scrollHeight));
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: "test-output/generate-tab.png" });
    const item = track.items.find((i: any) => i.media === media.id);
    assert.equal(item.start, 0);
    assert.equal(item.duration, 5 * project.canvas.fps);

    // Claude was asked once, with no tools; no key was stored and nothing else was called.
    const runs = readFileSync(join(root, "prompts.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(runs.filter((r) => r.oneshot).length, 1);
    assert.equal(runs[0].tools, "");
    assert.ok(!existsSync(join(root, "data", "keys.json")));
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: "test-output/generate-failure.png" }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});
