// Website analytics consent in a real browser (D284). site/ is served locally with the CSP from
// site/_headers and the real Pages middleware (site/functions/_middleware.ts) in front of HTML; the
// country comes from a CF-IPCountry request header. Every request off localhost is aborted and
// recorded, so nothing reaches Google: the test checks what *would* load, and when.
// Screenshots: test-output/site-consent-{1440,390}.png. Skipped without Chrome.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { onRequest } from "../../site/functions/_middleware.ts";
import { GA_MEASUREMENT_ID } from "../../site/src/consent.ts";

declare global {
  interface Window { dataLayer?: Array<unknown>; gtag?: (...args: Array<unknown>) => void }
}

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SITE = new URL("../../site/", import.meta.url).pathname;
const CSP = readFileSync(join(SITE, "_headers"), "utf8").match(/Content-Security-Policy: (.*)/)![1]!;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
/** Serve analytics.js with the placeholder ID instead of the real one. */
let placeholder = false;

let server: Server, base: string, browser: Browser;
const skip = !existsSync(CHROME) && "Chrome isn't installed";

before(async () => {
  if (skip) return;
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    const file = join(SITE, path);
    if (!file.startsWith(SITE) || !existsSync(file)) { res.writeHead(404).end(); return; }
    let body: Buffer = readFileSync(file);
    if (placeholder && path.endsWith("analytics.js")) body = Buffer.from(body.toString("utf8").replace(GA_MEASUREMENT_ID, "G-XXXXXXXXXX"));
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const response = await onRequest({
      request: new Request(`http://localhost${req.url}`, { headers }),
      next: async () => new Response(new Uint8Array(body), { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-security-policy": CSP } }),
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
const settingsLink = (p: Page) => p.$('footer [data-cookie-settings]').then(Boolean);

test("EU visitor: banner with equal Accept and Reject, nothing from Google before a choice", { skip }, async () => {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    const v = await visitor("PL", w, h);
    await v.page.goto(`${base}/`, { waitUntil: "networkidle0" });
    await settle(v.page);
    assert.equal(await bannerShown(v.page), true);
    assert.deepEqual(google(v), []);
    assert.equal(await v.page.evaluate(() => typeof window.gtag), "function", "Consent Mode defaults are set");
    const btns = await v.page.$$eval(".consent-btn", (bs) => bs.map((b) => ({ t: b.textContent, w: Math.round(b.getBoundingClientRect().width), bg: getComputedStyle(b).backgroundColor, r: getComputedStyle(b).borderRadius })));
    assert.deepEqual(btns.map((b) => b.t), ["Reject", "Accept"]);
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
