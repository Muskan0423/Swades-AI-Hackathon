import { useCallback, useEffect, useRef, useState } from "react"
import { saveChunkToOPFS, isOPFSSupported, deleteChunkFromOPFS, saveRecordingMetadata } from "@/lib/opfs"
import {
  createRecording,
  completeRecording,
  uploadChunkWithRetry,
  getOrCreateClientId,
  type ChunkUploadStatus,
} from "@/lib/chunk-upload"

const SAMPLE_RATE = 16000
const BUFFER_SIZE = 4096

export interface WavChunk {
  id: string
  blob: Blob
  url: string
  duration: number
  timestamp: number
  chunkIndex: number
  uploadStatus: ChunkUploadStatus
  error?: string
}

export type RecorderStatus = "idle" | "requesting" | "recording" | "paused"

export type SyncStatus = "idle" | "syncing" | "synced" | "error"

interface UseRecorderOptions {
  chunkDuration?: number
  deviceId?: string
  autoUpload?: boolean // Enable automatic upload pipeline
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  writeStr(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  writeStr(8, "WAVE")
  writeStr(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, "data")
  view.setUint32(40, samples.length * 2, true)

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }

  return new Blob([buffer], { type: "audio/wav" })
}

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const length = Math.round(input.length / ratio)
  const output = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const srcIndex = i * ratio
    const low = Math.floor(srcIndex)
    const high = Math.min(low + 1, input.length - 1)
    const frac = srcIndex - low
    output[i] = input[low] * (1 - frac) + input[high] * frac
  }
  return output
}

