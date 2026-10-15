// Bounded tool loop for the planning agent, behind the same gateway modes as every other call:
//   live    the model chooses tool calls (Vercel AI SDK tool loop)
//   mock    a scripted agent (src/agent/scripted.ts) chooses tool calls; tools really run
//   record  as live or mock, and the model DECISIONS (tool calls per step, final text) are stored as a recording
//   replay  the recorded decisions are re-run against the CURRENT tools (so tool results are always fresh); never a live call
// Tool inputs are zod-validated here; tool errors become structured results, never exceptions to the model.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, isStepCount, tool } from "ai";
import { z } from "zod";
import { assertLiveReady } from "./config";
import { toSdkPrompt } from "./prompt";
import { readRecording, requestHash, writeRecording, type Recording } from "./recordings";
import { getAgentScript } from "./scripted";
import { LlmConfigError, LlmRecordingMissingError, type CallMeta, type CallOptions, type GatewayConfig, type Message, type Source } from "./types";

export interface AgentTool {
  description: string;
  parameters: z.ZodType;
  execute: (args: never) => unknown | Promise<unknown>;
}

export type AgentEvent =
  | { kind: "llm_message"; step: number; text: string }
  | { kind: "tool_call"; step: number; toolName: string; input: unknown }
  | { kind: "tool_result"; step: number; toolName: string; output: unknown };

export interface AgentLoopOptions extends CallOptions {
  maxSteps?: number;
  maxToolCallsPerStep?: number;
  timeoutMs?: number;
  /** Approximate token budget (live mode, from reported usage). */
  tokenBudget?: number;
  /** The loop ends when this tool returns { ok: true }. */
  stopWhenToolOk?: string;
  onEvent?: (e: AgentEvent) => void | Promise<void>;
  /**
   * Maps ids that differ between businesses (counterparty ids) to stable aliases (their names). The request hash and the stored
   * decisions use the aliases, so a recording made on one demo clone replays on any other clone. Replay maps the aliases back.
   */
  idAliases?: Record<string, string>;
}

export type StopReason = "finished" | "max_steps" | "timeout" | "token_budget";

export interface AgentLoopResult {
  text: string;
  steps: number;
  toolCalls: number;
  stopped: StopReason;
  meta: CallMeta;
}

export interface ScriptContext {
  messages: Message[];
  /** Run one step with these tool calls (in order). Returns the tool outputs. */
  step(calls: { toolName: string; input: unknown }[]): Promise<unknown[]>;
  readonly finished: boolean;
}
export type AgentScript = (ctx: ScriptContext) => Promise<string>;

