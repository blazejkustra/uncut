// Synthetic landscape clips for the README hero (test/app/readme-hero.test.ts): no footage, no
// third-party content. Each clip is drawn in Node, pixel by pixel at 1920×1080 (layered ridges
// with anti-aliased edges, a sun or moon, stars, water), with slow parallax, and piped to ffmpeg.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

interface Scene {
  /** Sky gradient stops from the top (0) to the horizon line (1). */
  sky: Array<[number, string]>;
  /** The horizon, as a fraction of the height. */
  horizon: number;
  sun?: { x: number; y: number; r: number; color: string; glow: string; glowSize: number };
  stars?: number;
  /** Ridges from the back to the front: base height (fraction of H), amplitude, colour, drift px/s. */
  ridges: Array<{ base: number; amp: number; color: string; drift: number; seed: number; rough?: number; until?: number }>;
  /** A sea below the horizon instead of land (the sun's reflection is drawn on it). */
  sea?: { top: string; bottom: string };
  /** Slow zoom over the clip (1 = none). */
  zoom?: number;
}

/** A ridgeline: a sum of sines at unrelated frequencies, plus a jagged high-frequency term. */
function ridgeY(x: number, seed: number, rough: number) {
  const s = seed * 1.37;
  return (
    Math.sin(x * 0.0021 + s) * 0.55 +
    Math.sin(x * 0.0047 + s * 2.1) * 0.28 +
    Math.sin(x * 0.0113 + s * 3.7) * 0.12 * rough +
    Math.abs(Math.sin(x * 0.031 + s * 5.3)) * 0.05 * rough +
    // Peaks: 1 - |sin| has sharp crests, so rough ridges read as mountains, smooth ones as dunes.
    (Math.pow(1 - Math.abs(Math.sin(x * 0.0036 + s * 1.9)), 2.2) - 0.3) * 0.7 * Math.max(0, rough - 0.5)
  );
}

function renderFrame(scene: Scene, W: number, H: number, t: number, out: Buffer) {
  const stops = scene.sky.map(([p, c]) => [p, hex(c)] as [number, Rgb]);
  const skyAt = (p: number): Rgb => {
    if (p <= stops[0]![0]) return stops[0]![1];
    for (let i = 1; i < stops.length; i++) if (p <= stops[i]![0]) return mix(stops[i - 1]![1], stops[i]![1], (p - stops[i - 1]![0]) / (stops[i]![0] - stops[i - 1]![0]));
    return stops.at(-1)![1];
  };
  const hy = scene.horizon * H;
  const z = 1 + ((scene.zoom ?? 1) - 1) * (t / 4);
  const sun = scene.sun && { ...scene.sun, cx: scene.sun.x * W, cy: scene.sun.y * H, rr: scene.sun.r * H, col: hex(scene.sun.color), glw: hex(scene.sun.glow) };
  const ridges = scene.ridges.map((r) => ({ ...r, col: hex(r.color), off: r.drift * t, rough: r.rough ?? 1 }));
  // Per column ridge heights for this frame (zoom about the centre).
  const heights = ridges.map((r) => {
    const a = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const wx = (x - W / 2) / z + W / 2 + r.off;
      a[x] = (r.base - r.amp * ridgeY(wx, r.seed, r.rough)) * H;
    }
    return a;
  });
  let seed = 1234567;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  for (let y = 0; y < H; y++) {
    const wy = (y - H / 2) / z + H / 2;
    for (let x = 0; x < W; x++) {
      const wx = (x - W / 2) / z + W / 2;
      let c: Rgb;
      if (scene.sea && wy > hy) {
        const p = (wy - hy) / (H - hy);
        c = mix(hex(scene.sea.top), hex(scene.sea.bottom), Math.pow(p, 0.7));
        if (sun) {
          // The sun's path on the water: broken horizontal streaks that widen towards the viewer.
          const dx = Math.abs(wx - sun.cx) / (sun.rr * (0.8 + p * 2.2));
          const band = Math.sin(wy * 0.9 + Math.sin(wx * 0.02 + t * 2) * 2 + t * 3);
          const k = clamp01(1 - dx) * (band > 0.2 ? 1 : 0.15) * (1 - p * 0.6);
          c = mix(c, sun.col, k * 0.85);
        }
      } else {
        c = skyAt(clamp01(wy / hy));
        if (scene.stars && wy < hy * 0.8) {
          // Deterministic stars from a hash of the cell.
          const cx = Math.floor(wx / 6), cy = Math.floor(wy / 6);
          const hsh = Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453;
          const f = hsh - Math.floor(hsh);
          if (f > 1 - scene.stars && wx - cx * 6 < 2 && wy - cy * 6 < 2) {
            const tw = 0.6 + 0.4 * Math.sin(t * 3 + f * 50);
            c = mix(c, [255, 255, 255], tw * (1 - wy / (hy * 0.8)) * ((f * 1e4) % 1));
          }
        }
        if (sun) {
          const d = Math.hypot(wx - sun.cx, wy - sun.cy);
          const glow = Math.exp(-Math.pow(d / (sun.rr * sun.glowSize), 2));
          c = mix(c, sun.glw, glow * 0.75);
          c = mix(c, sun.col, clamp01(sun.rr - d + 0.5));
        }
      }
      // Ridges, back to front, with vertical anti-aliasing on the edge (wider where the edge is steep).
      for (let i = 0; i < ridges.length; i++) {
        const h = heights[i]!;
        const top = h[x]!;
        const slope = Math.abs((h[Math.min(W - 1, x + 1)]! - h[Math.max(0, x - 1)]!) / 2);
        const until = ridges[i]!.until;
        if (until !== undefined && wy > until * H) continue;
        const cov = clamp01((y - top + 0.5) / Math.max(1, slope));
        if (cov > 0) {
          // A touch of light along the crest and darker towards the base.
          const depth = clamp01((y - top) / (H * 0.5));
          const shade = mix(ridges[i]!.col, [0, 0, 0], depth * 0.25);
          c = mix(c, shade, cov);
        }
      }
      // Gentle vignette, and dither so the gradients don't band in h264.
      const vx = x / W - 0.5, vy = y / H - 0.5;
      const v = 1 - 0.32 * Math.pow(vx * vx + vy * vy, 1.1) * 2.2;
      const n = noise() * 1.4;
      const o = (y * W + x) * 3;
      out[o] = Math.max(0, Math.min(255, c[0] * v + n));
      out[o + 1] = Math.max(0, Math.min(255, c[1] * v + n));
      out[o + 2] = Math.max(0, Math.min(255, c[2] * v + n));
    }
  }
}

