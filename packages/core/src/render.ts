// Shared by the preview and export: the one place text and backgrounds are turned into HTML, so
// an exported frame shows exactly what the editor showed (D39). Everything that decides how an
// item looks is inline on its element; RENDER_CSS holds only the few rules both need, and both
// inject it as is.
import type { Canvas, Item, Project } from "./types.ts";

const ENTITIES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, (c) => ENTITIES[c]!);

type Theme = NonNullable<Project["theme"]>;
/**
 * What the renderer needs of a project: its canvas and its theme (optional in the format), and how
 * a component's `{ media }` reference becomes an image URL there (D76): the preview's
 * /media/file URL, the export's data: URL. Without it, media references draw nothing.
 */
export type RenderTarget = {
  readonly canvas: Pick<Canvas, "width" | "height" | "background">;
  readonly theme?: Theme | undefined;
  readonly mediaUrl?: ((mediaId: string) => string | undefined) | undefined;
};

/**
 * The theme a project without one (or without some tokens) falls back to. New projects have no
 * theme, so these tokens are what "fg", "bg" and "accent" mean there; a project's own theme wins.
 */
export const DEFAULT_THEME = {
  colors: { bg: "#0A0A0B", fg: "#F2F1EE", mute: "#8C8C91", accent: "#99DAFF" },
  fonts: { sans: "", mono: "" },
} as const;

/** The system font stacks the preview and export both use when a theme names no font. */
const SANS = `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Helvetica Neue", sans-serif`;
const MONO = `"SF Mono", ui-monospace, Menlo, monospace`;

/**
 * The fonts Uncut bundles (D77, SIL OFL 1.1, assets/fonts/OFL.txt): DM Sans (variable, weights
 * 100–1000) and DM Mono 400 / 500. The preview and the export rasteriser both load them from data:
 * URLs with the same @font-face rules (fontFaceCss), so text measures the same in both. Text items
 * use them by name (style.font "DM Sans"); components use them by default.
 */
export const FONT_FACES = [
  { family: "DM Sans", file: "DMSans-Variable.woff2", weight: "100 1000" },
  { family: "DM Mono", file: "DMMono-Regular.woff2", weight: "400" },
  { family: "DM Mono", file: "DMMono-Medium.woff2", weight: "500" },
] as const;
export type FontFile = (typeof FONT_FACES)[number]["file"];

/** @font-face rules for the bundled fonts, given each file's URL (no font-display: they block until loaded). */
export const fontFaceCss = (url: (file: FontFile) => string) =>
  FONT_FACES.map((f) => `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};src:url(${url(f.file)}) format("woff2")}`).join("\n");

/** The bundled fonts' stacks (components draw with these; D77). */
export const DM_SANS = `'DM Sans', ${SANS.replace(/"/g, "'")}`;
export const DM_MONO = `'DM Mono', ${MONO.replace(/"/g, "'")}`;

/** Theme colours by token: the project's own over the defaults. */
export function themeColors(target: Pick<RenderTarget, "theme">): Record<string, string> {
  return { ...DEFAULT_THEME.colors, ...(target.theme?.colors ?? {}) };
}

// A colour or font name goes inside a style attribute (and a solid's background): only plain
// colour syntax is accepted, so nothing can end the declaration or smuggle in an image (url(),
// image-set(), var(), several layers). Anything else falls back.
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,30}|(rgba?|hsla?)\(\s*-?[\d.]+(deg|%)?(\s*[,\s/]\s*-?[\d.]+%?){2,3}\s*\))$/i;
const SAFE_FONT = /^[a-zA-Z0-9 _-]+$/;

/** A theme token ("fg") or a CSS colour as a CSS colour; `fallback` for anything unusable. */
export function resolveColor(target: Pick<RenderTarget, "theme">, value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const token = themeColors(target)[value];
  const color = token ?? value;
  return SAFE_COLOR.test(color) ? color : fallback;
}

