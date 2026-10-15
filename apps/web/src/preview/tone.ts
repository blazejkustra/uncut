// D221: how macOS shows a <video> of BT.709 footage (its mid-tones lifted: grey 126 shows as 137;
// BT.601 footage, such as untagged SD, isn't) next to the same frame drawn into a canvas or uploaded
// to WebGL (shown as sRGB, unchanged). Measured
// on a grey ramp in the packaged app with the sRGB colour profile the app tests pin (D216): the
// <video>'s level at evenly spaced canvas levels 0, 15, ..., 255. The scrub cache's canvas (CSS filter)
// and the GPU compositor's video layers (in their shader) go through it, so swapping them with the
// <video> doesn't shift the picture. The DOM path's effects canvases (D136) don't, as before.
export const VIDEO_TONE: ReadonlyArray<number> = [0, 0.049, 0.1309, 0.2009, 0.2688, 0.333, 0.3961, 0.4549, 0.5137, 0.5698, 0.631, 0.686, 0.7392, 0.7922, 0.8456, 0.8986, 0.949, 1];

/** GLSL: `vec3 videoTone(vec3)`, the table with linear interpolation. */
export const VIDEO_TONE_GLSL = `
const float TONE[${VIDEO_TONE.length}] = float[${VIDEO_TONE.length}](${VIDEO_TONE.map((v) => v.toFixed(4)).join(", ")});
float toneOf(float v) {
  float x = clamp(v, 0.0, 1.0)*${(VIDEO_TONE.length - 1).toFixed(1)};
  int i = int(min(floor(x), ${(VIDEO_TONE.length - 2).toFixed(1)}));
  return mix(TONE[i], TONE[i + 1], x - float(i));
}
vec3 videoTone(vec3 c) { return vec3(toneOf(c.r), toneOf(c.g), toneOf(c.b)); }`;

export const VIDEO_TONE_FILTER = "uncut-video-tone";

/** The SVG filter (feComponentTransfer, in sRGB values) a scrub canvas uses: `filter: url(#uncut-video-tone)`. */
export function ensureToneFilter() {
  if (typeof document === "undefined" || document.getElementById(VIDEO_TONE_FILTER)) return;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  const filter = document.createElementNS(ns, "filter");
  filter.id = VIDEO_TONE_FILTER;
  filter.setAttribute("color-interpolation-filters", "sRGB");
  const transfer = document.createElementNS(ns, "feComponentTransfer");
  for (const ch of ["feFuncR", "feFuncG", "feFuncB"]) {
    const fn = document.createElementNS(ns, ch);
    fn.setAttribute("type", "table");
    fn.setAttribute("tableValues", VIDEO_TONE.join(" "));
    transfer.append(fn);
  }
  filter.append(transfer);
  svg.append(filter);
  document.body.append(svg);
}
