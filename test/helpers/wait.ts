// Waiting on real conditions instead of fixed sleeps (#89). A fixed sleep before an assertion is
// either too long (slow suite) or too short under a full run's load (a flake); a poll with a
// generous deadline is neither: it returns as soon as the condition holds.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Generous by default: a loaded machine (a full run, another file's export) is slow, a pass is still instant. */
export const WAIT_MS = 15000;

type Truthy<T> = Exclude<T, false | 0 | "" | null | undefined>;

/**
 * Polls `check` until it returns something truthy, and returns that. Throws after `timeout` ms
 * with `what` and the last value (or the last error `check` threw), so a failure says what it saw.
 */
export async function until<T>(check: () => T | Promise<T>, what: string, { timeout = WAIT_MS, interval = 100 } = {}): Promise<Truthy<T>> {
  const end = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value as Truthy<T>;
      last = value;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= end) {
      const seen = last instanceof Error ? last.message : JSON.stringify(last);
      throw new Error(`Waited ${timeout / 1000} s for ${what}; last saw ${seen}`);
    }
    await sleep(interval);
  }
}

/** Polls `read` until it returns the same value `times` reads in a row (`interval` ms apart), and returns it. */
export async function settled<T>(read: () => T | Promise<T>, what: string, { timeout = WAIT_MS, interval = 50, times = 3 } = {}): Promise<T> {
  const end = Date.now() + timeout;
  let last = JSON.stringify(await read());
  let same = 1;
  for (;;) {
    await sleep(interval);
    const value = await read();
    const now = JSON.stringify(value);
    same = now === last ? same + 1 : 1;
    last = now;
    if (same >= times) return value;
    if (Date.now() >= end) throw new Error(`Waited ${timeout / 1000} s for ${what} to stop changing; last saw ${now}`);
  }
}

/**
 * Polls `check` until it's truthy, for up to `timeout` ms, and says whether it got there. For a
 * wait followed by its own assertion (which then reports what it saw): no throw here.
 */
export async function eventually(check: () => unknown, { timeout = WAIT_MS, interval = 100 } = {}): Promise<boolean> {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      if (await check()) return true;
    } catch {}
    if (Date.now() >= end) return false;
    await sleep(interval);
  }
}