export const HERO_SCENES: Record<string, Scene> = {
  "Summit at sunset": {
    horizon: 0.74,
    sky: [[0, "#1d1340"], [0.38, "#5a2a7a"], [0.66, "#d9487a"], [0.86, "#ff8a5c"], [1, "#ffc477"]],
    sun: { x: 0.7, y: 0.66, r: 0.075, color: "#fff1c9", glow: "#ffb46b", glowSize: 4 },
    ridges: [
      { base: 0.69, amp: 0.1, color: "#e2708f", drift: -4, seed: 1, rough: 1.5 },
      { base: 0.76, amp: 0.11, color: "#a8487f", drift: -9, seed: 2, rough: 1.7 },
      { base: 0.84, amp: 0.1, color: "#6b2c6e", drift: -16, seed: 3, rough: 1.4 },
      { base: 0.91, amp: 0.09, color: "#3a1a4c", drift: -26, seed: 4, rough: 1.1 },
      { base: 0.99, amp: 0.08, color: "#1a0d2a", drift: -40, seed: 5, rough: 1.3 },
    ],
    zoom: 1.03,
  },
  "Coast at dawn": {
    horizon: 0.6,
    sky: [[0, "#24345f"], [0.5, "#6f6fa6"], [0.82, "#f2a0a0"], [1, "#ffd3a6"]],
    sun: { x: 0.36, y: 0.6, r: 0.06, color: "#fff4dc", glow: "#ffc9a1", glowSize: 3.4 },
    sea: { top: "#7b6d9e", bottom: "#1d2447" },
    ridges: [
      { base: 0.6, amp: 0.05, color: "#57517f", drift: -3, seed: 8, rough: 1.2, until: 0.6 },
      { base: 0.6, amp: 0.025, color: "#6c628f", drift: -6, seed: 9, rough: 0.4, until: 0.6 },
    ],
    zoom: 1.04,
  },
  "Night peaks": {
    horizon: 0.78,
    sky: [[0, "#050816"], [0.6, "#121a3d"], [1, "#2b3a74"]],
    sun: { x: 0.24, y: 0.24, r: 0.045, color: "#f2f5ff", glow: "#8ea4ff", glowSize: 3 },
    stars: 0.06,
    ridges: [
      { base: 0.68, amp: 0.13, color: "#2a3566", drift: -5, seed: 11, rough: 1.6 },
      { base: 0.78, amp: 0.12, color: "#1b2350", drift: -11, seed: 12, rough: 1.4 },
      { base: 0.88, amp: 0.1, color: "#10163a", drift: -20, seed: 13 },
      { base: 0.97, amp: 0.08, color: "#070b22", drift: -34, seed: 14 },
    ],
    zoom: 1.03,
  },
  "Desert dunes": {
    horizon: 0.62,
    sky: [[0, "#3b6aa8"], [0.6, "#9cc0e0"], [1, "#f6dcb4"]],
    sun: { x: 0.82, y: 0.2, r: 0.04, color: "#fffaf0", glow: "#fff0d0", glowSize: 3 },
    ridges: [
      { base: 0.62, amp: 0.03, color: "#e5b07c", drift: -5, seed: 21, rough: 0.2 },
      { base: 0.72, amp: 0.06, color: "#d8935a", drift: -12, seed: 22, rough: 0.2 },
      { base: 0.84, amp: 0.08, color: "#c0703f", drift: -22, seed: 23, rough: 0.2 },
      { base: 0.97, amp: 0.09, color: "#8f4a2a", drift: -36, seed: 24, rough: 0.2 },
    ],
    zoom: 1.03,
  },
  "Last light": {
    horizon: 0.7,
    sky: [[0, "#0f1d3a"], [0.5, "#2d4a7a"], [0.8, "#f08a4b"], [1, "#ffcf7a"]],
    sun: { x: 0.5, y: 0.71, r: 0.09, color: "#ffe9b0", glow: "#ff9a4a", glowSize: 3.6 },
    ridges: [
      { base: 0.72, amp: 0.05, color: "#5a4a6a", drift: -6, seed: 31, rough: 0.8 },
      { base: 0.82, amp: 0.08, color: "#34304f", drift: -14, seed: 32 },
      { base: 0.94, amp: 0.1, color: "#16152a", drift: -28, seed: 33, rough: 1.3 },
    ],
    zoom: 1.03,
  },
};

