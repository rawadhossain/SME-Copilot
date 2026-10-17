// Which invoices and bills the forecast is still waiting on, and how much of each. One definition, shared by the forecast, the plan search and the agent tools.
import type { BillRecord, InvoiceRecord } from "./types";

/** Open, not already counted elsewhere in the forecast, and something still unpaid. */
export const isForecast = (r: InvoiceRecord | BillRecord): boolean => r.status === "open" && !r.countedIn && (r.outstanding === undefined || r.outstanding > 0n);
/** The unpaid part: the whole amount unless payments were recorded. */
export const owedOf = (r: InvoiceRecord | BillRecord): bigint => r.outstanding ?? r.amount;
