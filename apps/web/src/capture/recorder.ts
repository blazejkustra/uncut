// Recording on this Mac (D114): the Capture tab's microphone, camera and screen. The page records
// with MediaRecorder (webm), sends the file to the active server (store saveTake: /api/upload,
// then capture.save converts and imports it in one edit) and says how it went. One take at a time.
//
// Permissions come from the desktop shell (macOS's answer; tests get theirs from the test). The
// level meter and the camera preview run only while their part of the tab is open. A take under a
// second is discarded. A voiceover can play the timeline from the playhead while it records (the
// preview muted, so the microphone doesn't pick it up) and lands on a Voiceover track there.
import { useSyncExternalStore } from "react";

import { muteOutput } from "../audio/audio.ts";
import { getPlayback, playback } from "../preview/playback.ts";
import { bridge, type CaptureSource, type MediaAccess, type MediaAccessKind } from "../state/bridge.ts";
import { actions, getState, subscribeApp } from "../state/store.ts";

export type TakeMode = "voiceover" | "camera" | "screen";
export type Resolution = "720p" | "1080p";

export interface Input {
  readonly id: string;
  readonly label: string;
}

export interface RecorderState {
  readonly access: Readonly<Record<MediaAccessKind, MediaAccess>> | undefined;
  readonly mics: ReadonlyArray<Input>;
  readonly cameras: ReadonlyArray<Input>;
  /** The microphone's level now, 0 (silence, -60 dBFS or less) to 1 (0 dBFS). */
  readonly level: number;
  /** D209: the highest level of the last PEAK_HOLD_MS (the meter's peak mark), same scale. */
  readonly peak: number;
  readonly phase: "idle" | "countdown" | "recording" | "saving";
  /** D209: the running take is paused (MediaRecorder.pause: the gap isn't in the file). */
  readonly paused: boolean;
  /** Milliseconds the take spent paused so far (left out of the timer and recordedMs). */
  readonly pausedMs: number;
  /** When the current pause began (Date.now()). */
  readonly pausedAt: number | undefined;
  /** What the running take records. */
  readonly mode: TakeMode | undefined;
  /** 3, 2, 1 before the take starts. */
  readonly count: number | undefined;
  /** When the recorder started (Date.now()), for the timer. */
  readonly startedAt: number | undefined;
  /** The last take's length as the recorder measured it (start to stop events), ms. */
  readonly recordedMs: number | undefined;
  readonly message: { readonly kind: "saved" | "discarded" | "error"; readonly text: string } | undefined;
  readonly sources: ReadonlyArray<CaptureSource> | undefined;
  readonly sourcesError: string | undefined;
  readonly loadingSources: boolean;
  /** The camera's live picture while the Camera part is open. */
  readonly preview: MediaStream | undefined;
  readonly previewError: string | undefined;
  /** D144: the running take answers the agent's screen_record (its card id). */
  readonly agentId: string | undefined;
}

/** How long the meter's peak mark stays before it falls back (D209). */
export const PEAK_HOLD_MS = 1500;
/** The meter's dB scale: -60 dBFS (0) to 0 dBFS (1). */
export const levelDb = (level: number) => (level <= 0 ? -Infinity : level * 60 - 60);

/** Shorter than this, a take is discarded (a click on Record then Stop). */
export const MIN_TAKE_MS = 1000;
const COUNTDOWN = 3;