export function useRecorder(options: UseRecorderOptions = {}) {
  const { chunkDuration = 5, deviceId, autoUpload = true } = options

  const [status, setStatus] = useState<RecorderStatus>("idle")
  const [chunks, setChunks] = useState<WavChunk[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle")
  const [opfsSupported, setOpfsSupported] = useState(true)

  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const samplesRef = useRef<Float32Array[]>([])
  const sampleCountRef = useRef(0)
  const chunkThreshold = SAMPLE_RATE * chunkDuration
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef(0)
  const pausedElapsedRef = useRef(0)
  const statusRef = useRef<RecorderStatus>("idle")
  const recordingIdRef = useRef<string | null>(null)
  const chunkIndexRef = useRef(0)
  const uploadQueueRef = useRef<Array<{ chunk: WavChunk; resolve: () => void }>>([])
  const isUploadingRef = useRef(false)
  const serverCreatedRef = useRef(false)

  statusRef.current = status
  recordingIdRef.current = recordingId

  // Check OPFS support on mount
  useEffect(() => {
    setOpfsSupported(isOPFSSupported())
  }, [])

  // Process upload queue
  const processUploadQueue = useCallback(async () => {
    if (isUploadingRef.current || uploadQueueRef.current.length === 0) return
    if (!recordingIdRef.current) return
    // Skip uploads if server recording wasn't created
    if (!serverCreatedRef.current) {
      console.warn("Skipping upload - server recording not created")
      return
    }

    isUploadingRef.current = true
    setSyncStatus("syncing")

    while (uploadQueueRef.current.length > 0) {
      const item = uploadQueueRef.current[0]
      const { chunk } = item

      try {
        // Update chunk status to uploading
        setChunks((prev) =>
          prev.map((c) =>
            c.id === chunk.id ? { ...c, uploadStatus: "uploading" as const } : c
          )
        )

        // Upload with retry
        const result = await uploadChunkWithRetry({
          chunkId: chunk.id,
          recordingId: recordingIdRef.current!,
          chunkIndex: chunk.chunkIndex,
          blob: chunk.blob,
          duration: chunk.duration,
        })

        if (result.success) {
          // Update chunk status to acknowledged
          setChunks((prev) =>
            prev.map((c) =>
              c.id === chunk.id ? { ...c, uploadStatus: "acknowledged" as const } : c
            )
          )

          // Clean up OPFS for this chunk
          if (opfsSupported && recordingIdRef.current) {
            await deleteChunkFromOPFS(recordingIdRef.current, chunk.chunkIndex)
          }
        } else {
          // Update chunk status to failed
          setChunks((prev) =>
            prev.map((c) =>
              c.id === chunk.id
                ? { ...c, uploadStatus: "failed" as const, error: result.error }
                : c
            )
          )
        }
      } catch (error) {
        setChunks((prev) =>
          prev.map((c) =>
            c.id === chunk.id
              ? {
                  ...c,
                  uploadStatus: "failed" as const,
                  error: error instanceof Error ? error.message : "Unknown error",
                }
              : c
          )
        )
      }

      // Remove from queue
      uploadQueueRef.current.shift()
      item.resolve()
    }

    isUploadingRef.current = false

    // Check if all chunks are synced
    const allSynced = chunks.every(
      (c) => c.uploadStatus === "acknowledged"
    )
    setSyncStatus(allSynced ? "synced" : "idle")
  }, [chunks, opfsSupported])

  // Create and queue a chunk
  const createAndQueueChunk = useCallback(
    async (samples: Float32Array) => {
      const blob = encodeWav(samples, SAMPLE_RATE)
      const url = URL.createObjectURL(blob)
      const currentIndex = chunkIndexRef.current++

      const chunk: WavChunk = {
        id: crypto.randomUUID(),
        blob,
        url,
        duration: samples.length / SAMPLE_RATE,
        timestamp: Date.now(),
        chunkIndex: currentIndex,
        uploadStatus: autoUpload ? "pending" : "acknowledged",
      }

      // Save to OPFS first (durable storage)
      if (opfsSupported && recordingIdRef.current && autoUpload) {
        const saveResult = await saveChunkToOPFS(
          recordingIdRef.current,
          currentIndex,
          blob
        )
        if (!saveResult.success) {
          console.error("Failed to save chunk to OPFS:", saveResult.error)
        }
      }

      // Add to chunks state
      setChunks((prev) => [...prev, chunk])

      // Queue for upload if auto-upload is enabled
      if (autoUpload && recordingIdRef.current) {
        return new Promise<void>((resolve) => {
          uploadQueueRef.current.push({ chunk, resolve })
          processUploadQueue()
        })
      }
    },
    [autoUpload, opfsSupported, processUploadQueue]
  )

  const flushChunk = useCallback(() => {
    if (samplesRef.current.length === 0) return

    const totalLen = samplesRef.current.reduce((n, b) => n + b.length, 0)
    const merged = new Float32Array(totalLen)
    let offset = 0
    for (const buf of samplesRef.current) {
      merged.set(buf, offset)
      offset += buf.length
    }
    samplesRef.current = []
    sampleCountRef.current = 0

    // Use async chunk creation
    createAndQueueChunk(merged)
  }, [createAndQueueChunk])

  const start = useCallback(async () => {
    if (statusRef.current === "recording") return

    setStatus("requesting")
    try {
      // Create recording session on server
      const newRecordingId = crypto.randomUUID()
      const clientId = getOrCreateClientId()

      serverCreatedRef.current = false
      if (autoUpload) {
        const createResult = await createRecording({
          id: newRecordingId,
          clientId,
          sampleRate: SAMPLE_RATE,
          chunkDuration,
        })

        if (!createResult.success) {
          console.error("Failed to create recording:", createResult.error)
          // Don't upload to server - just save to OPFS for later sync
        } else {
          serverCreatedRef.current = true
        }

        // Save metadata to OPFS
        if (opfsSupported) {
          await saveRecordingMetadata(newRecordingId, {
            clientId,
            sampleRate: SAMPLE_RATE,
            chunkDuration,
            totalChunks: 0,
            createdAt: new Date().toISOString(),
            serverCreated: serverCreatedRef.current,
          })
        }
      }

      setRecordingId(newRecordingId)
      recordingIdRef.current = newRecordingId
      chunkIndexRef.current = 0
      uploadQueueRef.current = []

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId
          ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }
          : { echoCancellation: true, noiseSuppression: true },
      })

      const audioCtx = new AudioContext()
      const source = audioCtx.createMediaStreamSource(mediaStream)
      const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1)
      const nativeSampleRate = audioCtx.sampleRate

      processor.onaudioprocess = (e) => {
        if (statusRef.current !== "recording") return

        const input = e.inputBuffer.getChannelData(0)
        const resampled = resample(new Float32Array(input), nativeSampleRate, SAMPLE_RATE)

        samplesRef.current.push(resampled)
        sampleCountRef.current += resampled.length

        if (sampleCountRef.current >= chunkThreshold) {
          // flush synchronously from the collected buffers
          const totalLen = samplesRef.current.reduce((n, b) => n + b.length, 0)
          const merged = new Float32Array(totalLen)
          let off = 0
          for (const buf of samplesRef.current) {
            merged.set(buf, off)
            off += buf.length
          }
          samplesRef.current = []
          sampleCountRef.current = 0

          // Use async chunk creation with OPFS + upload
          createAndQueueChunk(merged)
        }
      }

      source.connect(processor)
      processor.connect(audioCtx.destination)

      streamRef.current = mediaStream
      audioCtxRef.current = audioCtx
      processorRef.current = processor
      setStream(mediaStream)

      samplesRef.current = []
      sampleCountRef.current = 0
      pausedElapsedRef.current = 0
      startTimeRef.current = Date.now()
      setElapsed(0)
      setSyncStatus("idle")
      setStatus("recording")

      timerRef.current = setInterval(() => {
        if (statusRef.current === "recording") {
          setElapsed(
            pausedElapsedRef.current + (Date.now() - startTimeRef.current) / 1000
          )
        }
      }, 100)
    } catch {
      setStatus("idle")
    }
  }, [deviceId, chunkThreshold, autoUpload, opfsSupported, chunkDuration, createAndQueueChunk])

  const stop = useCallback(async () => {
    flushChunk()

    processorRef.current?.disconnect()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    if (audioCtxRef.current?.state !== "closed") {
      audioCtxRef.current?.close()
    }
    if (timerRef.current) clearInterval(timerRef.current)

    processorRef.current = null
    audioCtxRef.current = null
    streamRef.current = null
    setStream(null)
    setStatus("idle")

    // Complete recording on server
    if (autoUpload && recordingIdRef.current) {
      const totalChunks = chunkIndexRef.current
      await completeRecording(recordingIdRef.current, totalChunks)

      // Update metadata in OPFS
      if (opfsSupported) {
        const clientId = getOrCreateClientId()
        await saveRecordingMetadata(recordingIdRef.current, {
          clientId,
          sampleRate: SAMPLE_RATE,
          chunkDuration,
          totalChunks,
          createdAt: new Date().toISOString(),
        })
      }
    }
  }, [flushChunk, autoUpload, opfsSupported, chunkDuration])

  const pause = useCallback(() => {
    if (statusRef.current !== "recording") return
    pausedElapsedRef.current += (Date.now() - startTimeRef.current) / 1000
    setStatus("paused")
  }, [])

  const resume = useCallback(() => {
    if (statusRef.current !== "paused") return
    startTimeRef.current = Date.now()
    setStatus("recording")
  }, [])

  const clearChunks = useCallback(() => {
    for (const c of chunks) URL.revokeObjectURL(c.url)
    setChunks([])
    chunkIndexRef.current = 0
  }, [chunks])

  // Retry failed chunks
  const retryFailedChunks = useCallback(async () => {
    const failedChunks = chunks.filter((c) => c.uploadStatus === "failed")

    for (const chunk of failedChunks) {
      // Re-queue for upload
      setChunks((prev) =>
        prev.map((c) =>
          c.id === chunk.id ? { ...c, uploadStatus: "pending" as const, error: undefined } : c
        )
      )

      await new Promise<void>((resolve) => {
        uploadQueueRef.current.push({ chunk, resolve })
        processUploadQueue()
      })
    }
  }, [chunks, processUploadQueue])

  // Get upload progress
  const getUploadProgress = useCallback(() => {
    const total = chunks.length
    const acknowledged = chunks.filter((c) => c.uploadStatus === "acknowledged").length
    const uploading = chunks.filter((c) => c.uploadStatus === "uploading").length
    const failed = chunks.filter((c) => c.uploadStatus === "failed").length
    const pending = chunks.filter((c) => c.uploadStatus === "pending").length

    return {
      total,
      acknowledged,
      uploading,
      failed,
      pending,
      percentage: total > 0 ? Math.round((acknowledged / total) * 100) : 0,
    }
  }, [chunks])

  // cleanup on unmount
  useEffect(() => {
    return () => {
      processorRef.current?.disconnect()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (audioCtxRef.current?.state !== "closed") {
        audioCtxRef.current?.close()
      }
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  return {
    status,
    start,
    stop,
    pause,
    resume,
    chunks,
    elapsed,
    stream,
    clearChunks,
    // New pipeline features
    recordingId,
    syncStatus,
    opfsSupported,
    retryFailedChunks,
    getUploadProgress,
  }
}
