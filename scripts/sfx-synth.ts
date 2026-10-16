// Uncut's own synthesised sound effects (D250), for scripts/make-sfx.ts. Every sound here is made
// from nothing (oscillators, seeded noise, filters, a small reverb): no sample, recording or clip
// goes in, so Uncut owns them and releases them as CC0 with the rest of the pack. The meme
// "sound-alikes" (an exaggerated shout, a dramatic boom, a deep bong...) are original sounds made to
// fit what people search for; none copies a real clip, voice or jingle.
//
// Each recipe returns mono float samples at RATE; make-sfx trims, levels and encodes them.

export const RATE = 48000;
type Buf = Float32Array;

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
const noise = (seconds: number, seed: number): Buf => {
  const r = rng(seed);
  const out = buf(seconds);
  for (let i = 0; i < out.length; i++) out[i] = r() * 2 - 1;
  return out;
};

/** An oscillator following a frequency curve (Hz at time t). */
function osc(seconds: number, freq: (t: number) => number, shape: "sine" | "saw" | "square" | "triangle" = "sine", phase0 = 0): Buf {
  const out = buf(seconds);
  let phase = phase0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    phase += freq(t) / RATE;
    phase -= Math.floor(phase);
    out[i] = shape === "sine" ? Math.sin(2 * Math.PI * phase) : shape === "saw" ? 2 * phase - 1 : shape === "square" ? (phase < 0.5 ? 1 : -1) : 1 - 4 * Math.abs(phase - 0.5);
  }
  return out;
}

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

/** A biquad (RBJ cookbook) whose frequency can follow a curve; coefficients recomputed every 16 samples. */
function filter(x: Buf, type: "lowpass" | "highpass" | "bandpass", freq: number | ((t: number) => number), q = 0.707): Buf {
  const out = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % 16 === 0) {
      const f = Math.min(RATE * 0.45, Math.max(20, typeof freq === "number" ? freq : freq(i / RATE)));
      const w = (2 * Math.PI * f) / RATE;
      const alpha = Math.sin(w) / (2 * q);
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

/** Sums sounds, each placed at a start time (s) with a gain; the result is as long as the longest. */
function mix(...parts: Array<readonly [Buf, number?, number?]>): Buf {
  const n = Math.max(...parts.map(([b, at = 0]) => len(at) + b.length));
  const out = new Float32Array(n);
  for (const [b, at = 0, gain = 1] of parts) {
    const o = len(at);
    for (let i = 0; i < b.length; i++) out[o + i]! += b[i]! * gain;
  }
  return out;
}
const pad = (x: Buf, seconds: number) => mix([x], [buf(seconds)]);
const drive = (x: Buf, amount: number) => x.map((v) => Math.tanh(v * amount) / Math.tanh(amount));
const scale = (x: Buf, g: number) => x.map((v) => v * g);

/** A small Schroeder reverb (four combs, two all-passes), mixed in at `wet`, with `tail` seconds added. */
function reverb(x: Buf, wet: number, size = 1, tail = 1.2): Buf {
  const dry = pad(x, tail);
  const n = dry.length;
  const wetBuf = new Float32Array(n);
  for (const [ms, fb] of [[29.7, 0.805], [37.1, 0.827], [41.1, 0.783], [43.7, 0.764]] as const) {
    const d = Math.round((ms * size * RATE) / 1000);
    const line = new Float32Array(d);
    let p = 0;
    for (let i = 0; i < n; i++) {
      const y = line[p]!;
      line[p] = dry[i]! + y * fb;
      p = (p + 1) % d;
      wetBuf[i]! += y * 0.25;
    }
  }
  let out = wetBuf;
  for (const ms of [5, 1.7]) {
    const d = Math.round((ms * RATE) / 1000);
    const line = new Float32Array(d);
    let p = 0;
    const next = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const delayed = line[p]!;
      const y = -0.7 * out[i]! + delayed;
      line[p] = out[i]! + 0.7 * y;
      p = (p + 1) % d;
      next[i] = y;
    }
    out = next;
  }
  return dry.map((v, i) => v * (1 - wet) + out[i]! * wet * 2);
}

