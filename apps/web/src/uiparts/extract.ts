// Runs inside the harness window (scripts/ui-parts.ts passes it, types stripped, to
// executeJavaScript): lifts the parts of one scene as the real editor drew them. Self-contained (no
// imports, nothing outside the function): it is sent as source text.
//
// For each part: its DOM (form values written into the markup, canvases as PNG images, the server's
// image URLs and the app's own inline <style>s left out, attributes no picture needs dropped), its
// size, and the chain of ancestors it sits in (tag, classes, data attributes, CSS variables), so the
// runtime can rebuild the context its selectors expect. Then every CSS rule that applies to any
// element of those parts or their ancestors (hover, focus and active states left out: nothing in a
// graphic is hovered), in stylesheet order, with @media flattened when it matches this window and
// the @keyframes the kept rules name.
export function extract(scene: string): unknown {
  const SPECS: ReadonlyArray<{ readonly name: string; readonly scene: string; readonly selector: string }> = [
    { name: "editor", scene: "done", selector: ".app" },
    { name: "topbar", scene: "done", selector: ".topbar" },
    { name: "agent", scene: "done", selector: ".side" },
    { name: "message", scene: "done", selector: ".msg-user" },
    { name: "turn", scene: "done", selector: ".turn" },
    { name: "review", scene: "done", selector: ".card-item[data-type=\"review\"]" },
    { name: "timeline", scene: "done", selector: ".bottom" },
    { name: "preview", scene: "done", selector: ".stage" },
    { name: "composer", scene: "compose", selector: ".composer" },
    { name: "storyboard", scene: "plan", selector: ".storyboard-card" },
    { name: "export", scene: "export", selector: ".modal-layer .modal" },
    { name: "exportProgress", scene: "exporting", selector: ".modal-layer .modal" },
    { name: "inspector", scene: "effects", selector: ".side" },
    { name: "effects", scene: "effects", selector: ".library" },
  ];
  const DROP_ATTRS = /^(aria-.*|title|tabindex|role|spellcheck|focusable|accept|multiple|draggable|autocomplete|data-held-by|data-gpu.*)$/;
  const HOVERISH = /:(hover|focus|focus-visible|focus-within|active)\b/;

  const parts: Record<string, unknown> = {};
  const live: Array<Element> = [];
  for (const spec of SPECS.filter((s) => s.scene === scene)) {
    const el = document.querySelector(spec.selector);
    if (!el) throw new Error(`${spec.name}: nothing matches ${spec.selector} in the ${scene} scene`);
    const rect = el.getBoundingClientRect();
    const clone = el.cloneNode(true) as Element;
    const from = [el, ...el.querySelectorAll("*")];
    const to = [clone, ...clone.querySelectorAll("*")];
    from.forEach((o, i) => {
      const c = to[i]!;
      // A scrolled panel (the agent's thread, at its newest turn): the runtime scrolls it back there.
      if (o.scrollTop > 0) c.setAttribute("data-ui-scroll", String(Math.round(o.scrollTop)));
      if (o instanceof HTMLTextAreaElement) c.textContent = o.value;
      else if (o instanceof HTMLInputElement) {
        if (o.type === "checkbox" || o.type === "radio") o.checked ? c.setAttribute("checked", "") : c.removeAttribute("checked");
        else if (o.type === "file") return void c.remove();
        else c.setAttribute("value", o.value);
      } else if (o instanceof HTMLCanvasElement) {
        const img = document.createElement("img");
        const box = o.getBoundingClientRect();
        if (o.className) img.className = o.className;
        img.setAttribute("style", `${o.getAttribute("style") ?? ""};width:${box.width}px;height:${box.height}px`);
        try {
          // An effect tile's thumbnail is a picture (JPEG, a quarter the bytes); the rest keep their transparency.
          if (o.width && o.height && box.width) {
            if (o.closest(".fx-thumb")) {
              // An effect tile's thumbnail is a picture: JPEG at the size it's drawn (a fraction of the bytes).
              const small = document.createElement("canvas");
              small.width = Math.round(box.width);
              small.height = Math.round(box.height);
              small.getContext("2d")!.drawImage(o, 0, 0, small.width, small.height);
              img.src = small.toDataURL("image/jpeg", 0.72);
            } else img.src = o.toDataURL("image/png");
          }
        } catch {}
        c.replaceWith(img);
      }
    });
    for (const c of [clone, ...clone.querySelectorAll("*")]) {
      if (c.tagName === "STYLE" || c.tagName === "VIDEO" || c.tagName === "AUDIO") {
        c.remove();
        continue;
      }
      if (c.tagName === "IMG" && !(c.getAttribute("src") ?? "").startsWith("data:")) c.removeAttribute("src");
      for (const a of [...c.attributes]) if (DROP_ATTRS.test(a.name)) c.removeAttribute(a.name);
      const cls = c.getAttribute("class");
      if (cls !== null) cls.trim() ? c.setAttribute("class", cls.trim().replace(/\s+/g, " ")) : c.removeAttribute("class");
    }
    // The Effects tab keeps its filters (the looks); its effect and shader grids would only weigh.
    if (spec.name === "effects") for (const g of clone.querySelectorAll('[data-testid="effects-grid"], [data-testid="shaders-grid"]')) {
      if (g.previousElementSibling?.classList.contains("lib-label")) g.previousElementSibling.remove();
      g.remove();
    }
    // The preview's picture is the author's: the frame keeps its size and background, empty.
    for (const f of clone.querySelectorAll(".frame")) f.replaceChildren();
    const ancestors: Array<{ tag: string; cls: string; attrs: Record<string, string>; vars: string }> = [];
    for (let p = el.parentElement; p && p.id !== "root"; p = p.parentElement) {
      const attrs: Record<string, string> = {};
      for (const a of p.attributes) if (a.name.startsWith("data-") && a.name !== "data-testid") attrs[a.name] = a.value;
      const style = (p as HTMLElement).style;
      const vars = [...Array(style.length).keys()].map((i) => style.item(i)).filter((n) => n.startsWith("--")).map((n) => `${n}:${style.getPropertyValue(n)}`).join(";");
      ancestors.unshift({ tag: p.tagName.toLowerCase(), cls: (p.getAttribute("class") ?? "").trim().replace(/\s+/g, " "), attrs, vars });
    }
    const extra: Record<string, unknown> = {};
    // A part whose own background isn't opaque (the top bar, a tinted card) was drawn over the
    // panel behind it: that colour, the nearest opaque background up the tree, goes behind it (with
    // the part's own corner radius).
    const alpha = (c: string) => {
      if (c === "transparent") return 0;
      const n = (c.match(/[\d.]+/g) ?? []).map(Number);
      return n.length >= 4 ? n[3]! : 1;
    };
    if (alpha(getComputedStyle(el).backgroundColor) < 1) {
      let behind = "rgb(10, 10, 10)";
      for (let p = el.parentElement; p; p = p.parentElement) {
        const c = getComputedStyle(p).backgroundColor;
        if (alpha(c) >= 1) {
          behind = c;
          break;
        }
      }
      extra.backdrop = behind;
      extra.radius = getComputedStyle(el).borderRadius;
    }
    if (spec.name === "timeline") {
      // Where 0 s is and how many px a second is, from the clips as drawn.
      const lane = el.querySelector(".tl-lane")!.getBoundingClientRect();
      const clip = el.querySelector(".clip.video") as HTMLElement;
      const fps = 60;
      extra.pxPerSecond = (clip.getBoundingClientRect().width / Number(clip.dataset.duration)) * fps;
      extra.laneLeft = lane.left - rect.left;
    }
    parts[spec.name] = { html: clone.outerHTML, width: Math.round(rect.width), height: Math.round(rect.height), ancestors, ...extra };
    live.push(el, ...el.querySelectorAll("*"));
    for (let p = el.parentElement; p && p.id !== "root"; p = p.parentElement) live.push(p);
  }

  // The rules that apply to any of those elements.
  const matchesSome = (selector: string) => {
    const bare = selector.replace(/::?(before|after|placeholder|selection|marker|-webkit-[a-z-]+)(\([^)]*\))?/g, "").trim() || "*";
    try {
      return live.some((e) => e.matches(bare));
    } catch {
      return false;
    }
  };
  const splitList = (text: string) => {
    const out: Array<string> = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === "," && depth === 0) {
        out.push(text.slice(from, i).trim());
        from = i + 1;
      }
    }
    out.push(text.slice(from).trim());
    return out.filter(Boolean);
  };
  const ROOTISH = /^(:root|html|body|#root)$/;
  const rules: Array<{ key: string; selectors: Array<string>; body: string; rootish: boolean }> = [];
  const keyframes = new Map<string, string>();
  const walk = (list: CSSRuleList, key: string) => {
    [...list].forEach((rule, i) => {
      const k = `${key}.${String(i).padStart(5, "0")}`;
      if (rule instanceof CSSStyleRule) {
        const selectors = splitList(rule.selectorText).filter((s) => !HOVERISH.test(s));
        const rootish = selectors.filter((s) => ROOTISH.test(s));
        const kept = selectors.filter((s) => !ROOTISH.test(s) && (s === "*" || matchesSome(s)));
        if (rootish.length) rules.push({ key: `${k}a`, selectors: rootish, body: rule.style.cssText, rootish: true });
        if (kept.length) rules.push({ key: `${k}b`, selectors: kept, body: rule.style.cssText, rootish: false });
      } else if (rule instanceof CSSMediaRule) {
        if (matchMedia(rule.conditionText).matches) walk(rule.cssRules, k);
      } else if (rule instanceof CSSSupportsRule) {
        if (CSS.supports(rule.conditionText)) walk(rule.cssRules, k);
      } else if (rule instanceof CSSKeyframesRule) keyframes.set(rule.name, rule.cssText);
    });
  };
  [...document.styleSheets].forEach((sheet, i) => {
    try {
      walk(sheet.cssRules, String(i).padStart(3, "0"));
    } catch {}
  });
  return { parts, rules, keyframes: Object.fromEntries(keyframes) };
}
