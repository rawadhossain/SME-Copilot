// Runs the labelled Copilot sentences against the configured REAL model, in record mode with reuse, into fixtures/llm-recordings-live.
//   bun run copilot:live            (needs LLM_PROVIDER=openai-compatible, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL in the local .env)
// A hard cap of COPILOT_LIVE_MAX_CALLS (default 24) model calls is enforced: the script never goes over it, and says which sentences it skipped.
// Canonical demo sentences are sent FIRST so that, with a small cap, they are always recorded (replay them with LLM_MODE=replay and
// LLM_RECORDINGS_DIR=fixtures/llm-recordings-live). They are, in order:
//   1. "What if Northgate pays 3 weeks late?"                                   (a single customer late)
//   2. "Northgate pays 21 days late and Kestrel won't give me longer payment terms"  (the combined crisis)
//   3. "Is it worth taking on some debt to get through the next quarter?"        (a funding question phrased unusually)
//   4. "what if it's 30 days instead?"  after "Northgate pays 21 days late"      (a follow-up modification)
//   5. "Do I need to borrow?"                                                      (a funding question)
// It asks through the real askCopilot on a throwaway clone of the demo business (so the prompts are exactly the ones the app sends) and prints, per
// sentence, what was expected and what the model's typed request became, then an accuracy summary. Nothing here can act: Copilot is read-only.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createGateway, readConfig, type Gateway } from "../src/ai";
import { toRawOutput, type CopilotEvent } from "../src/agent/copilot";
import { CASES, type Case } from "./copilot-cases";

const MAX = Number(process.env.COPILOT_LIVE_MAX_CALLS ?? 24);
const CANON = ["S01", "S14", "G04", "F01", "G01"];

async function main() {
  const cfg = readConfig();
  if (cfg.provider === "mock") { console.error("copilot:live needs a real model: set LLM_PROVIDER=openai-compatible, LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in your local .env."); process.exit(1); }
  const real = createGateway({ ...cfg, mode: "record", reuse: true, recordingsDir: "fixtures/llm-recordings-live" });
  let calls = 0;
  const counted = { ...real, generateStructured: async (...a: Parameters<Gateway["generateStructured"]>) => { if (calls >= MAX) throw new Error(`COPILOT_LIVE_MAX_CALLS (${MAX}) reached`); calls++; return real.generateStructured(...a); } } as Gateway;

  const { db, sql } = await import("../src/db");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const { createDemoClone } = await import("../src/actions/demo-clone");
  const { askCopilot } = await import("../src/actions/copilot");
  try {
    const demo = (await getDefaultBusinessId())!;
    const { id } = await createDemoClone(db as any, demo);
    process.env.CASH_ASK_PER_HOUR = "1000";
    process.env.COPILOT_MODEL_PER_HOUR = "1000";
    const reachesModel = (c: Case) => c.parser !== "skip";
    const order = [...CANON.map((i) => CASES.find((c) => c.id === i)!), ...CASES.filter((c) => reachesModel(c) && !CANON.includes(c.id))];
    let typeRight = 0, eventsRight = 0, eventsTotal = 0, asked = 0;
    const skipped: string[] = [];
    for (const c of order) {
      if (calls >= MAX) { skipped.push(c.id); continue; }
      asked++;
      const previous = c.previous ? { events: toRawOutput({ type: "simulate_scenario", events: c.previous }).events! } : undefined;
      let r: any;
      try { r = await askCopilot(db as any, id, { message: c.sentence, previous }, { gateway: counted, viewerRole: "owner" }); } catch (e: any) { r = { kind: "error", answerText: String(e?.message ?? e), source: "none" }; }
      const sameType = r.kind === c.outcome;
      if (sameType) typeRight++;
      let evNote = "";
      if (c.outcome === "scenario" && c.request && "events" in c.request) {
        eventsTotal++;
        const want = JSON.stringify(c.request.events.map(norm));
        const got = JSON.stringify(((r.scenario?.events ?? []) as CopilotEvent[]).map(norm));
        if (want === got) eventsRight++;
        evNote = want === got ? " events ok" : ` events differ: expected ${want} got ${got}`;
      }
      console.log(`  ${sameType ? "OK  " : "DIFF"} ${c.id} [${r.source}] expected ${c.outcome}, got ${r.kind}${evNote} | ${c.sentence}`);
    }
    console.log(`\ncopilot live: ${asked} sentences asked with ${calls} model calls (cap ${MAX})${skipped.length ? `; skipped for the cap: ${skipped.join(", ")}` : ""}`);
    console.log(`request type exact match: ${typeRight}/${asked}; events exact match (scenarios): ${eventsRight}/${eventsTotal}`);
    console.log("Recordings are in fixtures/llm-recordings-live. Replay them with LLM_MODE=replay and LLM_RECORDINGS_DIR=fixtures/llm-recordings-live.");
  } finally {
    await sql.end();
  }
}

/** Events compared by what they say: names reduced to their first word, in lower case. */
function norm(e: CopilotEvent): unknown {
  const first = (s: string) => s.toLowerCase().replace(/\(synthetic\)/g, "").trim().split(/\s+/)[0];
  return e.type === "customer_late" ? { t: e.type, c: first(e.customer), d: e.days } : e.type === "customer_pays_less" ? { t: e.type, c: first(e.customer), p: e.percent }
    : e.type === "supplier_refuses" ? { t: e.type, s: first(e.supplier), df: e.deferral, lo: e.lowerDeposit } : { t: e.type, a: e.amount.replace(/,/g, ""), w: e.weeksAhead, dt: e.date };
}

main().catch((e) => { console.error(e); process.exit(1); });
