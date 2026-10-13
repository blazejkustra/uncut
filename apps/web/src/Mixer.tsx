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
import { useEffect, useRef, useState } from "react";
import { MAX_DB, SILENCE_DB, gainToDb, mixNote } from "@uncut/core/audio";
import { duckNote, duckSettings, DUCK_DEFAULTS } from "@uncut/core/ducking";
import { COMPRESSOR, compressorParams, DENOISE, DUCK, effectName, effectSummary, EQ, eqParams, EXPORT_ONLY_EFFECTS, LIMITER_CEILING_DB, LOUDNESS_PRESETS, masterLimiter, projectTargetLufs, VOICE, amountOf } from "@uncut/core/effects";
import type { ModuleUse } from "@uncut/core/types";

import { currentMix, type StereoLevel } from "./audio.ts";
import { draftOf, planTrackFlag, trackFlag, type Plan } from "./edit.ts";
import { getPlayback, playback, type PreviewDraft } from "./playback.ts";
import { MASTER_EXPORT_NOTE } from "./sound.ts";
import { displayTracks, type ProjectModel, type Track } from "./project.ts";
import { dbLabel, levelY, panShort, panWords, planAddEffect, planBypassEffect, planDuck, planEffectParams, planLoudnessTarget, planMasterGain, planMasterLimiter, planMoveEffect, planRemoveEffect, planTrackGain, planTrackPan, planVoicePreset, soundTrack, yLevel } from "./sound.ts";
import { useDuckCurves, useDuckState } from "./ducking.ts";
import { NumberField } from "./ItemEditors.tsx";
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
      <EffectSlots project={project} track={track} online={online} />
      <DuckRow project={project} track={track} online={online} />
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
      <MasterControls project={project} online={online} />
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
  // Gain-reduction lights come and go with compressors and the limiter: the loop re-reads them.
  const fxKey = [...strips.map((t) => (t.mixer?.effects ?? []).map((f) => `${f.module}${f.bypass ? "-" : ""}`).join("+")), masterLimiter(project) ? "lim" : ""].join(",");
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


// ---- effects, ducking, the limiter and the loudness target (D84–D88) ----

/** Fill a gain-reduction light from a reading (dB ≤ 0): its bar grows down from the top over 0…−12 dB. Returns whether it shows anything. */
function drawReduction(el: HTMLElement, gr: number): boolean {
  const v = Math.max(0, Math.min(12, -gr));
  const key = v.toFixed(1);
  if (el.dataset.last === key) return v > 0.05;
  el.dataset.last = key;
  el.dataset.value = String(Math.round(gr * 10) / 10);
  const bar = el.firstElementChild as HTMLElement | null;
  if (bar) bar.style.height = `${(v / 12) * 100}%`;
  return v > 0.05;
}

