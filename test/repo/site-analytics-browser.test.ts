// Website analytics consent in a real browser (D284). The site is built (pnpm site:build, the Next
// static export in site/out) and served locally with the headers from the generated site/out/_headers
// (each page's CSP with the hashes of its inline scripts) and the real Pages middleware
// (site/functions/_middleware.ts) in front of HTML; the country comes from a CF-IPCountry request
// header. Every request off localhost is aborted and recorded, so nothing reaches Google: the test
// checks what *would* load, and when. Screenshots: test-output/site-consent-{1440,390}.png.
// Skipped without Chrome.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { extname, join, normalize } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { onRequest } from "../../site/functions/_middleware.ts";
import { GA_MEASUREMENT_ID } from "../../site/src/consent.ts";

declare global {
  interface Window {
    dataLayer?: Array<unknown>;
    gtag?: (...args: Array<unknown>) => void;
  }
}

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SITE = new URL("../../site/out/", import.meta.url).pathname;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
  ".txt": "text/plain",
};
/** Serve the scripts with the placeholder ID instead of the real one. */
let placeholder = false;

type Rule = { re: RegExp; lines: Array<string> };
/** site/out/_headers as Cloudflare reads it: path rules (with * splats) and their header lines. */
function parseHeaders(text: string): Array<Rule> {
  const rules: Array<Rule> = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line))
      rules.push({
        re: new RegExp(
          "^" +
            line
              .trim()
              .replace(/[.+?^$(){}|[\]\\]/g, "\\$&")
              .replace(/\*/g, ".*") +
            "$",
        ),
        lines: [],
      });
    else rules.at(-1)!.lines.push(line.trim());
  }
  return rules;
}
/** The headers for a path: every matching rule in order; "! Name" detaches what an earlier rule set. */
function headersFor(rules: Array<Rule>, path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules.filter((r) => r.re.test(path))) {
    for (const l of r.lines) {
      if (l.startsWith("! ")) delete out[l.slice(2).toLowerCase()];
      else {
        const i = l.indexOf(":");
        const k = l.slice(0, i).trim().toLowerCase();
        const v = l.slice(i + 1).trim();
        out[k] = out[k] ? `${out[k]}, ${v}` : v;
      }
    }
  }
  return out;
}
let rules: Array<Rule> = [];

let server: Server, base: string, browser: Browser;
const skip = !existsSync(CHROME) && "Chrome isn't installed";

before(async () => {
  if (skip) return;
  // A fresh build, so the test never checks a stale export.
  execFileSync(process.execPath, [new URL("../../scripts/site-build.ts", import.meta.url).pathname], { stdio: ["ignore", "ignore", "inherit"] });
  rules = parseHeaders(readFileSync(join(SITE, "_headers"), "utf8"));
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    const file = join(SITE, path);
    if (!file.startsWith(SITE) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    let body: Buffer = readFileSync(file);
    if (placeholder && path.endsWith(".js")) body = Buffer.from(body.toString("utf8").replaceAll(GA_MEASUREMENT_ID, "G-XXXXXXXXXX"));
    const csp = headersFor(rules, url.pathname)["content-security-policy"];
    assert.ok(csp && !csp.includes(", "), `one CSP for ${url.pathname}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const response = await onRequest({
      request: new Request(`http://localhost${req.url}`, { headers }),
      next: async () =>
        new Response(new Uint8Array(body), { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-security-policy": csp } }),
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  await mkdir("test-output", { recursive: true });
});
after(async () => {
  await browser?.close();
  server?.close();
});

type Visit = { page: Page; offsite: Array<string>; errors: Array<string> };

async function visitor(country: string | null, width = 1280, height = 900): Promise<Visit> {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height });
  if (country) await page.setExtraHTTPHeaders({ "CF-IPCountry": country });
  const offsite: Array<string> = [];
  const errors: Array<string> = [];
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    if (r.url().startsWith(base) || r.url().startsWith("data:")) return void r.continue();
    offsite.push(r.url());
    void r.abort();
  });
  page.on("pageerror", (e) => errors.push((e as Error).message));
  page.on("console", (m) => /Content Security Policy|Refused/.test(m.text()) && errors.push(m.text()));
  return { page, offsite, errors };
}