let state: RecorderState = {
  access: undefined,
  mics: [],
  cameras: [],
  level: 0,
  peak: 0,
  phase: "idle",
  paused: false,
  pausedMs: 0,
  pausedAt: undefined,
  mode: undefined,
  count: undefined,
  startedAt: undefined,
  recordedMs: undefined,
  message: undefined,
  sources: undefined,
  sourcesError: undefined,
  loadingSources: false,
  preview: undefined,
  previewError: undefined,
  agentId: undefined,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<RecorderState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const useRecorder = <T>(select: (s: RecorderState) => T): T => useSyncExternalStore(subscribe, () => select(state));
export const getRecorder = () => state;

const stopStream = (stream: MediaStream | undefined) => stream?.getTracks().forEach((t) => t.stop());
const errorText = (error: unknown) => {
  const e = error as { name?: string; message?: string };
  if (e?.name === "NotAllowedError") return "macOS or Uncut didn't allow it.";
  if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError") return "That device isn't there any more.";
  if (e?.name === "NotReadableError") return "Another app is using it.";
  return e?.message || String(error);
};

// ---- permissions and devices ----

export async function refreshAccess() {
  try {
    set({ access: await bridge.mediaAccess() });
  } catch {
    set({ access: { microphone: "unknown", camera: "unknown", screen: "unknown" } });
  }
}

export async function askAccess(kind: "microphone" | "camera") {
  await bridge.askMediaAccess(kind).catch(() => undefined);
  await refreshAccess();
  await loadInputs();
}

export const openPrivacySettings = (kind: MediaAccessKind) => void bridge.openPrivacySettings(kind).catch(() => {});

/** The microphones and cameras (their names show once the page may use them). */
export async function loadInputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const list = (kind: MediaDeviceKind, fallback: string) =>
      devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== "communications").map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
    set({ mics: list("audioinput", "Microphone"), cameras: list("videoinput", "Camera") });
  } catch {
    set({ mics: [], cameras: [] });
  }
}

const micConstraints = (id: string | undefined): MediaTrackConstraints => ({
  ...(id ? { deviceId: { exact: id } } : {}),
  // A voice for a video: what the microphone hears, not a call's processing.
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
});

// ---- the level meter ----

let monitor: { stream: MediaStream; ctx: AudioContext; raf: number } | undefined;

/** Meters the microphone `id` until closeMonitor; the stream also unlocks the devices' names. */
let monitorSeq = 0;
export async function openMonitor(id: string | undefined) {
  closeMonitor();
  const seq = monitorSeq;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(id) });
  } catch (error) {
    if (seq === monitorSeq) set({ level: 0, message: { kind: "error", text: `The microphone couldn't be opened: ${errorText(error)}` } });
    return;
  }
  // Closed or opened again meanwhile: this one isn't wanted.
  if (seq !== monitorSeq) return stopStream(stream);
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let last = 0;
  let peakAt = 0;
  const tick = (t: number) => {
    if (!monitor) return;
    monitor.raf = requestAnimationFrame(tick);
    if (t - last < 60) return;
    last = t;
    analyser.getFloatTimeDomainData(data);
    let sample = 0;
    for (const v of data) sample = Math.max(sample, Math.abs(v));
    const db = sample > 0 ? 20 * Math.log10(sample) : -Infinity;
    const level = Math.max(0, Math.min(1, (db + 60) / 60));
    // The peak mark holds the highest level for PEAK_HOLD_MS, then follows the level down.
    let peak = state.peak;
    if (level >= peak) {
      peak = level;
      peakAt = t;
    }
    else if (t - peakAt > PEAK_HOLD_MS) peak = Math.max(level, peak - 0.02);
    if (Math.abs(level - state.level) > 0.01 || peak !== state.peak) set({ level, peak });
  };
  monitor = { stream, ctx, raf: requestAnimationFrame(tick) };
  if (!state.mics.some((m) => m.label && !/^Microphone \d+$/.test(m.label))) await loadInputs();
}

export function closeMonitor() {
  ++monitorSeq;
  if (!monitor) return;
  cancelAnimationFrame(monitor.raf);
  stopStream(monitor.stream);
  void monitor.ctx.close().catch(() => {});
  monitor = undefined;
  set({ level: 0, peak: 0 });
}

// ---- the camera preview ----

const cameraConstraints = (id: string | undefined, resolution: Resolution): MediaTrackConstraints => ({
  ...(id ? { deviceId: { exact: id } } : {}),
  // max as well as ideal: a camera already open at a bigger size (the preview) is scaled down, not handed over as is.
  width: { ideal: resolution === "1080p" ? 1920 : 1280, max: resolution === "1080p" ? 1920 : 1280 },
  height: { ideal: resolution === "1080p" ? 1080 : 720, max: resolution === "1080p" ? 1080 : 720 },
  frameRate: { ideal: 30 },
});

// What the Camera part wants shown (cleared when it closes); a newer open wins over a slower older one.
let previewWanted: { readonly id: string | undefined; readonly resolution: Resolution } | undefined;
let previewSeq = 0;

/** The preview's stream, stopped unless a take records from it (then the take stops it). */
const stopPreviewStream = () => {
  if (state.preview && !running?.streams.includes(state.preview)) stopStream(state.preview);
};

