import { useEffect, type RefObject } from "react";

import { getPlayback, usePlayback } from "../preview/playback.ts";

/**
 * The playhead: its own component, so playback re-renders only this. It lives in the ruler (sticky
 * at the top of the timeline, D115), so its handle stays in view when the tracks scroll; the line
 * reaches down over the visible tracks (--tl-view-h). A press on the handle is the ruler's scrub.
 */
export function Playhead({ ppf, bodyRef, headWidth }: { ppf: number; bodyRef: RefObject<HTMLDivElement | null>; headWidth: number }) {
  const frame = usePlayback((s) => s.frame);
  const x = frame * ppf;
  // While playing, keep the playhead in view.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !getPlayback().playing) return;
    const view = body.clientWidth - headWidth;
    if (x < body.scrollLeft || x > body.scrollLeft + view - 24) body.scrollLeft = Math.max(0, x - 48);
  }, [x, bodyRef, headWidth]);
  return (
    <div className="playhead" data-testid="playhead" data-frame={Math.floor(frame)} style={{ left: x }}>
      <div className="playhead-handle" />
    </div>
  );
}