const google = (v: Visit) => v.offsite.filter((u) => /google(tagmanager|-analytics)\.com|analytics\.google\.com/.test(u));
const gtagUrl = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
const settle = (p: Page) => p.evaluate(() => new Promise((r) => setTimeout(r, 400)));
const bannerShown = (p: Page) => p.$eval(".consent", (e) => getComputedStyle(e).position === "fixed" && (e as HTMLElement).offsetHeight > 0).catch(() => false);
const settingsLink = (p: Page) => p.$("footer [data-cookie-settings]").then(Boolean);

test("EU visitor: banner with equal Accept and Reject, nothing from Google before a choice", { skip }, async () => {
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    const v = await visitor("PL", w, h);
    await v.page.goto(`${base}/`, { waitUntil: "networkidle0" });
    await settle(v.page);
    assert.equal(await bannerShown(v.page), true);
    assert.deepEqual(google(v), []);
    assert.equal(await v.page.evaluate(() => typeof window.gtag), "function", "Consent Mode defaults are set");
    const btns = await v.page.$$eval(".consent-btn", (bs) =>
      bs.map((b) => ({
        t: b.textContent,
        w: Math.round(b.getBoundingClientRect().width),
        bg: getComputedStyle(b).backgroundColor,
        r: getComputedStyle(b).borderRadius,
      })),
    );
    assert.deepEqual(
      btns.map((b) => b.t),
      ["Reject", "Accept"],
    );
    assert.equal(btns[0]!.w, btns[1]!.w);
    assert.equal(btns[0]!.bg, btns[1]!.bg);
    assert.equal(btns[0]!.r, "6px");
    assert.equal(await settingsLink(v.page), true);
    assert.equal(await v.page.evaluate(() => document.cookie), "uncut_region=eu");
    assert.equal(await v.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await v.page.screenshot({ path: `test-output/site-consent-${w}.png` });
    assert.deepEqual(v.errors, []);
    await v.page.browserContext().close();
  }
});

test("EU visitor: Accept loads gtag.js and is remembered", { skip }, async () => {
  const v = await visitor("DE");
  await v.page.goto(`${base}/`, { waitUntil: "networkidle0" });
  assert.deepEqual(google(v), []);
  await v.page.click(".consent-btn:last-child");
  await settle(v.page);
  assert.deepEqual(google(v), [gtagUrl]);
  assert.equal(await bannerShown(v.page), false);
  const dl = await v.page.evaluate(() => JSON.stringify(window.dataLayer!.map((a) => Array.from(a as ArrayLike<unknown>))));
  assert.match(dl, /\["consent","default",\{"ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied","analytics_storage":"denied"\}\]/);
  assert.match(dl, /\["consent","update",\{"ad_storage":"granted",.*"analytics_storage":"granted"\}\]/);
  await v.page.reload({ waitUntil: "networkidle0" });
  await settle(v.page);
  assert.equal(await bannerShown(v.page), false);
  assert.deepEqual(google(v), [gtagUrl, gtagUrl], "a returning visitor who accepted loads it straight away");
  assert.deepEqual(v.errors, []);
  await v.page.browserContext().close();
});

