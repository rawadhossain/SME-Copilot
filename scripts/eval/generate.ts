// Seeded generator of crisis cases for the evaluation (bun run eval). Pure: no Math.random, no wall clock, no database.
// A case is a parameter set; scripts/eval/run-case.ts applies it to a FRESH throwaway is_test clone of the demo business.
// The ranges are fixed here, once, and are listed in docs/eval-results.md. They are never tuned to improve a rate.
export const DEFAULT_SEED = 20261018;
export const DEFAULT_CASES = 60;

export const SHOCKS = ["none", "customer_late", "supplier_refusal"] as const;
export type Shock = (typeof SHOCKS)[number];

export interface CaseParams {
  index: number; // 1-based
  /** Opening bank balance as a percent of the demo's (books and sandbox bank), 60..160. */
  balancePct: number;
  /** Safety cushion as a percent of the demo's, 80..120 (businesses.reserve_minor; the signed mandate is not touched). */
  reservePct: number;
  /** Size of the sample order and of the supplier quote behind it, percent of the sample documents, 50..150. */
  orderPct: number;
  /** Extra days the largest customer (Northgate) paid late in its paid-invoice history, 0..30. This is the learned lateness the forecast uses. */
  lateExtraDays: number;
  /** The largest deposit the order's buyer accepts, percent: 5, 10, 20 or 30. */
  buyerDepositCapPct: 5 | 10 | 20 | 30;
  /** Do the customers agree to pay overdue invoices when chased (within 14 days)? false: they will not commit before 90 days. */
  buyersAcceptChase: boolean;
  /** Does the supplier defer the balance (up to 14 days after shipment)? false: balance due on shipment. */
  supplierDefers: boolean;
  /** The lowest deposit the supplier accepts, percent of the quote (its standard deposit is 30%): 15, 20, 25 or 30. */
  supplierMinDepositPct: 15 | 20 | 25 | 30;
  /** The lender's fee on the invoice face value, basis points, 150..400 in steps of 25. (The signed mandate caps the fee it will accept at 300.) */
  lenderFeeBps: number;
  shock: Shock;
}

export const RANGES = {
  balancePct: "60 to 160 (percent of the demo's GBP 42,000.00 opening balance)",
  reservePct: "80 to 120 (percent of the demo's safety cushion)",
  orderPct: "50 to 150 (percent of the sample order, quote and purchase order both)",
  lateExtraDays: "0 to 30 (extra days the largest customer paid late in its history)",
  buyerDepositCapPct: "5, 10, 20 or 30",
  buyersAcceptChase: "accept (pay within 14 days) or refuse (not before 90 days), 50/50",
  supplierDefers: "defers up to 14 days or refuses, 50/50",
  supplierMinDepositPct: "15, 20, 25 or 30 (standard deposit 30)",
  lenderFeeBps: "150 to 400 in steps of 25 (1.5% to 4.0% of the invoice); the signed mandate accepts up to 300",
  shock: "none (50%), customer_late (25%: the largest customer pays a further 21 days late), supplier_refusal (25%: the supplier refuses both a lower deposit and a deferral)",
} as const;

/** mulberry32: small, fast, well-distributed 32-bit generator. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each case has its own stream, so case k is the same whatever N is. */
const streamSeed = (seed: number, index: number): number => (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(index, 0x85ebca6b)) >>> 0;

export function generateCase(seed: number, index: number): CaseParams {
  const r = mulberry32(streamSeed(seed, index));
  for (let i = 0; i < 4; i++) r(); // warm up: neighbouring indexes give unrelated streams
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const shockRoll = r();
  return {
    index,
    balancePct: int(60, 160),
    reservePct: int(80, 120),
    orderPct: int(50, 150),
    lateExtraDays: int(0, 30),
    buyerDepositCapPct: pick([5, 10, 20, 30] as const),
    buyersAcceptChase: r() < 0.5,
    supplierDefers: r() < 0.5,
    supplierMinDepositPct: pick([15, 20, 25, 30] as const),
    lenderFeeBps: 150 + 25 * int(0, 10),
    shock: shockRoll < 0.5 ? "none" : shockRoll < 0.75 ? "customer_late" : "supplier_refusal",
  };
}

export function generateCases(n: number, seed: number = DEFAULT_SEED): CaseParams[] {
  return Array.from({ length: n }, (_, i) => generateCase(seed, i + 1));
}

export function describeParams(p: CaseParams): string {
  return `balance ${p.balancePct}%, cushion ${p.reservePct}%, order ${p.orderPct}%, +${p.lateExtraDays}d late, buyer deposit cap ${p.buyerDepositCapPct}%, chase ${p.buyersAcceptChase ? "accepted" : "refused"}, supplier ${p.supplierDefers ? "defers" : "no deferral"} / min deposit ${p.supplierMinDepositPct}%, lender fee ${(p.lenderFeeBps / 100).toFixed(2)}%, shock ${p.shock}`;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/eval/generate.ts")) {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? Number(process.argv[i + 1]) : undefined; };
  const cases = generateCases(arg("cases") ?? DEFAULT_CASES, arg("seed") ?? DEFAULT_SEED);
  for (const c of cases) console.log(`${String(c.index).padStart(3)}  ${describeParams(c)}`);
}
