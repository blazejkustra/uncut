// The preview's playback mix (phase 4 chunk 5, D54). Every item that sounds at the playhead
// (core audibleAt: clips with sound and audio items, the gain from their volume, keys, fades, the
// track's volume and mute, transitions) plays through Web Audio:
//
//   media element → MediaElementAudioSourceNode → GainNode (per item) → track bus → master → analyser → speakers
//
// The track bus (D83) makes the sum stereo (mono at full level on both channels, as the speakers
// up-mixed it before), pans it with core panGains (left and right GainNodes between a splitter and
// a merger: exactly the export's per-channel factors, not a StereoPannerNode, whose law differs)
// and meters it (one AnalyserNode per channel, after the pan). The master GainNode is the project's
// master volume (core masterGain), metered the same way after it; the mono analyser after it stays
// the app tests' level().
//
// A clip that the preview shows already has a <video> (the Compositor's): its sound is routed from
// that element, so picture and sound come from one decoder and stay together. Audio items, and
// clips on a hidden track (hidden hides the picture, not the sound), get an <audio> element here,
// warmed up two seconds ahead like the next video, and kept in step with the playback clock the
// same way (seeked only when it drifts). Gains move by a short linear ramp once per animation
// frame towards the value one ramp ahead, so volume and fades follow smoothly and a cut starts or
// stops with a ~17 ms ramp instead of a click. Paused or scrubbing: silent.
//
// The file:// renderer can only hear an element through Web Audio if the media was fetched in
// CORS mode: elements get crossOrigin="anonymous" before their src, and the server's /media/file
// route allows it.
import { audibleAt, audioSpan, itemGain, masterGain, panGains, soundMedia, sourceAt, trackPan } from "@uncut/core/audio";

import { layoutOf, type Item, type ProjectModel } from "./project.ts";
import { mediaUrl } from "./store.ts";

/** How long a gain change takes (one display frame): smooth, and short enough to feel immediate. */
const RAMP_S = 1 / 60;
/** Seek a playing element when it is this far from where the clock says it should be. */
const DRIFT_S = 0.12;
/** Audio items starting this soon get their element ready. */
const WARM_S = 2;
/** ...and this soon (while playing) it already runs, silent, so a cut doesn't wait for it to start. */
export const PREROLL_S = 0.3;
// When an element was first seen playing (its currentTime then), to tell when it really runs.
const startedAt = new WeakMap<HTMLMediaElement, number>();

interface Route {
  readonly source: MediaElementAudioSourceNode;
  readonly gain: GainNode;
  /** The gain last asked for (the AudioParam ramps towards it). */
  target: number;
  /** The track bus its gain feeds (items move between tracks). */
  bus?: Bus;
  /** Moving to another bus: ramping down until this context time, then rewired (no click). */
  rewiring?: number;
}

/** A reroute or a dropped bus first ramps to silence over this long, so it doesn't click. */
const UNWIRE_S = 0.01;

/** A track's bus (D83): stereo up-mix → pan (a gain per channel) → master, with a meter per channel. */
interface Bus {
  readonly input: GainNode;
  readonly splitter: ChannelSplitterNode;
  readonly left: GainNode;
  readonly right: GainNode;
  readonly merger: ChannelMergerNode;
  readonly meters: readonly [AnalyserNode, AnalyserNode];
}

/** A channel's level over the analyser's window: RMS and peak, linear (1 = full scale). */
export interface Level {
  readonly rms: number;
  readonly peak: number;
}
/** Left and right levels of a strip. */
export interface StereoLevel {
  readonly left: Level;
  readonly right: Level;
}
export interface Levels {
  readonly master: StereoLevel;
  readonly tracks: Readonly<Record<string, StereoLevel>>;
}
const SILENT: StereoLevel = { left: { rms: 0, peak: 0 }, right: { rms: 0, peak: 0 } };

/** What the test hook and the timeline can read about the mix. */
export interface MixState {
  readonly state: AudioContextState | "none";
  readonly items: ReadonlyArray<{ readonly id: string; readonly gain: number; readonly playing: boolean; readonly own: boolean }>;
}

