"use client";

import { useEffect, useState } from "react";
import { loadConfig, saveConfig, maskApiKey, hasApiKey, type AppConfig } from "@/lib/config";

const TITLE_TEXT = `
 ██████╗ ███████╗████████╗████████╗███████╗██████╗
 ██╔══██╗██╔════╝╚══██╔══╝╚══██╔══╝██╔════╝██╔══██╗
 ██████╔╝█████╗     ██║      ██║   █████╗  ██████╔╝
 ██╔══██╗██╔══╝     ██║      ██║   ██╔══╝  ██╔══██╗
 ██████╔╝███████╗   ██║      ██║   ███████╗██║  ██║
 ╚═════╝ ╚══════╝   ╚═╝      ╚═╝   ╚══════╝╚═╝  ╚═╝

 ████████╗    ███████╗████████╗ █████╗  ██████╗██╗  ██╗
 ╚══██╔══╝    ██╔════╝╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝
    ██║       ███████╗   ██║   ███████║██║     █████╔╝
    ██║       ╚════██║   ██║   ██╔══██║██║     ██╔═██╗
    ██║       ███████║   ██║   ██║  ██║╚██████╗██║  ██╗
    ╚═╝       ╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝
 `;

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

interface HealthData {
  status: string;
  timestamp: string;
  services: {
    database: string;
    cache: string;
    storage: string;
    transcription: string;
  };
  config: {
    rateLimit: {
      requests: number;
      window: number;
    };
  };
}

interface StatsData {
  recordings: {
    total: number;
    active: number;
    completed: number;
  };
  chunks: {
    total: number;
    uploaded: number;
    acknowledged: number;
    transcribed: number;
    pendingTranscription: number;
  };
  recentRecordings: Array<{
    id: string;
    status: string;
    totalChunks: number;
    createdAt: string;
  }>;
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const colors: Record<string, string> = {
    connected: "bg-green-500/20 text-green-400 border-green-500/30",
    enabled: "bg-green-500/20 text-green-400 border-green-500/30",
    ok: "bg-green-500/20 text-green-400 border-green-500/30",
    s3: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    local: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    disconnected: "bg-red-500/20 text-red-400 border-red-500/30",
    unavailable: "bg-gray-500/20 text-gray-400 border-gray-500/30",
    disabled: "bg-gray-500/20 text-gray-400 border-gray-500/30",
    degraded: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  };

  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`px-2 py-0.5 text-xs rounded border ${colors[status] || colors.unavailable}`}>
        {status}
      </span>
    </div>
  );
}

function StatCard({ label, value, subtext }: { label: string; value: number | string; subtext?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 text-center">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
      {subtext && <div className="text-xs text-muted-foreground mt-1">{subtext}</div>}
    </div>
  );
}

