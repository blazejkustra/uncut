// Google Analytics 4 with Consent Mode v2 and a cookie banner for the EEA, UK and Switzerland (D284).
// Built by `pnpm site:build` into site/assets/analytics.js. No inline script: this bundle defines
// gtag, sets the consent defaults and only then injects gtag.js, so the CSP needs no 'unsafe-inline'.
// The visitor's region comes from the uncut_region cookie the Pages Function sets
// (site/functions/_middleware.ts); without it (local preview, function not deployed) they count as EU.
import { CONSENT_KEY, type ConsentChoice, GA_MEASUREMENT_ID, decide, parseConsent, regionFromCookies } from "./consent.ts";

type Gtag = (...args: Array<unknown>) => void;
declare global {
  interface Window { dataLayer?: Array<unknown>; gtag?: Gtag }
}

const id = GA_MEASUREMENT_ID;

function readStored(): ConsentChoice | null {
  try {
    return parseConsent(window.localStorage.getItem(CONSENT_KEY), Date.now());
  } catch {
    return null;
  }
}

function store(value: ConsentChoice): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify({ value, ts: Date.now() }));
  } catch {
    /* storage blocked: the choice holds for this page view only */
  }
}

function consent(value: ConsentChoice): Record<string, ConsentChoice> {
  return { ad_storage: value, ad_user_data: value, ad_personalization: value, analytics_storage: value };
}

let loaded = false;
function loadTag(): void {
  if (loaded) return;
  loaded = true;
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.append(s);
}

/** Drops Google Analytics' own cookies (_ga, _ga_<id>) after a Reject, on every domain they may sit on. */
function clearGaCookies(): void {
  const names = document.cookie.split(";").map((c) => c.split("=")[0]!.trim()).filter((n) => n === "_ga" || n.startsWith("_ga_"));
  const host = location.hostname;
  const domains = ["", host, `.${host}`, `.${host.split(".").slice(-2).join(".")}`];
  for (const n of names) for (const d of domains) document.cookie = `${n}=; Max-Age=0; Path=/${d ? `; Domain=${d}` : ""}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

let banner: HTMLElement | null = null;

function choose(value: ConsentChoice): void {
  store(value);
  window.gtag?.("consent", "update", consent(value));
  if (value === "granted") loadTag();
  else clearGaCookies();
  closeBanner();
}

function closeBanner(): void {
  banner?.remove();
  banner = null;
}

function openBanner(focus: boolean): void {
  if (banner) return;
  const section = el("section", "consent");
  section.setAttribute("aria-label", "Cookie consent");
  section.setAttribute("role", "region");
  const p = el("p", "consent-text", "We'd like to use Google Analytics cookies to see how people find Uncut. They stay off unless you accept. ");
  const more = el("a", "", "Privacy");
  more.href = "/privacy/#website";
  p.append(more);
  const row = el("div", "consent-actions");
  const reject = el("button", "consent-btn", "Reject");
  const accept = el("button", "consent-btn", "Accept");
  reject.type = accept.type = "button";
  reject.addEventListener("click", () => choose("denied"));
  accept.addEventListener("click", () => choose("granted"));
  row.append(reject, accept);
  section.append(p, row);
  banner = section;
  // The styles are only needed with the banner, so they load with it (CSP style-src 'self').
  const show = () => { if (banner === section) { document.body.append(section); if (focus) accept.focus(); } };
  if (document.querySelector('link[href="/analytics.css"]')) return show();
  const css = el("link", "");
  css.rel = "stylesheet";
  css.href = "/analytics.css";
  css.addEventListener("load", show);
  css.addEventListener("error", show);
  document.head.append(css);
}

function addSettingsLink(): void {
  const nav = document.querySelector('footer nav[aria-label="Footer"]');
  if (!nav || nav.querySelector("[data-cookie-settings]")) return;
  const a = el("a", "", "Cookie settings");
  a.href = "#cookie-settings";
  a.dataset.cookieSettings = "";
  a.addEventListener("click", (e) => { e.preventDefault(); openBanner(true); });
  nav.append(a);
}

function start(): void {
  const region = regionFromCookies(document.cookie);
  const stored = readStored();
  const d = decide(region, stored, id);
  if (!d.load && !d.ask && !d.settings) return;

  window.dataLayer = window.dataLayer || [];
  // gtag.js reads Arguments objects from the dataLayer, not arrays, so this can't be an arrow function.
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag("consent", "default", { ...consent(region === "other" ? "granted" : "denied") });
  if (stored && region === "eu") window.gtag("consent", "update", consent(stored));
  window.gtag("js", new Date());
  window.gtag("config", id);

  if (d.load) loadTag();
  if (d.settings) addSettingsLink();
  if (d.ask) openBanner(false);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
