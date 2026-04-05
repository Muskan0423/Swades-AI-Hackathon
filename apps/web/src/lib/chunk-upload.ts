import { env } from "@my-better-t-app/env/web";
import {
  loadChunkFromOPFS,
  deleteChunkFromOPFS,
  listChunksInOPFS,
} from "./opfs";
import { getApiKey } from "./config";

const API_BASE = env.NEXT_PUBLIC_SERVER_URL;

/**
 * Get headers including API key if configured
 */
function getHeaders(contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  
  const apiKey = getApiKey();
  if (apiKey) {
    headers["X-OpenAI-Key"] = apiKey;
  }
  
  return headers;
}

export type ChunkUploadStatus =
  | "pending"
  | "uploading"
  | "uploaded"
  | "acknowledged"
  | "failed";

export type AudioFormat = "wav" | "opus";

export interface ChunkState {
  id: string;
  chunkIndex: number;
  status: ChunkUploadStatus;
  error?: string;
  retryCount: number;
}

export interface UploadResult {
  success: boolean;
  error?: string;
  checksum?: string;
  needsReupload?: boolean;
}

export interface PresignedUrlResult {
  success: boolean;
  uploadUrl?: string | null;
  key?: string;
  fallbackToUpload?: boolean;
  error?: string;
}

// ============================================
// Presigned URL & Direct S3 Upload
// ============================================

/**
 * Get a presigned URL for direct S3 upload
 * Returns null uploadUrl if S3 is not configured (use fallback upload)
 */
export async function getPresignedUploadUrl(params: {
  recordingId: string;
  chunkIndex: number;
  chunkId: string;
  format?: AudioFormat;
}): Promise<PresignedUrlResult> {
  try {
    const response = await fetch(`${API_BASE}/api/chunks/upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recordingId: params.recordingId,
        chunkIndex: params.chunkIndex,
        chunkId: params.chunkId,
        format: params.format || "wav",
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || "Failed to get upload URL" };
    }

    return {
      success: true,
      uploadUrl: data.uploadUrl,
      key: data.key,
      fallbackToUpload: data.fallbackToUpload || false,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  }
}

/**
 * Upload directly to S3 using presigned URL
 */
export async function uploadToS3(
  uploadUrl: string,
  blob: Blob,
  contentType: string = "audio/wav"
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(uploadUrl, {
      method: "PUT",
      body: blob,
      headers: {
        "Content-Type": contentType,
      },
    });

    if (!response.ok) {
      return { success: false, error: `S3 upload failed: ${response.status}` };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "S3 upload error",
    };
  }
}

/**
 * Confirm direct S3 upload on server
 */
export async function confirmS3Upload(params: {
  chunkId: string;
  checksum?: string;
  fileSize?: number;
  duration?: number;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${API_BASE}/api/chunks/confirm-upload`, {
      method: "POST",
      headers: getHeaders("application/json"),
      body: JSON.stringify(params),
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || "Confirm upload failed" };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  }
}

/**
 * Calculate SHA-256 checksum of a blob
 */
export async function calculateChecksum(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Smart upload - uses presigned URL if available, falls back to server upload
 */
export async function smartUploadChunk(params: {
  chunkId: string;
  recordingId: string;
  chunkIndex: number;
  blob: Blob;
  duration?: number;
  format?: AudioFormat;
}): Promise<UploadResult> {
  // Try to get presigned URL first
  const presignedResult = await getPresignedUploadUrl({
    recordingId: params.recordingId,
    chunkIndex: params.chunkIndex,
    chunkId: params.chunkId,
    format: params.format,
  });

  // If S3 is configured and we have a URL, upload directly
  if (presignedResult.success && presignedResult.uploadUrl) {
    const contentType = params.format === "opus" ? "audio/opus" : "audio/wav";
    const s3Result = await uploadToS3(presignedResult.uploadUrl, params.blob, contentType);

    if (s3Result.success) {
      // Calculate checksum and confirm upload
      const checksum = await calculateChecksum(params.blob);
      const confirmResult = await confirmS3Upload({
        chunkId: params.chunkId,
        checksum,
        fileSize: params.blob.size,
        duration: params.duration ? Math.round(params.duration * 1000) : undefined,
      });

      if (confirmResult.success) {
        return { success: true, checksum };
      }
      return { success: false, error: confirmResult.error };
    }
    
    // S3 upload failed, fall through to server upload
    console.warn("Direct S3 upload failed, falling back to server upload");
  }

  // Fall back to server upload
  return uploadChunk(params);
}

/**
 * Create a new recording session on the server
 */
export async function createRecording(params: {
  id: string;
  clientId: string;
  sampleRate?: number;
  chunkDuration?: number;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${API_BASE}/api/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: params.id,
        clientId: params.clientId,
        sampleRate: params.sampleRate ?? 16000,
        chunkDuration: params.chunkDuration ?? 5,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      return { success: false, error: data.error || "Failed to create recording" };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  }
}

/**
 * Complete a recording session on the server
 */
export async function completeRecording(
  recordingId: string,
  totalChunks: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${API_BASE}/api/recordings/${recordingId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalChunks }),
      }
    );

    if (!response.ok) {
      const data = await response.json();
      return { success: false, error: data.error || "Failed to complete recording" };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  }
}

