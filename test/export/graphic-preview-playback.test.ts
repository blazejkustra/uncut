// A graphic that draws footage (uncut.frame) while the editor's preview plays it. The preview posts
// { uncut: "render" } once per frame (60 a second) and never waits; footage takes longer than a frame
// to come (here every picture is answered 120 ms late, as a 4K clip's 1920-px frame is). Before:
// each post started a render(t) at once, so a dozen ran interleaved on one canvas: an older t
// finished after a newer one and stayed on screen (time going backwards), one render's transform
// leaked into another's drawing, the half-drawn canvas (its black footage box) was on screen while
// the picture was awaited, and the asks piled up until the graphic lagged seconds behind the
// playhead (frozen). Now, in a real Chrome with the real document and media source:
// - render(t) runs one at a time and the t it finishes on never goes back;
// - what's on screen (sampled every animation frame inside the graphic) is never the black box once
//   the footage has come, and the footage's frame advances;
// - at most one picture of the clip is asked for at a time;
// - stopped, the frame drawn is the exact frame asked for, never the black box on the way.
// And smooth (the footage answered at once, as from a proxy): while playing, a render for about
// every frame posted (it no longer waits two animation frames after each, which capped it at 30 a
// second), the footage asked with p (a proxy's picture will do) and a smaller picture given to the
// graphic at the exact one's size; stopped, the exact picture asked for and drawn.
// Skipped without Chrome or ffmpeg.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { graphicDocument, parseGraphicMediaRequest, type Media } from "../../packages/core/src/index.ts";
import { graphicMediaSource, type GraphicMediaSource } from "../../apps/server/src/export/graphicMedia.ts";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const bin = spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout.trim();
const skip = !existsSync(CHROME) ? "needs Chrome" : bin ? false : "needs ffmpeg";

const W = 320;
const H = 180;
const FPS = 60;
const CLIP_FPS = 30;
const LATE_MS = 120;
// The clip's frame n in grey: 16 + 2n (a grey survives the YUV round trip to the pixel).
const decode = (r: number) => Math.round((r - 16) / 2);

// Like the launch films: the footage box filled black, then the frame awaited and drawn over it,
// a thumbnail asked every frame beside it. The probe reports each finished render's t and, every
// animation frame, the pixel on screen.
const GRAPHIC = `<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
const ctx = document.getElementById("c").getContext("2d");
window.render = async (t) => {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, ${W}, ${H});
  ctx.translate(${W / 2}, 0);
  const f = await uncut.frame("clip", 0.1 + t, { width: ${W} });
  ctx.drawImage(f, ${-W / 2}, 0, ${W}, ${H});
  const thumb = await uncut.frame("clip", 0.05, { width: 32 });
  ctx.drawImage(thumb, ${W / 2 - 40}, 4, 32, 18);
};
</script>
<script>(() => {
  const real = window.render;
  window.render = async (t, info) => { await real(t, info); parent.postMessage({ uncut: "probe", t }, "*"); };
  const sample = () => {
    const [r, g, b] = ctx.getImageData(${W / 4}, ${H / 2}, 1, 1).data;
    parent.postMessage({ uncut: "sample", r, g, b }, "*");
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
})();</script>`;

// A render(t) that never settles (t = 1): the preview must still draw the asks after it.
const HANG = `<script>
window.render = async (t) => {
  if (t === 1) await new Promise(() => {});
  parent.postMessage({ uncut: "probe", t }, "*");
};
</script>`;

// Draws the picture at its own size (no width given to drawImage): a proxy's smaller picture must
// come at the exact one's size or half the frame would be empty.
const NATURAL = `<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
const ctx = document.getElementById("c").getContext("2d");
window.render = async (t) => {
  ctx.clearRect(0, 0, ${W}, ${H});
  const f = await uncut.frame("clip", 0.1 + t, { width: ${W} });
  ctx.drawImage(f, 0, 0);
  const [r] = ctx.getImageData(${(W * 3) / 4}, ${H / 2}, 1, 1).data;
  parent.postMessage({ uncut: "probe", t, w: f.width, h: f.height, r }, "*");
};
</script>`;

