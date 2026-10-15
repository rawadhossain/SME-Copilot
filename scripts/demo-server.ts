// Starts the app for the OFFLINE demo: no key, no network.
//   bun run demo                the CANONICAL recordings (fixtures/llm-recordings-live): the real model's recorded answers for the
//                               sample documents, the shortage plan and the re-plan, replayed on any fresh demo clone
//   DEMO_MODE=mock bun run demo the scripted mock provider instead
// Then open http://localhost:3000 and sign in (owner@mercer-vale.example / Ledger-Owner-2026). Stop with Ctrl+C.
// If you change the story (other documents, other choices) a request may have no recording: the planner then says "fallback used".
import { spawn } from "node:child_process";
import { join } from "node:path";

const mock = process.env.DEMO_MODE === "mock";
const env = { ...process.env, SHORTAGE_AUTO_PLAN: "on", LLM_API_KEY: "" } as NodeJS.ProcessEnv;
if (mock) {
  env.LLM_PROVIDER = "mock"; env.LLM_MODE = "live"; delete env.LLM_RECORDINGS_DIR;
} else {
  env.LLM_PROVIDER = "openai-compatible"; env.LLM_MODE = "replay"; env.LLM_RECORDINGS_DIR = "fixtures/llm-recordings-live";
  env.LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini"; env.LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
}
console.log(`Ledgerhand demo (offline, ${mock ? "mock provider" : "canonical recordings"}). http://localhost:3000`);
const child = spawn("node", [join("node_modules", "next", "dist", "bin", "next"), "dev"], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
