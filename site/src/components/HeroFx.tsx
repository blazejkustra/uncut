"use client";
// The hero's background layer: the static CSS gradient (globals.css, .hero-fx::before) under a canvas
// that hero.ts draws with WebGPU where it can, after hydration. Absolutely placed, so nothing shifts
// whether or not it runs; without WebGPU, with reduced motion or on any failure the gradient stays.
import { useEffect, useRef } from "react";
import { background } from "../hero.ts";

export default function HeroFx() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    const hero = c?.closest<HTMLElement>(".hero");
    if (c && hero) void background(hero, c);
  }, []);
  return (
    <div className="hero-fx" aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}
