import type { Brief, AgentPlan } from "@uncut/contracts";
import { soundProfileText } from "@uncut/core/checks";
import { isVideoType, VIDEO_TYPE_NAMES, soundProfileFor, VIDEO_TYPES } from "@uncut/core/skills";
import { X, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp, actions } from "../../state/store.ts";

/** D217 (issue #45): the project's skills on the latest Brief card: on ones with a one-click remove, suggested ones to add. */
function BriefSkills({ brief, online }: { brief: Brief; online: boolean }) {
  const brand = useApp().brand;
  if (!brand) return null;
  const on = brand.active.skills;
  const suggested = (brief.skills ?? []).filter((id) => !on.includes(id) && brand.skills.some((x) => x.id === id));
  const name = (id: string) => brand.skills.find((x) => x.id === id)?.name ?? id;
  const set = (skills: ReadonlyArray<string>) => void actions.brandSetActive({ kit: brand.active.kit, skills: [...skills] });
  return (
    <div className="brief-row" data-testid="brief-skills">
      <span className="brief-key">Skills</span>
      <span className="brief-chips">
        {on.map((id) => (
          <button key={id} className="chip-btn active" data-testid={`brief-skill-on-${id}`} disabled={!online} title={`Turn ${name(id)} off for this project`} onClick={() => set(on.filter((x) => x !== id))}>
            {name(id)}
            <X />
          </button>
        ))}
        {suggested.map((id) => (
          <button key={id} className="chip-btn" data-testid={`brief-skill-add-${id}`} disabled={!online} title={`Turn ${name(id)} on for this project`} onClick={() => set([...on, id])}>
            <Plus />
            {name(id)}
          </button>
        ))}
        {!on.length && !suggested.length && <span className="muted">None</span>}
      </span>
    </div>
  );
}

export function BriefBody({ brief, live }: { brief: Brief; live?: CardLive | undefined }) {
  const brand = useApp().brand;
  const active = brand?.active.skills ?? [];
  const type = isVideoType(brief.type) ? VIDEO_TYPE_NAMES[brief.type] : "";
  const sound = soundProfileText(soundProfileFor(brief, active));
  const rows: Array<[string, string]> = [
    ["Film", brief.film],
    ["Type", type],
    ["Audience", brief.audience],
    ["Length", brief.duration],
    ["Formats", brief.formats.join(", ")],
    ["Assets", brief.assets.join(", ")],
    ["Look", brief.visual],
    ["Never", brief.hardLines.join("; ")],
    ["Deliver", brief.deliverables.join(", ")],
    ["Notes", brief.notes ?? ""],
  ];
  // The latest card follows the project's skills (the agent or the Brand tab may have changed them).
  useEffect(() => {
    if (live) void actions.brandGet();
  }, [live?.plan.brief?.updatedAt]);
  return (
    <div className="brief-rows" data-testid="agent-brief-rows">
      {rows
        .filter(([, v]) => v.trim())
        .map(([k, v]) => (
          <div key={k} className="brief-row">
            <span className="brief-key">{k}</span>
            <span>{v}</span>
          </div>
        ))}
      {live && (
        <div className="brief-row" data-testid="brief-sound">
          <span className="brief-key">Sound</span>
          <span>{sound.charAt(0).toUpperCase() + sound.slice(1)}</span>
        </div>
      )}
      {live && <BriefSkills brief={brief} online={live.online} />}
    </div>
  );
}

/** What the latest card of its type can do (D197): edit the brief, approve the storyboard. */
export interface CardLive {
  readonly plan: AgentPlan;
  readonly online: boolean;
  readonly busy: boolean;
  /** A storyboard approval card is open. */
  readonly waiting: boolean;
}

const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);

/** The brief as a form (the user's edit, D188). */
export function BriefForm({ brief, onDone }: { brief: Brief; onDone: () => void }) {
  const [b, setB] = useState(brief);
  const [saving, setSaving] = useState(false);
  const field = (key: "film" | "audience" | "duration" | "visual" | "notes", label: string, rows = 1) => (
    <label className="brief-field">
      <span className="brief-key">{label}</span>
      {rows > 1 ? <textarea className="field input" rows={rows} data-testid={`plan-brief-${key}`} value={b[key] ?? ""} onChange={(e) => setB({ ...b, [key]: e.target.value })} /> : <input className="field input" data-testid={`plan-brief-${key}`} value={b[key] ?? ""} onChange={(e) => setB({ ...b, [key]: e.target.value })} />}
    </label>
  );
  const list = (key: "formats" | "assets" | "hardLines" | "deliverables", label: string) => (
    <label className="brief-field">
      <span className="brief-key">{label}</span>
      <textarea className="field input" rows={2} data-testid={`plan-brief-${key}`} value={b[key].join("\n")} onChange={(e) => setB({ ...b, [key]: lines(e.target.value) })} />
    </label>
  );
  return (
    <div className="brief-form" data-testid="plan-brief-form">
      {field("film", "Film", 2)}
      <label className="brief-field">
        <span className="brief-key">Type</span>
        <select className="field input" data-testid="plan-brief-type" value={b.type ?? ""} onChange={(e) => setB(e.target.value ? { ...b, type: e.target.value } : (({ type: _t, ...rest }) => rest)(b))}>
          <option value="">Not set</option>
          {VIDEO_TYPES.map((t) => (
            <option key={t} value={t}>
              {VIDEO_TYPE_NAMES[t]}
            </option>
          ))}
        </select>
      </label>
      {field("audience", "Audience")}
      {field("duration", "Length")}
      {list("formats", "Formats")}
      {list("assets", "Assets")}
      {field("visual", "Look", 2)}
      {list("hardLines", "Never")}
      {list("deliverables", "Deliver")}
      {field("notes", "Notes", 2)}
      <div className="approval-btns">
        <button className="btn ghost" data-testid="plan-brief-cancel" onClick={onDone}>
          Cancel
        </button>
        <button
          className="btn primary"
          data-testid="plan-brief-save"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            if (await actions.agentPlanSave({ brief: b })) onDone();
            setSaving(false);
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
