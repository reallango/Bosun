/**
 * In-memory sliding-window rate limiter with optional lockout.
 *
 * Each bucket tracks attempt timestamps per key. When a key reaches
 * `maxAttempts` inside `windowMs` it is refused; if `lockoutMs` > 0 it is also
 * locked out for that long. A lockout is kept until it expires, even after the
 * attempts that caused it have aged out of the window (previously the cleanup
 * pass dropped the whole entry once attempts aged out, so a 30-minute login
 * lockout ended after the 15-minute window).
 */

export interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number;
  lockoutMs: number;
}

interface RateLimitEntry {
  attempts: number[];
  lockedUntil?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remainingAttempts: number;
  lockedUntil?: number;
  retryAfterMs?: number;
}

export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>();
  private lastCleanup = 0;

  constructor(private readonly config: RateLimitConfig, private readonly now: () => number = Date.now) {}

  /** Drop aged-out attempts; keep entries that are still locked out. */
  cleanup(): void {
    const now = this.now();
    for (const [key, entry] of Array.from(this.entries.entries())) {
      entry.attempts = entry.attempts.filter(t => now - t < this.config.windowMs);
      const locked = entry.lockedUntil !== undefined && entry.lockedUntil > now;
      if (!locked) entry.lockedUntil = undefined;
      if (entry.attempts.length === 0 && !locked) this.entries.delete(key);
    }
    this.lastCleanup = now;
  }

  private maybeCleanup(): void {
    if (this.now() - this.lastCleanup > Math.min(this.config.windowMs, 60_000)) this.cleanup();
  }

  /** Check whether `key` may make another attempt (does not record one). */
  check(key: string): RateLimitResult {
    this.maybeCleanup();
    const now = this.now();
    const entry = this.entries.get(key) || { attempts: [] };

    if (entry.lockedUntil && now < entry.lockedUntil) {
      return { allowed: false, remainingAttempts: 0, lockedUntil: entry.lockedUntil, retryAfterMs: entry.lockedUntil - now };
    }

    const recent = entry.attempts.filter(t => now - t < this.config.windowMs);
    const remaining = this.config.maxAttempts - recent.length;
    if (remaining <= 0) {
      if (this.config.lockoutMs > 0) {
        entry.lockedUntil = now + this.config.lockoutMs;
        this.entries.set(key, entry);
        return { allowed: false, remainingAttempts: 0, lockedUntil: entry.lockedUntil, retryAfterMs: this.config.lockoutMs };
      }
      const oldest = Math.min(...recent);
      return { allowed: false, remainingAttempts: 0, retryAfterMs: Math.max(0, oldest + this.config.windowMs - now) };
    }
    return { allowed: true, remainingAttempts: remaining };
  }

  record(key: string): void {
    const entry = this.entries.get(key) || { attempts: [] };
    entry.attempts.push(this.now());
    this.entries.set(key, entry);
  }

  /** Check and, if allowed, record in one step. */
  consume(key: string): RateLimitResult {
    const result = this.check(key);
    if (result.allowed) {
      this.record(key);
      result.remainingAttempts -= 1;
    }
    return result;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  size(): number {
    return this.entries.size;
  }
}

export const loginRateLimit: RateLimitConfig = { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 30 * 60 * 1000 };
const sshRateLimit: RateLimitConfig = { maxAttempts: 60, windowMs: 60 * 1000, lockoutMs: 0 };
const apiRateLimit: RateLimitConfig = { maxAttempts: 120, windowMs: 60 * 1000, lockoutMs: 0 };
/** Destructive/admin actions (container control, model pull/delete). */
const actionRateLimit: RateLimitConfig = { maxAttempts: 20, windowMs: 60 * 1000, lockoutMs: 0 };

const loginLimiter = new RateLimiter(loginRateLimit);
const sshLimiter = new RateLimiter(sshRateLimit);
const apiLimiter = new RateLimiter(apiRateLimit);
const actionLimiter = new RateLimiter(actionRateLimit);

export function checkLoginRateLimit(ip: string): RateLimitResult {
  return loginLimiter.check(ip);
}

export function recordLoginAttempt(ip: string): void {
  loginLimiter.record(ip);
}

export function checkSSHRateLimit(serverId: string): RateLimitResult {
  return sshLimiter.check(serverId);
}

export function recordSSHAttempt(serverId: string): void {
  sshLimiter.record(serverId);
}

export function checkAPIRateLimit(userId: string): RateLimitResult {
  return apiLimiter.check(userId);
}

export function recordAPIAttempt(userId: string): void {
  apiLimiter.record(userId);
}

/** Rate limit for destructive actions; checks and records in one call. */
export function consumeActionRateLimit(userId: string): RateLimitResult {
  return actionLimiter.consume(userId);
}
