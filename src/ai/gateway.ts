// The LLM gateway. Provider-agnostic (any OpenAI-compatible endpoint, or the scripted mock), with record/replay.
//   live    call the provider (or serve the scripted mock)
//   record  as live, and store each exchange under fixtures/llm-recordings/
//   replay  serve ONLY from recordings; a missing recording is a loud error, never a silent live call
// All LLM calls in the product go through this module. Extraction calls never get tools (generateStructured has none).
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, isStepCount, NoObjectGeneratedError, Output, tool } from "ai";
import { z } from "zod";
import { runAgentLoop, type AgentLoopOptions, type AgentTool } from "./agent-loop";
import { assertLiveReady, readConfig } from "./config";
import { toSdkPrompt } from "./prompt";
import { readRecording, requestHash, writeRecording, type Recording } from "./recordings";
import { getStructuredScript, getToolsScript } from "./scripted";
import {
  LlmConfigError, LlmRecordingMissingError, LlmSchemaError,
  type CallLogRow, type CallMeta, type GatewayConfig, type Message, type Source, type StructuredOptions, type StructuredResult,
  type ToolCallRecord, type ToolDefinition, type ToolsOptions, type ToolsResult,
} from "./types";

function liveModel(c: GatewayConfig) {
  assertLiveReady(c);
  const provider = createOpenAICompatible({ name: "llm", baseURL: c.baseUrl!, apiKey: c.apiKey!, supportsStructuredOutputs: c.supportsStructuredOutputs });
  return provider(c.model);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);


/** Content-free description of an error, safe for telemetry (never document text). */
function safeError(e: unknown): string {
  if (e instanceof LlmRecordingMissingError) return "LlmRecordingMissingError";
  if (e instanceof LlmSchemaError) return `LlmSchemaError: ${e.issues.length} issue(s)`;
  if (e instanceof LlmConfigError) return `LlmConfigError: ${e.message}`.slice(0, 200);
  return e instanceof Error ? e.name : "UnknownError";
}

