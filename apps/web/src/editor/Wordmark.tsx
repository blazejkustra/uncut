// D244 (#87): the title bar's "Uncut": the app icon's cut U and the name, with a light that
// sweeps through the letters along the icon's cut, once when a project opens and over and over
// while the agent works on it. CSS only (one background-position animation on a few letters);
// still under prefers-reduced-motion; the whole wordmark stays part of the window's drag region.
import { useId } from "react";

import { useApp } from "../state/store.ts";
import { anyAgentRunning } from "../state/agents.ts";
import "./wordmark.css";

/**
 * The Uncut mark (D243): the app icon's U (apps/desktop/build/icon.png) with its diagonal cut,
 * drawn in currentColor. `tile` puts it on the icon's dark rounded square.
 */
export function UncutMark({ className, tile = false }: { className?: string; tile?: boolean }) {
  const mask = useId();
  return (
    <svg className={className} viewBox={tile ? "0 0 1024 1024" : "280 230 464 562"} aria-hidden="true" focusable="false">
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
          <rect width="1024" height="1024" fill="#fff" />
          {/* The cut through the left stem, as in the icon. */}
          <path d="M270 506 L466 403" stroke="#000" strokeWidth="26" />
        </mask>
        {tile && (
          <linearGradient id={`${mask}-tile`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#202020" />
            <stop offset="1" stopColor="#0f0f0f" />
          </linearGradient>
        )}
      </defs>
      {tile && <rect x="100" y="100" width="824" height="824" rx="184" fill={`url(#${mask}-tile)`} />}
      <path
        d="M368 318 V560 A144 144 0 0 0 656 560 V318"
        fill="none"
        stroke={tile ? "#f1f0ed" : "currentColor"}
        strokeWidth="128"
        strokeLinecap="round"
        mask={`url(#${mask})`}
      />
    </svg>
  );
}

/** The title bar's brand and the project's name. */
export function Wordmark({ dir, name }: { dir: string; name: string }) {
  const { agent } = useApp();
  const busy = agent !== null && agent.dir === dir && anyAgentRunning(agent);
  return (
    <div className="wordmark" data-testid="wordmark" data-busy={busy}>
      <span className="brand wordmark-name">
        <UncutMark className="wordmark-mark" />
        {/* key: a project opening plays the sweep once. */}
        <span key={dir} className="wordmark-text" data-testid="wordmark-text">
          Uncut
        </span>
      </span>
      <span className="wordmark-slash" aria-hidden="true" />
      <div className="project-title" data-testid="project-title" title={dir}>
        {name}
      </div>
    </div>
  );
}
