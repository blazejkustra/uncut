// Uncut's own synthesised sound effects (D250, D286), for scripts/make-sfx.ts. Every sound here is
// made from nothing (oscillators, additive partials, seeded noise, filters, a synthetic room): no
// sample, recording or clip goes in, so Uncut owns them and releases them as CC0 with the rest of the
// pack. The meme "sound-alikes" (an exaggerated shout, a dramatic boom, a deep bong...) are original
// sounds made to fit what people search for; none copies a real clip, voice or jingle.
//
// D286 (quality pass): band-limited oscillators (polyBLEP), sounds built in layers (sub, body,
// transient, noise tail), a damped stereo room (Freeverb-style: eight damped combs and four
// all-passes per side), stereo width where it fits (whooshes pan, risers widen, rooms spread), and a
// master stage on every sound: DC/rumble high-pass, a look-ahead limiter that caps the peak-to-loudness
// ratio (so clicks and hits reach the pack's level instead of being held down by one sample peak),
// silent tail trimmed, edges faded.
//
// Each recipe returns mono or stereo float samples at RATE; make-sfx levels and encodes them.

export const RATE = 48000;
type Buf = Float32Array;
/** Left and right. */
type St = readonly [Buf, Buf];
/** What a recipe returns: mono (centred) or stereo. */
export type SynthOut = Buf | St;

/** A seeded random source (mulberry32): the same sound on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const len = (seconds: number) => Math.round(seconds * RATE);
const buf = (seconds: number): Buf => new Float32Array(len(seconds));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const isSt = (x: SynthOut): x is St => Array.isArray(x);

/** White noise. */
const noise = (seconds: number, seed: number): Buf => {
  const r = rng(seed);
  const out = buf(seconds);
  for (let i = 0; i < out.length; i++) out[i] = r() * 2 - 1;
  return out;
};
/** Pink noise (Paul Kellet's filter): softer and more natural than white for air and rumble. */
const pink = (seconds: number, seed: number): Buf => {
  const w = noise(seconds, seed);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return w.map((v) => {
    b0 = 0.99886 * b0 + v * 0.0555179;
    b1 = 0.99332 * b1 + v * 0.0750759;
    b2 = 0.969 * b2 + v * 0.153852;
    b3 = 0.8665 * b3 + v * 0.3104856;
    b4 = 0.55 * b4 + v * 0.5329522;
    b5 = -0.7616 * b5 - v * 0.016898;
    const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + v * 0.5362;
    b6 = v * 0.115926;
    return out * 0.11;
  });
};

/** PolyBLEP correction: removes most of the aliasing of a naive saw or square. */
const blep = (p: number, dt: number) => (p < dt ? ((p /= dt), p + p - p * p - 1) : p > 1 - dt ? ((p = (p - 1) / dt), p * p + p + p + 1) : 0);

/** An oscillator following a frequency curve (Hz at time t); saw and square are band-limited. */
function osc(seconds: number, freq: (t: number) => number, shape: "sine" | "saw" | "square" | "triangle" = "sine", phase0 = 0): Buf {
  const out = buf(seconds);
  let phase = phase0;
  for (let i = 0; i < out.length; i++) {
    const f = freq(i / RATE);
    const dt = Math.min(0.5, Math.abs(f) / RATE);
    phase += f / RATE;
    phase -= Math.floor(phase);
    out[i] =
      shape === "sine" ? Math.sin(2 * Math.PI * phase)
      : shape === "saw" ? 2 * phase - 1 - blep(phase, dt)
      : shape === "square" ? (phase < 0.5 ? 1 : -1) + blep(phase, dt) - blep((phase + 0.5) % 1, dt)
      : 1 - 4 * Math.abs(phase - 0.5);
  }
  return out;
}
/** Three detuned saws (cents apart): a thick, moving tone. */
const supersaw = (seconds: number, freq: (t: number) => number, cents = 9, phase = 0) =>
  mix(...[-cents, 0, cents].map((c, i) => [osc(seconds, (t) => freq(t) * 2 ** (c / 1200), "saw", (phase + i * 0.37) % 1), 0, 0.33] as const));

/** Multiplies by an envelope (value at time t). */
function env(x: Buf, f: (t: number) => number): Buf {
  for (let i = 0; i < x.length; i++) x[i]! *= f(i / RATE);
  return x;
}
const decay = (seconds: number) => (t: number) => Math.exp(-t / seconds);
/** Attack then exponential decay. */
const ad = (attack: number, release: number) => (t: number) => (t < attack ? t / attack : Math.exp(-(t - attack) / release));
/** A smooth bump peaking at `peak` (s), zero at 0 and `end`. */
const bump = (peak: number, end: number) => (t: number) => (t <= 0 || t >= end ? 0 : t < peak ? Math.sin((t / peak) * (Math.PI / 2)) ** 2 : Math.cos(((t - peak) / (end - peak)) * (Math.PI / 2)) ** 2);
const fadeOut = (end: number, fade: number) => (t: number) => (t > end - fade ? Math.max(0, (end - t) / fade) : 1);
const fadeIn = (fade: number) => (t: number) => Math.min(1, t / fade);

