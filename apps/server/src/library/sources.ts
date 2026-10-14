// The online sound library's sources (D134): Openverse (no key; CC0 and CC BY only, commercial use
// allowed) and Freesound (the user's own key). Each turns a search into one request URL and its
// reply into LibraryHits; nothing here sends anything (library.ts does, through guardedFetch).
// Base URLs: UNCUT_OPENVERSE_BASE / UNCUT_FREESOUND_BASE, honoured only in test runs (providerBase).
import { attributionLine, licenseUrl, type LibraryHit, type LibraryLicense, type LibraryQuery } from "@uncut/core/library";

import { inTestContext, providerBase } from "../generate/providers.ts";

export const PAGE_SIZE = 20;

export const openverseBase = () => providerBase("UNCUT_OPENVERSE_BASE", "https://api.openverse.org");
export const freesoundBase = () => providerBase("UNCUT_FREESOUND_BASE", "https://freesound.org");

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/**
 * A file, preview or page URL from a reply: https, or (only in a test context) http to a loopback
 * stub. Fetching it is checked again on every hop (net.ts: public addresses only).
 */
export function fetchableUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname) && inTestContext())) return url.href;
  } catch {}
  return undefined;
}

const text = (v: unknown, max = 300) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max) : "");

// ---- Openverse ----

/** Openverse's length buckets for ours: shortest < 30 s, short 30 s–2 min, medium 2–10 min, long > 10 min. */
const OPENVERSE_LENGTH = { short: "shortest", medium: "short", long: "medium,long" } as const;

/**
 * The search URL: CC0 and CC BY only (both allow commercial use and changes; NC, ND and sampling+
 * never come back), without Wikimedia's word pronunciations, nothing marked mature.
 */
export function openverseUrl(q: LibraryQuery): string {
  const params = new URLSearchParams({
    q: q.query.trim(),
    license: q.license === "cc0" ? "cc0" : "cc0,by",
    license_type: "commercial,modification",
    excluded_source: "wikimedia_audio",
    mature: "false",
    page_size: String(PAGE_SIZE),
    page: String(Math.max(1, Math.floor(q.page ?? 1))),
  });
  if (q.kind === "music" && q.songs) params.set("category", "music");
  if (q.length) params.set("length", OPENVERSE_LENGTH[q.length]);
  return `${openverseBase()}/v1/audio/?${params}`;
}

/** One Openverse result as a hit, with the file URL to fetch; undefined when it isn't usable (licence, no file). */
export function openverseHit(r: Record<string, unknown>): { hit: LibraryHit; fileUrl: string } | undefined {
  const license = r.license === "cc0" || r.license === "by" ? (r.license as LibraryLicense) : undefined;
  const fileUrl = fetchableUrl(r.url);
  const id = text(r.id, 64);
  const landing = fetchableUrl(r.foreign_landing_url);
  if (!license || !fileUrl || !/^[A-Za-z0-9-]{1,64}$/.test(id) || !landing) return undefined;
  const version = text(r.license_version, 10) || (license === "cc0" ? "1.0" : "4.0");
  const base = {
    title: text(r.title, 200) || "Untitled",
    creator: text(r.creator, 120) || "Unknown",
    license,
    licenseVersion: version,
    licenseUrl: fetchableUrl(r.license_url) ?? licenseUrl(license, version),
  };
  const duration = typeof r.duration === "number" && r.duration > 0 ? r.duration / 1000 : undefined;
  const tags = Array.isArray(r.tags) ? r.tags.map((t) => text((t as { name?: unknown })?.name, 40)).filter(Boolean).slice(0, 12) : [];
  const creatorUrl = fetchableUrl(r.creator_url);
  const provider = text(r.provider, 40);
  const filetype = text(r.filetype, 8).toLowerCase();
  return {
    fileUrl,
    hit: {
      source: "openverse",
      id,
      ...base,
      ...(creatorUrl ? { creatorUrl } : {}),
      landingUrl: landing,
      ...(provider ? { provider } : {}),
      attribution: text(r.attribution, 600) || attributionLine(base),
      ...(duration ? { seconds: Math.round(duration * 100) / 100 } : {}),
      tags,
      ...(/^[a-z0-9]{2,5}$/.test(filetype) ? { filetype } : {}),
    },
  };
}

