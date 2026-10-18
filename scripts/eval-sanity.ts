// EVALUATION on generated crises. Run: bun run eval            (default cases and seed)
//                                      bun run eval -- --cases 8   (quick mode)   --seed S   --no-write
// Runs the whole pipeline on N generated crisis companies (throwaway is_test clones of the demo business) and reports honest rates.
// Measures the system (search, gate, executor, verifier), not a language model. Exits non-zero ONLY if an invariant breaks:
// a limit violation, a floor breach, an execution without a signed authorisation, a "passed" verification that an independent recomputation
// contradicts, or a broken log chain. Resolved rates are reported, never pass/fail. Writes fixtures/eval-results.json and docs/eval-results.md.
import { mkdirSync, writeFileSync } from "node:fs";
import { DEFAULT_CASES, DEFAULT_SEED } from "./eval/generate";
import { shutdown } from "./eval/run-case";
import { runEval } from "./eval/report";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? Number(process.argv[i + 1]) : undefined; };

async function main() {
  const cases = arg("cases") ?? DEFAULT_CASES;
  const seed = arg("seed") ?? DEFAULT_SEED;
  if (!Number.isInteger(cases) || cases < 1) throw new Error("--cases must be a positive integer");
  const t0 = Date.now();
  const run = await runEval({ cases, seed, log: (s) => console.log(s) });
  if (!process.argv.includes("--no-write")) {
    mkdirSync("fixtures", { recursive: true });
    writeFileSync("fixtures/eval-results.json", run.json);
    writeFileSync("docs/eval-results.md", run.md);
  }
  const counts: Record<string, number> = {};
  for (const r of run.results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  console.log(`\neval: ${cases} cases, seed ${seed}, outcomes ${JSON.stringify(counts)}`);
  console.log(`runtime ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min; footprint: ${run.footprint.clones} is_test clones, ${run.footprint.logRecords} action-log records`);
  for (const i of run.invariants) console.log(`  invariant ${i.ok ? "ok  " : "FAIL"} ${i.name}: ${i.value}`);
  await shutdown();
  if (run.invariants.some((i) => !i.ok)) { console.error("AN INVARIANT BROKE"); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
