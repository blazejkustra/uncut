// The Mixer's effect slots and their popovers (D84–D88; redesigned in D246). Every popover has the
// same header (the effect's name and one On switch: bypass for track effects, on/off for ducking
// and the limiter), fields grouped by what they shape with their units after the value, and a live
// graph: the EQ's response with a draggable handle per band, the compressor's curve with its gain
// reduction, the voice chain's curve, the noise floor noise removal works from, the duck curve
// over the timeline with the playhead, the limiter's ceiling with the master's peak and its
// reduction. Every change is one edit (a handle drag or a field scrub is previewed while it moves).
import { useState, useEffect, useRef } from "react";
import { duckSettings, duckNote, DUCK_DEFAULTS } from "@uncut/core/ducking";
import { EQ, COMPRESSOR, VOICE, DENOISE, eqParams, compressorParams, amountOf, DUCK, effectName, effectSummary, effectStages, voiceStages, masterLimiter, projectTargetLufs, LOUDNESS_PRESETS, LIMITER_CEILING_DB, trackNoiseFloorDb, type Stage } from "@uncut/core/effects";
import { denoiseReductionDb } from "@uncut/core/denoise";
import type { ModuleUse } from "@uncut/core/types";
import { planAddEffect, planVoicePreset, planMoveEffect, planBypassEffect, planRemoveEffect, planEffectParams, soundTrack, dbLabel, planDuck, planMasterLimiter, planLoudnessTarget } from "../sound.ts";
import type { ProjectModel, Track } from "../../state/project.ts";
import { useDuckCurves, useDuckState } from "../ducking.ts";
import { NumberField } from "../../inspector/fields.tsx";
import { previewEdits, endPreview } from "../../state/store.ts";
import { getPlayback } from "../../preview/playback.ts";
import { Popover, commit } from "./controls.tsx";
import { EqGraph, CompressorGraph, DuckGraph, LimiterGraph, type EqHandle, dbText } from "./graphs.tsx";
import { useLoudnessPreview, setPreviewAtTarget } from "../loudnessPreview.ts";
import "./effects.css";

