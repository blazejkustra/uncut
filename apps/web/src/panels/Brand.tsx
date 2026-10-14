// The Brand tab (D186): the open project's kit and skills, the kits (logos, colours, fonts, voice,
// examples and a style guide the agent writes from a reference) and the skills (production
// recipes). Kits and skills live in the user's library (every project picks from it; D198) or are
// pinned to this project; an editor works on a draft and saves it explicitly (Esc or Cancel drop
// it). D198: logos show as pictures; logos and font files come in from a file, a folder or an
// https address; a font with its file is loaded everywhere text is drawn.
import type { BrandKit, BrandScope, BrandSkill, BrandState } from "@uncut/contracts";
import { ChevronLeft, FolderOpen, Plus, Sparkles, Trash2, Type, X } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { actions, brandFileUrl, getState, useApp } from "../state/store.ts";
import { SKILL_TEMPLATES } from "./brandTemplates.ts";

const COLOR_ROLES = ["background", "surface", "text", "primary", "accent", "muted"] as const;
const FONT_ROLES = ["headline", "body", "mono"] as const;
const LOGO_SLOTS = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "mark", label: "Mark" },
] as const;
type LogoSlot = (typeof LOGO_SLOTS)[number]["id"];
const SCOPE_LABEL: Record<BrandScope, string> = { global: "Library", project: "Pinned here" };
const SCOPE_CHOICE: Record<BrandScope, string> = { global: "Library", project: "Pin to this project" };
const LOGO_BACKDROP: Record<LogoSlot, string> = { light: "#ffffff", dark: "#111111", mark: "#808080" };
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** An id like the server's slug, not taken by `taken`. */
export function freeId(name: string, taken: ReadonlyArray<string>, fallback: string): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || fallback;
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

interface KitDraft {
  readonly name: string;
  readonly scope: BrandScope;
  readonly logos: Partial<Record<LogoSlot, string>>;
  readonly colors: ReadonlyArray<{ readonly hex: string; readonly role: string; readonly name?: string | undefined }>;
  readonly fonts: ReadonlyArray<{ readonly family: string; readonly role: string; readonly weight?: number | undefined; readonly file?: string | undefined }>;
  readonly tone: string;
  readonly taglines: string;
  readonly urls: string;
  readonly dos: string;
  readonly donts: string;
  readonly examples: ReadonlyArray<string>;
}
const draftOfKit = (k: BrandKit): KitDraft => ({
  name: k.name,
  scope: k.scope,
  logos: { ...k.logos },
  colors: k.colors.map((c) => ({ ...c })),
  fonts: k.fonts.map((f) => ({ ...f })),
  tone: k.tone,
  taglines: k.taglines.join("\n"),
  urls: k.urls.join("\n"),
  dos: k.dos.join("\n"),
  donts: k.donts.join("\n"),
  examples: [...k.examples],
});
const emptyKit = (id: string, name: string, scope: BrandScope): BrandKit => ({ id, name, scope, logos: {}, colors: [], fonts: [], tone: "", taglines: [], urls: [], dos: [], donts: [], examples: [] });

type View =
  | { readonly kind: "list" }
  | { readonly kind: "kit"; readonly id: string; readonly scope: BrandScope; readonly draft: KitDraft }
  | { readonly kind: "skill"; readonly id: string | undefined; readonly scope: BrandScope; readonly draft: { readonly name: string; readonly scope: BrandScope; readonly description: string; readonly body: string } };

