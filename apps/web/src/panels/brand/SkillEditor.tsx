import type { BrandState, BrandSkill } from "@uncut/contracts";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { actions } from "../../state/store.ts";
import { type View, freeId } from "./kit.ts";
import { EditorFrame, ScopeChoice } from "./parts.tsx";

export function SkillEditor({ brand, view, hasProject, online, onDraft, onClose }: { brand: BrandState; view: Extract<View, { kind: "skill" }>; hasProject: boolean; online: boolean; onDraft: (d: Extract<View, { kind: "skill" }>["draft"]) => void; onClose: () => void }) {
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
        <span className="lib-label">Instructions</span>
        <textarea className="gen-prompt brand-text brand-mono" data-testid="brand-skill-body" spellCheck={false} value={d.body} onChange={(e) => set({ body: e.target.value })} />
      </div>
    </EditorFrame>
  );
}

/**
 * D207, D232: a plugin's skill (Uncut's own come from the bundled uncut.skills), read-only: its
 * instructions, Use in chat (/name in the composer) and a Duplicate that opens an editable copy.
 */
export function SkillView({ skill, online, hasProject, onUse, onDuplicate, onClose }: { skill: BrandSkill | undefined; online: boolean; hasProject: boolean; onUse: (s: BrandSkill) => void; onDuplicate: (s: BrandSkill) => void; onClose: () => void }) {
  return (
    <div
      className="brand-editor"
      data-testid="skill-view"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="brand-editor-head">
        <button className="icon-btn" title="Back" data-testid="brand-back" onClick={onClose}>
          <ChevronLeft />
        </button>
        <span className="ellipsis">{skill?.name ?? "Skill"}</span>
        <span className="brand-tag">/{skill?.id ?? ""}</span>
      </div>
      <div className="brand-body">
        <div className="lib-section">
          {skill?.description && <div className="brand-desc">{skill.description}</div>}
          <div className="muted small">
            {skill?.pluginName ? `From the plugin ${skill.pluginName}, read-only.` : "Read-only."} The agent reads it when it fits; Use in chat calls it with /{skill?.id ?? ""}. Duplicate it to change it.
          </div>
          <pre className="brand-skill-read selectable" data-testid="skill-view-body">
            {skill?.body ?? ""}
          </pre>
        </div>
      </div>
      <div className="brand-foot">
        <button className="btn ghost" data-testid="brand-duplicate" disabled={!online || !skill} onClick={() => skill && onDuplicate(skill)}>
          Duplicate
        </button>
        <span className="brand-foot-gap" />
        <button className="btn ghost" data-testid="brand-cancel" onClick={onClose}>
          Close
        </button>
        <button className="btn primary" data-testid="skill-use" disabled={!skill || !hasProject} title={hasProject ? undefined : "Open a project to use the agent"} onClick={() => skill && onUse(skill)}>
          Use in chat
        </button>
      </div>
    </div>
  );
}
