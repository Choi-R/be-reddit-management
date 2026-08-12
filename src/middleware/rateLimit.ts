import { MiddlewareHandler } from 'hono';
import { Env, Variables } from '../types';

interface RateLimitConfig {
  windowMs: number;
  max: number;
  message?: string;
}

export const rateLimiter = (config: RateLimitConfig): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> => {
  // In-memory request tracker specific to this middleware instance
  const tracker = new Map<string, number[]>();
  return async (c, next) => {
    // 1. Identify client using Cloudflare's standard header or X-Forwarded-For fallback
    const forwarded = c.req.header('x-forwarded-for');
    const ip = c.req.header('CF-Connecting-IP') || (forwarded ? forwarded.split(',')[0].trim() : '127.0.0.1');
    
    // Check if user context is available (if rateLimiter runs after authMiddleware)
    const user = c.get('user');
    const key = user?.id ? `user:${user.id}` : `ip:${ip}`;

    const now = Date.now();
    const timestamps = tracker.get(key) || [];

    // 2. Lazy cleanup: Keep only timestamps within the current window
    const activeTimestamps = timestamps.filter(t => now - t < config.windowMs);

    // 3. Set Rate Limit Headers so scanners & clients can confirm rate limiting
    const remaining = Math.max(0, config.max - activeTimestamps.length - 1);
    const resetTime = Math.ceil((activeTimestamps[0] ? activeTimestamps[0] + config.windowMs : now + config.windowMs) / 1000);
    const retryAfter = Math.ceil(config.windowMs / 1000);

    c.header('X-RateLimit-Limit', String(config.max));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(resetTime));

    // 4. Check rate limit
    if (activeTimestamps.length >= config.max) {
      c.header('Retry-After', String(retryAfter));
      return c.json({
        error: config.message || 'Too many requests, please try again later.',
        code: 'RATE_LIMIT_EXCEEDED'
      }, 429);
    }

    // 5. Log the current request
    activeTimestamps.push(now);
    tracker.set(key, activeTimestamps);

    // 6. Occasional global garbage collection (1% chance per request) to prevent memory leaks
    if (Math.random() < 0.01) {
      for (const [k, ts] of tracker.entries()) {
        const valid = ts.filter(t => now - t < config.windowMs);
        if (valid.length === 0) {
          tracker.delete(k);
        } else {
          tracker.set(k, valid);
        }
      }
    }

    await next();
  };
};