/** Notes to Hz. */
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** A bell: inharmonic partials, each with its own decay. */
function bell(f: number, seconds: number, partials: ReadonlyArray<readonly [number, number, number]> = [[1, 1, 1], [2.0, 0.5, 0.6], [2.76, 0.35, 0.45], [5.4, 0.2, 0.25], [8.93, 0.1, 0.15]]): Buf {
  return mix(...partials.map(([ratio, gain, d]) => [env(osc(seconds, () => f * ratio), ad(0.002, seconds * d * 0.35)), 0, gain] as const));
}

/** A whoosh: noise through a band-pass that sweeps, under a bump. */
function whoosh(seconds: number, from: number, peak: number, to: number, seed: number, q = 1.4, peakAt = 0.5): Buf {
  const p = seconds * peakAt;
  const f = (t: number) => (t < p ? from * (peak / from) ** (t / p) : peak * (to / peak) ** ((t - p) / (seconds - p)));
  return env(filter(noise(seconds, seed), "bandpass", f, q), bump(p, seconds));
}

/** A kick-like thump: a sine whose pitch drops fast. */
const thump = (seconds: number, from: number, to: number, drop: number, release: number) => env(osc(seconds, (t) => to + (from - to) * Math.exp(-t / drop)), ad(0.002, release));

/**
 * A voice-like vowel (source-filter): a buzzy glottal source following a pitch curve, with breath,
 * through three formant band-passes. Used for original shouts and grunts, never a real voice.
 */
function vowel(seconds: number, pitch: (t: number) => number, formants: ReadonlyArray<readonly [number, number, number]>, seed: number, breath = 0.15): Buf {
  const r = rng(seed);
  let jitter = 0;
  const src = osc(seconds, (t) => {
    jitter = jitter * 0.995 + (r() - 0.5) * 0.4;
    return pitch(t) * (1 + jitter * 0.01);
  }, "saw");
  const air = scale(noise(seconds, seed + 1), breath);
  const excitation = src.map((v, i) => v + air[i]!);
  return mix(...formants.map(([f, q, g]) => [filter(excitation, "bandpass", f, q), 0, g] as const));
}

/** A recipe: an id, how it's listed, and how it's made. */
export interface SynthSound {
  readonly id: string;
  readonly title: string;
  readonly category: "whoosh" | "transition" | "swipe" | "ui" | "pop" | "impact" | "riser" | "notification" | "success" | "glitch" | "typing" | "crowd" | "meme";
  readonly tags: ReadonlyArray<string>;
  readonly make: () => Float32Array;
}
const s = (id: string, title: string, category: SynthSound["category"], tags: Array<string>, make: () => Buf): SynthSound => ({ id, title, category, tags, make });

