// ActionOS Pay: Rate Limiter for AI Procurement Planning
// Throttles repeated invocations against paid Gemini AI endpoints to protect budget and prevent abuse.

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitRecord>();

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfter?: number;
}

/**
 * Checks whether an actor (user ID, IP, or caller identity) has exceeded the permitted request rate.
 * Default: 10 requests per 60 seconds per user.
 */
export function checkRateLimit(
  key: string,
  limit = 10,
  windowSeconds = 60
): RateLimitResult {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const record = rateLimitStore.get(key);

  if (!record || now >= record.resetAt) {
    // New window
    const resetAt = now + windowMs;
    rateLimitStore.set(key, { count: 1, resetAt });
    return {
      allowed: true,
      limit,
      remaining: limit - 1,
      resetSeconds: windowSeconds,
    };
  }

  if (record.count < limit) {
    record.count += 1;
    const remaining = limit - record.count;
    const resetSeconds = Math.ceil((record.resetAt - now) / 1000);
    return {
      allowed: true,
      limit,
      remaining,
      resetSeconds,
    };
  }

  // Rate limit exceeded
  const retryAfter = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
  return {
    allowed: false,
    limit,
    remaining: 0,
    resetSeconds: retryAfter,
    retryAfter,
  };
}

/**
 * Resets rate limit store (for test suite isolation).
 */
export function resetRateLimits(): void {
  rateLimitStore.clear();
}