/** A biquad (RBJ cookbook) whose frequency (and Q) can follow a curve; coefficients recomputed every 16 samples. */
function filter(x: Buf, type: "lowpass" | "highpass" | "bandpass", freq: number | ((t: number) => number), q: number | ((t: number) => number) = 0.707): Buf {
  const out = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % 16 === 0) {
      const t = i / RATE;
      const f = Math.min(RATE * 0.45, Math.max(20, typeof freq === "number" ? freq : freq(t)));
      const qq = Math.max(0.1, typeof q === "number" ? q : q(t));
      const w = (2 * Math.PI * f) / RATE;
      const alpha = Math.sin(w) / (2 * qq);
      const cos = Math.cos(w);
      const a0 = 1 + alpha;
      if (type === "lowpass") [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
      else if (type === "highpass") [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
      else [b0, b1, b2] = [alpha, 0, -alpha];
      [b0, b1, b2, a1, a2] = [b0 / a0, b1 / a0, b2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
    }
    const y = b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/** A two-pole resonator (Klatt), unity gain at DC: chained, they shape a vowel like a vocal tract. */
function reson(x: Buf, freq: (t: number) => number, bandwidth: number): Buf {
  const out = new Float32Array(x.length);
  let y1 = 0, y2 = 0, a = 0, b = 0, c = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % 16 === 0) {
      const f = freq(i / RATE);
      c = -Math.exp((-2 * Math.PI * bandwidth) / RATE);
      b = 2 * Math.exp((-Math.PI * bandwidth) / RATE) * Math.cos((2 * Math.PI * f) / RATE);
      a = 1 - b - c;
    }
    const y = a * x[i]! + b * y1 + c * y2;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/** Sums mono sounds, each placed at a start time (s) with a gain; the result is as long as the longest. */
function mix(...parts: Array<readonly [Buf, number?, number?]>): Buf {
  const n = Math.max(...parts.map(([b, at = 0]) => len(at) + b.length));
  const out = new Float32Array(n);
  for (const [b, at = 0, gain = 1] of parts) {
    const o = len(at);
    for (let i = 0; i < b.length; i++) out[o + i]! += b[i]! * gain;
  }
  return out;
}
/** Sums mono or stereo sounds into stereo (mono goes in the centre at -3 dB per side). */
function mixSt(...parts: Array<readonly [SynthOut, number?, number?]>): St {
  const sides = parts.map(([x, at = 0, gain = 1]): readonly [Buf, Buf, number, number] => (isSt(x) ? [x[0], x[1], at, gain] : [x, x, at, gain * Math.SQRT1_2]));
  return [mix(...sides.map(([l, , at, g]) => [l, at, g] as const)), mix(...sides.map(([, r, at, g]) => [r, at, g] as const))];
}
const pad = (x: Buf, seconds: number) => mix([x], [buf(seconds)]);
const drive = (x: Buf, amount: number) => x.map((v) => Math.tanh(v * amount) / Math.tanh(amount));
const scale = (x: Buf, g: number) => x.map((v) => v * g);
const peakOf = (x: Buf) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-9);
const normalize = (x: Buf, to = 1) => scale(x, to / peakOf(x));
/** Equal-power pan, -1 (left) to 1 (right), fixed or moving. */
function pan(x: Buf, p: number | ((t: number) => number)): St {
  const l = new Float32Array(x.length);
  const r = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const a = ((clamp01(((typeof p === "number" ? p : p(i / RATE)) + 1) / 2)) * Math.PI) / 2;
    l[i] = x[i]! * Math.cos(a);
    r[i] = x[i]! * Math.sin(a);
  }
  return [l, r];
}

/**
 * A damped stereo room (Freeverb: eight low-passed feedback combs and four all-passes per side, the
 * right side's delays 23 samples longer for width). size 0–1 sets the decay, damp 0–1 how fast highs
 * die, width 0–1 the spread, predelay in seconds; `tail` seconds are added for the decay.
 */
function room(x: SynthOut, o: { wet: number; size?: number; damp?: number; width?: number; predelay?: number; tail: number; dry?: number }): St {
  const { wet, size = 0.5, damp = 0.5, width = 1, predelay = 0.012, tail, dry = 1 } = o;
  const [l0, r0] = isSt(x) ? x : [x, x];
  const l = pad(l0, tail);
  const r = pad(r0, tail);
  const n = l.length;
  const pre = len(predelay);
  const input = new Float32Array(n);
  for (let i = pre; i < n; i++) input[i] = (l[i - pre]! + r[i - pre]!) * 0.015;
  const fb = 0.7 + 0.28 * size;
  const d = damp * 0.4;
  const k = RATE / 44100;
  const side = (spread: number) => {
    const out = new Float32Array(n);
    for (const c of [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]) {
      const line = new Float32Array(Math.round((c + spread) * k));
      let p = 0, store = 0;
      for (let i = 0; i < n; i++) {
        const y = line[p]!;
        store = y * (1 - d) + store * d;
        line[p] = input[i]! + store * fb;
        p = (p + 1) % line.length;
        out[i]! += y;
      }
    }
    for (const a of [556, 441, 341, 225]) {
      const line = new Float32Array(Math.round((a + spread) * k));
      let p = 0;
      for (let i = 0; i < n; i++) {
        const b = line[p]!;
        line[p] = out[i]! + b * 0.5;
        out[i] = b - out[i]!;
        p = (p + 1) % line.length;
      }
    }
    return out;
  };
  const wl = side(0);
  const wr = side(23);
  const w1 = wet * 3 * (width / 2 + 0.5);
  const w2 = wet * 3 * ((1 - width) / 2);
  return [l.map((v, i) => v * dry + wl[i]! * w1 + wr[i]! * w2), r.map((v, i) => v * dry + wr[i]! * w1 + wl[i]! * w2)];
}

/** Notes to Hz. */
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/**
 * A struck bell: inharmonic partials [ratio, gain, decay share], each a slightly detuned pair (so it
 * beats like real metal), higher partials dying first, a tiny pitch settle and a strike click.
 */
function bell(f: number, seconds: number, partials: ReadonlyArray<readonly [number, number, number]> = [[1, 1, 1], [2.0, 0.5, 0.6], [2.76, 0.35, 0.45], [5.4, 0.2, 0.25], [8.93, 0.1, 0.15]], beat = 1.2, seed = 7): Buf {
  const tones = partials.flatMap(([ratio, gain, share], i) => {
    const fr = f * ratio;
    const release = seconds * share * 0.35;
    const b = beat * (0.6 + 0.4 * ((i * 0.618) % 1));
    const settle = (t: number) => 1 + 0.004 * Math.exp(-t / 0.02);
    return [
      [env(osc(seconds, (t) => (fr - b / 2) * settle(t), "sine", (i * 0.13) % 1), ad(0.0015, release)), 0, gain * 0.5] as const,
      [env(osc(seconds, (t) => (fr + b / 2) * settle(t), "sine", (i * 0.29) % 1), ad(0.0015, release)), 0, gain * 0.5] as const,
    ];
  });
  const click = env(filter(noise(0.02, seed), "bandpass", Math.min(12000, f * 4), 1.2), decay(0.0015));
  return mix(...tones, [click, 0, 0.25]);
}

/** A whoosh: pink noise through a sweeping band-pass (the body) and a thin air layer, under a bump. */
function whoosh(seconds: number, from: number, peak: number, to: number, seed: number, q = 1.4, peakAt = 0.5): Buf {
  const p = seconds * peakAt;
  const f = (t: number) => (t < p ? from * (peak / from) ** (t / p) : peak * (to / peak) ** ((t - p) / (seconds - p)));
  const body = filter(pink(seconds, seed), "bandpass", f, q);
  const air = env(filter(noise(seconds, seed + 100), "highpass", (t) => Math.max(2500, f(t) * 1.8)), bump(p, seconds * (0.5 + peakAt / 2)));
  return env(mix([normalize(body)], [normalize(air), 0, 0.18]), bump(p, seconds));
}
/** A whoosh that passes by: panned from one side to the other, a touch of room. */
const passBy = (x: Buf, from: number, to: number, seconds: number) => pan(x, (t) => from + (to - from) * clamp01(t / seconds) ** 1.2);

/** A kick-like thump: a sine whose pitch drops fast. */
const thump = (seconds: number, from: number, to: number, drop: number, release: number, attack = 0.002) => env(osc(seconds, (t) => to + (from - to) * Math.exp(-t / drop)), ad(attack, release));
/** A short bright click (the transient on top of a hit). */
const click = (seed: number, cutoff = 2500, length = 0.004) => env(filter(noise(0.03, seed), "highpass", cutoff), decay(length));

/**
 * A voiced sound, additive: harmonics of a pitch curve with a spectral tilt that can change (strain
 * brightens it), per-cycle jitter and shimmer, slow drift, vibrato and optional subharmonics (vocal
 * roughness). Band-limited by construction (nothing above 9 kHz).
 */
function voiceSource(seconds: number, pitch: (t: number) => number, o: { seed: number; tilt: (t: number) => number; vibrato?: (t: number) => number; rough?: (t: number) => number }): { wave: Buf; pulse: Buf } {
  const r = rng(o.seed);
  const n = len(seconds);
  const wave = new Float32Array(n);
  const pulse = new Float32Array(n);
  const ph = [r(), r(), r()];
  let phase = 0, half = 0, jitter = 0, shimmer = 1;
  const lnk = Array.from({ length: 64 }, (_, k) => Math.log(k + 1));
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const drift = 1 + 0.006 * Math.sin(2 * Math.PI * 0.7 * t + ph[0]! * 6) + 0.004 * Math.sin(2 * Math.PI * 1.9 * t + ph[1]! * 6) + 0.003 * Math.sin(2 * Math.PI * 3.3 * t + ph[2]! * 6);
    const vib = 1 + (o.vibrato?.(t) ?? 0) * Math.sin(2 * Math.PI * 5.8 * t);
    const f = pitch(t) * drift * vib * (1 + jitter);
    phase += f / RATE;
    half += f / (2 * RATE);
    if (phase >= 1) {
      phase -= 1;
      jitter = (r() - 0.5) * 0.01;
      shimmer = 1 + (r() - 0.5) * 0.12;
    }
    half -= Math.floor(half);
    const tilt = o.tilt(t);
    const rough = o.rough?.(t) ?? 0;
    let v = 0;
    for (let k = 1; k * f < 9000 && k <= 64; k++) v += Math.exp(-tilt * lnk[k - 1]!) * Math.sin(2 * Math.PI * k * phase);
    if (rough > 0) for (let m = 0; (2 * m + 1) * f * 0.5 < 3000; m++) v += rough * Math.exp(-tilt * Math.log(m + 0.5 + 1)) * Math.sin(2 * Math.PI * (2 * m + 1) * half);
    wave[i] = v * shimmer;
    pulse[i] = Math.max(0, Math.cos(2 * Math.PI * phase)) ** 2;
  }
  return { wave, pulse };
}
/** Five formants in cascade (a vocal tract), formant frequencies following curves; then lip radiation. */
function tract(x: Buf, formants: ReadonlyArray<readonly [(t: number) => number, number]>): Buf {
  let y = x;
  for (const [f, bw] of formants) y = reson(y, f, bw);
  let prev = 0;
  return y.map((v) => {
    const out = v - 0.97 * prev;
    prev = v;
    return out;
  });
}

