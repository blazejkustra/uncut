// Website analytics consent (D284): the pure decisions in site/src/consent.ts and the Pages Function
// that sets the region cookie (site/functions/_middleware.ts). The browser flow is in
// test/repo/site-analytics-browser.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSENT_MAX_AGE_MS, GA_MEASUREMENT_ID, decide, isConfigured, parseConsent, regionFromCookies, regionOf } from "../../site/src/consent.ts";
import { onRequest } from "../../site/functions/_middleware.ts";

test("regionOf: EEA, UK and CH are eu; unknown and Tor count as eu; the rest is other", () => {
  for (const c of ["PL", "de", "GB", "CH", "NO", "IS", "LI"]) assert.equal(regionOf(c), "eu", c);
  for (const c of [null, undefined, "", "XX", "T1", "abc"]) assert.equal(regionOf(c), "eu", String(c));
  for (const c of ["US", "JP", "BR", "UA", "TR"]) assert.equal(regionOf(c), "other", c);
});

test("regionFromCookies: only an explicit other is other", () => {
  assert.equal(regionFromCookies("a=1; uncut_region=other; b=2"), "other");
  assert.equal(regionFromCookies("uncut_region=eu"), "eu");
  assert.equal(regionFromCookies("x_uncut_region=other"), "eu");
  assert.equal(regionFromCookies(""), "eu");
});

test("parseConsent keeps a valid choice for 12 months", () => {
  const now = 1_800_000_000_000;
  assert.equal(parseConsent(JSON.stringify({ value: "granted", ts: now - 1000 }), now), "granted");
  assert.equal(parseConsent(JSON.stringify({ value: "denied", ts: now }), now), "denied");
  assert.equal(parseConsent(JSON.stringify({ value: "granted", ts: now - CONSENT_MAX_AGE_MS - 1 }), now), null);
  assert.equal(parseConsent(JSON.stringify({ value: "yes", ts: now }), now), null);
  assert.equal(parseConsent("{", now), null);
  assert.equal(parseConsent(null, now), null);
});

test("decide: EU loads nothing before Accept; other loads with no banner; a placeholder ID does nothing", () => {
  const id = "G-ABC123";
  assert.deepEqual(decide("eu", null, id), { load: false, ask: true, settings: true });
  assert.deepEqual(decide("eu", "granted", id), { load: true, ask: false, settings: true });
  assert.deepEqual(decide("eu", "denied", id), { load: false, ask: false, settings: true });
  assert.deepEqual(decide("other", null, id), { load: true, ask: false, settings: false });
  for (const r of ["eu", "other"] as const) assert.deepEqual(decide(r, "granted", "G-XXXXXXXXXX"), { load: false, ask: false, settings: false });
  assert.equal(isConfigured("G-XXXXXXXXXX"), false);
  assert.equal(isConfigured(""), false);
  assert.equal(isConfigured(GA_MEASUREMENT_ID), true, "the configured ID is a real-looking one");
});

function ctx(url: string, headers: Record<string, string> = {}, cf?: { country?: string }, contentType = "text/html; charset=utf-8") {
  const request = Object.assign(new Request(url, { headers }), { cf });
  return { request, next: async () => new Response("<!doctype html>", { headers: { "content-type": contentType } }) };
}
const cookieOf = (r: Response) => r.headers.get("set-cookie");

test("middleware: sets uncut_region from CF-IPCountry or request.cf, never the country itself", async () => {
  const pl = cookieOf(await onRequest(ctx("https://uncut.video/", { "CF-IPCountry": "PL" })));
  assert.match(pl!, /^uncut_region=eu; Path=\/; Max-Age=2592000; SameSite=Lax; Secure$/);
  assert.match(cookieOf(await onRequest(ctx("https://uncut.video/", { "CF-IPCountry": "US" })))!, /^uncut_region=other;/);
  assert.match(cookieOf(await onRequest(ctx("https://uncut.video/", {}, { country: "US" })))!, /^uncut_region=other;/);
  assert.match(cookieOf(await onRequest(ctx("https://uncut.video/", {})))!, /^uncut_region=eu;/, "unknown country counts as EU");
  assert.match(cookieOf(await onRequest(ctx("https://uncut.video/", { "CF-IPCountry": "XX" })))!, /^uncut_region=eu;/);
  assert.doesNotMatch(pl!, /PL/);
});

test("middleware: ?region= overrides, an unchanged cookie isn't re-set, non-HTML is untouched", async () => {
  assert.match(cookieOf(await onRequest(ctx("https://uncut.video/?region=other", { "CF-IPCountry": "PL" })))!, /^uncut_region=other;/);
  assert.equal(cookieOf(await onRequest(ctx("https://uncut.video/", { "CF-IPCountry": "PL", Cookie: "uncut_region=eu" }))), null);
  assert.match(cookieOf(await onRequest(ctx("https://uncut.video/", { "CF-IPCountry": "US", Cookie: "uncut_region=eu" })))!, /^uncut_region=other;/);
  assert.equal(cookieOf(await onRequest(ctx("https://uncut.video/x.png", { "CF-IPCountry": "US" }, undefined, "image/png"))), null);
  assert.doesNotMatch(cookieOf(await onRequest(ctx("http://localhost:8788/", { "CF-IPCountry": "US" })))!, /Secure/);
});
