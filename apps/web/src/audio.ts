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
// Track effects (D84): each bus runs its track's stages (core trackStages, the preview's: noise
// removal is export-only, D88) between its input and its pan, as the export filters each track's
// sum: BiquadFilterNodes for the EQ (the cookbook curves core biquadResponseDb states; Web Audio
// takes a high-/low-pass Q in dB) and a DynamicsCompressorNode with a gain after it that cancels
// its built-in make-up gain (core makeupCompensationDb) and adds the effect's own. Ducking (D85) is
// core's duck curve added to each item's gain on the ducked track (ducking.ts duckCurvesOf), the
// export's numbers. The master limiter (D86) follows the master volume: a hard-knee
// DynamicsCompressor (ratio 20, compensated) working LIMITER_MARGIN_DB under the ceiling, as the
// export's alimiter does, and a clip at the ceiling, so the preview never goes over it either;
// the meters, level() and the capture read after it.
//
// The file:// renderer can only hear an element through Web Audio if the media was fetched in
// CORS mode: elements get crossOrigin="anonymous" before their src, and the server's /media/file
// route allows it.
import { audibleAt, audioSpan, itemGain, masterGain, panGains, soundMedia, sourceAt, trackPan } from "@uncut/core/audio";
import { duckDbAt } from "@uncut/core/ducking";
import { LIMITER_MARGIN_DB, makeupCompensationDb, masterLimiter, trackStages, type Stage } from "@uncut/core/effects";

import { duckCurvesOf } from "./ducking.ts";

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

/** A track's bus (D83): stereo up-mix → its effects (D84) → pan (a gain per channel) → master, with a meter per channel. */
interface Bus {
  readonly input: GainNode;
  /** The effect stages' nodes between input and splitter (empty: input feeds the splitter). */
  chain: StageChain;
  readonly splitter: ChannelSplitterNode;
  readonly left: GainNode;
  readonly right: GainNode;
  readonly merger: ChannelMergerNode;
  readonly meters: readonly [AnalyserNode, AnalyserNode];
}

/** dB → linear (no cutoff: for node parameters). */
const lin = (db: number) => 10 ** (db / 20);

/** The nodes of a chain of effect stages, and how to set their parameters without rebuilding. */
export interface StageChain {
  /** Kinds and types in order: a chain with the same shape is updated in place. */
  readonly shape: string;
  readonly first: AudioNode | undefined;
  readonly last: AudioNode | undefined;
  readonly nodes: ReadonlyArray<AudioNode>;
  /** Set every parameter from `stages` (same shape), gliding over `ramp` seconds (0: at once). */
  readonly set: (stages: ReadonlyArray<Stage>, ramp: number) => void;
  /** Compressors' gain reduction now (dB, ≤ 0), the deepest. */
  readonly reduction: () => number;
}
export const stageShape = (stages: ReadonlyArray<Stage>) => stages.map((s) => (s.kind === "biquad" ? s.type : s.kind)).join(",");

/**
 * Web Audio nodes for effect stages (D84), in order, connected one to the next. Noise removal has
 * no preview node (D88: export only; trackStages leaves it out for the preview). Works on any
 * context (the live mix, and the app tests' OfflineAudioContext checks).
 */
export function buildStages(ctx: BaseAudioContext, stages: ReadonlyArray<Stage>): StageChain {
  type Part = { readonly stage: Stage["kind"]; readonly nodes: ReadonlyArray<AudioNode>; readonly set: (s: Stage, at: (p: AudioParam, v: number) => void) => void };
  const parts: Array<Part> = [];
  for (const stage of stages) {
    if (stage.kind === "biquad") {
      const f = ctx.createBiquadFilter();
      f.type = stage.type;
      parts.push({
        stage: "biquad",
        nodes: [f],
        set: (s, at) => {
          if (s.kind !== "biquad") return;
          at(f.frequency, s.freq);
          // Web Audio: a high-/low-pass's Q is in dB (20·log10 of the cookbook's Q); a peak's is linear; shelves ignore it (slope 1).
          at(f.Q, s.type === "highpass" || s.type === "lowpass" ? 20 * Math.log10(s.q) : s.q);
          at(f.gain, s.gainDb);
        },
      });
    } else if (stage.kind === "compressor") {
      const c = ctx.createDynamicsCompressor();
      const g = ctx.createGain();
      c.knee.value = 0;
      c.connect(g);
      parts.push({
        stage: "compressor",
        nodes: [c, g],
        set: (s, at) => {
          if (s.kind !== "compressor") return;
          at(c.threshold, s.thresholdDb);
          at(c.ratio, s.ratio);
          at(c.attack, s.attackMs / 1000);
          at(c.release, s.releaseMs / 1000);
          at(g.gain, lin(s.makeupDb - makeupCompensationDb(s.thresholdDb, s.ratio)));
        },
      });
    }
  }
  for (let i = 1; i < parts.length; i++) parts[i - 1]!.nodes.at(-1)!.connect(parts[i]!.nodes[0]!);
  const apply = (list: ReadonlyArray<Stage>, ramp: number) => {
    const shown = list.filter((s) => s.kind !== "denoise");
    const now = ctx.currentTime;
    const at = (p: AudioParam, v: number) => {
      if (ramp <= 0) {
        p.cancelScheduledValues(now);
        p.value = v;
        return;
      }
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(v, now + ramp);
    };
    shown.forEach((s, i) => parts[i]?.set(s, at));
  };
  apply(stages, 0);
  const compressors = parts.filter((p) => p.stage === "compressor").map((p) => p.nodes[0] as DynamicsCompressorNode);
  return {
    shape: stageShape(stages.filter((s) => s.kind !== "denoise")),
    first: parts[0]?.nodes[0],
    last: parts.at(-1)?.nodes.at(-1),
    nodes: parts.flatMap((p) => p.nodes),
    set: apply,
    reduction: () => compressors.reduce((m, c) => Math.min(m, c.reduction), 0),
  };
}

