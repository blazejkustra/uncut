import type { BrandState } from "@uncut/contracts";
import { actions } from "../../state/store.ts";

export function ThisProject({ brand, hasProject, online }: { brand: BrandState; hasProject: boolean; online: boolean }) {
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
          {[...brand.skills.filter((s) => !s.builtin), ...brand.skills.filter((s) => s.builtin)].map((s) => {
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