// Where an element was last asked to be; while a seek runs only the newest target is kept.
const wanted = new WeakMap<HTMLMediaElement, number>();
const reachable = (el: HTMLMediaElement, t: number) => (Number.isFinite(el.duration) && el.duration > 0 ? Math.min(Math.max(0, t), Math.max(0, el.duration - 0.001)) : Math.max(0, t));
function seek(el: HTMLMediaElement, t: number) {
  const target = reachable(el, t);
  wanted.set(el, target);
  if (!el.seeking && Math.abs(el.currentTime - target) > 0.004) el.currentTime = target;
}

export class Mix {
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private analyser: AnalyserNode | undefined;
  private masterMeters: readonly [AnalyserNode, AnalyserNode] | undefined;
  private readonly buses = new Map<string, Bus>();
  /** The pan factors and master gain last asked for (ramped towards). */
  private readonly panTarget = new WeakMap<Bus, { left: number; right: number }>();
  private masterTarget = 1;
  /** Test-only capture of the master output (see capture()). */
  private tap: Capture | undefined;
  private marks: Array<{ t: number; frame: number }> = [];
  private readonly routes = new WeakMap<HTMLMediaElement, Route>();
  /** Elements the Compositor shows, by item id (registered with attach). */
  private readonly shown = new Map<string, HTMLVideoElement>();
  /** <audio> elements this mix owns, by item id. */
  private readonly own = new Map<string, HTMLAudioElement>();
  /** The element each sounding item is heard through. */
  private readonly active = new Map<string, { el: HTMLMediaElement }>();
  /** Items waiting to hand over to another element, since when (performance.now()). */
  private readonly handover = new Map<string, number>();
  /** Elements ramping to 0 after they stopped sounding, kept until this context time (no click at an end or a cut). */
  private readonly fading = new Map<HTMLMediaElement, number>();
  private last: MixState = { state: "none", items: [] };

  /** The audio graph, made on first use (an AudioContext can't be made before the page runs). */
  private graph() {
    if (!this.ctx) {
      try {
        const ctx = new AudioContext({ latencyHint: "interactive" });
        const master = ctx.createGain();
        master.gain.value = this.masterTarget;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        master.connect(analyser);
        analyser.connect(ctx.destination);
        // The master strip's meters: the output split into its two channels.
        const split = ctx.createChannelSplitter(2);
        const meters = [ctx.createAnalyser(), ctx.createAnalyser()] as const;
        for (const m of meters) m.fftSize = 2048;
        master.connect(split);
        split.connect(meters[0], 0);
        split.connect(meters[1], 1);
        this.ctx = ctx;
        this.master = master;
        this.analyser = analyser;
        this.masterMeters = meters;
      } catch {
        return undefined;
      }
    }
    return { ctx: this.ctx, master: this.master!, analyser: this.analyser! };
  }

  /** Route an element's sound through its own gain (once per element: Web Audio allows no more). */
  private route(el: HTMLMediaElement): Route | undefined {
    const known = this.routes.get(el);
    if (known) return known;
    const g = this.graph();
    if (!g) return undefined;
    try {
      const source = g.ctx.createMediaElementSource(el);
      const gain = g.ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      // Until render() wires it to its track's bus, straight to the master.
      gain.connect(g.master);
      // From now on the element is heard only through the graph; muted would silence its input.
      el.muted = false;
      const route = { source, gain, target: 0 };
      this.routes.set(el, route);
      return route;
    } catch {
      return undefined;
    }
  }

  /** Whether an element is still in use: sounding for an item, or ramping down after it. */
  holds(el: HTMLMediaElement | undefined): boolean {
    if (!el) return false;
    for (const a of this.active.values()) if (a.el === el) return true;
    if (!this.ctx) return false;
    const until = this.fading.get(el);
    if (until === undefined) return false;
    if (this.ctx.currentTime < until) return true;
    this.fading.delete(el);
    return false;
  }

  private unroute(el: HTMLMediaElement) {
    this.fading.delete(el);
    const route = this.routes.get(el);
    if (!route) return;
    route.source.disconnect();
    route.gain.disconnect();
    this.routes.delete(el);
  }

