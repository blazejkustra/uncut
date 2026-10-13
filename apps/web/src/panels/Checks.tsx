// The Checks tab (D90): the project's taste checks (core projectChecks, the same list the agent's
// project_check returns), warnings first, then suggestions. Clicking a finding selects its item and
// moves the playhead there; Fix applies its suggested edit (one undoable edit, labelled in History);
// a rule can be turned off for the project (checks.disabled) and back on. Checks never block export.
import { checkRule, disabledChecks, projectChecks, type Check } from "@uncut/core/checks";
import { CircleAlert, Info, ListChecks, Wand2, EyeOff } from "lucide-react";

import { playback } from "../preview/playback.ts";
import { actions, type Project } from "../state/store.ts";

// Snapshots are immutable: one list per project object.
const memo = new WeakMap<Project, ReadonlyArray<Check>>();
export function checksOf(project: Project): ReadonlyArray<Check> {
  let list = memo.get(project);
  if (!list) {
    list = projectChecks(project);
    memo.set(project, list);
  }
  return list;
}
/** How many warnings the project has (the tab's and the export dialog's count). */
export const warningCount = (project: Project) => checksOf(project).filter((c) => c.severity === "warn").length;

export function ChecksPanel({ project, online }: { project: Project; online: boolean }) {
  const checks = checksOf(project);
  const warnings = checks.filter((c) => c.severity === "warn");
  const notes = checks.filter((c) => c.severity === "info");
  const off = disabledChecks(project);
  return (
    <div className="checks" data-testid="checks-panel">
      <div className="history-head">
        <ListChecks />
        <span className="grow">Checks</span>
        <span className="muted small" data-testid="checks-summary">
          {warnings.length ? `${warnings.length} to look at` : "Nothing to look at"}
        </span>
      </div>
      <div className="checks-list">
        {checks.length === 0 && <div className="muted small checks-empty">The video follows the house style as far as these checks can tell. They never block an export.</div>}
        {warnings.length > 0 && <div className="lib-label checks-group">To look at</div>}
        {warnings.map((c) => (
          <Finding key={c.key} check={c} online={online} />
        ))}
        {notes.length > 0 && <div className="lib-label checks-group">Suggestions</div>}
        {notes.map((c) => (
          <Finding key={c.key} check={c} online={online} />
        ))}
        {off.length > 0 && (
          <div className="checks-off" data-testid="checks-off">
            <div className="lib-label checks-group">Turned off for this project</div>
            {off.map((id) => (
              <div key={id} className="checks-off-row" data-testid="check-off" data-rule={id}>
                <span className="grow">{checkRule(id)?.title ?? id}</span>
                <button className="btn ghost small-btn" data-testid="check-enable" disabled={!online} onClick={() => void actions.setCheckDisabled(id, false)}>
                  Turn on
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="hint muted small">Checks follow the house style for short product videos. They're suggestions: the export never waits on them.</div>
      </div>
    </div>
  );
}

function Finding({ check, online }: { check: Check; online: boolean }) {
  const rule = checkRule(check.id);
  const show = () => {
    playback.pause();
    playback.select(check.itemIds?.[0]);
    if (check.frame !== undefined) playback.seek(check.frame);
  };
  return (
    <div className={`check ${check.severity}`} data-testid="check" data-rule={check.id} data-key={check.key}>
      <button className="check-row" data-testid="check-show" title={check.frame !== undefined ? "Show it on the timeline" : undefined} onClick={show}>
        {check.severity === "warn" ? <CircleAlert /> : <Info />}
        <span className="check-label">
          <span className="check-title">{rule?.title ?? check.id}</span>
          <span className="check-message" data-testid="check-message">
            {check.message}
          </span>
          {check.hint && !check.fix && <span className="check-hint">{check.hint}</span>}
        </span>
      </button>
      <div className="check-actions">
        {check.fix && (
          <button className="btn small-btn" data-testid="check-fix" disabled={!online} title={check.fix.summary} onClick={() => void actions.applyCheckFix(check)}>
            <Wand2 />
            Fix
          </button>
        )}
        <button className="btn ghost small-btn" data-testid="check-disable" disabled={!online} title={`Don't check "${rule?.title ?? check.id}" in this project`} onClick={() => void actions.setCheckDisabled(check.id, true)}>
          <EyeOff />
          Turn off
        </button>
      </div>
    </div>
  );
}
