// D290: a graphic's project media in the preview. Its sandboxed iframe can't fetch (CSP, no
// network), so it asks this page: { uncut: "media", seq, id, t, w, h } by postMessage. Only a
// graphic's own iframe (the compositor's .pv-graphic ones, from the opaque origin "null":
// graphicMessage.ts) is answered; the picture comes from the server's GRAPHIC_MEDIA_PATH route
// (the same bytes the export's rasteriser draws) and goes back as a Blob:
// { uncut: "media-reply", seq, blob } or { uncut: "media-reply", seq, error }.
import { graphicMediaUrl } from "../state/store.ts";
import { graphicMediaAsk } from "./graphicMessage.ts";

const graphicWindows = () => [...document.querySelectorAll<HTMLIFrameElement>(".pv-graphic iframe")].map((f) => f.contentWindow);

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

addEventListener("message", (e: MessageEvent) => {
  const d = graphicMediaAsk(e, graphicWindows());
  if (!d) return;
  const target = e.source as Window;
  // "*": an opaque origin can't be named; the desktop keeps the frame on its graphic (allowFrameNavigation).
  const reply = (r: { blob: Blob } | { error: string }) => target.postMessage({ uncut: "media-reply", seq: d.seq, ...r }, "*");
  const url = graphicMediaUrl(d.id, num(d.t) ?? 0, num(d.w) || undefined, num(d.h) || undefined);
  if (!url) return reply({ error: "not connected to Uncut's server yet" });
  void fetch(url)
    .then(async (r) => (r.ok ? reply({ blob: await r.blob() }) : reply({ error: (await r.text()) || `the media couldn't be loaded (${r.status})` })))
    .catch((error: Error) => reply({ error: error.message }));
});