/** One On switch for every effect (track effects, ducking, the limiter). */
function OnSwitch({ on, onChange, disabled, testId, label }: { on: boolean; onChange: (on: boolean) => void; disabled: boolean; testId: string; label: string }) {
  return (
    <button type="button" role="switch" className={`fxp-switch ${on ? "on" : ""}`} data-testid={testId} aria-checked={on} aria-pressed={!on} aria-label={label} title={on ? `${label}: on (click to bypass)` : `${label}: bypassed (click to turn on)`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="fxp-switch-knob" />
      <span className="fxp-switch-text">{on ? "On" : "Off"}</span>
    </button>
  );
}

/** A number field with its unit after the value. */
function Field({ unit, ...props }: React.ComponentProps<typeof NumberField> & { unit: string }) {
  return (
    <div className="fxp-field" data-unit={unit}>
      <NumberField {...props} />
      <span className="fxp-unit">{unit}</span>
    </div>
  );
}

function Head({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="fxp-head">
      <div className="fxp-title">
        <b>{title}</b>
        {sub && <span className="muted small">{sub}</span>}
      </div>
      {children}
    </div>
  );
}

type Patch = Record<string, number | null>;
/** EQ band handles: which params a handle drags. */
const EQ_HANDLES: ReadonlyArray<{ id: string; label: string; freq: string; gain?: string; min: number; max: number }> = [
  { id: "lowcut", label: "LC", freq: "lowCutHz", min: 20, max: 1000 },
  { id: "low", label: "L", freq: "lowHz", gain: "lowGainDb", min: 20, max: 1000 },
  { id: "mid", label: "M", freq: "midHz", gain: "midGainDb", min: 100, max: 10000 },
  { id: "high", label: "H", freq: "highHz", gain: "highGainDb", min: 1000, max: 16000 },
  { id: "highcut", label: "HC", freq: "highCutHz", min: 1000, max: 20000 },
];

/** The settings of one track effect: header with its On switch, graph, grouped fields, order and remove. */
function EffectEditor({ project, track, index, fx, online, onMoved, onRemoved }: { project: ProjectModel; track: Track; index: number; fx: ModuleUse; online: boolean; onMoved: (to: number) => void; onRemoved: () => void }) {
  const [drag, setDrag] = useState<Patch | undefined>(undefined);
  const dragRef = useRef<Patch | undefined>(undefined);
  const paramsKey = JSON.stringify(fx.params ?? {});
  // The saved edit has come back: the drag's local values give way to it.
  useEffect(() => setDrag(undefined), [paramsKey]);
  const shown: ModuleUse = drag ? { ...fx, params: { ...fx.params, ...Object.fromEntries(Object.entries(drag).map(([k, v]) => [k, v ?? undefined])) } } : fx;
  const set = (patch: Patch) => commit((now) => planEffectParams(now, track.id, index, patch, fx.module));
  const bypassed = fx.bypass === true;
  const count = (track.mixer?.effects ?? []).length;
  const field = (key: string, label: string, unit: string, step: number, min: number, max: number, value: number | undefined, optional = false) => (
    <Field key={key} unit={unit} label={label} testId={`fx-param-${key}`} value={optional && shown.params?.[key] === undefined ? undefined : value} placeholder={optional ? "off" : undefined} step={step} min={min} max={max} disabled={!online} onCommit={(v) => set({ [key]: v ?? null })} />
  );
  let body: React.ReactNode = null;
  if (fx.module === EQ) {
    const p = eqParams(shown.params);
    const stages = effectStages({ ...shown, bypass: false });
    const handles: Array<EqHandle> = EQ_HANDLES.filter((h) => h.gain || shown.params?.[h.freq] !== undefined).map((h) => ({ id: h.id, label: h.label, freq: p[h.freq as keyof typeof p] as number, gainDb: h.gain ? (p[h.gain as keyof typeof p] as number) : 0, vertical: h.gain !== undefined, min: h.min, max: h.max }));
    body = (
      <>
        <EqGraph
          stages={stages}
          handles={handles}
          bypassed={bypassed}
          disabled={!online}
          onDrag={(id, freq, gainDb) => {
            const h = EQ_HANDLES.find((x) => x.id === id)!;
            const patch: Patch = { ...dragRef.current, [h.freq]: freq, ...(h.gain ? { [h.gain]: gainDb } : {}) };
            dragRef.current = patch;
            setDrag(patch);
            previewEdits(() => set(patch));
          }}
          onDrop={() => {
            const d = dragRef.current;
            dragRef.current = undefined;
            if (!d) return;
            set(d);
            endPreview(true);
          }}
          onCancel={() => {
            // Cancelled or closed mid-drag (D262): no edit, and the scrub preview goes.
            dragRef.current = undefined;
            setDrag(undefined);
            endPreview(false);
          }}
        />
        <div className="fxp-bands">
          <div className="fxp-band">
            <span className="fxp-band-name">Low cut</span>
            {field("lowCutHz", "Freq", "Hz", 10, 20, 1000, p.lowCutHz, true)}
          </div>
          <div className="fxp-band">
            <span className="fxp-band-name">Low shelf</span>
            {field("lowGainDb", "Gain", "dB", 0.5, -24, 24, p.lowGainDb)}
            {field("lowHz", "Freq", "Hz", 10, 20, 1000, p.lowHz)}
          </div>
          <div className="fxp-band">
            <span className="fxp-band-name">Mid peak</span>
            {field("midGainDb", "Gain", "dB", 0.5, -24, 24, p.midGainDb)}
            {field("midHz", "Freq", "Hz", 50, 100, 10000, p.midHz)}
            {field("midQ", "Q", "", 0.1, 0.1, 10, p.midQ)}
          </div>
          <div className="fxp-band">
            <span className="fxp-band-name">High shelf</span>
            {field("highGainDb", "Gain", "dB", 0.5, -24, 24, p.highGainDb)}
            {field("highHz", "Freq", "Hz", 100, 1000, 16000, p.highHz)}
          </div>
          <div className="fxp-band">
            <span className="fxp-band-name">High cut</span>
            {field("highCutHz", "Freq", "Hz", 100, 1000, 20000, p.highCutHz, true)}
          </div>
        </div>
        <div className="muted small">Drag a handle: sideways for the frequency, up and down for the gain.</div>
      </>
    );
  } else if (fx.module === COMPRESSOR) {
    const c = compressorParams(shown.params);
    body = (
      <>
        <CompressorGraph stage={{ kind: "compressor", ...c }} trackId={track.id} bypassed={bypassed} />
        <div className="fxp-grid">
          {field("thresholdDb", "Threshold", "dB", 1, -60, 0, c.thresholdDb)}
          {field("ratio", "Ratio", ": 1", 0.5, 1, 20, c.ratio)}
          {field("attackMs", "Attack", "ms", 1, 1, 500, c.attackMs)}
          {field("releaseMs", "Release", "ms", 10, 10, 1000, c.releaseMs)}
          {field("makeupDb", "Make-up", "dB", 0.5, 0, 24, c.makeupDb)}
        </div>
      </>
    );
  } else if (fx.module === VOICE || fx.module === DENOISE) {
    const amount = amountOf(shown.params);
    const pct = <Field unit="%" label="Amount" testId="fx-param-amount" value={Math.round(amount * 100)} step={5} min={0} max={100} disabled={!online} onCommit={(v) => set({ amount: v === undefined ? null : Math.round(v) / 100 })} />;
    if (fx.module === VOICE) {
      const stages = voiceStages(amount);
      const comp = stages.find((s): s is Extract<Stage, { kind: "compressor" }> => s.kind === "compressor")!;
      const peak = stages.find((s) => s.kind === "biquad" && s.type === "peaking") as Extract<Stage, { kind: "biquad" }>;
      body = (
        <>
          <EqGraph stages={stages} handles={[]} bypassed={bypassed} testId="fx-voice-graph" />
          {pct}
          <div className="muted small" data-testid="fx-voice-summary">
            Low cut 80 Hz, presence {dbText(peak.gainDb)} at 3.5 kHz, compression {comp.ratio}:1 from {dbText(comp.thresholdDb)} with {dbText(comp.makeupDb)} make-up.
          </div>
        </>
      );
    } else {
      body = <DenoiseInfo project={project} track={track} amount={amount} bypassed={bypassed} amountField={pct} />;
    }
  }
  return (
    <>
      <Head title={effectName(fx.module)} sub={`on ${track.name}, slot ${index + 1} of ${count}`}>
        <OnSwitch on={!bypassed} label={effectName(fx.module)} testId="fx-bypass" disabled={!online} onChange={(on) => commit((now) => planBypassEffect(now, track.id, index, !on, fx.module))} />
      </Head>
      {body}
      <div className="fxp-foot">
        <button type="button" className="btn ghost" data-testid="fx-up" disabled={!online || index === 0} title="Earlier in the chain" onClick={() => (commit((now) => planMoveEffect(now, track.id, index, -1, fx.module)), onMoved(index - 1))}>
          ↑ Earlier
        </button>
        <button type="button" className="btn ghost" data-testid="fx-down" disabled={!online || index >= count - 1} title="Later in the chain" onClick={() => (commit((now) => planMoveEffect(now, track.id, index, 1, fx.module)), onMoved(index + 1))}>
          ↓ Later
        </button>
        <button type="button" className="btn ghost danger" data-testid="fx-remove" disabled={!online} onClick={() => (commit((now) => planRemoveEffect(now, track.id, index, fx.module)), onRemoved())}>
          Remove
        </button>
      </div>
    </>
  );
}

/** Noise removal: the floor it works from (measured or assumed) and how far it goes down. */
function DenoiseInfo({ project, track, amount, bypassed, amountField }: { project: ProjectModel; track: Track; amount: number; bypassed: boolean; amountField: React.ReactNode }) {
  const envelopes = useDuckState((s) => s.envelopes);
  const measured = track.items.some((i) => i.media && envelopes.get(i.media));
  const floor = trackNoiseFloorDb(project, track, envelopes);
  const reduction = denoiseReductionDb(amount);
  const LO = -80;
  const X = (db: number) => ((Math.max(LO, Math.min(0, db)) - LO) / -LO) * 268 + 4;
  return (
    <>
      <svg className={`fxg denoise ${bypassed ? "bypassed" : ""}`} viewBox="0 0 276 46" data-testid="fx-denoise-graph" data-floor={floor} role="img" aria-label="Noise floor and reduction">
        <rect className="fxg-meter" x={4} y={8} width={268} height={10} rx={2} />
        <rect className="fxg-noise" x={4} y={8} width={X(floor) - 4} height={10} rx={2} />
        <rect className="fxg-gr" x={Math.max(4, X(floor - reduction))} y={8} width={X(floor) - Math.max(4, X(floor - reduction))} height={10} />
        <line className="fxg-threshold" x1={X(floor)} x2={X(floor)} y1={4} y2={22} />
        <text className="fxg-tick" x={Math.min(176, X(floor) + 3)} y={34}>
          floor {dbText(floor, "dBFS")}
        </text>
        <text className="fxg-tick" x={4} y={44}>
          sound under the floor goes down by up to {Math.round(reduction)} dB
        </text>
      </svg>
      {amountField}
      <div className="muted small" data-testid="fx-denoise-floor" data-measured={measured}>
        {measured ? "The noise floor is measured from this track's sound (its quiet stretches)." : "The noise floor isn't measured yet: −40 dBFS until the track's loudness analysis is done."} Heard in the preview as in the export.
      </div>
    </>
  );
}

/** A track's effect slots (ducking has its own row) and the add menu. */
export function EffectSlots({ project, track, online }: { project: ProjectModel; track: Track; online: boolean }) {
  const [open, setOpen] = useState<{ index: number; module: string; anchor: HTMLElement } | undefined>(undefined);
  const [menu, setMenu] = useState<HTMLElement | undefined>(undefined);
  const effects = track.mixer?.effects ?? [];
  const hasCompressor = effects.some((fx) => !fx.bypass && (fx.module === COMPRESSOR || fx.module === VOICE));
  // The popover belongs to that entry: if the chain changes under it (an agent turn, an undo), it closes.
  const shownFx = open && effects[open.index]?.module === open.module ? effects[open.index] : undefined;
  // A move (↑ / ↓) follows the entry to its new place; the popover waits for that edit to land.
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    if (shownFx) setMoving(false);
    else if (open && !moving) setOpen(undefined);
  }, [open, shownFx, moving]);
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
              title={`${effectName(fx.module)}: ${effectSummary(fx)}${fx.bypass ? " (bypassed)" : ""}`}
              onClick={(e) => setOpen(open?.index === index ? undefined : { index, module: fx.module, anchor: e.currentTarget })}
            >
              <span className="fx-dot" />
              <span className="ellipsis">{effectName(fx.module)}</span>
              {fx.bypass && <span className="fx-off">off</span>}
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
              ["fx-add-audio.denoise", "Noise removal", "Takes out steady hiss and hum", (now: ProjectModel) => planAddEffect(now, track.id, DENOISE)],
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
        <Popover anchor={open.anchor} onClose={() => setOpen(undefined)} testId="fx-popover" wide>
          <EffectEditor
            project={project}
            track={track}
            index={open.index}
            fx={shownFx}
            online={online}
            onMoved={(to) => {
              setMoving(true);
              setOpen({ ...open, index: to });
            }}
            onRemoved={() => setOpen(undefined)}
          />
        </Popover>
      )}
    </div>
  );
}