// As apps/web answers: asked with p (playing), a half-size picture and the exact size (x-uncut-full); else the exact one. At once.
const proxyHost = `<!doctype html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:${W}px;height:${H}px" src="/natural"></iframe><script>
const f = document.getElementById("f");
window.log = { probes: [], proxied: 0, exact: 0 };
addEventListener("message", (e) => {
  const d = e.data;
  if (d && d.uncut === "probe") return log.probes.push(d);
  if (!d || d.uncut !== "media" || e.source !== f.contentWindow) return;
  const target = e.source;
  if (d.p) log.proxied++; else log.exact++;
  // The proxy's picture 0.1 s early (3 frames): a stop frame left on it shows the wrong frame.
  fetch("/fast/media/" + d.id + "?t=" + (d.p ? Math.max(0, d.t - 0.1) : d.t) + "&w=" + (d.p ? ${W / 2} : d.w)).then(async (r) => {
    const blob = await r.blob();
    target.postMessage({ uncut: "media-reply", seq: d.seq, blob, ...(d.p ? { full: { width: ${W}, height: ${H} } } : {}) }, "*");
  });
});
const post = (frame, playing) => f.contentWindow.postMessage({ uncut: "render", seq: frame, t: frame / ${FPS}, playing, info: { frame, fps: ${FPS}, duration: 600, width: ${W}, height: ${H}, props: {} } }, "*");
window.play = (secs) => new Promise((done) => {
  let sent = -1, posts = 0;
  const t0 = performance.now();
  const tick = () => {
    const el = (performance.now() - t0) / 1000;
    const frame = Math.floor(el * ${FPS});
    if (frame !== sent) { post((sent = frame), true); posts++; }
    if (el < secs) requestAnimationFrame(tick);
    else done({ last: sent, posts });
  };
  requestAnimationFrame(tick);
});
window.stop = (frame) => post(frame, false);
</script></body>`;

const host = (
  src: string,
) => `<!doctype html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:${W}px;height:${H}px" src="${src}"></iframe><script>
const f = document.getElementById("f");
window.log = { probes: [], samples: [], rendered: [], asks: 0, open: 0, maxOpen: 0 };
addEventListener("message", (e) => {
  const d = e.data;
  if (d && d.uncut === "probe") return log.probes.push(d.t);
  if (d && d.uncut === "rendered") return log.rendered.push(d.seq);
  if (d && d.uncut === "sample") return log.samples.push([d.r, d.g, d.b]);
  if (!d || d.uncut !== "media" || e.source !== f.contentWindow) return;
  const clip = d.w === ${W};
  if (clip) { log.asks++; log.open++; log.maxOpen = Math.max(log.maxOpen, log.open); }
  const target = e.source;
  fetch("/media/" + d.id + "?t=" + d.t + (d.w ? "&w=" + d.w : "")).then(async (r) => {
    const blob = await r.blob();
    if (clip) log.open--;
    target.postMessage({ uncut: "media-reply", seq: d.seq, blob }, "*");
  });
});
const post = (frame, playing) => f.contentWindow.postMessage({ uncut: "render", seq: frame, t: frame / ${FPS}, playing, info: { frame, fps: ${FPS}, duration: 600, width: ${W}, height: ${H}, props: {} } }, "*");
// As the compositor plays: one post per new frame, never waiting.
window.play = (secs) => new Promise((done) => {
  let sent = -1;
  const t0 = performance.now();
  const tick = () => {
    const el = (performance.now() - t0) / 1000;
    const frame = Math.floor(el * ${FPS});
    if (frame !== sent) post((sent = frame), true);
    if (el < secs) requestAnimationFrame(tick);
    else done(sent);
  };
  requestAnimationFrame(tick);
});
window.stop = (frame) => post(frame, false);
</script></body>`;

