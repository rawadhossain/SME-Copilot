// "Attack lab": the recorded result of `bun run check:attacks`, shown in plain words. Presentational only: the data is the committed file
// fixtures/attack-results.json (a recorded run), so the screen never runs an attack and never claims more than the file says.
import results from "../../fixtures/attack-results.json";
import { Card, Chip, Th } from "./kit";
import { money } from "./format";

interface Row {
  id: string; category: string; title: string; passed: boolean;
  observed: { kind: string; code: string; events: string[] };
  baseline: { outcome: string; movedMinor: string; note: string } | null;
}

/** The system's reason code in plain words. Unknown codes are shown as they are. */
const WHY: Record<string, string> = {
  maxPaymentMinor: "over the per-payment limit", maxDailyOutflowMinor: "over the daily limit", minBankBalanceMinor: "would go under the balance floor", projectedBalanceFloor: "would go under the balance floor",
  approvedPayee: "payee not on your approved list", forbiddenPurposes: "a purpose you forbade", maxEarlyPaymentDiscountBps: "discount above your cap", maxFinanceAdvanceBps: "advance above your cap", maxFinanceFeeBps: "fee above your cap",
  conflict: "already used", mandate_expired: "your signed limits have expired", mandate_signature_invalid: "the signed limits do not verify",
  refused: "refused", suspicious_text: "hidden instructions flagged, nothing acted on", untrusted_flag: "reply kept as untrusted text; no effect", template_only: "shown only as a name inside fixed wording",
  needs_replan: "counter outside what you signed was not accepted", "403": "not allowed for this sign-in", bankDetailsUnchanged: "bank details differ from the approved ones", forbidden: "wrong password refused", "no-restricted-imports": "blocked by the code rules before it can run",
  "log hash chain": "tampering detected by the offline checker", "log head": "tampering detected by the offline checker", "authorisation terms hash": "tampering detected by the offline checker", "authorisation signature": "tampering detected by the offline checker",
  action_request: "declined: the Copilot cannot act", data_only: "kept as a name inside fixed wording", schema_violation: "model output outside the closed schema refused",
  submit_plans_rejected: "invented figures rejected", guard: "bad plan demoted, safe plan first", lever_not_runnable: "unrunnable plan rejected", no_secrets_found: "no keys or passwords found", no_injected_text_found: "no injected text found", quoted_as_data_only: "appears only as quoted data in one test recording",
};
/** Where one code covers several different attacks, the plain reason is given per attack. */
const WHY_BY_ID: Record<string, string> = {
  G11: "the same request key cannot be reused with a different amount",
  P01: "something signed was changed after signing", P02: "something signed was changed after signing", P03: "something signed was changed after signing", P04: "something signed was changed after signing",
  P06: "your signed limits changed after the plan was signed", P07: "an approval can be used only once",
  V01: "an approver cannot sign as the owner", V02: "the second confirmation must come from a different person", V04: "missing security token", V05: "another business's data is off limits",
};
const why = (code: string, id = "") => WHY_BY_ID[id] ?? code.split("+").map((c) => WHY[c] ?? c).filter((v, i, a) => a.indexOf(v) === i).join("; ");

export function AttackLab() {
  const rows = results.results as unknown as Row[];
  const s = results.summary;
  return (
    <Card title="Attack lab" subtitle="What it looks like when the assistant, a document or the other side is hostile">
      <p className="text-sm">An attack here is a request that tries to move money, sign something or take over the assistant outside the limits you signed. We assume the planning assistant, a document or a counterparty has been compromised, and we make no claim about how any particular AI model behaves. Each attack is run against a throwaway copy of the sample company and checked four ways: the right refusal, no money moved, the attempt in the record where it should be, and nothing signed or run as a side effect.</p>
      <p className="mt-3 rounded-xl border border-line bg-white/60 p-3 text-sm" role="status">
        <b>{s.attacks} attacks tried, {s.blocked} blocked.</b> Without the permission gate, <b>{s.movedWithoutGate} of the {s.moneyAttacks}</b> money attacks would have moved money.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[56rem] text-sm">
          <thead><tr><Th>Category</Th><Th>What the attacker tried</Th><Th>With your protections</Th><Th>Without the permission gate</Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line align-top">
                <td className="py-2 pr-3 text-ink-soft">{r.category}</td>
                <td className="py-2 pr-3">{r.title}</td>
                <td className="py-2 pr-3">{r.passed ? <><Chip tone="good">Blocked</Chip> <span className="text-ink-soft">{why(r.observed.code, r.id)}</span></> : <Chip tone="danger">Not blocked</Chip>}</td>
                <td className="py-2">
                  {!r.baseline || r.baseline.outcome === "n/a" ? <span className="text-ink-soft">not applicable</span>
                    : r.baseline.outcome === "moved" ? <Chip tone="danger">money moved: {money(r.baseline.movedMinor, "GBP")}</Chip>
                    : <span className="text-ink-soft">no money moved</span>}
                </td>
              </tr>))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-ink-soft">Recorded run of <span className="font-mono">bun run check:attacks</span> (as of {results.asOf}, {s.attacks} attacks). Reproduce it with that command. The &quot;without the gate&quot; column comes from a test double that exists only in scripts/.</p>
    </Card>
  );
}