/** A small popover over the panel, opened from an anchor (fixed, so the panel's scroll doesn't clip it). Escape or a click outside closes it. */
function Popover({ anchor, onClose, children, testId }: { anchor: HTMLElement; onClose: () => void; children: React.ReactNode; testId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - 268, r.left));
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);
  return (
    <div className="fx-popover" data-testid={testId} ref={ref} style={{ left, bottom: Math.max(8, window.innerHeight - r.top + 6) }} onPointerDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

/** The fields of one effect's settings, each a number committed as one edit. */
const FIELDS: Readonly<Record<string, ReadonlyArray<{ key: string; label: string; step: number; min: number; max: number; optional?: boolean }>>> = {
  [EQ]: [
    { key: "lowCutHz", label: "Low cut Hz", step: 10, min: 20, max: 1000, optional: true },
    { key: "lowGainDb", label: "Low dB", step: 0.5, min: -24, max: 24 },
    { key: "lowHz", label: "Low Hz", step: 10, min: 20, max: 1000 },
    { key: "midGainDb", label: "Mid dB", step: 0.5, min: -24, max: 24 },
    { key: "midHz", label: "Mid Hz", step: 50, min: 100, max: 10000 },
    { key: "midQ", label: "Mid Q", step: 0.1, min: 0.1, max: 10 },
    { key: "highGainDb", label: "High dB", step: 0.5, min: -24, max: 24 },
    { key: "highHz", label: "High Hz", step: 100, min: 1000, max: 16000 },
    { key: "highCutHz", label: "High cut Hz", step: 100, min: 1000, max: 20000, optional: true },
  ],
  [COMPRESSOR]: [
    { key: "thresholdDb", label: "Threshold dB", step: 1, min: -60, max: 0 },
    { key: "ratio", label: "Ratio", step: 0.5, min: 1, max: 20 },
    { key: "attackMs", label: "Attack ms", step: 1, min: 1, max: 500 },
    { key: "releaseMs", label: "Release ms", step: 10, min: 10, max: 1000 },
    { key: "makeupDb", label: "Make-up dB", step: 0.5, min: 0, max: 24 },
  ],
  [VOICE]: [{ key: "amount", label: "Amount", step: 0.1, min: 0, max: 1 }],
  [DENOISE]: [{ key: "amount", label: "Amount", step: 0.1, min: 0, max: 1 }],
};
/** An effect's value for a field, defaults filled in (what it sounds like now). */
function fieldValue(fx: ModuleUse, key: string): number | undefined {
  const all: Record<string, number | undefined> = fx.module === EQ ? eqParams(fx.params) : fx.module === COMPRESSOR ? compressorParams(fx.params) : { amount: amountOf(fx.params) };
  return all[key];
}

/** A track's effect slots (ducking has its own row) and the add menu. */
function EffectSlots({ project, track, online }: { project: ProjectModel; track: Track; online: boolean }) {
  const [open, setOpen] = useState<{ index: number; module: string; anchor: HTMLElement } | undefined>(undefined);
  const [menu, setMenu] = useState<HTMLElement | undefined>(undefined);
  const effects = track.mixer?.effects ?? [];
  const hasCompressor = effects.some((fx) => !fx.bypass && (fx.module === COMPRESSOR || fx.module === VOICE));
  // The popover belongs to that entry: if the chain changes under it (an agent turn, an undo), it closes.
  const shownFx = open && effects[open.index]?.module === open.module ? effects[open.index] : undefined;
  useEffect(() => {
    if (open && !shownFx) setOpen(undefined);
  }, [open, shownFx]);
  return (
    <div className="fx-list" data-testid="fx-list">
      <div className="fx-slots">
      {effects.map((fx, index) =>
        fx.module === DUCK ? null : (
          <button
            key={index}
            type="button"
            className={`fx-slot ${fx.bypass ? "bypassed" : ""} ${open?.index === index ? "open" : ""}`}
            data-testid="fx-slot"
            data-module={fx.module}
            data-index={index}
            data-bypass={fx.bypass === true}
            title={`${effectName(fx.module)}: ${effectSummary(fx)}${fx.bypass ? " (bypassed)" : ""}${EXPORT_ONLY_EFFECTS.includes(fx.module) ? " — applied on export" : ""}`}
            onClick={(e) => setOpen(open?.index === index ? undefined : { index, module: fx.module, anchor: e.currentTarget })}
          >
            <span className="fx-dot" />
            <span className="ellipsis">{effectName(fx.module)}</span>
            {EXPORT_ONLY_EFFECTS.includes(fx.module) && (
              <span className="fx-badge" data-testid="fx-export-badge" title="Applied on export: the preview plays the track as recorded">
                export
              </span>
            )}
          </button>
        ),
      )}
      </div>
      <div className="fx-foot">
        <button type="button" className="fx-add" data-testid="fx-add" disabled={!online} title="Add an effect" onClick={(e) => setMenu(menu ? undefined : e.currentTarget)}>
          + FX
        </button>
        {hasCompressor && (
          <div className="gr" data-testid="fx-gr" data-gr={track.id} data-value="0" title="Compressor gain reduction">
            <div className="gr-bar" />
          </div>
        )}
      </div>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(undefined)} testId="fx-menu">
          <div className="fx-pop-title">Add to {track.name}</div>
          {(
            [
              ["fx-add-audio.eq", "EQ", "Low cut, low / mid / high", (now: ProjectModel) => planAddEffect(now, track.id, EQ)],
              ["fx-add-audio.compressor", "Compressor", "Evens out the level", (now: ProjectModel) => planAddEffect(now, track.id, COMPRESSOR)],
              ["fx-add-voice-preset", "Voice preset", "EQ (low cut, presence) and a gentle compressor", (now: ProjectModel) => planVoicePreset(now, track.id)],
              ["fx-add-audio.voice-enhance", "Voice", "The voice chain in one slot", (now: ProjectModel) => planAddEffect(now, track.id, VOICE)],
              ["fx-add-audio.denoise", "Noise removal", "Applied on export", (now: ProjectModel) => planAddEffect(now, track.id, DENOISE)],
            ] as const
          ).map(([id, name, hint, make]) => (
            <button
              key={id}
              type="button"
              className="fx-menu-item"
              data-testid={id}
              onClick={() => {
                setMenu(undefined);
                commit(make);
              }}
            >
              <b>{name}</b>
              <span className="muted small">{hint}</span>
            </button>
          ))}
        </Popover>
      )}
      {open && shownFx && (
        <Popover anchor={open.anchor} onClose={() => setOpen(undefined)} testId="fx-popover">
          <div className="fx-pop-title">
            {effectName(shownFx.module)} on {track.name}
          </div>
          {EXPORT_ONLY_EFFECTS.includes(shownFx.module) && <div className="muted small">Applied on export: the preview plays the track as recorded.</div>}
          <div className="fx-pop-actions">
            <button type="button" className="btn ghost" data-testid="fx-up" disabled={!online} title="Earlier in the chain" onClick={() => (commit((now) => planMoveEffect(now, track.id, open.index, -1, open.module)), setOpen(undefined))}>
              ↑
            </button>
            <button type="button" className="btn ghost" data-testid="fx-down" disabled={!online} title="Later in the chain" onClick={() => (commit((now) => planMoveEffect(now, track.id, open.index, 1, open.module)), setOpen(undefined))}>
              ↓
            </button>
            <button type="button" className={`btn ghost ${shownFx.bypass ? "on" : ""}`} data-testid="fx-bypass" aria-pressed={shownFx.bypass === true} disabled={!online} onClick={() => commit((now) => planBypassEffect(now, track.id, open.index, !shownFx.bypass, open.module))}>
              {shownFx.bypass ? "Turn on" : "Bypass"}
            </button>
            <button type="button" className="btn ghost" data-testid="fx-remove" disabled={!online} onClick={() => (commit((now) => planRemoveEffect(now, track.id, open.index, open.module)), setOpen(undefined))}>
              Remove
            </button>
          </div>
          <div className="fx-fields">
            {(FIELDS[shownFx.module] ?? []).map((f) => (
              <NumberField
                key={f.key}
                label={f.label}
                testId={`fx-param-${f.key}`}
                value={f.optional && shownFx.params?.[f.key] === undefined ? undefined : fieldValue(shownFx, f.key)}
                placeholder={f.optional ? "off" : undefined}
                step={f.step}
                min={f.min}
                max={f.max}
                disabled={!online}
                onCommit={(v) => commit((now) => planEffectParams(now, track.id, open.index, { [f.key]: v ?? null }, open.module))}
              />
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}

/** The Duck row (D85): under which track, and the settings, in a popover; what it waits for when the key isn't measured. */
function DuckRow({ project, track, online }: { project: ProjectModel; track: Track; online: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined);
  const curves = useDuckCurves(project);
  useDuckState((s) => s.measuring);
  const fxIndex = (track.mixer?.effects ?? []).findIndex((e) => e.module === DUCK);
  const fx = fxIndex >= 0 ? track.mixer!.effects![fxIndex] : undefined;
  const settings = fx ? duckSettings(fx.params) : undefined;
  const bypassed = fx?.bypass === true;
  const keys = project.tracks.filter((t) => t.id !== track.id && soundTrack(project, t));
  const note = duckNote(project, track, curves.get(track.id));
  const name = (id: string) => project.tracks.find((t) => t.id === id)?.name ?? id;
  const label = settings ? `Duck${bypassed ? " (off)" : ""}: ${settings.under.map(name).join(", ")} ${dbLabel(settings.amountDb)}` : "Duck…";
  return (
    <div className="duck-row">
      <button type="button" className={`duck-btn ${settings && !bypassed ? "on" : ""}`} data-testid="duck-btn" data-under={settings?.under.join(",") ?? ""} data-bypass={bypassed} disabled={!online || (!keys.length && !settings)} title={note ?? (settings ? `Ducks under ${settings.under.map(name).join(", ")} by ${dbLabel(settings.amountDb)} dB` : "Duck this track while another has speech")} onClick={(e) => setAnchor(anchor ? undefined : e.currentTarget)}>
        <span className="ellipsis">{label}</span>
        {note && !bypassed && <span className="duck-wait" data-testid="duck-note" title={note}>…</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(undefined)} testId="duck-popover">
          <div className="fx-pop-title">Duck {track.name}</div>
          <div className="muted small">Goes down while the key track has speech (its measured loudness), the same in the preview and the export.</div>
          <label className="field">
            <span className="k">Under</span>
            <select
              className="v"
              data-testid="duck-under"
              value={settings?.under[0] ?? ""}
              disabled={!online}
              onChange={(e) => {
                const id = e.target.value;
                commit((now) => planDuck(now, track.id, id ? { under: [id] } : null));
              }}
            >
              <option value="">Nothing (off)</option>
              {keys.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {settings && (
            <label className="field">
              <span className="k">On</span>
              <input type="checkbox" className="v" data-testid="duck-on" checked={!bypassed} disabled={!online} onChange={(e) => commit((now) => planBypassEffect(now, track.id, fxIndex, !e.target.checked, DUCK))} />
            </label>
          )}
          {settings && (
            <div className="fx-fields">
              <NumberField label="Amount dB" testId="duck-amountDb" value={settings.amountDb} step={1} min={-40} max={0} disabled={!online} onCommit={(v) => commit((now) => planDuck(now, track.id, { under: settings.under, amountDb: v ?? DUCK_DEFAULTS.amountDb }))} />
              <NumberField label="Attack ms" testId="duck-attackMs" value={settings.attackMs} step={50} min={0} max={2000} disabled={!online} onCommit={(v) => commit((now) => planDuck(now, track.id, { under: settings.under, attackMs: v ?? DUCK_DEFAULTS.attackMs }))} />
              <NumberField label="Release ms" testId="duck-releaseMs" value={settings.releaseMs} step={50} min={0} max={5000} disabled={!online} onCommit={(v) => commit((now) => planDuck(now, track.id, { under: settings.under, releaseMs: v ?? DUCK_DEFAULTS.releaseMs }))} />
              <NumberField label="Threshold dB" testId="duck-thresholdDb" value={settings.thresholdDb} placeholder="auto" step={1} min={-80} max={0} disabled={!online} onCommit={(v) => commit((now) => planDuck(now, track.id, { under: settings.under, thresholdDb: v ?? null }))} />
            </div>
          )}
          {note && (
            <div className="small duck-note-text" data-testid="duck-popover-note">
              {note}
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}

/** The master's limiter (on / ceiling, gain reduction) and loudness target (D86, D87). */
function MasterControls({ project, online }: { project: ProjectModel; online: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined);
  const limiter = masterLimiter(project);
  const target = projectTargetLufs(project);
  const preset = LOUDNESS_PRESETS.find((p) => p.lufs === target);
  return (
    <div className="fx-list master-fx">
      <div className="fx-foot">
        <button type="button" className={`fx-slot ${limiter ? "" : "bypassed"}`} data-testid="limiter-btn" data-on={limiter !== undefined} data-ceiling={limiter?.ceilingDb ?? ""} title={limiter ? `Limiter on: peaks stay under ${dbLabel(limiter.ceilingDb)} dBTP` : "Limiter off: loud peaks can clip"} onClick={(e) => setAnchor(anchor ? undefined : e.currentTarget)}>
          <span className="fx-dot" />
          <span className="ellipsis">Limiter</span>
        </button>
        {limiter && (
          <div className="gr" data-testid="limiter-gr" data-gr="master" data-value="0" title="Limiter gain reduction">
            <div className="gr-bar" />
          </div>
        )}
      </div>
      <button type="button" className="fx-slot target" data-testid="target-btn" data-lufs={target} title="Loudness target: the export dialog starts from it" onClick={(e) => setAnchor(anchor ? undefined : e.currentTarget)}>
        <span className="ellipsis">{preset ? preset.name : `${dbLabel(target)} LUFS`}</span>
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(undefined)} testId="master-popover">
          <div className="fx-pop-title">Master</div>
          <label className="field">
            <span className="k">Limiter</span>
            <input type="checkbox" className="v" data-testid="limiter-toggle" checked={limiter !== undefined} disabled={!online} onChange={(e) => commit((now) => planMasterLimiter(now, e.target.checked, masterLimiter(now)?.ceilingDb ?? LIMITER_CEILING_DB))} />
          </label>
          {limiter && <NumberField label="Ceiling dBTP" testId="limiter-ceiling" value={limiter.ceilingDb} step={0.5} min={-12} max={0} disabled={!online} onCommit={(v) => commit((now) => planMasterLimiter(now, true, v ?? LIMITER_CEILING_DB))} />}
          <div className="muted small">The limiter is the last stage, after the master volume: the export never goes over the ceiling, As mixed too.</div>
          <label className="field">
            <span className="k">Loudness target</span>
            <select className="v" data-testid="target-select" value={preset ? String(target) : "custom"} disabled={!online} onChange={(e) => e.target.value !== "custom" && commit((now) => planLoudnessTarget(now, Number(e.target.value)))}>
              {LOUDNESS_PRESETS.map((p) => (
                <option key={p.id} value={String(p.lufs)}>
                  {p.name} ({dbLabel(p.lufs)} LUFS)
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </label>
          <NumberField label="Target LUFS" testId="target-lufs" value={target} step={1} min={-30} max={-5} disabled={!online} onCommit={(v) => commit((now) => planLoudnessTarget(now, v ?? -14))} />
          <div className="muted small">The export dialog starts from this target (Normal, Quieter, Broadcast or this number); As mixed keeps your levels.</div>
        </Popover>
      )}
    </div>
  );
}