export async function openPreview(id: string | undefined, resolution: Resolution) {
  previewWanted = { id, resolution };
  const seq = ++previewSeq;
  stopPreviewStream();
  set({ preview: undefined, previewError: undefined });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(id, resolution) });
    if (seq !== previewSeq) return stopStream(stream);
    set({ preview: stream, previewError: undefined });
    if (!state.cameras.some((c) => c.label && !/^Camera \d+$/.test(c.label))) await loadInputs();
  } catch (error) {
    if (seq === previewSeq) set({ preview: undefined, previewError: `The camera couldn't be opened: ${errorText(error)}` });
  }
}

/** Stops the preview's stream (a camera take shows its own meanwhile). */
function pausePreview() {
  ++previewSeq;
  stopPreviewStream();
  if (state.preview || state.previewError) set({ preview: undefined, previewError: undefined });
}

export function closePreview() {
  previewWanted = undefined;
  pausePreview();
}

// ---- screens and windows ----

export async function loadSources() {
  set({ loadingSources: true, sourcesError: undefined });
  try {
    const sources = await bridge.captureSources();
    set({ sources, loadingSources: false });
  } catch (error) {
    set({ sources: [], loadingSources: false, sourcesError: `Screens and windows couldn't be listed: ${errorText(error)}` });
  }
  await refreshAccess();
}

/** Tests' stand-in for a screen (never the real one): a moving picture drawn on a canvas. */
function standinStream(name: string): { stream: MediaStream; stop: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const g = canvas.getContext("2d")!;
  const started = performance.now();
  const draw = () => {
    const t = (performance.now() - started) / 1000;
    g.fillStyle = "#101820";
    g.fillRect(0, 0, 1280, 720);
    g.fillStyle = "#4ade80";
    g.fillRect(100 + ((t * 200) % 1000), 300, 120, 120);
    g.fillStyle = "#ffffff";
    g.font = "48px sans-serif";
    g.fillText(`${name} ${t.toFixed(1)} s`, 100, 160);
  };
  draw();
  const timer = setInterval(draw, 1000 / 30);
  const stream = canvas.captureStream(30);
  return { stream, stop: () => clearInterval(timer) };
}

// ---- a take ----

export interface TakeOptions {
  readonly mode: TakeMode;
  readonly mic?: string | undefined;
  /** Camera and screen: record the microphone too. */
  readonly withMic?: boolean;
  readonly camera?: string | undefined;
  readonly resolution?: Resolution;
  readonly source?: CaptureSource | undefined;
  /** Voiceover: play the timeline from the playhead while recording, and whether muted. */
  readonly playTimeline?: boolean;
  readonly muteTimeline?: boolean;
  /** Camera and screen: put the take on the timeline at the playhead too. */
  readonly place?: boolean;
  /** Stop by itself after this many seconds of recording (D144's screen_record). */
  readonly seconds?: number;
  /** D144: the agent's screen_record this take answers (card id): uploaded and handed to the agent's turn, not saved as the user's edit. */
  readonly agent?: { readonly id: string };
}

interface Running {
  readonly options: TakeOptions;
  readonly dir: string;
  readonly frame: number;
  readonly streams: Array<MediaStream>;
  readonly cleanups: Array<() => void>;
  recorder: MediaRecorder | undefined;
  chunks: Array<Blob>;
  cancelled: boolean;
  startMs: number;
  /** performance.now() of the current pause, and the milliseconds paused before it. */
  pauseMs: number | undefined;
  pausedTotal: number;
  playing: boolean;
  countdown: ReturnType<typeof setTimeout> | undefined;
  /** Resolves the countdown early (cancel). */
  wake: (() => void) | undefined;
  /** The timed stop (options.seconds). */
  autoStop: ReturnType<typeof setTimeout> | undefined;
  /** The agent got its answer already. */
  answered: boolean;
  /** The server was seen waiting for this take (AgentState.screenTake). */
  awaited: boolean;
}
let running: Running | undefined;

/** Ends take `r` in the UI; nothing when another take has started since (its state isn't touched). */
function endTake(r: Running, patch: Partial<RecorderState>) {
  clearTimeout(r.autoStop);
  // An agent's take that didn't make it: the agent hears why.
  if (r.options.agent && !r.answered) {
    r.answered = true;
    void actions.agentScreenTake(r.options.agent.id, { problem: patch.message?.kind === "discarded" ? (r.cancelled ? "The user cancelled the recording." : "The take was too short.") : patch.message?.text ?? "The recording didn't work." });
  }
  if (running !== r) return;
  running = undefined;
  set({ phase: "idle", mode: undefined, count: undefined, startedAt: undefined, agentId: undefined, paused: false, pausedMs: 0, pausedAt: undefined, ...patch });
}

