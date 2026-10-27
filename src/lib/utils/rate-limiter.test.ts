import { describe, it, expect } from 'vitest';
import { RateLimiter } from './rate-limiter';

const MIN = 60 * 1000;

function limiter(cfg = { maxAttempts: 5, windowMs: 15 * MIN, lockoutMs: 30 * MIN }) {
  let t = 1_000_000;
  const rl = new RateLimiter(cfg, () => t);
  return { rl, advance: (ms: number) => { t += ms; } };
}

describe('RateLimiter', () => {
  it('allows up to maxAttempts inside the window', () => {
    const { rl } = limiter();
    for (let i = 0; i < 5; i++) {
      expect(rl.check('ip').allowed).toBe(true);
      rl.record('ip');
    }
    expect(rl.check('ip').allowed).toBe(false);
  });

  it('keeps a lockout for its full duration after attempts age out of the window', () => {
    const { rl, advance } = limiter();
    for (let i = 0; i < 5; i++) rl.record('ip');
    expect(rl.check('ip').allowed).toBe(false); // locks out for 30 min

    advance(16 * MIN); // attempts have aged out of the 15 min window
    rl.cleanup();
    expect(rl.check('ip').allowed).toBe(false);

    advance(13 * MIN); // 29 min into the lockout
    expect(rl.check('ip').allowed).toBe(false);

    advance(2 * MIN); // lockout over
    expect(rl.check('ip').allowed).toBe(true);
  });

  it('forgets idle keys once nothing is locked', () => {
    const { rl, advance } = limiter();
    rl.record('a');
    advance(16 * MIN);
    rl.cleanup();
    expect(rl.size()).toBe(0);
  });

  it('without lockout refuses only until the oldest attempt ages out', () => {
    const { rl, advance } = limiter({ maxAttempts: 2, windowMs: MIN, lockoutMs: 0 });
    expect(rl.consume('u').allowed).toBe(true);
    advance(10_000);
    expect(rl.consume('u').allowed).toBe(true);
    const refused = rl.consume('u');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(50_000);
    advance(50_001);
    expect(rl.consume('u').allowed).toBe(true);
  });
});
