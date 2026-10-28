// What the agent and the critic get of the measured mix (the measure tool's sound, review_submit's
// sound facts): loudness per role as exported, each sound effect against the voice (or the music)
// around it with a verdict, and the loudness over time. Pure: the exporter measures (mixMeasure.ts).
import { projectTargetLufs, soundRoles, type Project, type SoundRole } from "@uncut/core";

import { BLOCK_S, type LoudnessTrace } from "../export/plan/mixMeasure.ts";
import type { MixTraces } from "../export/exporter/mixMeasure.ts";

/**
 * A background effect's loudest moment (momentary, 400 ms) sits this many dB under the voice around
 * it. Set by ear on a real promo: the user found 10 to 21 dB under too loud, fixed it by hand at
 * 24 to 28 dB under, and 31 dB or more too quiet.
 */
export const EFFECT_UNDER_VOICE = { min: 22, max: 30 } as const;
/** Without a voice, under the music around it. */
export const EFFECT_UNDER_MUSIC = { min: 6, max: 18 } as const;
/** A music bed under speech sits this many dB under the voice. */
export const MUSIC_UNDER_VOICE = { min: 10, max: 20 } as const;
/** The voice or music counts as around an effect within this many seconds of it. */
export const AROUND_S = 3;
/** Quieter than this (LUFS) is silence for the readings. */
const SILENT = -60;
/** At most this many readings over time per role. */
const MAX_POINTS = 60;

