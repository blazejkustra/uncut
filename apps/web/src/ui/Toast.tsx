// An error toast (#67, D239) that closes itself after toastMs(text), stops counting while the
// pointer is over it or focus is in it, and keeps its close button. A new `token` (the store's
// notice object, fresh for every refusal) starts the count again, even for the same text.
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { toastMs } from "./toast.ts";
import "./toast.css";

export function ErrorToast({ text, token, onClose, testId }: { text: string; token: unknown; onClose: () => void; testId?: string }) {
  const ms = toastMs(text);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const left = useRef(ms);
  const counted = useRef<unknown>(token);
  // The timer line restarts with each new token too.
  const gen = useRef({ token, n: 0 });
  if (gen.current.token !== token) gen.current = { token, n: gen.current.n + 1 };
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (counted.current !== token) {
      counted.current = token;
      left.current = ms;
    }
    if (paused) return;
    const from = performance.now();
    const t = setTimeout(() => close.current(), left.current);
    return () => {
      clearTimeout(t);
      left.current = Math.max(0, left.current - (performance.now() - from));
    };
  }, [paused, token, ms]);

  return (
    <div
      className="banner error toast"
      data-testid={testId}
      data-auto-close={ms}
      data-paused={paused}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
    >
      <span className="banner-text">{text}</span>
      <button className="icon-btn" title="Dismiss" onClick={onClose}>
        <X />
      </button>
      <span key={gen.current.n} className="toast-timer" style={{ animationDuration: `${ms}ms` }} />
    </div>
  );
}
