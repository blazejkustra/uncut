// Issues #25, #27, #22 (D201–D203) on the packaged app run invisibly and muted, with the stand-in
// claude and a home folder of the test's own:
// - #25: a turn is a stream of messages in order (thinking, replies, folded tool calls, the import
//   as one "Imported 40 files" row that opens to thumbnails, an edit where it happened, the question
//   card), with a compact footer (3 edits, Undo turn); scrolled up, the thread keeps its place while
//   the agent goes on, and the question is answered from there;
// - #27: playing while the agent edits and calls ui_show: playback goes on and the playhead isn't
//   moved; a pill "Agent changed 0:12–0:18" jumps there; an idle user's playhead stays too (D235);
// - #22: pasting Finder's copied folder (its icon File, the clipboard's path) and files from disk
//   (SVG, video, font: path chips; a PNG: attached), no "isn't a PNG" error.
// Screenshots: test-output/issue25-*.png, issue27-*.png, issue22-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

/** A 32×20 PNG of one colour. */
function png(r: number, g: number, b: number): Buffer {
  const w = 32;
  const h = 20;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

let root = "";
let home = "";
const apps = new Set<LaunchedApp>();
const shot = (name: string) => resolve("test-output", `${name}.png`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue22-25-27-")));
  home = join(root, "home");
  mkdirSync(join(home, "Projects"), { recursive: true });
  const stills = join(home, "Documents", "stills");
  mkdirSync(stills, { recursive: true });
  for (let i = 0; i < 40; i++) writeFileSync(join(stills, `still-${String(i + 1).padStart(2, "0")}.png`), png((i * 53) % 256, (i * 97) % 256, (i * 31 + 80) % 256));
  // #22: a Finder folder and files to paste.
  mkdirSync(join(home, "Downloads", "argent-marketing"), { recursive: true });
  writeFileSync(join(home, "Downloads", "argent-marketing", "a.txt"), "x");
  writeFileSync(join(home, "Downloads", "logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#f5a623"/></svg>`);
  writeFileSync(join(home, "Downloads", "demo take.mp4"), "x");
  writeFileSync(join(home, "Downloads", "KitMono.woff2"), readFileSync(resolve("assets/fonts/DMMono-Regular.woff2")));
  writeFileSync(join(home, "Downloads", "shot.png"), png(200, 40, 40));
  writeFileSync(join(root, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const text = (id: string, start: number, duration: number, words: string) => ({ id, type: "text", start, duration, text: words, transform: { x: 154, y: 410 }, style: { preset: "text.title", size: 120, weight: 700 } });

test("issues 25, 27, 22: the turn as a stream, playback the agent doesn't interrupt, pasted folders as paths", { skip, timeout: 300000 }, async () => {
  const stills = join(home, "Documents", "stills");
  const gate = join(root, "gate.json");
  const plan = join(root, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify([
      // #25: thinking, a reply, a 40-file import, a read, an edit, a question, then more words.
      [
        { think: "The stills come first, then a title over them." },
        { text: "I'll bring the stills in and start with the title." },
        { tool: "media_import", args: { path: stills } },
        { tool: "project_read" },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Scene 1: the title", ops: [{ op: "insert_item", track: "text", item: text("title-1", 0, 300, "Stills") }] } },
        { tool: "ask_user", args: { question: "Which ending should it have?", options: [{ label: "A logo", detail: "The mark on black" }, { label: "A line", detail: "Thanks for watching" }] } },
        { await: gate },
        { text: "Going with the line." },
        { tool: "project_read" },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Scene 2: the end line", ops: [{ op: "insert_item", track: "text", item: text("end-1", 300, 150, "Thanks for watching") }] } },
        { text: "The title and the end line are in." },
      ],
      // #27: edits and a ui_show while the user plays.
      [
        { sleep: 1200 },
        { tool: "project_read" },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Scene 3: a middle line", ops: [{ op: "insert_item", track: "text", item: text("mid-1", 450, 90, "In between") }] } },
        { tool: "ui_show", args: { frame: 450, select: ["mid-1"] } },
        { sleep: 800 },
        { text: "Added a middle line at 0:15." },
      ],
      // #27: the user idle: still a pill (D235: the agent never steers).
      [{ tool: "ui_show", args: { frame: 300, select: ["end-1"] } }, { text: "Here's the end line." }],
    ]),
  );
  const app = await launchApp({
    command: APP,
    env: { HOME: home, UNCUT_FONT_DIRS: "", UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(home, "Projects")]), UNCUT_TEST_CLIPBOARD: JSON.stringify([join(home, "Downloads", "argent-marketing")]), UNCUT_CLAUDE: join(root, "claude"), FAKE_PLAN: plan, UNCUT_APPROVAL_MS: "60000" },
  });
  apps.add(app);
  const { page } = app;
  const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
  const frame = () => page.$eval("[data-testid=preview-frame]", (el) => Number((el as HTMLElement).dataset.frame));
  const playing = () => page.$eval("[data-testid=play]", (el) => (el.getAttribute("aria-label") ?? "").startsWith("Pause"));
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor("[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor("[data-testid=agent-panel]");

    // ---- #25 ----
    await page.click("[data-testid=agent-input]");
    await page.keyboard.type("Make a short from the stills in ~/Documents/stills");
    await page.keyboard.press("Enter");
    await waitFor("[data-testid=agent-question]", 60000);
    // The stream so far, in order: thinking, the reply, the import row, the read, the edit, the question.
    const order = await page.$$eval("[data-testid=agent-stream] > *", (els) => els.map((el) => (el as HTMLElement).dataset.testid ?? el.className));
    assert.deepEqual(order.slice(0, 7), ["agent-thinking", "agent-reply", "agent-import", "worklog", "agent-edit-row", "worklog", "agent-question"], order.join(", "));
    assert.equal(await page.$eval("[data-testid=agent-import] [data-testid=agent-step]", (el) => (el as HTMLElement).innerText.trim()), "Imported 40 files");
    assert.equal(await page.$("[data-testid=agent-import-grid]"), null, "the files are folded into one row");
    assert.equal(await page.$eval("[data-testid=agent-edit-row] [data-testid=agent-step]", (el) => (el as HTMLElement).innerText.trim()), "Scene 1: the title");
    assert.equal((await page.$$("[data-testid=agent-stream] .turn-edit-line")).length, 0, "no edit list at the bottom of the stream");
    await page.screenshot({ path: shot("issue25-question") });
    // Opened: the 40 files as thumbnails.
    await page.click("[data-testid=agent-import] [data-testid=agent-step]");
    await waitFor("[data-testid=agent-import-grid]");
    assert.equal((await page.$$("[data-testid=agent-import-thumb]")).length, 40);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("[data-testid=agent-import-thumb] img")].filter((i) => i.complete && i.naturalWidth > 0).length >= 6, { timeout: 20000 });
    assert.equal((await page.$$("[data-testid=agent-import-thumb] img")).length, 40, "each file has its picture (loaded as it scrolls into view)");
    await page.$eval("[data-testid=agent-import]", (el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: shot("issue25-imports") });
    await page.click("[data-testid=agent-import] [data-testid=agent-step]");

    // Scrolled up while the agent goes on: the thread keeps its place; the question is answered from there.
    await page.$eval("[data-testid=agent-thread]", (el) => (el.scrollTop = 0));
    await waitFor("[data-testid=agent-latest]");
    // Clicked in place (a puppeteer click would scroll the card into view first).
    await page.$$eval("[data-testid=agent-question-option]", (els) => (els[1] as HTMLElement).click());
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("[data-testid=agent-question-send]")!.disabled);
    await page.$eval("[data-testid=agent-question-send]", (el) => (el as HTMLElement).click());
    writeFileSync(gate, "[]");
    await page.waitForFunction(() => document.querySelector("[data-testid=agent-turn]")?.getAttribute("data-status") === "done", { timeout: 60000 });
    assert.ok((await page.$eval("[data-testid=agent-thread]", (el) => el.scrollTop)) < 40, "the thread wasn't pulled down while the user read");
    await page.click("[data-testid=agent-latest]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=agent-latest]"));
    // Done: the later reply and edit come after the answered question; the footer is compact.
    const done = await page.$$eval("[data-testid=agent-stream] > *", (els) => els.map((el) => (el as HTMLElement).dataset.testid ?? el.className));
    assert.deepEqual(done, ["agent-thinking", "agent-reply", "agent-import", "worklog", "agent-edit-row", "worklog", "agent-card", "agent-reply", "worklog", "agent-edit-row", "agent-reply", "agent-reply"], "the stand-in's closing line comes last");
    assert.equal(await page.$eval("[data-testid=agent-edits-toggle]", (el) => (el as HTMLElement).innerText.trim()), "3 edits", "the import and two scenes");
    assert.ok(await page.$("[data-testid=agent-undo-turn]"), "Undo turn is in the footer");
    assert.match(await page.$eval(".turn-status", (el) => (el as HTMLElement).innerText), /^Claude Code, \d+ s$/);
    await (await page.$$("[data-testid=agent-edit-row] [data-testid=agent-step]")).at(-1)!.click();
    await waitFor("[data-testid=agent-edit-lines]");
    await page.screenshot({ path: shot("issue25-stream") });
    await page.click("[data-testid=agent-edits-toggle]");
    await waitFor(".turn-edits-pop");
    await page.screenshot({ path: shot("issue25-footer-edits") });
    await page.click(".turn-status");
    await page.waitForFunction(() => !document.querySelector(".turn-edits-pop"));

    // ---- #27 ----
    // D235: no Follow agent toggle any more.
    assert.equal(await page.$("[data-testid=agent-follow]"), null);
    await page.click("[data-testid=agent-input]");
    await page.keyboard.type("Add a middle line");
    await page.keyboard.press("Enter");
    await page.click("[data-testid=play]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=play]")!.getAttribute("aria-label")!.startsWith("Pause"));
    const frames: Array<number> = [];
    let turnDone = false;
    for (let i = 0; i < 40 && !(turnDone && frames.length > 4); i++) {
      frames.push(await frame());
      assert.ok(await playing(), `still playing at sample ${i} (frames ${frames.join(", ")})`);
      turnDone = await page.$$eval("[data-testid=agent-turn]", (els) => els[1]?.getAttribute("data-status") === "done");
      await sleep(200);
    }
    assert.ok(turnDone, "the agent's turn ended while playing");
    for (let i = 1; i < frames.length; i++) assert.ok(frames[i]! >= frames[i - 1]!, `the playhead only moved forward: ${frames.join(", ")}`);
    assert.ok(frames.every((f) => f < 450), `the playhead never jumped to the agent's 450: ${frames.join(", ")}`);
    assert.equal(await page.$('[data-testid=timeline-item][data-item="mid-1"].selected'), null, "nothing selected under the user");
    await waitFor("[data-testid=agent-change]");
    assert.equal(await page.$eval("[data-testid=agent-change-jump]", (el) => (el as HTMLElement).innerText.trim()), "Agent changed 0:15–0:18");
    await page.screenshot({ path: shot("issue27-pill") });
    // The pill jumps there; playback carries on from it.
    await page.click("[data-testid=agent-change-jump]");
    await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) >= 450, { timeout: 5000 });
    assert.ok(await playing(), "still playing after the jump");
    assert.ok(await page.$('[data-testid=timeline-item][data-item="mid-1"].selected'), "the agent's item is selected");
    assert.equal(await page.$("[data-testid=agent-change]"), null);
    await page.click("[data-testid=play]");

    // The user idle (D235): a ui_show is a pill too, the playhead stays.
    await sleep(3200);
    const before = await frame();
    await page.click("[data-testid=agent-input]");
    await page.keyboard.type("Show me the end line");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=agent-turn]")[2]?.getAttribute("data-status") === "done", { timeout: 30000 });
    await waitFor("[data-testid=agent-change]");
    assert.equal(await frame(), before, "idle: the playhead stays");
    assert.equal(await page.$('[data-testid=timeline-item][data-item="end-1"].selected'), null, "nothing selected");
    await page.screenshot({ path: shot("issue27-idle-pill") });
    await page.click("[data-testid=agent-change-dismiss]");

    // ---- #22 ----
    await page.click("[data-testid=agent-input]");
    await page.keyboard.type("Use these: ");
    // Finder's copy of a folder: the paste carries its icon (a TIFF named after it); the clipboard has its path.
    await page.evaluate(() => {
      const box = document.querySelector<HTMLTextAreaElement>("[data-testid=agent-input]")!;
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([0x4d, 0x4d, 0x00, 0x2a])], "argent-marketing", { type: "image/tiff" }));
      data.setData("text/plain", "argent-marketing");
      box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const folder = join(home, "Downloads", "argent-marketing");
    await page.waitForFunction((p) => document.querySelector<HTMLTextAreaElement>("[data-testid=agent-input]")!.value === `Use these: ${p} `, { timeout: 5000 }, folder);
    // Files from disk (real Files, set through CDP): SVG, video and font as paths, the PNG attached.
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.id = "test-paste-files";
      input.style.display = "none";
      document.body.append(input);
    });
    const picker = (await page.$("#test-paste-files"))!;
    const downloads = join(home, "Downloads");
    await (picker as unknown as { uploadFile: (...p: Array<string>) => Promise<void> }).uploadFile(join(downloads, "logo.svg"), join(downloads, "demo take.mp4"), join(downloads, "KitMono.woff2"), join(downloads, "shot.png"));
    await page.evaluate(() => {
      const box = document.querySelector<HTMLTextAreaElement>("[data-testid=agent-input]")!;
      box.setSelectionRange(box.value.length, box.value.length);
      const data = new DataTransfer();
      for (const f of document.querySelector<HTMLInputElement>("#test-paste-files")!.files!) data.items.add(f);
      box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await waitFor("[data-testid=agent-attachment]");
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[data-testid=agent-input]")!.value.includes("KitMono.woff2"), { timeout: 5000 });
    const value = await page.$eval("[data-testid=agent-input]", (el) => (el as HTMLTextAreaElement).value);
    assert.equal(value, `Use these: ${folder} ${join(downloads, "logo.svg")} ${join(downloads, "demo\\ take.mp4")} ${join(downloads, "KitMono.woff2")} `);
    const chips = await page.$$eval(".composer-hl [data-testid=agent-path-chip]", (els) => els.map((el) => (el as HTMLElement).innerText));
    assert.deepEqual(chips, [folder, join(downloads, "logo.svg"), join(downloads, "demo\\ take.mp4"), join(downloads, "KitMono.woff2")]);
    assert.equal((await page.$$("[data-testid=agent-attachment]")).length, 1, "the PNG attached as an image");
    assert.equal(await page.$("[data-testid=agent-attach-error]"), null, "no \"isn't a PNG\" error");
    await page.screenshot({ path: shot("issue22-paste") });
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: shot("issue22-25-27-failure") }).catch(() => {});
    throw error;
  }
});