test("EU visitor: Reject loads nothing, now or later; Cookie settings reopens the banner", { skip }, async () => {
  const v = await visitor(null); // unknown country counts as EU
  await v.page.goto(`${base}/privacy/`, { waitUntil: "networkidle0" });
  assert.equal(await bannerShown(v.page), true);
  await v.page.click(".consent-btn:first-child");
  await v.page.reload({ waitUntil: "networkidle0" });
  await settle(v.page);
  assert.equal(await bannerShown(v.page), false);
  assert.deepEqual(google(v), []);
  await v.page.click("footer [data-cookie-settings]");
  await settle(v.page);
  assert.equal(await bannerShown(v.page), true);
  assert.equal(await v.page.evaluate(() => document.activeElement?.textContent), "Accept");
  assert.deepEqual(google(v), []);
  assert.deepEqual(v.errors, []);
  await v.page.browserContext().close();
});

test("Visitor outside the EEA/UK/CH: no banner, no settings link, gtag.js with consent granted", { skip }, async () => {
  const v = await visitor("US");
  await v.page.goto(`${base}/`, { waitUntil: "networkidle0" });
  await settle(v.page);
  assert.equal(await bannerShown(v.page), false);
  assert.equal(await settingsLink(v.page), false);
  assert.deepEqual(google(v), [gtagUrl]);
  const dl = await v.page.evaluate(() => JSON.stringify(window.dataLayer!.map((a) => Array.from(a as ArrayLike<unknown>))));
  assert.match(dl, /\["consent","default",\{"ad_storage":"granted",.*"analytics_storage":"granted"\}\]/);
  assert.deepEqual(v.errors, []);
  await v.page.browserContext().close();
});

const downloadEvents = (p: Page) => p.evaluate(() => window.dataLayer!.filter((a) => Array.from(a as ArrayLike<unknown>)[1] === "download_click").length);
const clickDownload = (p: Page) => p.$eval(".btn-nav", (a) => a.addEventListener("click", (e) => e.preventDefault())).then(() => p.click(".btn-nav"));

test("Download click: an event outside the EU and after Accept, none undecided or after Reject", { skip }, async () => {
  const us = await visitor("US");
  await us.page.goto(`${base}/`, { waitUntil: "networkidle0" });
  await clickDownload(us.page);
  assert.equal(await downloadEvents(us.page), 1);
  await us.page.browserContext().close();

  const eu = await visitor("PL");
  await eu.page.goto(`${base}/`, { waitUntil: "networkidle0" });
  await settle(eu.page);
  await clickDownload(eu.page);
  assert.equal(await downloadEvents(eu.page), 0, "undecided");
  await eu.page.click(".consent-btn:first-child");
  await clickDownload(eu.page);
  assert.equal(await downloadEvents(eu.page), 0, "rejected");
  await eu.page.click("footer [data-cookie-settings]");
  await settle(eu.page);
  await eu.page.click(".consent-btn:last-child");
  await clickDownload(eu.page);
  assert.equal(await downloadEvents(eu.page), 1, "accepted");
  await eu.page.browserContext().close();
});

const proInterest = (p: Page) =>
  p.evaluate(() =>
    window
      .dataLayer!.map((a) => Array.from(a as ArrayLike<unknown>))
      .filter((a) => a[1] === "pro_interest")
      .map((a) => (a[2] as { feature: string }).feature),
  );
const openGetPro = (p: Page) => p.$eval(".get-pro", (b) => (b as HTMLElement).click());
const pickFeature = (p: Page, index: number) => p.$$eval(".pro-chip", (chips, i) => (chips[i] as HTMLElement).click(), index);
const clickEmail = (p: Page) =>
  p.$eval('.pro-dialog a[href^="mailto:"]', (a) => {
    a.addEventListener("click", (e) => e.preventDefault());
    (a as HTMLElement).click();
  });
const dialogOpen = (p: Page) => p.$eval(".pro-dialog", (d) => (d as HTMLDialogElement).open);
const focusedIsGetPro = (p: Page) => p.evaluate(() => document.activeElement?.classList.contains("get-pro") ?? false);
const mailto = (p: Page) => p.$eval('.pro-dialog a[href^="mailto:"]', (a) => (a as HTMLAnchorElement).href);
const CONTACT = ["kustrablazej", "gmail.com"].join("@");
const SUBJECT = "subject=Email%20me%20when%20Uncut%20Pro%20launches";

