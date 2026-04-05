/**
 * Client-side configuration storage with basic encryption
 * Uses AES-like obfuscation for API keys stored in localStorage
 */

const CONFIG_KEY = "swadesh_config";
const ENCRYPTION_KEY = "swadesh-ai-2024"; // Simple key for obfuscation

/**
 * Simple XOR-based encryption for localStorage
 * Not cryptographically secure but prevents casual viewing
 */
function xorEncrypt(text: string, key: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(
      text.charCodeAt(i) ^ key.charCodeAt(i % key.length)
    );
  }
  return btoa(result); // Base64 encode
}

function xorDecrypt(encoded: string, key: string): string {
  try {
    const text = atob(encoded); // Base64 decode
    let result = "";
    for (let i = 0; i < text.length; i++) {
      result += String.fromCharCode(
        text.charCodeAt(i) ^ key.charCodeAt(i % key.length)
      );
    }
    return result;
  } catch {
    return "";
  }
}

export interface AppConfig {
  openaiApiKey?: string;
  autoTranscribe?: boolean;
  theme?: "light" | "dark" | "system";
}

/**
 * Save configuration to localStorage
 */
export function saveConfig(config: AppConfig): void {
  if (typeof window === "undefined") return;

  const stored: Record<string, string> = {};

  if (config.openaiApiKey) {
    stored.openaiApiKey = xorEncrypt(config.openaiApiKey, ENCRYPTION_KEY);
  }
  if (config.autoTranscribe !== undefined) {
    stored.autoTranscribe = String(config.autoTranscribe);
  }
  if (config.theme) {
    stored.theme = config.theme;
  }

  localStorage.setItem(CONFIG_KEY, JSON.stringify(stored));
}

/**
 * Load configuration from localStorage
 */
export function loadConfig(): AppConfig {
  if (typeof window === "undefined") return {};

  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (!stored) return {};

    const parsed = JSON.parse(stored);
    const config: AppConfig = {};

    if (parsed.openaiApiKey) {
      config.openaiApiKey = xorDecrypt(parsed.openaiApiKey, ENCRYPTION_KEY);
    }
    if (parsed.autoTranscribe !== undefined) {
      config.autoTranscribe = parsed.autoTranscribe === "true";
    }
    if (parsed.theme) {
      config.theme = parsed.theme as AppConfig["theme"];
    }

    return config;
  } catch {
    return {};
  }
}

/**
 * Clear all configuration
 */
export function clearConfig(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(CONFIG_KEY);
}

/**
 * Check if API key is configured
 */
export function hasApiKey(): boolean {
  const config = loadConfig();
  return !!config.openaiApiKey && config.openaiApiKey.startsWith("sk-");
}

/**
 * Get API key (for sending to server)
 */
export function getApiKey(): string | null {
  const config = loadConfig();
  return config.openaiApiKey || null;
}

/**
 * Mask API key for display (show only last 4 chars)
 */
export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return "••••••••";
  return `sk-...${key.slice(-4)}`;
}
