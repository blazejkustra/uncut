// The site's two small browser behaviours, run after hydration by their client components
// (components/StarButton.tsx, components/HeroFx.tsx):
//   - the nav's GitHub star count (shown from 10 stars), fetched once per session and cached in
//     sessionStorage;
//   - the hero background, a WebGPU shader (heroGpu.ts, a separate chunk loaded only where
//     navigator.gpu exists). Without WebGPU, or if anything fails, the static CSS gradient under
//     the canvas stays as it is. The pages work without any script too.

export const REPO = "blazejkustra/uncut";
const STARS_KEY = "uncut-stars";
/** Below this the count reads as a sad number, so the button says "Star" instead. */
export const MIN_STARS = 10;

/** 1234 → "1.2k", 999 → "999", 12500 → "12.5k". */
export function formatStars(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
}

function readCache(): number | null | undefined {
  try {
    const v = sessionStorage.getItem(STARS_KEY);
    if (v === null) return undefined;
    return v === "none" ? null : Number(v);
  } catch {
    return undefined;
  }
}

function writeCache(v: number | null) {
  try {
    sessionStorage.setItem(STARS_KEY, v === null ? "none" : String(v));
  } catch {
    // Storage blocked: fetch again next time.
  }
}

/** The repo's star count from the GitHub API (cached for the session), or null when there's no number
 *  (private, rate-limited, offline) or too few to be worth showing: the button then keeps "Star". */
export async function fetchStars(): Promise<number | null> {
  let n = readCache();
  if (n === undefined) {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}`, { headers: { Accept: "application/vnd.github+json" } });
      const body = res.ok ? ((await res.json()) as { stargazers_count?: unknown }) : null;
      n = typeof body?.stargazers_count === "number" ? body.stargazers_count : null;
    } catch {
      n = null;
    }
    writeCache(n);
  }
  // From MIN_STARS on, the count takes the label's place in the same fixed width.
  if (typeof n !== "number" || !Number.isFinite(n) || n < MIN_STARS) return null;
  return n;
}

/** Starts the hero's WebGPU background on `canvas`; `hero` gets .fx-live after the first frame. */
export async function background(hero: HTMLElement, canvas: HTMLCanvasElement): Promise<void> {
  if (!("gpu" in navigator) || !navigator.gpu) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  try {
    const { startHeroGpu } = await import("./heroGpu.ts");
    await startHeroGpu(canvas, hero, reduced, () => hero.classList.add("fx-live"));
  } catch (error) {
    console.warn("hero background: " + String((error as Error)?.message ?? error));
    // WebGPU missing pieces, a blocked adapter, a shader the driver rejects: keep the gradient.
  }
}
