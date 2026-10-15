// D221: how macOS shows a <video> of BT.709 footage (its mid-tones lifted: grey 126 shows as 137;
// BT.601 footage, such as untagged SD, isn't) next to the same frame drawn into a canvas or uploaded
// to WebGL (shown as sRGB, unchanged). Measured on a grey ramp in the packaged app with the sRGB
// colour profile the app tests pin (D216): the <video>'s level at evenly spaced canvas levels 0, 15, ..., 255.
// D222: the preview shows a clip's values as the export holds them (as canvases, effects, stills,
// text and the GPU compositor do), so a <video> that macOS lifts gets the inverse of this table.
export const VIDEO_TONE: ReadonlyArray<number> = [0, 0.049, 0.1309, 0.2009, 0.2688, 0.333, 0.3961, 0.4549, 0.5137, 0.5698, 0.631, 0.686, 0.7392, 0.7922, 0.8456, 0.8986, 0.949, 1];

/** The lift at v (0–1): the table with linear interpolation, as an SVG table function reads it. */
export function videoTone(v: number): number {
  const n = VIDEO_TONE.length - 1;
  const x = Math.min(1, Math.max(0, v)) * n;
  const i = Math.min(n - 1, Math.floor(x));
  return VIDEO_TONE[i]! + (VIDEO_TONE[i + 1]! - VIDEO_TONE[i]!) * (x - i);
}

/** The level the <video> must be given to show v once lifted (the table is monotonic). */
export function videoUntone(v: number): number {
  const y = Math.min(1, Math.max(0, v));
  const n = VIDEO_TONE.length - 1;
  let i = 0;
  while (i < n - 1 && VIDEO_TONE[i + 1]! < y) i++;
  const a = VIDEO_TONE[i]!;
  const b = VIDEO_TONE[i + 1]!;
  return (i + (b > a ? (y - a) / (b - a) : 0)) / n;
}

/** videoUntone sampled finely enough (256 points) that the table's own interpolation adds nothing visible. */
export const VIDEO_UNTONE: ReadonlyArray<number> = Array.from({ length: 256 }, (_, k) => Math.round(videoUntone(k / 255) * 1e5) / 1e5);

export const VIDEO_UNTONE_FILTER = "uncut-video-untone";

/** The SVG filter (feComponentTransfer, in sRGB values) a lifted <video> is shown through: `filter: url(#uncut-video-untone)`. */
export function ensureUntoneFilter() {
  if (typeof document === "undefined" || document.getElementById(VIDEO_UNTONE_FILTER)) return;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  const filter = document.createElementNS(ns, "filter");
  filter.id = VIDEO_UNTONE_FILTER;
  filter.setAttribute("color-interpolation-filters", "sRGB");
  const transfer = document.createElementNS(ns, "feComponentTransfer");
  for (const ch of ["feFuncR", "feFuncG", "feFuncB"]) {
    const fn = document.createElementNS(ns, ch);
    fn.setAttribute("type", "table");
    fn.setAttribute("tableValues", VIDEO_UNTONE.join(" "));
    transfer.append(fn);
  }
  filter.append(transfer);
  svg.append(filter);
  document.body.append(svg);
}
