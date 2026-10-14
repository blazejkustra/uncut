// A double click on an element on the canvas (F23, D162) asks the Inspector to focus the element's
// main text field (component/schema.ts mainTextParam) with its text selected. The request waits for
// the element's Inspector to mount (the selection and the Inspector tab change first).
const listeners = new Set<() => void>();
let pending: string | undefined;

export function requestTextFocus(itemId: string) {
  pending = itemId;
  for (const l of listeners) l();
}

/** Calls `focus` now and on every later request for `itemId`, while subscribed; it says whether it focused. */
export function onTextFocus(itemId: string, focus: () => boolean): () => void {
  const check = () => {
    if (pending !== itemId) return;
    // A few frames: the field may not be laid out yet (the tab switch, the section opening).
    let tries = 0;
    const attempt = () => {
      if (pending !== itemId) return;
      if (focus()) pending = undefined;
      else if (++tries < 20) requestAnimationFrame(attempt);
      else pending = undefined;
    };
    requestAnimationFrame(attempt);
  };
  listeners.add(check);
  check();
  return () => void listeners.delete(check);
}
