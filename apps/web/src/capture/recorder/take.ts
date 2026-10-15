import type { MultiLayout } from "@uncut/contracts";
import { muteOutput } from "../../audio/audio.ts";
import { playback, getPlayback } from "../../preview/playback.ts";
import { type CaptureSource, bridge } from "../../state/bridge.ts";
import { actions, getState, subscribeApp } from "../../state/store.ts";
import { type TakeMode, type Resolution, type PartKind, type RecorderState, set, stopStream, state, errorText, COUNTDOWN, MIN_TAKE_MS, listeners } from "./state.ts";
import { openParts, openStreams } from "./streams.ts";
import { closeMonitor, closePreview } from "./devices.ts";

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
  /** D211: the sources of a multi-source take (each its own file; with more than one, or mode "multi"). */
  readonly parts?: ReadonlyArray<PartKind>;
  /** D211: where the camera goes over the screen. */
  readonly layout?: MultiLayout;
}

/** D211: one source's recorder in a multi-source take. */
interface PartRec {
  readonly kind: PartKind;
  readonly recorder: MediaRecorder;
  readonly mime: string;
  readonly chunks: Array<Blob>;
  startMs: number | undefined;
  stopMs: number | undefined;
}

/** Whether a take records its sources into separate files (D211). */
export const isMulti = (options: Pick<TakeOptions, "mode" | "parts">) => options.mode === "multi" || (options.parts?.length ?? 0) > 1;

export interface Running {
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
  /** D211: a multi-source take's recorders. */
  parts: Array<PartRec> | undefined;
  finished: boolean;
}

/** The take's recorders (one, or one per source). */
const recordersOf = (r: Running): Array<MediaRecorder> => (r.parts ? r.parts.map((p) => p.recorder) : r.recorder ? [r.recorder] : []);
export let running: Running | undefined;

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
  set({ phase: "idle", mode: undefined, count: undefined, startedAt: undefined, agentId: undefined, paused: false, pausedMs: 0, pausedAt: undefined, parts: undefined, ...patch });
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
  if (state.screenLive) set({ screenLive: undefined });
}

/** The recorder (the first one of a multi-source take) started: the timer, a timed stop, the timeline playing. */
function recordingStarted(r: Running, startMs: number) {
  const { options } = r;
  r.startMs = startMs;
  set({ phase: "recording", count: undefined, startedAt: Date.now() });
  if (options.seconds && options.seconds > 0) r.autoStop = setTimeout(() => void stopTake(), options.seconds * 1000);
  // Play the timeline from where the take goes, for timing (muted unless asked otherwise).
  if ((options.mode === "voiceover" || options.mode === "system") && options.playTimeline) {
    muteOutput(options.muteTimeline !== false);
    playback.seek(r.frame);
    playback.play();
    r.playing = true;
  }
}

/** D211: one MediaRecorder per source, all started in the same tick; the take ends when every one has stopped. */
function startParts(r: Running, streams: Map<PartKind, MediaStream>) {
  const { options } = r;
  const recs: Array<PartRec> = [];
  try {
    for (const [kind, stream] of streams) {
      const video = kind === "screen" || kind === "camera";
      const mime = pickMime(video);
      const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), ...(video ? { videoBitsPerSecond: kind === "camera" && options.resolution === "720p" ? 6_000_000 : 10_000_000 } : {}), audioBitsPerSecond: 192_000 });
      recs.push({ kind, recorder, mime, chunks: [], startMs: undefined, stopMs: undefined });
    }
  } catch (error) {
    release(r);
    return endTake(r, { message: { kind: "error", text: `Recording couldn't start: ${errorText(error)}` } });
  }
  r.parts = recs;
  for (const p of recs) {
    p.recorder.ondataavailable = (e) => {
      if (e.data.size) p.chunks.push(e.data);
    };
    p.recorder.onstart = (e) => {
      // The event's own time (the page's clock): when this recorder's file begins.
      p.startMs = e.timeStamp > 0 ? e.timeStamp : performance.now();
      if (state.phase === "countdown" && running === r) recordingStarted(r, p.startMs);
    };
    p.recorder.onstop = () => {
      p.stopMs = performance.now();
      if (recs.every((x) => x.stopMs !== undefined)) void finishParts(r);
    };
  }
  try {
    for (const p of recs) p.recorder.start(250);
  } catch (error) {
    for (const p of recs) if (p.recorder.state !== "inactive") p.recorder.stop();
    r.parts = undefined;
    release(r);
    endTake(r, { message: { kind: "error", text: `Recording couldn't start: ${errorText(error)}` } });
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
  const r: Running = { options, dir: snapshot.dir, frame: Math.round(getPlayback().frame), streams: [], cleanups: [], recorder: undefined, chunks: [], cancelled: false, startMs: 0, pauseMs: undefined, pausedTotal: 0, playing: false, countdown: undefined, wake: undefined, autoStop: undefined, answered: false, awaited: false, parts: undefined, finished: false };
  running = r;
  const multi = isMulti(options);
  set({ phase: "countdown", mode: options.mode, count: COUNTDOWN, message: undefined, recordedMs: undefined, startedAt: undefined, agentId: options.agent?.id, paused: false, pausedMs: 0, pausedAt: undefined, parts: multi ? options.parts : undefined });
  const stream = multi ? await openParts(options, r) : await openStreams(options, r);
  if (typeof stream === "string" || r.cancelled) {
    release(r);
    return endTake(r, typeof stream === "string" ? { message: { kind: "error", text: stream } } : {});
  }
  for (let n = COUNTDOWN; n > 0; n--) {
    set({ count: n });
    await sleep(1000, r);
    if (r.cancelled) return;
  }
  if (stream instanceof Map) return startParts(r, stream);
  const video = options.mode !== "voiceover" && options.mode !== "system";
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
  recorder.onstart = () => recordingStarted(r, performance.now());
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
  const live = recordersOf(r).filter((x) => x.state !== "inactive");
  if (!live.length) return cancelTake();
  for (const x of live) x.stop();
}

