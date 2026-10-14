import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./editor/App.tsx";
import { loadFonts, syncKitFonts } from "./preview/fonts.ts";
import { installLeave } from "./state/leave.tsx";
import { brandFileUrl, getState, start, subscribeApp } from "./state/store.ts";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// U13: nothing outside the panels scrolls. The CSS leaves the root nothing to scroll; this puts
// it back at once should a focus or scrollIntoView move it anyway.
document.addEventListener(
  "scroll",
  (e) => {
    // Only the root and the editor's grid: the welcome card and the wizard scroll themselves.
    const root = document.getElementById("root");
    for (const el of [document.documentElement, document.body, root, root?.querySelector(":scope > .app")]) {
      if (el && (e.target === el || e.target === document) && (el.scrollTop || el.scrollLeft)) el.scrollTop = el.scrollLeft = 0;
    }
  },
  true,
);

installLeave();

// D198: the chosen brand kit's font files, loaded for the preview whenever the kit or its files change.
let kitFontsKey = "";
subscribeApp(() => {
  const brand = getState().brand;
  const kit = brand?.kits.find((k) => k.id === brand.active.kit);
  const files = (kit && brand?.files[kit.id]) || {};
  const wanted = (kit?.fonts ?? []).flatMap((f) => {
    const path = f.file ? files[f.file] : undefined;
    const url = path && kit ? brandFileUrl(kit.id, f.file!, path) : undefined;
    return url ? [{ key: `${kit!.id}/${f.family}/${f.weight ?? ""}/${path}`, family: f.family, weight: f.weight, url }] : [];
  });
  const key = wanted.map((w) => w.key).join("\n");
  if (key === kitFontsKey) return;
  kitFontsKey = key;
  void syncKitFonts(wanted);
});

// Tests wait for this: the connection is up (or failed), the first state is loaded and the
// bundled fonts are ready (D77).
void Promise.all([start(), loadFonts()]).finally(() => (document.body.dataset.ready = "1"));
