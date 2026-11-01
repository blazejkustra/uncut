// The benchmark's seeded cases: one 6 s title film drawn by a graphic, clean or with one planted
// defect. Pure data plus the film's HTML.

export interface Seed {
  readonly id: string;
  readonly defect?: string;
  /** Where the defect shows, in seconds. */
  readonly from?: number;
  readonly to?: number;
  /** A finding near the defect catches it by its kind (blocker kinds only, a category proves nothing) or its words. */
  readonly kinds?: ReadonlyArray<string>;
  readonly words?: RegExp;
  /** What the film's script changes. */
  readonly film?: Readonly<Record<string, unknown>>;
}

export const SEEDS: ReadonlyArray<Seed> = [
  { id: "clean-a" },
  { id: "clean-b", film: { navy: "#10243f", amber: "#ffb340" } },
  {
    id: "placeholder",
    defect: "the timeline panel the storyboard plans is an empty frame",
    from: 2,
    to: 4,
    kinds: ["placeholder", "missing-asset"],
    words: /empty|placeholder|blank panel/i,
    film: { emptyPanel: true },
  },
  {
    id: "overflow",
    defect: "the headline runs off the right edge of the frame",
    from: 2,
    to: 4,
    kinds: ["overflow"],
    words: /cut off|clipped|edge|overflow/i,
    film: { title2: "Cuts itself on every single beat automatically", title2Size: 170, title2X: 300 },
  },
  {
    id: "illegible",
    defect: "the headline is tiny and low in contrast",
    from: 2,
    to: 4,
    kinds: ["illegible"],
    words: /tiny|illegible|unreadable|too small|low contrast/i,
    film: { title2Size: 18, title2Color: "#31475f" },
  },
  {
    id: "blank",
    defect: "one second of black in the middle of the film",
    from: 2.5,
    to: 3.5,
    kinds: ["blank"],
    words: /black|blank|empty frame/i,
    film: { blackFrom: 2.5, blackTo: 3.5 },
  },
  {
    id: "invented",
    defect: "a customer count the brief forbids",
    from: 4,
    to: 6,
    kinds: ["invented"],
    words: /invent|4 million|customer|not in the brief|unsupported/i,
    film: { title3Sub: "Trusted by 4 million teams" },
  },
  {
    id: "wrong-words",
    defect: "the headline's words differ from the approved storyboard",
    from: 2,
    to: 4,
    kinds: [],
    words: /cuts yourself|wrong word|typo|misspell/i,
    film: { title2: "Cuts yourself" },
  },
  {
    id: "off-centre",
    defect: "a headline meant to be centred sits well left of centre",
    from: 0,
    to: 2,
    kinds: ["off-centre"],
    words: /off[- ]cent|not centred|left of/i,
    film: { title1Shift: -130 },
  },
];

const SCRIPT = {
  navy: "#0b1d3a",
  amber: "#f5a623",
  title1: "Edit video by asking",
  title1Shift: 0,
  title2: "Cuts itself",
  title2Size: 120,
  title2X: 960,
  title2Color: "#ffffff",
  title3: "Try Uncut free",
  title3Sub: "uncut.dev",
  emptyPanel: false,
  blackFrom: -1,
  blackTo: -1,
};

