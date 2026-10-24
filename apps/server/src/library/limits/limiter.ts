// Openverse's and Freesound's request limits, and the per-minute / per-day limiter that keeps to them.
import type { LibraryLimit } from "@uncut/contracts";

/** Openverse's anonymous limits (its x-ratelimit headers say the same). */
export const OPENVERSE_PER_MINUTE = 20;
export const OPENVERSE_PER_DAY = 200;
/** Freesound's documented API limits. */
export const FREESOUND_PER_MINUTE = 60;
export const FREESOUND_PER_DAY = 2000;

/** Requests per minute and per day: what's been sent, and when a source said stop. */
export class Limiter {
  private sent: Array<number> = [];
  private blocked: LibraryLimit | undefined;
  private readonly perMinute: number;
  private readonly perDay: number;
  private readonly now: () => number;
  constructor(perMinute: number, perDay: number, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.perDay = perDay;
    this.now = now;
  }
  /** The limit in force now, if any (without counting a request). */
  limit(): LibraryLimit | undefined {
    const t = this.now();
    if (this.blocked && Date.parse(this.blocked.until) > t) return this.blocked;
    this.blocked = undefined;
    this.sent = this.sent.filter((s) => t - s < 24 * 3600 * 1000);
    if (this.sent.length >= this.perDay) return { scope: "day", until: new Date(this.sent[0]! + 24 * 3600 * 1000).toISOString() };
    const minute = this.sent.filter((s) => t - s < 60 * 1000);
    if (minute.length >= this.perMinute) return { scope: "minute", until: new Date(minute[0]! + 60 * 1000).toISOString() };
    return undefined;
  }
  /** Counts a request about to go out, or says why it can't. */
  take(): LibraryLimit | undefined {
    const limit = this.limit();
    if (!limit) this.sent.push(this.now());
    return limit;
  }
  /** What the source reported: requests left this minute / today (0 blocks), or a 429's Retry-After. */
  report(left: {
    readonly minute?: number | undefined;
    readonly day?: number | undefined;
    readonly retryAfter?: number | undefined;
    readonly refused?: boolean;
  }) {
    const t = this.now();
    if (left.day === 0 || (left.refused && left.minute !== 0 && left.day !== undefined && left.day <= 0)) {
      const midnight = new Date(t);
      midnight.setUTCHours(24, 0, 0, 0);
      this.blocked = { scope: "day", until: midnight.toISOString() };
    } else if (left.minute === 0 || left.refused) {
      const wait = left.retryAfter && left.retryAfter > 0 ? Math.min(left.retryAfter, 24 * 3600) * 1000 : 60 * 1000;
      this.blocked = { scope: wait > 3600 * 1000 ? "day" : "minute", until: new Date(t + wait).toISOString() };
    }
  }
}