  /** The bus of a track, made on first use. */
  private bus(trackId: string): Bus | undefined {
    const known = this.buses.get(trackId);
    if (known) return known;
    const g = this.graph();
    if (!g) return undefined;
    const ctx = g.ctx;
    // Explicit stereo with speaker up-mixing: a mono source plays at full level on both channels.
    const input = ctx.createGain();
    input.channelCount = 2;
    input.channelCountMode = "explicit";
    input.channelInterpretation = "speakers";
    const splitter = ctx.createChannelSplitter(2);
    const left = ctx.createGain();
    const right = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    const meters = [ctx.createAnalyser(), ctx.createAnalyser()] as const;
    for (const m of meters) m.fftSize = 2048;
    input.connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    left.connect(meters[0]);
    right.connect(meters[1]);
    merger.connect(g.master);
    const bus = { input, splitter, left, right, merger, meters };
    this.buses.set(trackId, bus);
    return bus;
  }

  private dropBus(trackId: string) {
    const bus = this.buses.get(trackId);
    if (!bus) return;
    this.buses.delete(trackId);
    const nodes = [bus.input, bus.splitter, bus.left, bus.right, bus.merger];
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return nodes.forEach((n) => n.disconnect());
    // Ramp its output down first, then let go of it.
    for (const g of [bus.left.gain, bus.right.gain]) {
      g.cancelScheduledValues(ctx.currentTime);
      g.setValueAtTime(g.value, ctx.currentTime);
      g.linearRampToValueAtTime(0, ctx.currentTime + UNWIRE_S);
    }
    setTimeout(() => nodes.forEach((n) => n.disconnect()), UNWIRE_S * 1000 + 15);
  }

  /** Feed a route into another bus: at once when it is silent, else after a short ramp down (the next render ramps it back up). */
  private rewire(route: Route, bus: Bus) {
    const ctx = this.ctx!;
    if (route.rewiring !== undefined) return;
    const connect = () => {
      route.gain.disconnect();
      route.gain.connect(bus.input);
      route.bus = bus;
      route.rewiring = undefined;
    };
    if (route.gain.gain.value === 0 || ctx.state !== "running") return connect();
    const param = route.gain.gain;
    param.cancelScheduledValues(ctx.currentTime);
    param.setValueAtTime(param.value, ctx.currentTime);
    param.linearRampToValueAtTime(0, ctx.currentTime + UNWIRE_S);
    route.target = 0;
    route.rewiring = ctx.currentTime + UNWIRE_S;
    setTimeout(connect, UNWIRE_S * 1000 + 5);
  }

