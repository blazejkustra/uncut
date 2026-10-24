import { bridge } from "../../state/bridge.ts";
import { type Running, type TakeOptions, stopTake } from "./take.ts";
import { state, set, errorText, type PartKind } from "./state.ts";
import { refreshSystemAudio, pausePreview, previewWanted, openPreview, cameraConstraints, micConstraints } from "./devices.ts";

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

/** D210: tests' stand-in for this Mac's sound (never the real loopback): a steady tone. */
function standinAudio(): { stream: MediaStream; stop: () => void } {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  osc.frequency.value = 523;
  const gain = ctx.createGain();
  gain.gain.value = 0.2;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  return {
    stream: dest.stream,
    stop: () => {
      osc.stop();
      void ctx.close().catch(() => {});
    },
  };
}

/** getDisplayMedia's sound as recorded: what the Mac plays, untouched (no call processing). */
const DISPLAY_AUDIO: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
export const NO_SYSTEM_SOUND =
  "macOS gave no sound. Check that Uncut is on in System Settings, Privacy & Security, Screen & System Audio Recording, then try again.";

/**
 * D210: this Mac's sound as a stream: from `display` (a screen take's own getDisplayMedia) or, for
 * the sound without the screen, from a getDisplayMedia of any screen whose picture isn't kept
 * (getDisplayMedia always has one; it keeps running until the take ends). Throws a sentence.
 */
async function systemStream(r: Running, display?: MediaStream): Promise<MediaStream> {
  if (!state.systemAudio) await refreshSystemAudio();
  const support = state.systemAudio;
  if (!support?.supported) throw new Error(`Recording this Mac's sound needs macOS 13 or later${support?.macos ? ` (this Mac has ${support.macos})` : ""}.`);
  if (support.standin) {
    const tone = standinAudio();
    r.streams.push(tone.stream);
    r.cleanups.push(tone.stop);
    return tone.stream;
  }
  let source = display;
  if (!source) {
    await bridge.chooseDisplaySource("screen:any", { systemAudio: true });
    source = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: DISPLAY_AUDIO });
    r.streams.push(source);
  }
  const audio = source.getAudioTracks();
  if (!audio.length) throw new Error(NO_SYSTEM_SOUND);
  return new MediaStream(audio);
}

/** The camera for a take: the preview pauses and shows the take's own picture meanwhile. */
async function takeCamera(options: TakeOptions, r: Running): Promise<MediaStream> {
  pausePreview();
  r.cleanups.push(() => {
    if (state.preview && r.streams.includes(state.preview)) set({ preview: undefined });
    if (previewWanted) void openPreview(previewWanted.id, previewWanted.resolution);
  });
  const cam = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(options.camera, options.resolution ?? "1080p") });
  r.streams.push(cam);
  if (previewWanted) set({ preview: cam, previewError: undefined });
  return cam;
}

/** Opens what the take records; a sentence when it can't. */
export async function openStreams(options: TakeOptions, r: Running): Promise<MediaStream | string> {
  try {
    if (options.mode === "voiceover") {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(options.mic) });
      r.streams.push(mic);
      return mic;
    }
    // D210: this Mac's sound alone.
    if (options.mode === "system") return await systemStream(r);
    const tracks: Array<MediaStreamTrack> = [];
    if (options.mode === "camera") {
      // One stream from the camera while it records: the preview shows the take's own picture.
      tracks.push(...(await takeCamera(options, r)).getVideoTracks());
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
    const what =
      options.mode === "voiceover"
        ? "The microphone"
        : options.mode === "camera"
          ? "The camera"
          : options.mode === "system"
            ? "This Mac's sound"
            : "The screen";
    return `${what} couldn't be opened: ${errorText(error)}`;
  }
}

/** D211: opens every source of a multi-source take, each as its own stream; a sentence when one can't. */
export async function openParts(options: TakeOptions, r: Running): Promise<Map<PartKind, MediaStream> | string> {
  const parts = options.parts ?? [];
  const out = new Map<PartKind, MediaStream>();
  let what = "The screen";
  try {
    let display: MediaStream | undefined;
    if (parts.includes("screen")) {
      const source = options.source;
      if (!source) return "Pick a screen or window first.";
      if (source.id.startsWith("standin:")) {
        const standin = standinStream(source.name);
        r.streams.push(standin.stream);
        r.cleanups.push(standin.stop);
        out.set("screen", new MediaStream(standin.stream.getVideoTracks()));
      } else {
        const sound = parts.includes("system") && state.systemAudio?.supported === true;
        await bridge.chooseDisplaySource(source.id, { systemAudio: sound });
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: sound ? DISPLAY_AUDIO : false });
        r.streams.push(screen);
        display = screen;
        out.set("screen", new MediaStream(screen.getVideoTracks()));
        screen.getVideoTracks()[0]?.addEventListener("ended", () => void stopTake());
      }
      set({ screenLive: out.get("screen") });
    }
    if (parts.includes("camera")) {
      what = "The camera";
      out.set("camera", await takeCamera(options, r));
    }
    if (parts.includes("voiceover")) {
      what = "The microphone";
      const mic = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(options.mic) });
      r.streams.push(mic);
      out.set("voiceover", mic);
    }
    if (parts.includes("system")) {
      what = "This Mac's sound";
      out.set("system", await systemStream(r, display));
    }
  } catch (error) {
    return `${what} couldn't be opened: ${errorText(error)}`;
  }
  if (!out.size) return "Turn on at least one source.";
  return out;
}
