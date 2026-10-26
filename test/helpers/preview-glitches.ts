// Issue #55: counts what the preview gets wrong while it plays or scrubs a busy project, sampled once
// per animation frame in the app's renderer and classified here (a pure function, unit-tested in
// test/media/preview-glitches.test.ts):
// - flash: a layer the playhead is inside, already drawn, isn't drawn in a later sample (a <video>
//   with no frame, every picture of it hidden, its box gone), until it's drawn again: one per run;
// - late: a layer still not drawn `lateMs` after the playhead entered it (one per layer and visit);
// - look flash: a clip with picture effects drawn without them after it had them (a lost WebGL
//   context shows the plain picture);
// - stale: while playing, a <video> more than `staleS` from the source time the playhead asks for
//   (one per run), and frozen: one that presented no new frame for `frozenMs`;
// - order: a sample where two drawn layers stack against their tracks' order;
// - long frames: animation frames over `longMs`.
// Layers within `edgeFrames` of their start or end aren't judged (the playhead and the picture may
// be a frame apart there), nor anything in the first `settleMs` after playback starts.
import type { Page } from "puppeteer-core";

/** A layer of the project under test, as the test wrote it. `track`: 0 is the top track. */
export interface GlitchLayer {
  readonly id: string;
  readonly kind: "video" | "text";
  readonly track: number;
  readonly start: number;
  readonly duration: number;
  /** Source frame at the clip's start (videos). */
  readonly in?: number;
  /** Whether it has picture effects (an effects canvas should show it). */
  readonly fx?: boolean;
}

/**
 * One layer in one sample: drawn, drawn with its effects, z-index, media time (s), frames presented,
 * seeking, and the media time of the picture on screen (`pt`: a <video>'s last presented frame, or
 * the decoded frame a D311 play canvas holds).
 */
export interface LayerSample {
  readonly d: boolean;
  readonly f?: boolean;
  readonly z: number;
  readonly mt?: number;
  readonly p?: number;
  readonly s?: boolean;
  readonly pt?: number;
}

export interface GlitchSample {
  /** performance.now() of the animation frame. */
  readonly t: number;
  /** The preview's frame (data-frame). */
  readonly frame: number;
  readonly playing: boolean;
  readonly layers: Readonly<Record<string, LayerSample>>;
}

export interface GlitchOptions {
  readonly fps: number;
  readonly lateMs?: number;
  readonly staleS?: number;
  readonly frozenMs?: number;
  readonly longMs?: number;
  readonly edgeFrames?: number;
  readonly settleMs?: number;
}

export interface GlitchCounts {
  flash: number;
  late: number;
  lookFlash: number;
  stale: number;
  frozen: number;
  order: number;
  longFrames: number;
  worstFrameMs: number;
  /** What each count was, for the log: "flash v3 @f251". */
  details: Array<string>;
}