interface RecordedStep {
  calls: { toolName: string; input: unknown }[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function mapStrings<T>(value: T, pairs: [string, string][]): T {
  if (pairs.length === 0) return value;
  let text = JSON.stringify(value);
  for (const [from, to] of pairs) text = text.split(from).join(to);
  return JSON.parse(text) as T;
}

export async function runAgentLoop(cfg: GatewayConfig, messages: Message[], tools: Record<string, AgentTool>, options: AgentLoopOptions): Promise<AgentLoopResult> {
  const definitions = Object.fromEntries(Object.entries(tools).map(([n, t]) => [n, { description: t.description, parameters: z.toJSONSchema(t.parameters) }]));
  const toAlias: [string, string][] = Object.entries(options.idAliases ?? {}).map(([id, name]) => [id, `@@cp:${name}`]);
  const fromAlias: [string, string][] = toAlias.map(([id, alias]) => [alias, id]);
  const aliasedMessages = mapStrings(messages, toAlias);
  const hash = requestHash(options.purposeId, aliasedMessages, definitions);
  const replaying = cfg.mode === "replay" || (cfg.mode === "record" && !!cfg.reuse && readRecording(cfg.recordingsDir, hash) !== null);
  const started = performance.now();
  const maxSteps = options.maxSteps ?? 12;
  const maxPerStep = options.maxToolCallsPerStep ?? 6;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const state = { step: 0, toolCalls: 0, finished: false, stopped: "finished" as StopReason };
  const taken: RecordedStep[] = [];
  const source: Source = replaying ? "replay" : cfg.provider === "mock" ? "mock" : "live";
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;

  const emit = async (e: AgentEvent) => void (await options.onEvent?.(e));
  const timedOut = () => performance.now() - started > timeoutMs;

  async function exec(toolName: string, input: unknown): Promise<unknown> {
    await emit({ kind: "tool_call", step: state.step, toolName, input });
    const t = tools[toolName];
    let output: unknown;
    if (state.finished) output = { ok: false, error: "The run has already finished" };
    else if (!t) output = { ok: false, error: `Unknown tool "${toolName}"` };
    else {
      const parsed = t.parameters.safeParse(input ?? {});
      if (!parsed.success) output = { ok: false, error: "Invalid tool input", issues: parsed.error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })) };
      else {
        try {
          output = await t.execute(parsed.data as never);
        } catch {
          output = { ok: false, error: "The tool failed" };
        }
      }
    }
    state.toolCalls++;
    if (options.stopWhenToolOk === toolName && (output as { ok?: boolean } | null)?.ok === true) state.finished = true;
    await emit({ kind: "tool_result", step: state.step, toolName, output });
    return output;
  }

  /** One step: bounded number of calls; the step and time limits are enforced here for scripted and replayed loops. */
  async function runStep(calls: { toolName: string; input: unknown }[]): Promise<unknown[]> {
    if (state.step >= maxSteps) {
      state.stopped = "max_steps";
      state.finished = true;
      return calls.map(() => ({ ok: false, error: "Step limit reached" }));
    }
    if (timedOut()) {
      state.stopped = "timeout";
      state.finished = true;
      return calls.map(() => ({ ok: false, error: "Time limit reached" }));
    }
    state.step++;
    taken.push({ calls: calls.map((c) => ({ toolName: c.toolName, input: c.input })) });
    const outputs: unknown[] = [];
    for (let i = 0; i < calls.length; i++) {
      outputs.push(i >= maxPerStep ? { ok: false, error: `At most ${maxPerStep} tool calls per step` } : await exec(calls[i].toolName, calls[i].input));
    }
    return outputs;
  }

  const finalize = async (text: string, ok: boolean, error: string | null): Promise<AgentLoopResult> => {
    await options.logger?.({
      businessId: options.businessId ?? null, purpose: options.purposeId, mode: cfg.mode === "record" && source === "live" ? "record" : source, model: cfg.model || "mock", requestHash: hash,
      promptTokens, completionTokens, latencyMs: Math.round(performance.now() - started), ok, error,
    });
    return {
      text, steps: state.step, toolCalls: state.toolCalls, stopped: state.stopped,
      meta: { source, mode: cfg.mode, model: cfg.model || "mock", requestHash: hash, attempts: 1, latencyMs: Math.round(performance.now() - started), promptTokens, completionTokens },
    };
  };

  try {
    let text = "";
    if (replaying) {
      const rec = readRecording(cfg.recordingsDir, hash);
      if (!rec) throw new LlmRecordingMissingError(options.purposeId, hash, cfg.recordingsDir);
      const r = mapStrings(rec.response as { steps: RecordedStep[]; text: string }, fromAlias);
      for (const s of r.steps) {
        if (state.finished) break;
        await runStep(s.calls);
      }
      text = r.text;
      if (text) await emit({ kind: "llm_message", step: state.step, text });
    } else if (cfg.provider === "mock") {
      const script = getAgentScript(options.purposeId);
      if (!script) throw new LlmConfigError(`The mock provider has no scripted agent for purpose "${options.purposeId}"`);
      text = await script({ messages, step: runStep, get finished() { return state.finished; } });
      if (text) await emit({ kind: "llm_message", step: state.step, text });
    } else {
      assertLiveReady(cfg);
      const model = createOpenAICompatible({ name: "llm", baseURL: cfg.baseUrl!, apiKey: cfg.apiKey!, supportsStructuredOutputs: cfg.supportsStructuredOutputs })(cfg.model);
      let liveStep = 0;
      let callsThisStep = 0;
      const sdkTools = Object.fromEntries(
        Object.entries(tools).map(([name, t]) => [
          name,
          tool({
            description: t.description,
            inputSchema: t.parameters as never,
            execute: (async (input: unknown) => {
              callsThisStep++;
              if (callsThisStep > maxPerStep) return { ok: false, error: `At most ${maxPerStep} tool calls per step` };
              if (timedOut()) {
                state.stopped = "timeout";
                state.finished = true;
              }
              return exec(name, input);
            }) as never,
          }),
        ]),
      );
      let used = 0;
      const call = generateText as unknown as (a: unknown) => Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number }; totalUsage?: { inputTokens?: number; outputTokens?: number } }>;
      const res = await call({
        model, ...toSdkPrompt(messages), tools: sdkTools, temperature: 0,
        stopWhen: [isStepCount(maxSteps), () => state.finished],
        abortSignal: AbortSignal.timeout(timeoutMs),
        onStepFinish: async (s: { text?: string; usage?: { inputTokens?: number; outputTokens?: number }; toolCalls?: { toolName: string; input: unknown; invalid?: boolean }[] }) => {
          liveStep++;
          state.step = liveStep;
          callsThisStep = 0;
          taken.push({ calls: (s.toolCalls ?? []).map((c) => ({ toolName: c.toolName, input: c.input })) });
          // The SDK rejects calls whose input fails the tool schema before our execute runs. Log them like the replay does,
          // so live, replay and the step log all agree on what the model asked for.
          for (const c of s.toolCalls ?? []) {
            if (!c.invalid) continue;
            state.toolCalls++;
            await emit({ kind: "tool_call", step: liveStep, toolName: c.toolName, input: c.input });
            await emit({ kind: "tool_result", step: liveStep, toolName: c.toolName, output: { ok: false, error: "Invalid tool input" } });
          }
          if (s.text) await emit({ kind: "llm_message", step: liveStep, text: s.text });
          used += (num(s.usage?.inputTokens) ?? 0) + (num(s.usage?.outputTokens) ?? 0);
          if (options.tokenBudget && used >= options.tokenBudget) {
            state.stopped = "token_budget";
            state.finished = true;
          }
        },
      });
      text = res.text;
      const total = res.totalUsage ?? res.usage; // totalUsage sums every step; usage is the last step only
      promptTokens = num(total?.inputTokens);
      completionTokens = num(total?.outputTokens);
      if (liveStep >= maxSteps && !state.finished) state.stopped = "max_steps";
    }

    if (cfg.mode === "record" && !replaying) {
      writeRecording(
        cfg.recordingsDir,
        { version: 1, kind: "agent", purposeId: options.purposeId, requestHash: hash, scripted: cfg.provider === "mock", recordedWith: { model: cfg.model || "mock" }, request: { messages: aliasedMessages, definitions }, response: mapStrings({ steps: taken, text }, toAlias) } satisfies Recording,
        [cfg.apiKey],
      );
    }
    return await finalize(text, true, null);
  } catch (e) {
    await finalize("", false, e instanceof Error ? e.name : "UnknownError").catch(() => undefined);
    throw e;
  }
}