/** The limiter's release (s) and attack (s): close to the export's alimiter (50 ms; its 5 ms lookahead is an attack here). */
const LIMITER_RELEASE_S = 0.05;
const LIMITER_ATTACK_S = 0.001;
/** A hard clip at ±ceiling (linear), as a WaveShaper curve: identity inside, flat outside (input past ±1 maps to the ends). */
function clipCurve(ceiling: number): Float32Array<ArrayBuffer> {
  const n = 4097;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.max(-ceiling, Math.min(ceiling, x));
  }
  return curve;
}

/** The master limiter's nodes (D86): compressor → compensation gain → clip. */
export interface LimiterNodes {
  readonly input: DynamicsCompressorNode;
  readonly gain: GainNode;
  readonly clip: WaveShaperNode;
  ceilingDb: number;
}
export function buildLimiter(ctx: BaseAudioContext, ceilingDb: number): LimiterNodes {
  const input = ctx.createDynamicsCompressor();
  input.knee.value = 0;
  input.ratio.value = 20;
  input.attack.value = LIMITER_ATTACK_S;
  input.release.value = LIMITER_RELEASE_S;
  const gain = ctx.createGain();
  const clip = ctx.createWaveShaper();
  clip.oversample = "none";
  input.connect(gain);
  gain.connect(clip);
  const nodes: LimiterNodes = { input, gain, clip, ceilingDb };
  setLimiter(nodes, ceilingDb);
  return nodes;
}
/** The compressor works LIMITER_MARGIN_DB under the ceiling, as the export's alimiter does; the clip is at the ceiling itself. */
function setLimiter(l: LimiterNodes, ceilingDb: number) {
  l.ceilingDb = ceilingDb;
  const threshold = ceilingDb - LIMITER_MARGIN_DB;
  l.input.threshold.value = threshold;
  l.gain.gain.value = lin(-makeupCompensationDb(threshold, 20));
  l.clip.curve = clipCurve(lin(ceilingDb));
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
  /** The master limiter's gain reduction now (dB, ≤ 0; 0 when off or idle), D86. */
  readonly limiter: number;
  /** Each bus's compressors' gain reduction now (dB, ≤ 0), D84. */
  readonly reduction: Readonly<Record<string, number>>;
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
  /** The stages each bus was last set to (JSON), so unchanged ones are skipped. */
  private readonly stageKeys = new WeakMap<Bus, string>();
  private masterTarget = 1;
  /** After the limiter: what the speakers, meters and capture get. */
  private post: GainNode | undefined;
  private limiter: LimiterNodes | undefined;
  /** Whether the master feeds the limiter (it is wired) and what the project asks for. */
  private limiterOn = false;
  private limiterTarget: { readonly ceilingDb: number } | undefined = { ceilingDb: -1 };
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
        // After the master volume: the limiter (D86, wired by mixer()), then `post`, what is heard and metered.
        const post = ctx.createGain();
        const limiter = buildLimiter(ctx, this.limiterTarget?.ceilingDb ?? -1);
        limiter.clip.connect(post);
        master.connect(this.limiterTarget ? limiter.input : post);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        post.connect(analyser);
        analyser.connect(ctx.destination);
        // The master strip's meters: the output split into its two channels.
        const split = ctx.createChannelSplitter(2);
        const meters = [ctx.createAnalyser(), ctx.createAnalyser()] as const;
        for (const m of meters) m.fftSize = 2048;
        post.connect(split);
        split.connect(meters[0], 0);
        split.connect(meters[1], 1);
        this.ctx = ctx;
        this.post = post;
        this.limiter = limiter;
        this.limiterOn = this.limiterTarget !== undefined;
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
    const bus: Bus = { input, chain: buildStages(ctx, []), splitter, left, right, merger, meters };
    this.buses.set(trackId, bus);
    return bus;
  }

  private dropBus(trackId: string) {
    const bus = this.buses.get(trackId);
    if (!bus) return;
    this.buses.delete(trackId);
    const nodes = [bus.input, ...bus.chain.nodes, bus.splitter, bus.left, bus.right, bus.merger];
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
    this.limiterTarget = masterLimiter(project);
    if (!this.ctx) {
      this.masterTarget = masterGain(project);
      return;
    }
    this.wireLimiter();
    const ids = new Set(project.tracks.map((t) => t.id));
    for (const id of [...this.buses.keys()]) if (!ids.has(id)) this.dropBus(id);
    for (const track of project.tracks) {
      const bus = this.buses.get(track.id);
      if (!bus) continue;
      this.effects(bus, trackStages(track, { preview: true }));
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

  /** A bus's effect chain to `stages` (D84): parameters glide when its shape is the same, else it is rebuilt between input and splitter. */
  private effects(bus: Bus, stages: ReadonlyArray<Stage>) {
    const key = JSON.stringify(stages);
    if (this.stageKeys.get(bus) === key) return;
    const had = this.stageKeys.has(bus);
    this.stageKeys.set(bus, key);
    if (bus.chain.shape === stageShape(stages)) {
      bus.chain.set(stages, had ? RAMP_S : 0);
      return;
    }
    const old = bus.chain;
    const chain = buildStages(this.ctx!, stages);
    bus.input.disconnect();
    for (const n of old.nodes) n.disconnect();
    if (chain.first && chain.last) {
      bus.input.connect(chain.first);
      chain.last.connect(bus.splitter);
    } else bus.input.connect(bus.splitter);
    bus.chain = chain;
  }

  /** Wire the master limiter in or out (D86) and set its ceiling. */
  private wireLimiter() {
    const want = this.limiterTarget;
    const l = this.limiter;
    if (!l || !this.master || !this.post) return;
    if (want && want.ceilingDb !== l.ceilingDb) setLimiter(l, want.ceilingDb);
    if ((want !== undefined) === this.limiterOn) return;
    this.master.disconnect(want ? this.post : l.input);
    this.master.connect(want ? l.input : this.post);
    this.limiterOn = want !== undefined;
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
    // Ducking (D85): each ducked track's curve, added to its items' gain like the export's expression.
    const ducks = duckCurvesOf(project);
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
      const gain = a.muted ? 0 : itemGain(a.track, index, local, duckDbAt(ducks.get(a.track.id)?.keys, start + local));
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
    const reduction: Record<string, number> = {};
    for (const [id, bus] of this.buses) {
      tracks[id] = read(bus.meters);
      reduction[id] = bus.chain.reduction();
    }
    return { master: read(this.masterMeters), tracks, limiter: this.limiterOn && this.limiter ? this.limiter.input.reduction : 0, reduction };
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
    // After the limiter (D86): what is heard.
    const out = this.post ?? g.master;
    out.connect(node);
    node.connect(sink);
    sink.connect(g.ctx.destination);
    this.tap = tap;
    this.marks = [];
    return {
      stop: () => {
        out.disconnect(node);
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
  levels: () => current?.levels() ?? { master: SILENT, tracks: {}, limiter: 0, reduction: {} },
  state: () => current?.state() ?? { state: "none", items: [] },
  // Test-only (D83): record the master output; stop returns the samples (float32, base64 per
  // channel), the context time of the first one, and the frame drawn at each context time.
  startCapture: () => {
    capturing = current?.capture();
    return capturing !== undefined;
  },
  // Test-only (D84, D86): the preview's own node builders on an OfflineAudioContext. biquadResponse:
  // a biquad stage's magnitude response (dB) at `freqs` from BiquadFilterNode.getFrequencyResponse;
  // offlineTone: a sine of amplitude `amp` through `stages` (and the limiter at `ceilingDb`), the
  // output's RMS and peak over its second half.
  biquadResponse: (stage: Stage, freqs: ReadonlyArray<number>, sampleRate = 48000) => {
    const ctx = new OfflineAudioContext(1, 128, sampleRate);
    const node = buildStages(ctx, [stage]).first as BiquadFilterNode;
    const f = Float32Array.from(freqs);
    const mag = new Float32Array(f.length);
    node.getFrequencyResponse(f, mag, new Float32Array(f.length));
    return [...mag].map((m) => 20 * Math.log10(m));
  },
  offlineTone: async ({ stages = [], ceilingDb, amp, freq = 1000, seconds = 2, sampleRate = 48000 }: { stages?: ReadonlyArray<Stage>; ceilingDb?: number; amp: number; freq?: number; seconds?: number; sampleRate?: number }) => {
    const ctx = new OfflineAudioContext(2, Math.round(seconds * sampleRate), sampleRate);
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = amp;
    osc.connect(g);
    let out: AudioNode = g;
    const chain = buildStages(ctx, stages);
    if (chain.first && chain.last) {
      out.connect(chain.first);
      out = chain.last;
    }
    if (ceilingDb !== undefined) {
      const l = buildLimiter(ctx, ceilingDb);
      out.connect(l.input);
      out = l.clip;
    }
    out.connect(ctx.destination);
    osc.start();
    const buf = await ctx.startRendering();
    const data = buf.getChannelData(0);
    let sum = 0;
    let peak = 0;
    const from = Math.floor(data.length / 2);
    for (let i = from; i < data.length; i++) {
      sum += data[i]! ** 2;
      peak = Math.max(peak, Math.abs(data[i]!));
    }
    return { rms: Math.sqrt(sum / (data.length - from)), peak };
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
