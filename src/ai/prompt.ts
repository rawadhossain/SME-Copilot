import type { Message } from "./types";

/** AI SDK v7 requires system content in `instructions`, not in `messages`. */
export function toSdkPrompt(messages: Message[]) {
  const instructions = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n") || undefined;
  const prompt = messages.filter((message) => message.role !== "system");
  return { instructions, messages: prompt };
}
