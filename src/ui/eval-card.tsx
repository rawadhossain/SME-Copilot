// "Evaluation": the recorded result of `bun run eval`, shown in plain words. Presentational only: the data is the committed file
// fixtures/eval-results.json (a recorded run), so the screen never runs a case and never claims more than the file says.
import results from "../../fixtures/eval-results.json";
import { Card, Th } from "./kit";
import { money } from "./format";

interface Row { outcome: string; error: string | null }
interface Base { cushion: number; zero: number }

/** What each outcome class means, in plain words. */
const OUTCOME: Record<string, string> = {
  resolved_verified: "Fixed and checked: the lowest balance stays at or above your cushion",
  verified_gap_remains: "Ran and checked, but a gap to your cushion remains",
  no_feasible_plan: "No plan inside your limits could run",
  exhausted_after_replans: "Counterparties kept pushing back until the re-plan limit",
  execution_failed: "Stopped before it could finish",
  rolled_back: "Rolled back: a step was refused and everything was withdrawn",
  verification_failed: "Ran, but the independent check failed",
  no_shortage: "No shortage to fix",
};
const OUTCOME_ORDER = ["resolved_verified", "verified_gap_remains", "no_feasible_plan", "exhausted_after_replans", "execution_failed", "rolled_back", "verification_failed", "no_shortage"];

/** The system's own reason, in plain words. Unknown reasons are shown as they are. */
function reasonOf(error: string): string {
  if (/offer_fee_within_limit/.test(error)) return "the lender's fee was above your signed fee limit";
  if (/still offered/.test(error)) return "the lender's fee was above what the plan was signed for, and its offer was still open when the re-plan started";
  if (/gate denied/.test(error)) return "the permission gate refused a payment";
  return error.length > 110 ? `${error.slice(0, 107)}...` : error;
}

export function EvalCard() {
  const s = results.summary;
  const rows = results.results as unknown as Row[];
  const short = results.baselines.shortageCases;
  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((n * 100) / d)}%`);
  const outcomes = s.outcomes as Record<string, number>;
  const causes = new Map<string, number>();
  for (const r of rows) if (r.outcome !== "resolved_verified" && r.outcome !== "verified_gap_remains" && r.error) {
    const k = `${r.outcome}|${reasonOf(r.error)}`;
    causes.set(k, (causes.get(k) ?? 0) + 1);
  }
  const causeList = [...causes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const baseRows: [string, Base][] = [
    ["Do nothing", results.baselines.doNothing], ["Borrow the most the lender allows (and nothing else)", results.baselines.financeEverything],
    ["The best single action", results.baselines.bestSingleAction], ["The assistant, as actually agreed with the other side", results.baselines.agentExecuted],
  ];
  return (
    <Card title="Evaluation" subtitle="How the whole system does across many made-up cash crises">
      <p className="text-sm">We generated {s.cases} small-business crises, each with a different balance, order size, late customer and stubborn buyer, supplier or lender, and ran the whole system on every one: spot the shortage, plan, get the plan signed, negotiate with the simulated other side, re-plan if needed, and check the result independently. This measures the system, not a language model.</p>
      <p className="mt-3 rounded-xl border border-line bg-white/60 p-3 text-sm" role="status">
        <b>{s.shortageCases} of {s.cases} had a cash shortage. {s.executedAndVerified} ran and passed the independent check ({pct(s.executedAndVerified, s.shortageCases)}); {s.resolvedVerified} also kept the lowest balance at or above your cushion ({pct(s.resolvedVerified, s.shortageCases)}).</b>{" "}
        Payments or terms beyond your signed limits: <b>{s.limitViolations}</b>. Times the balance floor was breached by the assistant: <b>{s.floorBreaches}</b>. Plans run without your signature: <b>{s.executionsWithoutSignature}</b>.
      </p>
      <dl className="mt-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-3"><dt className="text-ink-soft">Rounds used (average, per plan that ran)</dt><dd>{s.meanRounds ?? "–"}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-ink-soft">Cost of the plans that ran (average)</dt><dd>{money(s.meanStrategyCostMinor, "GBP")}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-ink-soft">Checked plans that needed borrowing</dt><dd>{s.verifiedNeedingBorrowing} of {s.executedAndVerified}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-ink-soft">Refusals or counters outside your terms</dt><dd>{s.counterpartyRefusals}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-ink-soft">Requests the permission gate refused</dt><dd>{s.gateDenials}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-ink-soft">Checked, but the real terms differed from the promise</dt><dd>{s.verifiedPromiseDiffersFromAgreed}</dd></div>
      </dl>
      <h3 className="mt-5 text-sm font-semibold">Against simpler approaches</h3>
      <p className="mt-1 text-xs text-ink-soft">The first three are worked out by the engine alone and assume the other side always agrees, so they are generous to the simpler approaches.</p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <thead><tr><Th>Approach</Th><Th>Keeps your cushion</Th><Th>Stays above zero</Th></tr></thead>
          <tbody>
            {baseRows.map(([label, b]) => (
              <tr key={label} className="border-t border-line"><td className="py-2 pr-3">{label}</td><td className="py-2 pr-3">{b.cushion} of {short} ({pct(b.cushion, short)})</td><td className="py-2">{b.zero} of {short} ({pct(b.zero, short)})</td></tr>))}
          </tbody>
        </table>
      </div>
      <h3 className="mt-5 text-sm font-semibold">What happened in each case</h3>
      <ul className="mt-2 space-y-1 text-sm">
        {OUTCOME_ORDER.filter((o) => (outcomes[o] ?? 0) > 0).map((o) => <li key={o} className="flex justify-between gap-3"><span>{OUTCOME[o]}</span><b>{outcomes[o]}</b></li>)}
      </ul>
      {causeList.length > 0 && (
        <>
          <h3 className="mt-5 text-sm font-semibold">Why the others did not finish</h3>
          <ul className="mt-2 space-y-1 text-sm text-ink-soft">
            {causeList.map(([k, n]) => { const [o, why] = k.split("|"); return <li key={k}><b className="text-ink">{n}</b> × {OUTCOME[o]?.split(":")[0].toLowerCase() ?? o}: {why}</li>; })}
          </ul>
        </>
      )}
      <p className="mt-3 text-xs text-ink-soft">Recorded run of <span className="font-mono">bun run eval</span> (seed {results.seed}, {s.cases} generated companies). Synthetic companies and simulated counterparties. Reproduce it with that command.</p>
    </Card>
  );
}