let root: string;
let source: GraphicMediaSource;
let server: Server;
let browser: Browser;
let page: Page;
let port = 0;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-graphic-playback-")));
  const clip = join(root, "clip.mp4");
  const c = spawnSync(bin, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=black:size=${W}x${H}:rate=${CLIP_FPS}`,
    "-t",
    "4",
    "-vf",
    "format=rgb24,geq=r='16+2*N':g='16+2*N':b='16+2*N',format=yuv444p",
    "-c:v",
    "libx264",
    "-qp",
    "0",
    "-g",
    "30",
    clip,
  ]);
  assert.equal(c.status, 0, String(c.stderr));
  const media: Array<Media> = [{ id: "clip", kind: "video", name: "clip.mp4", path: clip }];
  source = graphicMediaSource({ bin, media: () => media, mediaPath: (m) => m.path });
  const doc = graphicDocument(GRAPHIC, { width: W, height: H });
  const hang = graphicDocument(HANG, { width: W, height: H });
  const natural = graphicDocument(NATURAL, { width: W, height: H });
  server = createServer(async (req, res) => {
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(host("/doc"));
    if (u.pathname === "/hang-host") return void res.writeHead(200, { "content-type": "text/html" }).end(host("/hang"));
    if (u.pathname === "/doc") return void res.writeHead(200, { "content-type": "text/html" }).end(doc);
    if (u.pathname === "/hang") return void res.writeHead(200, { "content-type": "text/html" }).end(hang);
    if (u.pathname === "/proxy-host") return void res.writeHead(200, { "content-type": "text/html" }).end(proxyHost);
    if (u.pathname === "/natural") return void res.writeHead(200, { "content-type": "text/html" }).end(natural);
    const fast = u.pathname.startsWith("/fast/");
    const ask = parseGraphicMediaRequest(u.pathname.slice((fast ? "/fast/media/" : "/media/").length), u.searchParams);
    if ("problem" in ask) return void res.writeHead(400).end(ask.problem);
    const p = await source.picture(ask);
    // A 4K clip's frame: longer than a preview frame to come (a proxy's: at once).
    if (!fast) await new Promise((r) => setTimeout(r, LATE_MS));
    res.writeHead(200, { "content-type": p.type }).end(p.bytes);
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as { port: number }).port;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
});

after(async () => {
  if (skip) return;
  await browser?.close();
  server?.close();
  source?.close();
  rmSync(root, { recursive: true, force: true });
});

type Log = { probes: Array<number>; rendered: Array<number>; samples: Array<[number, number, number]>; asks: number; open: number; maxOpen: number };

test(
  "a graphic drawing footage plays in the preview: time never goes back, no black box, the footage advances, the stop frame is exact",
  { skip, timeout: 60_000 },
  async () => {
    // Paused at 0 first (the editor draws the frame it opens on): the exact frame, awaited.
    await page.evaluate(() => (window as unknown as { stop: (f: number) => void }).stop(0));
    await page.waitForFunction(() => (window as unknown as { log: Log }).log.probes.length > 0, { timeout: 10_000 });
    const last = await page.evaluate(() => (window as unknown as { play: (s: number) => Promise<number> }).play(3));
    const played = await page.evaluate(() => (window as unknown as { log: Log }).log);

    // One render at a time, in order: the t on screen never goes back.
    for (let i = 1; i < played.probes.length; i++)
      assert.ok(played.probes[i]! >= played.probes[i - 1]!, `render ${i} finished on t ${played.probes[i]} after t ${played.probes[i - 1]}`);
    // Rendering keeps up with the playhead (a render no longer waits for each picture).
    assert.ok(played.probes.length > 30, `only ${played.probes.length} renders finished in 3 s of playback`);
    assert.ok(played.probes.at(-1)! >= last / FPS - 0.5, `the graphic is at ${played.probes.at(-1)} s, the playhead at ${last / FPS} s`);

    // On screen: never the black box once the footage came; the footage's frame never goes back and advances.
    const shown = played.samples.filter(([r]) => r >= 12);
    const first = played.samples.findIndex(([r]) => r >= 12);
    assert.ok(first >= 0, "the footage never showed");
    const black = played.samples.slice(first).filter(([r]) => r < 12).length;
    assert.equal(black, 0, `${black} of ${played.samples.length - first} animation frames showed the black box after the footage came`);
    const frames = shown.map(([r]) => decode(r));
    for (let i = 1; i < frames.length; i++) assert.ok(frames[i]! >= frames[i - 1]!, `footage went back from frame ${frames[i - 1]} to ${frames[i]}`);
    assert.ok(new Set(frames).size >= 5, `the footage showed only ${new Set(frames).size} frames in 3 s`);
    assert.ok(
      frames.at(-1)! >= Math.floor((0.1 + last / FPS - 1.5) * CLIP_FPS),
      `the footage is at frame ${frames.at(-1)}, the playhead asks for ${Math.floor((0.1 + last / FPS) * CLIP_FPS)}`,
    );

    // Paced: one picture of the clip asked at a time, not one per frame.
    assert.ok(played.maxOpen <= 1, `${played.maxOpen} pictures of the clip were asked for at once`);
    assert.ok(played.asks < 60, `${played.asks} pictures asked in 3 s`);

    // Stopped: the exact frame.
    const stopAt = last;
    const exact = Math.floor((0.1 + stopAt / FPS) * CLIP_FPS + 1e-6);
    const from = played.samples.length;
    await page.evaluate((f) => (window as unknown as { stop: (f: number) => void }).stop(f), stopAt);
    // Drawn when the last sample on screen is the exact frame (or after 5 s, which fails below).
    await page
      .waitForFunction((n) => Math.round((((window as unknown as { log: Log }).log.samples.at(-1)?.[0] ?? 0) - 16) / 2) === n, { timeout: 5_000 }, exact)
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    const stopped = (await page.evaluate(() => (window as unknown as { log: Log }).log.samples)).slice(from);
    // Never half drawn on the way: the nearest frame stays until the exact one is drawn over it.
    assert.equal(stopped.filter(([v]) => v < 12).length, 0, "the black box showed while the stop frame's picture came");
    const [r] = stopped.at(-1)!;
    assert.equal(decode(r), exact, "the frame playback stopped on isn't the exact one");
  },
);

test("the export (and render_frames) draws the exact frame, even after a playing preview's begin", { skip, timeout: 60_000 }, async () => {
  // The rasteriser's own window: the document at the top (parent === window), its pictures fetched
  // by the uncut-media scheme, stubbed here with the clip's grey for the frame asked, 120 ms late.
  const top = await browser.newPage();
  await top.evaluateOnNewDocument(
    (w: number, h: number, clipFps: number, late: number) => {
      window.fetch = (async (url: string) => {
        const t = Number(new URL(String(url)).searchParams.get("t"));
        const n = Math.floor(t * clipFps + 1e-6);
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext("2d")!;
        const v = 16 + 2 * n;
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(0, 0, w, h);
        await new Promise((r) => setTimeout(r, late));
        return new Response(await c.convertToBlob());
      }) as typeof fetch;
    },
    W,
    H,
    CLIP_FPS,
    LATE_MS,
  );
  await top.goto(`http://127.0.0.1:${port}/doc`);
  try {
    const drawn = await top.evaluate(
      async (w: number, h: number) => {
        const win = window as unknown as { __uncutMedia: { begin: (o: object) => void }; __uncutRender: (t: number, info: object) => Promise<boolean> };
        const ctx = (document.getElementById("c") as HTMLCanvasElement).getContext("2d")!;
        const out: Array<[number, number]> = [];
        // A frame is cached first, so a nearest one (within a second) is there to substitute.
        for (const t of [0, 0.5, 0.25, 0.9]) {
          win.__uncutMedia.begin({ playing: true });
          await win.__uncutRender(t, {});
          out.push([t, ctx.getImageData(w / 4, h / 2, 1, 1).data[0]!]);
        }
        return out;
      },
      W,
      H,
    );
    for (const [t, r] of drawn) assert.equal(decode(r), Math.floor((0.1 + t) * CLIP_FPS + 1e-6), `the export drew another frame at t ${t}`);
  } finally {
    await top.close();
  }
});

