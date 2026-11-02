/** At most `size` holders at once; the rest wait in order. `take` resolves to the release, once only. */
export const makeSlots = (size: number) => {
  let busy = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else busy--;
  };
  const once = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  };
  const take = (signal?: AbortSignal): Promise<() => void> =>
    new Promise((resolve, reject) => {
      if (busy < size) {
        busy++;
        return resolve(once());
      }
      const grant = () => {
        signal?.removeEventListener("abort", leave);
        resolve(once());
      };
      const leave = () => {
        waiting.splice(waiting.indexOf(grant), 1);
        reject(signal?.reason);
      };
      waiting.push(grant);
      signal?.addEventListener("abort", leave, { once: true });
    });
  return { take, active: () => busy, queued: () => waiting.length };
};

export type Slots = ReturnType<typeof makeSlots>;