const pickMime = (video: boolean) =>
  (video ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"] : ["audio/webm;codecs=opus", "audio/webm"]).find((m) => MediaRecorder.isTypeSupported(m)) ?? "";

const sleep = (ms: number, r: Running) =>
  new Promise<void>((resolve) => {
    r.wake = resolve;
    r.countdown = setTimeout(resolve, ms);
  });

function release(r: Running) {
  for (const s of r.streams) stopStream(s);
  for (const c of r.cleanups) c();
  // The timeline played for timing: back to where the take starts (saved, discarded or cancelled).
  if (r.playing) {
    playback.pause();
    playback.seek(r.frame);
    r.playing = false;
  }
  muteOutput(false);
}

/** Opens what the take records; a sentence when it can't. */
async function openStreams(options: TakeOptions, r: Running): Promise<MediaStream | string> {
  try {
    if (options.mode === "voiceover") {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(options.mic) });
      r.streams.push(mic);
      return mic;
    }
    const tracks: Array<MediaStreamTrack> = [];
    if (options.mode === "camera") {
      // One stream from the camera while it records: the preview shows the take's own picture.
      pausePreview();
      r.cleanups.push(() => {
        if (state.preview && r.streams.includes(state.preview)) set({ preview: undefined });
        if (previewWanted) void openPreview(previewWanted.id, previewWanted.resolution);
      });
      const cam = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(options.camera, options.resolution ?? "1080p") });
      r.streams.push(cam);
      if (previewWanted) set({ preview: cam, previewError: undefined });
      tracks.push(...cam.getVideoTracks());
    } else {
      const source = options.source;
      if (!source) return "Pick a screen or window first.";
      if (source.id.startsWith("standin:")) {
        const standin = standinStream(source.name);
        r.streams.push(standin.stream);
        r.cleanups.push(standin.stop);
        tracks.push(...standin.stream.getVideoTracks());
      } else {
        await bridge.chooseDisplaySource(source.id);
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
        r.streams.push(screen);
        tracks.push(...screen.getVideoTracks());
        // The user stopped sharing from macOS's menu: the take ends there.
        screen.getVideoTracks()[0]?.addEventListener("ended", () => void stopTake());
      }
    }
    if (options.withMic) {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(options.mic) });
      r.streams.push(mic);
      tracks.push(...mic.getAudioTracks());
    }
    return new MediaStream(tracks);
  } catch (error) {
    const what = options.mode === "voiceover" ? "The microphone" : options.mode === "camera" ? "The camera" : "The screen";
    return `${what} couldn't be opened: ${errorText(error)}`;
  }
}

