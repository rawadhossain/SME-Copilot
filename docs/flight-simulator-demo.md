# Flight simulator demo (repeatable, synthetic)

**Setup (once per demo, additive only):** `bun run db:up`, then `bun run demo:flight`. It creates a NEW flagged copy of the demo company ("Mercer & Vale demo run N (SYNTHETIC)") with both sample orders confirmed, a 50,000.00 supplier bill, and its bank balance raised so the lowest balance in the 20-week forecast is exactly the cushion plus 10,000.00: cushion £28,000.00, lowest balance today £38,000.00, healthy but thin. The demo company and every other business are untouched. Then `bun run demo`.

**Steps**
1. Sign in as the owner (`owner@mercer-vale.example`). Footer "Demo tools" (/dev), choose the company printed by `demo:flight`. Open **Simulator**.
2. Click **Combined crisis: late customer + supplier refuses**. Shown: Northgate Grocers (largest) 21 days late, Kestrel refuses a payment deferral. Click **Run the simulation**.
3. Expect: dashed "HYPOTHETICAL RESULT ... not verified" banner. Lowest balance today £38,000.00 (week 10); in the scenario −£12,753.68 (week 13), £40,753.68 short of the cushion, cushion first breached and cash runs out in week 9. "Northgate pays 21 days late: on its own moves the lowest balance by −£50,753.68"; the supplier refusal "does not change cash by itself".
4. Strategy table (8 rows): Do nothing = shortage. Coordinated strategy (20% buyer deposit + 5% invoice finance, cost £2,880.00, borrows £7,200 and repays £10,080) **resolves it**, recommended. Best without borrowing (20% deposit) only reduces it (£4,753.68 short). Finance alone (25%) and an 80% advance resolve it at £720 more. A 1% early-payment discount is "unacceptable" (worse than nothing). Today's deferral-based options are "not available" (the supplier refused). Open "Why this result · what could go wrong" on any row.
5. Read **Recommended response**: why it beats the others, what it relies on, what could still go wrong (late customer slip of 14 more days takes it to £456.32, below the cushion; the fallback if each party refuses; every ask is an assumption, nothing predicted).
6. Change **Days late** from 21 to 7 and click **Run again**. Expect "What changed": lowest £38,000.00, shortfall £0.00, "no action needed"; whole thing recomputed, not adjusted.
7. To act: the page links to **Plans**. In a business that really is short, Plans runs the same planner on the real books. To use the simulator's exact terms, use the plan's **Adjust terms**; the preview recomputes the identical figures; then Review and sign (password, second approver where limits require), gate, sandbox, independent check.

**Truthful caveats to say aloud:** nothing on the simulator page can sign, send or run; the numbers are a hypothetical copy; acceptance is unknown; Plans may list an equally priced option that borrows more (e.g. 80% advance) instead of the simulator's smallest-advance plan, which is why "Adjust terms" is the way to take the exact terms across.

**Checks:** `bun run test:simulator` (route protections, browser journey above, transition), `bun run check:flight` (engine and isolation).