export function countGlitches(samples: ReadonlyArray<GlitchSample>, layers: ReadonlyArray<GlitchLayer>, options: GlitchOptions): GlitchCounts {
  const { fps, lateMs = 1000, staleS = 0.25, frozenMs = 500, longMs = 100, edgeFrames = 2, settleMs = 600 } = options;
  const c: GlitchCounts = { flash: 0, late: 0, lookFlash: 0, stale: 0, frozen: 0, order: 0, longFrames: 0, worstFrameMs: 0, details: [] };
  const note = (kind: string, id: string, s: GlitchSample) => c.details.length < 200 && c.details.push(`${kind} ${id} @f${s.frame}`);
  type State = {
    inside: boolean;
    since: number;
    drawnOnce: boolean;
    flashing: boolean;
    lateCounted: boolean;
    fxOnce: boolean;
    lookFlashing: boolean;
    stale: boolean;
    lastP?: number;
    lastPAt: number;
    frozen: boolean;
  };
  const state = new Map<string, State>();
  let playingSince: number | undefined;
  let prev: GlitchSample | undefined;
  for (const s of samples) {
    if (prev) {
      const dt = s.t - prev.t;
      c.worstFrameMs = Math.max(c.worstFrameMs, dt);
      if (dt > longMs) {
        c.longFrames++;
        if (c.details.length < 200) c.details.push(`long frame ${dt.toFixed(0)} ms @f${s.frame}`);
      }
    }
    if (s.playing && !prev?.playing) playingSince = s.t;
    if (!s.playing) playingSince = undefined;
    const settled = playingSince === undefined || s.t - playingSince >= settleMs;
    // A jump (a click on the ruler, a long frame) starts every layer's visit over; steps don't.
    const jumped = !!prev && Math.abs(s.frame - prev.frame) > 3;
    for (const l of layers) {
      const inside = s.frame >= l.start + edgeFrames && s.frame < l.start + l.duration - edgeFrames;
      let st = state.get(l.id);
      if (!st || !st.inside || !inside || jumped) {
        st = {
          inside,
          since: s.t,
          drawnOnce: false,
          flashing: false,
          lateCounted: false,
          fxOnce: false,
          lookFlashing: false,
          stale: false,
          lastPAt: s.t,
          frozen: false,
        };
        state.set(l.id, st);
      }
      if (!inside) continue;
      const ls = s.layers[l.id];
      const drawn = !!ls?.d;
      if (drawn) {
        st.drawnOnce = true;
        st.flashing = false;
      } else if (st.drawnOnce && !st.flashing) {
        st.flashing = true;
        c.flash++;
        note("flash", l.id, s);
      } else if (!st.drawnOnce && !st.lateCounted && s.t - st.since > lateMs) {
        st.lateCounted = true;
        c.late++;
        note("late", l.id, s);
      }
      if (l.fx && drawn) {
        if (ls?.f) {
          st.fxOnce = true;
          st.lookFlashing = false;
        } else if (st.fxOnce && !st.lookFlashing) {
          st.lookFlashing = true;
          c.lookFlash++;
          note("look flash", l.id, s);
        }
      }
      if (l.kind !== "video" || !ls) continue;
      // Presented frames: a playing <video> that stops presenting is frozen on its last frame.
      if (ls.p !== undefined && ls.p !== st.lastP) {
        st.lastP = ls.p;
        st.lastPAt = s.t;
        st.frozen = false;
      }
      if (!s.playing || !settled || s.t - st.since < settleMs) {
        st.lastPAt = Math.max(st.lastPAt, s.t - frozenMs / 2);
        st.stale = false;
        continue;
      }
      if (!st.frozen && s.t - st.lastPAt > frozenMs) {
        st.frozen = true;
        c.frozen++;
        note("frozen", l.id, s);
      }
      if (ls.mt !== undefined) {
        const want = ((l.in ?? 0) + (s.frame - l.start)) / fps;
        const off = Math.abs(ls.mt - want) > staleS;
        if (off && !st.stale) {
          c.stale++;
          note(`stale (${(ls.mt - want).toFixed(2)} s)`, l.id, s);
        }
        st.stale = off;
      }
    }
    // Stacking: drawn layers' z-index against their tracks (a smaller track index is above).
    const drawnLayers = layers.filter((l) => s.layers[l.id]?.d && s.frame >= l.start + edgeFrames && s.frame < l.start + l.duration - edgeFrames);
    let wrong = false;
    for (let i = 0; i < drawnLayers.length && !wrong; i++)
      for (let j = 0; j < drawnLayers.length && !wrong; j++) {
        const a = drawnLayers[i]!;
        const b = drawnLayers[j]!;
        if (a.track < b.track && s.layers[a.id]!.z <= s.layers[b.id]!.z) {
          wrong = true;
          note(`order ${a.id} under ${b.id}`, a.id, s);
        }
      }
    if (wrong) c.order++;
    prev = s;
  }
  return c;
}

/**
 * Starts sampling the preview in the page, once per animation frame, for `ids` (clips' and texts'
 * item ids). What counts as drawn: a clip's box with a <video> that has a frame (or an <img> that's
 * loaded) shown, or its effects, scrub or play canvas (D311) shown (a shown effects canvas also counts
 * as "with effects"; so does a layer the GPU compositor draws); a graphic's iframe shown once it has
 * drawn a render(t) (its media time: the last one it drew); a text's element in the text layer, not hidden.
 */
