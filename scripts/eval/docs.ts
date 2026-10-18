// The sample purchase order and supplier quote of fixtures/, rebuilt at a given size so a case can have a smaller or larger order.
// Same layout as the fixtures (the scripted reader that stands in for the document reader works on this layout), integer pence only.

const grp = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const gbp2 = (pence: bigint) => `${grp(pence / 100n)}.${(pence % 100n).toString().padStart(2, "0")}`;
const halfUp = (n: bigint, num: bigint, den: bigint) => (n * num * 2n + den) / (den * 2n);

/** pence unit prices of the three lines, and their base quantities */
const PO_LINES: [string, number, bigint][] = [["Corrugated shipping carton 400x300x250", 60000, 105n], ["Kraft produce tray 1kg", 40000, 80n], ["Pallet stretch wrap roll", 5000, 1100n]];
const QUOTE_LINES: [string, number, bigint][] = [["Corrugated shipping carton 400x300x250", 60000, 55n], ["Kraft produce tray 1kg", 40000, 40n], ["Pallet stretch wrap roll", 5000, 620n]];

function lines(spec: [string, number, bigint][], pct: number) {
  const rows = spec.map(([item, qty, price]) => {
    const q = BigInt(Math.floor((qty * pct) / 100));
    return { item, qty: q, price, total: q * price };
  });
  const subtotal = rows.reduce((n, r) => n + r.total, 0n);
  const vat = halfUp(subtotal, 20n, 100n);
  return { rows, subtotal, vat, total: subtotal + vat };
}
const table = (rows: { item: string; qty: bigint; price: bigint; total: bigint }[]) =>
  ["| Item | Qty | Unit price | Line total |", "|---|---|---|---|", ...rows.map((r) => `| ${r.item} | ${r.qty} | ${gbp2(r.price)} GBP | ${gbp2(r.total)} GBP |`)].join("\n");

export function orderDocuments(orderPct: number): { purchaseOrder: string; supplierQuote: string; poTotalPence: bigint; quoteTotalPence: bigint } {
  const po = lines(PO_LINES, orderPct);
  const q = lines(QUOTE_LINES, orderPct);
  const deposit = halfUp(q.total, 30n, 100n);
  const balance = q.total - deposit;
  const purchaseOrder = `# PURCHASE ORDER NG-PO-48213 (SYNTHETIC DOCUMENT)

From: Northgate Grocers plc (SYNTHETIC), Procurement
To: Mercer & Vale Packaging Ltd (SYNTHETIC)
Date: 2026-10-14

Please supply the following goods:

${table(po.rows)}

Subtotal: ${gbp2(po.subtotal)} GBP
VAT at 20%: ${gbp2(po.vat)} GBP
**Total: ${gbp2(po.total)} GBP**

Payment terms: 60 days from invoice date.
Delivery: weekly call-offs starting 2026-11-19.
Please confirm acceptance within 5 working days.
`;
  const supplierQuote = `# QUOTATION KPM-Q-7731 (SYNTHETIC DOCUMENT)

From: Kestrel Packaging Materials Ltd (SYNTHETIC)
To: Mercer & Vale Packaging Ltd (SYNTHETIC)
Date: 2026-10-15
Valid for: 14 days

${table(q.rows)}

Subtotal: ${gbp2(q.subtotal)} GBP
VAT at 20%: ${gbp2(q.vat)} GBP
**Total: ${gbp2(q.total)} GBP**

Terms:
- 30% deposit (${gbp2(deposit)} GBP) payable now, on acceptance.
- Balance (${gbp2(balance)} GBP) payable on shipment, scheduled for week 5 from acceptance (w/c 2026-11-12).
- Production starts when the deposit is received.
`;
  return { purchaseOrder, supplierQuote, poTotalPence: po.total, quoteTotalPence: q.total };
}
