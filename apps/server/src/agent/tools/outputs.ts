// project_check's findings (D90) and the music list as the agent reads them.
import { type Check, type Project, type CheckRule, type SoundProfile, disabledChecks, projectChecks, soundProfileText } from "@uncut/core";
import { type IntendedRef, isIntended } from "@uncut/core/skills";

/** One finding as project_check returns it (D90): frames are the edit's. */
const checkOut = (c: Check, fps: number) => ({
  rule: c.id,
  severity: c.severity,
  message: c.message,
  ...(c.itemIds?.length ? { items: c.itemIds } : {}),
  ...(c.frame !== undefined ? { frame: c.frame, seconds: Number((c.frame / fps).toFixed(2)) } : {}),
  ...(c.range ? { range: c.range } : {}),
  ...(c.fix ? { fix: { summary: c.fix.summary, ops: c.fix.ops } } : {}),
  ...(c.hint ? { hint: c.hint } : {}),
});

/** D198: findings of these rules are errors: what they name is drawn wrong (a font that falls back), never a matter of taste. */
export const FONT_ERRORS: ReadonlySet<string> = new Set(["font-missing"]);

/** project_check's answer (D90): the project's checks, optionally only some rules or one severity. */
export function checksOut(
  project: Project,
  revision: number,
  filter: { readonly rules?: ReadonlyArray<string> | undefined; readonly severity?: string | undefined } = {},
  plugins: {
    readonly rules?: ReadonlyArray<CheckRule>;
    readonly found?: ReadonlyArray<Check>;
    readonly notes?: ReadonlyArray<string>;
    readonly errors?: ReadonlySet<string>;
    readonly sound?: SoundProfile;
    readonly intended?: ReadonlyArray<IntendedRef>;
  } = {},
) {
  // Plugin rules (D103): the allowed plugins' data rules run with the built-ins; process plugins' findings are added.
  const off = new Set(disabledChecks(project));
  const errorIds = plugins.errors ?? new Set<string>();
  const rank = (c: Check) => (errorIds.has(c.id) ? -1 : c.severity === "warn" ? 0 : 1);
  const fps = project.canvas.fps;
  // D217: the sound rule at the video's profile; sound findings the user marked Intended left out.
  const marked = (c: Check) =>
    c.id === "sound" &&
    isIntended(
      {
        kind: "sound",
        rule: c.key.split(":").slice(0, 2).join(":"),
        ...(c.frame !== undefined ? { at: Math.round((c.frame / fps) * 100) / 100 } : {}),
        ...(c.range ? { to: Math.round((c.range.end / fps) * 100) / 100 } : {}),
      },
      plugins.intended,
    );
  const found = [
    ...projectChecks(project, { rules: plugins.rules ?? [], ...(plugins.sound ? { sound: plugins.sound } : {}) }),
    ...(plugins.found ?? []).filter((c) => !off.has(c.id)),
  ];
  const all = found.filter((c) => !marked(c)).sort((a, b) => rank(a) - rank(b) || (a.frame ?? Infinity) - (b.frame ?? Infinity));
  const intended = found.length - all.length;
  const picked = all.filter((c) => (!filter.rules?.length || filter.rules.includes(c.id)) && (!filter.severity || c.severity === filter.severity));
  const errors = picked.filter((c) => errorIds.has(c.id)).length;
  const warnings = picked.filter((c) => c.severity === "warn").length - errors;
  const disabled = disabledChecks(project);
  return {
    revision,
    ...(errors ? { errors } : {}),
    warnings,
    notes: picked.length - warnings - errors,
    checks: picked.map((c) => (errorIds.has(c.id) ? { ...checkOut(c, fps), severity: "error" } : checkOut(c, fps))),
    ...(disabled.length ? { disabled } : {}),
    ...(plugins.sound ? { soundProfile: soundProfileText(plugins.sound) } : {}),
    ...(intended ? { intended: `${intended} sound finding${intended === 1 ? "" : "s"} the user marked Intended left out` } : {}),
    ...(plugins.notes?.length ? { pluginNotes: plugins.notes } : {}),
    note: errors
      ? "Fix every error first: it is drawn wrong as it is (a missing font falls back to another one). Then fix each warning (a fix's ops go into timeline_edit as they are, with your baseRevision) or tell the user why it's right as it is. Info notes are suggestions."
      : picked.length
        ? "Fix each warning (a fix's ops go into timeline_edit as they are, with your baseRevision) or tell the user why it's right as it is. Info notes are suggestions. Checks never block the export."
        : "Nothing to fix.",
  };
}