test("a render(t) that never settles doesn't freeze the preview: the asks after it still draw", { skip, timeout: 60_000 }, async () => {
  const p = await browser.newPage();
  await p.goto(`http://127.0.0.1:${port}/hang-host`);
  try {
    const post = (frame: number) =>
      p.evaluate(
        (n) => (document.getElementById("f") as HTMLIFrameElement).contentWindow!.postMessage({ uncut: "render", seq: n, t: n, playing: false, info: {} }, "*"),
        frame,
      );
    // The iframe loads after the host page: ready once a first render is answered.
    await p.waitForFunction(() => document.getElementById("f") && (window as unknown as { log: Log }).log !== undefined);
    await new Promise((r) => setTimeout(r, 300));
    await post(0);
    await p.waitForFunction(() => (window as unknown as { log: Log }).log.rendered.includes(0), { timeout: 10_000 });
    await post(1);
    await post(2);
    await p.waitForFunction(() => (window as unknown as { log: Log }).log.probes.includes(2), { timeout: 15_000 });
  } finally {
    await p.close();
  }
});

test(
  "smooth: footage answered at once plays a render about every frame, a proxy's picture at the exact size, the stop frame exact",
  { skip, timeout: 60_000 },
  async () => {
    type ProxyLog = { probes: Array<{ t: number; w: number; h: number; r: number }>; proxied: number; exact: number };
    const p = await browser.newPage();
    await p.goto(`http://127.0.0.1:${port}/proxy-host`);
    try {
      await p.waitForFunction(() => (window as unknown as { log?: ProxyLog }).log !== undefined);
      await new Promise((r) => setTimeout(r, 300));
      await p.evaluate(() => (window as unknown as { stop: (f: number) => void }).stop(0));
      await p.waitForFunction(() => (window as unknown as { log: ProxyLog }).log.probes.length > 0, { timeout: 10_000 });
      const before = await p.evaluate(() => (window as unknown as { log: ProxyLog }).log.probes.length);
      const { last, posts } = await p.evaluate(() => (window as unknown as { play: (s: number) => Promise<{ last: number; posts: number }> }).play(2));
      const played = await p.evaluate(() => (window as unknown as { log: ProxyLog }).log);
      const renders = played.probes.slice(before);
      // About one render per frame posted (a ratio, not a rate: a slow machine posts fewer). Waiting
      // two animation frames after each render held it to at most half.
      assert.ok(renders.length >= 0.65 * posts, `${renders.length} renders for ${posts} frames posted`);
      assert.ok(played.proxied > 0, "no picture was asked with p while playing");
      // The proxy's half-size picture is given at the exact size: the frame's right half is footage.
      for (const r of renders) assert.deepEqual([r.w, r.h], [W, H], `a ${r.w}×${r.h} picture at t ${r.t}`);
      const empty = renders.filter((r) => r.r < 12).length;
      assert.equal(empty, 0, `${empty} renders left the frame's right half empty`);
      // Stopped: the exact picture asked for (never the proxy's from the cache) and drawn.
      const exactBefore = played.exact;
      await p.evaluate((f) => (window as unknown as { stop: (f: number) => void }).stop(f), last);
      const n = Math.floor((0.1 + last / FPS) * CLIP_FPS + 1e-6);
      await p
        .waitForFunction(
          (m) => {
            const l = (window as unknown as { log: ProxyLog }).log;
            const q = l.probes.at(-1)!;
            return Math.round((q.r - 16) / 2) === m && l.exact > 0;
          },
          { timeout: 5_000 },
          n,
        )
        .catch(() => {});
      const stopped = await p.evaluate(() => (window as unknown as { log: ProxyLog }).log);
      assert.ok(stopped.exact > exactBefore, "the stop frame's exact picture wasn't asked for");
      assert.equal(decode(stopped.probes.at(-1)!.r), n, "the frame playback stopped on isn't the exact one");
    } finally {
      await p.close();
    }
  },
);
