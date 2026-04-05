import { env } from "@my-better-t-app/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { compress } from "hono/compress";
import { secureHeaders } from "hono/secure-headers";
import { timing } from "hono/timing";
import recordingsRoutes from "./routes/recordings";
import chunksRoutes from "./routes/chunks";
import { rateLimiter } from "./middleware/rate-limit";
import { cache } from "./lib/cache";
import { isTranscriptionEnabled } from "./lib/transcription";
import { db, recordings, chunks } from "@my-better-t-app/db";
import { count, sql } from "drizzle-orm";

const app = new Hono();

// ============================================
// Middleware Stack
// ============================================

// Request timing headers (useful for debugging)
app.use(timing());

// Security headers
app.use(secureHeaders());

// Compression for JSON responses
app.use(compress());

// Request logging
app.use(logger());

// CORS configuration
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    exposeHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
    maxAge: 86400,
  }),
);

// Rate limiting (applies to all API routes)
app.use("/api/*", rateLimiter());

// ============================================
// Health & Status Endpoints
// ============================================

// Health check
app.get("/", (c) => {
  return c.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// Detailed health check for monitoring
app.get("/health", async (c) => {
  // Check database connectivity
  let dbStatus = "disconnected";
  try {
    await db.execute(sql`SELECT 1`);
    dbStatus = "connected";
  } catch {
    dbStatus = "disconnected";
  }

  const health = {
    status: dbStatus === "connected" ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    services: {
      database: dbStatus,
      cache: cache.isAvailable() ? "connected" : "unavailable",
      storage: env.STORAGE_ENDPOINT ? "s3" : "local",
      transcription: isTranscriptionEnabled() ? "enabled" : "disabled",
    },
    config: {
      rateLimit: {
        requests: env.RATE_LIMIT_REQUESTS,
        window: env.RATE_LIMIT_WINDOW,
      },
    },
  };

  return c.json(health);
});

// Stats endpoint for dashboard
app.get("/stats", async (c) => {
  try {
    // Get recording counts
    const [recordingStats] = await db
      .select({
        total: count(),
        active: count(sql`CASE WHEN ${recordings.status} = 'active' THEN 1 END`),
        completed: count(sql`CASE WHEN ${recordings.status} = 'completed' THEN 1 END`),
      })
      .from(recordings);

    // Get chunk counts
    const [chunkStats] = await db
      .select({
        total: count(),
        uploaded: count(sql`CASE WHEN ${chunks.status} = 'uploaded' THEN 1 END`),
        acknowledged: count(sql`CASE WHEN ${chunks.status} = 'acknowledged' THEN 1 END`),
        transcribed: count(sql`CASE WHEN ${chunks.transcriptionStatus} = 'completed' THEN 1 END`),
        pendingTranscription: count(sql`CASE WHEN ${chunks.transcriptionStatus} = 'pending' THEN 1 END`),
      })
      .from(chunks);

    // Get recent recordings (last 5)
    const recentRecordings = await db
      .select({
        id: recordings.id,
        status: recordings.status,
        totalChunks: recordings.totalChunks,
        createdAt: recordings.createdAt,
      })
      .from(recordings)
      .orderBy(sql`${recordings.createdAt} DESC`)
      .limit(5);

    return c.json({
      success: true,
      stats: {
        recordings: recordingStats,
        chunks: chunkStats,
        recentRecordings,
      },
    });
  } catch (error) {
    console.error("Failed to get stats:", error);
    return c.json({ success: false, error: "Failed to get stats" }, 500);
  }
});

// ============================================
// API Routes
// ============================================

app.route("/api/recordings", recordingsRoutes);
app.route("/api/chunks", chunksRoutes);

// ============================================
// Error Handling
// ============================================

app.onError((err, c) => {
  console.error("Server error:", err);
  return c.json(
    {
      success: false,
      error: env.NODE_ENV === "production" 
        ? "Internal server error" 
        : err.message,
    },
    500
  );
});

app.notFound((c) => {
  return c.json({ success: false, error: "Not found" }, 404);
});

export default app;