  /** Move an AudioParam towards a value with the usual short ramp. */
  private glide(param: AudioParam, target: number) {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + RAMP_S);
  }

  /** Pan every sounding track's bus and set the master volume (D83); drop buses of tracks that went. */
  private mixer(project: ProjectModel) {
    if (!this.ctx) {
      this.masterTarget = masterGain(project);
      return;
    }
    const ids = new Set(project.tracks.map((t) => t.id));
    for (const id of [...this.buses.keys()]) if (!ids.has(id)) this.dropBus(id);
    for (const track of project.tracks) {
      const bus = this.buses.get(track.id);
      if (!bus) continue;
      const want = panGains(trackPan(track));
      const had = this.panTarget.get(bus);
      if (had && had.left === want.left && had.right === want.right) continue;
      this.panTarget.set(bus, { ...want });
      if (had) {
        this.glide(bus.left.gain, want.left);
        this.glide(bus.right.gain, want.right);
      } else {
        bus.left.gain.value = want.left;
        bus.right.gain.value = want.right;
      }
    }
    const master = masterGain(project);
    if (master !== this.masterTarget && this.master) {
      this.masterTarget = master;
      this.glide(this.master.gain, master);
    }
  }

  private ramp(route: Route, target: number) {
    const ctx = this.ctx!;
    if (route.target === target && route.gain.gain.value === target) return;
    route.target = target;
    const now = ctx.currentTime;
    const param = route.gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + RAMP_S);
  }

  /** The Compositor shows (or warms up) a <video> for a clip with sound: its sound can come through here. */
  attach(itemId: string, el: HTMLVideoElement) {
    this.shown.set(itemId, el);
  }

  /**
   * The Compositor stopped showing a clip's <video> (it ended, or its track was hidden). The mix
   * may still hold it for a moment (see holds) while its sound hands over or ramps down.
   */
  unshow(itemId: string, el: HTMLVideoElement) {
    if (this.shown.get(itemId) === el) this.shown.delete(itemId);
  }

  /** The Compositor is dropping a <video>. */
  detach(itemId: string, el: HTMLVideoElement) {
    this.unshow(itemId, el);
    for (const [id, a] of this.active) if (a.el === el) this.active.delete(id);
    this.unroute(el);
  }

  private ownElement(item: Item, project: ProjectModel): HTMLAudioElement | undefined {
    const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
    const src = media ? mediaUrl(media.id, media.path) : undefined;
    if (!src) return undefined;
    let el = this.own.get(item.id);
    if (el && el.dataset.src === src) return el;
    if (el) this.dropOwn(item.id);
    el = document.createElement("audio");
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    el.dataset.item = item.id;
    el.dataset.src = src;
    el.addEventListener("seeked", () => {
      const want = wanted.has(el!) ? reachable(el!, wanted.get(el!)!) : undefined;
      if (want !== undefined && Math.abs(el!.currentTime - want) > 0.004) {
        wanted.set(el!, want);
        el!.currentTime = want;
      } else wanted.delete(el!);
    });
    el.src = src;
    this.own.set(item.id, el);
    return el;
  }

  private dropOwn(id: string) {
    const el = this.own.get(id);
    if (!el) return;
    for (const [item, a] of this.active) if (a.el === el) this.active.delete(item);
    this.unroute(el);
    el.pause();
    el.removeAttribute("src");
    el.load();
    this.own.delete(id);
  }

  /** Ramp an element down; it is kept (holds) until the ramp has landed. */
  private retire(el: HTMLMediaElement) {
    const route = this.routes.get(el);
    if (route && this.ctx) {
      this.ramp(route, 0);
      this.fading.set(el, this.ctx.currentTime + RAMP_S + 0.015);
    }
  }

  /** Playing for real: started, loaded, not seeking, and its time has moved since it started. */
  private ready(el: HTMLMediaElement) {
    if (el.paused || el.seeking || el.readyState < 3) {
      startedAt.delete(el);
      return false;
    }
    const first = startedAt.get(el);
    if (first === undefined) {
      startedAt.set(el, el.currentTime);
      return false;
    }
    return el.currentTime > first + 0.02;
  }

  /** Bring the mix to frame `frame` of `project` (called by the Compositor on every redraw). */
  render(project: ProjectModel, frame: number, playing: boolean) {
    const fps = project.canvas.fps;
    const { starts } = layoutOf(project);
    const g = playing ? this.graph() : this.ctx ? { ctx: this.ctx } : undefined;
    if (playing && g?.ctx.state === "suspended") void g.ctx.resume().catch(() => {});
    const audible = audibleAt(project, starts, frame);
    const audibleIds = new Set(audible.map((a) => a.item.id));
    const keepOwn = new Set<string>();
    const items: Array<{ id: string; gain: number; playing: boolean; own: boolean }> = [];
    // Each gain heads for its value one ramp from now, when the ramp lands.
    const ahead = frame + (playing ? RAMP_S * fps : 0);
    const nowMs = performance.now();

    // Items that stopped sounding (ended, deleted, muted out of the list): ramp down.
    for (const [id, a] of [...this.active]) {
      if (audibleIds.has(id)) continue;
      this.active.delete(id);
      this.handover.delete(id);
      this.retire(a.el);
    }

    for (const a of audible) {
      const id = a.item.id;
      const index = a.track.items.indexOf(a.item);
      const start = starts.get(id) ?? 0;
      const local = Math.min(ahead, audioSpan(a.track, index, start).to - 1e-6) - start;
      const gain = a.muted ? 0 : itemGain(a.track, index, local);
      const video = this.shown.get(id);
      const preferred: HTMLMediaElement | undefined = video ?? this.ownElement(a.item, project);
      if (!preferred) continue;
      if (!video) {
        keepOwn.add(id);
        this.drive(preferred, a.item, a.source, playing);
      }
      let cur = this.active.get(id)?.el;
      if (cur && cur !== preferred) {
        // Another element takes over (a track hidden or shown mid-play): the old one keeps
        // sounding until the new one is really playing, then they swap with a ramp. Paused, or
        // after a second of waiting, they swap at once.
        const since = this.handover.get(id) ?? nowMs;
        this.handover.set(id, since);
        if (!playing || this.ready(preferred) || nowMs - since > 1000) {
          this.retire(cur);
          this.handover.delete(id);
          cur = undefined;
        } else {
          // Keep the outgoing one going: an <audio> of ours is still driven; a <video> the
          // Compositor no longer shows plays on by itself for these few frames.
          if (this.own.get(id) === cur) {
            keepOwn.add(id);
            this.drive(cur, a.item, a.source, playing);
          }
          const route = this.route(preferred);
          if (route) this.ramp(route, 0);
        }
      }
      if (!cur) {
        cur = preferred;
        this.active.set(id, { el: cur });
        this.fading.delete(cur);
      }
      items.push({ id, gain: playing ? gain : 0, playing: playing && !cur.paused, own: this.own.get(id) === cur });
      if (!this.ctx && !playing) continue;
      const route = this.route(cur);
      if (route) {
        const bus = this.bus(a.track.id);
        if (bus && route.bus !== bus) this.rewire(route, bus);
        if (route.rewiring === undefined) this.ramp(route, playing ? gain : 0);
      }
    }
    this.mixer(project);
    if (this.tap && this.ctx) this.marks.push({ t: this.ctx.currentTime, frame });

    // Audio items (and clips on hidden tracks) about to start: ready at their first frame and
    // silent. Just before they start (while playing) they already run, so a cut overlaps two
    // playing elements instead of waiting for one to start.
    for (const track of project.tracks) {
      track.items.forEach((item, index) => {
        if (keepOwn.has(item.id) || this.shown.has(item.id) || !soundMedia(project, item)) return;
        // Clips on a visible track get their <video> from the Compositor, which warms it up.
        if (item.type === "clip" && !track.hidden) return;
        const start = starts.get(item.id) ?? 0;
        const from = audioSpan(track, index, start).from;
        if (from <= frame || from - frame > WARM_S * fps) return;
        const el = this.ownElement(item, project);
        if (!el) return;
        keepOwn.add(item.id);
        const early = sourceAt(project, item, frame - start);
        if (playing && from - frame <= PREROLL_S * fps && (item.in ?? 0) + (frame - start) * (item.speed ?? 1) >= 0) {
          this.drive(el, item, early, true);
          const route = this.route(el);
          if (route) this.ramp(route, 0);
        } else {
          if (!el.paused) el.pause();
          seek(el, sourceAt(project, item, from - start));
        }
      });
    }

    // Compositor <video>s held for a handover or a ramp don't get paused by it: pause them here.
    if (!playing) for (const [el] of this.fading) if (!el.paused && !(el instanceof HTMLAudioElement)) el.pause();
    for (const [id, el] of [...this.own]) if (!keepOwn.has(id) && !this.holds(el)) this.dropOwn(id);
    this.last = { state: this.ctx?.state ?? "none", items };
  }

  /** Keep an element this mix owns in step with the clock (the Compositor does this for video). */
  private drive(el: HTMLMediaElement, item: Item, source: number, playing: boolean) {
    const rate = item.speed ?? 1;
    if (el.playbackRate !== rate) {
      el.playbackRate = rate;
      el.preservesPitch = true;
    }
    el.loop = item.loop === true;
    const target = source + 0.0001;
    if (playing) {
      if (el.paused) {
        seek(el, target);
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - target) > DRIFT_S * Math.max(1, rate)) {
        // A looped item wraps by itself; its clock wraps too, a little off from the file's end.
        const length = Number.isFinite(el.duration) ? el.duration : 0;
        if (!(el.loop && length > 0 && Math.abs(Math.abs(el.currentTime - target) - length) < DRIFT_S)) seek(el, target);
      }
    } else {
      if (!el.paused) el.pause();
      seek(el, target);
    }
  }

  /** Silence everything (another project, the preview going away). */
  stop() {
    for (const id of [...this.own.keys()]) this.dropOwn(id);
    this.shown.clear();
    this.active.clear();
    this.handover.clear();
    this.fading.clear();
    this.last = { state: this.ctx?.state ?? "none", items: [] };
  }

  destroy() {
    this.stop();
    for (const id of [...this.buses.keys()]) this.dropBus(id);
    void this.ctx?.close().catch(() => {});
    this.ctx = undefined;
  }

  state(): MixState {
    return this.last;
  }

  /** Left and right levels of the master and of every track bus (the Mixer's meters), from the last ~43 ms. */
  levels(): Levels {
    const read = (meters: readonly [AnalyserNode, AnalyserNode] | undefined): StereoLevel => (meters ? { left: levelOf(meters[0]), right: levelOf(meters[1]) } : SILENT);
    const tracks: Record<string, StereoLevel> = {};
    for (const [id, bus] of this.buses) tracks[id] = read(bus.meters);
    return { master: read(this.masterMeters), tracks };
  }

  /**
   * Test-only: record what the master puts out (after the master volume), sample for sample, with
   * the context time of each block and, from render(), which frame was drawn at which context
   * time. The app tests compare it with the export's mix (D83). Nothing else uses it.
   */
  capture(): { stop: () => CaptureResult } | undefined {
    const g = this.graph();
    if (!g) return undefined;
    const node = g.ctx.createScriptProcessor(4096, 2, 2);
    const sink = g.ctx.createGain();
    sink.gain.value = 0;
    const tap: Capture = { node, sink, blocks: [] };
    node.onaudioprocess = (e) => {
      tap.blocks.push({ t: e.playbackTime, left: e.inputBuffer.getChannelData(0).slice(), right: e.inputBuffer.getChannelData(1).slice() });
    };
    g.master.connect(node);
    node.connect(sink);
    sink.connect(g.ctx.destination);
    this.tap = tap;
    this.marks = [];
    return {
      stop: () => {
        g.master.disconnect(node);
        node.disconnect();
        sink.disconnect();
        node.onaudioprocess = null;
        if (this.tap === tap) this.tap = undefined;
        return { sampleRate: g.ctx.sampleRate, blocks: tap.blocks, marks: this.marks };
      },
    };
  }

  /** The master output's level right now: RMS and peak of the last ~43 ms (0 when nothing plays). */
  level(): { rms: number; peak: number } {
    return this.analyser ? levelOf(this.analyser) : { rms: 0, peak: 0 };
  }
}

