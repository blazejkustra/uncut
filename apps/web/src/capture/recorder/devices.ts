import { bridge, type MediaAccessKind } from "../../state/bridge.ts";
import { set, errorText, stopStream, state, PEAK_HOLD_MS, type Resolution } from "./state.ts";
import { running } from "./take.ts";

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

/** D210: asks the desktop shell whether this Mac can record its own sound. */
export async function refreshSystemAudio() {
  try {
    set({ systemAudio: (await bridge.systemAudio?.()) ?? { supported: false, macos: "" } });
  } catch {
    set({ systemAudio: { supported: false, macos: "" } });
  }
}

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

export const micConstraints = (id: string | undefined): MediaTrackConstraints => ({
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

export const cameraConstraints = (id: string | undefined, resolution: Resolution): MediaTrackConstraints => ({
  ...(id ? { deviceId: { exact: id } } : {}),
  // max as well as ideal: a camera already open at a bigger size (the preview) is scaled down, not handed over as is.
  width: { ideal: resolution === "1080p" ? 1920 : 1280, max: resolution === "1080p" ? 1920 : 1280 },
  height: { ideal: resolution === "1080p" ? 1080 : 720, max: resolution === "1080p" ? 1080 : 720 },
  frameRate: { ideal: 30 },
});

// What the Camera part wants shown (cleared when it closes); a newer open wins over a slower older one.
export let previewWanted: { readonly id: string | undefined; readonly resolution: Resolution } | undefined;
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
export function pausePreview() {
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
