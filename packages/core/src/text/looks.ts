// Text looks (D80): how each built-in text style (spec/modules/builtin/text.*.json) looks, read from
// the manifests' `look` block, so the validator, the renderer's Text tab and Inspector, the agent's
// modules_list and textHtml all read one definition. Before D80 these numbers lived in core
// TEXT_STYLES (D53); the six styles from then keep their values and their soft shadow
// (legacyShadow), so projects made before look the same.
//
// Browser-safe: the manifests are imported as JSON (as components.ts does). test/core/text-looks.test.ts
// keeps TEXT_STYLES equal to the built-in text-style manifests and checks every look validates.
import titleJson from "../../../../spec/modules/builtin/text.title.json" with { type: "json" };
import headerJson from "../../../../spec/modules/builtin/text.header.json" with { type: "json" };
import lowerThirdJson from "../../../../spec/modules/builtin/text.lower-third.json" with { type: "json" };
import footnoteJson from "../../../../spec/modules/builtin/text.footnote.json" with { type: "json" };
import monoLabelJson from "../../../../spec/modules/builtin/text.mono-label.json" with { type: "json" };
import captionsJson from "../../../../spec/modules/builtin/text.captions.json" with { type: "json" };
import bigTitleJson from "../../../../spec/modules/builtin/text.big-title.json" with { type: "json" };
import kickerTitleJson from "../../../../spec/modules/builtin/text.kicker-title.json" with { type: "json" };
import kickerJson from "../../../../spec/modules/builtin/text.kicker.json" with { type: "json" };
import highlightJson from "../../../../spec/modules/builtin/text.highlight.json" with { type: "json" };
import captionJson from "../../../../spec/modules/builtin/text.caption.json" with { type: "json" };
import strokeTitleJson from "../../../../spec/modules/builtin/text.stroke-title.json" with { type: "json" };
import outlineJson from "../../../../spec/modules/builtin/text.outline.json" with { type: "json" };
import boxedLabelJson from "../../../../spec/modules/builtin/text.boxed-label.json" with { type: "json" };
import quoteJson from "../../../../spec/modules/builtin/text.quote.json" with { type: "json" };
import chapterJson from "../../../../spec/modules/builtin/text.chapter.json" with { type: "json" };
import wordByWordJson from "../../../../spec/modules/builtin/move.word-by-word.json" with { type: "json" };
import zoomJson from "../../../../spec/modules/builtin/move.zoom.json" with { type: "json" };

/** A look's stroke: width in em of the font size. */
export interface LookStroke {
  readonly width: number;
  readonly color?: string;
}
/** A look's shadow: offsets and blur in em of the font size. */
export interface LookShadow {
  readonly x?: number;
  readonly y?: number;
  readonly blur?: number;
  readonly color?: string;
  readonly opacity?: number;
}
/** A look's background box: padding and radius in em of the font size. */
export interface LookBackground {
  readonly color: string;
  readonly opacity?: number;
  readonly padding?: number;
  readonly radius?: number;
  readonly wrap?: "box" | "lines";
}
export interface LookMove {
  readonly module: string;
  readonly seconds: number;
  readonly params?: { readonly [key: string]: unknown };
}

/**
 * How a text style looks (module.schema.json $defs/look). size and y are shares of the canvas
 * height, x and w of its width; stroke, shadow and background lengths are em of the font size.
 */
export interface TextLook {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly size: number;
  readonly weight: number;
  readonly font: string;
  readonly tracking: number;
  readonly lineHeight: number;
  readonly color: string;
  readonly align?: "left" | "center" | "right";
  readonly uppercase?: boolean;
  readonly x: number;
  readonly y: number;
  readonly w?: number;
  readonly span?: boolean;
  readonly stroke?: LookStroke;
  readonly shadow?: LookShadow;
  readonly legacyShadow?: boolean;
  readonly background?: LookBackground;
  readonly text: string;
  readonly animation?: { readonly in?: LookMove; readonly out?: LookMove };
  readonly with?: ReadonlyArray<{ readonly look: string; readonly text: string; readonly dy?: number }>;
}