/** A font token ("sans", "mono") or a family name as a CSS font-family list. */
export function resolveFont(target: Pick<RenderTarget, "theme">, value: unknown): string {
  const fonts: Record<string, string> = { ...(target.theme?.fonts ?? {}) };
  const name = typeof value === "string" && value ? value : "sans";
  const family = fonts[name] ?? (name === "sans" || name === "mono" ? "" : name);
  const stack = name === "mono" ? MONO : SANS;
  return family && SAFE_FONT.test(family) ? `"${family}", ${stack}` : stack;
}

/**
 * How each built-in text style (spec/modules/builtin/text.*.json) looks: the defaults a text item
 * with that preset gets when it's added or restyled, and the fallbacks for the fields it doesn't
 * set. Sizes and positions are fractions of the canvas height/width, so they fit any canvas.
 */
export interface TextLook {
  readonly name: string;
  readonly size: number;
  readonly weight: number;
  readonly font: "sans" | "mono";
  readonly tracking: number;
  readonly lineHeight: number;
  readonly color: string;
  readonly align?: "left" | "center" | "right";
  readonly x: number;
  readonly y: number;
}
export const TEXT_STYLES: Readonly<Record<string, TextLook>> = {
  "text.title": { name: "Title", size: 0.12, weight: 700, font: "sans", tracking: -0.02, lineHeight: 1.05, color: "fg", x: 0.08, y: 0.38 },
  "text.header": { name: "Header", size: 0.06, weight: 500, font: "sans", tracking: -0.02, lineHeight: 1.1, color: "fg", x: 0.08, y: 0.46 },
  "text.lower-third": { name: "Lower third", size: 0.05, weight: 600, font: "sans", tracking: -0.01, lineHeight: 1.1, color: "fg", x: 0.0625, y: 0.8 },
  "text.footnote": { name: "Footnote", size: 0.03, weight: 400, font: "sans", tracking: 0, lineHeight: 1.25, color: "mute", x: 0.0625, y: 0.9 },
  "text.mono-label": { name: "Mono label", size: 0.035, weight: 500, font: "mono", tracking: 0, lineHeight: 1.2, color: "fg", x: 0.0625, y: 0.1 },
  "text.captions": { name: "Captions", size: 0.05, weight: 600, font: "sans", tracking: -0.01, lineHeight: 1.15, color: "fg", align: "center", x: 0.1, y: 0.78 },
};
/** Fallbacks for a text item with no preset (or one that isn't built in). */
const PLAIN: TextLook = { name: "Text", size: 0.08, weight: 600, font: "sans", tracking: -0.02, lineHeight: 1.05, color: "fg", x: 0.08, y: 0.42 };
export const textLook = (preset: unknown): TextLook => (typeof preset === "string" && TEXT_STYLES[preset]) || PLAIN;

/** The safe margin in canvas pixels: the theme's, else 1/15 of the shorter side (72 px at 1080p). */
export const safeMargin = (target: RenderTarget) => target.theme?.margin ?? Math.round(Math.min(target.canvas.width, target.canvas.height) / 15);

/** The project's canvas colour, shown where nothing is drawn (black by default). */
export const canvasBackground = (target: RenderTarget) => resolveColor(target, target.canvas.background, "#000");

/** Rules the preview and export inject; everything per item is inline. */
export const RENDER_CSS = [
  ".pv-text{position:absolute;white-space:pre-wrap;overflow-wrap:break-word;text-shadow:0 2px 18px rgb(0 0 0 / 45%);cursor:default;user-select:none;box-sizing:border-box}",
  ".pv-text .accent{color:var(--accent)}",
  ".pv-text b{font-weight:800}",
  ".pv-text code{font-family:var(--mono);font-size:0.9em}",
  ".pv-solid{position:absolute;inset:0}",
  ".pv-comp{position:absolute;box-sizing:border-box;user-select:none;cursor:default}",
  ".pv-comp *{box-sizing:border-box}",
  ".pv-comp .accent{color:var(--accent)}",
  ".pv-comp b{font-weight:800}",
].join("\n");

