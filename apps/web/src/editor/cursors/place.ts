// D348: where a cursor sits on screen. A target scrolled out of its panel pins the cursor to the
// nearest edge with an arrow toward it; the pill's colour is the agent's, darkened until white
// text reads on it. Pure.

export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface Bounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}
export type Pin = "left" | "right" | "up" | "down";

/** How far inside the panel's edge a pinned cursor stays. */
export const PIN_INSET = 10;

/** The point inside `bounds`, and which edge it was pinned to when it was outside. */
export function pinTo(point: Point, bounds: Bounds): Point & { readonly pin?: Pin } {
  const x = Math.min(bounds.right - PIN_INSET, Math.max(bounds.left + PIN_INSET, point.x));
  const y = Math.min(bounds.bottom - PIN_INSET, Math.max(bounds.top + PIN_INSET, point.y));
  const pin: Pin | undefined =
    point.x < bounds.left ? "left" : point.x > bounds.right ? "right" : point.y < bounds.top ? "up" : point.y > bounds.bottom ? "down" : undefined;
  return pin ? { x, y, pin } : { x, y };
}

export const lerp = (from: Point, to: Point, t: number): Point => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const rgbOf = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hexOf = (rgb: ReadonlyArray<number>) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** WCAG contrast of white text on `hex`. */
export function whiteContrast(hex: string): number {
  const [r, g, b] = rgbOf(hex);
  const lum = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return 1.05 / (lum + 0.05);
}

/** The agent's colour for its pill: as it is when white text reads at 4.5:1, else darkened until it does. */
export function pillColour(hex: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return "#3d5fb8";
  const rgb = rgbOf(hex);
  for (let k = 1; k > 0.2; k -= 0.02) {
    const shade = hexOf(rgb.map((v) => v * k));
    if (whiteContrast(shade) >= 4.5) return shade;
  }
  return hexOf(rgb.map((v) => v * 0.2));
}