export async function startGlitchProbe(page: Page, ids: ReadonlyArray<string>) {
  await page.evaluate(
    (ids: Array<string>) => {
      type L = { d: boolean; f?: boolean; z: number; mt?: number; p?: number; s?: boolean; pt?: number };
      type W = {
        __glitch?: {
          samples: Array<{ t: number; frame: number; playing: boolean; layers: Record<string, L> }>;
          stop: boolean;
          contextLost: number;
          playSeeks: number;
        };
      };
      const w = window as unknown as W;
      if (w.__glitch) w.__glitch.stop = true;
      const g = { samples: [] as Array<{ t: number; frame: number; playing: boolean; layers: Record<string, L> }>, stop: false, contextLost: 0, playSeeks: 0 };
      w.__glitch = g;
      document.addEventListener("webglcontextlost", () => g.contextLost++, true);
      const presented = new WeakMap<HTMLVideoElement, number>();
      const presentedAt = new WeakMap<HTMLVideoElement, number>();
      const watch = (v: HTMLVideoElement) => {
        if (presented.has(v)) return;
        presented.set(v, 0);
        const onFrame = (_: number, meta: VideoFrameCallbackMetadata) => {
          presented.set(v, (presented.get(v) ?? 0) + 1);
          presentedAt.set(v, meta.mediaTime);
          if (!g.stop) v.requestVideoFrameCallback(onFrame);
        };
        v.requestVideoFrameCallback(onFrame);
        v.addEventListener(
          "seeking",
          () => document.querySelector<HTMLElement>("[data-testid=preview-frame]")?.dataset.playing === "true" && !v.paused && g.playSeeks++,
        );
      };
      const frameEl = document.querySelector<HTMLElement>("[data-testid=preview-frame]")!;
      const text = document.querySelector<HTMLElement>("[data-testid=preview-text]")!;
      const shown = (el: HTMLElement | null | undefined): el is HTMLElement => !!el && el.style.visibility !== "hidden";
      const tick = (t: number) => {
        if (g.stop) return;
        const layers: Record<string, L> = {};
        for (const id of ids) {
          const sel = CSS.escape(id);
          const box = frameEl.querySelector<HTMLElement>(`.pv-box[data-item="${sel}"]`);
          if (box) {
            const v = box.querySelector<HTMLVideoElement>(":scope > video");
            const img = box.querySelector<HTMLImageElement>(":scope > img");
            const fx = box.querySelector<HTMLCanvasElement>("canvas[data-fx]");
            const scrub = box.querySelector<HTMLCanvasElement>("canvas[data-scrub]");
            const play = box.querySelector<HTMLCanvasElement>("canvas[data-play]");
            if (v) watch(v);
            const gpu = box.dataset.gpu !== undefined;
            const visible = (el: HTMLElement | null) => shown(el) && el!.style.opacity !== "0";
            const vOk = !!v && (visible(v) || gpu) && (v.readyState >= 2 || (v.seeking && v.videoWidth > 0));
            const iOk = !!img && (visible(img) || gpu) && img.complete && img.naturalWidth > 0;
            const fOk = !!fx && visible(fx) && fx.width > 0;
            const sOk = !!scrub && visible(scrub) && scrub.width > 0;
            // The play canvas is the clip's picture (shown, or read by its effects canvas or the GPU compositor).
            const pOk = !!play && play.dataset.shown === "true" && play.width > 0;
            layers[id] = {
              d: vOk || iOk || fOk || sOk || pOk,
              f: fOk || (gpu && (vOk || iOk || pOk)),
              z: Number(box.style.zIndex || 0),
              ...(pOk
                ? { mt: Number(play.dataset.time), p: Number(play.dataset.frames ?? 0), s: false, pt: Number(play.dataset.time) }
                : v
                  ? { mt: v.currentTime, p: presented.get(v) ?? 0, s: v.seeking, ...(presentedAt.has(v) ? { pt: presentedAt.get(v)! } : {}) }
                  : {}),
            };
            continue;
          }
          const graphic = frameEl.querySelector<HTMLElement>(`.pv-graphic[data-item="${sel}"]`);
          if (graphic) {
            const drawn = shown(graphic) && graphic.style.opacity !== "0" && graphic.dataset.time !== undefined;
            const time = Number(graphic.dataset.time);
            layers[id] = {
              d: drawn,
              z: Number(graphic.style.zIndex || 0),
              ...(drawn ? { mt: time, p: Number(graphic.dataset.frames ?? 0), s: false, pt: time } : {}),
            };
            continue;
          }
          const el = text.querySelector<HTMLElement>(`:scope > [data-item="${sel}"]`);
          if (el) layers[id] = { d: shown(el), z: Number(el.style.zIndex || 0) };
        }
        g.samples.push({ t, frame: Number(frameEl.dataset.frame), playing: frameEl.dataset.playing === "true", layers });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    [...ids],
  );
}

/** The samples taken since startGlitchProbe (sampling stops), with the page's own counters. */
export async function stopGlitchProbe(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __glitch: { samples: Array<GlitchSample>; stop: boolean; contextLost: number; playSeeks: number };
      __uncutPreview?: { stats?: () => { compositors: number; fxLost: number; playSeeks: number } };
    };
    w.__glitch.stop = true;
    return { samples: w.__glitch.samples, contextLost: w.__glitch.contextLost, playSeeks: w.__glitch.playSeeks, stats: w.__uncutPreview?.stats?.() };
  }) as Promise<{
    samples: Array<GlitchSample>;
    contextLost: number;
    playSeeks: number;
    stats: { compositors: number; fxLost: number; playSeeks: number } | undefined;
  }>;
}
