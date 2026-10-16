// The landing page's only script (built by `pnpm site:build` into site/assets/hero.js):
//   - the nav's GitHub star count, fetched once per session and cached in sessionStorage;
//   - the hero background, a WebGPU shader (heroGpu.ts, a separate chunk loaded only where
//     navigator.gpu exists). Without WebGPU, or if anything fails, the static CSS gradient under
//     the canvas stays as it is. Everything works without this script too.

const REPO = "blazejkustra/uncut";
const STARS_KEY = "uncut-stars";

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
  // No number (the repo is private, rate-limited, offline): the plain "GitHub" label stays.
  if (typeof n !== "number" || !Number.isFinite(n)) return;
  slot.textContent = formatStars(n);
  slot.closest("a")?.setAttribute("aria-label", `GitHub, ${n} stars`);
  slot.closest("a")?.classList.add("has-stars");
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