const DRAW = String.raw`
const c = document.getElementById("c");
const out = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
function text(g, words, x, y, size, color, weight) {
  g.font = weight + " " + size + "px 'DM Sans'";
  g.fillStyle = color;
  g.fillText(words, x, y);
}
function drift(g, t, from) {
  const k = 1 + 0.03 * (t - from);
  g.translate(960, 540);
  g.scale(k, k);
  g.translate(-960, -540);
}
function panel(g, t) {
  const rise = 500 * (1 - out((t - 2) / 0.6));
  g.save();
  g.translate(0, rise);
  g.fillStyle = "#132b52";
  g.fillRect(360, 500, 1200, 400);
  g.strokeStyle = "#ffffff55";
  g.lineWidth = 3;
  g.strokeRect(360, 500, 1200, 400);
  if (!S.emptyPanel) {
    const clips = [[400, 540, 420, S.amber], [840, 540, 300, "#3fb6a8"], [400, 650, 610, "#7c8cf5"], [1030, 650, 490, S.amber], [400, 760, 1120, "#3fb6a8"]];
    clips.forEach(([x, y, w, fill], i) => {
      g.fillStyle = fill;
      g.fillRect(x, y, w * out((t - 2.3 - i * 0.2) / 0.4), 90);
    });
    g.fillStyle = "#ffffff";
    g.fillRect(400 + ((t - 2) / 2) * 1120, 520, 6, 340);
  }
  g.restore();
}
function words(g, line, y, t, shift) {
  const parts = line.split(" ");
  g.font = "700 150px 'DM Sans'";
  const widths = parts.map((p) => g.measureText(p + " ").width);
  let x = 960 + shift - widths.reduce((a, b) => a + b, 0) / 2;
  parts.forEach((part, i) => {
    const p = out((t - i * 0.18) / 0.45);
    g.globalAlpha = p;
    g.textAlign = "left";
    text(g, part, x, y + 70 * (1 - p), 150, "#ffffff", 700);
    x += widths[i];
  });
  g.globalAlpha = 1;
  g.textAlign = "center";
}
window.render = (t, info) => {
  c.width = info.width;
  c.height = info.height;
  const g = c.getContext("2d");
  g.setTransform(info.width / 1920, 0, 0, info.height / 1080, 0, 0);
  g.textAlign = "center";
  if (t >= S.blackFrom && t < S.blackTo) {
    g.fillStyle = "#000";
    g.fillRect(0, 0, 1920, 1080);
    return;
  }
  g.fillStyle = S.navy;
  g.fillRect(0, 0, 1920, 1080);
  if (t < 2) {
    drift(g, t, 0);
    words(g, S.title1, 580, t, S.title1Shift);
  } else if (t < 4) {
    if (S.title2X !== 960) g.textAlign = "left";
    text(g, S.title2, S.title2X, 380 + 90 * (1 - out((t - 2) / 0.45)), S.title2Size, S.title2Color, 700);
    g.textAlign = "center";
    panel(g, t);
  } else {
    g.fillStyle = S.amber;
    g.fillRect(0, 0, 1920 * out((t - 4) / 0.35), 1080);
    drift(g, t, 4);
    text(g, S.title3, 960, 520 + 80 * (1 - out((t - 4.1) / 0.45)), 150, S.navy, 700);
    g.globalAlpha = out((t - 4.5) / 0.4);
    text(g, S.title3Sub, 960, 680, 96, S.navy, 500);
    g.globalAlpha = 1;
  }
};`;

/** The film as a graphic: a canvas drawn from its script, a pure function of t. */
export const filmHtml = (seed: Seed) =>
  `<canvas id="c"></canvas><style>html,body{margin:0}canvas{display:block;width:100vw;height:100vh}</style><script>const S=${JSON.stringify({ ...SCRIPT, ...seed.film })};${DRAW}</script>`;

/** What the user asked for: silent, so the critic judges the picture. */
export const REQUEST = "A 6 second silent launch title film for Uncut: no music, no sound effects.";

export const BRIEF = {
  film: "A 6 second launch title film for Uncut, a video editor you drive by asking",
  audience: "Developers on X",
  duration: "6 s",
  formats: ["16:9"],
  assets: ["The timeline panel, drawn as a graphic"],
  visual: "Navy and amber, DM Sans, type led, quick eased rises",
  hardLines: ["No statistics, customer counts or claims beyond the storyboard"],
  deliverables: ["16:9 mp4"],
};

export const BEATS = [
  { start: 0, end: 2, title: "Hook", entry: "Words rise in one by one", exit: "'Edit video by asking' settled", purpose: "The promise", assets: [] },
  {
    start: 2,
    end: 4,
    title: "Proof",
    entry: "'Cuts itself' rises over the timeline panel",
    exit: "The playhead crosses the filled tracks",
    purpose: "Show the timeline filled with clips",
    assets: ["timeline panel"],
  },
  { start: 4, end: 6, title: "End card", entry: "Amber card", exit: "'Try Uncut free' and uncut.dev held", purpose: "Call to action", assets: [] },
];
