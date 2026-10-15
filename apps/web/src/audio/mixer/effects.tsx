import { useState, useEffect } from "react";
import { duckSettings, duckNote, DUCK_DEFAULTS } from "@uncut/core/ducking";
import { EQ, COMPRESSOR, VOICE, DENOISE, eqParams, compressorParams, amountOf, DUCK, effectName, effectSummary, EXPORT_ONLY_EFFECTS, masterLimiter, projectTargetLufs, LOUDNESS_PRESETS, LIMITER_CEILING_DB } from "@uncut/core/effects";
import type { ModuleUse } from "@uncut/core/types";
import { planAddEffect, planVoicePreset, planMoveEffect, planBypassEffect, planRemoveEffect, planEffectParams, soundTrack, dbLabel, planDuck, planMasterLimiter, planLoudnessTarget } from "../sound.ts";
import type { ProjectModel, Track } from "../../state/project.ts";
import { useDuckCurves, useDuckState } from "../ducking.ts";
import { NumberField } from "../../inspector/fields.tsx";
import { Popover, commit } from "./controls.tsx";

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
export function EffectSlots({ project, track, online }: { project: ProjectModel; track: Track; online: boolean }) {
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
export function MasterControls({ project, online }: { project: ProjectModel; online: boolean }) {
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