/** A recipe: an id, how it's listed, and how it's made. */
export interface SynthSound {
  readonly id: string;
  readonly title: string;
  readonly category: "whoosh" | "transition" | "swipe" | "ui" | "pop" | "impact" | "riser" | "notification" | "success" | "glitch" | "typing" | "crowd" | "meme";
  readonly tags: ReadonlyArray<string>;
  readonly make: () => SynthOut;
}

// ---- Master stage ----

/**
 * Gated loudness as an RMS level, the way EBU R128 integrates it (400 ms blocks every 100 ms, the
 * channels' powers summed, blocks 60 dB under the loudest and then 10 dB under the mean left out),
 * without the K-weighting curve. Blocks run over 0.4 s of silence on each side, like make-sfx measures.
 */
function gatedLevel(chs: ReadonlyArray<Buf>): number {
  const w = len(0.4), step = len(0.1), n = chs[0]!.length;
  const blocks: Array<number> = [];
  for (let s0 = -w; s0 < n; s0 += step) {
    let e = 0;
    for (const x of chs) for (let i = Math.max(0, s0); i < Math.min(n, s0 + w); i++) e += x[i]! ** 2;
    blocks.push(e / w);
  }
  const top = Math.max(...blocks);
  const loud = blocks.filter((e) => e > top * 1e-6);
  const mean = loud.reduce((a, b) => a + b, 0) / loud.length;
  const gated = loud.filter((e) => e > mean * 0.1);
  return Math.sqrt(gated.reduce((a, b) => a + b, 0) / gated.length);
}

/** Highest peak over gated loudness, in dB. A pack sound at -20 LUFS with a -1 dB ceiling has room for 19; this leaves a margin. */
const MAX_PEAK_TO_LOUDNESS = 17.5;

/**
 * The master stage every recipe goes through: a 25 Hz high-pass (DC and rumble), a look-ahead limiter
 * (1.5 ms, 80 ms release) that holds the peak within MAX_PEAK_TO_LOUDNESS dB of the gated loudness,
 * the silent tail (60 dB under the peak) trimmed, 1 ms in and 15 ms out fades, and a 0.9 peak.
 */
export function master(out: SynthOut): SynthOut {
  let chs = (isSt(out) ? [out[0], out[1]] : [out]).map((x) => filter(filter(x, "highpass", 25, 0.6), "highpass", 25, 0.6));
  const n = chs[0]!.length;
  const ceiling = gatedLevel(chs) * 10 ** (MAX_PEAK_TO_LOUDNESS / 20);
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.max(...chs.map((x) => Math.abs(x[i]!)));
    need[i] = p > ceiling ? ceiling / p : 1;
  }
  if (need.some((v) => v < 1)) {
    const la = len(0.0015);
    const held = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 1;
      for (let j = Math.max(0, i - la); j <= Math.min(n - 1, i + la); j++) m = Math.min(m, need[j]!);
      held[i] = m;
    }
    const gain = new Float32Array(n);
    const rel = 1 - Math.exp(-1 / (0.08 * RATE));
    let g = 1;
    for (let i = 0; i < n; i++) {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - la / 2); j <= Math.min(n - 1, i + la / 2); j++, count++) sum += held[j]!;
      const target = sum / count;
      g = target < g ? target : g + (target - g) * rel;
      gain[i] = Math.min(g, held[i]!);
    }
    chs = chs.map((x) => x.map((v, i) => v * gain[i]!));
  }
  const peak = Math.max(...chs.map(peakOf));
  let last = 0;
  for (const x of chs) for (let i = n - 1; i > last; i--) if (Math.abs(x[i]!) > peak * 1e-3) { last = i; break; }
  const end = Math.min(n, last + len(0.02));
  const fadeLen = len(0.015);
  chs = chs.map((x) => {
    const y = x.slice(0, end);
    for (let i = 0; i < y.length; i++) y[i]! *= Math.min(1, i / len(0.001), (y.length - i) / fadeLen) * (0.9 / peak);
    return y;
  });
  return isSt(out) ? [chs[0]!, chs[1]!] : chs[0]!;
}

const s = (id: string, title: string, category: SynthSound["category"], tags: Array<string>, make: () => SynthOut): SynthSound => ({ id, title, category, tags, make: () => master(make()) });

// ---- Recipes ----

