// Regenerates fixtures/injected-purchase-order.md from the current purchase order fixture (the seed does this too).
import { readFileSync, writeFileSync } from "node:fs";
import { makeInjectedPurchaseOrder } from "../src/ingest/documents/fixtures";

writeFileSync("fixtures/injected-purchase-order.md", makeInjectedPurchaseOrder(readFileSync("fixtures/purchase-order-northgate.md", "utf8")));
console.log("wrote fixtures/injected-purchase-order.md");
