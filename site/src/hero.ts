// The landing page's only script (built by `pnpm site:build` into site/assets/hero.js):
//   - the nav's GitHub star count (shown from 10 stars), fetched once per session and cached in
//     sessionStorage;
//   - the hero background, a WebGPU shader (heroGpu.ts, a separate chunk loaded only where
//     navigator.gpu exists). Without WebGPU, or if anything fails, the static CSS gradient under
//     the canvas stays as it is. Everything works without this script too.

const REPO = "blazejkustra/uncut";
const STARS_KEY = "uncut-stars";
/** Below this the count reads as a sad number, so the button says "Star" instead. */
const MIN_STARS = 10;

/** 1234 → "1.2k", 999 → "999", 12500 → "12.5k". */
function formatStars(n: number): string {
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

async function stars() {
  const slot = document.querySelector<HTMLElement>("[data-stars]");
  if (!slot) return;
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
  // No number (private, rate-limited, offline) or too few to be worth showing: the button keeps
  // its "Star" label. From MIN_STARS on, the count takes the label's place in the same fixed width.
  if (typeof n !== "number" || !Number.isFinite(n) || n < MIN_STARS) return;
  const link = slot.closest("a");
  const num = slot.querySelector<HTMLElement>(".n");
  if (!link || !num) return;
  num.textContent = formatStars(n);
  slot.hidden = false;
  link.classList.add("has-stars");
  link.setAttribute("aria-label", `Star Uncut on GitHub, ${n.toLocaleString("en-US")} stars`);
}

async function background() {
  const hero = document.querySelector<HTMLElement>(".hero");
  const canvas = hero?.querySelector<HTMLCanvasElement>(".hero-fx canvas");
  if (!hero || !canvas || !("gpu" in navigator) || !navigator.gpu) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  try {
    const { startHeroGpu } = await import("./heroGpu.ts");
    await startHeroGpu(canvas, hero, reduced, () => hero.classList.add("fx-live"));
  } catch (error) {
    console.warn("hero background: " + String((error as Error)?.message ?? error));
    // WebGPU missing pieces, a blocked adapter, a shader the driver rejects: keep the gradient.
  }
}

void stars();
void background();
