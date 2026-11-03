/**
 * Small fixed-window limiter (per server instance). Used as a cost guard for
 * live-camera vision calls; the client also caps itself.
 */
export class FixedWindowLimiter {
  private hits = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true when the call is allowed (and counts it). */
  take(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      if (this.hits.size > 5000) this.prune(now);
      return true;
    }
    if (h.count >= this.limit) return false;
    h.count += 1;
    return true;
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
  }
}
