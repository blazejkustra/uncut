// The text census of a drawn graphic frame (render_frames' and review_submit's legibility note):
// every word the DOM shows, how tall its letters stand on the frame, the small ones listed. The
// films' agent-step lines came out 2 to 2.5 % tall (a piece typed under its default, a thread's
// step rows smaller than its message) and nothing measured them before the critic, which judged
// them by eye. Canvas-drawn text isn't in the DOM and isn't measured.

/** Words a viewer must read stand at least this share of the frame's height (the motion films' readability floor). */
export const SMALL_TEXT = 0.03;
/** A letter's height (cap and ascender height) as a share of its font size, about DM Sans' and SF Pro's. */
export const LETTER_SHARE = 0.72;

/** One text run of a census: its words (cut at 60 characters) and its letters' height, % of the frame's height. */
export interface CensusRun {
  readonly text: string;
  readonly share: number;
}
/**
 * A frame's census: the runs under the floor (the biggest first, at most 40), how many runs were
 * measured, and `unseen`: canvases, images and videos on screen (each over 1 % of the frame) whose
 * words, if any, the census can't read, so "no small text" can't be claimed for them.
 */
export interface Census {
  readonly small: ReadonlyArray<CensusRun>;
  readonly measured: number;
  readonly unseen?: number;
}

/**
 * The census as a function's source, called in the graphic's window after render(t) as
 * `(${GRAPHIC_CENSUS})(width, height, floor)`. A run counts when it is on screen (half of it inside
 * the frame), not hidden, not faded under 35 % and not under a blur over 1 px (the stage blurred
 * behind a hero is texture, not words to read). Its size is its font in frame px (every transform
 * on the way, the camera's included) times LETTER_SHARE, as uncutUI.frameText measures.
 */
export const GRAPHIC_CENSUS = `function (W, H, floor) {
  var LETTER = ${LETTER_SHARE};
  var state = new Map();
  function look(el) {
    if (state.has(el)) return state.get(el);
    var cs = getComputedStyle(el);
    var up = el.parentElement ? look(el.parentElement) : { alpha: 1, ok: true };
    var alpha = up.alpha * (parseFloat(cs.opacity) || 0);
    var m = /blur\\(([\\d.]+)px\\)/.exec(cs.filter || "");
    var ok = up.ok && cs.display !== "none" && alpha >= 0.35 && !(m && parseFloat(m[1]) > 1);
    var s = { alpha: alpha, ok: ok };
    state.set(el, s);
    return s;
  }
  function scaleOf(el) {
    // SVG text: its viewBox scales it too, which offsetWidth doesn't see.
    if (el instanceof SVGElement && el.getScreenCTM) { var c = el.getScreenCTM(); if (c) return Math.hypot(c.a, c.b); }
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.offsetWidth > 0) { var b = e.getBoundingClientRect(); if (b.width > 0) return b.width / e.offsetWidth; }
    }
    return 1;
  }
  var runs = new Map();
  var measured = 0;
  var walk = document.createTreeWalker(document.body || document.documentElement, 4);
  for (var n = walk.nextNode(); n; n = walk.nextNode()) {
    var text = (n.nodeValue || "").replace(/\\s+/g, " ").trim();
    var p = n.parentElement;
    if (!p || text.length < 2 || !/[\\p{L}\\p{N}]/u.test(text)) continue;
    var tag = p.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "TITLE" || tag === "NOSCRIPT") continue;
    var st = look(p);
    if (!st.ok) continue;
    var cs = getComputedStyle(p);
    if (cs.visibility === "hidden") continue;
    var range = document.createRange();
    range.selectNodeContents(n);
    var rects = range.getClientRects();
    var area = 0, inside = 0;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      var a = r.width * r.height;
      if (!a) continue;
      area += a;
      var w = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0));
      var h = Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0));
      inside += w * h;
    }
    if (!area || inside < area / 2) continue;
    var share = ((parseFloat(cs.fontSize) || 0) * scaleOf(p) * LETTER) / H;
    if (!(share > 0)) continue;
    measured++;
    if (share >= floor) continue;
    var key = text.slice(0, 60);
    var was = runs.get(key);
    if (was === undefined || share < was) runs.set(key, share);
  }
  var unseen = 0;
  var pics = document.querySelectorAll("canvas, img, video, image, object, embed, iframe");
  for (var k = 0; k < pics.length; k++) {
    var q = pics[k];
    var b = q.getBoundingClientRect();
    var vis = Math.max(0, Math.min(b.right, W) - Math.max(b.left, 0)) * Math.max(0, Math.min(b.bottom, H) - Math.max(b.top, 0));
    if (vis < W * H * 0.01) continue;
    var ps = look(q);
    if (ps.ok && getComputedStyle(q).visibility !== "hidden") unseen++;
  }
  var small = [];
  runs.forEach(function (share, text) { small.push({ text: text, share: Math.round(share * 1000) / 10 }); });
  small.sort(function (a, b) { return b.share - a.share; });
  return { small: small.slice(0, 40), measured: measured, unseen: unseen };
}`;

/** A census back from the rasteriser, checked (it crossed a process boundary). */
export function censusOf(v: unknown): Census | undefined {
  const c = v as { small?: unknown; measured?: unknown; unseen?: unknown } | null;
  if (!c || typeof c !== "object" || !Array.isArray(c.small) || typeof c.measured !== "number") return undefined;
  const small = c.small
    .filter((x): x is CensusRun => !!x && typeof (x as CensusRun).text === "string" && typeof (x as CensusRun).share === "number" && Number.isFinite((x as CensusRun).share))
    .slice(0, 40)
    .map((x) => ({ text: x.text.slice(0, 60), share: x.share }));
  return { small, measured: c.measured, ...(typeof c.unseen === "number" && c.unseen > 0 ? { unseen: c.unseen } : {}) };
}

/** Runs as a short list: the biggest first (the moment's lines before the chrome), at most `max`, then how many more. */
export function censusList(small: ReadonlyArray<CensusRun>, max = 5): string {
  const shown = small.slice(0, max).map((x) => `"${x.text.length > 40 ? `${x.text.slice(0, 39)}…` : x.text}" ${x.share} %`);
  return `${shown.join(", ")}${small.length > max ? ` and ${small.length - max} more${small.length >= 40 ? " (at least)" : ""}` : ""}`;
}