type LookManifest = { readonly id: string; readonly name: string; readonly description?: string; readonly look: Omit<TextLook, "id" | "name" | "description" | "font" | "tracking" | "lineHeight" | "color" | "text"> & Partial<Pick<TextLook, "font" | "tracking" | "lineHeight" | "color" | "text">> };

const lookOf = (json: unknown): TextLook => {
  const m = json as LookManifest;
  return { font: "sans", tracking: 0, lineHeight: 1.1, color: "fg", text: m.name, ...m.look, id: m.id, name: m.name, description: m.description ?? "" } as TextLook;
};

/**
 * Every built-in look by module id, in the Inspector's order: the six from before D80 first, then
 * the curated ones (D80).
 */
export const TEXT_STYLES: Readonly<Record<string, TextLook>> = Object.fromEntries(
  [titleJson, headerJson, lowerThirdJson, footnoteJson, monoLabelJson, captionsJson, bigTitleJson, kickerTitleJson, kickerJson, highlightJson, captionJson, strokeTitleJson, outlineJson, boxedLabelJson, quoteJson, chapterJson].map((j) => {
    const look = lookOf(j);
    return [look.id, look];
  }),
);

/** The looks from before D80: they keep the soft shadow every text had then. */
export const LEGACY_LOOKS = Object.values(TEXT_STYLES).filter((l) => l.legacyShadow).map((l) => l.id);

/** Fallbacks for a text item with no preset (or one that isn't built in): as before D80, with the soft shadow. */
export const PLAIN_LOOK: TextLook = { id: "", name: "Text", description: "", size: 0.08, weight: 600, font: "sans", tracking: -0.02, lineHeight: 1.05, color: "fg", x: 0.08, y: 0.42, legacyShadow: true, text: "Text" };

export const textLook = (preset: unknown): TextLook => (typeof preset === "string" && TEXT_STYLES[preset]) || PLAIN_LOOK;

/**
 * The Text tab's grid (D80): the three tiles from before (same ids, so "title" still adds a
 * text.title), then the curated looks. Each tile adds its look (and the looks in its `with`).
 */
export const TEXT_PRESETS = [
  { id: "title", module: "text.title", label: "Title", text: "Title" },
  { id: "text", module: "text.header", label: "Text", text: "Text" },
  { id: "lower-third", module: "text.lower-third", label: "Lower third", text: "Lower third" },
  ...["text.big-title", "text.kicker-title", "text.highlight", "text.caption", "text.stroke-title", "text.outline", "text.boxed-label", "text.quote", "text.chapter"].map((module) => {
    const look = TEXT_STYLES[module]!;
    return { id: module.replace(/^text\./, ""), module, label: look.name, text: look.text };
  }),
] as const satisfies ReadonlyArray<{ id: string; module: string; label: string; text: string }>;
export type TextPreset = { readonly id: string; readonly module: string; readonly label: string; readonly text: string };

// ---- text moves (D81) ----

export const WORD_BY_WORD = "move.word-by-word";
export const ZOOM_MOVE = "move.zoom";
export type WordStyle = "pop" | "fade" | "rise";
export const WORD_STYLES: ReadonlyArray<WordStyle> = (wordByWordJson as { params: { properties: { style: { enum: Array<WordStyle> } } } }).params.properties.style.enum;
const zoomParams = (zoomJson as { params: { properties: { scale: { default: number }; ease: { default: string } } } }).params.properties;
/** move.zoom's defaults (its manifest's): the scale it starts from (in) or ends at (out), and the ease. */
export const ZOOM_DEFAULTS = { scale: zoomParams.scale.default, ease: zoomParams.ease.default as "linear" | "in" | "out" | "inOut" };
