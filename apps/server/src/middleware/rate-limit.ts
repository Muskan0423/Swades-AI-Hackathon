import type { Context, Next } from "hono";
import { env } from "@my-better-t-app/env/server";
import { checkRateLimit } from "../lib/cache";

/**
 * Rate limiting middleware using Redis
 * Falls back to allowing all requests if Redis is not available
 */
export function rateLimiter(options?: {
  limit?: number;
  windowSeconds?: number;
  keyPrefix?: string;
  keyGenerator?: (c: Context) => string;
}) {
  const limit = options?.limit ?? env.RATE_LIMIT_REQUESTS;
  const windowSeconds = options?.windowSeconds ?? env.RATE_LIMIT_WINDOW;
  const keyPrefix = options?.keyPrefix ?? "api";
  const keyGenerator = options?.keyGenerator ?? defaultKeyGenerator;

  return async (c: Context, next: Next) => {
    const identifier = keyGenerator(c);
    const key = `${keyPrefix}:${identifier}`;

    const result = await checkRateLimit(key, limit, windowSeconds);

    // Set rate limit headers
    c.header("X-RateLimit-Limit", limit.toString());
    c.header("X-RateLimit-Remaining", result.remaining.toString());
    c.header("X-RateLimit-Reset", result.resetIn.toString());

    if (!result.allowed) {
      return c.json(
        {
          success: false,
          error: "Too many requests",
          retryAfter: result.resetIn,
        },
        429
      );
    }

    await next();
  };
}

/**
 * Default key generator - uses IP address or API key
 */
function defaultKeyGenerator(c: Context): string {
  // Check for API key first
  const apiKey = c.req.header("X-API-Key");
  if (apiKey) {
    return `key:${apiKey.substring(0, 16)}`;
  }

  // Fall back to IP address
  const forwarded = c.req.header("X-Forwarded-For");
  if (forwarded) {
    return `ip:${forwarded.split(",")[0]?.trim()}`;
  }

  // Get IP from request (works with Bun/Node)
  const ip = c.req.header("CF-Connecting-IP") || 
             c.req.header("X-Real-IP") ||
             "unknown";
  
  return `ip:${ip}`;
}

/**
 * Stricter rate limiter for upload endpoints
 */
export const uploadRateLimiter = rateLimiter({
  limit: 60, // 60 uploads per minute
  windowSeconds: 60,
  keyPrefix: "upload",
});

/**
 * Relaxed rate limiter for read endpoints
 */
export const readRateLimiter = rateLimiter({
  limit: 300, // 300 reads per minute
  windowSeconds: 60,
  keyPrefix: "read",
});
