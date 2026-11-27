/** Access requests are limited per caller, shared by POST /api/access-requests and the MCP access_request tool. */
import { RateLimiter } from '@/lib/utils/rate-limiter';

const g = globalThis as unknown as { __bosunAccessRequestLimiter?: RateLimiter };
export const accessRequestLimiter = g.__bosunAccessRequestLimiter
  ?? (g.__bosunAccessRequestLimiter = new RateLimiter({ maxAttempts: 20, windowMs: 3600_000, lockoutMs: 0 }));
