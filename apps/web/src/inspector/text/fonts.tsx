// The font picker (D129): a button showing the font in itself, opening a searchable list where each
// name is drawn in its own font. The bundled DM Sans and DM Mono (D77) first, then the system's
// stacks, then the fonts installed on this Mac: read with queryLocalFonts when the list is first
// opened (Chromium asks for the local-fonts permission, which the app grants), else a curated list
// of fonts macOS ships. The preview and the export (Chromium on this Mac) draw a family by name, so
// both show the same font; a remote project's server needs it installed too.
import { useMemo, useRef, useState } from "react";

import { Popover } from "../controls.tsx";

/** Fonts every Mac has (a fallback for when the installed list can't be read). */
export const MAC_FONTS = [
  "Helvetica Neue",
  "Avenir Next",
  "Futura",
  "Gill Sans",
  "Optima",
  "Arial",
  "Arial Black",
  "Verdana",
  "Trebuchet MS",
  "Impact",
  "Georgia",
  "Baskerville",
  "Didot",
  "Times New Roman",
  "Palatino",
  "Hoefler Text",
  "Rockwell",
  "Copperplate",
  "American Typewriter",
  "Courier New",
  "Menlo",
  "Marker Felt",
  "Chalkboard SE",
  "Noteworthy",
  "Bradley Hand",
  "Snell Roundhand",
] as const;

/** A family name the renderer accepts (core resolveFont's SAFE_FONT). */
const SAFE = /^[a-zA-Z0-9 _-]+$/;

/** What each special value is called, and how its option is drawn. */
const SPECIAL: ReadonlyArray<readonly [string, string, string]> = [
  ["", "Default", "-apple-system, BlinkMacSystemFont, sans-serif"],
  ["DM Sans", "DM Sans", "'DM Sans'"],
  ["DM Mono", "DM Mono", "'DM Mono'"],
  ["mono", "System mono", "ui-monospace, Menlo, monospace"],
];

let installed: Promise<Array<string>> | undefined;
/** The installed families (once per session); [] when the browser can't list them. */
function installedFonts(): Promise<Array<string>> {
  if (installed) return installed;
  const query = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts;
  installed = query
    ? query()
        .then((fonts) => [...new Set(fonts.map((f) => f.family))].filter((f) => SAFE.test(f) && !f.startsWith(".")).sort((a, b) => a.localeCompare(b)))
        .catch(() => [])
    : Promise.resolve([]);
  return installed;
}

export const fontLabel = (font: string) => SPECIAL.find(([v]) => v === font)?.[1] ?? font;
const fontCss = (font: string) => SPECIAL.find(([v]) => v === font)?.[2] ?? `'${font}'`;

export function FontPicker({ value, onPick, testId, disabled }: { value: string; onPick: (font: string) => void; testId: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [local, setLocal] = useState<Array<string> | undefined>(undefined);
  const anchor = useRef<HTMLButtonElement>(null);
  const others = local?.length ? local : [...MAC_FONTS];
  const q = query.trim().toLowerCase();
  const list = useMemo(() => {
    const special = SPECIAL.filter(([, label]) => !q || label.toLowerCase().includes(q)).map(([v]) => v);
    const rest = others.filter((f) => !SPECIAL.some(([v]) => v === f) && (!q || f.toLowerCase().includes(q)));
    return { special, rest };
  }, [q, others]);
  const pick = (font: string) => {
    setOpen(false);
    setQuery("");
    if (font !== value) onPick(font);
  };
  return (
    <>
      <button
        ref={anchor}
        className="pselect font-btn"
        data-testid={testId}
        data-font={value}
        disabled={disabled}
        style={{ fontFamily: fontCss(value) }}
        onClick={() => {
          // Read the installed fonts on this click (queryLocalFonts needs a user gesture).
          if (!open && !local) void installedFonts().then(setLocal);
          setOpen(!open);
        }}
      >
        {fontLabel(value)}
      </button>
      {open && (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} testId={`${testId}-popover`} width={260}>
          <input className="field input ppop-search" data-testid={`${testId}-search`} placeholder="Search fonts" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
              const first = [...list.special, ...list.rest][0];
              if (e.key === "Enter" && first !== undefined) pick(first);
            }} />
          <div className="font-list">
            {[...list.special, ...list.rest].map((f, i) => (
              <button key={f || "default"} className={`font-opt ${f === value ? "active" : ""} ${i === list.special.length && list.special.length ? "sep" : ""}`} data-testid={`${testId}-option`} data-font={f} style={{ fontFamily: fontCss(f) }} onClick={() => pick(f)}>
                {fontLabel(f)}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}
