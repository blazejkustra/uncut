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
import { useEffect, useRef, useState } from "react";
import { MAX_DB, SILENCE_DB, gainToDb, mixNote } from "@uncut/core/audio";

import { currentMix, type StereoLevel } from "./audio.ts";
import { draftOf, planTrackFlag, trackFlag, type Plan } from "./edit.ts";
import { getPlayback, playback, type PreviewDraft } from "./playback.ts";
import { MASTER_EXPORT_NOTE } from "./sound.ts";
import { displayTracks, type ProjectModel, type Track } from "./project.ts";
import { dbLabel, levelY, panShort, panWords, planMasterGain, planTrackGain, planTrackPan, soundTrack, yLevel } from "./sound.ts";
import { actions, getState, projectOf, useApp } from "./store.ts";
import { BottomTabs } from "./Timeline.tsx";

type Problem = { readonly problem: string };

/** Send a plan made against the project as it is now (an agent edit may have landed meanwhile), then drop the drag's draft. */
function commit(make: (project: ProjectModel) => Plan | Problem, draft?: PreviewDraft) {
  const snapshot = getState().snapshot;
  if (!snapshot) return;
  void actions.timelineEdit(make(projectOf(snapshot)), { baseRevision: snapshot.revision, dir: snapshot.dir }).finally(() => {
    if (draft && getPlayback().draft === draft) playback.setDraft(undefined);
  });
}

/** Show a planned change in the preview (and the mix) while a control is dragged. */
function preview(project: ProjectModel, plan: Plan | Problem): PreviewDraft | undefined {
  if ("problem" in plan || !plan.ops.length) return undefined;
  const result = draftOf(project, plan.ops);
  if (!("project" in result)) return undefined;
  const draft = { base: project, project: result.project };
  playback.setDraft(draft);
  return draft;
}

/**
 * A relative drag (no jump on press): the value moves by the pointer's travel, `toValue` maps a
 * start value and the travel in pixels to the new value. Commits on release only if it changed.
 */
