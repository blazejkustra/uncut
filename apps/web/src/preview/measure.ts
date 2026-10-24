// A text box's size as drawn (canvas px, D129): core textHtml laid out off screen at canvas size in
// a size container, as the preview and the export lay it out, so it's right even when the text
// isn't at the playhead. Its rotation and moves don't count. Used by the Inspector's "align to the
// frame" (a text box has no saved height).
import { RENDER_CSS, textHtml } from "@uncut/core/render";
import type { Item } from "@uncut/core/types";

import { type ProjectModel } from "../state/project.ts";

export function measureText(item: Item, project: ProjectModel): { w: number; h: number } {
  const { width, height } = project.canvas;
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-${width * 2 + 100}px;top:0;width:${width}px;height:${height}px;container-type:size;visibility:hidden;pointer-events:none`;
  host.innerHTML = `<style>${RENDER_CSS}</style>${textHtml({ ...item, transform: { ...item.transform, rotate: 0 } }, project)}`;
  document.body.append(host);
  const el = host.querySelector<HTMLElement>(".pv-text");
  const size = { w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 };
  host.remove();
  return size;
}