export function createGateway(config: GatewayConfig = readConfig()) {
  const cfg = config;

  async function finish<T>(opts: { purposeId: string; businessId?: string | null; logger?: StructuredOptions["logger"] }, hash: string, started: number, run: () => Promise<{ value: T; source: Source; attempts: number; promptTokens: number | null; completionTokens: number | null }>): Promise<{ value: T; meta: CallMeta }> {
    const logRow = (ok: boolean, source: Source | "record", error: string | null, usage?: { p: number | null; c: number | null }): CallLogRow => ({
      businessId: opts.businessId ?? null, purpose: opts.purposeId, mode: cfg.mode === "record" && source === "live" ? "record" : source, model: cfg.model || "mock",
      requestHash: hash, promptTokens: usage?.p ?? null, completionTokens: usage?.c ?? null, latencyMs: Math.round(performance.now() - started), ok, error,
    });
    try {
      const r = await run();
      await opts.logger?.(logRow(true, r.source, null, { p: r.promptTokens, c: r.completionTokens }));
      return {
        value: r.value,
        meta: { source: r.source, mode: cfg.mode, model: cfg.model || "mock", requestHash: hash, attempts: r.attempts, latencyMs: Math.round(performance.now() - started), promptTokens: r.promptTokens, completionTokens: r.completionTokens },
      };
    } catch (e) {
      await opts.logger?.(logRow(false, cfg.mode === "replay" ? "replay" : cfg.provider === "mock" ? "mock" : "live", safeError(e)));
      throw e;
    }
  }

  /** Zod-validated structured output with a bounded retry on schema failure. No tools are ever passed. */
  async function generateStructured<T>(schema: z.ZodType<T>, messages: Message[], options: StructuredOptions): Promise<StructuredResult<T>> {
    const definitions = { schema: z.toJSONSchema(schema) };
    const hash = requestHash(options.purposeId, messages, definitions);
    const started = performance.now();
    const maxAttempts = Math.max(1, options.maxAttempts ?? 2);

    const { value, meta } = await finish<T>(options, hash, started, async () => {
      const validate = (raw: unknown): T => {
        const parsed = schema.safeParse(raw);
        if (!parsed.success) throw new LlmSchemaError(options.purposeId, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
        return parsed.data;
      };

      if (cfg.mode === "replay" || (cfg.mode === "record" && cfg.reuse && readRecording(cfg.recordingsDir, hash))) {
        const rec = readRecording(cfg.recordingsDir, hash);
        if (!rec) throw new LlmRecordingMissingError(options.purposeId, hash, cfg.recordingsDir);
        return { value: validate(rec.response), source: "replay" as const, attempts: 1, promptTokens: null, completionTokens: null };
      }

      if (cfg.provider === "mock") {
        const script = getStructuredScript(options.purposeId);
        if (!script) throw new LlmConfigError(`The mock provider has no scripted response for purpose "${options.purposeId}"`);
        const raw = script({ messages });
        const value = validate(raw);
        if (cfg.mode === "record") writeRecording(cfg.recordingsDir, { version: 1, kind: "structured", purposeId: options.purposeId, requestHash: hash, scripted: true, recordedWith: { model: "mock" }, request: { messages, definitions }, response: raw } satisfies Recording);
        return { value, source: "mock" as const, attempts: 1, promptTokens: null, completionTokens: null };
      }

      // Live (or record against a live provider).
      const model = liveModel(cfg);
      let convo: Message[] = messages;
      let lastIssues: string[] = [];
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const res = await generateText({ model, ...toSdkPrompt(convo), output: Output.object({ schema }), temperature: options.temperature ?? 0 });
          const value = validate(res.output);
          if (cfg.mode === "record") writeRecording(cfg.recordingsDir, { version: 1, kind: "structured", purposeId: options.purposeId, requestHash: hash, scripted: false, recordedWith: { model: cfg.model }, request: { messages, definitions }, response: res.output } satisfies Recording, [cfg.apiKey]);
          return { value, source: "live" as const, attempts: attempt, promptTokens: num(res.usage?.inputTokens), completionTokens: num(res.usage?.outputTokens) };
        } catch (e) {
          if (!(NoObjectGeneratedError.isInstance(e) || e instanceof LlmSchemaError)) throw e;
          lastIssues = e instanceof LlmSchemaError ? e.issues : ["output was not valid JSON for the schema"];
          convo = [...messages, { role: "user", content: `Your previous output failed validation (${lastIssues.slice(0, 5).join("; ")}). Reply again with ONLY JSON that matches the schema.` }];
        }
      }
      throw new LlmSchemaError(options.purposeId, lastIssues);
    });
    return { object: value, meta };
  }

  /**
   * Minimal tool-calling round trip, for later (the agent loop is not built yet). Live mode executes the tools'
   * `execute` functions; replay and mock return the recorded or scripted transcript WITHOUT executing tools.
   */
  async function generateWithTools(messages: Message[], tools: Record<string, ToolDefinition>, options: ToolsOptions): Promise<ToolsResult> {
    const definitions = Object.fromEntries(Object.entries(tools).map(([name, t]) => [name, { description: t.description, parameters: z.toJSONSchema(t.parameters) }]));
    const hash = requestHash(options.purposeId, messages, definitions);
    const started = performance.now();

    const { value, meta } = await finish<{ text: string; toolCalls: ToolCallRecord[] }>(options, hash, started, async () => {
      if (cfg.mode === "replay" || (cfg.mode === "record" && cfg.reuse && readRecording(cfg.recordingsDir, hash))) {
        const rec = readRecording(cfg.recordingsDir, hash);
        if (!rec) throw new LlmRecordingMissingError(options.purposeId, hash, cfg.recordingsDir);
        return { value: rec.response as { text: string; toolCalls: ToolCallRecord[] }, source: "replay" as const, attempts: 1, promptTokens: null, completionTokens: null };
      }
      if (cfg.provider === "mock") {
        const script = getToolsScript(options.purposeId);
        if (!script) throw new LlmConfigError(`The mock provider has no scripted tool response for purpose "${options.purposeId}"`);
        const out = script({ messages });
        if (cfg.mode === "record") writeRecording(cfg.recordingsDir, { version: 1, kind: "tools", purposeId: options.purposeId, requestHash: hash, scripted: true, recordedWith: { model: "mock" }, request: { messages, definitions }, response: out } satisfies Recording);
        return { value: out, source: "mock" as const, attempts: 1, promptTokens: null, completionTokens: null };
      }
      const model = liveModel(cfg);
      const sdkTools = Object.fromEntries(Object.entries(tools).map(([name, t]) => [name, tool({ description: t.description, inputSchema: t.parameters as never, execute: t.execute as never })]));
      // Typed loosely on purpose: the tool loop is minimal here and gets its own typing when the agent is built.
      const call = generateText as unknown as (a: unknown) => Promise<{ text: string; steps?: unknown[]; usage?: { inputTokens?: number; outputTokens?: number } }>;
      const res = await call({ model, ...toSdkPrompt(messages), tools: sdkTools, stopWhen: isStepCount(options.maxSteps ?? 4), temperature: options.temperature ?? 0 });
      const calls: ToolCallRecord[] = [];
      for (const step of (res.steps ?? []) as unknown as { toolCalls?: { toolCallId: string; toolName: string; input: unknown }[]; toolResults?: { toolCallId: string; output: unknown }[] }[]) {
        for (const c of step.toolCalls ?? []) calls.push({ toolName: c.toolName, input: c.input, output: step.toolResults?.find((r) => r.toolCallId === c.toolCallId)?.output });
      }
      const out = { text: res.text, toolCalls: calls };
      if (cfg.mode === "record") writeRecording(cfg.recordingsDir, { version: 1, kind: "tools", purposeId: options.purposeId, requestHash: hash, scripted: false, recordedWith: { model: cfg.model }, request: { messages, definitions }, response: out } satisfies Recording, [cfg.apiKey]);
      return { value: out, source: "live" as const, attempts: 1, promptTokens: num(res.usage?.inputTokens), completionTokens: num(res.usage?.outputTokens) };
    });
    return { text: value.text, toolCalls: value.toolCalls, meta };
  }

  /** Bounded tool loop for the planning agent (ADR-015). Tools run here; the model only chooses calls. */
  const generateAgentLoop = (messages: Message[], tools: Record<string, AgentTool>, options: AgentLoopOptions) => runAgentLoop(cfg, messages, tools, options);

  return { config: cfg, generateStructured, generateWithTools, generateAgentLoop };
}

export type Gateway = ReturnType<typeof createGateway>;

let defaultGateway: Gateway | null = null;
/** The gateway configured from the environment (created on first use). */
export function getGateway(): Gateway {
  return (defaultGateway ??= createGateway());
}
