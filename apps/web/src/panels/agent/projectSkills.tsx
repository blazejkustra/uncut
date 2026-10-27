// The open project's own Claude Code skills load only after the user says yes (the security review
// of 9d372be: a shared or downloaded project can carry skills). Asked again when they change.
import { useState } from "react";
import { actions, useApp } from "../../state/store.ts";

export function ProjectSkillsCard() {
  const { brand, connection } = useApp();
  const [busy, setBusy] = useState(false);
  const ask = brand?.projectSkillsAsk;
  if (!ask) return null;
  const answer = async (load: boolean) => {
    setBusy(true);
    await actions.brandTrustProjectSkills(ask.key, load);
    setBusy(false);
  };
  const off = busy || connection !== "connected";
  return (
    <div className="approval project-skills" data-testid="project-skills-ask">
      <strong>Load this project's skills?</strong>
      <span className="small">
        This project folder brings its own Claude Code skills: {ask.names.join(", ")}. Load them only if you trust where the project came from.
      </span>
      <div className="approval-btns">
        <button className="btn ghost" data-testid="project-skills-skip" disabled={off} onClick={() => void answer(false)}>
          Not now
        </button>
        <button className="btn primary" data-testid="project-skills-load" disabled={off} onClick={() => void answer(true)}>
          Load skills
        </button>
      </div>
    </div>
  );
}
