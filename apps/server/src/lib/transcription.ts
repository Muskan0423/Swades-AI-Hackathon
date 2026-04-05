import OpenAI from "openai";
import { db, chunks } from "@my-better-t-app/db";
import { eq } from "drizzle-orm";
import { storage } from "./storage";
import { env } from "@my-better-t-app/env/server";

// Default OpenAI client from env (can be null)
const defaultOpenai = env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: env.OPENAI_API_KEY })
  : null;

// Cache for dynamic clients (per API key)
const clientCache = new Map<string, OpenAI>();

/**
 * Get OpenAI client - uses provided key or falls back to env
 */
function getOpenAIClient(apiKey?: string): OpenAI | null {
  // If key provided, create/cache client for it
  if (apiKey && apiKey.startsWith("sk-")) {
    if (!clientCache.has(apiKey)) {
      clientCache.set(apiKey, new OpenAI({ apiKey }));
    }
    return clientCache.get(apiKey)!;
  }
  // Fall back to default from env
  return defaultOpenai;
}

export interface TranscriptionResult {
  success: boolean;
  transcript?: string;
  language?: string;
  confidence?: number;
  duration?: number;
  error?: string;
}

/**
 * Transcribe an audio file using OpenAI Whisper API
 * @param audioBuffer - The audio data to transcribe
 * @param filename - Filename with extension for MIME type detection
 * @param apiKey - Optional API key (uses env if not provided)
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string = "audio.wav",
  apiKey?: string
): Promise<TranscriptionResult> {
  const client = getOpenAIClient(apiKey);
  
  if (!client) {
    return {
      success: false,
      error: "OpenAI API key not configured. Add your key in Settings.",
    };
  }

  try {
    // Create a File object from buffer for OpenAI API
    const file = new File([audioBuffer], filename, {
      type: filename.endsWith(".opus") ? "audio/opus" : "audio/wav",
    });

    // Call Whisper API with verbose response for confidence
    const response = await client.audio.transcriptions.create({
      file,
      model: "whisper-1",
      response_format: "verbose_json",
      language: undefined, // Auto-detect language
    });

    // Extract data from verbose response
    const transcript = response.text || "";
    const language = response.language || "en";
    const duration = response.duration;

    // Calculate confidence from segments if available
    let avgConfidence = 95; // Default high confidence
    if ("segments" in response && Array.isArray(response.segments)) {
      const segments = response.segments as Array<{
        avg_logprob?: number;
        no_speech_prob?: number;
      }>;
      if (segments.length > 0) {
        const avgLogProb =
          segments.reduce((sum, s) => sum + (s.avg_logprob || -0.5), 0) /
          segments.length;
        // Convert log probability to 0-100 confidence score
        avgConfidence = Math.round(Math.min(100, Math.max(0, (avgLogProb + 1) * 100)));
      }
    }

    return {
      success: true,
      transcript,
      language,
      confidence: avgConfidence,
      duration,
    };
  } catch (error) {
    console.error("Transcription error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Transcription failed",
    };
  }
}

/**
 * Transcribe a chunk by its ID
 * Fetches audio from storage, transcribes, and updates the database
 * @param chunkId - The chunk ID to transcribe
 * @param apiKey - Optional API key (uses env if not provided)
 */
