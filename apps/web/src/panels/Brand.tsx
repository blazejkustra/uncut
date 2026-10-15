// The Brand tab (D186, D232): Make a kit from a reference first (it calls the make-brand-kit skill
// in the composer: the agent asks a few questions, takes a link or dropped logos and builds the
// kit), the open project's kit, and the kits (logos, colours, fonts, voice, examples and a style
// guide the agent writes from a reference). Skills have their own tab since D232 (Skills.tsx).
// Kits live in the user's library (every project picks from it; D198) or are pinned to this
// project; an editor works on a draft and saves it explicitly (Esc or Cancel drop it). D198: logos show as pictures; logos and font files come in from a file, a folder or an
// https address; a font with its file is loaded everywhere text is drawn.
import type { BrandKit, BrandScope } from "@uncut/contracts";
import { Plus, Sparkles, X } from "lucide-react";
import { useState } from "react";

import { actions, brandFileUrl, getState, useApp } from "../state/store.ts";
import { BUILTIN_IDS } from "@uncut/core/skills";
import { type View, draftOfKit, freeId, emptyKit, SCOPE_LABEL, LOGO_BACKDROP } from "./brand/kit.ts";
import { KitEditor } from "./brand/KitEditor.tsx";
import { ThisProject } from "./brand/ThisProject.tsx";
import { Swatches, ScopeChoice } from "./brand/parts.tsx";
import "./skills/skills.css";
export { freeId } from "./brand/kit.ts";

export function BrandLibrary() {
  const app = useApp();
  const brand = app.brand;
  const online = app.connection === "connected";
  const hasProject = app.snapshot !== null;
  const [view, setView] = useState<View>({ kind: "list" });
  const [newKit, setNewKit] = useState<{ name: string; scope: BrandScope } | undefined>();

  const openKit = (k: BrandKit) => setView({ kind: "kit", id: k.id, scope: k.scope, draft: draftOfKit(k) });
  // D232: the kit maker is a skill (the bundled make-brand-kit); without it installed the button says so.
  const kitSkill = brand?.skills.some((s) => s.id === BUILTIN_IDS.brandKit);

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
      ) : (
        <div className="brand-body">
          <div className="lib-section">
            <div className="brand-hero" data-testid="brand-hero">
              <span className="brand-hero-title">Make a kit from a reference</span>
              <span className="brand-desc">Give the agent your site's link, or drop your logos and pictures in the chat. It asks a few questions, then builds the kit: logos, colours, fonts and tone. You can change anything here after.</span>
              <button
                className="btn primary"
                data-testid="brand-make-from-reference"
                disabled={!online || !hasProject || !kitSkill}
                title={!hasProject ? "Open a project to use the agent" : !kitSkill ? "The make-brand-kit skill isn't installed (Uncut skills plugin)" : undefined}
                onClick={() => actions.composeSkill(BUILTIN_IDS.brandKit)}
              >
                <Sparkles />
                Make from reference
              </button>
              {!hasProject && <span className="muted small">Open a project to use the agent.</span>}
            </div>
          </div>
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
