// The Mixer (phase 6 chunk 6, D83): the bottom panel's third mode. One channel strip per track
// that can sound (audio tracks, video tracks holding a clip with sound) in timeline order, and the
// master strip. A strip has the track's name, a pan slider (−1…1, double-click centres), a fader
// (−∞…+12 dB, double-click resets to 0 dB), mute and solo, and a stereo meter of what the track
// puts out after its fader and pan (peak and RMS from the preview's audio graph, read every
// animation frame while the panel is open). The master strip has the project's master volume and
// the meter of the whole mix.
//
// Every gesture is one project.edit through timelineEdit (validated, one ⌘Z, a History label): a
// fader or pan drag is heard while it moves (a local draft the playback mix plays, as the track
// volume slider does) and saved once on release.
//
// Phase 6 chunk 7 (D84–D88): each strip has its effects as slots (EQ, compressor, voice, noise
// removal; click one for its settings, up / down, bypass and remove, in a small popover; "+" adds
// one or the Voice preset), a Duck row (under which track, how far, attack, release, threshold; the
// curve shows on the track's items in the timeline) and a gain-reduction light for compressors.
// The master strip has the limiter (on by default at −1 dBTP, with its gain reduction) and the
// loudness target the export dialog starts from. Each change is one edit with a History label.
import { useEffect, useRef } from "react";
import { mixNote } from "@uncut/core/audio";
import { masterLimiter } from "@uncut/core/effects";

import { currentMix } from "./audio.ts";
import { getPlayback, playback } from "../preview/playback.ts";
import { displayTracks, type ProjectModel } from "../state/project.ts";
import { soundTrack } from "./sound.ts";
import { useApp } from "../state/store.ts";
import { BottomTabs } from "../timeline/BottomTabs.tsx";
import { type MeterEl, drawMeter, drawReduction } from "./mixer/controls.tsx";
import { Strip, MasterStrip } from "./mixer/Strip.tsx";

export function MixerPanel({ project }: { project: ProjectModel }) {
  const { connection } = useApp();
  const online = connection === "connected";
  const bodyRef = useRef<HTMLDivElement>(null);
  // Tracks with sound, and any soloed track (a solo on a track with nothing to play is ignored by
  // the mix, but it stays reachable here so it can be turned off).
  const strips = displayTracks(project).filter((t) => soundTrack(project, t) || t.mixer?.solo === true);
  const note = mixNote(project);
  const stripKey = strips.map((t) => t.id).join(",");
  // Gain-reduction lights come and go with compressors and the limiter: the loop re-reads them.
  const fxKey = [
    ...strips.map((t) => (t.mixer?.effects ?? []).map((f) => `${f.module}${f.bypass ? "-" : ""}`).join("+")),
    masterLimiter(project) ? "lim" : "",
  ].join(",");
  // The meters: read the mix's levels every animation frame while something plays; once paused and
  // every meter rests at the floor, the loop idles until playback starts again.
  useEffect(() => {
    const meters: Array<MeterEl> = [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-meter]") ?? [])].map((el) => ({
      el,
      rms: [...el.querySelectorAll<HTMLElement>(".meter-rms")],
      peak: [...el.querySelectorAll<HTMLElement>(".meter-peak")],
      last: "",
      overUntil: 0,
    }));
    const silent = { left: { rms: 0, peak: 0 }, right: { rms: 0, peak: 0 } };
    const reductions = [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-gr]") ?? [])];
    let raf = 0;
    const loop = (now: number) => {
      raf = 0;
      const levels = currentMix()?.levels();
      let lit = false;
      for (const m of meters) {
        const id = m.el.dataset.meter!;
        if (drawMeter(m, (id === "master" ? levels?.master : levels?.tracks[id]) ?? silent, now)) lit = true;
        if (now < m.overUntil) lit = true;
      }
      // Gain reduction (D84, D86): the master limiter's and each strip's compressors'.
      for (const el of reductions) {
        const id = el.dataset.gr!;
        const gr = id === "master" ? (levels?.limiter ?? 0) : (levels?.reduction[id] ?? 0);
        if (drawReduction(el, gr)) lit = true;
      }
      if (lit || getPlayback().playing) raf = requestAnimationFrame(loop);
    };
    const wake = () => {
      if (!raf) raf = requestAnimationFrame(loop);
    };
    wake();
    const unsubscribe = playback.subscribe(() => getPlayback().playing && wake());
    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, [stripKey, fxKey]);
  return (
    <section className="bottom" data-testid="mixer-panel">
      <div className="bottom-toolbar">
        <BottomTabs />
        <span className="muted small">{strips.length === 1 ? "1 channel" : `${strips.length} channels`}</span>
        {note && (
          <span className="solo-note small" data-testid="mixer-solo-note">
            {note}
          </span>
        )}
      </div>
      <div className="bottom-body mixer-body" ref={bodyRef}>
        {strips.length === 0 && <div className="mixer-empty muted">Nothing makes sound yet: add a clip with sound or music, and its track shows up here.</div>}
        <div className="mixer-strips">
          {strips.map((t) => (
            <Strip key={t.id} project={project} track={t} online={online} />
          ))}
          <div className="mixer-gap" />
          <MasterStrip project={project} online={online} />
        </div>
      </div>
    </section>
  );
}
