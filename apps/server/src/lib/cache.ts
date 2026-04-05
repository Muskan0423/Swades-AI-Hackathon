import { env } from "@my-better-t-app/env/server";
import Redis from "ioredis";

/**
 * Redis cache wrapper for scalable caching
 * Supports recording metadata, presigned URLs, and session state
 */

// Cache TTL constants (in seconds)
export const CACHE_TTL = {
  RECORDING_METADATA: 300, // 5 minutes
  PRESIGNED_URL: 840, // 14 minutes (URLs valid for 15)
  CHUNK_LIST: 60, // 1 minute
  USER_SESSION: 3600, // 1 hour
} as const;

// Cache key prefixes for namespacing
export const CACHE_PREFIX = {
  RECORDING: "rec:",
  CHUNK: "chunk:",
  PRESIGNED: "presigned:",
  USER: "user:",
  RATE_LIMIT: "rl:",
} as const;

let redisClient: Redis | null = null;

/**
 * Get Redis client singleton
 * Returns null if Redis is not configured
 */
export function getRedisClient(): Redis | null {
  if (!env.REDIS_URL) {
    return null;
  }

  if (!redisClient) {
    redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      lazyConnect: true,
    });

    redisClient.on("error", (err) => {
      console.error("[Redis] Connection error:", err.message);
    });

    redisClient.on("connect", () => {
      console.log("[Redis] Connected to cache server");
    });
  }

  return redisClient;
}

/**
 * Cache wrapper with automatic JSON serialization
 */
export class Cache {
  private redis: Redis | null;

  constructor() {
    this.redis = getRedisClient();
  }

  /**
   * Check if caching is available
   */
  isAvailable(): boolean {
    return this.redis !== null;
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.redis) return null;
    
    try {
      const value = await this.redis.get(key);
      return value ? (JSON.parse(value) as T) : null;
    } catch (error) {
      console.error("[Cache] Get error:", error);
      return null;
    }
  }

  /**
   * Set value in cache with TTL
   */
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
    if (!this.redis) return false;
    
    try {
      await this.redis.setex(key, ttlSeconds, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error("[Cache] Set error:", error);
      return false;
    }
  }

  /**
   * Delete value from cache
   */
  async delete(key: string): Promise<boolean> {
    if (!this.redis) return false;
    
    try {
      await this.redis.del(key);
      return true;
    } catch (error) {
      console.error("[Cache] Delete error:", error);
      return false;
    }
  }

  /**
   * Delete multiple keys matching a pattern
   */
  async deletePattern(pattern: string): Promise<number> {
    if (!this.redis) return 0;
    
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length === 0) return 0;
      return await this.redis.del(...keys);
    } catch (error) {
      console.error("[Cache] Delete pattern error:", error);
      return 0;
    }
  }

  /**
   * Increment counter (for rate limiting)
   */
  async increment(key: string, ttlSeconds: number): Promise<number> {
    if (!this.redis) return 0;
    
    try {
      const multi = this.redis.multi();
      multi.incr(key);
      multi.expire(key, ttlSeconds);
      const results = await multi.exec();
      return (results?.[0]?.[1] as number) || 0;
    } catch (error) {
      console.error("[Cache] Increment error:", error);
      return 0;
    }
  }

  /**
   * Get remaining TTL for a key
   */
  async ttl(key: string): Promise<number> {
    if (!this.redis) return -1;
    
    try {
      return await this.redis.ttl(key);
    } catch {
      return -1;
    }
  }
}

// Export singleton cache instance
export const cache = new Cache();

// ============================================
// Recording-specific cache helpers
// ============================================

export interface CachedRecording {
  id: string;
  clientId: string;
  status: string;
  totalChunks: number;
  acknowledgedChunks: number;
  sampleRate: number;
  chunkDuration: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Cache recording metadata
 */
export async function cacheRecording(recording: CachedRecording): Promise<void> {
  const key = `${CACHE_PREFIX.RECORDING}${recording.id}`;
  await cache.set(key, recording, CACHE_TTL.RECORDING_METADATA);
}

/**
 * Get cached recording metadata
 */
export async function getCachedRecording(id: string): Promise<CachedRecording | null> {
  const key = `${CACHE_PREFIX.RECORDING}${id}`;
  return cache.get<CachedRecording>(key);
}

/**
 * Invalidate recording cache
 */
export async function invalidateRecordingCache(id: string): Promise<void> {
  const key = `${CACHE_PREFIX.RECORDING}${id}`;
  await cache.delete(key);
}

// ============================================
// Presigned URL cache helpers
// ============================================

export interface CachedPresignedUrl {
  url: string;
  key: string;
  expiresAt: number;
}

/**
 * Cache presigned URL
 */
export async function cachePresignedUrl(
  chunkKey: string,
  url: string,
  expiresIn: number
): Promise<void> {
  const cacheKey = `${CACHE_PREFIX.PRESIGNED}${chunkKey}`;
  const data: CachedPresignedUrl = {
    url,
    key: chunkKey,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  await cache.set(cacheKey, data, CACHE_TTL.PRESIGNED_URL);
}

/**
 * Get cached presigned URL if still valid
 */
export async function getCachedPresignedUrl(chunkKey: string): Promise<string | null> {
  const cacheKey = `${CACHE_PREFIX.PRESIGNED}${chunkKey}`;
  const cached = await cache.get<CachedPresignedUrl>(cacheKey);
  
  if (!cached) return null;
  
  // Check if URL is still valid (with 1 minute buffer)
  if (Date.now() > cached.expiresAt - 60000) {
    await cache.delete(cacheKey);
    return null;
  }
  
  return cached.url;
}

// ============================================
// Rate limiting helpers
// ============================================

/**
 * Check rate limit for a user/IP
 * Returns { allowed: boolean, remaining: number, resetIn: number }
 */
export async function checkRateLimit(
  identifier: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
  const key = `${CACHE_PREFIX.RATE_LIMIT}${identifier}`;
  
  if (!cache.isAvailable()) {
    return { allowed: true, remaining: limit, resetIn: windowSeconds };
  }
  
  const count = await cache.increment(key, windowSeconds);
  const remaining = Math.max(0, limit - count);
  const ttl = await cache.ttl(key);
  
  return {
    allowed: count <= limit,
    remaining,
    resetIn: ttl > 0 ? ttl : windowSeconds,
  };
}
