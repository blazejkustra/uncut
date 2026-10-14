// What a plugin adds as data (D103): text looks, components and check rules declared in its
// manifest's `contributes`. Nothing a plugin wrote runs in Uncut's process or the editor's
// renderer: looks are numbers the core draws, rules are declarative and evaluated here (a
// process plugin's own `check` tool is called by the server), and a component is an HTML/CSS
// template that only ever runs in the graphics sandbox (D78): adding one writes
// componentGraphicHtml into the project's graphics/ folder and inserts a graphic item.
//
// Browser-safe and pure: the server reads manifests (schema-checked by validateModule first) and
// hands the renderer the result; the renderer and the agent compile the same rules.
import { CHECK_IDS, textLabel, type CheckContext, type CheckRule, type CheckSeverity } from "../checks/checks.ts";
import { TEXT_STYLES, type TextLook } from "../text/looks.ts";
import { COMPONENTS } from "../visual/components.ts";
import { SOLID, textPlacement, wordCount } from "../visual/render.ts";
import type { ModuleManifest } from "../timeline/types.ts";
import type { LookDef } from "../visual/fx.ts";

/** Which plugin a contribution came from (the grids' source label). */
export interface FromPlugin {
  readonly plugin: string;
  readonly pluginName: string;
}

export type PluginLook = TextLook & FromPlugin;

export interface PluginComponent extends FromPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly params: { readonly [key: string]: unknown };
  /** The params' defaults (each property's `default`). */
  readonly defaults: { readonly [key: string]: unknown };
  readonly template: string;
  readonly css: string;
  readonly version: string;
}

export type RuleSpec =
  | { readonly type: "max-words"; readonly max: number }
  | { readonly type: "banned-phrases"; readonly phrases: ReadonlyArray<string> }
  | { readonly type: "min-text-size"; readonly px: number }
  | { readonly type: "end-card"; readonly seconds?: number }
  | { readonly type: "process" };

export interface PluginRule extends FromPlugin {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly severity: CheckSeverity;
  readonly hint?: string;
  readonly rule: RuleSpec;
}

/** A colour look for the Effects tab's filters (D136, `contributes.filters`): numbers core's colour maths draws. */
export interface PluginFilter extends FromPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly look: LookDef;
}

export interface Contributions {
  readonly looks: ReadonlyArray<PluginLook>;
  readonly components: ReadonlyArray<PluginComponent>;
  readonly rules: ReadonlyArray<PluginRule>;
  readonly filters: ReadonlyArray<PluginFilter>;
}

export const NO_CONTRIBUTIONS: Contributions = { looks: [], components: [], rules: [], filters: [] };

/** Every id a built-in look, component or check rule has (contributions can't take one). */
export const BUILTIN_CONTRIBUTION_IDS: ReadonlySet<string> = new Set([...Object.keys(TEXT_STYLES), ...COMPONENTS.map((c) => c.id), ...CHECK_IDS]);

// Plugin markup never gets script: no <script>, no inline event handlers, no javascript: URLs
// (the sandbox would contain them anyway; this keeps a template a template).
const SCRIPTY = /<\s*script|\bon[a-z]+\s*=|<\s*\/?\s*(iframe|object|embed|base|meta|link|form|frame|frameset|portal)\b/i;
// A script URL however it's spelled: entities decoded (&#106; &#x6A; &colon; &Tab; &NewLine;) and
// whitespace and control characters dropped before looking (browsers ignore them in a scheme).
const NAMED: Readonly<Record<string, string>> = { colon: ":", tab: "", newline: "", sol: "/", lpar: "(", rpar: ")" };
const unentity = (s: string) =>
  s.replace(/&#x([0-9a-f]+);?|&#([0-9]+);?|&([a-z]+);/gi, (m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex || dec) {
      const code = parseInt(hex ?? dec!, hex ? 16 : 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return NAMED[name!.toLowerCase()] ?? m;
  });
const SCRIPT_URL = /(javascript|vbscript|livescript):|data:text\/html/i;
const hasScriptUrl = (s: string) => SCRIPT_URL.test(unentity(unentity(s)).replace(/[\s\u0000-\u001f\u007f]+/g, ""));

/** Why a component's template or CSS is refused, or undefined. */
export function componentProblem(template: string, css: string): string | undefined {
  if (SCRIPTY.test(template) || hasScriptUrl(template)) return "its template has a script, an event handler or an embedded page, and component templates are plain HTML";
  if (/</.test(css)) return "its css has a <, and component CSS is plain CSS";
  if (hasScriptUrl(css)) return "its css has a script URL, and component CSS is plain CSS";
  return undefined;
}

