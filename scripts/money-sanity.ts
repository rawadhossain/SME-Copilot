import assert from "node:assert/strict";
import { add, compare, formatMoney, money, multiplyRatio, subtract } from "../src/lib/money";

const a = money(4_200_000n, "GBP");
assert.equal(formatMoney(a, 2), "42,000.00 GBP");
assert.equal(add(a, money(1n, "GBP")).amountMinor, 4_200_001n);
assert.equal(subtract(money(5n, "GBP"), money(8n, "GBP")).amountMinor, -3n);
assert.equal(compare(a, money(1n, "GBP")), 1);
assert.throws(() => add(a, money(1n, "USD")));
assert.equal(formatMoney(money(1234n, "JPY"), 0), "1,234 JPY");

const r = { num: 1n, den: 2n };
const m = (n: bigint, mode: Parameters<typeof multiplyRatio>[2]) => multiplyRatio(money(n, "GBP"), r, mode).amountMinor;
assert.deepEqual([m(5n, "floor"), m(5n, "ceil"), m(5n, "half-up"), m(5n, "half-even")], [2n, 3n, 3n, 2n]);
assert.deepEqual([m(-5n, "floor"), m(-5n, "ceil"), m(-5n, "half-up"), m(-5n, "half-even")], [-3n, -2n, -3n, -2n]);
// 1.5% of 180,000.00 GBP
assert.equal(multiplyRatio(money(18_000_000n, "GBP"), { num: 3n, den: 200n }, "half-up").amountMinor, 270_000n);
console.log("money sanity: ok");