/** Record: opens the devices, counts 3-2-1, then records until stopTake or cancelTake. */
export async function startTake(options: TakeOptions) {
  const snapshot = getState().snapshot;
  const refuse = (text: string) => {
    if (options.agent) void actions.agentScreenTake(options.agent.id, { problem: text });
  };
  if (running || state.phase !== "idle") return refuse("Another recording is running in Uncut.");
  if (!snapshot) {
    refuse("No project is open.");
    return set({ message: { kind: "error", text: "Open a project first: takes go into its media folder." } });
  }
  const r: Running = { options, dir: snapshot.dir, frame: Math.round(getPlayback().frame), streams: [], cleanups: [], recorder: undefined, chunks: [], cancelled: false, startMs: 0, pauseMs: undefined, pausedTotal: 0, playing: false, countdown: undefined, wake: undefined, autoStop: undefined, answered: false, awaited: false };
  running = r;
  set({ phase: "countdown", mode: options.mode, count: COUNTDOWN, message: undefined, recordedMs: undefined, startedAt: undefined, agentId: options.agent?.id, paused: false, pausedMs: 0, pausedAt: undefined });
  const stream = await openStreams(options, r);
  if (typeof stream === "string" || r.cancelled) {
    release(r);
    return endTake(r, typeof stream === "string" ? { message: { kind: "error", text: stream } } : {});
  }
  for (let n = COUNTDOWN; n > 0; n--) {
    set({ count: n });
    await sleep(1000, r);
    if (r.cancelled) return;
  }
  const video = options.mode !== "voiceover";
  const mimeType = pickMime(video);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), ...(video ? { videoBitsPerSecond: options.resolution === "720p" ? 6_000_000 : 10_000_000 } : {}), audioBitsPerSecond: 192_000 });
  } catch (error) {
    release(r);
    return endTake(r, { message: { kind: "error", text: `Recording couldn't start: ${errorText(error)}` } });
  }
  r.recorder = recorder;
  recorder.ondataavailable = (e) => {
    if (e.data.size) r.chunks.push(e.data);
  };
  recorder.onstart = () => {
    r.startMs = performance.now();
    set({ phase: "recording", count: undefined, startedAt: Date.now() });
    if (options.seconds && options.seconds > 0) r.autoStop = setTimeout(() => void stopTake(), options.seconds * 1000);
    // Play the timeline from where the take goes, for timing (muted unless asked otherwise).
    if (options.mode === "voiceover" && options.playTimeline) {
      muteOutput(options.muteTimeline !== false);
      playback.seek(r.frame);
      playback.play();
      r.playing = true;
    }
  };
  recorder.onstop = () => {
    // A take stopped while paused: the pause up to now isn't in the file either.
    if (r.pauseMs !== undefined) (r.pausedTotal += performance.now() - r.pauseMs, (r.pauseMs = undefined));
    void finish(r, performance.now() - r.startMs - r.pausedTotal, recorder.mimeType || mimeType);
  };
  try {
    recorder.start(250);
  } catch (error) {
    r.recorder = undefined;
    release(r);
    endTake(r, { message: { kind: "error", text: `Recording couldn't start: ${errorText(error)}` } });
  }
}

/** Stop: the take is saved (or discarded when under a second). */
export async function stopTake() {
  const r = running;
  if (!r) return;
  if (!r.recorder || r.recorder.state === "inactive") return cancelTake();
  r.recorder.stop();
}

/** D209: Pause the running take (the timer and the file stop; the timeline it plays pauses too). */
export function pauseTake() {
  const r = running;
  if (!r?.recorder || r.recorder.state !== "recording") return;
  r.recorder.pause();
  r.pauseMs = performance.now();
  clearTimeout(r.autoStop);
  if (r.playing) playback.pause();
  set({ paused: true, pausedAt: Date.now() });
}

/** D209: Resume a paused take. */
export function resumeTake() {
  const r = running;
  if (!r?.recorder || r.recorder.state !== "paused" || r.pauseMs === undefined) return;
  r.pausedTotal += performance.now() - r.pauseMs;
  r.pauseMs = undefined;
  r.recorder.resume();
  if (r.playing) playback.play();
  if (r.options.seconds && r.options.seconds > 0) r.autoStop = setTimeout(() => void stopTake(), Math.max(0, r.options.seconds * 1000 - (performance.now() - r.startMs - r.pausedTotal)));
  set({ paused: false, pausedMs: state.pausedMs + (Date.now() - (state.pausedAt ?? Date.now())), pausedAt: undefined });
}

/** Seconds the running take has recorded (pauses left out), for the timer. */
export const takeSeconds = (s: Pick<RecorderState, "startedAt" | "pausedMs" | "pausedAt">, now = Date.now()) =>
  s.startedAt === undefined ? 0 : Math.max(0, (s.pausedAt ?? now) - s.startedAt - s.pausedMs) / 1000;

/** Cancel: nothing is kept. */
export function cancelTake() {
  const r = running;
  if (!r) return;
  r.cancelled = true;
  clearTimeout(r.countdown);
  r.wake?.();
  if (r.recorder && r.recorder.state !== "inactive") r.recorder.stop();
  else {
    // The devices may still be opening: startTake releases what they give once it sees `cancelled`.
    release(r);
    endTake(r, { message: { kind: "discarded", text: "Cancelled. Nothing was kept." } });
  }
}

