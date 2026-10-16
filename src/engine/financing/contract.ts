// Contract-versus-offer check (Phase K). Pure, deterministic, no model: the owner types the terms the lender's CONTRACT actually states, and
// plain code lists every way they differ from the OFFER the owner compared. Anything that costs the owner more is marked worse. A difference
// of unknown direction (a different date or number of payments) is reported and also treated as needing a look.
import type { FinancingOffer } from "@/domain/financing-offer";
import { costOf, type Cost } from "./compare";

export type DiffUnit = "money" | "date" | "count";
export interface ContractDifference {
  field: "principal" | "upfront_fees" | "advance_date" | "payment_count" | "total_repayment" | "payment";
  unit: DiffUnit;
  offered: string; // minor units, ISO date or a count
  contract: string;
  /** true: costs the owner more or gives less; false: in the owner's favour; null: direction unknown, needs a look. */
  worse: boolean | null;
  /** Which payment (1-based) when field is "payment". */
  paymentNumber?: number;
}

export interface ContractCheck {
  matches: boolean;
  /** True when anything differs; the contract should not be relied on until the owner has looked at every item. */
  needsAttention: boolean;
  worseCount: number;
  differences: ContractDifference[];
  offerCost: Cost;
  contractCost: Cost;
  /** Contract total cost minus offer total cost, minor units. Positive = the contract costs more. */
  extraCostMinor: bigint;
  /** Contract simple annualised cost minus the offer's, basis points. */
  annualisedDeltaBps: number;
}

const byDate = (a: { date: string }, b: { date: string }) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

export function checkContract(offer: FinancingOffer, contract: FinancingOffer): ContractCheck {
  if (offer.currency !== contract.currency) throw new Error(`The offer is in ${offer.currency} and the contract in ${contract.currency}`);
  const diffs: ContractDifference[] = [];
  const money = (field: ContractDifference["field"], o: bigint, c: bigint, worseIfHigher: boolean, extra: Partial<ContractDifference> = {}) => {
    if (o !== c) diffs.push({ field, unit: "money", offered: o.toString(), contract: c.toString(), worse: worseIfHigher ? c > o : c < o, ...extra });
  };
  money("principal", offer.principalMinor, contract.principalMinor, false);
  money("upfront_fees", offer.upfrontFeesMinor, contract.upfrontFeesMinor, true);
  if (offer.disbursementDate !== contract.disbursementDate) diffs.push({ field: "advance_date", unit: "date", offered: offer.disbursementDate, contract: contract.disbursementDate, worse: contract.disbursementDate > offer.disbursementDate ? true : null });

  const o = [...offer.repayments].sort(byDate);
  const c = [...contract.repayments].sort(byDate);
  if (o.length !== c.length) diffs.push({ field: "payment_count", unit: "count", offered: String(o.length), contract: String(c.length), worse: null });
  const total = (xs: { amountMinor: bigint }[]) => xs.reduce((a, r) => a + r.amountMinor, 0n);
  money("total_repayment", total(o), total(c), true);
  for (let i = 0; i < Math.min(o.length, c.length); i++) {
    if (o[i].date !== c[i].date) diffs.push({ field: "payment", unit: "date", offered: o[i].date, contract: c[i].date, worse: c[i].date < o[i].date ? true : null, paymentNumber: i + 1 });
    if (o[i].amountMinor !== c[i].amountMinor) diffs.push({ field: "payment", unit: "money", offered: o[i].amountMinor.toString(), contract: c[i].amountMinor.toString(), worse: c[i].amountMinor > o[i].amountMinor, paymentNumber: i + 1 });
  }

  const offerCost = costOf(offer);
  const contractCost = costOf(contract);
  return {
    matches: diffs.length === 0,
    needsAttention: diffs.length > 0,
    worseCount: diffs.filter((d) => d.worse !== false).length,
    differences: diffs,
    offerCost,
    contractCost,
    extraCostMinor: contractCost.totalCostMinor - offerCost.totalCostMinor,
    annualisedDeltaBps: contractCost.annualisedCostBps - offerCost.annualisedCostBps,
  };
}