/** D209: Pause the running take (the timer and the file stop; the timeline it plays pauses too). */
export function pauseTake() {
  const r = running;
  const recs = r ? recordersOf(r) : [];
  if (!r || !recs.length || recs.some((x) => x.state !== "recording")) return;
  for (const x of recs) x.pause();
  r.pauseMs = performance.now();
  clearTimeout(r.autoStop);
  if (r.playing) playback.pause();
  set({ paused: true, pausedAt: Date.now() });
}

/** D209: Resume a paused take. */
export function resumeTake() {
  const r = running;
  const recs = r ? recordersOf(r) : [];
  if (!r || !recs.length || recs.some((x) => x.state !== "paused") || r.pauseMs === undefined) return;
  r.pausedTotal += performance.now() - r.pauseMs;
  r.pauseMs = undefined;
  for (const x of recs) x.resume();
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
  const live = recordersOf(r).filter((x) => x.state !== "inactive");
  if (live.length) for (const x of live) x.stop();
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
  const audioOnly = options.mode === "voiceover" || options.mode === "system";
  const blob = new Blob(r.chunks, { type: mimeType.split(";")[0] || (audioOnly ? "audio/webm" : "video/webm") });
  if (options.agent) {
    // The agent's take: up to the server, then its turn imports it (Undo turn removes it).
    if (getState().snapshot?.dir !== r.dir) return endTake(r, { message: { kind: "error", text: "The project changed while recording, so the take wasn't added." } });
    const uploaded = await actions.uploadTake(blob, "screen");
    if ("message" in uploaded) return endTake(r, { message: { kind: "error", text: `The take couldn't be sent to the server: ${uploaded.message}` } });
    r.answered = true;
    void actions.agentScreenTake(options.agent.id, { path: uploaded.path, ...(options.source?.name ? { source: options.source.name } : {}) });
    return endTake(r, { message: { kind: "saved", text: `Recorded ${options.source?.name ?? "the screen"} for the agent.` } });
  }
  const kind = options.mode === "multi" ? "screen" : options.mode;
  const device = kind === "screen" ? options.source?.name : kind === "camera" ? state.cameras.find((c) => c.id === options.camera)?.label : kind === "system" ? undefined : state.mics.find((m) => m.id === options.mic)?.label;
  const place = audioOnly || options.place === true;
  const result = await actions.saveTake(blob, {
    kind,
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

/** D211: every recorder of a multi-source take stopped: the parts go up and in as one edit. */
async function finishParts(r: Running) {
  if (r.finished) return;
  r.finished = true;
  if (r.pauseMs !== undefined) (r.pausedTotal += performance.now() - r.pauseMs, (r.pauseMs = undefined));
  release(r);
  const parts = r.parts ?? [];
  const first = Math.min(...parts.map((p) => p.startMs ?? Infinity));
  const lengthOf = (p: PartRec) => (p.stopMs ?? 0) - (p.startMs ?? p.stopMs ?? 0) - r.pausedTotal;
  const recordedMs = Math.round(Math.min(...parts.map(lengthOf)));
  if (r.cancelled) return endTake(r, { message: { kind: "discarded", text: "Cancelled. Nothing was kept." } });
  if (!parts.length || recordedMs < MIN_TAKE_MS || parts.some((p) => !p.chunks.length)) return endTake(r, { recordedMs, message: { kind: "discarded", text: "That take was under a second, so it was discarded." } });
  const offsets: Partial<Record<PartKind, number>> = {};
  for (const p of parts) offsets[p.kind] = Math.round(((p.startMs ?? first) - first) * 10) / 10;
  set({ phase: "saving", startedAt: undefined, recordedMs, offsets });
  const { options } = r;
  const deviceOf = (kind: PartKind) =>
    kind === "screen" ? options.source?.name : kind === "camera" ? state.cameras.find((c) => c.id === options.camera)?.label : kind === "voiceover" ? state.mics.find((m) => m.id === options.mic)?.label : undefined;
  const result = await actions.saveMultiTake({
    parts: parts.map((p) => ({ blob: new Blob(p.chunks, { type: (p.recorder.mimeType || p.mime).split(";")[0] || (p.kind === "screen" || p.kind === "camera" ? "video/webm" : "audio/webm") }), kind: p.kind, device: deviceOf(p.kind), offsetMs: offsets[p.kind] ?? 0, recordedMs: lengthOf(p) })),
    name: parts.some((p) => p.kind === "screen") ? options.source?.name : undefined,
    placeAt: r.frame,
    layout: options.layout,
    dir: r.dir,
  });
  if ("problem" in result) return endTake(r, { message: { kind: "error", text: result.problem } });
  playback.seek(r.frame);
  endTake(r, { message: { kind: "saved", text: `${result.saved.name} (${result.saved.seconds.toFixed(1)} s, ${parts.length} files) is in Media and on the timeline at ${clock(r.frame / Math.max(1, getPlayback().fps))}.` } });
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
  const show = r && (state.mode === "screen" || r.options.parts?.includes("screen")) && state.phase !== "idle" && !r.options.agent;
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