/** Writes "<name>.mp4" (1920×1080, 30 fps, `seconds` long) for each scene into `dir`. */
export async function makeHeroClips(dir: string, seconds = 5, names = Object.keys(HERO_SCENES)) {
  mkdirSync(dir, { recursive: true });
  const W = 1920, H = 1080, fps = 30;
  for (const name of names) {
    const scene = HERO_SCENES[name]!;
    const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(fps), "-i", "-", "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-movflags", "+faststart", join(dir, `${name}.mp4`)], { stdio: ["pipe", "inherit", "inherit"] });
    const done = new Promise<void>((res, rej) => ff.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code} for ${name}`)))));
    for (let f = 0; f < seconds * fps; f++) {
      const buf = Buffer.alloc(W * H * 3);
      renderFrame(scene, W, H, f / fps, buf);
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    }
    ff.stdin.end();
    await done;
  }
}

// `node test/helpers/hero-clips.ts <dir> [seconds] [names,...]` to look at the clips on their own.
if (import.meta.main) {
  await makeHeroClips(process.argv[2] ?? "test-output/hero-clips", Number(process.argv[3] ?? 5), process.argv[4]?.split(","));
}

/** "Launch theme.m4a": 20 s of synthesised music (a pad on A minor, a soft kick on every beat at 120 bpm, a hat on the off-beats). */
export function makeHeroMusic(dir: string, seconds = 20) {
  mkdirSync(dir, { recursive: true });
  const pad = "0.12*(sin(2*PI*220*t)+0.7*sin(2*PI*261.63*t)+0.6*sin(2*PI*329.63*t))*(0.6+0.4*sin(2*PI*0.25*t))";
  const kick = "0.55*exp(-mod(t,0.5)*14)*sin(2*PI*(50+90*exp(-mod(t,0.5)*30))*t)";
  const hat = "0.08*exp(-mod(t+0.25,0.5)*60)*(random(0)*2-1)";
  const fade = `min(1,t/1.5)*min(1,(${seconds}-t)/2)`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='(${pad}+${kick}+${hat})*${fade}':s=48000:d=${seconds}`, "-c:a", "aac", "-b:a", "160k", join(dir, "Launch theme.m4a")]);
}
