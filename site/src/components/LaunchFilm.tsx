"use client";
import { useEffect, useRef } from "react";

export default function LaunchFilm() {
  const film = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = film.current;
    if (!video || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const playWhileVisible = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void video.play().catch(() => undefined);
        else video.pause();
      },
      { threshold: 0.4 },
    );
    playWhileVisible.observe(video);
    return () => playWhileVisible.disconnect();
  }, []);

  return (
    <video
      ref={film}
      src="/assets/video/launch.mp4"
      poster="/assets/img/launch-poster.webp"
      width={720}
      height={900}
      preload="none"
      muted
      playsInline
      loop
      controls
      aria-label="The 28 second Uncut launch film: a prompt typed into the app, the agent building the timeline, a critic scoring the cut, one clip changed on request, and the export."
    />
  );
}
