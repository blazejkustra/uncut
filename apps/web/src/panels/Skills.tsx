// The Skills tab (D232, issue #60): every installed skill, from plugins (Uncut's own come with the
// bundled uncut.skills) and the user's own. Nothing to pick: the agent sees each skill's name and
// description and reads one when it fits; the user calls one with /name in the composer (Use in
// chat puts it there). More skills come with plugins (Get more skills: the plugins in setup).
import type { BrandSkill } from "@uncut/contracts";
import { Plus, Puzzle, X } from "lucide-react";
import { useEffect, useState } from "react";

import { actions, useApp } from "../state/store.ts";
import { type View, SCOPE_LABEL } from "./brand/kit.ts";
import { SkillEditor, SkillView } from "./brand/SkillEditor.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";
import "./skills/skills.css";

export function SkillsLibrary() {
  const app = useApp();
  const brand = app.brand;
  const online = app.connection === "connected";
  const hasProject = app.snapshot !== null;
  const [view, setView] = useState<View>({ kind: "list" });
  // Fresh when the tab opens: a plugin installed or allowed since brings its skills.
  useEffect(() => {
    if (online) void actions.brandGet();
  }, [online]);

  const openSkill = (s: BrandSkill) =>
    s.plugin ? setView({ kind: "builtin", id: s.id }) : setView({ kind: "skill", id: s.id, scope: s.scope, draft: { name: s.name, scope: s.scope, description: s.description, body: s.body } });
  const newSkill = (t?: Pick<BrandSkill, "name" | "description" | "body">) =>
    setView({ kind: "skill", id: undefined, scope: "global", draft: { name: t ? `${t.name} copy` : "", scope: "global", description: t?.description ?? "", body: t?.body ?? "" } });
  const use = (s: BrandSkill) => actions.composeSkill(s.id);

  const fromPlugins = brand?.skills.filter((s) => s.plugin) ?? [];
  const yours = brand?.skills.filter((s) => !s.plugin) ?? [];
  // Grouped by plugin, Uncut's own first.
  const groups = [...new Set(fromPlugins.map((s) => s.pluginName ?? s.plugin!))].sort((a, b) => Number(fromPlugins.find((s) => (s.pluginName ?? s.plugin) === b)?.builtin ?? false) - Number(fromPlugins.find((s) => (s.pluginName ?? s.plugin) === a)?.builtin ?? false));

  const row = (s: BrandSkill) => (
    <button key={`${s.scope}:${s.id}`} className="brand-row" data-testid={`skill-${s.id}`} onClick={() => openSkill(s)}>
      <span className="brand-row-top">
        <span className="brand-row-name ellipsis">{s.name}</span>
        {!s.plugin && <span className="brand-tag">{SCOPE_LABEL[s.scope]}</span>}
        <span className="skill-call">/{s.id}</span>
      </span>
      {s.description && <span className="brand-desc">{s.description}</span>}
    </button>
  );

  return (
    <aside className="library brand-panel skills-panel" data-testid="skills-library">
      <div className="lib-head">Skills</div>
      {app.brandError && (
        <div className="inline-error small brand-error" data-testid="brand-error">
          <span>{app.brandError}</span>
          <Tooltip label="Dismiss">
            <button className="icon-btn" data-testid="brand-error-dismiss" onClick={actions.dismissBrandError}>
              <X />
            </button>
          </Tooltip>
        </div>
      )}
      {!brand ? (
        <div className="lib-section muted small" data-testid="skills-loading">
          {online ? "Loading" : "Not connected"}
        </div>
      ) : view.kind === "builtin" ? (
        <SkillView skill={brand.skills.find((s) => s.id === view.id)} online={online} hasProject={hasProject} onUse={use} onDuplicate={(s) => newSkill(s)} onClose={() => setView({ kind: "list" })} />
      ) : view.kind === "skill" ? (
        <SkillEditor brand={brand} view={view} hasProject={hasProject} online={online} onDraft={(draft) => setView({ ...view, draft })} onClose={() => setView({ kind: "list" })} />
      ) : (
        <div className="brand-body">
          <div className="lib-section">
            <div className="skills-intro small" data-testid="skills-intro">
              Installed skills are always on: the agent reads one when it fits your request. To call one yourself, type <kbd>/</kbd> in the chat.
            </div>
            <button className="btn brand-wide-btn" data-testid="skills-get-more" disabled={!online} onClick={() => actions.openPlugins()}>
              <Puzzle />
              Get more skills with plugins
            </button>
          </div>
          {groups.map((g) => (
            <div key={g} className="lib-section" data-testid="skills-group">
              <span className="lib-label">{g}</span>
              {fromPlugins.filter((s) => (s.pluginName ?? s.plugin) === g).map(row)}
            </div>
          ))}
          <div className="lib-section">
            <div className="brand-head">
              <span className="lib-label" data-testid="skills-yours">Yours</span>
              <button className="btn ghost brand-small-btn" data-testid="skills-new" disabled={!online} onClick={() => newSkill()}>
                <Plus />
                New skill
              </button>
            </div>
            {yours.length === 0 && <div className="muted small">None yet; duplicate a plugin's skill to make your own version</div>}
            {yours.map(row)}
          </div>
        </div>
      )}
    </aside>
  );
}
