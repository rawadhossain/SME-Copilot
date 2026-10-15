import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";

// The two SYNTHETIC sample documents (fixtures/), so the story can start from the UI with one click each.
export async function GET() {
  const f = (n: string) => readFileSync(join(process.cwd(), "fixtures", n), "utf8");
  return NextResponse.json({
    samples: [
      { filename: "supplier-quote-kestrel.md", kind: "supplier_quote", title: "Supplier quote (Kestrel Packaging Materials)", text: f("supplier-quote-kestrel.md") },
      { filename: "purchase-order-northgate.md", kind: "purchase_order", title: "Purchase order (Northgate Grocers)", text: f("purchase-order-northgate.md") },
    ],
  });
}