interface Capture {
  readonly node: ScriptProcessorNode;
  readonly sink: GainNode;
  readonly blocks: Array<{ t: number; left: Float32Array; right: Float32Array }>;
}
export interface CaptureResult {
  readonly sampleRate: number;
  readonly blocks: ReadonlyArray<{ readonly t: number; readonly left: Float32Array; readonly right: Float32Array }>;
  readonly marks: ReadonlyArray<{ readonly t: number; readonly frame: number }>;
}

const buffers = new WeakMap<AnalyserNode, Float32Array<ArrayBuffer>>();
/** RMS and peak of an analyser's window. */
function levelOf(analyser: AnalyserNode): Level {
  let buf = buffers.get(analyser);
  if (!buf) buffers.set(analyser, (buf = new Float32Array(analyser.fftSize)));
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  let peak = 0;
  for (const v of buf) {
    sum += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  return { rms: Math.sqrt(sum / buf.length), peak };
}

// A read-only hook for the app tests (and for poking at the mix in DevTools): the live mix's
// level and gains. It changes nothing.
let current: Mix | undefined;
export const setCurrentMix = (mix: Mix | undefined) => {
  current = mix;
};
export const currentMix = () => current;
let capturing: { stop: () => CaptureResult } | undefined;
const b64 = (a: Float32Array) => {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
(globalThis as { __uncutAudio?: unknown }).__uncutAudio = {
  level: () => current?.level() ?? { rms: 0, peak: 0 },
  levels: () => current?.levels() ?? { master: SILENT, tracks: {} },
  state: () => current?.state() ?? { state: "none", items: [] },
  // Test-only (D83): record the master output; stop returns the samples (float32, base64 per
  // channel), the context time of the first one, and the frame drawn at each context time.
  startCapture: () => {
    capturing = current?.capture();
    return capturing !== undefined;
  },
  stopCapture: () => {
    const r = capturing?.stop();
    capturing = undefined;
    if (!r || !r.blocks.length) return undefined;
    const n = r.blocks.reduce((s, b) => s + b.left.length, 0);
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    let o = 0;
    for (const b of r.blocks) {
      left.set(b.left, o);
      right.set(b.right, o);
      o += b.left.length;
    }
    return { sampleRate: r.sampleRate, t0: r.blocks[0]!.t, left: b64(left), right: b64(right), marks: r.marks };
  },
};
