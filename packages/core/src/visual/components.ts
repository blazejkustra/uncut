// Components (D76): html modules drawn from their manifests (spec/modules/builtin/component.*.json)
// by one pure function, componentHtml(item, target, localFrame), shared by the preview (which puts
// the HTML on the canvas), the export (which has Chromium rasterise it: one PNG per distinct look)
// and the agent's frame renders. So preview == export by construction, as for text (D39).
//
// A component draws in a box like a clip (D75, box.ts): transform {x, y, w, h} in canvas pixels,
// opacity, x / y / opacity / scale keys. No w and h = the manifest's default size (component.size,
// canvas pixels on a canvas whose shorter side is 1080, scaled to the project's), centred; a
// fullFrame component fills the canvas. The body is laid out at the box's size in canvas pixels, so
// resizing the box re-lays it out (text sizes follow the box). scale zooms the whole box about its
// centre (not clipped).
//
// Browser-safe (no node:fs): the manifests are imported as JSON, so the renderer's Inspector reads
// the same params schema the validator checks props against. test/core/components.test.ts keeps the
// registry and the manifests in step: every renderer has a manifest, every built-in component
// manifest is either drawn here or listed in UNDRAWN_COMPONENTS, defaults validate.
//
// Media inside a component (the end card's logo) is a `{ media }` prop; target.mediaUrl turns it
// into a URL (the preview's /media/file URL; the export's data: URL). Footage never goes inside a
// component: a device frame is a bezel with a transparent screen over a separate clip (planDeviceFrame).
import deviceFrameJson from "../../../../spec/modules/builtin/component.device-frame.json" with { type: "json" };
import endCardJson from "../../../../spec/modules/builtin/component.end-card.json" with { type: "json" };
import codeBlockJson from "../../../../spec/modules/builtin/component.code-block.json" with { type: "json" };
import chartJson from "../../../../spec/modules/builtin/component.chart.json" with { type: "json" };
import terminalJson from "../../../../spec/modules/builtin/component.terminal.json" with { type: "json" };
import agentLogJson from "../../../../spec/modules/builtin/component.agent-log.json" with { type: "json" };
import compareTableJson from "../../../../spec/modules/builtin/component.compare-table.json" with { type: "json" };

import { calloutJson, countdownJson, drawCallout, drawCountdown, drawImageFrame, drawLowerThird, drawProgressBar, drawShape, drawSticker, drawSubscribe, imageFrameJson, lowerThirdJson, progressBarJson, shapeJson, stickerJson, subscribeJson } from "./elements.ts";
import { baseBox, clipBox, EASES, type ClipBox, type Rect } from "./box.ts";
import { DEFAULT_THEME, DM_MONO, DM_SANS, esc, markup, num, resolveColor, safeMargin, SOLID, type Motion, type RenderTarget } from "./render.ts";
import type { Canvas, FieldSet, Item, Media, ModuleManifest, Op, Project, Track } from "../timeline/types.ts";

/** A component's placement block (module.schema.json `component`). */
export interface ComponentBlock {
  readonly size: { readonly width: number; readonly height: number };
  readonly fullFrame?: boolean;
  readonly animated?: boolean;
  readonly defaults?: { readonly [key: string]: unknown };
  readonly screens?: { readonly [device: string]: { readonly size: { readonly width: number; readonly height: number }; readonly screen: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly radius?: number } } };
}

/** What a renderer gets: the item's props, its box size (canvas px), the local frame and the target. */
export interface Draw {
  readonly item: Item;
  readonly props: { readonly [key: string]: unknown };
  readonly w: number;
  readonly h: number;
  readonly local: number;
  readonly fps: number;
  readonly target: RenderTarget;
}

export interface ComponentInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly manifest: ModuleManifest & { readonly component: ComponentBlock };
  readonly block: ComponentBlock;
  /** JSON Schema of the props (the manifest's params). */
  readonly params: { readonly properties?: { readonly [key: string]: unknown }; readonly required?: ReadonlyArray<string> };
  readonly render: (d: Draw) => string;
}

const manifestOf = (json: unknown) => json as ModuleManifest & { readonly component: ComponentBlock; readonly description: string; readonly params: ComponentInfo["params"] };

// ---- shared bits ----

const str = (v: unknown) => (typeof v === "string" ? v : "");
const px = (n: number) => `${num(n)}px`;
const color = (target: RenderTarget, v: unknown, fallback: string) => resolveColor(target, v, fallback);
const fg = (target: RenderTarget) => color(target, "fg", DEFAULT_THEME.colors.fg);
const mute = (target: RenderTarget) => color(target, "mute", DEFAULT_THEME.colors.mute);
const accent = (target: RenderTarget) => color(target, "accent", DEFAULT_THEME.colors.accent);
/** A media reference prop ({ media: id }) as an image URL in this target, or undefined. */
const mediaSrc = (target: RenderTarget, v: unknown) => {
  const id = v && typeof v === "object" ? (v as { media?: unknown }).media : undefined;
  return typeof id === "string" ? target.mediaUrl?.(id) : undefined;
};
/** Image files a component can show ({ media } props): what Chromium decodes (no TIFF, no HEIC). */
export const COMPONENT_IMAGE = /\.(svg|png|jpe?g|gif|webp|bmp)$/i;
/** URLs go in a src="…" attribute: only data:, http(s): and the export's placeholder pass. */
const safeSrc = (url: string | undefined) => (url && /^(data:image\/|https?:\/\/|uncut-media:)/.test(url) ? esc(url) : undefined);

/** "42", "1.5", "0.25": up to two decimals. */
const numberLabel = (n: number) => String(Math.round(n * 100) / 100);

// ---- device frame ----

export type Device = "phone" | "android" | "browser";
export const DEVICES: ReadonlyArray<Device> = ["phone", "android", "browser"];
const deviceOf = (props: { readonly [key: string]: unknown }): Device => (DEVICES.includes(props.device as Device) ? (props.device as Device) : "phone");

/** The device's frame size and screen rect (its manifest's component.screens), in that size's pixels. */
export const deviceSpec = (device: Device) => manifestOf(deviceFrameJson).component.screens![device]!;