/** Markup → HTML, after escaping: [[accent]], **bold**, `mono`. */
export const markup = (text: string) =>
  esc(text)
    .replace(/\[\[(.*?)\]\]/gs, '<span class="accent">$1</span>')
    .replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

/** An item's motion at one frame (core visualsAt computes it from its animation). */
export interface Motion {
  /** Offset in canvas pixels. */
  readonly dx?: number;
  readonly dy?: number;
  /** How much of a wipe is revealed, 0–1 (1 = all of it). */
  readonly reveal?: number;
}

export const num = (n: number) => String(Math.round(n * 10000) / 10000);

/**
 * A text item as HTML. transform (x, y) is the box's top-left corner and transform.w its width in
 * canvas pixels (no w: as wide as its longest line, wrapping at the canvas edge); style.align
 * aligns the lines inside the box. A text item without transform or size (the format allows it,
 * and the agent can write one) falls back to its preset's look instead of breaking the preview.
 */
export function textHtml(item: Item, target: RenderTarget, { opacity = 1, selected = false, motion }: { opacity?: number; selected?: boolean; motion?: Motion } = {}): string {
  const { width, height } = target.canvas;
  const look = textLook(item.style?.preset);
  const s = item.style ?? {};
  const x = item.transform?.x ?? width * look.x;
  const y = item.transform?.y ?? height * look.y;
  const w = item.transform?.w;
  const size = s.size ?? height * look.size;
  const css = [
    `left:${num((x / width) * 100)}%`,
    `top:${num((y / height) * 100)}%`,
    w && w > 0 ? `width:${num((w / width) * 100)}%` : `width:max-content;max-width:${num(Math.max(5, 100 - (x / width) * 100))}%`,
    `font-size:${num((size / height) * 100)}cqh`,
    `font-weight:${s.weight ?? look.weight}`,
    `font-family:${resolveFont(target, s.font ?? look.font).replace(/"/g, "'")}`,
    `letter-spacing:${num(s.tracking ?? look.tracking)}em`,
    `line-height:${num(s.lineHeight ?? look.lineHeight)}`,
    `color:${resolveColor(target, s.color ?? look.color, DEFAULT_THEME.colors.fg)}`,
    `text-align:${s.align ?? look.align ?? "left"}`,
    `--accent:${resolveColor(target, "accent", DEFAULT_THEME.colors.accent)}`,
    `--mono:${resolveFont(target, "mono").replace(/"/g, "'")}`,
    `opacity:${num(opacity)}`,
  ];
  if (motion?.dx || motion?.dy) css.push(`transform:translate(${num(((motion.dx ?? 0) / width) * 100)}cqw,${num(((motion.dy ?? 0) / height) * 100)}cqh)`);
  if (motion?.reveal !== undefined && motion.reveal < 1) css.push(`clip-path:inset(-20% ${num((1 - motion.reveal) * 100)}% -20% -5%)`);
  return `<div class="pv-text${selected ? " sel-box" : ""}" data-item="${esc(item.id)}" style="${css.join(";")}">${markup(item.text ?? "")}</div>`;
}

/** The built-in full-frame background (component.solid): a colour, or a gradient to `to`. */
export const SOLID = "component.solid";

/** A component.solid's CSS background: props.color, or a linear gradient to props.to at props.angle. */
export function solidBackground(item: Item, target: Pick<RenderTarget, "theme">): string {
  const props = item.props ?? {};
  const from = resolveColor(target, props.color, DEFAULT_THEME.colors.bg);
  if (props.to === undefined) return from;
  const to = resolveColor(target, props.to, from);
  const angle = typeof props.angle === "number" && Number.isFinite(props.angle) ? props.angle : 180;
  return `linear-gradient(${num(angle)}deg, ${from}, ${to})`;
}

/** A component.solid as HTML (export draws it like this; the preview sets the same background). */
export function solidHtml(item: Item, target: RenderTarget, { opacity = 1 }: { opacity?: number } = {}): string {
  return `<div class="pv-solid" data-item="${esc(item.id)}" style="background:${solidBackground(item, target)};opacity:${num(opacity)}"></div>`;
}