/** The Duck row (D85): under which track, and the settings, in a popover; what it waits for when the key isn't measured. */
export function DuckRow({ project, track, online }: { project: ProjectModel; track: Track; online: boolean }) {
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
  const curve = curves.get(track.id);
  return (
    <div className="duck-row">
      <button type="button" className={`duck-btn ${settings && !bypassed ? "on" : ""}`} data-testid="duck-btn" data-under={settings?.under.join(",") ?? ""} data-bypass={bypassed} disabled={!online || (!keys.length && !settings)} title={note ?? (settings ? `Ducks under ${settings.under.map(name).join(", ")} by ${dbLabel(settings.amountDb)} dB` : "Duck this track while another has speech")} onClick={(e) => setAnchor(anchor ? undefined : e.currentTarget)}>
        <span className="ellipsis">{label}</span>
        {note && !bypassed && (
          <span className="duck-wait" data-testid="duck-note" title={note}>
            …
          </span>
        )}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(undefined)} testId="duck-popover" wide>
          <Head title="Ducking" sub={`${track.name} goes down while the key track has speech`}>
            {settings && <OnSwitch on={!bypassed} label="Ducking" testId="duck-on" disabled={!online} onChange={(on) => commit((now) => planBypassEffect(now, track.id, fxIndex, !on, DUCK))} />}
          </Head>
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
          {settings && <DuckGraph keys={bypassed ? [] : (curve?.keys ?? [])} frames={getPlayback().frames} amountDb={settings.amountDb} bypassed={bypassed} />}
          {settings && (
            <div className="fxp-grid">
              <Field unit="dB" label="Amount" testId="duck-amountDb" value={settings.amountDb} step={1} min={-40} max={0} disabled={!online} onCommit={(v) => commit((now) => planDuck(now, track.id, { under: settings.under, amountDb: v ?? DUCK_DEFAULTS.amountDb }))} />
              <Field unit="dB" label="Threshold" testId="duck-thresholdDb" value={settings.thresholdDb} placeholder="auto" step={1} min={-80} max={0} disabled={!online} onCommit={(v) => commit((now) => planDuck(now, track.id, { under: settings.under, thresholdDb: v ?? null }))} />
              <Field unit="ms" label="Attack" testId="duck-attackMs" value={settings.attackMs} step={50} min={0} max={2000} disabled={!online} onCommit={(v) => commit((now) => planDuck(now, track.id, { under: settings.under, attackMs: v ?? DUCK_DEFAULTS.attackMs }))} />
              <Field unit="ms" label="Release" testId="duck-releaseMs" value={settings.releaseMs} step={50} min={0} max={5000} disabled={!online} onCommit={(v) => commit((now) => planDuck(now, track.id, { under: settings.under, releaseMs: v ?? DUCK_DEFAULTS.releaseMs }))} />
            </div>
          )}
          {note ? (
            <div className="small duck-note-text" data-testid="duck-popover-note">
              {note}
            </div>
          ) : (
            settings && <div className="muted small">Down by the attack before the speech starts, back up over the release after it; the same in the preview and the export.</div>
          )}
        </Popover>
      )}
    </div>
  );
}

