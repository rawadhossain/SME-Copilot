// Scripted responses for the mock provider: a simple map from purpose id to a deterministic function. Used for tests and
// for the offline demo. These are NOT model outputs. Recordings made from them are marked scripted: true.
import type { AgentScript } from "./agent-loop";
import type { Message, ToolCallRecord } from "./types";

export type StructuredScript = (ctx: { messages: Message[] }) => unknown;
export type ToolsScript = (ctx: { messages: Message[] }) => { text: string; toolCalls: ToolCallRecord[] };

const structured = new Map<string, StructuredScript>();
const tools = new Map<string, ToolsScript>();
const agents = new Map<string, AgentScript>();

export const registerStructuredScript = (purposeId: string, fn: StructuredScript) => void structured.set(purposeId, fn);
export const registerToolsScript = (purposeId: string, fn: ToolsScript) => void tools.set(purposeId, fn);
export const getStructuredScript = (purposeId: string) => structured.get(purposeId);
export const getToolsScript = (purposeId: string) => tools.get(purposeId);
export const userText = (messages: Message[]): string => messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n");

/** A scripted agent: an async function that runs tool steps through the harness and returns its final text. */
export const registerAgentScript = (purposeId: string, fn: AgentScript) => void agents.set(purposeId, fn);
export const getAgentScript = (purposeId: string) => agents.get(purposeId);