/**
 * Where the screen is in a frame drawn in a w×h box: the device's screen rect scaled to the box
 * (radius by the smaller scale). This is the clip's box under the frame; the bezel's hole is
 * 2 px (scaled) inside it, so the clip's edges always sit under the bezel (no seam).
 */
export function screenRect(device: Device, w: number, h: number): Rect & { readonly radius: number } {
  const spec = deviceSpec(device);
  const sx = w / spec.size.width;
  const sy = h / spec.size.height;
  const s = spec.screen;
  return { x: s.x * sx, y: s.y * sy, w: s.width * sx, h: s.height * sy, radius: (s.radius ?? 0) * Math.min(sx, sy) };
}

const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  return `M${num(x + k)} ${num(y)}H${num(x + w - k)}A${num(k)} ${num(k)} 0 0 1 ${num(x + w)} ${num(y + k)}V${num(y + h - k)}A${num(k)} ${num(k)} 0 0 1 ${num(x + w - k)} ${num(y + h)}H${num(x + k)}A${num(k)} ${num(k)} 0 0 1 ${num(x)} ${num(y + h - k)}V${num(y + k)}A${num(k)} ${num(k)} 0 0 1 ${num(x + k)} ${num(y)}Z`;
};

/** The default frame colour (near-black) and the browser bar's text. */
export const FRAME_COLOR = "#1C1C1F";

/**
 * The bezel as an SVG at w×h (canvas px): the frame filled with `fill`, a transparent hole for the
 * screen (fill-rule evenodd), a hairline edge, and the device's details (camera pill, punch hole,
 * or the browser's dots and address bar). Generic shapes, no brand marks.
 */
