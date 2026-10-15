// SCRIPTED (not model) extraction responses for the mock provider. They are written by hand as rules over the layout of
// the two fixture documents, so they keep working when the seed dates change. They read like a careful model would:
// every value comes with a verbatim evidence quote. A recording made from them is marked scripted: true.
//
// Two deliberately BAD behaviours exist for tests:
//   [[test:fabricated-amount]] in a purchase order makes the scripted reader claim a total that is not in the document.
// (An inconsistent quote needs no marker: edit the document so deposit + balance differ from the total.)
import { registerStructuredScript } from "@/ai/scripted";
import { purposeIdFor } from "./prompt";
import type { Confidence, PoOutput, QuoteOutput } from "./schema";

const find = (text: string, re: RegExp): RegExpMatchArray | null => text.match(re);
type F<T> = { value: T | null; confidence: Confidence; evidence: string | null };
const field = <T extends string | number>(value: T, confidence: Confidence, evidence: string): F<T> => ({ value, confidence, evidence });
const none = <T,>(): F<T> => ({ value: null, confidence: "low", evidence: null });
const lineWith = (text: string, re: RegExp) => text.split("\n").map((l) => l.trim()).filter((l) => re.test(l));

const INJECTION_LINES = /AI assistant|ignore (previous|your)/i;

export function scriptedPurchaseOrder(text: string): PoOutput {
  const from = find(text, /From:\s*([^,\n]+)/);
  const ref = find(text, /PURCHASE ORDER\s+(\S+)/);
  const total = find(text, /Total:\s*([\d,]+\.\d{2})\s*([A-Z]{3})/);
  const terms = find(text, /Payment terms:\s*(\d+)\s*days[^\n]*/);
  const delivery = find(text, /Delivery:[^\n]*?(\d{4}-\d{2}-\d{2})[^\n]*/);
  const fabricate = text.includes("[[test:fabricated-amount]]");
  return {
    buyerName: from ? field(from[1].trim(), "high", from[0].trim()) : none(),
    orderReference: ref ? field(ref[1], "high", ref[0]) : none(),
    totalAmount: fabricate ? field("190,000.00", "high", "Total: 190,000.00 GBP") : total ? field(total[1], "high", total[0]) : none(),
    currency: total ? field(total[2], "high", total[0]) : none(),
    paymentTermsDays: terms ? field(Number(terms[1]), "high", terms[0].trim()) : none(),
    deliveryDate: delivery ? field(delivery[1], "medium", delivery[0].trim()) : none(),
    depositTerms: none(),
    suspiciousInstructions: lineWith(text, INJECTION_LINES),
  };
}

export function scriptedSupplierQuote(text: string): QuoteOutput {
  const from = find(text, /From:\s*([^\n]+)/);
  const ref = find(text, /QUOTATION\s+(\S+)/);
  const total = find(text, /Total:\s*([\d,]+\.\d{2})\s*([A-Z]{3})/);
  const deposit = find(text, /(\d+(?:\.\d+)?)%\s*deposit[^\n]*/);
  const balance = find(text, /Balance\s*\(([\d,]+\.\d{2})\s*[A-Z]{3}\)[^\n]*/);
  const timing = find(text, /payable on shipment/i);
  const week = find(text, /scheduled for week (\d+) from acceptance/);
  const wc = find(text, /w\/c (\d{4}-\d{2}-\d{2})/);
  const valid = find(text, /Valid for:\s*(\d+)\s*days/);
  const onAcceptance = deposit ? find(deposit[0], /on acceptance/i) : null;
  return {
    supplierName: from ? field(from[1].trim(), "high", from[0].trim()) : none(),
    quoteReference: ref ? field(ref[1], "high", ref[0]) : none(),
    totalAmount: total ? field(total[1], "high", total[0]) : none(),
    currency: total ? field(total[2], "high", total[0]) : none(),
    depositPercent: deposit ? field(deposit[1], "high", deposit[0].trim()) : none(),
    depositDue: deposit && onAcceptance ? field("on acceptance", "high", deposit[0].trim()) : none(),
    balanceAmount: balance ? field(balance[1], "high", balance[0].trim()) : none(),
    balanceTiming: timing ? field("on shipment", "medium", timing[0]) : none(),
    shipmentWeek: week ? field(Number(week[1]), "medium", week[0]) : none(),
    shipmentDate: wc ? field(wc[1], "medium", wc[0]) : none(),
    validityDays: valid ? field(Number(valid[1]), "high", valid[0]) : none(),
    suspiciousInstructions: lineWith(text, INJECTION_LINES),
  };
}

const documentOf = (messages: { role: string; content: string }[]): string => {
  const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const start = user.indexOf("<document>\n");
  const end = user.lastIndexOf("\n</document>");
  return start >= 0 && end > start ? user.slice(start + "<document>\n".length, end) : user;
};

registerStructuredScript(purposeIdFor("purchase_order"), ({ messages }) => scriptedPurchaseOrder(documentOf(messages)));
registerStructuredScript(purposeIdFor("supplier_quote"), ({ messages }) => scriptedSupplierQuote(documentOf(messages)));