/**
 * Upload a chunk to the server
 */
export async function uploadChunk(params: {
  chunkId: string;
  recordingId: string;
  chunkIndex: number;
  blob: Blob;
  duration?: number;
}): Promise<UploadResult> {
  try {
    const formData = new FormData();
    formData.append("file", params.blob, `chunk_${params.chunkIndex}.wav`);
    formData.append("chunkId", params.chunkId);
    formData.append("recordingId", params.recordingId);
    formData.append("chunkIndex", params.chunkIndex.toString());
    if (params.duration !== undefined) {
      formData.append("duration", Math.round(params.duration * 1000).toString());
    }

    // Get API key header (don't set Content-Type for FormData)
    const apiKey = getApiKey();
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["X-OpenAI-Key"] = apiKey;
    }

    const response = await fetch(`${API_BASE}/api/chunks/upload`, {
      method: "POST",
      headers,
      body: formData,
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        success: false,
        error: data.error || "Upload failed",
      };
    }

    return {
      success: true,
      checksum: data.chunk?.checksum,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  }
}

/**
 * Acknowledge a chunk (confirm it's stored correctly)
 */
export async function acknowledgeChunk(
  chunkId: string,
  checksum?: string
): Promise<UploadResult> {
  try {
    const response = await fetch(`${API_BASE}/api/chunks/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chunkId, checksum }),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        success: false,
        error: data.error || "Acknowledgment failed",
        needsReupload: data.needsReupload,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  }
}

/**
 * Upload a chunk with retry logic
 * Uses smart upload (presigned URL if available, server upload as fallback)
 */
export async function uploadChunkWithRetry(
  params: {
    chunkId: string;
    recordingId: string;
    chunkIndex: number;
    blob: Blob;
    duration?: number;
    format?: AudioFormat;
    useSmartUpload?: boolean;
  },
  maxRetries = 3,
  onProgress?: (attempt: number, maxAttempts: number) => void
): Promise<UploadResult> {
  let lastError: string | undefined;
  const useSmartUpload = params.useSmartUpload ?? true;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    onProgress?.(attempt, maxRetries);

    // Use smart upload (presigned URL) or direct server upload
    const result = useSmartUpload 
      ? await smartUploadChunk(params)
      : await uploadChunk(params);

    if (result.success) {
      // Chunk uploaded, now acknowledge
      const ackResult = await acknowledgeChunk(params.chunkId, result.checksum);

      if (ackResult.success) {
        return { success: true, checksum: result.checksum };
      }

      if (ackResult.needsReupload) {
        // Need to re-upload, continue to next attempt
        lastError = ackResult.error;
        continue;
      }

      // Ack failed but doesn't need re-upload
      return ackResult;
    }

    lastError = result.error;

    // Exponential backoff before retry
    if (attempt < maxRetries) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.pow(2, attempt) * 1000)
      );
    }
  }

  return {
    success: false,
    error: lastError || `Failed after ${maxRetries} attempts`,
  };
}

/**
 * Get chunks that need re-upload for a recording
 */
export async function getChunksNeedingReupload(
  recordingId: string
): Promise<string[]> {
  try {
    const response = await fetch(
      `${API_BASE}/api/chunks/needs-reupload/${recordingId}`
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return data.needsReupload || [];
  } catch {
    return [];
  }
}

/**
 * Run reconciliation for a recording - verify all chunks exist in storage
 */
export async function reconcileRecording(recordingId: string): Promise<{
  success: boolean;
  total: number;
  verified: number;
  missing: Array<{ id: string; chunkIndex: number }>;
}> {
  try {
    const response = await fetch(`${API_BASE}/api/chunks/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingId }),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        success: false,
        total: 0,
        verified: 0,
        missing: [],
      };
    }

    return {
      success: true,
      total: data.reconciliation.total,
      verified: data.reconciliation.verified,
      missing: data.reconciliation.missing,
    };
  } catch {
    return {
      success: false,
      total: 0,
      verified: 0,
      missing: [],
    };
  }
}

/**
 * Re-upload missing chunks from OPFS
 */
