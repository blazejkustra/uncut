import type { Item, MediaProbe, ModuleUse } from "../../timeline/types.ts";
import { baseBox } from "../box.ts";
import { SHADER } from "../shaders.ts";
import { fxSkips } from "./clipFx.ts";
import {
  type LookDef,
  LOOK,
  lookInfo,
  num,
  type AdjustKey,
  ADJUST,
  adjustOf,
  NO_ADJUST,
  ADJUST_KEYS,
  ADJUST_INFO,
  effectInfo,
  effectParams,
  effectOptions,
  MASK,
} from "./defs.ts";

// ---- edits ----

type Plan =
  | { readonly ops: ReadonlyArray<{ op: "update_item"; item: string; set: Record<string, unknown> }>; readonly summary: string }
  | { readonly problem: string };

interface Target {
  readonly luts?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The canvas, for a new mask's default shape (D326); without it the mask covers the box. */
  readonly canvas?: { readonly width: number; readonly height: number };
  readonly tracks: ReadonlyArray<{
    readonly kind: string;
    readonly locked?: boolean;
    readonly items: ReadonlyArray<Pick<Item, "id" | "type" | "effects" | "media" | "locked" | "name" | "transform">>;
  }>;
  readonly media?: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly name?: string;
    readonly path?: string;
    readonly probe?: Pick<MediaProbe, "width" | "height">;
  }>;
}

type ClipOf = { item: Pick<Item, "id" | "type" | "effects" | "name" | "transform">; name: string; probe?: Pick<MediaProbe, "width" | "height"> | undefined };

function clipOf(project: Target, id: string): ClipOf | { problem: string } {
  for (const t of project.tracks)
    for (const it of t.items) {
      if (it.id !== id) continue;
      const media = it.media ? project.media?.find((m) => m.id === it.media) : undefined;
      if (it.type !== "clip" || !media || media.kind === "audio") return { problem: "Effects go on video clips and stills." };
      // SVG stills are drawn by Chromium in the export, not decoded: looks and effects don't apply to them (D138).
      if (fxSkips(media)) return { problem: "Looks and effects don't apply to SVG images." };
      if (t.locked || it.locked) return { problem: "That clip is locked: unlock it to change its effects." };
      return { item: it, name: it.name ?? media.name ?? it.id, probe: media.probe };
    }
  return { problem: "Pick a clip first." };
}

const setEffects = (id: string, list: ReadonlyArray<ModuleUse>, summary: string): Plan => ({
  ops: [{ op: "update_item", item: id, set: { effects: list.length ? list : null } }],
  summary,
});
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Give a clip a look (one look per clip: it replaces the one it had), or with undefined take it off. */
export function planSetLook(
  project: Target,
  itemId: string,
  look: string | undefined,
  opts: { intensity?: number; custom?: LookDef; label?: string } = {},
): Plan {
  const c = clipOf(project, itemId);
  if ("problem" in c) return c;
  const list = [...(c.item.effects ?? [])];
  const at = list.findIndex((e) => e.module === LOOK);
  if (look === undefined) {
    if (at < 0) return { problem: "That clip has no filter." };
    list.splice(at, 1);
    return setEffects(itemId, list, `Remove the filter from ${c.name}`);
  }
  const info = lookInfo(look);
  const lut = project.luts?.find((l) => l.id === look);
  if (!info && !opts.custom && !lut) return { problem: `There's no filter called ${look}.` };
  const before = at >= 0 ? ((list[at]!.params ?? {}) as Record<string, unknown>) : undefined;
  const intensity = num(opts.intensity ?? (before?.look === look ? before?.intensity : undefined), 0, 1, 1);
  const params: Record<string, unknown> = {
    look,
    intensity: Math.round(intensity * 100) / 100,
    ...(opts.custom ? { custom: opts.custom, label: opts.label ?? look } : {}),
    ...(lut ? { label: lut.name } : {}),
  };
  // An off filter (bypass, F18) stays off while its intensity changes; a new filter is on.
  const entry = { module: LOOK, params, ...(at >= 0 && list[at]!.bypass && before?.look === look ? { bypass: true } : {}) };
  if (at >= 0) list[at] = entry;
  else list.unshift(entry);
  const name = info?.name ?? lut?.name ?? opts.label ?? look;
  return setEffects(
    itemId,
    list,
    opts.intensity !== undefined && before?.look === look ? `Set ${name} on ${c.name} to ${pct(intensity)}` : `Filter ${name} on ${c.name}`,
  );
}

