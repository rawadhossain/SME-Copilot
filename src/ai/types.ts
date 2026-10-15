// Provider-agnostic types for the LLM gateway. No provider or model names live in code; they come from the environment.
import type { z } from "zod";

export type Role = "system" | "user" | "assistant";
export interface Message {
  role: Role;
  content: string;
}

export type LlmMode = "live" | "record" | "replay";
export type LlmProvider = "openai-compatible" | "mock";
/** What actually served a call. */
export type Source = "live" | "replay" | "mock";

export interface GatewayConfig {
  provider: LlmProvider;
  mode: LlmMode;
  baseUrl: string | null;
  apiKey: string | null; // memory only; never logged, never recorded
  model: string; // "mock" for the mock provider
  supportsStructuredOutputs: boolean;
  recordingsDir: string;
  /** LLM_REUSE=1 with LLM_MODE=record: serve a request from an existing recording instead of calling the model; only missing ones are live. */
  reuse?: boolean;
}

export interface CallLogRow {
  businessId: string | null;
  purpose: string;
  mode: Source | "record";
  model: string;
  requestHash: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  ok: boolean;
  /** Short, content-free description (error class and a safe code). Never document text. */
  error: string | null;
}
export type CallLogger = (row: CallLogRow) => Promise<void> | void;

export interface CallOptions {
  /** Stable id of what the call is for, e.g. "extract.purchase_order.v1". Part of the recording key. */
  purposeId: string;
  businessId?: string | null;
  logger?: CallLogger;
}

export interface StructuredOptions extends CallOptions {
  /** Attempts on schema failure (default 2: one retry). */
  maxAttempts?: number;
  temperature?: number;
}

export interface StructuredResult<T> {
  object: T;
  meta: CallMeta;
}

export interface CallMeta {
  source: Source;
  mode: LlmMode;
  model: string;
  requestHash: string;
  attempts: number;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface ToolDefinition {
  description: string;
  parameters: z.ZodType;
  /** Run by the gateway in live mode only. Replay and mock return the recorded transcript without executing tools. */
  execute?: (args: never) => Promise<unknown> | unknown;
}

export interface ToolCallRecord {
  toolName: string;
  input: unknown;
  output?: unknown;
}

export interface ToolsOptions extends CallOptions {
  maxSteps?: number;
  temperature?: number;
}

export interface ToolsResult {
  text: string;
  toolCalls: ToolCallRecord[];
  meta: CallMeta;
}

export class LlmRecordingMissingError extends Error {
  constructor(public purposeId: string, public requestHash: string, public dir: string) {
    super(
      `No LLM recording for purpose "${purposeId}" (request ${requestHash.slice(0, 16)}...) in ${dir}. ` +
        `Replay mode never calls a live model. Record one (LLM_MODE=record with a real provider, or bun run llm:record-scripted for the scripted fixtures), or set LLM_MODE=live with LLM_PROVIDER=mock.`,
    );
    this.name = "LlmRecordingMissingError";
  }
}

export class LlmSchemaError extends Error {
  constructor(public purposeId: string, public issues: string[]) {
    super(`LLM output for "${purposeId}" did not match the schema: ${issues.slice(0, 5).join("; ")}`);
    this.name = "LlmSchemaError";
  }
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}
