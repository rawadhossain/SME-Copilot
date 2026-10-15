// Gateway configuration from environment variables only. No provider names or model ids are hard-coded.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LlmConfigError, type GatewayConfig, type LlmMode, type LlmProvider } from "./types";

export const RECORDINGS_DIR = join("fixtures", "llm-recordings");

export function hasRecordings(dir = RECORDINGS_DIR): boolean {
  try {
    return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

/**
 * LLM_PROVIDER: openai-compatible | mock (default mock).
 * LLM_MODE: live | record | replay. Default: replay if recordings exist, else live (which, for the mock provider,
 * serves scripted responses).
 */
export function readConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const provider = (env.LLM_PROVIDER?.trim() || "mock") as LlmProvider;
  if (provider !== "openai-compatible" && provider !== "mock") throw new LlmConfigError(`LLM_PROVIDER must be "openai-compatible" or "mock", got "${provider}"`);
  const rawMode = env.LLM_MODE?.trim();
  if (rawMode && !["live", "record", "replay"].includes(rawMode)) throw new LlmConfigError(`LLM_MODE must be live, record or replay, got "${rawMode}"`);
  const mode: LlmMode = (rawMode as LlmMode | undefined) ?? (hasRecordings() ? "replay" : "live");
  return {
    provider,
    mode,
    baseUrl: env.LLM_BASE_URL?.trim() || null,
    apiKey: env.LLM_API_KEY?.trim() || null,
    model: provider === "mock" ? "mock" : env.LLM_MODEL?.trim() || "",
    supportsStructuredOutputs: env.LLM_STRUCTURED_OUTPUTS?.trim() === "true",
    reuse: env.LLM_REUSE?.trim() === "1",
    recordingsDir: env.LLM_RECORDINGS_DIR?.trim() || RECORDINGS_DIR, // live recordings go in their own folder so they never overwrite the scripted ones
  };
}

/** Throws a helpful error when a live call cannot be made. */
export function assertLiveReady(c: GatewayConfig): void {
  const missing: string[] = [];
  if (c.provider !== "openai-compatible") missing.push('LLM_PROVIDER=openai-compatible');
  if (!c.baseUrl) missing.push("LLM_BASE_URL");
  if (!c.apiKey) missing.push("LLM_API_KEY");
  if (!c.model) missing.push("LLM_MODEL");
  if (missing.length > 0) throw new LlmConfigError(`Live LLM calls need: ${missing.join(", ")}. See .env.example.`);
}

/** Config safe to print: no key, only the host of the base URL. */
export function describeConfig(c: GatewayConfig): Record<string, string> {
  let host = "-";
  try {
    host = c.baseUrl ? new URL(c.baseUrl).host : "-";
  } catch {
    host = "(invalid URL)";
  }
  return { provider: c.provider, mode: c.mode, model: c.model || "(unset)", baseUrlHost: host, apiKey: c.apiKey ? "(set)" : "(not set)", structuredOutputs: String(c.supportsStructuredOutputs) };
}
