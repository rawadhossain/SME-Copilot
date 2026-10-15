// The sample order from fixtures/ as structured CommitmentEvents: a stand-in for the future document reader.
//   fixtures/purchase-order-northgate.md : GBP 180,000 incl. VAT, 60-day terms, call-offs from asOf + 35 days
//   fixtures/supplier-quote-kestrel.md   : GBP 96,000 incl. VAT, 30% deposit now, balance on shipment in week 5
// Pure: dates are derived from the asOf argument; no clock.
import type { CommitmentEvent } from "@/domain/commitment-event";
import { money, multiplyRatio } from "@/lib/money";
import { addDays } from "../dates";

/**
 * Rounding rule (ADR-008): percentages of money use half-up to the minor unit. The balance is the total minus the
 * rounded deposit, so deposit + balance always equals the total exactly.
 */
export function sampleOrderEvents(asOf: string, currency = "GBP"): CommitmentEvent[] {
  // Quote lines (qty x unit price in minor units), then VAT at 20%.
  const quoteSubtotal = 60000n * 55n + 40000n * 40n + 5000n * 620n; // 8,000,000 = GBP 80,000.00
  const quoteTotal = quoteSubtotal + multiplyRatio(money(quoteSubtotal, currency), { num: 1n, den: 5n }, "half-up").amountMinor; // 9,600,000
  const deposit = multiplyRatio(money(quoteTotal, currency), { num: 3n, den: 10n }, "half-up").amountMinor; // 30%
  const balance = quoteTotal - deposit;

  const poSubtotal = 60000n * 105n + 40000n * 80n + 5000n * 1100n; // 15,000,000 = GBP 150,000.00
  const poTotal = poSubtotal + multiplyRatio(money(poSubtotal, currency), { num: 1n, den: 5n }, "half-up").amountMinor; // 18,000,000

  const firstDelivery = addDays(asOf, 35);
  return [
    {
      date: asOf, amountMinor: -deposit, currency, kind: "supplier_deposit", source: "manual", confidence: "high",
      label: "Kestrel deposit (30% of quote KPM-Q-7731), due on acceptance", sourceRef: "supplier-quote-kestrel.md",
    },
    {
      date: addDays(asOf, 28), amountMinor: -balance, currency, kind: "supplier_balance", source: "manual", confidence: "medium",
      label: "Kestrel balance on shipment (week 5)", sourceRef: "supplier-quote-kestrel.md",
    },
    {
      date: addDays(firstDelivery, 60), amountMinor: poTotal, currency, kind: "customer_receipt", source: "manual", confidence: "medium",
      label: "Northgate order NG-PO-48213 paid, 60 days after first delivery", sourceRef: "purchase-order-northgate.md",
    },
  ];
}