export function BrandLibrary() {
  const app = useApp();
  const brand = app.brand;
  const online = app.connection === "connected";
  const hasProject = app.snapshot !== null;
  const [view, setView] = useState<View>({ kind: "list" });
  const [newKit, setNewKit] = useState<{ name: string; scope: BrandScope } | undefined>();
  const [skillMenu, setSkillMenu] = useState(false);

  const openKit = (k: BrandKit) => setView({ kind: "kit", id: k.id, scope: k.scope, draft: draftOfKit(k) });
  const openSkill = (s: BrandSkill) => setView({ kind: "skill", id: s.id, scope: s.scope, draft: { name: s.name, scope: s.scope, description: s.description, body: s.body } });
  const newSkill = (t?: (typeof SKILL_TEMPLATES)[number]) => {
    setSkillMenu(false);
    setView({ kind: "skill", id: undefined, scope: "global", draft: { name: t?.name ?? "", scope: "global", description: t?.description ?? "", body: t?.body ?? "" } });
  };

  const createKit = async () => {
    if (!newKit || !brand) return;
    const name = newKit.name.trim();
    if (!name) return;
    const id = freeId(name, brand.kits.map((k) => k.id), "kit");
    if (!(await actions.brandSaveKit(emptyKit(id, name, newKit.scope)))) return;
    setNewKit(undefined);
    const made = getState().brand?.kits.find((k) => k.id === id && k.scope === newKit.scope);
    if (made) openKit(made);
  };

  return (
    <aside className="library brand-panel" data-testid="brand-library">
      <div className="lib-head">Brand</div>
      {app.brandError && (
        <div className="inline-error small brand-error" data-testid="brand-error">
          <span>{app.brandError}</span>
          <button className="icon-btn" title="Dismiss" data-testid="brand-error-dismiss" onClick={actions.dismissBrandError}>
            <X />
          </button>
        </div>
      )}
      {!brand ? (
        <div className="lib-section muted small" data-testid="brand-loading">
          {online ? "Loading" : "Not connected"}
        </div>
      ) : view.kind === "kit" ? (
        <KitEditor
          key={`${view.scope}:${view.id}`}
          brand={brand}
          view={view}
          hasProject={hasProject}
          online={online}
          // An updater: a picked file lands in the draft as it is when the pick ends, if it's still open.
          onDraft={(f) => setView((v) => (v.kind === "kit" && v.id === view.id && v.scope === view.scope ? { ...v, draft: f(v.draft) } : v))}
          onClose={() => setView({ kind: "list" })}
        />
      ) : view.kind === "skill" ? (
        <SkillEditor brand={brand} view={view} hasProject={hasProject} online={online} onDraft={(draft) => setView({ ...view, draft })} onClose={() => setView({ kind: "list" })} />
      ) : (
        <div className="brand-body">
          <ThisProject brand={brand} hasProject={hasProject} online={online} />
          <div className="lib-section">
            <div className="brand-head">
              <span className="lib-label">Kits</span>
              <button className="btn ghost brand-small-btn" data-testid="brand-new-kit" disabled={!online} onClick={() => setNewKit({ name: "", scope: "global" })}>
                <Plus />
                New kit
              </button>
            </div>
            {brand.kits.length === 0 && <div className="muted small">No kits yet</div>}
            {brand.kits.map((k) => (
              <button key={`${k.scope}:${k.id}`} className="brand-row" data-testid={`brand-kit-${k.id}`} onClick={() => openKit(k)}>
                <span className="brand-row-top">
                  <span className="brand-row-name ellipsis">{k.name}</span>
                  <span className="brand-tag">{SCOPE_LABEL[k.scope]}</span>
                </span>
                {k.colors.length > 0 && <Swatches hexes={k.colors.map((c) => c.hex)} />}
                {(() => {
                  const slot = (["light", "mark", "dark"] as const).find((x) => k.logos[x]);
                  const name = slot ? k.logos[slot]! : undefined;
                  const path = name ? brand.files[k.id]?.[name] : undefined;
                  const src = name && path ? brandFileUrl(k.id, name, path) : undefined;
                  return name ? (
                    <span className="brand-row-logo">
                      <span className="brand-logo-thumb" style={{ background: LOGO_BACKDROP[slot!] }}>
                        {src ? <img src={src} alt={name} draggable={false} /> : null}
                      </span>
                      <span className="brand-file ellipsis">{name}</span>
                    </span>
                  ) : null;
                })()}
                {k.style && <span className="brand-tag">Style guide</span>}
              </button>
            ))}
          </div>
          <div className="lib-section">
            <div className="brand-head">
              <span className="lib-label">Skills</span>
              <button className="btn ghost brand-small-btn" data-testid="brand-skill-new" disabled={!online} onClick={() => setSkillMenu(!skillMenu)}>
                <Plus />
                New skill
              </button>
            </div>
            {skillMenu && (
              <div className="brand-menu" data-testid="brand-skill-new-menu">
                <button className="chip-btn" data-testid="brand-skill-new-blank" onClick={() => newSkill()}>
                  Blank
                </button>
                {SKILL_TEMPLATES.map((t) => (
                  <button key={t.id} className="chip-btn" data-testid={`brand-skill-new-${t.id}`} onClick={() => newSkill(t)}>
                    {t.name}
                  </button>
                ))}
              </div>
            )}
            {brand.skills.length === 0 && <div className="muted small">No skills yet</div>}
            {brand.skills.map((s) => (
              <button key={`${s.scope}:${s.id}`} className="brand-row" data-testid={`brand-skill-${s.id}`} onClick={() => openSkill(s)}>
                <span className="brand-row-top">
                  <span className="brand-row-name ellipsis">{s.name}</span>
                  <span className="brand-tag">{SCOPE_LABEL[s.scope]}</span>
                </span>
                {s.description && <span className="brand-desc">{s.description}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      {newKit && (
        <div className="modal-layer" data-testid="brand-new-kit-modal" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setNewKit(undefined))}>
          <div className="modal confirm-modal">
            <div className="confirm-title">New kit</div>
            <input
              className="field input"
              data-testid="brand-new-kit-name"
              autoFocus
              placeholder="Name"
              maxLength={80}
              value={newKit.name}
              onChange={(e) => setNewKit({ ...newKit, name: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && void createKit()}
            />
            <ScopeChoice value={newKit.scope} hasProject={hasProject} testId="brand-new-kit-scope" onChange={(scope) => setNewKit({ ...newKit, scope })} />
            <div className="confirm-actions">
              <button className="btn ghost" data-testid="brand-new-kit-cancel" onClick={() => setNewKit(undefined)}>
                Cancel
              </button>
              <button className="btn primary" data-testid="brand-new-kit-create" disabled={!online || !newKit.name.trim()} onClick={() => void createKit()}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function Swatches({ hexes }: { hexes: ReadonlyArray<string> }) {
  return (
    <span className="brand-swatches">
      {hexes.slice(0, 12).map((hex, i) => (
        <span key={i} className="brand-swatch" style={{ background: hex }} title={hex} />
      ))}
    </span>
  );
}

function ScopeChoice({ value, onChange, hasProject, testId }: { value: BrandScope; onChange: (scope: BrandScope) => void; hasProject: boolean; testId: string }) {
  return (
    <div className="brand-menu">
      {(["global", "project"] as const).map((s) => (
        <button key={s} className={`chip-btn ${value === s ? "active" : ""}`} data-testid={`${testId}-${s}`} disabled={s === "project" && !hasProject} onClick={() => onChange(s)}>
          {SCOPE_CHOICE[s]}
        </button>
      ))}
    </div>
  );
}

function ThisProject({ brand, hasProject, online }: { brand: BrandState; hasProject: boolean; online: boolean }) {
  const disabled = !hasProject || !online;
  const yours = brand.kits.filter((k) => k.scope === "global");
  const ours = brand.kits.filter((k) => k.scope === "project");
  return (
    <div className="lib-section" data-testid="brand-this-project">
      <span className="lib-label">This project</span>
      {!hasProject && <div className="muted small">No project open</div>}
      <select
        className="field input"
        data-testid="brand-kit-select"
        disabled={disabled}
        value={brand.active.kit ?? ""}
        onChange={(e) => void actions.brandSetActive({ kit: e.target.value || null, skills: brand.active.skills })}
      >
        <option value="">No kit</option>
        {yours.length > 0 && (
          <optgroup label="Library">
            {yours.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </optgroup>
        )}
        {ours.length > 0 && (
          <optgroup label="Pinned to this project">
            {ours.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {brand.skills.length > 0 && (
        <div className="brand-checks">
          {brand.skills.map((s) => {
            const on = brand.active.skills.includes(s.id);
            return (
              <label key={s.id} className="check-row">
                <input
                  type="checkbox"
                  data-testid={`brand-skill-check-${s.id}`}
                  disabled={disabled}
                  checked={on}
                  onChange={() => void actions.brandSetActive({ kit: brand.active.kit, skills: on ? brand.active.skills.filter((x) => x !== s.id) : [...brand.active.skills, s.id] })}
                />
                <span className="ellipsis">{s.name}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The editor's frame: back, the body, Save, Cancel and Delete; Esc drops the draft. */
function EditorFrame({ title, testId, children, onClose, onSave, onDelete, saveDisabled, problem }: { title: string; testId: string; children: React.ReactNode; onClose: () => void; onSave: () => void; onDelete?: (() => void) | undefined; saveDisabled: boolean; problem?: string | undefined }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div
      className="brand-editor"
      data-testid={testId}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        if (confirm) setConfirm(false);
        else onClose();
      }}
    >
      <div className="brand-editor-head">
        <button className="icon-btn" title="Back" data-testid="brand-back" onClick={onClose}>
          <ChevronLeft />
        </button>
        <span className="ellipsis">{title}</span>
      </div>
      <div className="brand-body">{children}</div>
      <div className="brand-foot">
        {problem && <div className="brand-problem small" data-testid="brand-problem">{problem}</div>}
        {onDelete && (
          <button className="btn ghost" data-testid="brand-delete" onClick={() => setConfirm(true)}>
            <Trash2 />
            Delete
          </button>
        )}
        <span className="brand-foot-gap" />
        <button className="btn ghost" data-testid="brand-cancel" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" data-testid="brand-save" disabled={saveDisabled} onClick={onSave}>
          Save
        </button>
      </div>
      {confirm && onDelete && (
        <div className="modal-layer" data-testid="brand-delete-modal">
          <div className="modal confirm-modal">
            <div className="confirm-title">Delete {title}?</div>
            <div className="confirm-text">It goes from every project that uses it.</div>
            <div className="confirm-actions">
              <button className="btn ghost" data-testid="brand-delete-cancel" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn danger"
                data-testid="brand-delete-confirm"
                onClick={() => {
                  setConfirm(false);
                  onDelete();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function KitEditor({ brand, view, hasProject, online, onDraft, onClose }: { brand: BrandState; view: Extract<View, { kind: "kit" }>; hasProject: boolean; online: boolean; onDraft: (f: (d: KitDraft) => KitDraft) => void; onClose: () => void }) {
  const d = view.draft;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>();
  // The kit as saved (the style guide is the agent's: always the saved one).
  const saved = brand.kits.find((k) => k.id === view.id && k.scope === view.scope);
  const files = brand.files[view.id] ?? {};
  const [source, setSource] = useState("");
  // D198: logos and font files from a file, a folder or an address: logos fill the empty slots, fonts become rows (or a family's file).
  const importFrom = async (from: string | undefined) => {
    const what = from?.trim();
    if (!what) return;
    setBusy(true);
    const got = await actions.brandImport(view.id, view.scope, what);
    setBusy(false);
    if (!got) return;
    setSource("");
    onDraft((cur) => {
      const logos = { ...cur.logos };
      for (const f of got) if (f.kind === "logo" && f.slot && !logos[f.slot]) logos[f.slot] = f.name;
      const fonts = [...cur.fonts];
      for (const f of got.filter((x) => x.kind === "font")) {
        const family = f.family ?? f.name;
        const same = fonts.findIndex((x) => x.family.trim().toLowerCase() === family.toLowerCase() && !x.file);
        if (same >= 0) fonts[same] = { ...fonts[same]!, file: f.name };
        else fonts.push({ family, role: fonts.length ? "body" : "headline", file: f.name });
      }
      return { ...cur, logos, fonts };
    });
  };
  const fontFile = async (i: number) => {
    const from = await actions.pickBrandSource();
    if (!from) return;
    const got = await actions.brandImport(view.id, view.scope, from);
    const font = got?.find((f) => f.kind === "font");
    if (font) onDraft((cur) => ({ ...cur, fonts: cur.fonts.map((x, j) => (j === i ? { ...x, file: font.name, family: x.family.trim() || (font.family ?? x.family) } : x)) }));
  };
  const badHex = d.colors.findIndex((c) => !HEX6.test(c.hex.trim()));
  const set = (patch: Partial<KitDraft>) => onDraft((cur) => ({ ...cur, ...patch }));

  const pickInto = async (multi: boolean): Promise<Array<string>> => {
    const paths = await actions.pickBrandFiles();
    const names: Array<string> = [];
    for (const path of multi ? paths : paths.slice(0, 1)) {
      const name = await actions.brandAddFile(view.id, view.scope, path);
      if (name) names.push(name);
    }
    return names;
  };

  const save = async () => {
    if (badHex >= 0 || !d.name.trim()) return;
    setBusy(true);
    const current = getState().brand;
    const style = current?.kits.find((k) => k.id === view.id && k.scope === view.scope)?.style;
    let logos: Partial<Record<LogoSlot, string>> = { ...d.logos };
    let examples = [...d.examples];
    let fontFiles = new Map<string, string>();
    const moving = d.scope !== view.scope;
    if (moving) {
      // The files go with the kit: copied into the new place (maybe under another name); an unpinned project copy then goes.
      const oldFiles = current?.files[view.id] ?? {};
      const renamed = new Map<string, string>();
      for (const name of new Set([...Object.values(logos), ...examples, ...d.fonts.map((f) => f.file)].filter((n): n is string => !!n))) {
        const path = oldFiles[name];
        if (!path) continue;
        const copied = await actions.brandAddFile(view.id, d.scope, path);
        if (!copied) return setBusy(false);
        renamed.set(name, copied);
      }
      const to = (n: string | undefined) => (n === undefined ? undefined : (renamed.get(n) ?? n));
      logos = Object.fromEntries(Object.entries(logos).map(([k, v]) => [k, to(v)]).filter(([, v]) => v !== undefined));
      examples = examples.map((n) => to(n)!);
      fontFiles = new Map(d.fonts.flatMap((f) => (f.file ? [[f.file, to(f.file)!] as const] : [])));
    }
    const kit: BrandKit = {
      id: view.id,
      name: d.name.trim(),
      scope: d.scope,
      logos,
      colors: d.colors.map((c) => ({ hex: c.hex.trim().toLowerCase(), role: c.role, ...(c.name ? { name: c.name } : {}) })),
      fonts: d.fonts.filter((f) => f.family.trim()).map((f) => ({ family: f.family.trim(), role: f.role, ...(f.weight ? { weight: f.weight } : {}), ...(f.file ? { file: fontFiles.get(f.file) ?? f.file } : {}) })),
      tone: d.tone,
      taglines: lines(d.taglines),
      urls: lines(d.urls),
      dos: lines(d.dos),
      donts: lines(d.donts),
      examples,
      ...(style ? { style } : {}),
    };
    let ok = await actions.brandSaveKit(kit);
    // D198: pinning to this project copies the kit (the library keeps it for other projects); unpinning moves it back.
    if (ok && moving && view.scope === "project") ok = await actions.brandDeleteKit(view.id, view.scope);
    setBusy(false);
    if (ok) onClose();
  };

  const remove = async () => {
    setBusy(true);
    const ok = await actions.brandDeleteKit(view.id, view.scope);
    setBusy(false);
    if (ok) onClose();
  };

  const fromReference = async () => {
    setNote(undefined);
    if (getState().agent?.running) return setNote("The agent is busy");
    const [path] = await actions.pickBrandFiles();
    if (!path) return;
    if (getState().agent?.running) return setNote("The agent is busy");
    await actions.agentSend(`Make a style guide for the kit "${saved?.name ?? (d.name.trim() || view.id)}" (${view.id}) from this reference: ${path}`, [], [], { access: "edit" });
    actions.openPanel("agent");
  };

  const style = saved?.style;
  return (
    <EditorFrame
      title={d.name.trim() || "Kit"}
      testId="brand-kit-editor"
      onClose={onClose}
      onSave={() => void save()}
      onDelete={saved ? () => void remove() : undefined}
      saveDisabled={!online || busy || badHex >= 0 || !d.name.trim()}
      problem={badHex >= 0 ? "Colours are #rrggbb" : undefined}
    >
      <div className="lib-section">
        <span className="lib-label">Name</span>
        <input className="field input" data-testid="brand-kit-name" maxLength={80} value={d.name} onChange={(e) => set({ name: e.target.value })} />
        <span className="lib-label">Where</span>
        <ScopeChoice value={d.scope} hasProject={hasProject} testId="brand-kit-scope" onChange={(scope) => set({ scope })} />
      </div>

      <div className="lib-section">
        <span className="lib-label">Logos</span>
        {LOGO_SLOTS.map(({ id, label }) => {
          const name = d.logos[id];
          const src = name && files[name] ? brandFileUrl(view.id, name, files[name]) : undefined;
          return (
          <div key={id} className="brand-line" data-testid={`brand-logo-${id}`}>
            <span className="brand-line-k">{label}</span>
            <span className="brand-logo-thumb" style={{ background: LOGO_BACKDROP[id] }} data-testid={`brand-logo-${id}-thumb`}>
              {src ? <img src={src} alt={name} draggable={false} /> : null}
            </span>
            <span className={`brand-file ellipsis ${name ? "" : "muted"}`} title={name ? files[name] : undefined}>
              {name ?? "None"}
            </span>
            <button
              className="btn ghost brand-small-btn"
              data-testid={`brand-logo-${id}-pick`}
              disabled={!online}
              onClick={() =>
                void pickInto(false).then(([name]) => {
                  if (name) onDraft((cur) => ({ ...cur, logos: { ...cur.logos, [id]: name } }));
                })
              }
            >
              Choose…
            </button>
            {d.logos[id] && (
              <button
                className="icon-btn"
                title="Remove"
                data-testid={`brand-logo-${id}-clear`}
                onClick={() => {
                  const { [id]: _gone, ...rest } = d.logos;
                  set({ logos: rest });
                }}
              >
                <X />
              </button>
            )}
          </div>
          );
        })}
        <div className="brand-line brand-import" data-testid="brand-import">
          <input
            className="field input"
            data-testid="brand-import-source"
            placeholder="File, folder or https address"
            spellCheck={false}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void importFrom(source)}
          />
          <button className="icon-btn" title="Choose a file or folder" data-testid="brand-import-pick" disabled={!online || busy} onClick={() => void actions.pickBrandSource().then((p) => importFrom(p))}>
            <FolderOpen />
          </button>
          <button className="btn ghost brand-small-btn" data-testid="brand-import-go" disabled={!online || busy || !source.trim()} onClick={() => void importFrom(source)}>
            Import
          </button>
        </div>
      </div>

      <div className="lib-section">
        <div className="brand-head">
          <span className="lib-label">Colours</span>
          <button className="icon-btn" title="Add colour" data-testid="brand-color-add" onClick={() => set({ colors: [...d.colors, { hex: "#ffffff", role: d.colors.length ? "accent" : "background" }] })}>
            <Plus />
          </button>
        </div>
        {d.colors.map((c, i) => {
          const ok = HEX6.test(c.hex.trim());
          const patch = (p: Partial<(typeof d.colors)[number]>) => set({ colors: d.colors.map((x, j) => (j === i ? { ...x, ...p } : x)) });
          return (
            <div key={i} className="brand-line" data-testid={`brand-color-${i}`}>
              <span className="brand-swatch big" style={{ background: ok ? c.hex.trim() : "transparent" }} />
              <input className={`field input mono brand-hex ${ok ? "" : "invalid"}`} data-testid={`brand-color-hex-${i}`} value={c.hex} maxLength={7} spellCheck={false} onChange={(e) => patch({ hex: e.target.value })} />
              <select className="field input" data-testid={`brand-color-role-${i}`} value={c.role} onChange={(e) => patch({ role: e.target.value })}>
                {!(COLOR_ROLES as ReadonlyArray<string>).includes(c.role) && <option value={c.role}>{c.role}</option>}
                {COLOR_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <button className="icon-btn" title="Remove" data-testid={`brand-color-remove-${i}`} onClick={() => set({ colors: d.colors.filter((_, j) => j !== i) })}>
                <X />
              </button>
            </div>
          );
        })}
      </div>

      <div className="lib-section">
        <div className="brand-head">
          <span className="lib-label">Fonts</span>
          <button className="icon-btn" title="Add font" data-testid="brand-font-add" onClick={() => set({ fonts: [...d.fonts, { family: "", role: d.fonts.length ? "body" : "headline" }] })}>
            <Plus />
          </button>
        </div>
        {d.fonts.map((f, i) => {
          const patch = (p: Partial<(typeof d.fonts)[number]>) => set({ fonts: d.fonts.map((x, j) => (j === i ? { ...x, ...p } : x)) });
          return (
            <div key={i} className="brand-line" data-testid={`brand-font-${i}`}>
              <input className="field input" data-testid={`brand-font-family-${i}`} placeholder="Family" value={f.family} maxLength={80} onChange={(e) => patch({ family: e.target.value })} />
              <select className="field input brand-font-role" data-testid={`brand-font-role-${i}`} value={f.role} onChange={(e) => patch({ role: e.target.value })}>
                {!(FONT_ROLES as ReadonlyArray<string>).includes(f.role) && <option value={f.role}>{f.role}</option>}
                {FONT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <input
                className="field input mono brand-weight"
                data-testid={`brand-font-weight-${i}`}
                type="number"
                min={100}
                max={900}
                step={100}
                placeholder="400"
                value={f.weight ?? ""}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  patch({ weight: e.target.value && n >= 100 && n <= 900 ? Math.round(n) : undefined });
                }}
              />
              <button className={`icon-btn ${f.file ? "on" : ""}`} title={f.file ? `${f.file}: loaded in graphics, texts and the export` : "Add the font's file"} data-testid={`brand-font-file-${i}`} disabled={!online} onClick={() => void fontFile(i)}>
                <Type />
              </button>
              <button className="icon-btn" title="Remove" data-testid={`brand-font-remove-${i}`} onClick={() => set({ fonts: d.fonts.filter((_, j) => j !== i) })}>
                <X />
              </button>
            </div>
          );
        })}
      </div>

      <div className="lib-section">
        <span className="lib-label">Tone of voice</span>
        <textarea className="gen-prompt brand-text" data-testid="brand-kit-tone" rows={3} value={d.tone} onChange={(e) => set({ tone: e.target.value })} />
        <span className="lib-label">Taglines, one per line</span>
        <textarea className="gen-prompt brand-text" data-testid="brand-kit-taglines" rows={2} value={d.taglines} onChange={(e) => set({ taglines: e.target.value })} />
        <span className="lib-label">URLs, one per line</span>
        <textarea className="gen-prompt brand-text mono" data-testid="brand-kit-urls" rows={2} spellCheck={false} value={d.urls} onChange={(e) => set({ urls: e.target.value })} />
        <span className="lib-label">Do's, one per line</span>
        <textarea className="gen-prompt brand-text" data-testid="brand-kit-dos" rows={3} value={d.dos} onChange={(e) => set({ dos: e.target.value })} />
        <span className="lib-label">Don'ts, one per line</span>
        <textarea className="gen-prompt brand-text" data-testid="brand-kit-donts" rows={3} value={d.donts} onChange={(e) => set({ donts: e.target.value })} />
      </div>

      <div className="lib-section">
        <div className="brand-head">
          <span className="lib-label">Examples</span>
          <button
            className="icon-btn"
            title="Add examples"
            data-testid="brand-example-add"
            disabled={!online}
            onClick={() => void pickInto(true).then((names) => names.length && onDraft((cur) => ({ ...cur, examples: [...cur.examples, ...names.filter((n) => !cur.examples.includes(n))] })))}
          >
            <Plus />
          </button>
        </div>
        {d.examples.length === 0 && <div className="muted small">None</div>}
        {d.examples.map((name, i) => (
          <div key={name} className="brand-line" data-testid={`brand-example-${i}`}>
            <span className="brand-file ellipsis" title={files[name]}>
              {name}
            </span>
            <button className="icon-btn" title="Remove" data-testid={`brand-example-remove-${i}`} onClick={() => set({ examples: d.examples.filter((x) => x !== name) })}>
              <X />
            </button>
          </div>
        ))}
      </div>

      <div className="lib-section" data-testid="brand-style">
        <span className="lib-label">Style guide</span>
        {style ? (
          <div className="brand-style">
            {style.palette.length > 0 && <Swatches hexes={style.palette.map((p) => p.hex)} />}
            <StyleRow label="Type" value={style.type} />
            <StyleRow label="Shot lengths" value={style.shotLengths} />
            <StyleRow label="Transitions" value={style.transitions} />
            <StyleRow label="Camera" value={style.camera} />
            <StyleRow label="Grain" value={style.grain} />
            <StyleRow label="Notes" value={style.notes ?? ""} />
            <StyleRow label="From" value={style.source ?? ""} />
          </div>
        ) : (
          <div className="muted small">None yet</div>
        )}
        <button className="btn brand-wide-btn" data-testid="brand-style-from-reference" disabled={!online || !saved} onClick={() => void fromReference()}>
          <Sparkles />
          Make a style from a reference…
        </button>
        {note && (
          <div className="muted small" data-testid="brand-style-note">
            {note}
          </div>
        )}
      </div>
    </EditorFrame>
  );
}

function StyleRow({ label, value }: { label: string; value: string }) {
  if (!value.trim()) return null;
  return (
    <div className="brand-style-row">
      <span className="brand-line-k">{label}</span>
      <span className="selectable">{value}</span>
    </div>
  );
}

function SkillEditor({ brand, view, hasProject, online, onDraft, onClose }: { brand: BrandState; view: Extract<View, { kind: "skill" }>; hasProject: boolean; online: boolean; onDraft: (d: Extract<View, { kind: "skill" }>["draft"]) => void; onClose: () => void }) {
  const d = view.draft;
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof d>) => onDraft({ ...d, ...patch });
  const save = async () => {
    if (!d.name.trim()) return;
    setBusy(true);
    const id = view.id ?? freeId(d.name, brand.skills.map((s) => s.id), "skill");
    let ok = await actions.brandSaveSkill({ id, name: d.name.trim(), scope: d.scope, description: d.description.trim(), body: d.body });
    if (ok && view.id && d.scope !== view.scope) ok = await actions.brandDeleteSkill(view.id, view.scope);
    setBusy(false);
    if (ok) onClose();
  };
  const remove = async () => {
    if (!view.id) return;
    setBusy(true);
    const ok = await actions.brandDeleteSkill(view.id, view.scope);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <EditorFrame
      title={d.name.trim() || "New skill"}
      testId="brand-skill-editor"
      onClose={onClose}
      onSave={() => void save()}
      onDelete={view.id ? () => void remove() : undefined}
      saveDisabled={!online || busy || !d.name.trim()}
    >
      <div className="lib-section">
        <span className="lib-label">Name</span>
        <input className="field input" data-testid="brand-skill-name" autoFocus={!view.id} maxLength={80} value={d.name} onChange={(e) => set({ name: e.target.value })} />
        <span className="lib-label">Where</span>
        <ScopeChoice value={d.scope} hasProject={hasProject} testId="brand-skill-scope" onChange={(scope) => set({ scope })} />
        <span className="lib-label">Description</span>
        <input className="field input" data-testid="brand-skill-description" maxLength={300} value={d.description} onChange={(e) => set({ description: e.target.value })} />
        <span className="lib-label">Recipe</span>
        <textarea className="gen-prompt brand-text brand-mono" data-testid="brand-skill-body" spellCheck={false} value={d.body} onChange={(e) => set({ body: e.target.value })} />
      </div>
    </EditorFrame>
  );
}
