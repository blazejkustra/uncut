// What a graphic's page shows over time (D316): render(t) called at sample times in the rasteriser,
// each element with an id read after it. Timing buried in a script (argent-100s' pop($("q-k"), t,
// 4.1, ...)) can't be parsed, but what the page does at each t can be measured.

/** One element as a scan saw it: `runs` are [first, last] sample indices (of the request's ts) it was on screen at. */
export interface ScannedElement {
  readonly key: string;
  readonly parent?: string;
  readonly tag: string;
  readonly name?: string;
  readonly at?: number;
  readonly out?: number;
  readonly text: string;
  readonly area: number;
  /** Nothing but text and inline markup inside: its text can be replaced without losing a piece of the page. */
  readonly plain?: boolean;
  readonly runs: ReadonlyArray<readonly [number, number]>;
}

/** Scan times over a graphic's `seconds`: at most `max`, at most SCAN_RATE a second. */
export const SCAN_RATE = 15;
export function scanTimes(seconds: number, max: number): Array<number> {
  const count = Math.max(1, Math.min(max, Math.ceil(seconds * SCAN_RATE)));
  return Array.from({ length: count }, (_, i) => (i * seconds) / count);
}

/** One scan from chunks of consecutive sample times: each chunk's runs are on its own indices; `offsets[i]`: chunk i's first sample. */
export function joinScans(chunks: ReadonlyArray<ReadonlyArray<ScannedElement>>, offsets: ReadonlyArray<number>): Array<ScannedElement> {
  const out = new Map<string, ScannedElement>();
  chunks.forEach((chunk, c) => {
    for (const e of chunk) {
      const runs = e.runs.map(([a, b]) => [a + offsets[c]!, b + offsets[c]!] as const);
      const had = out.get(e.key);
      if (!had) {
        out.set(e.key, { ...e, runs });
        continue;
      }
      const last = had.runs.at(-1);
      const joined =
        last && runs[0] && last[1] + 1 === runs[0][0] ? [...had.runs.slice(0, -1), [last[0], runs[0][1]] as const, ...runs.slice(1)] : [...had.runs, ...runs];
      out.set(e.key, { ...had, area: Math.max(had.area, e.area), text: e.text.length > had.text.length ? e.text : had.text, runs: joined });
    }
  });
  return [...out.values()];
}

/** The page function: (ts, info) gives Array<ScannedElement>, run after the document has loaded. */
export const GRAPHIC_SCAN = `async (ts, info) => {
  const INLINE = new Set(["span", "b", "i", "em", "strong", "u", "s", "small", "sub", "sup", "mark", "code", "br", "tspan"]);
  const plainText = (el) => [...el.querySelectorAll("*")].every((c) => !c.id && INLINE.has(c.tagName.toLowerCase()));
  const SKIP = new Set(["script", "style", "defs", "marker", "clippath", "lineargradient", "radialgradient", "stop", "filter", "mask", "symbol", "title"]);
  const inert = (el) => { for (let a = el; a; a = a.parentElement) if (SKIP.has(a.tagName.toLowerCase())) return true; return false; };
  const list = [...document.body.querySelectorAll("[id]")].filter((el) => el.id && !inert(el));
  const keys = new Set(list);
  const seen = new Map();
  const W = innerWidth, H = innerHeight;
  const opacityOf = (el, memo) => {
    if (!el || el === document.documentElement) return 1;
    let o = memo.get(el);
    if (o === undefined) { o = Number(getComputedStyle(el).opacity) * opacityOf(el.parentElement, memo); memo.set(el, o); }
    return o;
  };
  const onScreen = (el, memo) => {
    const s = getComputedStyle(el);
    if (s.visibility !== "visible" || s.display === "none" || opacityOf(el, memo) < 0.02) return 0;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) return 0;
    return r.width * r.height;
  };
  for (let i = 0; i < ts.length; i++) {
    await window.__uncutRender(ts[i], { ...info, frame: Math.round(ts[i] * info.fps) }, true);
    const memo = new Map();
    for (const el of list) {
      const area = onScreen(el, memo);
      if (!area) continue;
      let e = seen.get(el);
      if (!e) { e = { area: 0, text: "", runs: [] }; seen.set(el, e); }
      e.area = Math.max(e.area, area);
      const text = (el.innerText ?? el.textContent ?? "").trim();
      if (text.length > e.text.length) e.text = text;
      const last = e.runs.at(-1);
      if (last && last[1] === i - 1) last[1] = i;
      else e.runs.push([i, i]);
    }
  }
  const parentOf = (el) => { for (let a = el.parentElement; a; a = a.parentElement) if (keys.has(a)) return a.id; return undefined; };
  const number = (v) => (v === null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
  return list.flatMap((el) => {
    const e = seen.get(el);
    const at = number(el.getAttribute("data-at"));
    if (!e && at === undefined) return [];
    return [{
      key: el.id,
      parent: parentOf(el),
      tag: el.tagName.toLowerCase(),
      name: el.getAttribute("data-name") || undefined,
      at,
      out: number(el.getAttribute("data-out")),
      text: (e ? e.text : "").slice(0, 400),
      plain: plainText(el),
      area: Math.round(e ? e.area : 0),
      runs: e ? e.runs : [],
    }];
  });
}`;
