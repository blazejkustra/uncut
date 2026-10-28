// Recording on this Mac (D114): macOS's media access and the screens and windows to record.
import { systemPreferences, nativeImage, desktopCapturer } from "electron";
import type { MediaAccessKind, MediaAccess, CaptureSource } from "../ipc.ts";
import { mediaTest } from "./testMode.ts";
import { windows } from "./state.ts";

const MEDIA_KINDS: ReadonlyArray<MediaAccessKind> = ["microphone", "camera", "screen"];
export const isMediaKind = (x: unknown): x is MediaAccessKind => MEDIA_KINDS.includes(x as MediaAccessKind);

/** macOS's answer for each (tests: the test's states, macOS never asked). */
export function mediaAccess(): Record<MediaAccessKind, MediaAccess> {
  if (mediaTest) return { ...mediaTest.access };
  const read = (kind: MediaAccessKind) => {
    try {
      return systemPreferences.getMediaAccessStatus(kind) as MediaAccess;
    } catch {
      return "unknown" as const;
    }
  };
  return { microphone: read("microphone"), camera: read("camera"), screen: read("screen") };
}

/** Asks macOS for the microphone or camera (its prompt shows only while it's "not-determined"); the state after. */
export async function askMediaAccess(kind: MediaAccessKind): Promise<MediaAccess> {
  if (mediaTest) return mediaTest.access[kind];
  if (kind === "screen") return mediaAccess().screen;
  if (systemPreferences.getMediaAccessStatus(kind) === "not-determined") await systemPreferences.askForMediaAccess(kind).catch(() => false);
  return mediaAccess()[kind];
}

/** Tests' stand-in screen picture: a 160×100 dark frame with a green block (BGRA). */
function standinThumbnail(): string {
  const width = 160;
  const height = 100;
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const block = x > 30 && x < 70 && y > 35 && y < 75;
      px[i] = block ? 0x80 : 0x20;
      px[i + 1] = block ? 0xde : 0x18;
      px[i + 2] = block ? 0x4a : 0x10;
      px[i + 3] = 0xff;
    }
  return nativeImage.createFromBitmap(px, { width, height }).toDataURL();
}

/** Screens and windows to record, with small pictures; never Uncut's own windows. Tests: stand-ins. */
export async function captureSources(): Promise<Array<CaptureSource>> {
  if (mediaTest) {
    // D209: the stand-in screen has a picture drawn here (a data: URL like desktopCapturer's), the
    // stand-in window none, so both the picture and the placeholder are on screen in tests.
    return [
      { id: "standin:screen:1", name: "Test screen", kind: "screen", thumbnail: standinThumbnail() },
      { id: "standin:window:1", name: "Test window", kind: "window", thumbnail: "" },
    ];
  }
  const own = new Set(windows.map((w) => w.window.getMediaSourceId()));
  // thumbnailSize: without one the pictures are 150×150; the app icon is the fallback for a window
  // whose picture is empty (macOS gives none for a minimised one, or before Screen Recording is on).
  const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 480, height: 300 }, fetchWindowIcons: true });
  const url = (image: Electron.NativeImage | null | undefined) => (image && !image.isEmpty() ? image.toDataURL() : "");
  return sources
    .filter((s) => !own.has(s.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith("screen:") ? ("screen" as const) : ("window" as const),
      thumbnail: url(s.thumbnail),
      ...(url(s.appIcon) ? { icon: url(s.appIcon) } : {}),
    }));
}
