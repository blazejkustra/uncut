"use client";
import type { ReactNode } from "react";
import { usePlayingWhileVisible } from "./usePlayback.ts";

export default function TimelineShot({ children }: { children: ReactNode }) {
  const root = usePlayingWhileVisible();
  return (
    <div ref={root} className="tl-stage" data-reveal="">
      <div className="tl-inner">
        {children}
        <span className="tl-head" aria-hidden="true" />
      </div>
    </div>
  );
}
