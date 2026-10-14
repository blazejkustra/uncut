// Renaming in place (T7, G4): a text field over a name; Enter or leaving it saves, Esc cancels.
import { useEffect, useRef } from "react";

export function RenameField({ value, onDone, testId }: { value: string; onDone: (name: string | undefined) => void; testId: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (name: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      ref={ref}
      className="renaming"
      data-testid={testId}
      defaultValue={value}
      aria-label="Name"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(undefined);
      }}
      // Switching to another app keeps the edit open (as in Finder); clicking elsewhere in Uncut saves it.
      onBlur={(e) => document.hasFocus() && finish(e.currentTarget.value)}
    />
  );
}
