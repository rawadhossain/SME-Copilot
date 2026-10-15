// Display formatting. Money stays integer minor units until the last step; grouping is done on the digit string (no floating point).
const group = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function money(minor: string | bigint | number | null | undefined, currency = "GBP", opts: { signed?: boolean; compact?: boolean } = {}): string {
  if (minor === null || minor === undefined || minor === "") return "–";
  const v = BigInt(minor);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "USD" ? "$" : `${currency} `;
  const body = opts.compact && abs >= 100000n
    ? `${symbol}${group(abs / 100000n)}.${((abs / 10000n) % 10n).toString()}k`
    : `${symbol}${group(abs / 100n)}.${(abs % 100n).toString().padStart(2, "0")}`;
  return `${neg ? "−" : opts.signed && v > 0n ? "+" : ""}${body}`;
}

export function date(d: string | Date | null | undefined): string {
  if (!d) return "–";
  const t = typeof d === "string" ? new Date(d.length === 10 ? `${d}T00:00:00Z` : d) : d;
  return t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function dateTime(d: string | Date | null | undefined): string {
  if (!d) return "–";
  return new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export const pct = (bps: number | null | undefined): string => (bps === null || bps === undefined ? "–" : `${(bps / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`);
export const week = (w: number | null | undefined): string => (w === null || w === undefined ? "none" : `week ${w}`);
export const short = (h: string | null | undefined, n = 10): string => (h ? `${h.slice(0, n)}…` : "–");

export const LEVER_NAME: Record<string, string> = {
  supplier_reduce_deposit: "Lower the supplier deposit", supplier_defer_balance: "Defer the supplier balance", buyer_request_deposit: "Ask the buyer for a deposit",
  finance_invoice: "Finance the invoice", chase_overdue: "Chase an overdue buyer", early_payment_discount: "Offer an early-payment discount",
};

type LeverLike = { kind: string; percentBps?: number; daysAfterShipment?: number; advanceBps?: number; payWithinDays?: number; daysEarly?: number; discountBps?: number };

export function leverText(l: LeverLike, who?: string): string {
  const w = who ? ` (${who})` : "";
  switch (l.kind) {
    case "supplier_reduce_deposit": return `Cut the supplier deposit to ${pct(l.percentBps)}${w}`;
    case "supplier_defer_balance": return `Pay the supplier balance ${l.daysAfterShipment} days after shipment${w}`;
    case "buyer_request_deposit": return `Ask the buyer for a ${pct(l.percentBps)} deposit${w}`;
    case "finance_invoice": return `Finance the invoice: ${pct(l.advanceBps)} advance${w}`;
    case "chase_overdue": return `Chase overdue invoices: pay within ${l.payWithinDays} days${w}`;
    case "early_payment_discount": return `Offer ${pct(l.discountBps)} to pay ${l.daysEarly} days early${w}`;
    default: return l.kind;
  }
}

/** A learned constraint in plain words (from structured fields only). */
export function constraintText(c: { kind: string; excluded?: boolean; minPercentBps?: number; maxPercentBps?: number; maxDays?: number; minDays?: number; minDiscountBps?: number; assumedFeeBps?: number }, who: string): string {
  if (c.excluded) return `${who} refused: “${LEVER_NAME[c.kind] ?? c.kind}” will not be tried with them again.`;
  switch (c.kind) {
    case "buyer_request_deposit": return `${who} will pay at most a ${pct(c.maxPercentBps)} deposit.`;
    case "supplier_reduce_deposit": return `${who} will not go below a ${pct(c.minPercentBps)} deposit.`;
    case "supplier_defer_balance": return `${who} allows at most ${c.maxDays} days of deferral.`;
    case "chase_overdue": return `${who} will not pay overdue invoices sooner than ${c.minDays} days.`;
    case "early_payment_discount": return `${who} wants at least a ${pct(c.minDiscountBps)} discount to pay early.`;
    case "finance_invoice": return `${who} charges a ${pct(c.assumedFeeBps)} fee; plans now assume it.`;
    default: return `${who}: ${c.kind}`;
  }
}
