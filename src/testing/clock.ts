import type { Timers } from '../engine';

/**
 * Test time: `now()` for the engines' timestamps and the timers for their
 * change debounce. Time moves only with `advance()`, which fires the timers
 * that fall due, in order.
 */
export class VirtualClock implements Timers {
  private ms: number;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = '2026-01-01T09:00:00.000Z') {
    this.ms = Date.parse(start);
  }

  /** UTC ISO timestamp. */
  now(): string {
    return new Date(this.ms).toISOString();
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.ms + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Timers not fired yet. */
  pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const end = this.ms + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timers) {
        if (entry[1].at <= end && (next === null || entry[1].at < next[1].at)) next = entry;
      }
      if (next === null) break;
      this.timers.delete(next[0]);
      this.ms = next[1].at;
      next[1].fn();
    }
    this.ms = end;
  }
}
