"use client";
// Blocks marked data-reveal rise in once as they scroll into view (globals.css). Only blocks still
// below the fold at hydration are hidden first, so nothing on screen blinks; with reduced motion, or
// without script, everything simply stays visible.
import { useEffect } from "react";

const SHOWN_AT = 0.2;

function belowFold(el: Element): boolean {
  return el.getBoundingClientRect().top > innerHeight;
}

function revealEntered(entries: Array<IntersectionObserverEntry>, observer: IntersectionObserver) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    (entry.target as HTMLElement).dataset.reveal = "in";
    observer.unobserve(entry.target);
  }
}

export default function ScrollReveal() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver(revealEntered, { threshold: SHOWN_AT });
    for (const el of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
      if (el.dataset.reveal === "in" || !belowFold(el)) continue;
      el.dataset.reveal = "pending";
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);
  return null;
}
