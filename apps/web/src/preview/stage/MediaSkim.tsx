// Issue #118: a media tile skimmed in the library shows in the main preview too (as in iMovie): one
// muted <video> of the file (its proxy when the preview uses proxies) over the frame, seeked to the
// skimmed time, letterboxed in black. Gone once the pointer leaves the tile; the project is drawn
// underneath all along, so the playhead's frame is back at once.
import { useEffect, useRef, useSyncExternalStore } from "react";

import { usePlayback } from "../playback.ts";
import { getState, mediaUrl, projectOf, proxyOf, proxyUrl, subscribeApp } from "../../state/store.ts";
import { useProxiesOn } from "../../settings/proxies.ts";

export function MediaSkim() {
  const hover = usePlayback((s) => s.hoverMedia);
  const media = useSyncExternalStore(subscribeApp, () => {
    const snapshot = getState().snapshot;
    return hover && snapshot ? projectOf(snapshot).media.find((m) => m.id === hover.media) : undefined;
  });
  const proxy = useSyncExternalStore(subscribeApp, () => (hover ? proxyOf(getState(), hover.media) : undefined));
  const proxiesOn = useProxiesOn();
  const ref = useRef<HTMLVideoElement>(null);
  const seconds = hover?.seconds;
  useEffect(() => {
    const v = ref.current;
    if (!v || seconds === undefined) return;
    if (v.readyState >= 1) v.currentTime = seconds;
    else v.onloadedmetadata = () => (v.currentTime = seconds);
  }, [seconds, media?.id]);
  if (!hover || !media || media.kind !== "video") return null;
  const src = proxiesOn && proxy?.phase === "done" && proxy.key ? proxyUrl(media.id, proxy.key) : mediaUrl(media.id, media.path);
  return <video ref={ref} key={media.id} className="pv-skim" data-testid="media-skim" data-media={media.id} data-seconds={seconds} src={src} muted playsInline preload="auto" />;
}