/** A record played at a hand's speed: the read head follows `speed` (1 = normal) through `music`. */
function scratchRead(music: Buf, seconds: number, speed: (t: number) => number, start: number): Buf {
  const out = buf(seconds);
  let pos = start * RATE;
  for (let i = 0; i < out.length; i++) {
    pos += speed(i / RATE);
    const p = ((pos % music.length) + music.length) % music.length;
    const i0 = Math.floor(p);
    const fr = p - i0;
    out[i] = music[i0]! * (1 - fr) + music[(i0 + 1) % music.length]! * fr;
  }
  return out;
}

export const SYNTH_SOUNDS: ReadonlyArray<SynthSound> = [
  // Whooshes and transitions: pink-noise body + air, passing from one side to the other.
  s("whoosh-airy", "Airy whoosh", "whoosh", ["whoosh", "swoosh", "air", "transition"], () => room(passBy(whoosh(0.8, 300, 2600, 500, 11), -0.7, 0.7, 0.8), { wet: 0.12, size: 0.55, damp: 0.5, tail: 0.5 })),
  s("whoosh-fast", "Fast whoosh", "whoosh", ["whoosh", "fast", "swish", "pass by"], () => room(passBy(whoosh(0.4, 500, 3500, 900, 12, 1.2, 0.45), -0.85, 0.85, 0.4), { wet: 0.08, size: 0.4, tail: 0.3 })),
  s("whoosh-low", "Low whoosh", "whoosh", ["whoosh", "low", "deep", "heavy"], () => {
    const b = bump(0.55, 1.2);
    const body = env(filter(pink(1.2, 13), "lowpass", (t) => 150 + 900 * b(t), 1.3), b);
    const sub = env(osc(1.2, (t) => 45 + 25 * b(t)), (t) => b(t) * 0.5);
    return room(mixSt([passBy(normalize(body), -0.5, 0.5, 1.2)], [sub, 0, 0.6]), { wet: 0.16, size: 0.7, damp: 0.6, tail: 0.6 });
  }),
  s("whoosh-scifi", "Sci-fi whoosh", "whoosh", ["whoosh", "sci-fi", "futuristic", "tonal"], () => {
    const tone = env(supersaw(0.9, (t) => 200 * 6 ** (t / 0.9), 14), bump(0.5, 0.9));
    return room(mixSt([passBy(whoosh(0.9, 400, 3000, 700, 14), -0.8, 0.8, 0.9)], [passBy(filter(tone, "lowpass", (t) => 800 + 3000 * bump(0.5, 0.9)(t)), 0.6, -0.6, 0.9), 0, 0.3]), { wet: 0.15, size: 0.6, tail: 0.5 });
  }),
  s("whoosh-reverse", "Reverse whoosh", "transition", ["reverse", "whoosh", "suck", "transition", "build"], () => {
    const shape = (t: number) => (t < 1.05 ? (t / 1.05) ** 3 : Math.max(0, (1.1 - t) / 0.05));
    const side = (seed: number) => env(filter(pink(1.1, seed), "bandpass", (t) => 300 * 12 ** (t / 1.1), 1.1), shape);
    // Decorrelated left and right that narrow into the centre as it sucks in.
    const l = side(15), r = side(115);
    return [l.map((v, i) => v * 0.8 + r[i]! * 0.2 * (i / l.length)), r.map((v, i) => v * 0.8 + l[i]! * 0.2 * (i / r.length))] as const;
  }),
  s("swoosh-double", "Double swoosh", "transition", ["swoosh", "double", "transition", "whoosh"], () => room(mixSt([passBy(whoosh(0.32, 600, 3200, 900, 16), -0.7, 0.5, 0.32)], [passBy(whoosh(0.36, 500, 2800, 700, 17), 0.7, -0.5, 0.36), 0.22, 0.85]), { wet: 0.08, size: 0.4, tail: 0.3 })),
  s("swipe-soft", "Soft swipe", "swipe", ["swipe", "slide", "soft", "flick"], () => passBy(env(filter(pink(0.22, 18), "highpass", (t) => 1500 + 4000 * (t / 0.22)), bump(0.08, 0.22)), -0.4, 0.4, 0.22)),

  // Risers: stereo noise and tone that open up, tremble faster and widen towards the top.
  s("riser-noise", "Noise riser", "riser", ["riser", "build", "noise", "uplifter", "tension"], () => {
    const side = (seed: number) => env(filter(filter(pink(3, seed), "bandpass", (t) => 200 * 40 ** (t / 3), (t) => 0.8 + 2.4 * (t / 3)), "highpass", (t) => 80 + 1500 * (t / 3) ** 2), (t) => (t / 3) ** 2 * (1 - 0.25 * (t / 3) * (0.5 + 0.5 * Math.sin(2 * Math.PI * (3 * t + 2 * t * t)))) * fadeOut(3, 0.02)(t));
    const l = side(21), r = side(121);
    // Mid/side: narrow at the start, wide at the top.
    return room([l.map((v, i) => { const w = 0.2 + 0.8 * (i / l.length); return (v + r[i]!) / 2 + ((v - r[i]!) / 2) * w; }), r.map((v, i) => { const w = 0.2 + 0.8 * (i / r.length); return (v + l[i]!) / 2 - ((l[i]! - v) / 2) * w; })], { wet: 0.12, size: 0.6, tail: 0.4 });
  }),
  s("riser-tension", "Tension riser", "riser", ["riser", "tension", "build", "suspense", "cinematic"], () => {
    const voice = (detune: number, phase: number) => mix(...[0, 7, 12].map((st) => [supersaw(3, (t) => hz(45 + st) * 2 ** (t / 3) * 2 ** (detune / 1200), 10, phase), 0, 0.3] as const));
    const shape = (t: number) => (0.6 + 0.4 * Math.sin(2 * Math.PI * (2 * t + 2 * t * t))) * (t / 3) ** 1.5 * fadeOut(3, 0.03)(t);
    const tone = (x: Buf) => env(filter(x, "lowpass", (t) => 400 + 8000 * (t / 3) ** 1.5, 1.4), shape);
    const air = (seed: number) => env(filter(pink(3, seed), "highpass", (t) => 800 + 5000 * (t / 3)), (t) => (t / 3) ** 3 * 0.5);
    return room(mixSt([[tone(voice(-6, 0)), tone(voice(6, 0.5))]], [[air(22), air(122)], 0, 0.6]), { wet: 0.18, size: 0.7, damp: 0.5, tail: 0.6 });
  }),
  s("riser-pitch", "Pitch riser", "riser", ["riser", "rise", "pitch", "sweep", "up"], () => {
    const f = (t: number) => 100 * 16 ** ((t / 2) ** 1.3) * (1 + 0.01 * Math.sin(2 * Math.PI * 6 * t));
    const shape = (t: number) => (0.2 + (0.8 * t) / 2) * fadeOut(2, 0.03)(t);
    const saw = (cents: number) => env(filter(supersaw(2, (t) => f(t) * 2 ** (cents / 1200), 12), "lowpass", (t) => Math.min(12000, f(t) * 6), 1), shape);
    return room(mixSt([[saw(-5), saw(5)], 0, 0.6], [env(osc(2, f), shape), 0, 0.5]), { wet: 0.12, size: 0.55, tail: 0.4 });
  }),
  s("downlifter", "Downlifter", "riser", ["downlifter", "fall", "drop", "sweep down", "transition"], () => {
    const side = (seed: number) => env(filter(pink(2, seed), "bandpass", (t) => 6000 * (1 / 30) ** (t / 2), 1.2), decay(0.7));
    const sub = env(osc(2, (t) => 40 + 160 * Math.exp(-t / 0.4)), ad(0.01, 0.5));
    return room(mixSt([[side(23), side(123)]], [sub, 0, 0.35]), { wet: 0.18, size: 0.65, damp: 0.5, tail: 0.6 });
  }),

  // Impacts: sub + body + click + noise, a little saturation, a room that keeps the sub dry.
  s("hit-deep-boom", "Deep boom", "impact", ["boom", "impact", "hit", "deep", "cinematic", "sub"], () => {
    const sub = thump(2.5, 70, 32, 0.15, 1.1, 0.003);
    const body = drive(thump(0.5, 140, 50, 0.04, 0.15), 4);
    const dirt = env(filter(pink(0.6, 31), "lowpass", 1400), ad(0.002, 0.12));
    const top = mixSt([body, 0, 0.6], [dirt, 0, 0.9], [click(131, 2000, 0.005), 0, 0.3]);
    return mixSt([room(top, { wet: 0.3, size: 0.85, damp: 0.6, tail: 1.2, predelay: 0.02 })], [sub, 0, 1]);
  }),
  s("hit-punchy", "Punchy hit", "impact", ["hit", "punch", "kick", "impact", "thump"], () => {
    const body = drive(thump(0.5, 180, 50, 0.035, 0.16), 2);
    const snap = env(filter(noise(0.1, 32), "bandpass", 1500, 0.9), decay(0.035));
    return room(mix([body], [snap, 0, 0.35], [click(132, 3000, 0.006), 0, 0.8]), { wet: 0.08, size: 0.35, damp: 0.5, tail: 0.25 });
  }),
  s("hit-trailer", "Trailer hit", "impact", ["impact", "trailer", "cinematic", "hit", "metal", "boom"], () => {
    const sub = thump(3, 80, 32, 0.15, 1.1, 0.003);
    const metal = bell(97, 3, [[1, 0.5, 0.8], [2.41, 0.4, 0.5], [3.87, 0.3, 0.4], [5.93, 0.2, 0.3], [8.14, 0.12, 0.2]], 2.5, 33);
    const crash = env(filter(pink(1.2, 33), "highpass", 900), ad(0.003, 0.35));
    const top = mixSt([drive(thump(0.5, 160, 55, 0.04, 0.2), 2.5), 0, 0.5], [metal, 0, 0.6], [[crash, filter(pink(1.2, 133), "highpass", 900).map((v, i) => v * Math.exp(-i / (0.35 * RATE)))], 0, 0.5], [click(233, 2000, 0.006), 0, 0.3]);
    return mixSt([room(top, { wet: 0.32, size: 0.9, damp: 0.45, tail: 1.6, predelay: 0.025 })], [sub, 0, 0.9]);
  }),
  s("hit-snap", "Snap hit", "impact", ["snap", "hit", "crack", "short"], () => {
    // A crack (two noise bands) with a short knock of body under it so it carries.
    const crack = mix([env(filter(noise(0.15, 34), "bandpass", 2200, 1.5), decay(0.015))], [env(filter(noise(0.15, 134), "bandpass", 5200, 1.2), decay(0.008)), 0, 0.6]);
    const knock = env(osc(0.12, (t) => 900 + 500 * Math.exp(-t / 0.005)), ad(0.0008, 0.025));
    return room(mix([crack], [knock, 0, 0.35]), { wet: 0.2, size: 0.45, damp: 0.4, tail: 0.35 });
  }),
  s("bonk", "Bonk", "impact", ["bonk", "cartoon", "wood", "head", "knock", "meme"], () => {
    // A hollow wooden knock: modal partials with a cartoon pitch drop, a mallet click, a body resonance and a low thud.
    const drop = (t: number) => 1 - 0.18 * Math.min(1, t / 0.07);
    const modes = mix(...([[1, 1, 0.09], [2.71, 0.5, 0.045], [4.8, 0.18, 0.022]] as const).map(([r, g, d]) => [env(osc(0.45, (t) => 540 * r * drop(t)), ad(0.0008, d)), 0, g] as const));
    const knock = env(filter(noise(0.05, 35), "bandpass", 820, 1.2), decay(0.012));
    const thud = env(osc(0.3, (t) => 110 + 70 * Math.exp(-t / 0.02)), ad(0.001, 0.05));
    return room(drive(mix([modes], [knock, 0, 0.5], [click(135, 2500, 0.002), 0, 0.3], [thud, 0, 0.45]), 1.4), { wet: 0.08, size: 0.3, damp: 0.5, tail: 0.25 });
  }),
  s("heartbeat", "Heartbeat", "impact", ["heartbeat", "heart", "pulse", "tension", "suspense"], () => {
    const beat = (from: number, to: number, rel: number) => filter(mix([thump(0.4, from, to, 0.05, rel, 0.006)], [env(filter(pink(0.2, 36), "lowpass", 200), ad(0.004, 0.04)), 0, 0.3]), "lowpass", 300);
    return room(mix([beat(70, 40, 0.09)], [beat(60, 36, 0.11), 0.28, 0.8], [beat(70, 40, 0.09), 1.0], [beat(60, 36, 0.11), 1.28, 0.8], [buf(0.3), 1.6]), { wet: 0.06, size: 0.4, damp: 0.7, width: 0.5, tail: 0.2 });
  }),

  // Pops: a short excitation through a resonance that sweeps (the cavity), plus a tone.
  s("pop-mouth", "Mouth pop", "pop", ["pop", "mouth", "plop", "appear"], () => {
    const cavity = reson(env(noise(0.14, 37), decay(0.0015)), (t) => 350 + 800 * (1 - Math.exp(-t / 0.015)), 60);
    const tone = env(osc(0.14, (t) => 300 + 700 * (1 - Math.exp(-t / 0.012))), ad(0.001, 0.03));
    return room(mix([normalize(cavity), 0, 0.7], [tone, 0, 0.6]), { wet: 0.05, size: 0.25, tail: 0.12 });
  }),
  s("pop-bubble", "Bubble pop", "pop", ["pop", "bubble", "blip", "up"], () => {
    const f = (t: number) => 450 + 1100 * (t / 0.12) ** 0.5;
    const ring = reson(env(noise(0.12, 38), decay(0.001)), f, 40);
    return room(mix([env(osc(0.12, f), ad(0.002, 0.03))], [normalize(ring), 0, 0.5]), { wet: 0.05, size: 0.25, tail: 0.12 });
  }),
  s("pop-soft", "Soft pop", "pop", ["pop", "soft", "appear", "ui"], () => {
    const tone = env(filter(osc(0.16, (t) => 220 + 380 * Math.exp(-t / 0.02), "triangle"), "lowpass", 1800), ad(0.003, 0.04));
    const puff = env(filter(noise(0.05, 39), "bandpass", 900, 1), decay(0.006));
    return mix([tone], [puff, 0, 0.25]);
  }),
  s("pop-blip", "Pop blip", "pop", ["blip", "pop", "pluck", "tiny"], () => mix([env(osc(0.1, () => 1320), ad(0.001, 0.025))], [env(osc(0.1, () => 1980), ad(0.001, 0.015)), 0, 0.4], [click(40, 4000, 0.001), 0, 0.12])),

  // Notifications and success: bells that beat like metal, in a short bright room.
  s("bell-ding", "Bell ding", "notification", ["ding", "bell", "notification", "ping"], () => room(bell(1320, 2, undefined, 1.6, 41), { wet: 0.12, size: 0.5, damp: 0.25, tail: 0.5 })),
  s("ding-double", "Double ding", "notification", ["ding", "double", "notification", "message", "alert"], () => room(mixSt([pan(bell(1568, 1.2, undefined, 1.6, 42), -0.2), 0, 0.8], [pan(bell(2093, 1.5, undefined, 1.6, 43), 0.2), 0.14]), { wet: 0.12, size: 0.5, damp: 0.25, tail: 0.5 })),
  s("wrong-buzzer", "Wrong buzzer", "notification", ["wrong", "buzzer", "error", "fail", "incorrect", "game show"], () => room(env(drive(filter(mix([osc(0.8, () => 150, "square"), 0, 0.5], [osc(0.8, () => 156, "square"), 0, 0.5]), "lowpass", 2400), 1.5), (t) => (t < 0.01 ? t / 0.01 : 1) * fadeOut(0.8, 0.05)(t)), { wet: 0.08, size: 0.4, tail: 0.3 })),
  s("correct-ding", "Correct answer", "success", ["correct", "right", "ding", "win", "game show", "success"], () => room(mixSt([pan(bell(1319, 1.2, undefined, 1.6, 44), -0.2), 0, 0.8], [pan(bell(1760, 1.6, undefined, 1.6, 45), 0.2), 0.12]), { wet: 0.12, size: 0.5, damp: 0.25, tail: 0.5 })),
  s("chime-rise", "Rising chime", "success", ["chime", "success", "rise", "arpeggio", "magic"], () => room(mixSt(...[72, 76, 79, 84].map((m, i) => [pan(bell(hz(m + 12), 1.4, undefined, 1.4, 46 + i), -0.45 + i * 0.3), i * 0.09, 0.7] as const)), { wet: 0.16, size: 0.6, damp: 0.25, tail: 0.6 })),
  s("cash-register", "Cash register", "success", ["cash", "money", "ka-ching", "register", "sale", "kaching"], () => {
    const drawer = mix([env(filter(noise(0.12, 41), "bandpass", 3000, 2), decay(0.03))], [env(filter(noise(0.2, 141), "bandpass", 700, 1.5), ad(0.004, 0.05)), 0.03, 0.4]);
    return room(mixSt([drawer, 0, 0.5], [pan(bell(2637, 1.5, undefined, 2, 51), -0.15), 0.08, 0.7], [pan(bell(3520, 1.5, undefined, 2, 52), 0.15), 0.12, 0.5]), { wet: 0.1, size: 0.45, damp: 0.3, tail: 0.4 });
  }),
  s("level-up", "Level up", "success", ["level up", "chiptune", "game", "win", "power up", "8-bit"], () => mix(...[60, 64, 67, 72, 76, 79, 84].map((m, i) => [env(filter(osc(0.12, () => hz(m + 12), "square"), "lowpass", 5000), ad(0.002, 0.08)), i * 0.06, 0.4] as const))),
  s("coin", "Coin", "success", ["coin", "collect", "pickup", "chiptune", "game", "8-bit"], () => mix([env(osc(0.07, () => hz(83), "square"), () => 0.4)], [env(osc(0.5, () => hz(88), "square"), (t) => 0.4 * Math.exp(-t / 0.15)), 0.07])),

  // UI and glitch
  s("clock-ticking", "Clock ticking", "ui", ["clock", "tick", "tock", "countdown", "timer", "ticking"], () => {
    // Each tick: an escapement click plus the wooden case ringing briefly; tick and tock differ.
    const tick = (i: number) => mix([env(filter(noise(0.05, 50 + i), "bandpass", i % 2 ? 2400 : 3200, 4), decay(0.004))], [reson(env(noise(0.06, 150 + i), decay(0.002)), () => (i % 2 ? 780 : 950), 35), 0, 0.3]);
    return room(mix(...[0, 0.5, 1, 1.5, 2, 2.5].map((t0, i) => [tick(i), t0] as const), [buf(0.2), 2.8]), { wet: 0.1, size: 0.3, damp: 0.5, width: 0.6, tail: 0.2 });
  }),
  s("laser-zap", "Laser zap", "glitch", ["laser", "zap", "sci-fi", "shoot", "pew"], () => room(env(osc(0.3, (t) => 200 + 2200 * Math.exp(-t / 0.05), "square"), ad(0.002, 0.08)), { wet: 0.1, size: 0.45, damp: 0.3, tail: 0.3 })),
  s("data-glitch", "Data glitch", "glitch", ["glitch", "data", "digital", "stutter", "bitcrush", "error"], () => {
    // A short slice of digital tone, stuttered: each burst repeats it at its own pitch, sample rate and
    // bit depth, panned somewhere else; a crushed buzz ends it.
    const r = rng(52);
    const slice = mix([osc(0.08, (t) => 600 + 2400 * (t / 0.08), "square"), 0, 0.5], [osc(0.08, (t) => 180 * (1 + 0.5 * Math.sin(2 * Math.PI * 40 * t)), "saw"), 0, 0.5], [filter(noise(0.08, 152), "bandpass", 3000, 1), 0, 0.3]);
    const crush = (x: Buf, hold: number, bits: number) => {
      const q = 2 ** bits / 2;
      let held = 0;
      return x.map((v, i) => (i % hold === 0 ? (held = Math.round(v * q) / q) : held));
    };
    const parts: Array<readonly [SynthOut, number, number]> = [];
    for (let t = 0; t < 0.55; ) {
      const piece = 0.012 + r() * 0.03;
      const repeats = 1 + Math.floor(r() * 4);
      const rate = 0.5 + r() * 1.5;
      const off = Math.floor(r() * (slice.length - len(piece * rate) - 1));
      const one = new Float32Array(len(piece));
      for (let i = 0; i < one.length; i++) one[i] = slice[off + Math.floor(i * rate)] ?? 0;
      const shaped = env(crush(one, 1 + Math.floor(r() * 10), 3 + Math.floor(r() * 4)), (x) => Math.min(1, x / 0.001, (piece - x) / 0.001));
      const where = (r() - 0.5) * 1.4;
      for (let k = 0; k < repeats; k++) parts.push([pan(shaped, where), t + k * piece, 0.4 + r() * 0.4]);
      t += piece * repeats + (r() < 0.3 ? 0.02 + r() * 0.04 : 0);
    }
    const buzz = env(crush(osc(0.18, () => 70, "square"), 6, 3), (t) => fadeIn(0.005)(t) * fadeOut(0.18, 0.04)(t));
    return mixSt(...parts, [buzz, 0.56, 0.35]);
  }),

  // Meme sound-alikes (only when asked, D207): original sounds, never the clips they're named after.
  s("exaggerated-shout", "Exaggerated shout", "meme", ["fahh", "faah", "fah", "shout", "yell", "fail", "frustrated", "meme", "scream"], () => {
    // An "ff" that blows into a strained, over-the-top "aaah": the pitch scoops up, holds high, then
    // falls in defeat with a widening tremble; the voice brightens and roughens at the peak and gets
    // breathy at the end. Additive glottal source through a five-formant tract (a synthetic voice).
    const D = 1.35;
    const strain = bump(0.42, 1.2);
    const pitch = (t: number) => Math.max(150, 175 + 155 * (1 - Math.exp(-t / 0.06)) + 25 * Math.sin((Math.min(1, t / 0.45) * Math.PI) / 2) - (t > 0.45 ? 135 * ((t - 0.45) / 0.85) ** 1.4 : 0));
    const voice = (seed: number, detune: number) => {
      const { wave, pulse } = voiceSource(D, (t) => pitch(t) * detune, {
        seed,
        tilt: (t) => 1.15 - 0.55 * strain(t) + 0.5 * clamp01((t - 1.0) / 0.35),
        vibrato: (t) => 0.028 * clamp01((t - 0.5) / 0.4),
        rough: (t) => 0.22 * strain(t) ** 2,
      });
      const breath = filter(noise(D, seed + 1), "bandpass", 2200, 0.6).map((v, i) => v * (0.35 + 0.65 * pulse[i]!) * (0.25 + 0.75 * clamp01((i / RATE - 0.95) / 0.4)));
      const src = mix([normalize(wave)], [normalize(breath), 0, 0.18]);
      const shaped = tract(src, [
        [(t) => 450 + 420 * (1 - Math.exp(-t / 0.05)) + 70 * strain(t), 85],
        [(t) => 1050 + 230 * (1 - Math.exp(-t / 0.06)), 110],
        [() => 2600, 150],
        [() => 3450, 220],
        [() => 4400, 280],
      ]);
      // The tract cascade rolls off hard above the fifth formant; a parallel branch keeps the presence
      // and breath a shouted voice has up there.
      const presence = filter(filter(src, "highpass", 3800), "highpass", 3800);
      const amp = (t: number) => fadeIn(0.05)(t) * (0.8 + 0.2 * strain(t)) * fadeOut(D, 0.35)(t);
      const n = normalize(env(mix([normalize(shaped)], [normalize(presence), 0, 0.3]), amp));
      // Drive that rises with the strain (a voice pushed into the mic), not a flat distortion.
      return n.map((v, i) => { const g = 1 + 1.8 * strain(i / RATE); return Math.tanh(v * g) / Math.tanh(g); });
    };
    const main = voice(62, 1);
    const double = voice(162, 1.007);
    const ff = env(filter(filter(noise(0.24, 61), "highpass", 1800), "bandpass", 5200, 0.8), (t) => (t / 0.24) ** 1.6 * (t > 0.2 ? Math.max(0, 1 - (t - 0.2) / 0.04) : 1));
    const v0 = 0.17;
    return room(mixSt([normalize(ff), 0, 0.3], [pan(main, -0.08), v0, 1], [pan(double, 0.15), v0 + 0.012, 0.35]), { wet: 0.12, size: 0.45, damp: 0.5, width: 0.7, tail: 0.5 });
  }),
  s("dramatic-boom", "Dramatic boom", "meme", ["boom", "dramatic", "bass", "meme", "reveal"], () => {
    // A long sub that falls in pitch, a saturated body so phones hear it, a click and a dusty noise
    // burst; the body and noise go into a big room, the sub stays dry and centred.
    const sub = thump(2.4, 78, 38, 0.08, 0.9, 0.003);
    const body = drive(mix([thump(0.8, 190, 62, 0.03, 0.22)], [thump(0.8, 380, 124, 0.03, 0.12), 0, 0.4]), 6);
    const dust = env(filter(pink(0.5, 63), "lowpass", 2200), ad(0.002, 0.1));
    const knock = env(filter(noise(0.2, 263), "bandpass", 1200, 0.9), ad(0.001, 0.03));
    const top = mixSt([body, 0, 0.7], [dust, 0, 0.9], [knock, 0, 0.35], [click(163, 2500, 0.005), 0, 0.45]);
    return mixSt([room(top, { wet: 0.28, size: 0.88, damp: 0.55, tail: 1.4, predelay: 0.02 })], [drive(sub, 1.6), 0, 1]);
  }),
  s("deep-bong", "Deep bong", "meme", ["bong", "bell", "dramatic", "deep", "meme"], () => {
    // A large cast bell: hum, prime, minor-third tierce, quint, nominal and upper partials, each a
    // beating pair, lows ringing longest; a padded mallet thud under it and a hall around it.
    const f = 165;
    const partials: ReadonlyArray<readonly [number, number, number]> = [[0.5, 0.55, 1.4], [1, 1, 1], [1.19, 0.4, 0.7], [1.5, 0.28, 0.55], [2, 0.5, 0.5], [2.5, 0.2, 0.32], [3, 0.16, 0.26], [4.2, 0.1, 0.16], [5.4, 0.07, 0.11], [6.8, 0.05, 0.08], [8.3, 0.04, 0.06], [10.6, 0.03, 0.045]];
    const metal = bell(f, 3, partials, 0.9, 64);
    const thud = mix([thump(0.4, 120, 70, 0.03, 0.08)], [env(filter(noise(0.1, 164), "lowpass", 1200), decay(0.008)), 0, 0.4], [env(filter(noise(0.05, 264), "bandpass", 3200, 1), decay(0.004)), 0, 0.25]);
    return room(mix([metal], [thud, 0, 0.5]), { wet: 0.28, size: 0.85, damp: 0.45, width: 1, tail: 1.3, predelay: 0.025 });
  }),
  s("womp-womp", "Womp womp", "meme", ["womp womp", "wah wah", "fail", "sad", "trombone", "lose"], () => {
    const notes: Array<readonly [number, number, number]> = [[58, 0, 0.35], [57, 0.4, 0.35], [56, 0.8, 0.35], [55, 1.2, 1.0]];
    return room(mix(...notes.map(([m, at, d], i) => {
      const tone = osc(d, (t) => hz(m) * (i === 3 ? 1 + 0.025 * Math.sin(2 * Math.PI * 5.5 * t) : 1) * (1 - 0.03 * Math.min(1, t / d)), "saw");
      return [env(filter(tone, "lowpass", (t) => 400 + 1400 * bump(0.08, d)(t), 2), (t) => Math.min(1, t / 0.03) * fadeOut(d, 0.08)(t)), at, 0.6] as const;
    })), { wet: 0.1, size: 0.5, damp: 0.5, tail: 0.4 });
  }),
  s("air-horn-blast", "Air horn blasts", "meme", ["airhorn", "air horn", "horn", "hype", "party"], () => {
    const blast = (d: number, seed: number) => env(drive(filter(mix(...[0, 4, 7].map((st) => [osc(d, (t) => hz(70 + st) * (1 - 0.06 * Math.exp(-t / 0.04)), "saw"), 0, 0.33] as const), [noise(d, seed), 0, 0.03]), "lowpass", 3500), 3), (t) => Math.min(1, t / 0.01) * fadeOut(d, 0.03)(t));
    return room(mix([blast(0.18, 64)], [blast(0.18, 65), 0.24], [blast(0.7, 66), 0.48]), { wet: 0.12, size: 0.6, damp: 0.4, tail: 0.5 });
  }),
  s("vinyl-scratch", "Vinyl scratch", "meme", ["record scratch", "scratch", "vinyl", "stop", "dj", "rewind"], () => {
    // A record of made-up music (a chord, a beat, hats) under a hand: the read head follows the hand's
    // speed, forward and back, so pitch and tone move together and stop at each turn; surface crackle.
    const music = mix(
      [filter(mix(...[48, 55, 60, 63].map((m) => [osc(2, () => hz(m), "saw"), 0, 0.25] as const)), "lowpass", 2500), 0, 0.6],
      ...[0, 0.5, 1, 1.5].map((at) => [thump(0.3, 150, 50, 0.03, 0.12), at, 0.8] as const),
      ...[0.25, 0.75, 1.25, 1.75].map((at) => [env(filter(noise(0.08, 70 + at * 10), "highpass", 6000), decay(0.02)), at, 0.4] as const),
    );
    const strokes: Array<readonly [number, number, number]> = [[0, 0.11, 2.6], [0.11, 0.1, -2.4], [0.21, 0.09, 2.8], [0.3, 0.32, -3.2]];
    const speed = (t: number) => strokes.reduce((v, [t0, d, a]) => (t >= t0 && t < t0 + d ? v + a * Math.sin((Math.PI * (t - t0)) / d) : v), 0);
    const D = 0.66;
    const read = scratchRead(music, D, speed, 0.6);
    const stylus = filter(read, "bandpass", (t) => 500 + 2200 * Math.min(1, Math.abs(speed(t)) / 3), 0.9);
    const r = rng(67);
    const crackle = filter(noise(D, 167).map((v) => (r() < 0.0015 ? v * 4 : v * 0.01)), "highpass", 1500);
    return room(mix([read, 0, 0.6], [stylus, 0, 0.6], [crackle, 0, 0.25]).map((v, i) => v * fadeOut(D, 0.04)(i / RATE)), { wet: 0.06, size: 0.35, width: 0.5, tail: 0.2 });
  }),
  s("questioning-huh", "Questioning huh", "meme", ["huh", "what", "question", "confused", "meme"], () => {
    const D = 0.42;
    const { wave, pulse } = voiceSource(D, (t) => 165 * 1.9 ** (t / D), { seed: 69, tilt: (t) => 1.6 - 0.3 * (t / D) });
    const breath = filter(noise(D, 70), "bandpass", 1800, 0.6).map((v, i) => v * (0.3 + 0.7 * pulse[i]!));
    const uh = tract(mix([normalize(wave)], [normalize(breath), 0, 0.15]), [[(t) => 560 + 120 * (t / D), 90], [() => 1190, 110], [() => 2390, 160], [() => 3400, 220], [() => 4300, 280]]);
    const h = env(filter(noise(0.1, 68), "bandpass", 1500, 0.8), (t) => Math.min(1, t / 0.02) * 0.5);
    const voiced = env(normalize(uh), (t) => fadeIn(0.03)(t) * fadeOut(D, 0.12)(t));
    return room(mix([normalize(h), 0, 0.25], [drive(voiced, 1.5), 0.07, 1]), { wet: 0.08, size: 0.35, width: 0.5, tail: 0.25 });
  }),
  s("dun-dun-dun", "Dramatic sting", "meme", ["dun dun dun", "dramatic", "sting", "suspense", "reveal"], () => {
    const note = (m: number, d: number) => env(filter(mix([supersaw(d, () => hz(m), 8), 0, 0.6], [osc(d, () => hz(m - 12), "square"), 0, 0.3], [osc(d, () => hz(m - 24)), 0, 0.4]), "lowpass", (t) => 300 + 1800 * Math.exp(-t / 0.25), 1.2), (t) => Math.min(1, t / 0.015) * fadeOut(d, 0.15)(t));
    return room(mix([note(50, 0.3)], [note(50, 0.3), 0.36], [note(46, 1.4), 0.72]), { wet: 0.25, size: 0.8, damp: 0.5, tail: 1.1 });
  }),
  s("slide-whistle-up", "Slide whistle up", "meme", ["slide whistle", "whistle", "up", "cartoon", "rise"], () => {
    const f = (t: number) => 500 * 3.5 ** (t / 0.7) * (1 + 0.015 * Math.sin(2 * Math.PI * 7 * t));
    const shape = (t: number) => Math.min(1, t / 0.04) * fadeOut(0.7, 0.06)(t);
    return room(mix([env(osc(0.7, f), shape)], [env(osc(0.7, (t) => f(t) * 2), shape), 0, 0.08], [env(filter(noise(0.7, 71), "bandpass", f, 8), shape), 0, 0.4]), { wet: 0.08, size: 0.4, tail: 0.3 });
  }),
  s("slide-whistle-down", "Slide whistle down", "meme", ["slide whistle", "whistle", "down", "cartoon", "fall"], () => {
    const f = (t: number) => 1800 * (1 / 3.5) ** (t / 0.8) * (1 + 0.015 * Math.sin(2 * Math.PI * 7 * t));
    const shape = (t: number) => Math.min(1, t / 0.04) * fadeOut(0.8, 0.08)(t);
    return room(mix([env(osc(0.8, f), shape)], [env(osc(0.8, (t) => f(t) * 2), shape), 0, 0.08], [env(filter(noise(0.8, 72), "bandpass", f, 8), shape), 0, 0.4]), { wet: 0.08, size: 0.4, tail: 0.3 });
  }),
  s("spring-boing", "Spring boing", "meme", ["boing", "spring", "bounce", "cartoon", "jump"], () => room(env(osc(0.7, (t) => 330 * (1 + 0.5 * Math.exp(-t / 0.25) * Math.sin(2 * Math.PI * 14 * t)), "triangle"), ad(0.003, 0.25)), { wet: 0.06, size: 0.35, tail: 0.2 })),
];