/** One sound's details (for an id no recent search returned, e.g. after a restart). */
export const openverseDetailUrl = (id: string) => `${openverseBase()}/v1/audio/${encodeURIComponent(id)}/`;

// ---- Freesound ----

const FREESOUND_FIELDS = "id,name,username,license,duration,previews,tags,url,type";
const FREESOUND_LENGTH = { short: "duration:[0 TO 30]", medium: "duration:[30 TO 120]", long: "duration:[120 TO *]" } as const;

/** The search URL (the key goes in the Authorization header, never the URL). */
export function freesoundUrl(q: LibraryQuery): string {
  const filters = [q.license === "cc0" ? 'license:"Creative Commons 0"' : '(license:"Creative Commons 0" OR license:"Attribution")'];
  if (q.length) filters.push(FREESOUND_LENGTH[q.length]);
  if (q.kind === "music" && q.songs) filters.push("tag:music");
  const params = new URLSearchParams({ query: q.query.trim(), filter: filters.join(" "), fields: FREESOUND_FIELDS, page_size: String(PAGE_SIZE), page: String(Math.max(1, Math.floor(q.page ?? 1))) });
  return `${freesoundBase()}/apiv2/search/text/?${params}`;
}

export const freesoundDetailUrl = (id: string) => `${freesoundBase()}/apiv2/sounds/${encodeURIComponent(id)}/?${new URLSearchParams({ fields: FREESOUND_FIELDS })}`;

/** Freesound's licence URL as ours: CC0 1.0 or CC BY (its version); anything else (BY-NC, sampling+) undefined. */
export function freesoundLicense(raw: unknown): { license: LibraryLicense; version: string } | undefined {
  if (typeof raw !== "string") return undefined;
  if (/creativecommons\.org\/publicdomain\/zero\/1\.0/.test(raw)) return { license: "cc0", version: "1.0" };
  const by = /creativecommons\.org\/licenses\/by\/(\d\.\d)/.exec(raw);
  return by ? { license: "by", version: by[1]! } : undefined;
}

export function freesoundHit(r: Record<string, unknown>): { hit: LibraryHit; fileUrl: string } | undefined {
  const lic = freesoundLicense(r.license);
  const previews = (r.previews ?? {}) as Record<string, unknown>;
  const fileUrl = fetchableUrl(previews["preview-hq-mp3"]) ?? fetchableUrl(previews["preview-lq-mp3"]);
  const id = typeof r.id === "number" && Number.isInteger(r.id) ? String(r.id) : "";
  const landing = fetchableUrl(r.url);
  if (!lic || !fileUrl || !id || !landing) return undefined;
  const creator = text(r.username, 120) || "Unknown";
  const base = { title: text(r.name, 200) || "Untitled", creator, license: lic.license, licenseVersion: lic.version, licenseUrl: licenseUrl(lic.license, lic.version) };
  const duration = typeof r.duration === "number" && r.duration > 0 ? r.duration : undefined;
  return {
    fileUrl,
    hit: {
      source: "freesound",
      id,
      ...base,
      creatorUrl: `https://freesound.org/people/${encodeURIComponent(creator)}/`,
      landingUrl: landing,
      provider: "freesound",
      attribution: attributionLine(base),
      ...(duration ? { seconds: Math.round(duration * 100) / 100 } : {}),
      tags: Array.isArray(r.tags) ? r.tags.map((t) => text(t, 40)).filter(Boolean).slice(0, 12) : [],
      filetype: "mp3",
    },
  };
}