async function finish(r: Running, ms: number, mimeType: string) {
  release(r);
  const recordedMs = Math.round(ms);
  if (r.cancelled) return endTake(r, { message: { kind: "discarded", text: "Cancelled. Nothing was kept." } });
  if (recordedMs < MIN_TAKE_MS || !r.chunks.length) return endTake(r, { recordedMs, message: { kind: "discarded", text: "That take was under a second, so it was discarded." } });
  set({ phase: "saving", startedAt: undefined, recordedMs });
  const { options } = r;
  const blob = new Blob(r.chunks, { type: mimeType.split(";")[0] || (options.mode === "voiceover" ? "audio/webm" : "video/webm") });
  if (options.agent) {
    // The agent's take: up to the server, then its turn imports it (Undo turn removes it).
    if (getState().snapshot?.dir !== r.dir) return endTake(r, { message: { kind: "error", text: "The project changed while recording, so the take wasn't added." } });
    const uploaded = await actions.uploadTake(blob, options.mode);
    if ("message" in uploaded) return endTake(r, { message: { kind: "error", text: `The take couldn't be sent to the server: ${uploaded.message}` } });
    r.answered = true;
    void actions.agentScreenTake(options.agent.id, { path: uploaded.path, ...(options.source?.name ? { source: options.source.name } : {}) });
    return endTake(r, { message: { kind: "saved", text: `Recorded ${options.source?.name ?? "the screen"} for the agent.` } });
  }
  const device = options.mode === "screen" ? options.source?.name : options.mode === "camera" ? state.cameras.find((c) => c.id === options.camera)?.label : state.mics.find((m) => m.id === options.mic)?.label;
  const place = options.mode === "voiceover" || options.place === true;
  const result = await actions.saveTake(blob, {
    kind: options.mode,
    dir: r.dir,
    ...(options.mode === "screen" && options.source ? { name: options.source.name } : {}),
    ...(device ? { device } : {}),
    ...(place ? { placeAt: r.frame } : {}),
  });
  if ("problem" in result) return endTake(r, { message: { kind: "error", text: result.problem } });
  const { saved } = result;
  const where = saved.itemId ? ` and on the timeline at ${clock(r.frame / Math.max(1, getPlayback().fps))}` : "";
  if (saved.itemId) playback.seek(r.frame);
  endTake(r, { message: { kind: "saved", text: `${saved.name} (${saved.seconds.toFixed(1)} s) is in Media${where}.` } });
}

/**
 * D144: an agent's take is cancelled (streams stopped, nothing kept) once nobody waits for it: the
 * project changed, the turn stopped or finished, or the server stopped waiting (timed out).
 */
function watchAgentTake() {
  const r = running;
  if (!r?.options.agent || r.cancelled) return;
  const app = getState();
  const id = r.options.agent.id;
  if (app.agent?.screenTake === id) r.awaited = true;
  const gone = app.snapshot?.dir !== r.dir || !app.agent || app.agent.dir !== r.dir || app.agent.running === null || (r.awaited && app.agent.screenTake !== id);
  if (gone) {
    // The server isn't listening any more: no answer goes back (an upload already on its way is deleted there).
    r.answered = true;
    cancelTake();
  }
}
subscribeApp(watchAgentTake);

export const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The Capture tab went away: devices close; a running take keeps going until Stop. */
export function closeAll() {
  closeMonitor();
  closePreview();
}

// ---- the floating mini recorder (D209) ----

// While the screen is recorded the take's controls float over every app in a small window of their
// own (always on top, left out of screen captures); its buttons come back here.
let miniShown = "";
function syncMini() {
  const r = running;
  const show = r && state.mode === "screen" && state.phase !== "idle" && !r.options.agent;
  const mini = show
    ? {
        name: r.options.source?.name ?? "Screen",
        phase: state.phase === "recording" && state.paused ? ("paused" as const) : (state.phase as "countdown" | "recording" | "saving"),
        seconds: takeSeconds(state),
        at: Date.now(),
        ...(state.count !== undefined ? { count: state.count } : {}),
      }
    : null;
  // Only when something it shows changes (the timer runs on its own from seconds and at).
  const key = mini ? `${mini.name}|${mini.phase}|${mini.count ?? ""}|${state.pausedMs}|${state.startedAt ?? ""}` : "";
  if (key === miniShown) return;
  miniShown = key;
  bridge.miniRecorder?.(mini);
}
listeners.add(syncMini);
bridge.onMiniRecorderAction?.((action) => {
  if (action === "stop") void stopTake();
  else if (action === "cancel") cancelTake();
  else if (action === "pause") pauseTake();
  else if (action === "resume") resumeTake();
});
