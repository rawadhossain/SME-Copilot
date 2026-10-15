import assert from "node:assert/strict";
import { add, compare, formatMoney, money, moneyFromJson, moneyToJson, multiplyRatio, parseDecimalToMinor, subtract } from "../src/lib/money";

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
// Parsing and JSON boundary
assert.equal(parseDecimalToMinor("1,234.56", 2), 123_456n);
assert.equal(parseDecimalToMinor("-45.00", 2), -4_500n);
assert.equal(parseDecimalToMinor("45", 2), 4_500n);
assert.equal(parseDecimalToMinor("0.05", 2), 5n);
assert.equal(parseDecimalToMinor("+7.1", 2), 710n);
assert.equal(parseDecimalToMinor("1,234", 0), 1_234n); // JPY
assert.equal(parseDecimalToMinor("-9007199254740993.99", 2), -900_719_925_474_099_399n); // beyond Number precision
for (const bad of ["", "abc", "1.234", "1,23", "1.234,56", ".5", "5.", "1,2345.00", "(45.00)", "£45", "--1", "1e3"]) {
  assert.throws(() => parseDecimalToMinor(bad, 2), `should reject "${bad}"`);
}
assert.throws(() => parseDecimalToMinor("12.5", 0));
const rt = money(-123_456n, "GBP");
assert.deepEqual(moneyFromJson(JSON.parse(JSON.stringify(moneyToJson(rt)))), rt);
assert.throws(() => moneyFromJson({ amountMinor: "12.5", currency: "GBP" }));
assert.throws(() => moneyFromJson({ amountMinor: "1", currency: "gbp" }));
assert.throws(() => moneyFromJson({ amountMinor: "99999999999999999999", currency: "GBP" }));

console.log("money sanity: ok");