export async function reuploadMissingChunks(
  recordingId: string,
  missingChunks: Array<{ id: string; chunkIndex: number }>,
  onProgress?: (current: number, total: number) => void
): Promise<{
  success: boolean;
  uploaded: number;
  failed: Array<{ chunkIndex: number; error: string }>;
}> {
  const results = {
    success: true,
    uploaded: 0,
    failed: [] as Array<{ chunkIndex: number; error: string }>,
  };

  for (let i = 0; i < missingChunks.length; i++) {
    const chunk = missingChunks[i];
    onProgress?.(i + 1, missingChunks.length);

    // Load chunk from OPFS
    const blob = await loadChunkFromOPFS(recordingId, chunk.chunkIndex);

    if (!blob) {
      results.failed.push({
        chunkIndex: chunk.chunkIndex,
        error: "Chunk not found in OPFS",
      });
      results.success = false;
      continue;
    }

    // Re-upload
    const result = await uploadChunkWithRetry({
      chunkId: chunk.id,
      recordingId,
      chunkIndex: chunk.chunkIndex,
      blob,
    });

    if (result.success) {
      results.uploaded++;
    } else {
      results.failed.push({
        chunkIndex: chunk.chunkIndex,
        error: result.error || "Upload failed",
      });
      results.success = false;
    }
  }

  return results;
}

/**
 * Full recovery flow - check for missing chunks and re-upload from OPFS
 */
export async function performRecovery(
  recordingId: string,
  onProgress?: (status: string, progress?: { current: number; total: number }) => void
): Promise<{
  success: boolean;
  reconciled: number;
  reuploaded: number;
  errors: string[];
}> {
  const errors: string[] = [];

  // Step 1: Reconcile
  onProgress?.("Verifying chunks in storage...");
  const reconciliation = await reconcileRecording(recordingId);

  if (!reconciliation.success) {
    return {
      success: false,
      reconciled: 0,
      reuploaded: 0,
      errors: ["Reconciliation failed"],
    };
  }

  if (reconciliation.missing.length === 0) {
    return {
      success: true,
      reconciled: reconciliation.verified,
      reuploaded: 0,
      errors: [],
    };
  }

  // Step 2: Re-upload missing chunks
  onProgress?.(`Re-uploading ${reconciliation.missing.length} missing chunks...`);

  const reuploadResult = await reuploadMissingChunks(
    recordingId,
    reconciliation.missing,
    (current, total) => {
      onProgress?.("Re-uploading chunks", { current, total });
    }
  );

  if (!reuploadResult.success) {
    for (const fail of reuploadResult.failed) {
      errors.push(`Chunk ${fail.chunkIndex}: ${fail.error}`);
    }
  }

  return {
    success: reuploadResult.success,
    reconciled: reconciliation.verified,
    reuploaded: reuploadResult.uploaded,
    errors,
  };
}

/**
 * Clean up OPFS for a recording after successful sync
 */
export async function cleanupOPFS(recordingId: string): Promise<void> {
  const chunks = await listChunksInOPFS(recordingId);

  for (const chunkIndex of chunks) {
    await deleteChunkFromOPFS(recordingId, chunkIndex);
  }
}

/**
 * Generate a unique client ID for this browser
 */
export function getOrCreateClientId(): string {
  const key = "recording_client_id";
  let clientId = localStorage.getItem(key);

  if (!clientId) {
    clientId = crypto.randomUUID();
    localStorage.setItem(key, clientId);
  }

  return clientId;
}

// ============================================
// Transcription API
// ============================================

export interface TranscriptChunk {
  index: number;
  transcript: string | null;
  status: string;
  language: string | null;
  confidence: number | null;
}

export interface RecordingTranscript {
  success: boolean;
  recordingId?: string;
  transcript?: string;
  chunks?: TranscriptChunk[];
  error?: string;
}

/**
 * Get the full transcript for a recording
 */
export async function getRecordingTranscript(
  recordingId: string
): Promise<RecordingTranscript> {
  try {
    const response = await fetch(
      `${API_BASE}/api/chunks/recording/${recordingId}/transcript`,
      {
        headers: getHeaders(),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || "Failed to get transcript" };
    }

    return {
      success: true,
      recordingId: data.recordingId,
      transcript: data.transcript,
      chunks: data.chunks,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  }
}

/**
 * Retry transcription for a specific chunk
 */
export async function retryTranscription(chunkId: string): Promise<{
  success: boolean;
  transcript?: string;
  language?: string;
  confidence?: number;
  error?: string;
}> {
  try {
    const response = await fetch(
      `${API_BASE}/api/chunks/${chunkId}/transcribe`,
      {
        method: "POST",
        headers: getHeaders("application/json"),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || "Transcription failed" };
    }

    return {
      success: data.success,
      transcript: data.transcription?.transcript,
      language: data.transcription?.language,
      confidence: data.transcription?.confidence,
      error: data.error,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  }
}

/**
 * Check if transcription is enabled on the server
 */
export async function checkTranscriptionStatus(): Promise<{
  enabled: boolean;
  model?: string;
}> {
  try {
    const response = await fetch(
      `${API_BASE}/api/chunks/transcription-status`,
      {
        headers: getHeaders(),
      }
    );

    if (!response.ok) {
      return { enabled: false };
    }

    const data = await response.json();
    return {
      enabled: data.enabled,
      model: data.model,
    };
  } catch {
    return { enabled: false };
  }
}
