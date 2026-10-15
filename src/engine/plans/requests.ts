// Pure: the sandbox request each lever would become (for the gate dry-run), built from structured data only.
import type { CommitmentEvent } from "@/domain/commitment-event";
import type { Lever } from "@/domain/plan";
import type { GateRequestJson } from "@/gate/request";
import { money, multiplyRatio } from "@/lib/money";

/** The customer invoice the lender would finance: the order receipt, less any buyer deposit lever. */
export function financedInvoiceMinor(baseEvents: CommitmentEvent[], levers: Lever[]): { amountMinor: bigint; currency: string } | null {
  const receipt = baseEvents.find((e) => e.kind === "customer_receipt");
  if (!receipt) return null;
  const deposit = levers.find((l) => l.kind === "buyer_request_deposit");
  const upfront =
    deposit && deposit.kind === "buyer_request_deposit"
      ? multiplyRatio(money(receipt.amountMinor, receipt.currency), { num: BigInt(deposit.percentBps), den: 10000n }, "half-up").amountMinor
      : 0n;
  return { amountMinor: receipt.amountMinor - upfront, currency: receipt.currency };
}

export function leverToRequest(lever: Lever, baseEvents: CommitmentEvent[], allLevers: Lever[]): GateRequestJson | null {
  switch (lever.kind) {
    case "supplier_reduce_deposit":
      return { kind: "sandbox.send_proposal", counterpartyId: lever.counterpartyId, proposal: { kind: "supplier.reduce_deposit", percentBps: lever.percentBps } };
    case "supplier_defer_balance":
      return { kind: "sandbox.send_proposal", counterpartyId: lever.counterpartyId, proposal: { kind: "supplier.defer_balance", daysAfterShipment: lever.daysAfterShipment } };
    case "buyer_request_deposit":
      return { kind: "sandbox.send_proposal", counterpartyId: lever.counterpartyId, proposal: { kind: "buyer.request_deposit", percentBps: lever.percentBps } };
    case "chase_overdue":
      return { kind: "sandbox.send_proposal", counterpartyId: lever.counterpartyId, proposal: { kind: "buyer.chase_payment", payWithinDays: lever.payWithinDays } };
    case "early_payment_discount":
      return { kind: "sandbox.send_proposal", counterpartyId: lever.counterpartyId, proposal: { kind: "buyer.request_early_payment", daysEarly: lever.daysEarly, discountBps: lever.discountBps } };
    case "finance_invoice": {
      const inv = financedInvoiceMinor(baseEvents, allLevers);
      return inv ? { kind: "sandbox.submit_application", lenderId: lever.counterpartyId, invoiceAmountMinor: inv.amountMinor.toString(), advanceBps: lever.advanceBps } : null;
    }
  }
}
