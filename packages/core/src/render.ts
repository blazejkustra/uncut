// Shared by the preview and export: the one place text is turned into HTML, so an
// exported frame shows exactly what the editor showed.
import type { Canvas, Item } from "./types.ts";

const ENTITIES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, (c) => ENTITIES[c]!);

/** A text item as HTML. Text items carry transform (x, y) and style.size; the caller only passes those. */
export function textHtml(item: Item, canvas: Pick<Canvas, "width" | "height">, { opacity = 1, selected = false }: { opacity?: number; selected?: boolean } = {}): string {
  const text = esc(item.text).replace(/\[\[(.*?)\]\]/g, '<span class="accent">$1</span>');
  const pos = `left:${(item.transform!.x! / canvas.width) * 100}%;top:${(item.transform!.y! / canvas.height) * 100}%`;
  const font = `font-size:${(item.style!.size! / canvas.height) * 100}cqh;font-weight:${item.style!.weight ?? 600}`;
  return `<div class="pv-text ${selected ? "sel-box" : ""}" data-item="${item.id}" style="${pos};${font};opacity:${opacity}">${text}</div>`;
}
