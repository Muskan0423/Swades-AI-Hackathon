import { Hono } from "hono";
import { z } from "zod";
import { db, chunks, recordings } from "@my-better-t-app/db";
import { eq, and, sql } from "drizzle-orm";
import { storage, getChunkStorageKey, s3Storage, getPlaybackUrl } from "../lib/storage";
import { 
  cachePresignedUrl, 
  getCachedPresignedUrl 
} from "../lib/cache";
import { 
  queueTranscription, 
  transcribeChunk, 
  getRecordingTranscript,
  isTranscriptionEnabled 
} from "../lib/transcription";

const app = new Hono();

// ============================================
// Presigned URL endpoint for direct S3 uploads
// ============================================

const getUploadUrlSchema = z.object({
  recordingId: z.string().uuid(),
  chunkIndex: z.number().int().min(0),
  chunkId: z.string().uuid(),
  format: z.enum(["wav", "opus"]).default("wav"),
});

/**
 * Get presigned URL for direct browser-to-S3 upload
 * This bypasses the server for large file uploads
 */
app.post("/upload-url", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = getUploadUrlSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ success: false, error: "Invalid request body" }, 400);
    }

    const { recordingId, chunkIndex, chunkId, format } = parsed.data;
    const storageKey = getChunkStorageKey(recordingId, chunkIndex, format);

    // Check cache first
    const cachedUrl = await getCachedPresignedUrl(storageKey);
    if (cachedUrl) {
      return c.json({
        success: true,
        uploadUrl: cachedUrl,
        key: storageKey,
        cached: true,
      });
    }

    // S3 not configured - fall back to regular upload endpoint
    if (!s3Storage) {
      return c.json({
        success: true,
        uploadUrl: null,
        fallbackToUpload: true,
        message: "S3 not configured, use /upload endpoint instead",
      });
    }

    // Generate presigned URL
    const result = await s3Storage.getPresignedUploadUrl(storageKey);
    
    if (!result.success || !result.uploadUrl) {
      return c.json(
        { success: false, error: result.error || "Failed to generate URL" },
        500
      );
    }

    // Cache the URL
    await cachePresignedUrl(storageKey, result.uploadUrl, result.expiresIn || 900);

    // Pre-create chunk record in pending state
    await db
      .insert(chunks)
      .values({
        id: chunkId,
        recordingId,
        chunkIndex,
        status: "pending",
        bucketPath: storageKey,
      })
      .onConflictDoNothing();

    return c.json({
      success: true,
      uploadUrl: result.uploadUrl,
      key: storageKey,
      expiresIn: result.expiresIn,
      cached: false,
    });
  } catch (error) {
    console.error("Failed to generate upload URL:", error);
    return c.json(
      { success: false, error: "Failed to generate upload URL" },
      500
    );
  }
});

/**
 * Confirm direct S3 upload completed
 * Called after browser uploads directly to S3
 */
app.post("/confirm-upload", async (c) => {
  try {
    const body = await c.req.json();
    const { chunkId, checksum, fileSize, duration } = body;

    if (!chunkId) {
      return c.json({ success: false, error: "chunkId required" }, 400);
    }

    // Get the chunk record
    const [chunk] = await db
      .select()
      .from(chunks)
      .where(eq(chunks.id, chunkId))
      .limit(1);

    if (!chunk) {
      return c.json({ success: false, error: "Chunk not found" }, 404);
    }

    // Verify file exists in S3
    if (chunk.bucketPath) {
      const exists = await storage.exists(chunk.bucketPath);
      if (!exists) {
        return c.json(
          { success: false, error: "File not found in storage" },
          400
        );
      }
    }

    // Update chunk record
    const [updated] = await db
      .update(chunks)
      .set({
        status: "uploaded",
        checksum,
        fileSize,
        duration,
        uploadedAt: new Date(),
      })
      .where(eq(chunks.id, chunkId))
      .returning();

    if (!updated) {
      return c.json({ success: false, error: "Failed to update chunk" }, 500);
    }

    // Queue transcription in background (use API key from header if provided)
    const apiKey = c.req.header("X-OpenAI-Key");
    queueTranscription(chunkId, apiKey);

    return c.json({
      success: true,
      chunk: {
        id: updated.id,
        status: updated.status,
        bucketPath: updated.bucketPath,
      },
      transcriptionQueued: isTranscriptionEnabled() || !!apiKey,
    });
  } catch (error) {
    console.error("Failed to confirm upload:", error);
    return c.json(
      { success: false, error: "Failed to confirm upload" },
      500
    );
  }
});

