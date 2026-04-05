import { Hono } from "hono";
import { z } from "zod";
import { db, recordings } from "@my-better-t-app/db";
import { eq } from "drizzle-orm";

const app = new Hono();

// Create a new recording session
const createRecordingSchema = z.object({
  id: z.string().uuid(),
  clientId: z.string().min(1),
  sampleRate: z.number().default(16000),
  chunkDuration: z.number().default(5),
});

app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createRecordingSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ success: false, error: "Invalid request body" }, 400);
    }

    const data = parsed.data;

    const [recording] = await db
      .insert(recordings)
      .values({
        id: data.id,
        clientId: data.clientId,
        sampleRate: data.sampleRate,
        chunkDuration: data.chunkDuration,
        status: "active",
      })
      .returning();

    return c.json({ success: true, recording });
  } catch (error) {
    console.error("Failed to create recording:", error);
    return c.json(
      { success: false, error: "Failed to create recording" },
      500
    );
  }
});

// Get recording by ID
app.get("/:id", async (c) => {
  const id = c.req.param("id");

  try {
    const [recording] = await db
      .select()
      .from(recordings)
      .where(eq(recordings.id, id))
      .limit(1);

    if (!recording) {
      return c.json({ success: false, error: "Recording not found" }, 404);
    }

    return c.json({ success: true, recording });
  } catch (error) {
    console.error("Failed to get recording:", error);
    return c.json({ success: false, error: "Failed to get recording" }, 500);
  }
});

// Complete a recording session
const completeRecordingSchema = z.object({
  totalChunks: z.number().min(0),
});

app.post("/:id/complete", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const parsed = completeRecordingSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ success: false, error: "Invalid request body" }, 400);
    }

    const { totalChunks } = parsed.data;

    const [recording] = await db
      .update(recordings)
      .set({
        status: "completed",
        totalChunks,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(recordings.id, id))
      .returning();

    if (!recording) {
      return c.json({ success: false, error: "Recording not found" }, 404);
    }

    return c.json({ success: true, recording });
  } catch (error) {
    console.error("Failed to complete recording:", error);
    return c.json(
      { success: false, error: "Failed to complete recording" },
      500
    );
  }
});

export default app;
