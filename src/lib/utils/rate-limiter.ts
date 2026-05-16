interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number;
  lockoutMs: number;
}

interface RateLimitEntry {
  attempts: number[];
  lockedUntil?: number;
}

const loginRateLimit: RateLimitConfig = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 30 * 60 * 1000
};

const sshRateLimit: RateLimitConfig = {
  maxAttempts: 60,
  windowMs: 60 * 1000,
  lockoutMs: 0
};

const apiRateLimit: RateLimitConfig = {
  maxAttempts: 120,
  windowMs: 60 * 1000,
  lockoutMs: 0
};

const loginAttempts = new Map<string, RateLimitEntry>();
const sshAttempts = new Map<string, RateLimitEntry>();
const apiAttempts = new Map<string, RateLimitEntry>();

function cleanOldAttempts(map: Map<string, RateLimitEntry>, windowMs: number): void {
  const now = Date.now();
  for (const [key, entry] of map) {
    entry.attempts = entry.attempts.filter(t => now - t < windowMs);
    if (entry.attempts.length === 0) {
      map.delete(key);
    }
  }
}

export function checkLoginRateLimit(ip: string): { allowed: boolean; remainingAttempts: number; lockedUntil?: number } {
  cleanOldAttempts(loginAttempts, loginRateLimit.windowMs);
  
  const entry = loginAttempts.get(ip) || { attempts: [] };
  
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    return { allowed: false, remainingAttempts: 0, lockedUntil: entry.lockedUntil };
  }

  const recentAttempts = entry.attempts.filter(t => Date.now() - t < loginRateLimit.windowMs).length;
  const remaining = loginRateLimit.maxAttempts - recentAttempts;

  if (remaining <= 0) {
    entry.lockedUntil = Date.now() + loginRateLimit.lockoutMs;
    loginAttempts.set(ip, entry);
    return { allowed: false, remainingAttempts: 0, lockedUntil: entry.lockedUntil };
  }

  return { allowed: true, remainingAttempts: remaining };
}

export function recordLoginAttempt(ip: string): void {
  const entry = loginAttempts.get(ip) || { attempts: [] };
  entry.attempts.push(Date.now());
  loginAttempts.set(ip, entry);
}

export function checkSSHRateLimit(serverId: string): { allowed: boolean; remainingAttempts: number } {
  cleanOldAttempts(sshAttempts, sshRateLimit.windowMs);
  
  const entry = sshAttempts.get(serverId) || { attempts: [] };
  const recentAttempts = entry.attempts.filter(t => Date.now() - t < sshRateLimit.windowMs).length;
  const remaining = sshRateLimit.maxAttempts - recentAttempts;

  if (remaining <= 0) {
    return { allowed: false, remainingAttempts: 0 };
  }

  return { allowed: true, remainingAttempts: remaining };
}

export function recordSSHAttempt(serverId: string): void {
  const entry = sshAttempts.get(serverId) || { attempts: [] };
  entry.attempts.push(Date.now());
  sshAttempts.set(serverId, entry);
}

export function checkAPIRateLimit(userId: string): { allowed: boolean; remainingAttempts: number } {
  cleanOldAttempts(apiAttempts, apiRateLimit.windowMs);
  
  const entry = apiAttempts.get(userId) || { attempts: [] };
  const recentAttempts = entry.attempts.filter(t => Date.now() - t < apiRateLimit.windowMs).length;
  const remaining = apiRateLimit.maxAttempts - recentAttempts;

  if (remaining <= 0) {
    return { allowed: false, remainingAttempts: 0 };
  }

  return { allowed: true, remainingAttempts: remaining };
}

export function recordAPIAttempt(userId: string): void {
  const entry = apiAttempts.get(userId) || { attempts: [] };
  entry.attempts.push(Date.now());
  apiAttempts.set(userId, entry);
}