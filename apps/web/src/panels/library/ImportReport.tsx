// What an import couldn't bring in (failed files with why, skipped ones with the reason) and a
// Dismiss. Media shows it; so does the agent centre stage (D266), where a drop on the card would
// otherwise fail out of sight under its backdrop.
import { actions, useApp } from "../../state/store.ts";

export function ImportReport({ testId = "import-report", className = "" }: { testId?: string; className?: string }) {
  const { importReport } = useApp();
  if (!importReport) return null;
  return (
    <div className={`import-report ${className}`.trim()} data-testid={testId} role="status">
      {importReport.failed.map((f) => (
        <div key={`f-${f.path}`} className="import-line error">
          <span className="ellipsis" title={f.path}>
            {f.path.split("/").pop()}
          </span>
          <span>{f.message}</span>
        </div>
      ))}
      {importReport.skipped.map((s) => (
        <div key={`s-${s.path}`} className="import-line">
          <span className="ellipsis" title={s.path}>
            {s.path.split("/").pop()}
          </span>
          <span>{s.reason}</span>
        </div>
      ))}
      <button className="link-btn" onClick={actions.dismissImportReport}>
        Dismiss
      </button>
    </div>
  );
}