function useDrag<T>({ value, toValue, onPreview, onCommit, disabled }: { value: T; toValue: (start: T, dx: number, dy: number) => T; onPreview: (v: T) => void; onCommit: (v: T) => void; disabled: boolean }) {
  const [local, setLocal] = useState<T | undefined>(undefined);
  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const start = value;
    let last: T = value;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2 && Math.abs(ev.clientY - y0) < 2) return;
      moved = true;
      last = toValue(start, ev.clientX - x0, ev.clientY - y0);
      setLocal(last);
      onPreview(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setLocal(undefined);
      if (moved && last !== start) onCommit(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  return { shown: local ?? value, dragging: local !== undefined, onPointerDown };
}

/** A vertical fader in dB on the shared level scale (levelY): drag the thumb, double-click for 0 dB. */
function Fader({ value, onPreview, onCommit, disabled, testId, label }: { value: number; onPreview: (db: number) => void; onCommit: (db: number) => void; disabled: boolean; testId: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { shown, onPointerDown } = useDrag({
    value,
    disabled,
    toValue: (start, _dx, dy) => {
      const h = ref.current?.clientHeight || 100;
      const db = yLevel(levelY(start) + dy / h);
      return Math.round(Math.min(MAX_DB, Math.max(SILENCE_DB, db)) * 2) / 2;
    },
    onPreview,
    onCommit,
  });
  return (
    <div
      className={`fader ${disabled ? "disabled" : ""}`}
      ref={ref}
      data-testid={testId}
      data-db={shown}
      role="slider"
      aria-label={label}
      aria-valuemin={SILENCE_DB}
      aria-valuemax={MAX_DB}
      aria-valuenow={shown}
      title={`${label}: ${dbLabel(shown)} dB (drag; double-click for 0 dB)`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => !disabled && value !== 0 && onCommit(0)}
    >
      <div className="fader-track" />
      <div className="fader-zero" style={{ top: `${levelY(0) * 100}%` }} />
      <div className="fader-thumb" data-testid={`${testId}-thumb`} style={{ top: `${levelY(shown) * 100}%` }} />
    </div>
  );
}

/** A horizontal pan slider, −1 (left) … 1 (right): drag, double-click to centre. */
function PanSlider({ value, onPreview, onCommit, disabled, name }: { value: number; onPreview: (p: number) => void; onCommit: (p: number) => void; disabled: boolean; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { shown, onPointerDown } = useDrag({
    value,
    disabled,
    toValue: (start, dx) => {
      const w = ref.current?.clientWidth || 60;
      const p = Math.min(1, Math.max(-1, start + (2 * dx) / w));
      return Math.abs(p) < 0.025 ? 0 : Math.round(p * 100) / 100;
    },
    onPreview,
    onCommit,
  });
  const x = ((shown + 1) / 2) * 100;
  return (
    <div className="pan-row">
      <div
        className={`pan ${disabled ? "disabled" : ""}`}
        ref={ref}
        data-testid="mixer-pan"
        data-pan={shown}
        role="slider"
        aria-label={`${name} pan`}
        aria-valuemin={-1}
        aria-valuemax={1}
        aria-valuenow={shown}
        title={`Pan ${panWords(shown)} (drag; double-click to centre)`}
        onPointerDown={onPointerDown}
        onDoubleClick={() => !disabled && value !== 0 && onCommit(0)}
      >
        <div className="pan-fill" style={{ left: `${Math.min(50, x)}%`, width: `${Math.abs(x - 50)}%` }} />
        <div className="pan-centre" />
        <div className="pan-thumb" style={{ left: `${x}%` }} />
      </div>
      <span className="pan-label mono" data-testid="mixer-pan-label">
        {panShort(shown)}
      </span>
    </div>
  );
}

/** A stereo meter: RMS as the bar, peak as a line, on the faders' scale. The panel's loop writes into it. */
function Meter({ id }: { id: string }) {
  return (
    <div className="meter" data-testid="mixer-meter" data-meter={id} data-peak="-Infinity" data-rms="-Infinity" data-over="false" title="Level after the fader and pan: RMS bar, peak line; the top lights red when the peak reaches full scale">
      {(["l", "r"] as const).map((c) => (
        <div key={c} className="meter-ch">
          <div className="meter-rms" data-ch={c} />
          <div className="meter-peak" data-ch={c} />
        </div>
      ))}
    </div>
  );
}

/** How long a meter's over (clip) light stays on after a peak at or above full scale. */
const OVER_HOLD_MS = 1500;
interface MeterEl {
  readonly el: HTMLElement;
  readonly rms: ReadonlyArray<HTMLElement>;
  readonly peak: ReadonlyArray<HTMLElement>;
  /** What was last written, to skip unchanged writes. */
  last: string;
  overUntil: number;
}
/**
 * Fill a meter from a level reading (and say it in data-peak / data-rms, dBFS of the louder
 * channel, for the tests); a peak at full scale lights the meter's over light for a moment.
 * Returns whether the meter shows anything (false once it rests at the floor).
 */
function drawMeter(m: MeterEl, level: StereoLevel, now: number): boolean {
  const chans = [level.left, level.right];
  if (chans.some((c) => c.peak >= 1)) m.overUntil = now + OVER_HOLD_MS;
  const over = now < m.overUntil;
  const ys = chans.map((c) => [levelY(gainToDb(c.rms)), levelY(gainToDb(c.peak))] as const);
  const key = `${ys.map(([r, p]) => `${r.toFixed(3)},${p.toFixed(3)}`).join(";")}${over ? "!" : ""}`;
  if (key === m.last) return key !== FLOOR_KEY;
  m.last = key;
  ys.forEach(([r, p], i) => {
    m.rms[i]!.style.clipPath = `inset(${r * 100}% 0 0 0)`;
    m.peak[i]!.style.bottom = `${(1 - p) * 100}%`;
  });
  m.el.classList.toggle("over", over);
  m.el.dataset.over = over ? "true" : "false";
  m.el.dataset.peak = String(Math.round(gainToDb(Math.max(level.left.peak, level.right.peak)) * 10) / 10);
  m.el.dataset.rms = String(Math.round(gainToDb(Math.max(level.left.rms, level.right.rms)) * 10) / 10);
  return key !== FLOOR_KEY;
}
const FLOOR_KEY = "1.000,1.000;1.000,1.000";

function Strip({ project, track, online }: { project: ProjectModel; track: Track; online: boolean }) {
  const muted = trackFlag(track, "mute");
  const solo = trackFlag(track, "solo");
  const draft = useRef<PreviewDraft | undefined>(undefined);
  const take = () => {
    const d = draft.current;
    draft.current = undefined;
    return d;
  };
  const db = track.mixer?.gainDb ?? 0;
  const pan = track.mixer?.pan ?? 0;
  return (
    <div className={`strip-ch ${muted ? "muted" : ""} ${solo ? "soloed" : ""}`} data-testid="mixer-strip" data-track={track.id}>
      <div className="strip-name ellipsis" title={track.name}>
        {track.name}
      </div>
      <PanSlider
        name={track.name}
        value={pan}
        disabled={!online}
        onPreview={(p) => (draft.current = preview(project, planTrackPan(project, track.id, p)) ?? draft.current)}
        onCommit={(p) => commit((now) => planTrackPan(now, track.id, p), take())}
      />
      <div className="strip-body">
        <Meter id={track.id} />
        <Fader
          testId="mixer-fader"
          label={`${track.name} volume`}
          value={db}
          disabled={!online}
          onPreview={(v) => (draft.current = preview(project, planTrackGain(project, track.id, v)) ?? draft.current)}
          onCommit={(v) => commit((now) => planTrackGain(now, track.id, v), take())}
        />
      </div>
      <div className="strip-foot">
        <span className="strip-db mono" data-testid="mixer-db">
          {dbLabel(db)}
        </span>
        <button className={`ms-btn ${muted ? "on mute" : ""}`} data-testid="mixer-mute" aria-pressed={muted} disabled={!online} title={muted ? "Unmute" : "Mute"} onClick={() => void actions.toggleTrack(track.id, "mute")}>
          M
        </button>
        <button
          className={`ms-btn ${solo ? "on solo" : ""}`}
          data-testid="mixer-solo"
          aria-pressed={solo}
          disabled={!online}
          title={solo ? "Unsolo" : "Solo: only soloed tracks play, in the preview and the export"}
          onClick={() => commit((now) => planTrackFlag(now, track.id, "solo"))}
        >
          S
        </button>
      </div>
    </div>
  );
}

function MasterStrip({ project, online }: { project: ProjectModel; online: boolean }) {
  const draft = useRef<PreviewDraft | undefined>(undefined);
  const db = project.master?.gainDb ?? 0;
  return (
    <div className="strip-ch master" data-testid="mixer-master">
      <div className="strip-name">Master</div>
      <div className="pan-row" />
      <div className="strip-body">
        <Meter id="master" />
        <Fader
          testId="mixer-master-fader"
          label="Master volume"
          value={db}
          disabled={!online}
          onPreview={(v) => (draft.current = preview(project, planMasterGain(project, v)) ?? draft.current)}
          onCommit={(v) => {
            const d = draft.current;
            draft.current = undefined;
            commit((now) => planMasterGain(now, v), d);
          }}
        />
      </div>
      <div className="strip-foot">
        <span className="strip-db mono" data-testid="mixer-master-db">
          {dbLabel(db)}
        </span>
      </div>
      {db !== 0 && (
        <div className="master-note small" data-testid="mixer-master-note" title={MASTER_EXPORT_NOTE}>
          {db <= SILENCE_DB ? "Silent: the export too" : "Export: As mixed"}
        </div>
      )}
    </div>
  );
}

export function MixerPanel({ project }: { project: ProjectModel }) {
  const { connection } = useApp();
  const online = connection === "connected";
  const bodyRef = useRef<HTMLDivElement>(null);
  // Tracks with sound, and any soloed track (a solo on a track with nothing to play is ignored by
  // the mix, but it stays reachable here so it can be turned off).
  const strips = displayTracks(project).filter((t) => soundTrack(project, t) || t.mixer?.solo === true);
  const note = mixNote(project);
  const stripKey = strips.map((t) => t.id).join(",");
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
  }, [stripKey]);
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
