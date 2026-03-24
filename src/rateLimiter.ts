export class TokenBucket {
  private readonly refillRatePerMs: number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(private readonly tokensPerSecond: number, private readonly burst = Math.max(1, tokensPerSecond)) {
    this.refillRatePerMs = tokensPerSecond / 1000;
    this.tokens = burst;
    this.lastRefillMs = Date.now();
  }

  tryTake(count = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillMs;
    if (elapsed <= 0) return;

    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefillMs = now;
  }
}
