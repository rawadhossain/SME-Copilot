// Deterministic mapper (not an LLM): a CONFIRMED extraction becomes CommitmentEvents for the scenario engine.
// Percentages use the existing money helpers with half-up rounding (ADR-008): the supplier deposit is the rounded share
// of the quote total and the balance is the total minus that deposit, so the two always add up exactly.
import type { CommitmentEvent } from "@/domain/commitment-event";
import { addDays } from "@/engine/dates";
import { money, multiplyRatio } from "@/lib/money";
import type { ExtractionResult, FieldResult, PoDerived, QuoteDerived } from "./validate";

const RANK = { low: 0, medium: 1, high: 2 } as const;
const minConfidence = (fields: (FieldResult | undefined)[]): "high" | "medium" | "low" => {
  const present = fields.filter((f): f is FieldResult => !!f && f.status === "verified");
  if (present.length === 0) return "low";
  return present.reduce((a, f) => (RANK[f.confidence] < RANK[a] ? f.confidence : a), "high" as "high" | "medium" | "low");
};
const shortName = (full: string): string => full.trim().split(/\s+/)[0];
const pct = (bps: number): string => `${(bps / 100).toFixed(2).replace(/\.00$/, "")}%`;

export class MappingRefusedError extends Error {}

export function mapExtractionToEvents(result: ExtractionResult, ctx: { status: string; filename: string }): CommitmentEvent[] {
  if (ctx.status !== "confirmed") throw new MappingRefusedError(`Only a confirmed extraction can be mapped (status is ${ctx.status})`);
  if (!result.derived) throw new MappingRefusedError("The extraction has missing or rejected required fields; nothing is mapped");
  const f = result.fields;

  if (result.kind === "supplier_quote") {
    const d = result.derived as QuoteDerived;
    const total = BigInt(d.totalMinor);
    const deposit = multiplyRatio(money(total, d.currency), { num: BigInt(d.depositBps), den: 10000n }, "half-up").amountMinor;
    const name = shortName(d.supplierName);
    return [
      {
        date: d.depositDate, amountMinor: -deposit, currency: d.currency, kind: "supplier_deposit", source: "document",
        confidence: minConfidence([f.totalAmount, f.currency, f.depositPercent, f.depositDue]),
        label: `${name} deposit (${pct(d.depositBps)} of quote ${d.quoteReference}), due on acceptance`, sourceRef: ctx.filename,
      },
      {
        date: d.balanceDate, amountMinor: -(total - deposit), currency: d.currency, kind: "supplier_balance", source: "document",
        confidence: minConfidence([f.totalAmount, f.depositPercent, f.balanceAmount, f.balanceTiming, f.shipmentDate, f.shipmentWeek]),
        label: `${name} balance on shipment (week ${d.weekNumber})`, sourceRef: ctx.filename,
      },
    ];
  }

  const d = result.derived as PoDerived;
  return [
    {
      date: addDays(d.deliveryDate, d.termsDays), amountMinor: BigInt(d.totalMinor), currency: d.currency, kind: "customer_receipt", source: "document",
      confidence: minConfidence([f.totalAmount, f.currency, f.paymentTermsDays, f.deliveryDate]),
      label: `${shortName(d.buyerName)} order ${d.orderReference} paid, ${d.termsDays} days after first delivery`, sourceRef: ctx.filename,
    },
  ];
}
