// The Brand tab (D186): the open project's kit and skills, the kits (logos, colours, fonts, voice,
// examples and a style guide the agent writes from a reference) and the skills (production
// recipes). Kits and skills live in the user's library (every project picks from it; D198) or are
// pinned to this project; an editor works on a draft and saves it explicitly (Esc or Cancel drop
// it). D198: logos show as pictures; logos and font files come in from a file, a folder or an
// https address; a font with its file is loaded everywhere text is drawn.
import type { BrandKit, BrandScope, BrandSkill } from "@uncut/contracts";
import { Plus, X } from "lucide-react";
import { useState } from "react";

import { actions, brandFileUrl, getState, useApp } from "../state/store.ts";
import { BUILTIN_SKILLS } from "@uncut/core/skills";
import { type View, draftOfKit, freeId, emptyKit, SCOPE_LABEL, LOGO_BACKDROP } from "./brand/kit.ts";
import { KitEditor } from "./brand/KitEditor.tsx";
import { BuiltinSkillView, SkillEditor } from "./brand/SkillEditor.tsx";
import { ThisProject } from "./brand/ThisProject.tsx";
import { Swatches, ScopeChoice } from "./brand/parts.tsx";
export { freeId } from "./brand/kit.ts";

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
  // D207: a built-in skill is read-only; New skill from one (or its Duplicate) opens a copy to edit.
  const newSkill = (t?: Pick<BrandSkill, "name" | "description" | "body">) => {
    setSkillMenu(false);
    setView({ kind: "skill", id: undefined, scope: "global", draft: { name: t ? `${t.name} copy` : "", scope: "global", description: t?.description ?? "", body: t?.body ?? "" } });
  };
  const builtins = brand?.skills.filter((s) => s.builtin) ?? [];
  const yours = brand?.skills.filter((s) => !s.builtin) ?? [];

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
      ) : view.kind === "builtin" ? (
        <BuiltinSkillView skill={brand.skills.find((s) => s.id === view.id)} online={online} onDuplicate={(s) => newSkill(s)} onClose={() => setView({ kind: "list" })} />
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
                {BUILTIN_SKILLS.map((t) => (
                  <button key={t.id} className="chip-btn" data-testid={`brand-skill-new-${t.id.replace(/^builtin-/, "")}`} onClick={() => newSkill(t)}>
                    {t.name}
                  </button>
                ))}
              </div>
            )}
            <span className="lib-label brand-sub" data-testid="brand-skills-yours">Yours</span>
            {yours.length === 0 && <div className="muted small">No skills of your own yet; duplicate a built-in one to make it yours</div>}
            {yours.map((s) => (
              <button key={`${s.scope}:${s.id}`} className="brand-row" data-testid={`brand-skill-${s.id}`} onClick={() => openSkill(s)}>
                <span className="brand-row-top">
                  <span className="brand-row-name ellipsis">{s.name}</span>
                  <span className="brand-tag">{SCOPE_LABEL[s.scope]}</span>
                </span>
                {s.description && <span className="brand-desc">{s.description}</span>}
              </button>
            ))}
            <span className="lib-label brand-sub" data-testid="brand-skills-builtin">Built-in</span>
            {builtins.map((s) => (
              <button key={s.id} className="brand-row" data-testid={`brand-skill-${s.id}`} onClick={() => setView({ kind: "builtin", id: s.id })}>
                <span className="brand-row-top">
                  <span className="brand-row-name ellipsis">{s.name}</span>
                  <span className="brand-tag">Built-in</span>
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
