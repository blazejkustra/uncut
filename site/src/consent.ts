// Website analytics consent (D284), shared by the Pages Function (site/functions/_middleware.ts),
// the page script (site/src/analytics.ts) and the tests. No DOM here: pure data and decisions.

/** The GA4 measurement ID for uncut.video. It's public (it ships in every page), so it lives here.
 *  An all-X placeholder (G-XXXXXXXXXX) turns analytics off: no banner, nothing loaded. */
export const GA_MEASUREMENT_ID = "G-B3BHRQMWK1";

/** EEA (EU27 + Iceland, Liechtenstein, Norway) + UK + Switzerland: these visitors are asked first. */
export const CONSENT_REGIONS: ReadonlyArray<string> = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT",
  "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO", "GB", "CH",
];

/** The cookie the Pages Function sets: only "eu" or "other", never the country itself. */
export const REGION_COOKIE = "uncut_region";
/** localStorage key for the visitor's choice: {"value":"granted"|"denied","ts":<ms>}. */
export const CONSENT_KEY = "uncut_consent";
/** A choice is asked again after 12 months. */
export const CONSENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export type Region = "eu" | "other";
export type ConsentChoice = "granted" | "denied";

export function isConfigured(id: string): boolean {
  return /^G-[A-Z0-9]+$/.test(id) && !/^G-X+$/.test(id);
}

/** Region from a country code. Unknown (missing, "XX") and Tor ("T1") count as EU, so they're asked. */
export function regionOf(country: string | null | undefined): Region {
  const c = (country ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === "XX" || c === "T1") return "eu";
  return CONSENT_REGIONS.includes(c) ? "eu" : "other";
}

/** The region cookie's value from a Cookie header or document.cookie; anything else counts as EU. */
export function regionFromCookies(cookies: string): Region {
  const m = cookies.match(new RegExp(`(?:^|;\\s*)${REGION_COOKIE}=([^;]*)`));
  return m?.[1] === "other" ? "other" : "eu";
}

/** A stored choice, or null when there is none, it's malformed or older than 12 months. */
export function parseConsent(raw: string | null, now: number): ConsentChoice | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { value?: unknown; ts?: unknown };
    if ((v.value !== "granted" && v.value !== "denied") || typeof v.ts !== "number" || now - v.ts > CONSENT_MAX_AGE_MS) return null;
    return v.value;
  } catch {
    return null;
  }
}

export type Decision = {
  /** Load gtag.js now (Consent Mode default and the stored choice already applied). */
  load: boolean;
  /** Ask with the banner. */
  ask: boolean;
  /** Show the footer "Cookie settings" link. */
  settings: boolean;
};

/** Outside the EEA/UK/CH analytics is on by default with no banner (as on cookinbuddy.com). Inside,
 *  nothing loads until the visitor accepts; a stored choice is kept for 12 months. */
export function decide(region: Region, stored: ConsentChoice | null, id: string): Decision {
  if (!isConfigured(id)) return { load: false, ask: false, settings: false };
  if (region === "other") return { load: true, ask: false, settings: false };
  return { load: stored === "granted", ask: stored === null, settings: true };
}
