"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertCircle,
  Check,
  Cloud,
  CloudOff,
  Download,
  FileText,
  HardDrive,
  Loader2,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Upload,
} from "lucide-react"

import { Button } from "@my-better-t-app/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@my-better-t-app/ui/components/card"
import { LiveWaveform } from "@/components/ui/live-waveform"
import { useRecorder, type WavChunk, type SyncStatus } from "@/hooks/use-recorder"
import { 
  getRecordingTranscript, 
  retryTranscription, 
  type TranscriptChunk 
} from "@/lib/chunk-upload"
import { hasApiKey } from "@/lib/config"

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 10)
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`
}

function formatDuration(seconds: number) {
  return `${seconds.toFixed(1)}s`
}

function UploadStatusBadge({ status }: { status: WavChunk["uploadStatus"] }) {
  switch (status) {
    case "pending":
      return (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Upload className="size-3" />
          Pending
        </span>
      )
    case "uploading":
      return (
        <span className="flex items-center gap-1 text-[10px] text-blue-500">
          <Loader2 className="size-3 animate-spin" />
          Uploading
        </span>
      )
    case "uploaded":
      return (
        <span className="flex items-center gap-1 text-[10px] text-amber-500">
          <Cloud className="size-3" />
          Uploaded
        </span>
      )
    case "acknowledged":
      return (
        <span className="flex items-center gap-1 text-[10px] text-green-500">
          <Check className="size-3" />
          Synced
        </span>
      )
    case "failed":
      return (
        <span className="flex items-center gap-1 text-[10px] text-destructive">
          <AlertCircle className="size-3" />
          Failed
        </span>
      )
  }
}

function SyncStatusIndicator({
  status,
  progress,
}: {
  status: SyncStatus
  progress: { total: number; acknowledged: number; percentage: number }
}) {
  if (progress.total === 0) return null

  return (
    <div className="flex items-center gap-2 text-sm">
      {status === "syncing" && (
        <>
          <Loader2 className="size-4 animate-spin text-blue-500" />
          <span>Syncing {progress.acknowledged}/{progress.total}</span>
        </>
      )}
      {status === "synced" && (
        <>
          <Check className="size-4 text-green-500" />
          <span className="text-green-500">All synced</span>
        </>
      )}
      {status === "idle" && progress.acknowledged < progress.total && (
        <>
          <Cloud className="size-4 text-muted-foreground" />
          <span>{progress.acknowledged}/{progress.total} synced</span>
        </>
      )}
      {status === "error" && (
        <>
          <AlertCircle className="size-4 text-destructive" />
          <span className="text-destructive">Sync error</span>
        </>
      )}
    </div>
  )
}

function ChunkRow({ chunk, index }: { chunk: WavChunk; index: number }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)

  const toggle = () => {
    const el = audioRef.current
    if (!el) return
    if (playing) {
      el.pause()
      el.currentTime = 0
      setPlaying(false)
    } else {
      el.play()
      setPlaying(true)
    }
  }

  const download = () => {
    const a = document.createElement("a")
    a.href = chunk.url
    a.download = `chunk-${index + 1}.wav`
    a.click()
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-sm border border-border/50 bg-muted/30 px-3 py-2">
      <audio
        ref={audioRef}
        src={chunk.url}
        onEnded={() => setPlaying(false)}
        preload="none"
      />
      <span className="text-xs font-medium text-muted-foreground tabular-nums">
        #{index + 1}
      </span>
      <span className="text-xs tabular-nums">{formatDuration(chunk.duration)}</span>
      <UploadStatusBadge status={chunk.uploadStatus} />
      <div className="ml-auto flex gap-1">
        <Button variant="ghost" size="icon-xs" onClick={toggle}>
          {playing ? <Square className="size-3" /> : <Play className="size-3" />}
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={download}>
          <Download className="size-3" />
        </Button>
      </div>
    </div>
  )
}

function TranscriptChunkItem({ 
  chunk, 
  onRetry 
}: { 
  chunk: TranscriptChunk
  onRetry: (chunkIndex: number) => void
}) {
  const statusColors: Record<string, string> = {
    completed: "text-green-500",
    processing: "text-blue-500",
    pending: "text-muted-foreground",
    failed: "text-destructive",
  }

  return (
    <div className="border-b border-border/50 pb-2 last:border-0">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground">
          Chunk #{chunk.index + 1}
        </span>
        <div className="flex items-center gap-2">
          {chunk.language && chunk.status === "completed" && (
            <span className="text-[10px] text-muted-foreground uppercase">
              {chunk.language}
            </span>
          )}
          {chunk.confidence !== null && chunk.status === "completed" && (
            <span className="text-[10px] text-muted-foreground">
              {chunk.confidence}%
            </span>
          )}
          <span className={`text-[10px] ${statusColors[chunk.status] || ""}`}>
            {chunk.status === "processing" && (
              <Loader2 className="inline size-3 animate-spin mr-1" />
            )}
            {chunk.status}
          </span>
          {chunk.status === "failed" && (
            <Button 
              variant="ghost" 
              size="icon-xs"
              onClick={() => onRetry(chunk.index)}
              title="Retry transcription"
            >
              <RefreshCw className="size-3" />
            </Button>
          )}
        </div>
      </div>
      {chunk.transcript ? (
        <p className="text-sm">{chunk.transcript}</p>
      ) : chunk.status === "pending" ? (
        <p className="text-sm text-muted-foreground italic">Waiting for transcription...</p>
      ) : chunk.status === "processing" ? (
        <p className="text-sm text-muted-foreground italic">Transcribing...</p>
      ) : (
        <p className="text-sm text-muted-foreground italic">No transcript</p>
      )}
    </div>
  )
}

function TranscriptPanel({ 
  recordingId,
  chunksCount,
  isRecording,
}: { 
  recordingId: string | null
  chunksCount: number
  isRecording: boolean
}) {
  const [transcript, setTranscript] = useState<{
    full: string
    chunks: TranscriptChunk[]
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<number | null>(null)
  const apiKeyConfigured = hasApiKey()

  // Fetch transcript periodically
  useEffect(() => {
    if (!recordingId || chunksCount === 0) {
      setTranscript(null)
      return
    }

    async function fetchTranscript() {
      const result = await getRecordingTranscript(recordingId!)
      if (result.success && result.chunks) {
        setTranscript({
          full: result.transcript || "",
          chunks: result.chunks,
        })
        setError(null)
      } else if (result.error) {
        setError(result.error)
      }
    }

    // Initial fetch
    setLoading(true)
    fetchTranscript().finally(() => setLoading(false))

    // Poll every 3 seconds while recording or if there are pending transcriptions
    const interval = setInterval(() => {
      fetchTranscript()
    }, 3000)

    return () => clearInterval(interval)
  }, [recordingId, chunksCount, isRecording])

  const handleRetry = async (chunkIndex: number) => {
    if (!transcript) return
    
    // Find the chunk ID from chunks (we need to pass chunk ID to retry)
    // For now, we'll refetch after a short delay
    setRetrying(chunkIndex)
    
    // Refetch transcript after a short delay to trigger retry
    setTimeout(async () => {
      const result = await getRecordingTranscript(recordingId!)
      if (result.success && result.chunks) {
        setTranscript({
          full: result.transcript || "",
          chunks: result.chunks,
        })
      }
      setRetrying(null)
    }, 1000)
  }

  const copyToClipboard = () => {
    if (transcript?.full) {
      navigator.clipboard.writeText(transcript.full)
    }
  }

  const downloadTranscript = () => {
    if (transcript?.full) {
      const blob = new Blob([transcript.full], { type: "text/plain" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `transcript-${recordingId?.slice(0, 8)}.txt`
      a.click()
      URL.revokeObjectURL(url)
    }
  }

  if (!recordingId || chunksCount === 0) {
    return null
  }

  if (!apiKeyConfigured) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="size-5" />
            Transcript
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4">
            <p className="text-sm text-muted-foreground mb-2">
              Configure your OpenAI API key to enable transcription
            </p>
            <a 
              href="/"
              className="text-sm text-blue-400 hover:underline"
            >
              Go to Settings →
            </a>
          </div>
        </CardContent>
      </Card>
    )
  }

  const completedCount = transcript?.chunks.filter(c => c.status === "completed").length || 0
  const pendingCount = transcript?.chunks.filter(c => c.status === "pending" || c.status === "processing").length || 0

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileText className="size-5" />
              Transcript
            </CardTitle>
            <CardDescription>
              {completedCount} of {transcript?.chunks.length || 0} chunks transcribed
              {pendingCount > 0 && (
                <span className="text-blue-500 ml-2">
                  ({pendingCount} in progress)
                </span>
              )}
            </CardDescription>
          </div>
          {transcript?.full && (
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={copyToClipboard}>
                Copy
              </Button>
              <Button variant="ghost" size="sm" onClick={downloadTranscript}>
                <Download className="size-3 mr-1" />
                Download
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading && !transcript && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="text-sm text-destructive py-2">{error}</div>
        )}

        {transcript && (
          <div className="space-y-3">
            {/* Full transcript */}
            {transcript.full && (
              <div className="p-3 bg-muted/30 rounded-lg border border-border/50">
                <p className="text-sm whitespace-pre-wrap">{transcript.full}</p>
              </div>
            )}

            {/* Individual chunks */}
            <details className="group">
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                View by chunk ({transcript.chunks.length})
              </summary>
              <div className="mt-2 space-y-2 pl-2 border-l-2 border-border/50">
                {transcript.chunks.map((chunk) => (
                  <TranscriptChunkItem 
                    key={chunk.index} 
                    chunk={chunk}
                    onRetry={handleRetry}
                  />
                ))}
              </div>
            </details>
          </div>
        )}

        {!loading && !transcript && !error && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No transcripts yet. Transcription starts after chunks are uploaded.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export default function RecorderPage() {
  const [deviceId] = useState<string | undefined>()
  const {
    status,
    start,
    stop,
    pause,
    resume,
    chunks,
    elapsed,
    stream,
    clearChunks,
    recordingId,
    syncStatus,
    opfsSupported,
    retryFailedChunks,
    getUploadProgress,
  } = useRecorder({ chunkDuration: 5, deviceId, autoUpload: true })

  const isRecording = status === "recording"
  const isPaused = status === "paused"
  const isActive = isRecording || isPaused
  const progress = getUploadProgress()
  const hasFailedChunks = progress.failed > 0

  const handlePrimary = useCallback(() => {
    if (isActive) {
      stop()
    } else {
      start()
    }
  }, [isActive, stop, start])

  return (
    <div className="container mx-auto flex max-w-lg flex-col items-center gap-6 px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle>Recorder</CardTitle>
              <CardDescription>16 kHz / 16-bit PCM WAV — chunked every 5 s</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {opfsSupported ? (
                <span className="flex items-center gap-1 text-[10px] text-green-600">
                  <HardDrive className="size-3" />
                  OPFS
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[10px] text-amber-500">
                  <CloudOff className="size-3" />
                  No OPFS
                </span>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          {/* Waveform */}
          <div className="overflow-hidden rounded-sm border border-border/50 bg-muted/20 text-foreground">
            <LiveWaveform
              active={isRecording}
              processing={isPaused}
              stream={stream}
              height={80}
              barWidth={3}
              barGap={1}
              barRadius={2}
              sensitivity={1.8}
              smoothingTimeConstant={0.85}
              fadeEdges
              fadeWidth={32}
              mode="static"
            />
          </div>

          {/* Timer */}
          <div className="text-center font-mono text-3xl tabular-nums tracking-tight">
            {formatTime(elapsed)}
          </div>

          {/* Controls */}
          <div className="flex items-center justify-center gap-3">
            {/* Record / Stop */}
            <Button
              size="lg"
              variant={isActive ? "destructive" : "default"}
              className="gap-2 px-5"
              onClick={handlePrimary}
              disabled={status === "requesting"}
            >
              {isActive ? (
                <>
                  <Square className="size-4" />
                  Stop
                </>
              ) : (
                <>
                  <Mic className="size-4" />
                  {status === "requesting" ? "Requesting..." : "Record"}
                </>
              )}
            </Button>

            {/* Pause / Resume */}
            {isActive && (
              <Button
                size="lg"
                variant="outline"
                className="gap-2"
                onClick={isPaused ? resume : pause}
              >
                {isPaused ? (
                  <>
                    <Play className="size-4" />
                    Resume
                  </>
                ) : (
                  <>
                    <Pause className="size-4" />
                    Pause
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Chunks */}
      {chunks.length > 0 && (
        <Card className="w-full">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Chunks</CardTitle>
                <CardDescription>{chunks.length} recorded</CardDescription>
              </div>
              <SyncStatusIndicator status={syncStatus} progress={progress} />
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {/* Progress bar */}
            {chunks.length > 0 && (
              <div className="mb-2">
                <div className="flex justify-between text-xs text-muted-foreground mb-1">
                  <span>Upload Progress</span>
                  <span>{progress.percentage}%</span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-green-500 transition-all duration-300"
                    style={{ width: `${progress.percentage}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                  <span>{progress.acknowledged} synced</span>
                  {progress.uploading > 0 && (
                    <span className="text-blue-500">{progress.uploading} uploading</span>
                  )}
                  {progress.failed > 0 && (
                    <span className="text-destructive">{progress.failed} failed</span>
                  )}
                </div>
              </div>
            )}

            {chunks.map((chunk, i) => (
              <ChunkRow key={chunk.id} chunk={chunk} index={i} />
            ))}

            <div className="mt-2 flex items-center justify-between">
              {hasFailedChunks && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={retryFailedChunks}
                >
                  <RefreshCw className="size-3" />
                  Retry failed
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 ml-auto text-destructive"
                onClick={clearChunks}
              >
                <Trash2 className="size-3" />
                Clear all
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Transcript Panel */}
      <TranscriptPanel 
        recordingId={recordingId}
        chunksCount={chunks.length}
        isRecording={status === "recording"}
      />

      {/* Recording ID (for debugging) */}
      {recordingId && (
        <p className="text-xs text-muted-foreground">
          Recording ID: <code className="font-mono">{recordingId}</code>
        </p>
      )}
    </div>
  )
}
