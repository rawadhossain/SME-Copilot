// Seed personalities for the simulated counterparties, keyed by the seed's counterparty key.
// Validated by profileSchema when read (src/sandbox/profile.ts).
export const SEED_PERSONALITIES: Record<string, Record<string, unknown>> = {
  // Stingy buyer: accepts at most a 10% deposit; early payment only for a generous discount (3% per 30 days early).
  grocer: { temperament: "stingy", maxBuyerDepositBps: 1000, minDiscountBpsPer30Days: 300 },
  harbour: { temperament: "cooperative", maxBuyerDepositBps: 1500, minDiscountBpsPer30Days: 200 },
  pennine: { temperament: "cooperative", maxBuyerDepositBps: 1500, minDiscountBpsPer30Days: 200 },
  // Cooperative supplier: standard deposit 30%, will go down to 15%, defers the balance up to 14 days.
  kestrel: { temperament: "cooperative", standardDepositBps: 3000, maxSupplierDepositReductionBps: 1500, maxBalanceDeferralDays: 14 },
  // Standard lender: 80% advance cap, fee 2.0% of the invoice face value.
  clearwater: { temperament: "cooperative", maxAdvanceBps: 8000, feeBps: 200 },
  // Hostile small customer, for later security demos.
  quickbuy: { temperament: "hostile", maxBuyerDepositBps: 500, minDiscountBpsPer30Days: 500 },
};
