import type { DocKind } from "@/domain/ledger";

export const kindOf = (segment: string): DocKind | null => (segment === "invoices" ? "invoice" : segment === "bills" ? "bill" : null);