test("Get Pro: the dialog opens, takes a pick, closes on Escape and returns focus; events only with consent", { skip }, async () => {
  const us = await visitor("US");
  await us.page.goto(`${base}/pricing/`, { waitUntil: "networkidle0" });
  assert.equal(await us.page.$$eval(".pricing .pro-note, .pricing [role=status]", (n) => n.length), 0, "no notes under the buttons");
  await openGetPro(us.page);
  assert.equal(await dialogOpen(us.page), true);
  assert.equal(await mailto(us.page), `mailto:${CONTACT}?${SUBJECT}`);
  await pickFeature(us.page, 0);
  await pickFeature(us.page, 0);
  assert.equal(await mailto(us.page), `mailto:${CONTACT}?${SUBJECT}&body=The%20feature%20I%20would%20use%20most%3A%20Review%20links`);
  assert.equal(await us.page.$$eval('.pro-chip[aria-pressed="true"]', (c) => c.length), 1);
  await clickEmail(us.page);
  assert.deepEqual(await proInterest(us.page), ["cta", "review_links", "email"]);
  assert.equal(await us.page.$$eval(".pro-dialog", (d) => d[0]!.textContent?.includes("Noted")), false, "no confirmation text");
  await us.page.keyboard.press("Escape");
  assert.equal(await dialogOpen(us.page), false, "Escape closes it");
  await settle(us.page);
  assert.equal(await focusedIsGetPro(us.page), true, "focus returns to Get Pro");
  await us.page.browserContext().close();

  const eu = await visitor("PL");
  await eu.page.goto(`${base}/pricing/`, { waitUntil: "networkidle0" });
  await settle(eu.page);
  await openGetPro(eu.page);
  await pickFeature(eu.page, 1);
  await clickEmail(eu.page);
  assert.deepEqual(await proInterest(eu.page), [], "undecided");
  await eu.page.keyboard.press("Escape");
  await eu.page.click(".consent-btn:first-child");
  await openGetPro(eu.page);
  await pickFeature(eu.page, 2);
  assert.equal(await dialogOpen(eu.page), true, "the dialog works without consent");
  assert.deepEqual(await proInterest(eu.page), [], "rejected");
  await eu.page.click(".pro-dialog-actions button");
  assert.equal(await dialogOpen(eu.page), false, "Close closes it");
  await eu.page.click("footer [data-cookie-settings]");
  await settle(eu.page);
  await eu.page.click(".consent-btn:last-child");
  await openGetPro(eu.page);
  await pickFeature(eu.page, 3);
  assert.deepEqual(await proInterest(eu.page), ["cta", "cloud_render"], "accepted");
  await eu.page.browserContext().close();
});

test("The launch film is requested under the CSP only once it's scrolled to", { skip }, async () => {
  const v = await visitor("US", 1280, 800);
  await v.page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  const isFilm = (r: { url(): string }) => r.url().endsWith("/assets/video/launch.mp4");
  let early = false;
  v.page.on("request", (r) => {
    early ||= isFilm(r);
  });
  await v.page.goto(`${base}/`, { waitUntil: "networkidle0" });
  assert.equal(early, false, "nothing is fetched above the fold");
  const requested = v.page.waitForRequest(isFilm, { timeout: 10_000 });
  await v.page.$eval(".film video", (e) => e.scrollIntoView({ block: "center" }));
  await requested;
  assert.deepEqual(v.errors, []);
  await v.page.browserContext().close();
});

test("Placeholder measurement ID: nothing loads and no banner, anywhere", { skip }, async () => {
  placeholder = true;
  try {
    for (const c of ["PL", "US"]) {
      const v = await visitor(c);
      await v.page.goto(`${base}/`, { waitUntil: "networkidle0" });
      await settle(v.page);
      assert.equal(await bannerShown(v.page), false);
      assert.equal(await settingsLink(v.page), false);
      assert.deepEqual(google(v), []);
      assert.equal(await v.page.evaluate(() => typeof window.gtag), "undefined");
      await v.page.browserContext().close();
    }
  } finally {
    placeholder = false;
  }
});