export async function transcribeChunk(chunkId: string, apiKey?: string): Promise<TranscriptionResult> {
  try {
    // Get chunk from database
    const [chunk] = await db
      .select()
      .from(chunks)
      .where(eq(chunks.id, chunkId))
      .limit(1);

    if (!chunk) {
      return { success: false, error: "Chunk not found" };
    }

    if (!chunk.bucketPath) {
      return { success: false, error: "Chunk has no audio file" };
    }

    // Mark as processing
    await db
      .update(chunks)
      .set({ transcriptionStatus: "processing" })
      .where(eq(chunks.id, chunkId));

    // Fetch audio from storage
    const audioData = await storage.download(chunk.bucketPath);
    if (!audioData) {
      await db
        .update(chunks)
        .set({
          transcriptionStatus: "failed",
          transcriptionError: "Failed to download audio file",
        })
        .where(eq(chunks.id, chunkId));
      return { success: false, error: "Failed to download audio file" };
    }

    // Transcribe
    const result = await transcribeAudio(
      audioData,
      chunk.bucketPath.split("/").pop() || "audio.wav",
      apiKey
    );

    if (!result.success) {
      await db
        .update(chunks)
        .set({
          transcriptionStatus: "failed",
          transcriptionError: result.error,
        })
        .where(eq(chunks.id, chunkId));
      return result;
    }

    // Update chunk with transcription
    await db
      .update(chunks)
      .set({
        transcript: result.transcript,
        transcriptionStatus: "completed",
        transcribedAt: new Date(),
        language: result.language,
        confidence: result.confidence,
        transcriptionError: null,
      })
      .where(eq(chunks.id, chunkId));

    return result;
  } catch (error) {
    console.error("Chunk transcription error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Update chunk with error
    await db
      .update(chunks)
      .set({
        transcriptionStatus: "failed",
        transcriptionError: errorMessage,
      })
      .where(eq(chunks.id, chunkId));

    return { success: false, error: errorMessage };
  }
}

/**
 * Queue transcription for async processing
 * In production, this would use a job queue (Bull, SQS, etc.)
 * For now, we process in the background without blocking
 * @param chunkId - The chunk ID to transcribe
 * @param apiKey - Optional API key (uses env if not provided)
 */
export function queueTranscription(chunkId: string, apiKey?: string): void {
  const client = getOpenAIClient(apiKey);
  if (!client) {
    console.warn("Skipping transcription - OpenAI API key not configured");
    return;
  }

  // Process in background (non-blocking)
  setImmediate(async () => {
    try {
      console.log(`[Transcription] Starting transcription for chunk ${chunkId}`);
      const result = await transcribeChunk(chunkId, apiKey);
      if (result.success) {
        console.log(`[Transcription] Completed for chunk ${chunkId}: "${result.transcript?.slice(0, 50)}..."`);
      } else {
        console.error(`[Transcription] Failed for chunk ${chunkId}: ${result.error}`);
      }
    } catch (error) {
      console.error(`[Transcription] Error processing chunk ${chunkId}:`, error);
    }
  });
}

/**
 * Get full transcript for a recording (all chunks combined)
 */
export async function getRecordingTranscript(recordingId: string): Promise<{
  success: boolean;
  transcript?: string;
  chunks?: Array<{
    index: number;
    transcript: string | null;
    status: string;
    language: string | null;
    confidence: number | null;
  }>;
  error?: string;
}> {
  try {
    const recordingChunks = await db
      .select({
        chunkIndex: chunks.chunkIndex,
        transcript: chunks.transcript,
        transcriptionStatus: chunks.transcriptionStatus,
        language: chunks.language,
        confidence: chunks.confidence,
      })
      .from(chunks)
      .where(eq(chunks.recordingId, recordingId))
      .orderBy(chunks.chunkIndex);

    if (recordingChunks.length === 0) {
      return { success: false, error: "No chunks found for recording" };
    }

    // Combine all transcripts in order
    const fullTranscript = recordingChunks
      .filter((c) => c.transcript)
      .map((c) => c.transcript)
      .join(" ");

    return {
      success: true,
      transcript: fullTranscript,
      chunks: recordingChunks.map((c) => ({
        index: c.chunkIndex,
        transcript: c.transcript,
        status: c.transcriptionStatus || "pending",
        language: c.language,
        confidence: c.confidence,
      })),
    };
  } catch (error) {
    console.error("Get recording transcript error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get transcript",
    };
  }
}

/**
 * Check if transcription is enabled (default API key configured in env)
 */
export function isTranscriptionEnabled(): boolean {
  return !!defaultOpenai;
}
