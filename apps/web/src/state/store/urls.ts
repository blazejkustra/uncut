import {
  TOKEN_QUERY_PARAM,
  BRAND_FILE_PATH,
  AGENT_IMAGE_PATH,
  THUMB_PATH,
  RECENT_THUMB_PATH,
  MEDIA_FILE_PATH,
  PROXY_PATH,
  SFX_FILE_PATH,
  LIBRARY_FOLDER_PATH,
  LIBRARY_PREVIEW_PATH,
  WAVEFORM_PATH,
  FILMSTRIP_PATH,
  GRAPHIC_PATH,
  GRAPHIC_MEDIA_PATH,
  GRAPHIC_ELEMENTS_PATH,
} from "@uncut/contracts";
import { serverConnection } from "./server.ts";
import type { AppStateShape } from "./types.ts";
import { state } from "./core.ts";

/** A short, stable tag for a file path (FNV-1a), so a relinked file gets a different URL. */
const pathTag = (path: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
const serverUrl = (route: string, id: string, path?: string) => {
  if (!serverConnection) return undefined;
  const url = new URL(serverConnection.url.replace(/^ws/, "http"));
  url.pathname = `${route}/${encodeURIComponent(id)}`;
  url.search = "";
  url.searchParams.set(TOKEN_QUERY_PARAM, serverConnection.token);
  // The server only looks at the id; the tag makes the URL (and so every <img>/<video> keyed on
  // it) change when the media item points at another file.
  if (path !== undefined) url.searchParams.set("v", pathTag(path));
  return url.href;
};
/** D198: a file of a brand kit (a logo thumbnail, a font for the preview), from the server's token-protected route. */
export const brandFileUrl = (kit: string, name: string, path?: string) => serverUrl(`${BRAND_FILE_PATH}/${encodeURIComponent(kit)}`, name, path);
/** An image attached to an agent message (D184), kept in the project's .cache/agent-images/. */
export const agentImageUrl = (name: string) => serverUrl(AGENT_IMAGE_PATH, name);
/** The poster for a media item, from the server's token-protected route (never file://). */
export const thumbUrl = (id: string, path?: string) => serverUrl(THUMB_PATH, id, path);
/** D205: a poster from the user's media index. */
export const recentThumbUrl = (id: string) => serverUrl(RECENT_THUMB_PATH, id);
/** The original file of a media item, streamed by the server with byte ranges (never file://). */
export const mediaUrl = (id: string, path?: string) => serverUrl(MEDIA_FILE_PATH, id, path);
/** D212: a media item's preview proxy (tagged with the key of the file it was made from). */
export const proxyUrl = (id: string, key: string) => {
  const url = serverUrl(PROXY_PATH, id);
  return url ? `${url}&v=${encodeURIComponent(key)}` : undefined;
};
/** D212: a media item's proxy state in the open project. */
export const proxyOf = (s: AppStateShape, mediaId: string) => s.proxies.find((p) => p.mediaId === mediaId);
/** A track of the bundled music library (D91), for the Audio tab's preview. */
/** A sound of the bundled sound-effects pack (D134), for the Sound effects tab's preview. */
export const sfxUrl = (file: string) => serverUrl(SFX_FILE_PATH, file);
/** A file of the user's sound folders (D208), by its id (the server knows its path). */
export const folderSoundUrl = (id: string) => serverUrl(LIBRARY_FOLDER_PATH, id);
/** An online library hit's preview (D134), streamed through the server (only hits of a recent search). */
export const libraryPreviewUrl = (source: string, id: string) => serverUrl(LIBRARY_PREVIEW_PATH, `${source}/${id}`);
/** The peaks of a media item's sound, made and cached by the server (D54). */
export const waveformUrl = (id: string, path?: string) => serverUrl(WAVEFORM_PATH, id, path);
/** Issue #53: a video's filmstrip sprite for the timeline, made and cached by the server. */
export const filmstripUrl = (id: string, path?: string) => serverUrl(FILMSTRIP_PATH, id, path);
/** A graphic item's document (D78), by its src ("graphics/x.html"), for the preview's sandboxed iframe. */
// Its URL carries the graphic-only secret from server.hello, never the server token: the graphic's
// script can read its own URL. No secret yet (hello not answered): no URL.
export const graphicUrl = (src: string) => {
  const secret = state.hello?.graphicToken;
  if (!src.startsWith("graphics/") || !secret) return undefined;
  const url = serverUrl(GRAPHIC_PATH, src.slice("graphics/".length), src);
  if (!url) return undefined;
  const u = new URL(url);
  u.searchParams.set(TOKEN_QUERY_PARAM, secret);
  return u.href;
};
/** D316: a graphic's elements, by its src. */
export const graphicElementsUrl = (src: string) => (src.startsWith("graphics/") ? serverUrl(GRAPHIC_ELEMENTS_PATH, src.slice("graphics/".length)) : undefined);
/** D290: a picture of a media item for a graphic in the preview (its frame at t seconds, fitting w × h); fetched by this page, never shown to the graphic. */
export const graphicMediaUrl = (id: string, t: number, w?: number, h?: number, preview?: boolean) => {
  const url = serverUrl(GRAPHIC_MEDIA_PATH, id);
  if (!url) return undefined;
  const u = new URL(url);
  u.searchParams.set("t", String(t));
  if (w) u.searchParams.set("w", String(Math.round(w)));
  if (h) u.searchParams.set("h", String(Math.round(h)));
  if (preview) u.searchParams.set("p", "1");
  return u.href;
};
