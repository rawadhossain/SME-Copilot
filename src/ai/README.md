# ai

The LLM gateway (ADR-012). All LLM calls in the product go through this module.

- `gateway.ts`: `generateStructured` (zod-validated, bounded retry, never any tools) and `generateWithTools` (minimal, for the later agent).
- `config.ts`: environment-only configuration. `LLM_PROVIDER` (openai-compatible | mock), `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_MODE` (live | record | replay), `LLM_STRUCTURED_OUTPUTS`. No provider or model name is hard-coded.
- `recordings.ts`: record and replay under `fixtures/llm-recordings/`, keyed by SHA-256 of {purpose id, messages, schema or tool definitions}. Replay never calls a live model; a missing recording is a loud error. Recordings never contain keys or headers.
- `scripted.ts`: the mock provider's scripted responses (purpose id -> deterministic function).
- `db-logger.ts`: one `llm_calls` row per call (telemetry, not the action log; no document text, no secrets).

Provider is UNKNOWN: any OpenAI-compatible endpoint works. To test one with your own key, put the variables in your git-ignored `.env` and run `bun run llm:smoke`.