test("Every page: no CSP violation, no page error, no inline script without its hash; the nav fits at 360 px", { skip }, async () => {
  for (const path of ["/", "/pricing/", "/privacy/", "/blog/", "/blog/uncut-0-0-1/", "/vs/", "/vs/palmier/", "/guides/edit-video-with-claude-code/"]) {
    for (const w of [1440, 360]) {
      const v = await visitor("US", w, 800);
      await v.page.goto(`${base}${path}`, { waitUntil: "networkidle0" });
      await settle(v.page);
      assert.deepEqual(v.errors, [], `${path} at ${w}`);
      const nav = await v.page.evaluate(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        return {
          fits: document.documentElement.scrollWidth <= window.innerWidth,
          gap: r("header.top nav").left - r(".wordmark").right,
          right: r("header.top nav").right,
          width: window.innerWidth,
        };
      });
      assert.ok(nav.fits && nav.gap > 0 && nav.right <= nav.width, `${path} at ${w}: ${JSON.stringify(nav)}`);
      await v.page.browserContext().close();
    }
  }
});

test("The CSP has no 'unsafe-inline' or 'unsafe-eval', and every page's own rule lists its inline scripts' hashes", { skip }, () => {
  const text = readFileSync(join(SITE, "_headers"), "utf8");
  for (const l of text.split("\n").filter((l) => l.includes("Content-Security-Policy:"))) assert.doesNotMatch(l, /unsafe-(inline|eval)/);
  for (const path of ["/", "/privacy/", "/blog/", "/blog/uncut-0-0-1/"]) {
    const page = readFileSync(join(SITE, path, "index.html"), "utf8");
    const csp = headersFor(rules, path)["content-security-policy"]!;
    const inline = [...page.matchAll(/<script\b(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)];
    assert.ok(inline.length > 0, path);
    for (const m of inline)
      assert.ok(csp.includes(`'sha256-${createHash("sha256").update(m[1]!, "utf8").digest("base64")}'`), `${path}: an inline script without its hash`);
  }
});

const PLAYBACKS = [".agent-pb", ".critic-pb"];

function hiddenRowCount(page: Page): Promise<number> {
  return page.$$eval('.pb-row[data-state="off"], .cp-score[data-on="false"]', (rows) => rows.length);
}

async function assertFinishedPlayback(page: Page, label: string) {
  for (const sel of PLAYBACKS) assert.equal(await page.$eval(sel, (e) => (e as HTMLElement).dataset.finished), "true", `${label}: ${sel}`);
  assert.equal(await hiddenRowCount(page), 0, label);
  const agent = await page.$eval(".agent-pb", (e) => e.textContent ?? "");
  assert.match(agent, /Imported 7 files/);
  assert.match(agent, /Storyboard, 4 beats/);
  assert.match(agent, /Cut and passed: 21 s/);
  assert.doesNotMatch(agent, /Approved/);
  const critic = await page.$$eval(".cp-value", (values) => values.map((v) => (v as HTMLElement).dataset.v));
  assert.deepEqual(critic, ["9", "9", "9", "9"]);
}

test("Feature playback with reduced motion: the finished state, no playback", { skip }, async () => {
  const v = await visitor("US", 1440, 900);
  await v.page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await v.page.goto(`${base}/`, { waitUntil: "networkidle0" });
  await settle(v.page);
  await assertFinishedPlayback(v.page, "reduced motion");
  await v.page.$eval(".agent-pb", (e) => e.scrollIntoView({ block: "center" }));
  await settle(v.page);
  await assertFinishedPlayback(v.page, "reduced motion, on screen");
  assert.deepEqual(v.errors, []);
  await v.page.browserContext().close();
});

test("Feature playback without script: the finished state is in the HTML", { skip }, async () => {
  const v = await visitor("US", 390, 844);
  await v.page.setJavaScriptEnabled(false);
  await v.page.goto(`${base}/`, { waitUntil: "networkidle0" });
  await assertFinishedPlayback(v.page, "no script");
  await v.page.browserContext().close();
});

test(
  "Feature playback: waits below the fold, plays on screen without moving the layout, pauses off screen, one label for screen readers",
  { skip },
  async () => {
    for (const [w, h] of [
      [1440, 900],
      [360, 800],
    ] as const) {
      const v = await visitor("US", w, h);
      await v.page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
      await v.page.goto(`${base}/`, { waitUntil: "networkidle0" });
      const heights = () =>
        v.page.evaluate(() => [".agent-pb", ".critic-pb", ".tl-stage", ".tx-stage"].map((s) => document.querySelector<HTMLElement>(s)!.offsetHeight));
      const before = await heights();
      assert.equal(await v.page.$eval(".agent-pb", (e) => (e as HTMLElement).dataset.finished), "false");
      assert.ok((await hiddenRowCount(v.page)) > 0);

      for (const sel of PLAYBACKS) {
        assert.equal(await v.page.$eval(sel, (e) => e.getAttribute("role")), "img");
        assert.ok(await v.page.$eval(sel, (e) => (e.getAttribute("aria-label") ?? "").length > 40));
        assert.equal(await v.page.$eval(sel, (e) => e.firstElementChild!.getAttribute("aria-hidden")), "true");
      }

      await v.page.$eval(".agent-pb", (e) => e.scrollIntoView({ block: "center" }));
      await v.page.waitForFunction(() => document.querySelector('.agent-pb .pb-user[data-state="done"]'), { timeout: 8000 });
      await v.page.waitForFunction(() => document.querySelector('.agent-pb .pb-step[data-state="run"]'), { timeout: 8000 });
      assert.deepEqual(await heights(), before, `no layout change at ${w}`);

      await v.page.$eval("footer", (e) => e.scrollIntoView());
      await v.page.waitForFunction(() => (document.querySelector(".agent-pb") as HTMLElement).dataset.paused !== undefined, { timeout: 4000 });
      const paused = await v.page.$eval(".agent-pb", (e) => e.querySelectorAll('[data-state="off"]').length);
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(await v.page.$eval(".agent-pb", (e) => e.querySelectorAll('[data-state="off"]').length), paused, "stays where it was off screen");

      await v.page.$eval(".tl-stage", (e) => e.scrollIntoView({ block: "center" }));
      await v.page.waitForFunction(() => (document.querySelector(".tl-stage") as HTMLElement).dataset.playing !== undefined, { timeout: 4000 });
      assert.ok(await v.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no sideways scroll at ${w}`);
      assert.deepEqual(v.errors, []);
      await v.page.browserContext().close();
    }
  },
);

test("Feature playback on desktop: the agent panel is landscape and fits the window, the critic panel is wider than tall", { skip }, async () => {
  for (const [w, h] of [
    [1024, 768],
    [1280, 800],
    [1440, 900],
  ] as const) {
    const v = await visitor("US", w, h);
    await v.page.goto(`${base}/`, { waitUntil: "networkidle0" });
    const size = (sel: string) => v.page.$eval(sel, (e) => [(e as HTMLElement).offsetWidth, (e as HTMLElement).offsetHeight] as const);
    const [agentW, agentH] = await size(".agent-pb");
    assert.ok(agentW > agentH && agentH < h - 100, `agent at ${w}: ${agentW}x${agentH}`);
    const [criticW, criticH] = await size(".critic-pb");
    assert.ok(criticW > criticH * 1.4, `critic at ${w}: ${criticW}x${criticH}`);
    await v.page.browserContext().close();
  }
});