/**
 * Get playback URL for a chunk (CDN or presigned)
 */
app.get("/:chunkId/playback-url", async (c) => {
  try {
    const chunkId = c.req.param("chunkId");

    const [chunk] = await db
      .select()
      .from(chunks)
      .where(eq(chunks.id, chunkId))
      .limit(1);

    if (!chunk || !chunk.bucketPath) {
      return c.json({ success: false, error: "Chunk not found" }, 404);
    }

    const playbackUrl = await getPlaybackUrl(chunk.bucketPath);

    return c.json({
      success: true,
      playbackUrl,
      format: chunk.bucketPath.endsWith(".opus") ? "opus" : "wav",
    });
  } catch (error) {
    console.error("Failed to get playback URL:", error);
    return c.json(
      { success: false, error: "Failed to get playback URL" },
      500
    );
  }
});

// Upload a chunk
app.post("/upload", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    const chunkId = formData.get("chunkId") as string | null;
    const recordingId = formData.get("recordingId") as string | null;
    const chunkIndex = formData.get("chunkIndex") as string | null;
    const duration = formData.get("duration") as string | null;

    if (!file || !chunkId || !recordingId || chunkIndex === null) {
      return c.json(
        { success: false, error: "Missing required fields" },
        400
      );
    }

    const index = parseInt(chunkIndex, 10);
    const durationMs = duration ? parseInt(duration, 10) : undefined;

    // Convert file to buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Generate storage key
    const storageKey = getChunkStorageKey(recordingId, index);

    // Upload to storage bucket
    const uploadResult = await storage.upload(storageKey, buffer);

    if (!uploadResult.success) {
      return c.json(
        { success: false, error: uploadResult.error || "Upload failed" },
        500
      );
    }

    // Insert or update chunk record in DB
    const [chunk] = await db
      .insert(chunks)
      .values({
        id: chunkId,
        recordingId,
        chunkIndex: index,
        status: "uploaded",
        bucketPath: uploadResult.path,
        fileSize: uploadResult.size,
        duration: durationMs,
        checksum: uploadResult.checksum,
        uploadedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: chunks.id,
        set: {
          status: "uploaded",
          bucketPath: uploadResult.path,
          fileSize: uploadResult.size,
          checksum: uploadResult.checksum,
          uploadedAt: new Date(),
          retryCount: sql`${chunks.retryCount} + 1`,
        },
      })
      .returning();

    if (!chunk) {
      return c.json({ success: false, error: "Failed to save chunk" }, 500);
    }

    // Queue transcription in background (use API key from header if provided)
    const apiKey = c.req.header("X-OpenAI-Key");
    queueTranscription(chunk.id, apiKey);

    return c.json({
      success: true,
      chunk: {
        id: chunk.id,
        status: chunk.status,
        bucketPath: chunk.bucketPath,
        checksum: chunk.checksum,
      },
      transcriptionQueued: isTranscriptionEnabled() || !!apiKey,
    });
  } catch (error) {
    console.error("Failed to upload chunk:", error);
    return c.json(
      { success: false, error: "Failed to upload chunk" },
      500
    );
  }
});

// Acknowledge a chunk (confirm it's safely stored)
const ackChunkSchema = z.object({
  chunkId: z.string().uuid(),
  checksum: z.string().optional(), // Client can verify checksum
});

