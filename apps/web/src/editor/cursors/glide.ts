// D348: how an agent's cursor moves through its stops. Stops queue up so the user can follow each
// one, but the newest is never shown later than MAX_LAG_MS after it arrived: stops in between are
// dropped. Pure; times are performance.now() milliseconds.
import type { AgentCursorStop } from "@uncut/contracts";

export const GLIDE_MS = 340;
/** The glide while more stops wait. */
export const FAST_GLIDE_MS = 250;
/** How long the cursor rests on a stop before going on to a queued one. */
export const DWELL_MS = 300;
export const MAX_LAG_MS = 1500;

export interface Leg {
  readonly stop: AgentCursorStop;
  readonly startedAt: number;
  readonly ms: number;
}

interface Queued {
  readonly stop: AgentCursorStop;
  readonly arrivedAt: number;
}

export interface Glide {
  readonly lastSeq: number;
  readonly queue: ReadonlyArray<Queued>;
  readonly leg: Leg | undefined;
}

export const emptyGlide = (): Glide => ({ lastSeq: 0, queue: [], leg: undefined });

/** The stops the cursor hasn't seen yet join the queue. */
export function receive(glide: Glide, stops: ReadonlyArray<AgentCursorStop>, now: number): Glide {
  const fresh = stops.filter((s) => s.seq > glide.lastSeq);
  if (!fresh.length) return glide;
  return { ...glide, lastSeq: fresh.at(-1)!.seq, queue: [...glide.queue, ...fresh.map((stop) => ({ stop, arrivedAt: now }))] };
}

const legMs = (waiting: number, reduced: boolean) => (reduced ? 0 : waiting > 1 ? FAST_GLIDE_MS : GLIDE_MS);

/** When the newest queued stop would be reached if every stop before it were visited. */
function lastArrival(queue: ReadonlyArray<Queued>, now: number, reduced: boolean) {
  const ms = legMs(queue.length, reduced);
  return now + queue.length * ms + (queue.length - 1) * DWELL_MS;
}

/** The next leg once the current one has glided and rested; stops that would lag too far are dropped. */
export function advance(glide: Glide, now: number, reduced = false): Glide {
  const leg = glide.leg;
  if (leg && now < leg.startedAt + leg.ms + DWELL_MS) return glide;
  if (!glide.queue.length) return glide;
  let queue = glide.queue;
  while (queue.length > 1 && lastArrival(queue, now, reduced) > queue.at(-1)!.arrivedAt + MAX_LAG_MS) queue = queue.slice(1);
  const [next, ...rest] = queue;
  return { ...glide, queue: rest, leg: { stop: next!.stop, startedAt: now, ms: legMs(queue.length, reduced) } };
}

/** How far along its leg the cursor is, eased out (0 at the start, 1 there). */
export function progress(leg: Pick<Leg, "startedAt" | "ms">, now: number): number {
  if (leg.ms <= 0) return 1;
  const t = Math.min(1, Math.max(0, (now - leg.startedAt) / leg.ms));
  return 1 - (1 - t) ** 3;
}
