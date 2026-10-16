"use client";
// The hero's background layer: the static CSS gradient (globals.css, .hero-fx::before) under a canvas
// that hero.ts draws with WebGPU where it can, after hydration. Absolutely placed, so nothing shifts
// whether or not it runs; without WebGPU, with reduced motion or on any failure the gradient stays.
import { useEffect, useRef } from "react";
import { background } from "../hero.ts";

/** Canvases already running, so a second effect run (React's strict mode in `next dev`) can't start
 *  a second loop on the same one. */
const started = new WeakSet<HTMLCanvasElement>();

export default function HeroFx() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    const hero = c?.closest<HTMLElement>(".hero");
    if (!c || !hero || started.has(c)) return;
    started.add(c);
    void background(hero, c);
  }, []);
  return (
    <div className="hero-fx" aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}
