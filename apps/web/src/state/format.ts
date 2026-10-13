/** /Users/me/Movies/A.uncut → ~/Movies/A.uncut */
export const shortPath = (path: string, home: string) =>
  home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

/** Frames → HH:MM:SS, whole seconds (media durations). */
export const timecode = (frames: number, fps: number) => {
  const total = Math.floor(frames / fps);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
};

/** Frames → HH:MM:SS:FF, the transport's timecode (frame f is the moment f / fps, D38). */
export const frameTimecode = (frames: number, fps: number) => {
  const f = Math.max(0, Math.floor(frames));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${timecode(f, fps)}:${pad(f % fps)}`;
};

/** Seconds → the ruler's label: "0s", "15s", "1:30". */
export const rulerLabel = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export interface Canvas {
  readonly width: number;
  readonly height: number;
  readonly fps: 24 | 25 | 30 | 50 | 60;
}

export const CANVAS_PRESETS: ReadonlyArray<{ readonly id: string; readonly label: string; readonly ratio: string; readonly canvas: Canvas }> = [
  { id: "landscape", label: "Landscape", ratio: "16:9", canvas: { width: 1920, height: 1080, fps: 30 } },
  { id: "4k", label: "4K", ratio: "16:9", canvas: { width: 3840, height: 2160, fps: 60 } },
  { id: "vertical", label: "Vertical", ratio: "9:16", canvas: { width: 1080, height: 1920, fps: 30 } },
  { id: "social", label: "Social", ratio: "4:5", canvas: { width: 1080, height: 1350, fps: 30 } },
];

export const canvasLabel = (c: Canvas) => `${c.width}×${c.height}, ${c.fps} fps`;