type RawContributes = {
  readonly looks?: ReadonlyArray<{ id: string; name: string; description?: string; look: Record<string, unknown> }>;
  readonly components?: ReadonlyArray<{ id: string; name: string; description?: string; params?: Record<string, unknown>; template: string; css?: string }>;
  readonly rules?: ReadonlyArray<{ id: string; title: string; description?: string; severity?: CheckSeverity; hint?: string; rule: RuleSpec }>;
  readonly filters?: ReadonlyArray<{ id: string; name: string; description?: string; look: LookDef }>;
};

/**
 * A plugin's contributions from its (schema-valid) manifest. An entry is left out, with one
 * sentence in `warnings`, when its id isn't namespaced by the plugin's id, a built-in has it
 * (`reserved`: BUILTIN_CONTRIBUTION_IDS plus the built-in module ids), an earlier plugin or entry
 * took it (`taken`, filled as entries are accepted), its template has script, a look's moves
 * aren't built-in moves (`moves`), a look's `with` names a look that isn't built in or the
 * plugin's own, or a "process" rule comes from a plugin that runs no program.
 */
export function readContributions(
  manifest: ModuleManifest,
  options: { readonly reserved: ReadonlySet<string>; readonly moves: ReadonlySet<string>; readonly taken?: Set<string> },
): { readonly contributions: Contributions; readonly warnings: ReadonlyArray<string> } {
  const raw = (manifest.contributes ?? {}) as RawContributes;
  const from: FromPlugin = { plugin: manifest.id, pluginName: manifest.name };
  const warnings: Array<string> = [];
  const taken = options.taken ?? new Set<string>();
  const accept = (id: string, what: string) => {
    // Owned by exactly one plugin id: the plugin's id, a dot and one name (no more dots), so a
    // plugin with a shorter id (taste) can't take a longer one's names (taste.extra.x).
    if (!id.startsWith(`${manifest.id}.`) || id.slice(manifest.id.length + 1).includes(".")) warnings.push(`Its ${what} ${id} is left out: its id must be the plugin's id, ${manifest.id}, a dot and one name.`);
    else if (options.reserved.has(id) || BUILTIN_CONTRIBUTION_IDS.has(id)) warnings.push(`Its ${what} ${id} is left out: a built-in has that id.`);
    else if (taken.has(id)) warnings.push(`Its ${what} ${id} is left out: another plugin (or entry) has that id.`);
    else {
      taken.add(id);
      return true;
    }
    return false;
  };
  const ownLooks = new Set((raw.looks ?? []).map((l) => l.id));
  const looks: Array<PluginLook> = [];
  for (const entry of raw.looks ?? []) {
    const look = entry.look as { animation?: Record<string, { module?: string } | undefined>; with?: ReadonlyArray<{ look: string }> };
    const badMove = Object.values(look.animation ?? {}).find((m) => !m?.module || !options.moves.has(m.module));
    if (badMove) {
      warnings.push(`Its look ${entry.id} is left out: its move ${badMove?.module ?? "(none)"} isn't one of Uncut's moves.`);
      continue;
    }
    const badWith = (look.with ?? []).find((w) => !Object.hasOwn(TEXT_STYLES, w.look) && !ownLooks.has(w.look));
    if (badWith) {
      warnings.push(`Its look ${entry.id} is left out: it comes with ${badWith.look}, which isn't a built-in look or one of its own.`);
      continue;
    }
    if (!accept(entry.id, "look")) continue;
    looks.push({ font: "sans", tracking: 0, lineHeight: 1.1, color: "fg", text: entry.name, ...(entry.look as object), id: entry.id, name: entry.name, description: entry.description ?? "", ...from } as PluginLook);
  }
  const components: Array<PluginComponent> = [];
  for (const entry of raw.components ?? []) {
    const css = entry.css ?? "";
    const problem = componentProblem(entry.template, css);
    if (problem) {
      warnings.push(`Its component ${entry.id} is left out: ${problem}.`);
      continue;
    }
    if (!accept(entry.id, "component")) continue;
    const params = (entry.params ?? { type: "object", properties: {} }) as { properties?: Record<string, { default?: unknown }> };
    const defaults = Object.fromEntries(Object.entries(params.properties ?? {}).flatMap(([k, v]) => (v && typeof v === "object" && v.default !== undefined ? [[k, v.default]] : [])));
    components.push({ id: entry.id, name: entry.name, description: entry.description ?? "", params, defaults, template: entry.template, css, version: manifest.version, ...from });
  }
  const runsProgram = (manifest.runtime as { type?: string } | undefined)?.type === "process";
  const rules: Array<PluginRule> = [];
  for (const entry of raw.rules ?? []) {
    if (entry.rule.type === "process" && !runsProgram) {
      warnings.push(`Its check ${entry.id} is left out: a "process" rule needs a plugin that runs a program.`);
      continue;
    }
    if (!accept(entry.id, "check")) continue;
    rules.push({ id: entry.id, title: entry.title, description: entry.description ?? "", severity: entry.severity ?? "warn", ...(entry.hint ? { hint: entry.hint } : {}), rule: entry.rule, ...from });
  }
  const filters: Array<PluginFilter> = [];
  for (const entry of raw.filters ?? []) {
    if (!accept(entry.id, "filter")) continue;
    filters.push({ id: entry.id, name: entry.name, description: entry.description ?? "", look: entry.look, ...from });
  }
  return { contributions: { looks, components, rules, filters }, warnings };
}

