// Record and replay of LLM exchanges as JSON files. Keyed by a SHA-256 of {purpose id, canonical messages, schema or
// tool definitions}. The key does not include the model, so a recording made with one model can be replayed anywhere.
// Recordings never contain API keys or headers.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "@/gate/canonical";
import type { Message } from "./types";

export type RecordingKind = "structured" | "tools" | "agent";

export interface Recording {
  version: 1;
  kind: RecordingKind;
  purposeId: string;
  requestHash: string;
  /** True for hand-written scripted responses (not produced by a real model). */
  scripted: boolean;
  /** Informational only. */
  recordedWith: { model: string };
  request: { messages: Message[]; definitions: unknown };
  response: unknown;
}

export function requestHash(purposeId: string, messages: Message[], definitions: unknown): string {
  return createHash("sha256").update(canonicalize({ purposeId, messages, definitions }), "utf8").digest("hex");
}

const fileFor = (dir: string, hash: string) => join(dir, `${hash}.json`);

export function readRecording(dir: string, hash: string): Recording | null {
  const f = fileFor(dir, hash);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Recording) : null;
}

const SECRET_PATTERNS = [/sk-[A-Za-z0-9_-]{16,}/, /Bearer\s+[A-Za-z0-9._-]{12,}/i, /api[_-]?key["']?\s*[:=]\s*["'][^"']{8,}/i, /"authorization"s*:/i];

/** Throws if a recording looks like it contains a secret. */
export function assertNoSecrets(rec: unknown, extraSecrets: (string | null | undefined)[] = []): void {
  const text = JSON.stringify(rec);
  for (const p of SECRET_PATTERNS) if (p.test(text)) throw new Error(`Recording looks like it contains a secret (pattern ${p})`);
  for (const s of extraSecrets) if (s && s.length >= 8 && text.includes(s)) throw new Error("Recording contains a configured secret value");
}

export function writeRecording(dir: string, rec: Recording, secrets: (string | null | undefined)[] = []): string {
  assertNoSecrets(rec, secrets);
  mkdirSync(dir, { recursive: true });
  const f = fileFor(dir, rec.requestHash);
  writeFileSync(f, JSON.stringify(rec, null, 2) + "\n");
  return f;
}