/** Change a clip's Adjust (a patch of its values; 0 is neutral); an all-neutral Adjust is removed. */
export function planAdjust(project: Target, itemId: string, patch: Partial<Record<AdjustKey, number>> | "reset"): Plan {
  const c = clipOf(project, itemId);
  if ("problem" in c) return c;
  const list = [...(c.item.effects ?? [])];
  const at = list.findIndex((e) => e.module === ADJUST);
  const before = at >= 0 ? adjustOf(list[at]!.params) : NO_ADJUST;
  const next = patch === "reset" ? NO_ADJUST : adjustOf({ ...before, ...patch });
  const params: Record<string, number> = {};
  for (const k of ADJUST_KEYS) if (next[k] !== 0) params[k] = Math.round(next[k] * 1000) / 1000;
  // Other params the entry had (an older project's) are kept on a reset only if they're not Adjust's.
  if (Object.keys(params).length) {
    const entry = { module: ADJUST, params, ...(at >= 0 && list[at]!.bypass ? { bypass: true } : {}) };
    if (at >= 0) list[at] = entry;
    else list.push(entry);
  } else if (at >= 0) list.splice(at, 1);
  else return { problem: "Nothing to reset." };
  const keys = patch === "reset" ? [] : (Object.keys(patch) as Array<AdjustKey>);
  const info = keys.length === 1 ? ADJUST_INFO.find((a) => a.key === keys[0]) : undefined;
  const summary =
    patch === "reset"
      ? `Reset the adjustments of ${c.name}`
      : info
        ? `Set ${info.name.toLowerCase()} of ${c.name} to ${adjustWord(info.key, next[info.key])}`
        : `Adjust ${c.name}`;
  return setEffects(itemId, list, summary);
}

/** An Adjust value as the Inspector shows it: stops for exposure, −100 to 100 for the rest. */
export const adjustWord = (key: AdjustKey, v: number) =>
  key === "exposure" ? `${v > 0 ? "+" : ""}${Math.round(v * 100) / 100} EV` : `${v > 0 ? "+" : ""}${Math.round(v * 100)}`;

type EffectValues = Record<string, number | string | boolean>;

/** A new mask's shape (D326): the middle 60 % of the clip's box, whole canvas px. */
function defaultMask(project: Target, c: ClipOf): EffectValues {
  if (!project.canvas) return {};
  const box = baseBox(c.item, project.canvas, c.probe);
  return { x: Math.round(box.w * 0.2), y: Math.round(box.h * 0.2), w: Math.round(box.w * 0.6), h: Math.round(box.h * 0.6) };
}

/** An entry's params as written: its options and numbers with defaults filled in and clamped. */
const effectValues = (module: string, params: unknown): EffectValues => ({ ...effectOptions(module, params), ...effectParams(module, params) });

function valueWord(info: NonNullable<ReturnType<typeof effectInfo>>, key: string, v: number | string | boolean): string | undefined {
  const option = info.options?.find((o) => o.key === key);
  if (option?.kind === "choice") return option.choices.find((c) => c.id === v)?.name.toLowerCase();
  if (option) return typeof v === "boolean" ? (v ? "on" : "off") : String(v);
  const p = info.params.find((d) => d.key === key);
  return p && typeof v === "number" ? `${Math.round(v * 100) / 100}${p.unit ? ` ${p.unit}` : ""}` : undefined;
}

/** Add an effect to a clip (with its defaults), or with `params` change the one it has. */
export function planEffect(project: Target, itemId: string, module: string, params?: EffectValues): Plan {
  const c = clipOf(project, itemId);
  const info = effectInfo(module);
  if (!info) return { problem: `There's no effect called ${module}.` };
  if ("problem" in c) return c;
  const list = [...(c.item.effects ?? [])];
  const at = list.findIndex((e) => e.module === module);
  const base = at >= 0 ? effectValues(module, list[at]!.params) : effectValues(module, module === MASK ? defaultMask(project, c) : {});
  const next = effectValues(module, { ...base, ...params });
  const hasParams = info.params.length > 0 || (info.options?.length ?? 0) > 0;
  const entry = { module, ...(hasParams ? { params: next } : {}), ...(at >= 0 && list[at]!.bypass ? { bypass: true } : {}) };
  if (at >= 0) {
    if (!params) return { problem: `${c.name} already has ${info.name.toLowerCase()}.` };
    list[at] = entry;
    const keys = Object.keys(params);
    const name = keys.length === 1 ? (info.params.find((d) => d.key === keys[0])?.name ?? info.options?.find((o) => o.key === keys[0])?.name) : undefined;
    const word = keys.length === 1 ? valueWord(info, keys[0]!, next[keys[0]!]!) : undefined;
    return setEffects(
      itemId,
      list,
      name && word ? `Set ${info.name.toLowerCase()} ${name.toLowerCase()} on ${c.name} to ${word}` : `Change ${info.name.toLowerCase()} on ${c.name}`,
    );
  }
  list.push(entry);
  return setEffects(itemId, list, `Add ${info.name.toLowerCase()} to ${c.name}`);
}

