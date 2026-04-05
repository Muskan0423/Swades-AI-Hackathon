import { env } from "@my-better-t-app/env/server";
import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageResult {
  success: boolean;
  path?: string;
  checksum?: string;
  size?: number;
  error?: string;
}

export interface PresignedUrlResult {
  success: boolean;
  uploadUrl?: string;
  downloadUrl?: string;
  key?: string;
  expiresIn?: number;
  error?: string;
}

export interface StorageProvider {
  upload(key: string, data: Buffer): Promise<StorageResult>;
  download(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  getChecksum(key: string): Promise<string | null>;
  getPresignedUploadUrl?(key: string, expiresIn?: number): Promise<PresignedUrlResult>;
  getPresignedDownloadUrl?(key: string, expiresIn?: number): Promise<PresignedUrlResult>;
}

function computeChecksum(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Local file storage implementation
 * Used for development or when S3 is not configured
 */
class LocalStorage implements StorageProvider {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  private getFullPath(key: string): string {
    return join(this.basePath, key);
  }

  async upload(key: string, data: Buffer): Promise<StorageResult> {
    try {
      const fullPath = this.getFullPath(key);
      const dir = dirname(fullPath);
      await mkdir(dir, { recursive: true });
      await writeFile(fullPath, data);
      const checksum = computeChecksum(data);
      return { success: true, path: key, checksum, size: data.length };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Upload failed",
      };
    }
  }

  async download(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.getFullPath(key));
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.getFullPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await unlink(this.getFullPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async getChecksum(key: string): Promise<string | null> {
    const data = await this.download(key);
    return data ? computeChecksum(data) : null;
  }
}

/**
 * S3 storage implementation
 * Supports AWS S3, MinIO, and other S3-compatible services
 * Features: presigned URLs for direct browser uploads
 */
class S3Storage implements StorageProvider {
  private client: S3Client;
  private bucket: string;

  constructor() {
    this.bucket = env.STORAGE_BUCKET_NAME;
    
    const config: ConstructorParameters<typeof S3Client>[0] = {
      region: env.STORAGE_REGION,
    };

    // Configure for MinIO or custom S3-compatible endpoint
    if (env.STORAGE_ENDPOINT) {
      config.endpoint = env.STORAGE_ENDPOINT;
      config.forcePathStyle = true; // Required for MinIO
    }

    // Use explicit credentials if provided (for MinIO or IAM user)
    if (env.STORAGE_ACCESS_KEY && env.STORAGE_SECRET_KEY) {
      config.credentials = {
        accessKeyId: env.STORAGE_ACCESS_KEY,
        secretAccessKey: env.STORAGE_SECRET_KEY,
      };
    }

    this.client = new S3Client(config);
  }

  async upload(key: string, data: Buffer): Promise<StorageResult> {
    try {
      const checksum = computeChecksum(data);
      
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentType: this.getContentType(key),
          Metadata: {
            checksum,
          },
        })
      );

      return {
        success: true,
        path: key,
        checksum,
        size: data.length,
      };
    } catch (error) {
      console.error("S3 upload error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "S3 upload failed",
      };
    }
  }

  async download(key: string): Promise<Buffer | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );

      if (!response.Body) return null;
      
      // Convert stream to buffer
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  async getChecksum(key: string): Promise<string | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );
      return response.Metadata?.checksum || null;
    } catch {
      return null;
    }
  }

  /**
   * Generate presigned URL for direct browser upload to S3
   * Bypasses server for large file uploads
   */
  async getPresignedUploadUrl(
    key: string,
    expiresIn = 900 // 15 minutes
  ): Promise<PresignedUrlResult> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: this.getContentType(key),
      });

      const uploadUrl = await getSignedUrl(this.client, command, { expiresIn });

      return {
        success: true,
        uploadUrl,
        key,
        expiresIn,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to generate upload URL",
      };
    }
  }

  /**
   * Generate presigned URL for downloading/streaming audio
   * Can be used with CDN for caching
   */
  async getPresignedDownloadUrl(
    key: string,
    expiresIn = 3600 // 1 hour
  ): Promise<PresignedUrlResult> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const downloadUrl = await getSignedUrl(this.client, command, { expiresIn });

      return {
        success: true,
        downloadUrl,
        key,
        expiresIn,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to generate download URL",
      };
    }
  }

  private getContentType(key: string): string {
    if (key.endsWith(".wav")) return "audio/wav";
    if (key.endsWith(".opus")) return "audio/opus";
    if (key.endsWith(".webm")) return "audio/webm";
    return "application/octet-stream";
  }
}

/**
 * Check if S3 is configured
 */
function isS3Configured(): boolean {
  return !!(
    env.STORAGE_BUCKET_NAME &&
    (env.STORAGE_ENDPOINT || env.STORAGE_ACCESS_KEY)
  );
}

/**
 * Create the appropriate storage provider based on configuration
 */
function createStorageProvider(): StorageProvider {
  if (isS3Configured()) {
    console.log("[Storage] Using S3 storage:", env.STORAGE_BUCKET_NAME);
    return new S3Storage();
  }
  console.log("[Storage] Using local storage:", env.STORAGE_LOCAL_PATH);
  return new LocalStorage(env.STORAGE_LOCAL_PATH);
}

// Export singleton storage instance
export const storage = createStorageProvider();

// Export S3 storage for presigned URL access
export const s3Storage = isS3Configured() ? (storage as S3Storage) : null;

/**
 * Generate a storage key for a chunk
 * Supports both WAV and Opus formats
 */
export function getChunkStorageKey(
  recordingId: string,
  chunkIndex: number,
  format: "wav" | "opus" = "wav"
): string {
  const ext = format === "opus" ? "opus" : "wav";
  return `recordings/${recordingId}/chunks/${chunkIndex.toString().padStart(6, "0")}.${ext}`;
}

/**
 * Generate a CDN-friendly URL for audio playback
 * Falls back to presigned URL if CDN is not configured
 */
export async function getPlaybackUrl(key: string): Promise<string | null> {
  if (env.CDN_URL) {
    return `${env.CDN_URL}/${key}`;
  }
  
  if (s3Storage) {
    const result = await s3Storage.getPresignedDownloadUrl(key);
    return result.success ? result.downloadUrl ?? null : null;
  }
  
  // For local storage, return relative path
  return `/api/audio/${key}`;
}
