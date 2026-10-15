// Run this yourself with a real key:  bun run llm:smoke
// Checks two capabilities of your OpenAI-compatible endpoint through the gateway (live mode, no recording):
//   (a) zod-validated structured output   (b) one tool-call round trip with a trivial tool
// It prints PASS/FAIL with timings and the provider host and model (never the key). Exit code is non-zero on failure.
import { z } from "zod";
import { createGateway, describeConfig, readConfig } from "../src/ai";

const cfg = { ...readConfig(), mode: "live" as const };
const info = describeConfig(cfg);
console.log(`provider=${info.provider} host=${info.baseUrlHost} model=${info.model} structuredOutputs=${info.structuredOutputs} apiKey=${info.apiKey}`);

const missing: string[] = [];
if (cfg.provider !== "openai-compatible") missing.push("LLM_PROVIDER=openai-compatible");
if (!cfg.baseUrl) missing.push("LLM_BASE_URL");
if (!cfg.apiKey) missing.push("LLM_API_KEY");
if (!cfg.model) missing.push("LLM_MODEL");
if (missing.length > 0) {
  console.error(`\nMissing configuration: ${missing.join(", ")}`);
  console.error("Put these in your .env (it is git-ignored). See .env.example. LLM_BASE_URL is the OpenAI-compatible base URL, for example https://<host>/v1");
  console.error("Optional: LLM_STRUCTURED_OUTPUTS=true if your endpoint supports JSON-schema structured outputs.");
  process.exit(2);
}

const gw = createGateway(cfg);
let failed = 0;
const report = (name: string, ok: boolean, ms: number, detail: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${ms} ms)  ${detail}`);
};

async function structured() {
  const t = Date.now();
  try {
    const { object, meta } = await gw.generateStructured(
      z.object({ city: z.string(), populationMillions: z.number() }),
      [
        { role: "system", content: "Reply with JSON only." },
        { role: "user", content: "Give the capital of France and its approximate population in millions." },
      ],
      { purposeId: "smoke.structured" },
    );
    report("structured output", object.city.length > 0 && Number.isFinite(object.populationMillions), Date.now() - t, `city=${object.city} attempts=${meta.attempts} tokens=${meta.promptTokens ?? "?"}/${meta.completionTokens ?? "?"}`);
  } catch (e) {
    report("structured output", false, Date.now() - t, e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : "error");
  }
}

async function tools() {
  const t = Date.now();
  try {
    const res = await gw.generateWithTools(
      [
        { role: "system", content: "You must use the add tool for arithmetic, then state the result." },
        { role: "user", content: "What is 17 plus 25? Use the add tool." },
      ],
      {
        add: {
          description: "Add two numbers",
          parameters: z.object({ a: z.number(), b: z.number() }),
          execute: (({ a, b }: { a: number; b: number }) => ({ sum: a + b })) as never,
        },
      },
      { purposeId: "smoke.tools", maxSteps: 4 },
    );
    const call = res.toolCalls.find((c) => c.toolName === "add");
    const input = (call?.input ?? {}) as { a?: unknown; b?: unknown };
    const ok = !!call && Number(input.a) + Number(input.b) === 42 && res.text.includes("42");
    report("tool-call round trip", ok, Date.now() - t, `calls=${res.toolCalls.length} text="${res.text.slice(0, 80).replace(/\s+/g, " ")}"`);
  } catch (e) {
    report("tool-call round trip", false, Date.now() - t, e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : "error");
  }
}

await structured();
await tools();
console.log(failed === 0 ? "\nAll capabilities PASS." : `\n${failed} capability check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