/** Take an effect (or the look, or Adjust) off a clip. */
export function planRemoveEffect(project: Target, itemId: string, module: string): Plan {
  const c = clipOf(project, itemId);
  if ("problem" in c) return c;
  const list = (c.item.effects ?? []).filter((e) => e.module !== module);
  if (list.length === (c.item.effects ?? []).length) return { problem: "That clip doesn't have it." };
  const name =
    module === LOOK
      ? "the filter"
      : module === ADJUST
        ? "the adjustments"
        : module === SHADER
          ? "the shader effect"
          : (effectInfo(module)?.name.toLowerCase() ?? module);
  return setEffects(itemId, list, `Remove ${name} from ${c.name}`);
}

/**
 * Turn one of a clip's effects (or its filter, or Adjust) off or on (F18): an off entry keeps its
 * place and settings (`bypass`, as the mixer's audio effects) and isn't drawn by the preview or the
 * export (clipFx skips it).
 */
export function planEffectBypass(project: Target, itemId: string, module: string, on: boolean): Plan {
  const c = clipOf(project, itemId);
  if ("problem" in c) return c;
  const list = [...(c.item.effects ?? [])];
  const at = list.findIndex((e) => e.module === module);
  if (at < 0) return { problem: "That clip doesn't have it." };
  if (!list[at]!.bypass === on) return { problem: on ? "It's already on." : "It's already off." };
  const { bypass: _, ...rest } = list[at]!;
  list[at] = on ? rest : { ...rest, bypass: true };
  const name =
    module === LOOK
      ? "the filter"
      : module === ADJUST
        ? "the adjustments"
        : module === SHADER
          ? "the shader effect"
          : (effectInfo(module)?.name.toLowerCase() ?? module);
  return setEffects(itemId, list, `Turn ${name} on ${c.name} ${on ? "on" : "off"}`);
}

/** A clip's effects in words (History, D136): "filter Warm 80%, exposure +0.3 EV, blur 8 px". */
export function fxWords(effects: unknown): string {
  const list = Array.isArray(effects) ? (effects as ReadonlyArray<ModuleUse>) : [];
  if (!list.length) return "no effects";
  return list
    .map((e) => {
      if (e.module === LOOK) {
        const p = (e.params ?? {}) as Record<string, unknown>;
        const name = typeof p.label === "string" ? p.label : (lookInfo(String(p.look))?.name ?? String(p.look));
        return `filter ${name} ${pct(num(p.intensity, 0, 1, 1))}${e.bypass ? " (off)" : ""}`;
      }
      if (e.module === ADJUST) {
        const a = adjustOf(e.params);
        const parts = ADJUST_INFO.filter((i) => a[i.key] !== 0).map((i) => `${i.name.toLowerCase()} ${adjustWord(i.key, a[i.key])}`);
        return (parts.length ? parts.join(", ") : "no adjustments") + (e.bypass ? " (off)" : "");
      }
      if (e.module === SHADER) {
        const p = (e.params ?? {}) as Record<string, unknown>;
        return `shader ${typeof p.name === "string" ? p.name : String(p.shader)}${e.bypass ? " (off)" : ""}`;
      }
      const info = effectInfo(e.module);
      if (!info) return e.module;
      const v = effectValues(e.module, e.params);
      const first = info.options?.[0] ?? info.params[0];
      const word = first ? valueWord(info, first.key, v[first.key]!) : undefined;
      return `${info.name.toLowerCase()}${word ? ` ${word}` : ""}${e.bypass ? " (off)" : ""}`;
    })
    .join(", ");
}
