// D290: a graphic's project media in the preview. Its sandboxed iframe can't fetch (CSP, no
// network), so it asks this page: { uncut: "media", seq, id, t, w, h } by postMessage. Only a
// graphic's own iframe (the compositor's .pv-graphic ones) is answered; the picture comes from the
// server's GRAPHIC_MEDIA_PATH route (the same bytes the export's rasteriser draws) and goes back as a
// Blob: { uncut: "media-reply", seq, blob } or { uncut: "media-reply", seq, error }.
import { graphicMediaUrl } from "../state/store.ts";

const fromGraphic = (source: MessageEventSource | null) => !!source && [...document.querySelectorAll<HTMLIFrameElement>(".pv-graphic iframe")].some((f) => f.contentWindow === source);

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

addEventListener("message", (e: MessageEvent) => {
  const d = e.data as { uncut?: unknown; seq?: unknown; id?: unknown; t?: unknown; w?: unknown; h?: unknown } | null;
  if (!d || d.uncut !== "media" || typeof d.id !== "string" || !fromGraphic(e.source)) return;
  const target = e.source as Window;
  const reply = (r: { blob: Blob } | { error: string }) => target.postMessage({ uncut: "media-reply", seq: d.seq, ...r }, "*");
  const url = graphicMediaUrl(d.id, num(d.t) ?? 0, num(d.w) || undefined, num(d.h) || undefined);
  if (!url) return reply({ error: "not connected to Uncut's server yet" });
  void fetch(url)
    .then(async (r) => (r.ok ? reply({ blob: await r.blob() }) : reply({ error: (await r.text()) || `the media couldn't be loaded (${r.status})` })))
    .catch((error: Error) => reply({ error: error.message }));
});