const round1 = (v: number) => Math.round(v * 10) / 10;
const lufsText = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(round1(v)).toFixed(1)} LUFS`;
const sec = (s: number) => `${round1(s).toFixed(1)} s`;

/** The blocks of a trace whose 400 ms window ends inside [from, to] seconds. */
function blocks(values: ReadonlyArray<number>, from: number, to: number) {
  const first = Math.max(0, Math.ceil(from / BLOCK_S) - 1);
  const last = Math.min(values.length - 1, Math.floor(to / BLOCK_S) - 1);
  return values.slice(first, last + 1);
}

/** Gated mean loudness of momentary readings (ebur128's integration: absolute gate, then 10 LU under the mean); undefined under half a second of sound. */
export function gatedLoudness(readings: ReadonlyArray<number>): number | undefined {
  const energy = (xs: ReadonlyArray<number>) => 10 * Math.log10(xs.reduce((sum, x) => sum + 10 ** (x / 10), 0) / xs.length);
  const heard = readings.filter((x) => x > SILENT);
  if (heard.length < 5) return undefined;
  const relative = energy(heard) - 10;
  const kept = heard.filter((x) => x > relative);
  return kept.length ? energy(kept) : undefined;
}

export interface EffectReading {
  readonly item: string;
  readonly label: string;
  readonly kind: string;
  readonly at: number;
  /** Its loudest momentary reading (LUFS, as exported). */
  readonly peak: number | null;
  readonly against: "voice" | "music" | null;
  /** How far under the voice or music around it (dB; negative: over it). */
  readonly under: number | null;
  readonly verdict: string;
}

/** An effect's verdict from how far under the voice or music it sits. */
export function effectVerdict(under: number | null, against: "voice" | "music" | null): string {
  if (under === null || against === null) return "plays with nothing else sounding around it; judge it against the film's overall level";
  const band = against === "voice" ? EFFECT_UNDER_VOICE : EFFECT_UNDER_MUSIC;
  const where = under >= 0 ? `${round1(under)} dB under the ${against}` : `${round1(-under)} dB over the ${against}`;
  const typical = `typical ${band.min} to ${band.max} dB under`;
  const toMiddle = Math.round((band.min + band.max) / 2 - under);
  if (under < band.min) return `${where}: likely too loud for a background effect (${typical}); lower its gain by about ${toMiddle} dB`;
  if (under > band.max) return `${where}: likely too quiet to notice (${typical}); raise its gain by about ${-toMiddle} dB`;
  return `${where}: fine (${typical})`;
}

/** The readings of one role, sampled every `every` seconds (short-term, 3 s), rounded; null for silence. */
function overTime(trace: LoudnessTrace | undefined, every: number, shift: number) {
  if (!trace) return undefined;
  const step = Math.max(1, Math.round(every / BLOCK_S));
  const out: Array<number | null> = [];
  for (let k = step - 1; k < trace.shortTerm.length; k += step) {
    const v = trace.shortTerm[k]!;
    out.push(v > SILENT ? Math.round(v + shift) : null);
  }
  return out;
}

export interface MixReport {
  readonly levels: string;
  readonly master: { readonly lufs: number | null; readonly peakIntoLimiter: number | null; readonly exportGainDb: number; readonly targetLufs: number };
  readonly roles: Partial<Record<SoundRole, { readonly lufs: number | null }>>;
  readonly music?: string;
  readonly effects: ReadonlyArray<EffectReading>;
  readonly overTime: { readonly every: string; readonly note: string } & Partial<Record<SoundRole, ReadonlyArray<number | null>>>;
}

/**
 * The report: every level as exported (the export's loudness step moves the whole mix to the
 * project's target by one gain, before its limiter), each effect's loudest moment against the voice
 * around it (else the music), the music under the voice, and short-term loudness over time.
 */
export function mixReport(project: Project, traces: MixTraces): MixReport {
  const fps = project.canvas.fps;
  const targetLufs = projectTargetLufs(project);
  const shift = traces.master.lufs === null ? 0 : round1(targetLufs - traces.master.lufs);
  const as = (v: number | null) => (v === null ? null : round1(v + shift));
  const roles: Partial<Record<SoundRole, { lufs: number | null }>> = {};
  for (const [role, trace] of Object.entries(traces.roles) as Array<[SoundRole, LoudnessTrace]>) roles[role] = { lufs: as(trace.lufs) };
  const voice = traces.roles.voice;
  const music = traces.roles.music;
  const effects: Array<EffectReading> = [];
  for (const s of soundRoles(project).values()) {
    if (s.role !== "effects") continue;
    const from = s.start / fps;
    const to = (s.start + s.item.duration) / fps;
    const own = blocks(traces.roles.effects?.momentary ?? [], from + BLOCK_S, to + 0.4).filter((x) => x > SILENT);
    const peak = own.length ? Math.max(...own) : null;
    const around = (trace: LoudnessTrace | undefined) => (trace ? gatedLoudness(blocks(trace.momentary, from - AROUND_S, to + AROUND_S)) : undefined);
    const v = around(voice);
    const m = v === undefined ? around(music) : undefined;
    const against = v !== undefined ? "voice" : m !== undefined ? "music" : null;
    const ref = v ?? m;
    const under = peak === null || ref === undefined ? null : round1(ref - peak);
    effects.push({
      item: s.item.id,
      label: s.label,
      kind: s.kind ?? "other",
      at: round1(from),
      peak: as(peak),
      against,
      under,
      verdict: peak === null ? "silent in the mix (muted by its gain or fades)" : effectVerdict(under, against),
    });
  }
  effects.sort((a, b) => a.at - b.at);
  const every = Math.max(1, Math.ceil((traces.master.momentary.length * BLOCK_S) / MAX_POINTS));
  const series: Partial<Record<SoundRole, ReadonlyArray<number | null>>> = {};
  for (const role of Object.keys(traces.roles) as Array<SoundRole>) series[role] = overTime(traces.roles[role], every, shift);
  const levels = [
    `master ${traces.master.lufs === null ? "silent" : lufsText(targetLufs)}`,
    ...(Object.entries(roles) as Array<[SoundRole, { lufs: number | null }]>).map(([role, r]) => `${role} ${r.lufs === null ? "silent" : lufsText(r.lufs)}`),
  ].join(", ");
  return {
    levels: `Integrated loudness as exported: ${levels}.`,
    master: { lufs: as(traces.master.lufs), peakIntoLimiter: as(traces.master.truePeak), exportGainDb: shift, targetLufs },
    roles,
    ...(music && voice ? { music: musicUnderVoice(voice, music) } : {}),
    effects,
    overTime: { every: `${every} s`, note: "short-term loudness (3 s window, LUFS as exported) at the end of each step; null is silence", ...series },
  };
}

/** The music bed against the voice where both sound. */
function musicUnderVoice(voice: LoudnessTrace, music: LoudnessTrace): string | undefined {
  const both = voice.momentary.flatMap((v, k) => (v > SILENT && (music.momentary[k] ?? -Infinity) > SILENT ? [k] : []));
  const v = gatedLoudness(both.map((k) => voice.momentary[k]!));
  const m = gatedLoudness(both.map((k) => music.momentary[k]!));
  if (v === undefined || m === undefined) return undefined;
  const under = round1(v - m);
  const { min, max } = MUSIC_UNDER_VOICE;
  const verdict =
    under < min
      ? `too loud under speech (typical ${min} to ${max} dB under); duck it or lower its gain`
      : under > max
        ? `likely too quiet to hear (typical ${min} to ${max} dB under)`
        : `fine (typical ${min} to ${max} dB under)`;
  return `While someone speaks the music sits ${under >= 0 ? `${under} dB under` : `${-under} dB over`} the voice: ${verdict}.`;
}

/** The report as lines (the critic's sound facts). */
export function mixLines(report: MixReport): Array<string> {
  return [
    `Measured mix: ${report.levels.replace(/^Integrated loudness as exported: /, "integrated loudness as exported, ")}`,
    ...(report.music ? [report.music] : []),
    ...report.effects.map(
      (e) => `measured sound effect ${sec(e.at)} ${e.label} (${e.kind}): loudest ${e.peak === null ? "silent" : lufsText(e.peak)}, ${e.verdict}`,
    ),
  ];
}
