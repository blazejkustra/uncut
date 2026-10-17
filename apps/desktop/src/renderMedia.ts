// D290: project media in the rasteriser's graphics (core graphicMedia.ts). A graphic's document asks
// for uncut-media://media/<id>?t=&w=&h= (fetch, from its data: page: a CORS request, answered with
// access-control-allow-origin: *); the handler asks the server on stdout ({ uncut: "render", media:
// { sub, id, t, w, h } }), the server answers on stdin ({ mediaReply: sub, file, type } or { error })
// and the file's bytes are the response. Each answer is a new file of the server's that is ours once
// answered: it's removed as soon as it's read (so none is rewritten while read, and none piles up).
// The rasteriser itself knows nothing of projects or ffmpeg.
import { readFile, unlink } from "node:fs/promises";
import type { Protocol } from "electron";

export const MEDIA_SCHEME = "uncut-media";
/** For protocol.registerSchemesAsPrivileged: fetchable from a graphic's (opaque-origin) page. */
export const MEDIA_SCHEME_PRIVILEGES = { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } } as const;
/** Whether a request may go out (the session's network filter): only this scheme's media URLs. */
export const isMediaUrl = (url: string) => url.startsWith(`${MEDIA_SCHEME}://media/`);

export const MEDIA_MS = 20_000;
let next = 0;
const pending = new Map<number, { readonly done: (r: { file?: unknown; type?: unknown; error?: unknown }) => void }>();
/** Round 3's A2: the media requests still waiting for the server (id, seconds), so a graphic's frame deadline can wait for them and say so. */
const waiting = new Map<number, { readonly id: string; readonly t: number }>();
/** The project media a graphic is waiting for right now. */
export const mediaWaiting = (): ReadonlyArray<{ readonly id: string; readonly t: number }> => [...waiting.values()];

const answer = (status: number, body: string | Uint8Array<ArrayBuffer>, type = "text/plain; charset=utf-8") =>
  new Response(body, { status, headers: { "content-type": type, "access-control-allow-origin": "*", "cache-control": "no-store" } });

/** Serve the scheme: each request asked of the server through `send` (a stdout line). */
export function handleMedia(protocol: Protocol, send: (msg: Record<string, unknown>) => void) {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== "media") return answer(404, "not found");
    let id: string;
    try {
      id = decodeURIComponent(url.pathname.slice(1));
    } catch {
      return answer(400, "bad media id");
    }
    const num = (name: string) => (url.searchParams.get(name) ? Number(url.searchParams.get(name)) : undefined);
    const sub = ++next;
    waiting.set(sub, { id, t: num("t") ?? 0 });
    const reply = await new Promise<{ file?: unknown; type?: unknown; error?: unknown }>((done) => {
      const timer = setTimeout(() => {
        // An answer after this has nobody to read its file: remove it then.
        pending.set(sub, { done: (late) => void (typeof late.file === "string" && unlink(late.file).catch(() => {})) });
        setTimeout(() => pending.delete(sub), MEDIA_MS).unref?.();
        done({ error: "the media took too long" });
      }, MEDIA_MS);
      pending.set(sub, {
        done: (r) => {
          clearTimeout(timer);
          done(r);
        },
      });
      send({ media: { sub, id, t: num("t") ?? 0, w: num("w"), h: num("h") } });
    }).finally(() => waiting.delete(sub));
    if (typeof reply.file !== "string") return answer(404, typeof reply.error === "string" ? reply.error : "the media couldn't be loaded");
    const file = reply.file;
    try {
      return answer(200, new Uint8Array(await readFile(file)), typeof reply.type === "string" ? reply.type : "application/octet-stream");
    } catch {
      return answer(404, "the media couldn't be read");
    } finally {
      void unlink(file).catch(() => {});
    }
  });
}

/** A stdin line that answers a media request (true: taken, not a render request). */
export function takeMediaReply(msg: unknown): boolean {
  const m = msg as { mediaReply?: unknown } | null;
  if (typeof m !== "object" || m === null || m.mediaReply === undefined) return false;
  const p = pending.get(Number(m.mediaReply));
  if (p) {
    pending.delete(Number(m.mediaReply));
    p.done(m as { file?: unknown; type?: unknown; error?: unknown });
  }
  return true;
}