app.post("/ack", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = ackChunkSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ success: false, error: "Invalid request body" }, 400);
    }

    const { chunkId, checksum } = parsed.data;

    // Get the chunk
    const [chunk] = await db
      .select()
      .from(chunks)
      .where(eq(chunks.id, chunkId))
      .limit(1);

    if (!chunk) {
      return c.json({ success: false, error: "Chunk not found" }, 404);
    }

    // Verify chunk exists in storage
    if (!chunk.bucketPath) {
      return c.json(
        { success: false, error: "Chunk not uploaded to storage" },
        400
      );
    }

    const existsInBucket = await storage.exists(chunk.bucketPath);
    if (!existsInBucket) {
      // Mark as failed - needs re-upload
      await db
        .update(chunks)
        .set({ status: "failed", lastError: "Chunk missing from storage" })
        .where(eq(chunks.id, chunkId));

      return c.json(
        {
          success: false,
          error: "Chunk missing from storage",
          needsReupload: true,
        },
        400
      );
    }

    // Optional: verify checksum
    if (checksum && chunk.checksum !== checksum) {
      return c.json(
        {
          success: false,
          error: "Checksum mismatch",
          needsReupload: true,
        },
        400
      );
    }

    // Mark as acknowledged
    const [updated] = await db
      .update(chunks)
      .set({
        status: "acknowledged",
        acknowledgedAt: new Date(),
      })
      .where(eq(chunks.id, chunkId))
      .returning();

    if (!updated) {
      return c.json({ success: false, error: "Failed to update chunk" }, 500);
    }

    // Update recording's acknowledged count
    await db
      .update(recordings)
      .set({
        acknowledgedChunks: sql`${recordings.acknowledgedChunks} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(recordings.id, chunk.recordingId));

    return c.json({
      success: true,
      chunk: {
        id: updated.id,
        status: updated.status,
        acknowledgedAt: updated.acknowledgedAt,
      },
    });
  } catch (error) {
    console.error("Failed to acknowledge chunk:", error);
    return c.json(
      { success: false, error: "Failed to acknowledge chunk" },
      500
    );
  }
});

// Get chunks for a recording
app.get("/recording/:recordingId", async (c) => {
  const recordingId = c.req.param("recordingId");

  try {
    const chunkList = await db
      .select()
      .from(chunks)
      .where(eq(chunks.recordingId, recordingId))
      .orderBy(chunks.chunkIndex);

    return c.json({ success: true, chunks: chunkList });
  } catch (error) {
    console.error("Failed to get chunks:", error);
    return c.json({ success: false, error: "Failed to get chunks" }, 500);
  }
});

// Get chunks that need re-upload (acknowledged in DB but missing from bucket)
app.get("/needs-reupload/:recordingId", async (c) => {
  const recordingId = c.req.param("recordingId");

  try {
    const chunkList = await db
      .select()
      .from(chunks)
      .where(
        and(
          eq(chunks.recordingId, recordingId),
          eq(chunks.status, "acknowledged")
        )
      )
      .orderBy(chunks.chunkIndex);

    // Check which ones are actually missing from storage
    const needsReupload: string[] = [];

    for (const chunk of chunkList) {
      if (chunk.bucketPath) {
        const exists = await storage.exists(chunk.bucketPath);
        if (!exists) {
          needsReupload.push(chunk.id);
        }
      }
    }

    return c.json({ success: true, needsReupload });
  } catch (error) {
    console.error("Failed to check chunks:", error);
    return c.json({ success: false, error: "Failed to check chunks" }, 500);
  }
});

// Reconciliation endpoint - verify all acknowledged chunks exist in storage
const reconcileSchema = z.object({
  recordingId: z.string().uuid(),
});

app.post("/reconcile", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = reconcileSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ success: false, error: "Invalid request body" }, 400);
    }

    const { recordingId } = parsed.data;

    const chunkList = await db
      .select()
      .from(chunks)
      .where(eq(chunks.recordingId, recordingId))
      .orderBy(chunks.chunkIndex);

    const results = {
      total: chunkList.length,
      verified: 0,
      missing: [] as Array<{ id: string; chunkIndex: number }>,
      failed: [] as Array<{ id: string; chunkIndex: number; error: string }>,
    };

    for (const chunk of chunkList) {
      if (!chunk.bucketPath) {
        results.missing.push({ id: chunk.id, chunkIndex: chunk.chunkIndex });
        continue;
      }

      const exists = await storage.exists(chunk.bucketPath);
      if (!exists) {
        results.missing.push({ id: chunk.id, chunkIndex: chunk.chunkIndex });

        // Mark chunk as needing re-upload
        await db
          .update(chunks)
          .set({
            status: "pending",
            lastError: "Missing from storage during reconciliation",
          })
          .where(eq(chunks.id, chunk.id));
      } else {
        results.verified++;
      }
    }

    return c.json({
      success: true,
      reconciliation: results,
      needsAction: results.missing.length > 0,
    });
  } catch (error) {
    console.error("Failed to reconcile:", error);
    return c.json({ success: false, error: "Reconciliation failed" }, 500);
  }
});

// Get chunk status
app.get("/:chunkId/status", async (c) => {
  const chunkId = c.req.param("chunkId");

  try {
    const [chunk] = await db
      .select()
      .from(chunks)
      .where(eq(chunks.id, chunkId))
      .limit(1);

    if (!chunk) {
      return c.json({ success: false, error: "Chunk not found" }, 404);
    }

    // Verify storage if needed
    let existsInStorage = false;
    if (chunk.bucketPath) {
      existsInStorage = await storage.exists(chunk.bucketPath);
    }

    return c.json({
      success: true,
      chunk: {
        id: chunk.id,
        status: chunk.status,
        existsInStorage,
        checksum: chunk.checksum,
      },
    });
  } catch (error) {
    console.error("Failed to get chunk status:", error);
    return c.json({ success: false, error: "Failed to get chunk status" }, 500);
  }
});

// ============================================
// Transcription Endpoints
// ============================================

/**
 * Get transcription for a single chunk
 */
app.get("/:chunkId/transcription", async (c) => {
  try {
    const chunkId = c.req.param("chunkId");

    const [chunk] = await db
      .select({
        id: chunks.id,
        transcript: chunks.transcript,
        transcriptionStatus: chunks.transcriptionStatus,
        language: chunks.language,
        confidence: chunks.confidence,
        transcribedAt: chunks.transcribedAt,
        transcriptionError: chunks.transcriptionError,
      })
      .from(chunks)
      .where(eq(chunks.id, chunkId))
      .limit(1);

    if (!chunk) {
      return c.json({ success: false, error: "Chunk not found" }, 404);
    }

    return c.json({
      success: true,
      transcription: {
        status: chunk.transcriptionStatus,
        transcript: chunk.transcript,
        language: chunk.language,
        confidence: chunk.confidence,
        transcribedAt: chunk.transcribedAt,
        error: chunk.transcriptionError,
      },
    });
  } catch (error) {
    console.error("Failed to get transcription:", error);
    return c.json({ success: false, error: "Failed to get transcription" }, 500);
  }
});

/**
 * Retry transcription for a chunk
 */
app.post("/:chunkId/transcribe", async (c) => {
  try {
    const chunkId = c.req.param("chunkId");

    const apiKey = c.req.header("X-OpenAI-Key");
    
    if (!isTranscriptionEnabled() && !apiKey) {
      return c.json({
        success: false,
        error: "Transcription not enabled. Add your OpenAI API key in Settings.",
      }, 400);
    }

    const [chunk] = await db
      .select()
      .from(chunks)
      .where(eq(chunks.id, chunkId))
      .limit(1);

    if (!chunk) {
      return c.json({ success: false, error: "Chunk not found" }, 404);
    }

    // Process synchronously for retry requests
    const result = await transcribeChunk(chunkId, apiKey);

    return c.json({
      success: result.success,
      transcription: result.success
        ? {
            transcript: result.transcript,
            language: result.language,
            confidence: result.confidence,
          }
        : undefined,
      error: result.error,
    });
  } catch (error) {
    console.error("Failed to transcribe:", error);
    return c.json({ success: false, error: "Transcription failed" }, 500);
  }
});

/**
 * Get full transcript for a recording (all chunks combined)
 */
app.get("/recording/:recordingId/transcript", async (c) => {
  try {
    const recordingId = c.req.param("recordingId");
    const result = await getRecordingTranscript(recordingId);

    if (!result.success) {
      return c.json({ success: false, error: result.error }, 404);
    }

    return c.json({
      success: true,
      recordingId,
      transcript: result.transcript,
      chunks: result.chunks,
    });
  } catch (error) {
    console.error("Failed to get recording transcript:", error);
    return c.json({ success: false, error: "Failed to get transcript" }, 500);
  }
});

/**
 * Check transcription status
 */
app.get("/transcription-status", async (c) => {
  return c.json({
    enabled: isTranscriptionEnabled(),
    model: "whisper-1",
  });
});

export default app;
