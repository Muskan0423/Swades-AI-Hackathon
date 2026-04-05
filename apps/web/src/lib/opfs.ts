/**
 * Origin Private File System (OPFS) utilities for durable client-side storage
 *
 * OPFS provides a sandboxed file system that persists data even when:
 * - The tab is closed
 * - The browser is restarted
 * - Network connection is lost
 *
 * Chunks are only cleared from OPFS after both:
 * 1. Successfully uploaded to storage bucket
 * 2. Acknowledged in the database
 */

const RECORDINGS_DIR = "recordings";

/**
 * Check if OPFS is supported in this browser
 */
export function isOPFSSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    "getDirectory" in navigator.storage
  );
}

/**
 * Get the root OPFS directory handle
 */
async function getRoot(): Promise<FileSystemDirectoryHandle> {
  if (!isOPFSSupported()) {
    throw new Error("OPFS is not supported in this browser");
  }
  return navigator.storage.getDirectory();
}

/**
 * Get or create a directory in OPFS
 */
async function getOrCreateDir(
  parent: FileSystemDirectoryHandle,
  name: string
): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create: true });
}

/**
 * Get the directory for a specific recording
 */
async function getRecordingDir(
  recordingId: string
): Promise<FileSystemDirectoryHandle> {
  const root = await getRoot();
  const recordingsDir = await getOrCreateDir(root, RECORDINGS_DIR);
  return getOrCreateDir(recordingsDir, recordingId);
}

/**
 * Save a chunk to OPFS
 */
export async function saveChunkToOPFS(
  recordingId: string,
  chunkIndex: number,
  blob: Blob
): Promise<{ success: boolean; error?: string }> {
  try {
    const dir = await getRecordingDir(recordingId);
    const fileName = `chunk_${chunkIndex.toString().padStart(6, "0")}.wav`;
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return { success: true };
  } catch (error) {
    console.error("Failed to save chunk to OPFS:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Load a chunk from OPFS
 */
export async function loadChunkFromOPFS(
  recordingId: string,
  chunkIndex: number
): Promise<Blob | null> {
  try {
    const dir = await getRecordingDir(recordingId);
    const fileName = `chunk_${chunkIndex.toString().padStart(6, "0")}.wav`;
    const fileHandle = await dir.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    return file;
  } catch {
    return null;
  }
}

/**
 * Delete a chunk from OPFS (call after successful ack)
 */
export async function deleteChunkFromOPFS(
  recordingId: string,
  chunkIndex: number
): Promise<boolean> {
  try {
    const dir = await getRecordingDir(recordingId);
    const fileName = `chunk_${chunkIndex.toString().padStart(6, "0")}.wav`;
    await dir.removeEntry(fileName);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all chunks in OPFS for a recording
 */
export async function listChunksInOPFS(
  recordingId: string
): Promise<number[]> {
  try {
    const dir = await getRecordingDir(recordingId);
    const chunks: number[] = [];

    // @ts-expect-error - entries() is part of the async iterator protocol for FileSystemDirectoryHandle
    for await (const [name] of dir) {
      const match = name.match(/^chunk_(\d+)\.wav$/);
      if (match) {
        chunks.push(parseInt(match[1], 10));
      }
    }

    return chunks.sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Delete entire recording directory from OPFS
 */
export async function deleteRecordingFromOPFS(
  recordingId: string
): Promise<boolean> {
  try {
    const root = await getRoot();
    const recordingsDir = await getOrCreateDir(root, RECORDINGS_DIR);
    await recordingsDir.removeEntry(recordingId, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all recording IDs stored in OPFS
 */
export async function listRecordingsInOPFS(): Promise<string[]> {
  try {
    const root = await getRoot();
    const recordingsDir = await getOrCreateDir(root, RECORDINGS_DIR);
    const recordings: string[] = [];

    // Use values() iterator which is more widely supported
    // @ts-expect-error - FileSystemDirectoryHandle is async iterable
    for await (const entry of recordingsDir.values()) {
      if (entry.kind === "directory") {
        recordings.push(entry.name);
      }
    }

    return recordings;
  } catch {
    return [];
  }
}

/**
 * Save recording metadata to OPFS
 */
export async function saveRecordingMetadata(
  recordingId: string,
  metadata: {
    clientId: string;
    sampleRate: number;
    chunkDuration: number;
    totalChunks: number;
    createdAt: string;
    serverCreated?: boolean;
  }
): Promise<boolean> {
  try {
    const dir = await getRecordingDir(recordingId);
    const fileHandle = await dir.getFileHandle("metadata.json", {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(metadata, null, 2));
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Load recording metadata from OPFS
 */
export async function loadRecordingMetadata(recordingId: string): Promise<{
  clientId: string;
  sampleRate: number;
  chunkDuration: number;
  totalChunks: number;
  createdAt: string;
  serverCreated?: boolean;
} | null> {
  try {
    const dir = await getRecordingDir(recordingId);
    const fileHandle = await dir.getFileHandle("metadata.json");
    const file = await fileHandle.getFile();
    const text = await file.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Get OPFS storage usage info
 */
export async function getOPFSStorageInfo(): Promise<{
  used: number;
  quota: number;
  percentage: number;
} | null> {
  try {
    const estimate = await navigator.storage.estimate();
    return {
      used: estimate.usage || 0,
      quota: estimate.quota || 0,
      percentage: estimate.quota
        ? Math.round(((estimate.usage || 0) / estimate.quota) * 100)
        : 0,
    };
  } catch {
    return null;
  }
}