/**
 * Several plugins' contributions as one, in the order given; an id a plugin earlier in the list
 * already has is dropped (ids are owned per plugin id, so this only happens to the same plugin id).
 * The server merges only allowed plugins, so a plugin nobody allowed can't take an id.
 */
export function mergeContributions(list: ReadonlyArray<Contributions>): Contributions {
  const seen = new Set<string>();
  const fresh = <T extends { readonly id: string }>(x: T) => !seen.has(x.id) && (seen.add(x.id), true);
  return { looks: list.flatMap((c) => c.looks).filter(fresh), components: list.flatMap((c) => c.components).filter(fresh), rules: list.flatMap((c) => c.rules).filter(fresh), filters: list.flatMap((c) => c.filters ?? []).filter(fresh) };
}

// ---- rules ----

const secs = (frames: number, fps: number) => `${(Math.round((frames / fps) * 10) / 10).toFixed(1)} s`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile(spec: PluginRule): CheckRule["check"] | undefined {
  const rule = spec.rule;
  const by = spec.pluginName;
  const hint = spec.hint ? { hint: spec.hint } : {};
  switch (rule.type) {
    case "max-words":
      return (ctx: CheckContext) =>
        ctx.texts.flatMap((p) => {
          if (!textLabel(p.item.text)) return [];
          const showing = ctx.texts.filter((o) => o.start <= p.start && p.start < o.start + o.item.duration);
          const words = showing.reduce((n, o) => n + wordCount(o.item.text ?? ""), 0);
          if (words <= rule.max) return [];
          return [
            {
              key: `${spec.id}:${p.item.id}`,
              message: `${words} words are on screen when "${textLabel(p.item.text)}" comes in; ${by} keeps it to ${rule.max}.`,
              itemIds: showing.map((o) => o.item.id),
              frame: p.start,
              range: { start: p.start, end: p.start + p.item.duration },
              ...(spec.hint ? hint : { hint: "Cut words, or show the texts one after the other." }),
            },
          ];
        });
    case "banned-phrases": {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])(${rule.phrases.map((p) => escapeRe(p.trim()).replace(/\s+/g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`, "iu");
      return (ctx: CheckContext) =>
        ctx.texts.flatMap((p) => {
          const found = re.exec(p.item.text ?? "");
          if (!found) return [];
          return [
            {
              key: `${spec.id}:${p.item.id}`,
              message: `"${textLabel(p.item.text)}" says "${found[1]!.replace(/\s+/g, " ")}", a phrase ${by} asks to leave out.`,
              itemIds: [p.item.id],
              frame: p.start,
              range: { start: p.start, end: p.start + p.item.duration },
              ...(spec.hint ? hint : { hint: "Say it plainly in other words." }),
            },
          ];
        });
    }
    case "min-text-size":
      return (ctx: CheckContext) =>
        ctx.texts.flatMap((p) => {
          if (!textLabel(p.item.text)) return [];
          const px = textPlacement(p.item, ctx.project).size / ctx.scale;
          if (px + 0.5 >= rule.px) return [];
          return [
            {
              key: `${spec.id}:${p.item.id}`,
              message: `"${textLabel(p.item.text)}" is ${Math.round(px)} px tall; ${by} asks for at least ${rule.px} px.`,
              itemIds: [p.item.id],
              frame: p.start,
              ...(spec.hint ? hint : { hint: "Make it bigger in the Inspector's Style tab." }),
            },
          ];
        });
    case "end-card": {
      const seconds = rule.seconds ?? 2;
      return (ctx: CheckContext) => {
        if (ctx.end <= 0) return [];
        const need = Math.round(seconds * ctx.fps);
        const last = ctx.end - 1;
        const ok = ctx.project.tracks.some(
          (t) =>
            !t.hidden &&
            t.kind === "video" &&
            t.items.some((i) => {
              // A background (component.solid) isn't an end card.
              if ((i.type !== "component" || i.component === SOLID) && i.type !== "graphic") return false;
              const s = ctx.starts.get(i.id) ?? 0;
              return s <= last && last < s + i.duration && ctx.end - s >= need;
            }),
        );
        if (ok) return [];
        return [{ key: spec.id, message: `The video doesn't end on an end card; ${by} asks for one over the last ${secs(need, ctx.fps)}.`, frame: Math.max(0, ctx.end - need), ...(spec.hint ? hint : { hint: "Add an end card from the Elements tab at the end." }) }];
      };
    }
    default:
      return undefined;
  }
}

/** The check rules core evaluates (every rule but "process" ones, which the server asks the plugin for). */
export function pluginCheckRules(rules: ReadonlyArray<PluginRule>): Array<CheckRule> {
  return rules.flatMap((r) => {
    const check = compile(r);
    return check ? [{ id: r.id, title: r.title, description: r.description, severity: r.severity, check }] : [];
  });
}

/** Every plugin rule as a registry entry (titles in the Checks tab), process ones included (they find nothing here). */
export function pluginRuleEntries(rules: ReadonlyArray<PluginRule>): Array<CheckRule> {
  return rules.map((r) => ({ id: r.id, title: r.title, description: r.description, severity: r.severity, check: compile(r) ?? (() => []) }));
}

// ---- components ----

/** JSON for inside a <script>: no "<" (so no </script>), no U+2028/2029. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));

/**
 * A plugin component as a graphic file's HTML (D78's render(t, info)): the template with every
 * {{name}} replaced by the item's props (else the params' defaults), HTML-escaped, inside a
 * full-canvas root whose --t (seconds) and --progress (0 to 1 over the item) the CSS can use. The
 * only script is this one, Uncut's; it runs in the graphics sandbox (strict CSP, no network) in
 * the preview's iframe and in the export's rasteriser, so preview == export.
 */
export function componentGraphicHtml(component: Pick<PluginComponent, "id" | "template" | "css" | "defaults">): string {
  // Nothing the plugin wrote goes into the comment unchecked: the id must have the schema's shape.
  const id = /^[a-z0-9][a-z0-9.-]*$/.test(component.id) ? component.id : "(plugin component)";
  const html = `<!-- Uncut component ${id}, copied from its plugin into the project (D103) -->
<style>#uncut-component{position:absolute;inset:0}
${component.css}</style>
<div id="uncut-component"></div>
<script>(() => {
  const template = ${scriptJson(component.template)};
  const defaults = ${scriptJson(component.defaults)};
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const root = document.getElementById("uncut-component");
  window.render = (t, info) => {
    const props = Object.assign({}, defaults, (info && info.props) || {});
    root.innerHTML = template.replace(/\\{\\{\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\}\\}/g, (_, k) => (Object.prototype.hasOwnProperty.call(props, k) && props[k] !== null && props[k] !== undefined && typeof props[k] !== "object" ? esc(props[k]) : ""));
    root.style.setProperty("--t", String(t));
    root.style.setProperty("--progress", String(info && info.duration > 0 ? Math.min(1, Math.max(0, info.frame / info.duration)) : 0));
  };
  window.render(0, { frame: 0, duration: 0, props: {} });
})();</script>
`;
  // The last word: the only script in it is Uncut's own (one opening, one closing tag).
  if ((html.match(/<\s*script/gi) ?? []).length !== 1 || (html.match(/<\s*\/\s*script/gi) ?? []).length !== 1 || (html.match(/<\s*\/\s*style/gi) ?? []).length !== 1 || !/<\/style>\n<div id="uncut-component"><\/div>\n<script>/.test(html)) throw new Error(`The component ${id} can't be drawn safely.`);
  return html;
}

/** The graphics/ file name a plugin component is copied to (n > 1: another version of it). */
export const componentGraphicName = (id: string, n = 1) => `${id}${n > 1 ? `-${n}` : ""}.html`;
