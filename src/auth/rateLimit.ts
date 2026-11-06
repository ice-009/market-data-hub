// Per-key token bucket: each key may make `perMinute` requests a minute, with
// bursts up to that size. This protects the hub (and through it the broker's
// quota) from one misbehaving client; the broker's own limits are enforced
// separately by the request budget.

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private perMinute: number) {}

  /** Take one token for `id`; returns 0 when allowed, else the ms to wait. */
  take(id: string, now = Date.now()): number {
    const rate = this.perMinute / 60_000;
    const bucket = this.buckets.get(id) ?? { tokens: this.perMinute, at: now };
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + (now - bucket.at) * rate);
    bucket.at = now;
    this.buckets.set(id, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / rate);
  }
}