/** The master's limiter (on / ceiling, gain reduction) and loudness target (D86, D87), and how the preview plays it (D246). */
export function MasterControls({ project, online }: { project: ProjectModel; online: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined);
  const limiter = masterLimiter(project);
  const target = projectTargetLufs(project);
  const preset = LOUDNESS_PRESETS.find((p) => p.lufs === target);
  const loud = useLoudnessPreview();
  const fresh = loud.targetLufs === target;
  const status = !loud.atTarget
    ? "The preview plays the mix as it is; the export normalises it to the target."
    : loud.problem
      ? loud.problem
      : loud.measuring || !fresh
        ? "Measuring the mix like the export does…"
        : loud.gainDb === undefined
          ? "Nothing to normalise: the mix is silent."
          : `The mix is ${dbText(loud.lufs ?? 0, "LUFS")}: the preview plays it ${dbText(loud.gainDb)}, as the export will.`;
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
      <button type="button" className={`fx-slot target ${loud.atTarget ? "heard" : ""}`} data-testid="target-btn" data-lufs={target} title={loud.atTarget ? "Loudness target, heard in the preview" : "Loudness target: the export dialog starts from it"} onClick={(e) => setAnchor(anchor ? undefined : e.currentTarget)}>
        <span className="ellipsis">{preset ? preset.name : `${dbLabel(target)} LUFS`}</span>
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(undefined)} testId="master-popover" wide>
          <Head title="Limiter" sub="The last stage, after the master volume">
            <OnSwitch on={limiter !== undefined} label="Limiter" testId="limiter-toggle" disabled={!online} onChange={(on) => commit((now) => planMasterLimiter(now, on, masterLimiter(now)?.ceilingDb ?? LIMITER_CEILING_DB))} />
          </Head>
          <LimiterGraph ceilingDb={limiter?.ceilingDb ?? LIMITER_CEILING_DB} on={limiter !== undefined} />
          {limiter && <Field unit="dBTP" label="Ceiling" testId="limiter-ceiling" value={limiter.ceilingDb} step={0.5} min={-12} max={0} disabled={!online} onCommit={(v) => commit((now) => planMasterLimiter(now, true, v ?? LIMITER_CEILING_DB))} />}
          <div className="muted small">{limiter ? "Peaks never go over the ceiling, in the preview and the export (As mixed too)." : "Off: loud peaks can clip in the export."}</div>
          <div className="fxp-sep" />
          <Head title="Loudness target" sub="Where the export dialog starts" />
          <div className="fxp-grid">
            <label className="field">
              <select className="v" data-testid="target-select" value={preset ? String(target) : "custom"} disabled={!online} onChange={(e) => e.target.value !== "custom" && commit((now) => planLoudnessTarget(now, Number(e.target.value)))}>
                {LOUDNESS_PRESETS.map((p) => (
                  <option key={p.id} value={String(p.lufs)}>
                    {p.name} ({dbLabel(p.lufs)} LUFS)
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            </label>
            <Field unit="LUFS" label="Target" testId="target-lufs" value={target} step={1} min={-30} max={-5} disabled={!online} onCommit={(v) => commit((now) => planLoudnessTarget(now, v ?? -14))} />
          </div>
          <div className="fxp-seg" role="radiogroup" aria-label="The preview plays">
            <span className="muted small">Preview</span>
            <button type="button" role="radio" aria-checked={!loud.atTarget} className={!loud.atTarget ? "on" : ""} data-testid="preview-loudness-mixed" onClick={() => setPreviewAtTarget(false)}>
              As mixed
            </button>
            <button type="button" role="radio" aria-checked={loud.atTarget} className={loud.atTarget ? "on" : ""} data-testid="preview-loudness-target" disabled={!online} onClick={() => setPreviewAtTarget(true)}>
              At target
            </button>
          </div>
          <div className="muted small" data-testid="preview-loudness-status" data-measuring={loud.atTarget && (loud.measuring || !fresh)} data-gain={loud.atTarget && fresh && loud.gainDb !== undefined ? loud.gainDb : ""} data-lufs={loud.lufs ?? ""}>
            {status}
          </div>
        </Popover>
      )}
    </div>
  );
}

