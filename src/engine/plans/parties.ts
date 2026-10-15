// Which counterparty plays which part in an order. Uses only ids, names, roles and the events' kinds: NEVER personality data.
import type { CommitmentEvent } from "@/domain/commitment-event";

export interface PartyInfo {
  id: string;
  name: string;
  role: "customer" | "supplier" | "lender";
}

export interface Parties {
  supplierId: string | null;
  buyerId: string | null;
  lenderId: string | null;
}

const firstWord = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

/**
 * The supplier and buyer are the counterparties whose first name word starts the label of the supplier or customer
 * events (the mapper writes "<Name> deposit ...", "<Name> order ... paid ..."); if no label matches but exactly one
 * counterparty has that role, it is used. The lender is the only lender, else the first by name.
 */
export function resolveParties(events: CommitmentEvent[], counterparties: PartyInfo[]): Parties {
  const pick = (role: PartyInfo["role"], kinds: CommitmentEvent["kind"][]): string | null => {
    const ofRole = counterparties.filter((c) => c.role === role).sort((a, b) => a.name.localeCompare(b.name));
    const labels = events.filter((e) => kinds.includes(e.kind)).map((e) => firstWord(e.label));
    const matched = ofRole.filter((c) => labels.includes(firstWord(c.name)));
    if (matched.length === 1) return matched[0].id;
    if (matched.length === 0 && ofRole.length === 1) return ofRole[0].id;
    return matched[0]?.id ?? null;
  };
  const lenders = counterparties.filter((c) => c.role === "lender").sort((a, b) => a.name.localeCompare(b.name));
  return {
    supplierId: pick("supplier", ["supplier_deposit", "supplier_balance"]),
    buyerId: pick("customer", ["customer_receipt"]),
    lenderId: lenders[0]?.id ?? null,
  };
}
