// The spike's own plain-JS copy of packages/core/src/render.ts, so its renderer can load it in the
// browser. Frozen reference for chunk 2 (porting the agent), deleted with the spike.
//
// Shared by the preview and export: the one place text is turned into HTML, so an
// exported frame shows exactly what the editor showed.
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function textHtml(item, canvas, { opacity = 1, selected = false } = {}) {
  const text = esc(item.text).replace(/\[\[(.*?)\]\]/g, '<span class="accent">$1</span>');
  const pos = `left:${(item.transform.x / canvas.width) * 100}%;top:${(item.transform.y / canvas.height) * 100}%`;
  const font = `font-size:${(item.style.size / canvas.height) * 100}cqh;font-weight:${item.style.weight ?? 600}`;
  return `<div class="pv-text ${selected ? "sel-box" : ""}" data-item="${item.id}" style="${pos};${font};opacity:${opacity}">${text}</div>`;
}
