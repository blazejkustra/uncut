// Synthetic rhythm for the beats analyzer's tests (D70): click tracks and a drum pattern over noise
// with known beat times, written as 16-bit mono WAV files.
import { writeFileSync } from "node:fs";

export const RATE = 44100;

/** A seeded PRNG (mulberry32), -1…1. */
export function noise(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

function click(buf: Float64Array, t: number, rate: number, amp = 0.8) {
  const s = Math.round(t * rate);
  const n = 0.01 * rate;
  for (let i = 0; i < n && s + i < buf.length; i++) buf[s + i]! += amp * Math.sin((2 * Math.PI * 1500 * i) / rate) * Math.exp(-i / (n / 4));
}
function burst(buf: Float64Array, t: number, rate: number, amp: number, dur: number, rnd: () => number) {
  const s = Math.round(t * rate);
  for (let i = 0; i < dur * rate && s + i < buf.length; i++) buf[s + i]! += amp * rnd() * Math.exp(-i / ((dur * rate) / 5));
}
function kick(buf: Float64Array, t: number, rate: number, amp = 0.9) {
  const s = Math.round(t * rate);
  let phase = 0;
  for (let i = 0; i < 0.15 * rate && s + i < buf.length; i++) {
    phase += (2 * Math.PI * (50 + 100 * Math.exp(-i / (0.03 * rate)))) / rate;
    buf[s + i]! += amp * Math.sin(phase) * Math.exp(-i / (0.05 * rate));
  }
}

/** Clicks every beat from `offset`: the samples and the true beat times. */
export function clickTrack(bpm: number, seconds: number, offset: number, rate = RATE) {
  const buf = new Float64Array(Math.round(seconds * rate));
  const truth: Array<number> = [];
  for (let t = offset; t < seconds - 0.05; t += 60 / bpm) {
    click(buf, t, rate);
    truth.push(t);
  }
  return { buf, truth };
}

/** Kick on 1 and 3, a snare (noise) on 2 and 4, hats on every eighth, all over steady noise. */
export function drums(bpm: number, seconds: number, offset: number, rate = RATE, seed = 7) {
  const rnd = noise(seed);
  const buf = new Float64Array(Math.round(seconds * rate));
  for (let i = 0; i < buf.length; i++) buf[i] = 0.05 * rnd();
  const truth: Array<number> = [];
  const beat = 60 / bpm;
  let k = 0;
  for (let t = offset; t < seconds - 0.2; t += beat, k++) {
    truth.push(t);
    if (k % 2 === 0) kick(buf, t, rate);
    else burst(buf, t, rate, 0.6, 0.12, rnd);
    burst(buf, t, rate, 0.15, 0.03, rnd);
    burst(buf, t + beat / 2, rate, 0.15, 0.03, rnd);
  }
  return { buf, truth };
}

/** A 16-bit mono WAV. */
export function writeWav(path: string, samples: Float64Array, rate = RATE) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([head, data]));
}

/**
 * A pop pattern: kick on 1 and 3, snare on 2 and 4, a hat on every eighth (on the beats and between
 * them), over a noise floor of `floor` (0: digital silence between hits). `swing` places the
 * off-beat hat (0.5 straight, 2/3 swung).
 */
export function pop(
  bpm: number,
  seconds: number,
  { floor = 0, swing = 0.5, rate = RATE, seed = 5 }: { floor?: number; swing?: number; rate?: number; seed?: number } = {},
) {
  const rnd = noise(seed);
  const buf = new Float64Array(Math.round(seconds * rate));
  for (let i = 0; i < buf.length; i++) buf[i] = floor * rnd();
  const truth: Array<number> = [];
  const beat = 60 / bpm;
  let k = 0;
  for (let t = 0.3; t < seconds - 0.3; t += beat, k++) {
    truth.push(t);
    if (k % 2 === 0) kick(buf, t, rate);
    else burst(buf, t, rate, 0.6, 0.12, rnd);
    burst(buf, t, rate, 0.15, 0.03, rnd);
    burst(buf, t + beat * swing, rate, 0.15, 0.03, rnd);
  }
  return { buf, truth };
}

/** A waltz: a kick on each bar's first beat, a lighter hit on the other two. */
export function waltz(bpm: number, seconds: number, rate = RATE, seed = 9) {
  const rnd = noise(seed);
  const buf = new Float64Array(Math.round(seconds * rate));
  const truth: Array<number> = [];
  let k = 0;
  for (let t = 0.3; t < seconds - 0.3; t += 60 / bpm, k++) {
    truth.push(t);
    if (k % 3 === 0) kick(buf, t, rate);
    else burst(buf, t, rate, 0.3, 0.06, rnd);
  }
  return { buf, truth };
}
