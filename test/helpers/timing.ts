// Timing budgets that hold on a slower machine (#89). A test that guards against a slow algorithm
// (an O(n²) check, a parse that holds the event loop) sets its budget for a developer's Apple-silicon
// Mac; GitHub's macOS runners (3 virtual cores) run the same JavaScript about 1.2-1.5× slower, so a
// fixed budget there fails by a few percent without anything having regressed. `slowdown()` times a
// fixed reference workload (CPU time, best of several) and says how much slower this machine is than
// the reference Mac; `budget(ms)` scales a budget by it. Never below 1: a faster machine keeps the
// original budget. UNCUT_TEST_SLOWDOWN overrides the measurement.

/** CPU ms of `work()` on the reference machine (M-series MacBook Pro, Node 24). */
const REFERENCE_MS = 25;

/** Strings, objects, a sort and a Map: the shape of the code the budgets guard. */
function work() {
  const rows = Array.from({ length: 60000 }, (_, i) => ({ id: `r${(i * 7919) % 60000}`, n: (i * 31) % 997, text: `item ${i} ${i % 13}` }));
  rows.sort((a, b) => a.id.localeCompare(b.id) || a.n - b.n);
  const byN = new Map<number, number>();
  for (const r of rows) byN.set(r.n, (byN.get(r.n) ?? 0) + r.text.length);
  return byN.size;
}

const cpuMs = (fn: () => unknown) => {
  const t0 = process.cpuUsage();
  fn();
  const used = process.cpuUsage(t0);
  return (used.user + used.system) / 1000;
};

let measured: number | undefined;

/** How many times slower than the reference Mac this machine runs the reference workload (≥ 1). */
export function slowdown() {
  if (measured !== undefined) return measured;
  const forced = Number(process.env.UNCUT_TEST_SLOWDOWN);
  if (forced > 0) return (measured = forced);
  work();
  let best = Infinity;
  for (let run = 0; run < 7; run++) best = Math.min(best, cpuMs(work));
  return (measured = Math.max(1, best / REFERENCE_MS));
}

/** `ms` scaled for this machine (see slowdown). */
export const budget = (ms: number) => ms * slowdown();

/** The reference workload's best CPU time here, for calibrating REFERENCE_MS. */
export const referenceMs = () => {
  work();
  let best = Infinity;
  for (let run = 0; run < 7; run++) best = Math.min(best, cpuMs(work));
  return best;
};