export function bezelSvg(device: Device, w: number, h: number, fill: string, url = ""): string {
  const spec = deviceSpec(device);
  const s = Math.min(w / spec.size.width, h / spec.size.height);
  const scr = screenRect(device, w, h);
  const inset = 2 * s;
  const hole = roundRect(scr.x + inset, scr.y + inset, scr.w - 2 * inset, scr.h - 2 * inset, Math.max(0, scr.radius - inset));
  const outerR = device === "phone" ? 66 * s : device === "android" ? 46 * s : 16 * s;
  const outer = roundRect(0, 0, w, h, outerR);
  const parts = [`<path d="${outer} ${hole}" fill="${fill}" fill-rule="evenodd"/>`, `<path d="${roundRect(0.75 * s, 0.75 * s, w - 1.5 * s, h - 1.5 * s, outerR - 0.75 * s)}" fill="none" stroke="rgb(255 255 255 / 14%)" stroke-width="${num(1.5 * s)}"/>`];
  if (device === "phone") parts.push(`<rect x="${num(w / 2 - 60 * s)}" y="${num(scr.y + 18 * s)}" width="${num(120 * s)}" height="${num(34 * s)}" rx="${num(17 * s)}" fill="#000"/>`);
  else if (device === "android") parts.push(`<circle cx="${num(w / 2)}" cy="${num(scr.y + 28 * s)}" r="${num(13 * s)}" fill="#000"/>`);
  else {
    // The browser's top bar: three neutral dots and an address field.
    for (const [i, x] of [24, 46, 68].entries()) parts.push(`<circle cx="${num(x * s)}" cy="${num(22 * s)}" r="${num(6.5 * s)}" fill="rgb(255 255 255 / ${[22, 16, 12][i]}%)"/>`);
    const fw = Math.min(w * 0.5, 640 * s);
    parts.push(`<rect x="${num(w / 2 - fw / 2)}" y="${num(9 * s)}" width="${num(fw)}" height="${num(26 * s)}" rx="${num(13 * s)}" fill="rgb(255 255 255 / 8%)"/>`);
    if (url) parts.push(`<text x="${num(w / 2)}" y="${num(27 * s)}" text-anchor="middle" font-family="${DM_SANS.replace(/'/g, "")}" font-size="${num(14 * s)}" fill="rgb(255 255 255 / 60%)">${esc(url)}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}" height="${num(h)}" viewBox="0 0 ${num(w)} ${num(h)}" style="position:absolute;left:0;top:0;display:block;overflow:visible">${parts.join("")}</svg>`;
}

const drawDeviceFrame = ({ props, w, h, target }: Draw) => bezelSvg(deviceOf(props), w, h, color(target, props.color, FRAME_COLOR), str(props.url));

// ---- end card ----

function drawEndCard({ props, w, h, target }: Draw) {
  const k = Math.min(w / 1920, h / 1080);
  const logo = safeSrc(mediaSrc(target, props.logo));
  const title = str(props.title);
  const code = str(props.code);
  const url = str(props.url);
  const bg = typeof props.background === "string" ? color(target, props.background, DEFAULT_THEME.colors.bg) : undefined;
  const parts: Array<string> = [];
  if (logo) parts.push(`<img src="${logo}" alt="" style="display:block;height:${px(128 * k)};max-width:${px(w * 0.6)};object-fit:contain">`);
  if (title) parts.push(`<div style="font-family:${DM_SANS};font-weight:700;font-size:${px(92 * k)};line-height:1.08;letter-spacing:-0.02em;color:${fg(target)};--accent:${accent(target)};text-align:center;max-width:${px(w * 0.86)}">${markup(title)}</div>`);
  if (code) parts.push(`<div style="font-family:${DM_MONO};font-weight:500;font-size:${px(40 * k)};line-height:1.2;color:${fg(target)};padding:${px(18 * k)} ${px(34 * k)};border-radius:${px(16 * k)};background:rgb(128 128 128 / 16%);border:${px(1.5 * k)} solid rgb(128 128 128 / 30%);white-space:pre">${esc(code)}</div>`);
  if (url) parts.push(`<div style="font-family:${DM_MONO};font-weight:400;font-size:${px(32 * k)};line-height:1.2;color:${mute(target)}">${esc(url)}</div>`);
  return `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${px(40 * k)};${bg ? `background:${bg};` : ""}">${parts.join("")}</div>`;
}

// ---- code block ----

function drawCodeBlock({ props, w, h, target }: Draw) {
  const file = str(props.file);
  const prompt = props.prompt === true;
  const lines = str(props.code).replace(/\r/g, "").split("\n");
  const longest = Math.max(1, ...lines.map((l) => [...l].length + (prompt ? 2 : 0)), file ? [...file].length * 0.8 : 0);
  // Sized to fit: rows of 1.5 em, a file line of 0.8 em + a gap, 0.9 em of padding all round
  // (1.8 em both ways), DM Mono's advance 0.6 em.
  const rows = lines.length * 1.5 + (file ? 1.4 : 0);
  const size = Math.max(4, Math.min(h / (rows + 1.8), w / (longest * 0.6 + 1.8), 64 * Math.min(w / 760, h / 120, 1.6)));
  const pad = size * 0.9;
  const body = lines
    .map((line) => {
      const add = line.startsWith("+ ");
      const del = line.startsWith("- ");
      const text = esc(add || del ? line.slice(2) : line) || " ";
      const style = add ? `color:${accent(target)}` : del ? `color:${mute(target)};text-decoration:line-through` : "";
      return `<div style="white-space:pre;${style}">${prompt ? `<span style="color:${mute(target)}">$ </span>` : ""}${text}</div>`;
    })
    .join("");
  const header = file ? `<div style="color:${mute(target)};font-size:0.8em;margin-bottom:0.6em;white-space:pre">${esc(file)}</div>` : "";
  return `<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 ${px(pad)};background:#111113;border:${px(Math.max(1, size * 0.05))} solid #2A2A2E;border-radius:${px(Math.min(h / 2, size * 0.6))};font-family:${DM_MONO};font-weight:400;font-size:${px(size)};line-height:1.5;color:${fg(target)};overflow:hidden">${header}${body}</div>`;
}

// ---- chart ----

interface Bar {
  readonly label: string;
  readonly value: number;
  readonly accent?: boolean;
}
const barsOf = (v: unknown): Array<Bar> =>
  Array.isArray(v) ? v.filter((b): b is Bar => !!b && typeof b === "object" && typeof (b as Bar).value === "number" && Number.isFinite((b as Bar).value)).map((b) => ({ label: str(b.label), value: Math.max(0, b.value), accent: b.accent === true })) : [];

function drawChart({ props, w, h, target }: Draw) {
  const bars = barsOf(props.bars);
  const k = Math.min(w / 1000, h / 600);
  const unit = str(props.unit);
  const max = typeof props.max === "number" && props.max > 0 ? props.max : Math.max(1e-9, ...bars.map((b) => b.value));
  const valueSize = 34 * k;
  const labelSize = 28 * k;
  // Room for the value over the tallest bar and the label under every bar.
  const top = valueSize * 1.7;
  const bottom = labelSize * 2.1;
  const area = Math.max(1, h - top - bottom);
  const slot = w / Math.max(1, bars.length);
  const barW = Math.min(slot * 0.56, 150 * k);
  const neutral = mute(target);
  const columns = bars
    .map((b, i) => {
      const bh = Math.max(b.value > 0 ? 2 * k : 0, (Math.min(b.value, max) / max) * area);
      const x = i * slot + slot / 2;
      const fill = b.accent ? accent(target) : neutral;
      return [
        `<div style="position:absolute;left:${px(x - barW / 2)};top:${px(top + area - bh)};width:${px(barW)};height:${px(bh)};background:${fill};border-radius:${px(6 * k)} ${px(6 * k)} 0 0"></div>`,
        `<div style="position:absolute;left:${px(x - slot / 2)};width:${px(slot)};top:${px(top + area - bh - valueSize * 1.45)};text-align:center;font-family:${DM_SANS};font-weight:600;font-size:${px(valueSize)};line-height:1.2;color:${fg(target)};font-variant-numeric:tabular-nums;white-space:nowrap">${esc(numberLabel(b.value) + unit)}</div>`,
        `<div style="position:absolute;left:${px(x - slot / 2)};width:${px(slot)};top:${px(top + area + labelSize * 0.6)};text-align:center;font-family:${DM_SANS};font-weight:500;font-size:${px(labelSize)};line-height:1.2;color:${neutral};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(b.label)}</div>`,
      ].join("");
    })
    .join("");
  const axis = `<div style="position:absolute;left:0;right:0;top:${px(top + area)};height:${px(Math.max(1, 2 * k))};background:${neutral};opacity:0.5"></div>`;
  return `<div style="position:absolute;inset:0">${columns}${axis}</div>`;
}

// ---- terminal ----

export interface TerminalLine {
  readonly text: string;
  readonly kind: "input" | "output";
  /** The shown part (input lines type in). */
  readonly shown: string;
  /** The cursor is at the end of this line. */
  readonly cursor: boolean;
}

/**
 * What a terminal shows at `local` frames: input lines type in at `speed` characters a second
 * from `typeFrom` (one after another, a quarter second apart), output lines appear at once a tenth
 * of a second after the line before; a line's `at` holds it until that frame. The cursor sits at the
 * end of the line being typed, else on a fresh prompt line once everything is shown (`idle`).
 */
export function terminalState(props: { readonly [key: string]: unknown }, local: number, fps: number): { lines: Array<TerminalLine>; idle: boolean } {
  const speed = typeof props.speed === "number" && props.speed > 0 ? props.speed : 30;
  const list = Array.isArray(props.lines) ? props.lines.filter((l): l is { text: string; kind?: string; at?: number } => !!l && typeof l === "object" && typeof (l as { text?: unknown }).text === "string") : [];
  let clock = typeof props.typeFrom === "number" ? Math.max(0, props.typeFrom) : 0;
  const lines: Array<TerminalLine> = [];
  let typing = false;
  let waitingFor: string | undefined;
  for (const l of list) {
    if (typeof l.at === "number") clock = Math.max(clock, l.at);
    if (local < clock) {
      waitingFor = l.kind === "input" ? "input" : "output";
      break;
    }
    if (l.kind === "input") {
      const chars = [...l.text];
      const frames = Math.ceil((chars.length * fps) / speed);
      const n = Math.min(chars.length, Math.floor(((local - clock) * speed) / fps));
      const done = n >= chars.length;
      lines.push({ text: l.text, kind: "input", shown: chars.slice(0, n).join(""), cursor: !done });
      clock += frames + Math.round(fps * 0.25);
      if (!done) {
        typing = true;
        break;
      }
    } else {
      lines.push({ text: l.text, kind: "output", shown: l.text, cursor: false });
      clock += Math.max(1, Math.round(fps * 0.1));
    }
  }
  // Idle (a fresh prompt with the cursor): everything shown, or waiting to type the next input line.
  const all = lines.length === list.length && !typing;
  return { lines, idle: all || waitingFor === "input" };
}

function drawTerminal({ props, w, h, local, fps, target }: Draw) {
  const k = Math.min(w / 1000, h / 620);
  const bar = 52 * k;
  const prompt = typeof props.prompt === "string" ? props.prompt : "$";
  const state = terminalState(props, local, fps);
  const total = (Array.isArray(props.lines) ? props.lines.length : 0) + 1;
  const size = Math.max(4, Math.min(26 * k, (h - bar - 56 * k) / (total * 1.5)));
  const cursor = `<span style="display:inline-block;width:0.6em;height:1.15em;vertical-align:-0.2em;background:#E6E6E6"></span>`;
  const promptHtml = `<span style="color:${accent(target)}">${esc(prompt)}</span> `;
  const rows = state.lines.map((l) =>
    l.kind === "input"
      ? `<div style="white-space:pre-wrap;color:#F2F1EE">${promptHtml}${esc(l.shown)}${l.cursor ? cursor : ""}</div>`
      : `<div style="white-space:pre-wrap;color:#B8B8BE">${esc(l.shown) || " "}</div>`,
  );
  if (state.idle) rows.push(`<div style="white-space:pre;color:#F2F1EE">${promptHtml}${cursor}</div>`);
  const title = str(props.title);
  const dots = [0, 1, 2].map((i) => `<i style="display:block;width:${px(14 * k)};height:${px(14 * k)};border-radius:50%;background:#3A3A3F;margin-right:${px(9 * k)}"></i>`).join("");
  return (
    `<div style="position:absolute;inset:0;border-radius:${px(18 * k)};background:#141416;border:${px(Math.max(1, 1.5 * k))} solid #2C2C30;overflow:hidden">` +
    `<div style="position:relative;height:${px(bar)};display:flex;align-items:center;padding:0 ${px(20 * k)};background:#1D1D20;border-bottom:${px(Math.max(1, k))} solid #0E0E10">${dots}` +
    `<span style="position:absolute;left:0;right:0;text-align:center;font-family:${DM_SANS};font-weight:500;font-size:${px(21 * k)};color:#8C8C91;white-space:nowrap">${esc(title)}</span></div>` +
    `<div style="padding:${px(26 * k)} ${px(30 * k)};font-family:${DM_MONO};font-weight:400;font-size:${px(size)};line-height:1.5">${rows.join("")}</div></div>`
  );
}

// ---- agent log (D95) ----

const numOr = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** "2:41": minutes and whole seconds. */
const clockLabel = (s: number) => {
  const r = Math.round(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
};
/** DM Sans has no tabular figures: each character in a cell of fixed width, so a changing number never moves its neighbours. */
const cells = (text: string) => [...text].map((c) => `<span style="display:inline-block;text-align:center;width:${/[0-9]/.test(c) ? "0.57em" : "0.27em"}">${esc(c)}</span>`).join("");

/**
 * What an agent log shows at `local` frames: the source second (srcAt + seconds × speed), the run's
 * clock (from runStart, stopping at durationMs), the token count reached, the lines in, and whether
 * the run is done.
 */
export function agentLogState(props: { readonly [key: string]: unknown }, local: number, fps: number): { src: number; clock: number; tokens: number; lines: number; done: boolean } {
  const speed = numOr(props.speed, 1) > 0 ? numOr(props.speed, 1) : 1;
  const src = Math.max(0, numOr(props.srcAt, 0)) + (Math.max(0, local) / fps) * speed;
  const runStart = numOr(props.runStart, 0);
  const length = Math.max(0, numOr(props.durationMs, Infinity)) / 1000;
  const clock = clamp(src - runStart, 0, length);
  let tokens = 0;
  for (const k of Array.isArray(props.tokens) ? props.tokens : []) {
    const t = k && typeof k === "object" ? (k as { t?: unknown; cum?: unknown }) : {};
    if (typeof t.t === "number" && typeof t.cum === "number" && t.t <= src) tokens = t.cum;
  }
  const lines = (Array.isArray(props.lines) ? props.lines : []).filter((l) => !!l && typeof l === "object" && typeof (l as { t?: unknown }).t === "number" && (l as { t: number }).t <= src).length;
  return { src, clock, tokens, lines, done: Number.isFinite(length) && src >= runStart + length };
}

function drawAgentLog({ props, w, h, local, fps, target }: Draw) {
  const k = Math.min(w / 470, h / 739);
  const size = numOr(props.size, 19) * k;
  const state = agentLogState(props, local, fps);
  const title = str(props.title);
  const list = (Array.isArray(props.lines) ? props.lines : []).filter((l): l is { t: number; tool?: string; text: string } => !!l && typeof l === "object" && typeof (l as { t?: unknown }).t === "number" && typeof (l as { text?: unknown }).text === "string");
  // Only the lines that can be on screen: the log is bottom-anchored and clipped above, and a line
  // takes at least one row (size × 1.45 + its 12 px gap), so the last ceil(area ÷ row) + 1 are all
  // that can show (a long log stays a few KB of HTML a frame).
  const area = Math.max(0, h - 256 * k);
  const fit = Math.ceil(area / (size * 1.45 + 12 * k)) + 1;
  const reached = list.filter((l) => l.t <= state.src);
  const shown = reached.slice(Math.max(0, reached.length - fit));
  const rows = shown
    .map((l) =>
      typeof l.tool === "string" && l.tool
        ? `<div style="margin-top:${px(12 * k)}"><span style="font-family:${DM_MONO};font-size:${px(size - 2 * k)};color:#7D7D85">${esc(l.tool)}</span> <span style="color:#B9B9C0">${esc(l.text)}</span></div>`
        : `<div style="margin-top:${px(12 * k)};color:#ECECEE">${esc(l.text)}</div>`,
    )
    .join("");
  const dots = ["#FF5F57", "#FEBC2E", "#28C840"].map((c) => `<i style="display:block;width:${px(12 * k)};height:${px(12 * k)};border-radius:50%;background:${c}"></i>`).join("");
  const label = str(props.tokenLabel)
    .split("\n")
    .map((part) => esc(part))
    .join("<br>");
  return (
    `<div style="position:absolute;inset:0;display:flex;flex-direction:column;border-radius:${px(18 * k)};background:rgb(16 17 20 / 94%);box-shadow:0 0 0 ${px(Math.max(1, k))} rgb(255 255 255 / 8%);overflow:hidden;color:#ECECEE;font-family:${DM_SANS};font-weight:400;font-size:${px(size)};line-height:1.45">` +
    `<div style="height:${px(44 * k)};flex:none;display:flex;align-items:center;gap:${px(8 * k)};padding:0 ${px(16 * k)};background:#1D1E22;border-bottom:${px(Math.max(1, k))} solid #000">${dots}` +
    `<span style="flex:1;text-align:center;margin-right:${px(52 * k)};white-space:nowrap;overflow:hidden;font-family:${DM_MONO};font-weight:500;font-size:${px(15 * k)};color:#8D8D94">${esc(title)}</span></div>` +
    `<div style="padding:${px(26 * k)} ${px(30 * k)} ${px(20 * k)};flex:none;border-bottom:${px(Math.max(1, k))} solid #26262B">` +
    `<div style="font-weight:600;font-size:${px(40 * k)};line-height:1;letter-spacing:-0.01em">${esc(str(props.model))}</div>` +
    `<div style="display:flex;align-items:baseline;gap:${px(28 * k)};margin-top:${px(20 * k)}">` +
    `<span style="font-weight:500;font-size:${px(64 * k)};line-height:1;white-space:nowrap">${cells(clockLabel(state.clock))}</span>` +
    `<span style="color:#8D8D94;font-size:${px(22 * k)};line-height:1.2"><span style="color:#ECECEE">${cells(Math.round(state.tokens).toLocaleString("en-US"))}</span><br>${label}</span></div>` +
    `<div style="margin-top:${px(14 * k)};font-weight:500;font-size:${px(22 * k)};line-height:1.25;color:${accent(target)};height:${px(28 * k)};white-space:nowrap">${state.done ? esc(str(props.doneLabel)) : ""}</div></div>` +
    `<div style="position:relative;flex:1;overflow:hidden;padding:0 ${px(30 * k)};-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 ${px(70 * k)});mask-image:linear-gradient(to bottom,transparent 0,#000 ${px(70 * k)})">` +
    `<div style="position:absolute;left:${px(30 * k)};right:${px(30 * k)};bottom:${px(22 * k)}">${rows}</div></div></div>`
  );
}

// ---- compare table (D95) ----

interface CompareRow {
  readonly label: string;
  readonly values: ReadonlyArray<number>;
  readonly text: ReadonlyArray<string>;
}
const compareRows = (v: unknown): Array<CompareRow> =>
  (Array.isArray(v) ? v : [])
    .filter((r): r is { label?: unknown; values?: unknown; text?: unknown } => !!r && typeof r === "object")
    .map((r) => {
      const values = (Array.isArray(r.values) ? r.values : []).map((x) => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, x) : 0));
      const text = Array.isArray(r.text) ? r.text.map((x) => str(x)) : [];
      return { label: str(r.label), values, text };
    });

function drawCompareTable({ props, w, h, local, fps }: Draw) {
  const k = Math.min(w / 1400, h / 600);
  const size = numOr(props.size, 24) * k;
  const names = (Array.isArray(props.names) ? props.names : []).map((n) => str(n));
  const rows = compareRows(props.rows);
  const t = Math.max(0, local) / fps;
  const start = numOr(props.start, 0.35);
  const step = numOr(props.step, 0.55);
  const grow = Math.max(0, numOr(props.grow, 0.7));
  const lin = (x: number, a: number, b: number) => (b <= a ? (x >= b ? 1 : 0) : clamp((x - a) / (b - a), 0, 1));
  const out = EASES.out;
  const body = rows
    .map((r, i) => {
      const t0 = start + i * step;
      const kr = out(lin(t, t0, t0 + 0.35));
      const kb = out(lin(t, t0 + 0.15, t0 + 0.15 + grow));
      const kv = out(lin(t, t0 + 0.15 + grow * 0.6, t0 + 0.15 + grow));
      const max = Math.max(...r.values, 0) || 1;
      const bars = names
        .map((n, j) => {
          const v = r.values[j] ?? 0;
          const shown = r.text[j] ?? numberLabel(v);
          return (
            `<div style="display:flex;align-items:center;gap:${px(20 * k)}">` +
            `<span style="width:${px(130 * k)};flex:none;color:#A9A9B0;white-space:nowrap">${esc(n)}</span>` +
            `<span style="flex:1;height:${px(14 * k)};border-radius:${px(7 * k)};background:rgb(255 255 255 / 6%);overflow:hidden"><i style="display:block;height:100%;width:${num((v / max) * 100 * kb)}%;border-radius:${px(7 * k)};background:#ECECEE"></i></span>` +
            `<b style="width:${px(170 * k)};flex:none;text-align:right;font-weight:500;font-size:${px(40 * k)};line-height:1;white-space:nowrap;opacity:${num(kv)}">${esc(shown)}</b></div>`
          );
        })
        .join("");
      return (
        `<div style="display:flex;align-items:center;gap:${px(40 * k)};padding:${px(22 * k)} 0;${i ? `border-top:${px(Math.max(1, k))} solid rgb(255 255 255 / 12%);` : ""}opacity:${num(kr)};transform:translateY(${px((1 - kr) * 18 * k)})">` +
        `<div style="width:${px(300 * k)};flex:none;color:#A9A9B0;font-size:${px(28 * k)}">${esc(r.label)}</div>` +
        `<div style="flex:1;display:flex;flex-direction:column;gap:${px(14 * k)}">${bars}</div></div>`
      );
    })
    .join("");
  return `<div style="position:absolute;inset:0;box-sizing:border-box;padding:${px(34 * k)} ${px(56 * k)};border-radius:${px(22 * k)};background:rgb(16 17 20 / 94%);box-shadow:0 0 0 ${px(Math.max(1, k))} rgb(255 255 255 / 8%);color:#ECECEE;font-family:${DM_SANS};font-weight:400;font-size:${px(size)};line-height:1.2">${body}</div>`;
}

// ---- the registry ----

const info = (json: unknown, render: ComponentInfo["render"]): ComponentInfo => {
  const manifest = manifestOf(json);
  return { id: manifest.id, name: manifest.name, description: manifest.description, manifest, block: manifest.component, params: manifest.params, render };
};

/** The components the preview and export draw, in the Elements panel's order. */
export const COMPONENTS: ReadonlyArray<ComponentInfo> = [
  // The general elements (D130) first, then the ones made for product videos.
  info(shapeJson, drawShape),
  info(lowerThirdJson, drawLowerThird),
  info(calloutJson, drawCallout),
  info(progressBarJson, drawProgressBar),
  info(countdownJson, drawCountdown),
  info(subscribeJson, drawSubscribe),
  info(stickerJson, drawSticker),
  info(imageFrameJson, drawImageFrame),
  info(endCardJson, drawEndCard),
  info(deviceFrameJson, drawDeviceFrame),
  info(codeBlockJson, drawCodeBlock),
  info(terminalJson, drawTerminal),
  info(chartJson, drawChart),
  info(agentLogJson, drawAgentLog),
  info(compareTableJson, drawCompareTable),
];
const BY_ID = new Map(COMPONENTS.map((c) => [c.id, c]));
export const componentInfo = (id: unknown) => (typeof id === "string" ? BY_ID.get(id) : undefined);

/** Every component module the preview and export draw: the registry and the background (render.ts solidHtml). */
export const DRAWN_COMPONENTS: ReadonlyArray<string> = [SOLID, ...COMPONENTS.map((c) => c.id)];

/**
 * Built-in component manifests that are valid in project.json but not drawn yet (as transition.cut
 * isn't): saved, shown to the agent with showsInPreview false, not offered in the panel.
 */
export const UNDRAWN_COMPONENTS: Readonly<Record<string, string>> = {
  "component.follow-card": "not drawn yet",
  "component.steps": "not drawn yet",
  "component.zoom-pan": "not drawn: zoom and pan a clip with its scale and x / y keys instead (D75)",
};

/** A drawn component item (not the background, which render.ts draws full-frame). */
export const isDrawnComponent = (item: Pick<Item, "type" | "component">) => item.type === "component" && !!componentInfo(item.component);

/** Canvas pixels per manifest pixel: manifests are sized for a canvas whose shorter side is 1080. */
export const componentScale = (canvas: Pick<Canvas, "width" | "height">) => Math.min(canvas.width, canvas.height) / 1080;

/** The box a component gets with no w and h: the device's frame size, else the manifest's size (scaled), or the canvas. */
export function naturalSize(item: Pick<Item, "component" | "props">, canvas: Pick<Canvas, "width" | "height">): { width: number; height: number } {
  const c = componentInfo(item.component);
  if (!c) return { width: canvas.width, height: canvas.height };
  if (c.block.fullFrame) return { width: canvas.width, height: canvas.height };
  const k = componentScale(canvas);
  const size = c.block.screens ? deviceSpec(deviceOf(item.props ?? {})).size : c.block.size;
  return { width: size.width * k, height: size.height * k };
}

/** A component's transform with its default size filled in (no w and h = its natural size). */
const sizedTransform = (item: Pick<Item, "component" | "props" | "transform">, canvas: Pick<Canvas, "width" | "height">) => {
  const size = naturalSize(item, canvas);
  const t = item.transform ?? {};
  const sized = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0;
  return { size, transform: sized(t.w) || sized(t.h) ? t : { ...t, w: size.width, h: size.height } };
};

/** A component's box at `local` frames (D75's box: transform, keys, opacity), or undefined if it isn't one drawn here. */
export function componentBox(item: Pick<Item, "type" | "component" | "props" | "transform" | "keys">, canvas: Pick<Canvas, "width" | "height"> & { readonly fps?: number }, local: number): ClipBox | undefined {
  if (!isDrawnComponent(item)) return undefined;
  const { size, transform } = sizedTransform(item, canvas);
  return clipBox({ transform, keys: item.keys }, canvas, size, local);
}

/** A component's box without keys (where its transform puts it), or undefined if it isn't one drawn here. */
export function componentRest(item: Pick<Item, "type" | "component" | "props" | "transform">, canvas: Pick<Canvas, "width" | "height">): Rect | undefined {
  if (!isDrawnComponent(item)) return undefined;
  const { size, transform } = sizedTransform(item, canvas);
  return baseBox({ transform }, canvas, size);
}

/**
 * Where a new component goes on this canvas (Fable QA round 2, F7, D152): its natural size, made
 * smaller when it wouldn't fit inside the safe area (the canvas less `safeMargin` on every side),
 * placed by its kind: a lower third bottom-left, a subscribe button and a progress bar along the
 * bottom (the bar as wide as the safe area), a sticker top-right, the rest centred. On a portrait
 * canvas the bottom ones sit a tenth of the height higher, clear of the apps' own captions and
 * buttons. Undefined for full-frame components and device frames (their own planner places them).
 */
export function defaultComponentBox(id: string, target: Pick<RenderTarget, "canvas" | "theme">): { x: number; y: number; w: number; h: number } | undefined {
  const c = componentInfo(id);
  if (!c || c.block.fullFrame || c.block.screens) return undefined;
  const { width: W, height: H } = target.canvas;
  const m = safeMargin(target as RenderTarget);
  const natural = naturalSize({ component: id, props: componentDefaults(id) }, target.canvas);
  const k = Math.min(1, (W - 2 * m) / natural.width, (H - 2 * m) / natural.height);
  let w = natural.width * k;
  const h = natural.height * k;
  const lift = H > W ? H / 10 : 0;
  let x = (W - w) / 2;
  let y = (H - h) / 2;
  if (id === "component.lower-third") [x, y] = [m, H - m - lift - h];
  else if (id === "component.subscribe") y = H - m - lift - h;
  else if (id === "component.progress-bar") [w, x, y] = [W - 2 * m, m, H - m - lift - h];
  else if (id === "component.sticker") [x, y] = [W - m - w, m];
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** The props a new component gets (its manifest's defaults). */
export const componentDefaults = (id: string) => structuredClone((componentInfo(id)?.block.defaults ?? {}) as Record<string, unknown>);

/**
 * A component item as HTML at `local` frames from its start: a wrapper at its box (canvas px) with
 * the opacity given (the caller's: the preview passes everything visualsAt folds in, the export the
 * box's own, its ramps being ffmpeg fades), the in/out animation's motion like text's, and the body.
 * Deterministic: the same item, target and frame give the same string, so the export draws one PNG
 * per distinct look.
 */
export function componentHtml(item: Item, target: RenderTarget, local: number, opts: { opacity?: number; motion?: Motion; fps?: number; box?: ClipBox } = {}): string {
  const parts = componentParts(item, target, local, opts);
  return parts ? wrapComponent(parts.wrapper, parts.body) : "";
}

/**
 * componentHtml in two parts (D76 review): the wrapper (the box's position, size, opacity, scale,
 * the move's offset and reveal) and the body (what the component looks like inside its box). The
 * export caps how many distinct bodies it draws (an animation), never the wrapper's motion, so a
 * keyed box moves on every frame however long it is. `box` is the box to draw it in when a
 * transition moves it (D79: visualsAt's), else its own at `local`.
 */
export function componentParts(item: Item, target: RenderTarget, local: number, { opacity = 1, motion, fps = 30, box: moved }: { opacity?: number; motion?: Motion; fps?: number; box?: ClipBox } = {}): { wrapper: string; body: string } | undefined {
  const c = componentInfo(item.component);
  const box = moved && isDrawnComponent(item) ? moved : componentBox(item, target.canvas, local);
  if (!c || !box) return undefined;
  const body = c.render({ item, props: item.props ?? {}, w: box.w, h: box.h, local, fps, target });
  const css = [`left:${px(box.x)}`, `top:${px(box.y)}`, `width:${px(box.w)}`, `height:${px(box.h)}`, `opacity:${num(opacity)}`];
  const moves: Array<string> = [];
  if (motion?.dx || motion?.dy) moves.push(`translate(${px(motion.dx ?? 0)},${px(motion.dy ?? 0)})`);
  if (box.scale !== 1) moves.push(`scale(${num(box.scale)})`);
  if (moves.length) css.push(`transform:${moves.join(" ")}`);
  if (motion?.reveal !== undefined && motion.reveal < 1) css.push(`clip-path:inset(-20% ${num((1 - motion.reveal) * 100)}% -20% -5%)`);
  return { wrapper: `<div class="pv-comp" data-item="${esc(item.id)}" data-component="${esc(c.id)}" style="${css.join(";")}">`, body };
}

/** A component's wrapper (componentParts) around a body. */
export const wrapComponent = (wrapper: string, body: string) => `${wrapper}${body}</div>`;

// ---- device frame planning ----

export interface DeviceFrameRequest {
  /** The footage (video or image media) for the screen; without it, only the frame. */
  readonly media?: string | undefined;
  readonly device?: Device | undefined;
  readonly start: number;
  readonly duration: number;
  /** Where in the media the clip starts (project frames). */
  readonly in?: number | undefined;
  /** The frame's box in canvas px: any of x, y and h (w follows the device's shape); default centred, 86 % of the canvas height (phones). */
  readonly box?: { readonly x?: number | undefined; readonly y?: number | undefined; readonly h?: number | undefined } | undefined;
  readonly frameId?: string | undefined;
  readonly clipId?: string | undefined;
  readonly color?: string | undefined;
  readonly url?: string | undefined;
  /** Footage shorter than the frame holds its last frame (D94) instead of looping. */
  readonly hold?: boolean | undefined;
}

type Problem = { readonly problem: string };

const allIds = (project: Pick<Project, "media" | "tracks" | "scenes">) =>
  new Set([...project.media.map((m) => m.id), ...project.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]), ...(project.scenes ?? []).map((s) => s.id)]);
const freshId = (ids: Set<string>, base: string) => {
  for (let n = 1; ; n++) {
    if (!ids.has(`${base}-${n}`)) {
      ids.add(`${base}-${n}`);
      return `${base}-${n}`;
    }
  }
};

/** The footage clip's transform for a frame item: its screen rect at the frame's rest box (D75 box, cover, the screen's corners). */
export function screenTransform(frame: Item, canvas: Pick<Canvas, "width" | "height">): { x: number; y: number; w: number; h: number; fit: "cover"; radius?: number } | undefined {
  const box = componentBox({ ...frame, keys: undefined }, canvas, 0);
  if (!box) return undefined;
  const r = screenRect(deviceOf(frame.props ?? {}), box.w, box.h);
  // The frame's transform.scale draws it scaled about its centre: the screen scales with it.
  const s = box.scale;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const radius = Math.round(r.radius * s);
  return { x: Math.round(cx + (box.x + r.x - cx) * s), y: Math.round(cy + (box.y + r.y - cy) * s), w: Math.round(r.w * s), h: Math.round(r.h * s), fit: "cover", ...(radius > 0 ? { radius } : {}) };
}

/** The frame's x / y keys moved onto its screen (so the footage moves with the frame), or none. */
export function screenKeys(frame: Item, canvas: Pick<Canvas, "width" | "height">): Item["keys"] | undefined {
  const keys = (frame.keys ?? []).filter((k) => typeof k.x === "number" || typeof k.y === "number" || typeof k.opacity === "number");
  if (!keys.length) return undefined;
  // A key moves the frame's box; the screen keeps its offset in it (rest box → rest screen).
  const box = componentBox({ ...frame, keys: undefined }, canvas, 0)!;
  const t = screenTransform(frame, canvas)!;
  const dx = t.x - box.x;
  const dy = t.y - box.y;
  return keys.map((k) => ({ frame: k.frame, ...(k.ease ? { ease: k.ease } : {}), ...(typeof k.x === "number" ? { x: Math.round(k.x + dx) } : {}), ...(typeof k.y === "number" ? { y: Math.round(k.y + dy) } : {}), ...(typeof k.opacity === "number" ? { opacity: k.opacity } : {}) }));
}

/**
 * A device frame and the footage under it, as one edit (D76): the clip on a free video track
 * between main and the text tracks (the nearest free one above main, else a new one), its box on
 * the frame's screen (cover, the screen's corners), and the bezel on a free video track above the
 * clip's (else a new one right above it), both over [start, start + duration). The frame is
 * centred at 86 % of the canvas height (a browser at 80 % of its width) unless `box` says otherwise.
 */
export function planDeviceFrame(project: Pick<Project, "canvas" | "media" | "tracks" | "scenes">, req: DeviceFrameRequest): { ops: Array<Op>; frameId: string; clipId?: string } | Problem {
  const { canvas } = project;
  const device = req.device && DEVICES.includes(req.device) ? req.device : "phone";
  if (!Number.isInteger(req.start) || req.start < 0) return { problem: "start must be a frame (0 or more)." };
  if (!Number.isInteger(req.duration) || req.duration < 1) return { problem: "duration must be at least one frame." };
  const media: Media | undefined = req.media !== undefined ? project.media.find((m) => m.id === req.media) : undefined;
  if (req.media !== undefined && !media) return { problem: `media "${req.media}" does not exist.` };
  if (media && media.kind === "audio") return { problem: `"${media.id}" is audio-only: a device frame needs video or an image.` };
  const ids = allIds(project);
  for (const id of [req.frameId, req.clipId]) if (id !== undefined && ids.has(id)) return { problem: `id "${id}" is already used.` };
  const frameId = req.frameId ?? freshId(ids, "device");
  ids.add(frameId);
  const clipId = media ? (req.clipId ?? freshId(ids, "screen")) : undefined;
  if (clipId) ids.add(clipId);

  const spec = deviceSpec(device);
  const aspect = spec.size.width / spec.size.height;
  let h = req.box?.h ?? (device === "browser" ? (canvas.width * 0.8) / aspect : canvas.height * 0.86);
  if (device === "browser" && req.box?.h === undefined) h = Math.min(h, canvas.height * 0.86);
  const w = h * aspect;
  const x = req.box?.x ?? (canvas.width - w) / 2;
  const y = req.box?.y ?? (canvas.height - h) / 2;
  const props: Record<string, unknown> = { device, ...(req.color ? { color: req.color } : {}), ...(req.url && device === "browser" ? { url: req.url } : {}) };
  const frame: Item = { id: frameId, type: "component", component: "component.device-frame", start: req.start, duration: req.duration, transform: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }, props };

  // Tracks: video tracks between the lowest text track above main and main (the project lists
  // tracks top to bottom; the first draws on top), nearest main first.
  const mainIndex = project.tracks.findIndex((t) => t.role === "main");
  if (mainIndex === -1) return { problem: "This project has no main track." };
  const free = (t: Track) => !t.locked && t.kind === "video" && t.role !== "main" && t.items.every((i) => (i.start ?? 0) + i.duration <= req.start || req.start + req.duration <= (i.start ?? 0));
  const lastText = project.tracks.slice(0, mainIndex).reduce((n, t, i) => (t.kind === "text" ? i : n), -1);
  const region = project.tracks.map((t, i) => ({ t, i })).slice(lastText + 1, mainIndex).reverse();
  const ops: Array<Op> = [];
  const newTrack = (index: number, name: string) => {
    const id = freshId(ids, "overlay");
    ops.push({ op: "add_track", index, track: { id, kind: "video", name } });
    return id;
  };
  const names = new Set(project.tracks.map((t) => t.name));
  const trackName = (base: string) => {
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base} ${n}`;
      if (!names.has(name)) {
        names.add(name);
        return name;
      }
    }
  };
  if (!media) {
    const spot = region.find(({ t }) => free(t));
    const track = spot ? spot.t.id : newTrack(mainIndex, trackName("Device"));
    ops.push({ op: "insert_item", track, item: frame });
    return { ops, frameId };
  }
  const t = screenTransform(frame, canvas)!;
  // Footage shorter than the frame (from its in-point) loops, as the Inspector's does.
  const from = req.in ?? 0;
  if (media.kind === "video" && media.probe?.frames !== undefined && from >= media.probe.frames) return { problem: `in (${from}) is past the end of "${media.id}" (${media.probe.frames} frames).` };
  const loop = media.kind === "video" && media.probe?.frames !== undefined && from + req.duration > media.probe.frames;
  const clip: Item = {
    id: clipId!,
    type: "clip",
    media: media.id,
    start: req.start,
    duration: req.duration,
    ...(media.kind === "video" ? { in: from } : {}),
    ...(loop ? (req.hold ? { hold: true } : { loop: true }) : {}),
    transform: t,
  };
  const clipSpot = region.find(({ t }) => free(t));
  let clipTrack: string;
  let bezelTrack: string;
  if (clipSpot) {
    clipTrack = clipSpot.t.id;
    // A free track above the clip's, still under the text.
    const above = region.filter(({ i }) => i < clipSpot.i).find(({ t }) => free(t));
    bezelTrack = above ? above.t.id : newTrack(clipSpot.i, trackName("Device"));
  } else {
    // Both new, right above main: the bezel first (on top), then the screen.
    clipTrack = newTrack(mainIndex, trackName("Screen"));
    bezelTrack = newTrack(mainIndex, trackName("Device"));
  }
  ops.push({ op: "insert_item", track: clipTrack, item: clip }, { op: "insert_item", track: bezelTrack, item: frame });
  return { ops, frameId, clipId: clipId! };
}

/** Re-align a frame's footage clip with its screen (after the frame moved or changed device): the update for the clip. */
export function alignScreen(frame: Item, clip: Item, canvas: Pick<Canvas, "width" | "height">): FieldSet | undefined {
  const t = screenTransform(frame, canvas);
  if (!t) return undefined;
  // The frame's x / y / opacity keys replace the clip's; its own scale keys (a zoom inside the screen) stay.
  const own = (clip.keys ?? []).filter((k) => typeof k.scale === "number").map((k) => ({ frame: k.frame, ...(k.ease ? { ease: k.ease } : {}), scale: k.scale }));
  const keys = [...(screenKeys(frame, canvas) ?? []), ...own].sort((a, b) => a.frame - b.frame);
  return { transform: { ...t, ...(typeof clip.transform?.opacity === "number" ? { opacity: clip.transform.opacity } : {}), ...(typeof clip.transform?.scale === "number" ? { scale: clip.transform.scale } : {}) }, keys: keys.length ? keys : null };
}
