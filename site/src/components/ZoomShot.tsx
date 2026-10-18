"use client";
// The hero's editor screenshot, which opens almost full screen on click: a fixed overlay with a copy of
// the image that grows from the screenshot's place (FLIP on transform) and shrinks back on close
// (click, Escape or a real scroll). The original stays in the layout, hidden while the copy is up.
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";

const MARGIN = 0.04;

/** The transform that puts an element laid out at `to` over the rect `from`. */
function fromRect(from: DOMRect, to: DOMRect): string {
  const s = from.width / to.width;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${s})`;
}

export default function ZoomShot(props: ComponentProps<"img">) {
  const shot = useRef<HTMLImageElement>(null);
  const big = useRef<HTMLImageElement>(null);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const closing = useRef(false);

  // Opening: lay the copy out at its final size, start it over the screenshot, then let it grow.
  useEffect(() => {
    const el = big.current;
    const src = shot.current;
    if (!open || !el || !src) return;
    el.style.transition = "none";
    el.style.transform = fromRect(src.getBoundingClientRect(), el.getBoundingClientRect());
    void el.offsetWidth;
    el.style.transition = "";
    el.style.transform = "";
    setShown(true);
  }, [open]);

  const close = () => {
    const el = big.current;
    const src = shot.current;
    if (!el || !src || closing.current) return;
    closing.current = true;
    setShown(false);
    el.style.transform = fromRect(src.getBoundingClientRect(), el.getBoundingClientRect());
    const done = () => { closing.current = false; setOpen(false); };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return done();
    el.addEventListener("transitionend", done, { once: true });
    setTimeout(() => { if (closing.current) done(); }, 600);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const y = scrollY;
    const onScroll = () => { if (Math.abs(scrollY - y) > 40) close(); };
    addEventListener("keydown", onKey);
    addEventListener("scroll", onScroll, { passive: true });
    return () => { removeEventListener("keydown", onKey); removeEventListener("scroll", onScroll); };
  }, [open]);

  return (
    <>
      <button type="button" className="shot-zoom" aria-label="View the editor screenshot larger" onClick={() => setOpen(true)} style={{ visibility: open ? "hidden" : undefined }}>
        <img ref={shot} {...props} />
      </button>
      {open && createPortal(
        <div className={shown ? "zoom open" : "zoom"} role="dialog" aria-modal="true" aria-label="Editor screenshot" onClick={close}>
          <img ref={big} className="zoom-img" src={props.src} alt={props.alt} style={{ maxWidth: `${100 - MARGIN * 200}vw`, maxHeight: `${100 - MARGIN * 200}vh` }} />
        </div>,
        document.body,
      )}
    </>
  );
}
