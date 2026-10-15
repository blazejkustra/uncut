// The beats analyzer's tuning (D70): sample rate, spectrogram, tempo range, onset picking.
export const SAMPLE_RATE = 11025;
/** Samples per spectrogram frame (46 ms) and between frames (11.6 ms). */
export const WINDOW = 512;
export const HOP = 128;
/** Envelope frames per second. */
export const FRAME_RATE = SAMPLE_RATE / HOP;
export const MIN_BPM = 60;
export const MAX_BPM = 200;
export const PRIOR_BPM = 120;
export const PRIOR_OCTAVES = 1;
export const COMB = 4;
export const HALF_PULSE = 0.6;
export const TIGHTNESS = 100;
/**
 * Log magnitudes are floored RANGE_DB below the loudest band magnitude lately (a running peak that
 * decays by PEAK_DECAY a frame, ~8 s half-life), and never below ABS_FLOOR (about −72 dB under a
 * full-scale sine's band): a hit after digital silence would otherwise rise from log(0), so a
 * quiet hat measured nearly as big as a kick (and the first hit came ~20 ms early).
 */
export const RANGE_DB = 35;
export const PEAK_DECAY = 0.999;
export const ABS_FLOOR = 0.03;
/** The low bands' flux (below LOW_HZ: kicks, bass) is a second envelope, added with the same weight as the full one. */
export const LOW_HZ = 200;
/** Spectral flux is summed over this many mel bands between BAND_LOW and BAND_HIGH Hz. */
export const BANDS = 40;
export const BAND_LOW = 30;
export const BAND_HIGH = 5000;
/** Onset picking: a peak must be the maximum within ±MAX_S, above the mean over [−PRE_AVG_S, +POST_AVG_S] plus DELTA × the typical peak, and MIN_GAP_S after the last onset. */
export const MAX_S = 0.03;
export const PRE_AVG_S = 0.1;
export const POST_AVG_S = 0.07;
export const DELTA = 0.07;
export const MIN_GAP_S = 0.03;
/** Below this pulse clarity (or with fewer onsets than MIN_ONSETS) there's no beat to speak of: bpm null, no beats. */
export const MIN_CONFIDENCE = 0.15;
export const MIN_ONSETS = 4;
const JOB_TIMEOUT_MS = 30 * 60_000;
export const timeoutFor = (seconds: number | undefined) => Math.max(JOB_TIMEOUT_MS, Math.round((seconds ?? 0) * 4 * 1000));
