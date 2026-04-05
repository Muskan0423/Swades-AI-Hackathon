import {
  pgTable,
  text,
  timestamp,
  integer,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Enums
export const recordingStatusEnum = pgEnum("recording_status", [
  "active",
  "completed",
  "failed",
]);

export const chunkStatusEnum = pgEnum("chunk_status", [
  "pending",
  "uploaded",
  "acknowledged",
  "failed",
]);

export const transcriptionStatusEnum = pgEnum("transcription_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

// Recordings table - represents a recording session
export const recordings = pgTable("recordings", {
  id: text("id").primaryKey(), // UUID from client
  clientId: text("client_id").notNull(), // Browser/device identifier
  status: recordingStatusEnum("status").default("active").notNull(),
  totalChunks: integer("total_chunks").default(0).notNull(),
  acknowledgedChunks: integer("acknowledged_chunks").default(0).notNull(),
  sampleRate: integer("sample_rate").default(16000).notNull(),
  chunkDuration: integer("chunk_duration").default(5).notNull(), // seconds
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  // Index for finding recordings by client (user's recordings)
  index("recordings_client_id_idx").on(table.clientId),
  // Index for finding active/recent recordings
  index("recordings_status_created_idx").on(table.status, table.createdAt),
  // Index for finding incomplete recordings for reconciliation
  index("recordings_status_updated_idx").on(table.status, table.updatedAt),
]);

// Chunks table - individual audio chunks
export const chunks = pgTable("chunks", {
  id: text("id").primaryKey(), // UUID from client
  recordingId: text("recording_id")
    .references(() => recordings.id, { onDelete: "cascade" })
    .notNull(),
  chunkIndex: integer("chunk_index").notNull(), // 0-based index
  status: chunkStatusEnum("status").default("pending").notNull(),
  bucketPath: text("bucket_path"), // Path in storage bucket
  fileSize: integer("file_size"), // Size in bytes
  duration: integer("duration"), // Duration in milliseconds
  checksum: text("checksum"), // SHA256 hash for verification
  uploadedAt: timestamp("uploaded_at"),
  acknowledgedAt: timestamp("acknowledged_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  retryCount: integer("retry_count").default(0).notNull(),
  lastError: text("last_error"),
  // Transcription fields
  transcript: text("transcript"),
  transcriptionStatus: transcriptionStatusEnum("transcription_status").default("pending"),
  transcribedAt: timestamp("transcribed_at"),
  transcriptionError: text("transcription_error"),
  language: text("language"), // Detected language code
  confidence: integer("confidence"), // Confidence score 0-100
}, (table) => [
  // Unique constraint: one chunk per index per recording
  uniqueIndex("chunks_recording_index_unique").on(table.recordingId, table.chunkIndex),
  // Index for finding chunks by recording (ordered)
  index("chunks_recording_id_idx").on(table.recordingId),
  // Index for finding chunks by status (for reconciliation)
  index("chunks_status_idx").on(table.status),
  // Index for finding failed chunks that need retry
  index("chunks_status_retry_idx").on(table.status, table.retryCount),
]);

// Types
export type Recording = typeof recordings.$inferSelect;
export type NewRecording = typeof recordings.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
