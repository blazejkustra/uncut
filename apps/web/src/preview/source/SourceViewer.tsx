// The source viewer (D311, source.ts) over the preview: the media open there, played by its own
// <video> or <audio> (a sound shows its waveform, a picture just itself), with its own transport.
// The project stays drawn underneath, so going back to the timeline shows its frame at once.
import { ArrowLeft, AudioLines, Film, Image as ImageIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type RefObject } from "react";

import { bridge } from "../../state/bridge.ts";
import { getState, mediaUrl, projectOf, proxyOf, proxyUrl, subscribeApp, type MediaItem } from "../../state/store.ts";
import { useProxiesOn } from "../../settings/proxies.ts";
import { MEDIA_DRAG_TYPE, MEDIA_RANGE_DRAG_TYPE } from "../../timeline/dnd.ts";
import { ItemWaveform } from "../../timeline/Waveform.tsx";
import { Tooltip } from "../../ui/Tooltip.tsx";
import { getSource, markedRange, source, useSource } from "./source.ts";
import { SourceTransport } from "./SourceTransport.tsx";
import "./source.css";

const useOpenMedia = (id: string | undefined) =>
  useSyncExternalStore(subscribeApp, () => {
    const snapshot = getState().snapshot;
    return id === undefined || !snapshot ? undefined : projectOf(snapshot).media.find((m) => m.id === id);
  });

const onTimeline = (e: PointerEvent) => e.target instanceof Element && e.target.closest("[data-testid=timeline]") !== null;

export function SourceViewer({ fps }: { fps: number }) {
  const id = useSource((s) => s.media);
  const media = useOpenMedia(id);
  const online = useSyncExternalStore(subscribeApp, () => getState().connection === "connected");
  useEffect(() => () => source.close(), []);
  useEffect(() => {
    if (id !== undefined && !media) source.close();
  }, [id, media]);
  useEffect(() => {
    if (id === undefined) return;
    const onDown = (e: PointerEvent) => onTimeline(e) && source.close();
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [id]);
  if (!media) return null;
  const Icon = media.kind === "audio" ? AudioLines : media.kind === "image" ? ImageIcon : Film;
  return (
    <section
      className="source-view"
      data-testid="source-viewer"
      data-media={media.id}
      onPointerEnter={() => source.pointerOver(true)}
      onPointerLeave={() => source.pointerOver(false)}
    >
      <header className="source-head">
        <Icon className="source-icon" />
        <span className="source-mode">Source</span>
        <span className="source-name" data-testid="source-name" title={media.path}>
          {media.name}
        </span>
        <Tooltip label="Back to the timeline" shortcut="deselect">
          <button className="btn ghost source-back" data-testid="source-back" onClick={source.close}>
            <ArrowLeft />
            Timeline
          </button>
        </Tooltip>
      </header>
      <SourcePicture media={media} fps={fps} online={online} />
      <SourceTransport media={media} fps={fps} online={online} />
    </section>
  );
}

function SourcePicture({ media, fps, online }: { media: MediaItem; fps: number; online: boolean }) {
  const proxy = useSyncExternalStore(subscribeApp, () => proxyOf(getState(), media.id));
  const proxiesOn = useProxiesOn();
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useMediaElement(ref);
  const src = media.kind === "video" && proxiesOn && proxy?.phase === "done" && proxy.key ? proxyUrl(media.id, proxy.key) : mediaUrl(media.id, media.path);
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(MEDIA_DRAG_TYPE, media.id);
    const range = markedRange(getSource(), fps, media.probe?.frames);
    if (range) e.dataTransfer.setData(MEDIA_RANGE_DRAG_TYPE, JSON.stringify(range));
    e.dataTransfer.effectAllowed = "copy";
  };
  const element = {
    ref,
    src,
    muted: !!bridge.silentAudio,
    preload: "auto",
    onLoadedMetadata: () => source.setDuration(ref.current?.duration ?? 0),
    onEnded: source.ended,
  } as const;
  return (
    <div
      className="source-picture"
      data-testid="source-picture"
      data-kind={media.kind}
      draggable={online}
      title={online ? "Drag onto the timeline to add it (In to Out when marked)" : undefined}
      onDragStart={onDragStart}
      onClick={media.kind === "image" ? undefined : source.toggle}
    >
      {media.kind === "image" && <img src={mediaUrl(media.id, media.path)} alt="" draggable={false} data-testid="source-image" />}
      {media.kind === "video" && <video key={src} {...element} playsInline data-testid="source-video" />}
      {media.kind === "audio" && (
        <>
          <audio key={src} {...element} data-testid="source-audio" />
          <SourceWave media={media} fps={fps} />
        </>
      )}
    </div>
  );
}

/** The element follows the viewer: plays and pauses with it, jumps on a seek, and reports where it is while playing. */
function useMediaElement(ref: RefObject<HTMLMediaElement | null>) {
  const playing = useSource((s) => s.playing);
  const seek = useSource((s) => s.seek);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const to = getSource().time;
    if (el.readyState >= 1) el.currentTime = to;
    else el.addEventListener("loadedmetadata", () => (el.currentTime = to), { once: true });
  }, [ref, seek]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!playing) return el.pause();
    el.play().catch(() => source.ended());
    return followWhilePlaying(el);
  }, [ref, playing]);
}

function followWhilePlaying(el: HTMLMediaElement) {
  let raf = 0;
  const tick = () => {
    source.playedTo(el.currentTime);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

function SourceWave({ media, fps }: { media: MediaItem; fps: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const time = useSource((s) => s.time);
  const duration = useSource((s) => s.duration);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const frames = media.probe?.frames ?? Math.max(1, Math.round(duration * fps));
  return (
    <div className="source-wave" ref={ref} data-testid="source-wave">
      {width > 0 && (
        <ItemWaveform
          item={{ id: `source-${media.id}`, type: "audio", media: media.id, in: 0, duration: frames }}
          media={media}
          fps={fps}
          width={width}
          compact={false}
        />
      )}
      {duration > 0 && <span className="source-wave-head" style={{ left: `${(time / duration) * 100}%` }} />}
    </div>
  );
}