export const SYNTH_SOUNDS: ReadonlyArray<SynthSound> = [
  // Whooshes and transitions
  s("whoosh-airy", "Airy whoosh", "whoosh", ["whoosh", "swoosh", "air", "transition"], () => reverb(whoosh(0.8, 300, 2600, 500, 11), 0.15, 1, 0.4)),
  s("whoosh-fast", "Fast whoosh", "whoosh", ["whoosh", "fast", "swish", "pass by"], () => whoosh(0.4, 500, 3500, 900, 12, 1.2, 0.45)),
  s("whoosh-low", "Low whoosh", "whoosh", ["whoosh", "low", "deep", "heavy"], () => reverb(env(filter(noise(1.2, 13), "lowpass", (t) => 150 + 800 * bump(0.55, 1.2)(t), 1.2), bump(0.55, 1.2)), 0.2, 1.2, 0.6)),
  s("whoosh-scifi", "Sci-fi whoosh", "whoosh", ["whoosh", "sci-fi", "futuristic", "tonal"], () => mix([whoosh(0.9, 400, 3000, 700, 14)], [env(osc(0.9, (t) => 200 * 6 ** (t / 0.9), "triangle"), bump(0.5, 0.9)), 0, 0.25])),
  s("whoosh-reverse", "Reverse whoosh", "transition", ["reverse", "whoosh", "suck", "transition", "build"], () => env(filter(noise(1.1, 15), "bandpass", (t) => 300 * 12 ** (t / 1.1), 1.1), (t) => (t < 1.05 ? (t / 1.05) ** 3 : Math.max(0, (1.1 - t) / 0.05)))),
  s("swoosh-double", "Double swoosh", "transition", ["swoosh", "double", "transition", "whoosh"], () => mix([whoosh(0.32, 600, 3200, 900, 16)], [whoosh(0.36, 500, 2800, 700, 17), 0.22, 0.85])),
  s("swipe-soft", "Soft swipe", "swipe", ["swipe", "slide", "soft", "flick"], () => env(filter(noise(0.22, 18), "highpass", (t) => 1500 + 4000 * (t / 0.22)), bump(0.08, 0.22))),

  // Risers
  s("riser-noise", "Noise riser", "riser", ["riser", "build", "noise", "uplifter", "tension"], () => env(filter(noise(3, 21), "bandpass", (t) => 200 * 40 ** (t / 3), 0.9), (t) => (t / 3) ** 2 * fadeOut(3, 0.05)(t))),
  s("riser-tension", "Tension riser", "riser", ["riser", "tension", "build", "suspense", "cinematic"], () => {
    const tone = mix(...[0, 7, 12].map((st) => [osc(3, (t) => hz(45 + st) * 2 ** (t / 3), "saw"), 0, 0.3] as const));
    const trem = env(filter(tone, "lowpass", (t) => 500 + 4000 * (t / 3)), (t) => (0.6 + 0.4 * Math.sin(2 * Math.PI * (2 * t + 2 * t * t))) * (t / 3) ** 1.5 * fadeOut(3, 0.05)(t));
    return mix([trem], [env(filter(noise(3, 22), "highpass", (t) => 800 + 4000 * (t / 3)), (t) => (t / 3) ** 3 * 0.4)]);
  }),
  s("riser-pitch", "Pitch riser", "riser", ["riser", "rise", "pitch", "sweep", "up"], () => env(osc(2, (t) => 100 * 16 ** ((t / 2) ** 1.3) * (1 + 0.01 * Math.sin(2 * Math.PI * 6 * t))), (t) => (0.2 + 0.8 * t / 2) * fadeOut(2, 0.04)(t))),
  s("downlifter", "Downlifter", "riser", ["downlifter", "fall", "drop", "sweep down", "transition"], () => reverb(env(filter(noise(2, 23), "bandpass", (t) => 6000 * (1 / 30) ** (t / 2), 1), decay(0.7)), 0.2, 1, 0.5)),

  // Impacts
  s("hit-deep-boom", "Deep boom", "impact", ["boom", "impact", "hit", "deep", "cinematic", "sub"], () => reverb(mix([thump(2.5, 90, 34, 0.12, 0.8)], [env(filter(noise(0.4, 31), "lowpass", 900), decay(0.06)), 0, 0.5]), 0.25, 1.3, 1)),
  s("hit-punchy", "Punchy hit", "impact", ["hit", "punch", "kick", "impact", "thump"], () => mix([thump(0.6, 160, 48, 0.04, 0.15)], [env(filter(noise(0.05, 32), "highpass", 2500), decay(0.008)), 0, 0.6])),
  s("hit-trailer", "Trailer hit", "impact", ["impact", "trailer", "cinematic", "hit", "metal", "boom"], () => reverb(mix([thump(3, 80, 32, 0.15, 1)], [bell(97, 3, [[1, 0.5, 0.8], [2.41, 0.4, 0.5], [3.87, 0.3, 0.4], [5.93, 0.2, 0.3]]), 0, 0.5], [env(filter(noise(0.3, 33), "bandpass", 1800, 0.8), decay(0.05)), 0, 0.4]), 0.35, 1.5, 1.5)),
  s("hit-snap", "Snap hit", "impact", ["snap", "hit", "crack", "short"], () => reverb(env(filter(noise(0.15, 34), "bandpass", 2200, 1.5), decay(0.02)), 0.2, 0.7, 0.3)),
  s("bonk", "Bonk", "impact", ["bonk", "cartoon", "wood", "head", "knock", "meme"], () => mix(...([[1, 1], [1.58, 0.5], [2.72, 0.25]] as const).map(([r, g]) => [env(osc(0.35, (t) => 620 * r * (1 - 0.25 * Math.min(1, t / 0.08))), ad(0.001, 0.06)), 0, g] as const))),
  s("heartbeat", "Heartbeat", "impact", ["heartbeat", "heart", "pulse", "tension", "suspense"], () => mix([thump(0.4, 70, 40, 0.05, 0.09)], [thump(0.4, 60, 36, 0.05, 0.11), 0.28, 0.8], [thump(0.4, 70, 40, 0.05, 0.09), 1.0], [thump(0.4, 60, 36, 0.05, 0.11), 1.28, 0.8], [buf(0.3), 1.6])),

  // Pops
  s("pop-mouth", "Mouth pop", "pop", ["pop", "mouth", "plop", "appear"], () => env(osc(0.14, (t) => 300 + 700 * Math.exp(-t / 0.012)), ad(0.001, 0.03))),
  s("pop-bubble", "Bubble pop", "pop", ["pop", "bubble", "blip", "up"], () => env(osc(0.12, (t) => 400 + 900 * (t / 0.12) ** 0.5), ad(0.002, 0.03))),
  s("pop-soft", "Soft pop", "pop", ["pop", "soft", "appear", "ui"], () => env(filter(osc(0.16, (t) => 220 + 380 * Math.exp(-t / 0.02), "triangle"), "lowpass", 1800), ad(0.003, 0.04))),
  s("pop-blip", "Pop blip", "pop", ["blip", "pop", "pluck", "tiny"], () => mix([env(osc(0.1, () => 1320), ad(0.001, 0.025))], [env(osc(0.1, () => 1980), ad(0.001, 0.015)), 0, 0.4])),

  // Notifications and success
  s("bell-ding", "Bell ding", "notification", ["ding", "bell", "notification", "ping"], () => bell(1320, 2)),
  s("ding-double", "Double ding", "notification", ["ding", "double", "notification", "message", "alert"], () => mix([bell(1568, 1.2), 0, 0.8], [bell(2093, 1.5), 0.14])),
  s("wrong-buzzer", "Wrong buzzer", "notification", ["wrong", "buzzer", "error", "fail", "incorrect", "game show"], () => env(filter(mix([osc(0.8, () => 150, "square"), 0, 0.5], [osc(0.8, () => 156, "square"), 0, 0.5]), "lowpass", 2400), (t) => (t < 0.01 ? t / 0.01 : 1) * fadeOut(0.8, 0.05)(t))),
  s("correct-ding", "Correct answer", "success", ["correct", "right", "ding", "win", "game show", "success"], () => mix([bell(1319, 1.2), 0, 0.8], [bell(1760, 1.6), 0.12])),
  s("chime-rise", "Rising chime", "success", ["chime", "success", "rise", "arpeggio", "magic"], () => mix(...[72, 76, 79, 84].map((m, i) => [bell(hz(m + 12), 1.4), i * 0.09, 0.7] as const))),
  s("cash-register", "Cash register", "success", ["cash", "money", "ka-ching", "register", "sale", "kaching"], () => mix([env(filter(noise(0.12, 41), "bandpass", 3000, 2), decay(0.03)), 0, 0.5], [bell(2637, 1.5), 0.08, 0.7], [bell(3520, 1.5), 0.12, 0.5])),
  s("level-up", "Level up", "success", ["level up", "chiptune", "game", "win", "power up", "8-bit"], () => mix(...[60, 64, 67, 72, 76, 79, 84].map((m, i) => [env(filter(osc(0.12, () => hz(m + 12), "square"), "lowpass", 5000), ad(0.002, 0.08)), i * 0.06, 0.4] as const))),
  s("coin", "Coin", "success", ["coin", "collect", "pickup", "chiptune", "game", "8-bit"], () => mix([env(osc(0.07, () => hz(83), "square"), (t) => 0.4)], [env(osc(0.5, () => hz(88), "square"), (t) => 0.4 * Math.exp(-t / 0.15)), 0.07])),

  // UI and glitch
  s("clock-ticking", "Clock ticking", "ui", ["clock", "tick", "tock", "countdown", "timer", "ticking"], () => mix(...[0, 0.5, 1, 1.5, 2, 2.5].map((t0, i) => [env(filter(noise(0.03, 50 + i), "bandpass", i % 2 ? 2400 : 3200, 6), decay(0.004)), t0] as const), [buf(0.2), 2.8])),
  s("laser-zap", "Laser zap", "glitch", ["laser", "zap", "sci-fi", "shoot", "pew"], () => env(osc(0.3, (t) => 200 + 2200 * Math.exp(-t / 0.05), "square"), ad(0.002, 0.08))),
  s("data-glitch", "Data glitch", "glitch", ["glitch", "data", "digital", "stutter", "bitcrush", "error"], () => {
    const r = rng(52);
    const parts: Array<readonly [Buf, number, number]> = [];
    for (let t = 0; t < 0.7; t += 0.035 + r() * 0.04) parts.push([env(osc(0.03, () => 200 + r() * 3000, r() > 0.5 ? "square" : "saw"), (x) => (x < 0.028 ? 1 : 0)), t, 0.3 + r() * 0.5]);
    return mix(...parts).map((v) => Math.round(v * 6) / 6);
  }),

  // Meme sound-alikes (only when asked, D207): original sounds, never the clips they're named after.
  s("exaggerated-shout", "Exaggerated shout", "meme", ["fahh", "faah", "fah", "shout", "yell", "fail", "frustrated", "meme", "scream"], () => {
    // An "ffff" breath, then a strained "aaah" that peaks and falls, driven hard like a blown-out mic.
    const fric = env(filter(noise(0.22, 61), "highpass", 2800), (t) => (t / 0.22) ** 1.5 * (t > 0.18 ? Math.max(0, 1 - (t - 0.18) / 0.06) : 1));
    const pitch = (t: number) => 210 + 110 * Math.sin(Math.min(1, t / 0.9) * Math.PI * 0.8) - 60 * Math.max(0, t - 0.7);
    const ah = env(vowel(1.25, pitch, [[760, 6, 1], [1180, 7, 0.7], [2600, 8, 0.35], [3400, 9, 0.15]], 62, 0.25), (t) => Math.min(1, t / 0.05) * fadeOut(1.25, 0.35)(t));
    return reverb(drive(mix([fric, 0, 0.5], [ah, 0.16, 1.6]), 4), 0.12, 0.8, 0.4);
  }),
  s("dramatic-boom", "Dramatic boom", "meme", ["boom", "dramatic", "bass", "meme", "reveal"], () => reverb(drive(mix([thump(2.2, 120, 42, 0.07, 0.6)], [thump(2.2, 240, 84, 0.07, 0.3), 0, 0.3], [env(filter(noise(0.1, 63), "lowpass", 1500), decay(0.02)), 0, 0.4]), 2.5), 0.3, 1.6, 1.4)),
  s("deep-bong", "Deep bong", "meme", ["bong", "bell", "dramatic", "deep", "meme"], () => reverb(bell(196, 3, [[1, 1, 1], [0.5, 0.6, 1.2], [2.0, 0.4, 0.5], [2.76, 0.3, 0.4], [4.07, 0.15, 0.3]]), 0.25, 1.4, 1)),
  s("womp-womp", "Womp womp", "meme", ["womp womp", "wah wah", "fail", "sad", "trombone", "lose"], () => {
    const notes: Array<readonly [number, number, number]> = [[58, 0, 0.35], [57, 0.4, 0.35], [56, 0.8, 0.35], [55, 1.2, 1.0]];
    return mix(...notes.map(([m, at, d], i) => {
      const tone = osc(d, (t) => hz(m) * (i === 3 ? 1 + 0.025 * Math.sin(2 * Math.PI * 5.5 * t) : 1) * (1 - 0.03 * Math.min(1, t / d)), "saw");
      return [env(filter(tone, "lowpass", (t) => 400 + 1400 * bump(0.08, d)(t), 2), (t) => Math.min(1, t / 0.03) * fadeOut(d, 0.08)(t)), at, 0.6] as const;
    }));
  }),
  s("air-horn-blast", "Air horn blasts", "meme", ["airhorn", "air horn", "horn", "hype", "party"], () => {
    const blast = (d: number, seed: number) => env(drive(filter(mix(...[0, 4, 7].map((st) => [osc(d, (t) => hz(70 + st) * (1 - 0.06 * Math.exp(-t / 0.04)), "saw"), 0, 0.33] as const), [noise(d, seed), 0, 0.03]), "lowpass", 3500), 3), (t) => Math.min(1, t / 0.01) * fadeOut(d, 0.03)(t));
    return mix([blast(0.18, 64)], [blast(0.18, 65), 0.24], [blast(0.7, 66), 0.48]);
  }),
  s("vinyl-scratch", "Vinyl scratch", "meme", ["record scratch", "scratch", "vinyl", "stop", "dj", "rewind"], () => {
    // A hand moving a record back and forth: the speed swings, the noise and tone follow it.
    const d = 0.6;
    const speed = (t: number) => Math.sin(2 * Math.PI * (t < 0.25 ? 4 : 2.5) * t);
    const tone = osc(d, (t) => 300 + 900 * Math.abs(speed(t)), "saw");
    const grit = filter(noise(d, 67), "bandpass", (t) => 800 + 2500 * Math.abs(speed(t)), 1.5);
    return env(mix([filter(tone, "lowpass", 2500), 0, 0.4], [grit, 0, 0.8]), (t) => (0.2 + Math.abs(speed(t))) * fadeOut(d, 0.05)(t));
  }),
  s("questioning-huh", "Questioning huh", "meme", ["huh", "what", "question", "confused", "meme"], () => {
    const h = env(filter(noise(0.1, 68), "bandpass", 1500, 0.8), (t) => Math.min(1, t / 0.02) * 0.5);
    const uh = env(vowel(0.42, (t) => 170 * 1.9 ** (t / 0.42), [[640, 6, 1], [1190, 7, 0.6], [2390, 8, 0.25]], 69, 0.2), (t) => Math.min(1, t / 0.03) * fadeOut(0.42, 0.12)(t));
    return mix([h], [drive(uh, 1.5), 0.07, 1.2]);
  }),
  s("dun-dun-dun", "Dramatic sting", "meme", ["dun dun dun", "dramatic", "sting", "suspense", "reveal"], () => {
    const note = (m: number, d: number) => env(filter(mix([osc(d, () => hz(m), "saw"), 0, 0.5], [osc(d, () => hz(m) * 1.004, "saw"), 0, 0.5], [osc(d, () => hz(m - 12), "square"), 0, 0.3]), "lowpass", (t) => 300 + 1800 * Math.exp(-t / 0.25), 1.2), (t) => Math.min(1, t / 0.02) * fadeOut(d, 0.15)(t));
    return reverb(mix([note(50, 0.3)], [note(50, 0.3), 0.36], [note(46, 1.4), 0.72]), 0.3, 1.3, 1);
  }),
  s("slide-whistle-up", "Slide whistle up", "meme", ["slide whistle", "whistle", "up", "cartoon", "rise"], () => env(osc(0.7, (t) => 500 * 3.5 ** (t / 0.7) * (1 + 0.015 * Math.sin(2 * Math.PI * 7 * t))), (t) => Math.min(1, t / 0.04) * fadeOut(0.7, 0.06)(t))),
  s("slide-whistle-down", "Slide whistle down", "meme", ["slide whistle", "whistle", "down", "cartoon", "fall"], () => env(osc(0.8, (t) => 1800 * (1 / 3.5) ** (t / 0.8) * (1 + 0.015 * Math.sin(2 * Math.PI * 7 * t))), (t) => Math.min(1, t / 0.04) * fadeOut(0.8, 0.08)(t))),
  s("spring-boing", "Spring boing", "meme", ["boing", "spring", "bounce", "cartoon", "jump"], () => env(osc(0.7, (t) => 330 * (1 + 0.5 * Math.exp(-t / 0.25) * Math.sin(2 * Math.PI * 14 * t)), "triangle"), ad(0.003, 0.25))),
];
