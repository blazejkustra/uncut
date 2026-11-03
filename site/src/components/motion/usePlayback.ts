import { useEffect, useRef, useState, type RefObject } from "react";

const START_RATIO = 0.35;
const FADE_MS = 360;

function pausableTimer(onDue: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueAt = 0;
  let left = 0;
  let running = false;
  const arm = () => {
    dueAt = performance.now() + left;
    timer = setTimeout(onDue, left);
  };
  return {
    wait(ms: number) {
      clearTimeout(timer);
      left = ms;
      if (running) arm();
    },
    pause() {
      if (!running) return;
      running = false;
      clearTimeout(timer);
      left = Math.max(0, dueAt - performance.now());
    },
    resume() {
      if (running) return;
      running = true;
      arm();
    },
  };
}

function belowFold(el: Element): boolean {
  return el.getBoundingClientRect().top > innerHeight;
}

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Steps through `waits` (ms spent on each step, the last one being the hold on the finished state) and
 * loops with a fade while the element is on screen. The finished step is what the server renders, so
 * it is also what shows without script and with reduced motion. `waits` must be a stable array.
 */
export function usePlayback(waits: ReadonlyArray<number>): { root: RefObject<HTMLDivElement | null>; step: number; finished: boolean } {
  const root = useRef<HTMLDivElement>(null);
  const finalStep = waits.length - 1;
  const [step, setStep] = useState(finalStep);

  useEffect(() => {
    const el = root.current;
    if (!el || reducedMotion()) return;
    let current = belowFold(el) ? 0 : finalStep;
    const show = (next: number) => {
      current = next;
      setStep(next);
      timer.wait(waits[next]!);
    };
    const advance = () => {
      if (current < finalStep) return show(current + 1);
      if (el.dataset.fading === undefined) {
        el.dataset.fading = "";
        return timer.wait(FADE_MS);
      }
      delete el.dataset.fading;
      show(0);
    };
    const timer = pausableTimer(advance);
    el.dataset.paused = "";
    show(current);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (!entry.isIntersecting) {
          timer.pause();
          el.dataset.paused = "";
        } else if (entry.intersectionRatio >= START_RATIO) {
          timer.resume();
          delete el.dataset.paused;
        }
      },
      { threshold: [0, START_RATIO] },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      timer.pause();
    };
  }, [waits, finalStep]);

  return { root, step, finished: step === finalStep };
}

/** Marks the element data-playing while it is on screen, for a CSS animation that pauses without it. */
export function usePlayingWhileVisible(): RefObject<HTMLDivElement | null> {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el || reducedMotion()) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) el.dataset.playing = "";
      else delete el.dataset.playing;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return root;
}