function SettingsPanel() {
  const [apiKey, setApiKey] = useState("");
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const config = loadConfig();
    if (config.openaiApiKey) {
      setSavedKey(config.openaiApiKey);
    }
  }, []);

  const handleSave = () => {
    if (!apiKey.trim()) {
      setMessage({ type: "error", text: "Please enter an API key" });
      return;
    }

    if (!apiKey.startsWith("sk-")) {
      setMessage({ type: "error", text: "Invalid API key format. Should start with 'sk-'" });
      return;
    }

    setSaving(true);
    try {
      saveConfig({ openaiApiKey: apiKey });
      setSavedKey(apiKey);
      setApiKey("");
      setMessage({ type: "success", text: "API key saved! Transcription will now work automatically." });
      setTimeout(() => setMessage(null), 3000);
    } catch {
      setMessage({ type: "error", text: "Failed to save API key" });
    } finally {
      setSaving(false);
    }
  };

  const handleClear = () => {
    saveConfig({ openaiApiKey: undefined });
    setSavedKey(null);
    setMessage({ type: "success", text: "API key removed" });
    setTimeout(() => setMessage(null), 3000);
  };

  return (
    <section className="rounded-lg border p-4 border-dashed border-yellow-500/50 bg-yellow-500/5">
      <div className="flex items-center gap-2 mb-4">
        <svg className="w-5 h-5 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <h2 className="font-semibold text-lg">Settings</h2>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">
            OpenAI API Key
            <span className="text-muted-foreground font-normal ml-2">(for Whisper transcription)</span>
          </label>
          
          {savedKey ? (
            <div className="flex items-center gap-2">
              <div className="flex-1 px-3 py-2 bg-muted rounded border text-sm font-mono">
                {showKey ? savedKey : maskApiKey(savedKey)}
              </div>
              <button
                onClick={() => setShowKey(!showKey)}
                className="px-3 py-2 text-sm border rounded hover:bg-muted"
              >
                {showKey ? "Hide" : "Show"}
              </button>
              <button
                onClick={handleClear}
                className="px-3 py-2 text-sm border border-red-500/50 text-red-400 rounded hover:bg-red-500/10"
              >
                Remove
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="flex-1 px-3 py-2 bg-background border rounded text-sm font-mono"
              />
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          )}
          
          <p className="text-xs text-muted-foreground mt-2">
            Get your API key from{" "}
            <a 
              href="https://platform.openai.com/api-keys" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline"
            >
              platform.openai.com/api-keys
            </a>
            . Your key is encrypted and stored locally in your browser.
          </p>
        </div>

        {message && (
          <div className={`px-3 py-2 rounded text-sm ${
            message.type === "success" 
              ? "bg-green-500/20 text-green-400 border border-green-500/30" 
              : "bg-red-500/20 text-red-400 border border-red-500/30"
          }`}>
            {message.text}
          </div>
        )}

        <div className="pt-4 border-t">
          <h3 className="text-sm font-medium mb-2">How Transcription Works</h3>
          <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
            <li>Record audio on the Recorder page</li>
            <li>Each 5-second chunk is automatically uploaded</li>
            <li>With an API key, chunks are transcribed using OpenAI Whisper</li>
            <li>View transcripts in real-time as they complete</li>
          </ol>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Check if API key exists on mount
  useEffect(() => {
    if (!hasApiKey()) {
      setShowSettings(true);
    }
  }, []);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        setError(null);

        const [healthRes, statsRes] = await Promise.all([
          fetch(`${API_URL}/health`),
          fetch(`${API_URL}/stats`),
        ]);

        if (healthRes.ok) {
          setHealth(await healthRes.json());
        }

        if (statsRes.ok) {
          const statsData = await statsRes.json();
          if (statsData.success) {
            setStats(statsData.stats);
          }
        }
      } catch (err) {
        setError("Failed to connect to API");
        console.error("API error:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    // Refresh every 10 seconds
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="container mx-auto max-w-4xl px-4 py-2">
      <div className="flex items-start justify-between mb-4">
        <pre className="overflow-x-auto font-mono text-xs sm:text-sm flex-1">{TITLE_TEXT}</pre>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`ml-4 mt-2 p-2 rounded border hover:bg-muted transition-colors ${
            showSettings ? "bg-muted border-primary" : ""
          }`}
          title="Settings"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>
      
      <div className="grid gap-6">
        {/* Settings Panel */}
        {showSettings && <SettingsPanel />}

        {/* API Status */}
        <section className="rounded-lg border p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-lg">System Status</h2>
            {health && (
              <span className={`px-2 py-1 text-xs rounded ${
                health.status === "ok" 
                  ? "bg-green-500/20 text-green-400" 
                  : "bg-yellow-500/20 text-yellow-400"
              }`}>
                {health.status === "ok" ? "● All Systems Operational" : "● Degraded"}
              </span>
            )}
          </div>

          {loading && !health && (
            <div className="text-center py-4 text-muted-foreground">Loading...</div>
          )}

          {error && (
            <div className="text-center py-4 text-red-400">
              ● Disconnected - {error}
            </div>
          )}

          {health && (
            <div className="grid sm:grid-cols-2 gap-x-8 divide-y sm:divide-y-0">
              <div>
                <StatusBadge status={health.services.database} label="Database" />
                <StatusBadge status={health.services.cache} label="Cache (Redis)" />
              </div>
              <div>
                <StatusBadge status={health.services.storage} label="Storage" />
                <StatusBadge status={health.services.transcription} label="Transcription (Whisper)" />
              </div>
            </div>
          )}

          {health && (
            <div className="mt-4 pt-4 border-t text-xs text-muted-foreground">
              Last updated: {new Date(health.timestamp).toLocaleTimeString()}
              {" • "}
              Rate limit: {health.config.rateLimit.requests} req/{health.config.rateLimit.window}s
            </div>
          )}
        </section>

        {/* Statistics */}
        {stats && (
          <>
            <section className="rounded-lg border p-4">
              <h2 className="font-semibold text-lg mb-4">Recording Statistics</h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <StatCard label="Total Recordings" value={stats.recordings.total} />
                <StatCard label="Active" value={stats.recordings.active} />
                <StatCard label="Completed" value={stats.recordings.completed} />
                <StatCard label="Total Chunks" value={stats.chunks.total} />
              </div>
            </section>

            <section className="rounded-lg border p-4">
              <h2 className="font-semibold text-lg mb-4">Transcription Status</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <StatCard 
                  label="Transcribed" 
                  value={stats.chunks.transcribed}
                  subtext={`${stats.chunks.total > 0 ? Math.round((stats.chunks.transcribed / stats.chunks.total) * 100) : 0}% complete`}
                />
                <StatCard label="Pending" value={stats.chunks.pendingTranscription} />
                <StatCard label="Acknowledged" value={stats.chunks.acknowledged} />
              </div>
            </section>

            {stats.recentRecordings.length > 0 && (
              <section className="rounded-lg border p-4">
                <h2 className="font-semibold text-lg mb-4">Recent Recordings</h2>
                <div className="space-y-2">
                  {stats.recentRecordings.map((rec) => (
                    <div 
                      key={rec.id} 
                      className="flex items-center justify-between py-2 px-3 rounded bg-muted/50"
                    >
                      <div className="flex items-center gap-3">
                        <span className={`w-2 h-2 rounded-full ${
                          rec.status === "completed" ? "bg-green-500" : 
                          rec.status === "active" ? "bg-blue-500 animate-pulse" : "bg-gray-500"
                        }`} />
                        <code className="text-xs text-muted-foreground">{rec.id.slice(0, 8)}...</code>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <span className="text-muted-foreground">{rec.totalChunks} chunks</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(rec.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
