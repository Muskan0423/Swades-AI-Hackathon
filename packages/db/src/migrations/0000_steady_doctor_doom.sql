CREATE TYPE "public"."chunk_status" AS ENUM('pending', 'uploaded', 'acknowledged', 'failed');--> statement-breakpoint
CREATE TYPE "public"."recording_status" AS ENUM('active', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"status" "chunk_status" DEFAULT 'pending' NOT NULL,
	"bucket_path" text,
	"file_size" integer,
	"duration" integer,
	"checksum" text,
	"uploaded_at" timestamp,
	"acknowledged_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"status" "recording_status" DEFAULT 'active' NOT NULL,
	"total_chunks" integer DEFAULT 0 NOT NULL,
	"acknowledged_chunks" integer DEFAULT 0 NOT NULL,
	"sample_rate" integer DEFAULT 16000 NOT NULL,
	"chunk_duration" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;