# Open questions

Copied from the "Open decisions for the team" section of docs/product-strategy.md.

1. **Which concept leads?** Candidates: Terms Desk (get paid sooner), Deal Desk (can I take this order), Offer Referee (check financing offers), Leashed Autopilot (safe bill pay), Payer Pulse (late-payer prediction). Or a combination. UNKNOWN.
2. Initial country and currency for the story. **Defaulted, changeable:** UK, GBP (ADR-006).
3. Which counterparty personalities to build first. UNKNOWN.
4. Which AI model and provider. UNKNOWN.
5. Whether to keep multi-agent out of the first version. Recommended: yes.
6. Can we talk to 5 to 8 owners or accountants this week?

**Rules questions still open:** whether the 0 to 5 on-chain bonus applies to Topic E; how many teams reach the finals; how task completion is judged; whether simulated counterparties count as evidence.

## Added in Batch 3

7. ~~Healthy baseline for the demo?~~ **Resolved in Batch 3B:** the seeded history was reshaped so the baseline is healthy (ADR-006 addendum). Remaining: the downside variant lands at about GBP 361, not GBP 10k to 25k.
8. **Reserve policy.** The seeded reserve is one fortnightly payroll (GBP 28,000). Is that the right default for owners? UNKNOWN.
9. **Purchase order call-offs.** The number and size of weekly call-offs is UNKNOWN, so the order receipt is a single event 60 days after the first delivery (week 14). Now visible with the 20-week horizon. Model call-offs? UNKNOWN.
10. **Run-rate projection.** Added by me to make the forecast usable; the team should confirm it is acceptable and whether to show it separately on the timeline.
11. **VAT on the order** is not modelled (UNKNOWN how the owner accounts for VAT: standard or cash accounting).

12. ~~Downside variant definition.~~ **Resolved (Batch 4): accepted as is** (lowest GBP 360.86 in week 12, below the reserve from week 2). Revisit if the demo needs it.
13. **Second VAT bill.** At a 26-week horizon the baseline dips to about GBP 13k around week 21 (the next quarterly VAT estimate of GBP 41.8k). Not shown by default (the views use 13 and 20 weeks).

## Added in Batch 4

14. ~~Fee base for invoice finance.~~ **Resolved (Batch 5):** the fee stays at 2% of the invoice face value; the UI shows it (ADR-010). Still to confirm against a real term sheet later.
15. **Who advances when the buyer also pays a deposit?** The model finances only the remaining invoice. UNKNOWN whether a lender would.
16. ~~Payee approval and changed bank details.~~ **Resolved (Batch 5):** a bank-details change makes the payee unapproved and the gate blocks it until the owner re-approves (ADR-010).
17. **Should a counter-offer be accepted by a second proposal or by a separate "accept" action?** Today the agent re-proposes the countered terms and the simulator accepts. A separate accept step may be clearer for the log. UNKNOWN.

## Status after Batch 5

Resolved: 7, 12, 14, 16. Still open: 1 (which concept leads), 2 (defaulted GBP), 3 (counterparty personalities, partly built), 4 (AI provider), 5, 6, 8 (reserve policy), 9 (PO call-offs), 10 (run rate), 11 (VAT on the order), 13 (second VAT bill), 15 (lender and a buyer deposit), 17 (separate accept step for counter-offers).

New in Batch 5:

18. ~~Real keys and key custody.~~ **Resolved (Batch 6):** dev keys in .env are acceptable and documented; real custody is out of scope.
19. ~~Mandate lifecycle.~~ **Resolved (Batch 6):** revoke and replace is deferred; only version 1 exists.
20. ~~Proposal and approval expiry.~~ **Resolved (Batch 6):** 24 hours of world time, configurable (PROPOSAL_TTL_HOURS).
21. ~~Who can approve in the demo?~~ **Resolved (Batch 6):** owner login comes in the UI batch; until then approval takes a name string.

## Status after Batch 6

Resolved: 7, 12, 14, 16, 18, 19, 20, 21. Still open: 1 (which concept leads), 2 (GBP is a default), 3 (counterparty personalities, partly built), 4 (**which AI model and provider: UNKNOWN; the gateway works with any OpenAI-compatible endpoint, run bun run llm:smoke to test one**), 5, 6, 8 (reserve policy), 9 (PO call-offs), 10 (run rate), 11 (VAT on the order), 13 (second VAT bill), 15 (lender and a buyer deposit), 17 (separate accept step for counter-offers).

New in Batch 6:

22. **Which model reads documents well enough?** Extraction accuracy on real documents is untested. The scripted recordings prove the plumbing and the validator, not model quality. UNKNOWN until bun run llm:smoke and a real recording pass.
23. **Messy documents.** The reader and validator assume the fixture layout (ISO dates, amounts written with a currency code, a stated total). Scanned PDFs, other currencies and symbols, dates like 12/11/26 and VAT-exclusive quotes are not handled. PDF text extraction is not built. UNKNOWN how much of this the competition needs.
24. **Should suspicious text block confirmation?** Today it is a red warning and the owner decides. A stricter policy (require a typed acknowledgement, or block) is possible. UNKNOWN, recommended: require an explicit acknowledgement in the UI batch.
25. **Deposit terms on purchase orders** are shown but not mapped (a buyer deposit event would reduce the later receipt, as the lever in ADR-009 does). UNKNOWN whether to map automatically.

## New in Batch 7

26. **Does the search grid suit real suppliers?** The grids (deposit 25/20/15%, deferral 14/30 days, buyer deposit 10/20%) are assumptions. UNKNOWN.
27. **Ranking: cost before minimum balance.** Within the same group a cheaper plan wins over one with a higher minimum. Whether the owner would prefer more safety margin is UNKNOWN.
28. ~~Which model plans well?~~ **Resolved for gpt-4o-mini (Batch 7.5):** it first proposed plans that went below zero; the prompt now says to choose from search_plans results, and a code guard never lets a below-zero AI plan be the recommendation when a feasible one exists. In the confirming live run all 3 plans stayed above zero. Other models UNKNOWN.
29. **Contingencies are advice, not logic.** They are validated and shown; Batch 8 decides how a refusal triggers re-planning.

## New in Batch 7.5

30. **Model over-reports suspicious text.** gpt-4o-mini listed ordinary payment-term sentences as "suspicious instructions" on a benign quote (a warning, not a block). Whether to ask the model for stricter reporting or ignore model-only reports is UNKNOWN; relates to question 24.

## New in Batch 8a

17. ~~Counter-offer: separate accept step?~~ **Partly resolved:** an in-bound counter is accepted by proposing exactly the countered terms (ADR-017). A counter outside the signed bound is never accepted; what then happens is re-planning (8b).
29. ~~Contingencies~~ **Moved to 8b:** a refusal now ends the execution as needs_replan with structured reasons; using contingencies is part of re-planning.
31. **Scheduling the changed payments.** The gate's bank-floor and per-payment checks look at the balance now, not at future receipts, so the plan's own supplier payments (for example the balance of GBP 76,800 at a 20% deposit) would be denied. 8a records the agreed terms instead. Does the gate need a forward-looking floor? UNKNOWN; a decision for 8b or 9.
32. **Owner tolerances.** The default is zero (only exact terms continue). Is a per-lever tolerance the right way to let the agent accept small counters, or should the owner approve each counter? UNKNOWN.
33. **What verification should compare after an accepted counter.** The promise is the plan's metrics; a looser agreed term may still pass (cash only moves before the lowest point) or fail. Should the signature also bind worst-case metrics? UNKNOWN.
34. **Verification failure policy.** It is logged loudly but nothing is undone. Should a failed verification withdraw the plan automatically? UNKNOWN (8b).
35. **Stingy buyers vs the planner.** The real model's three plans all asked the buyer for a 20% deposit; the test buyer caps it at 10%. The planner may not see personalities (by design), so refusals will be common until re-planning exists (8b).

## Status after Batch 8b

31. ~~Scheduling the changed payments.~~ **Resolved (ADR-019):** receipts exist in the sandbox, the gate projects the balance on the payment date, and the demo per-payment limit was raised for the synthetic demo mandate (not the gate). The existing demo database still has the old limit until it is re-seeded.
33. ~~What verification compares after an accepted counter.~~ **Resolved (ADR-020):** the expectation is recomputed from the agreed terms; the promise-versus-agreed difference is shown and labelled.
34. ~~Verification failure policy.~~ **Resolved (ADR-022):** loud, kept as evidence, no automatic action; the owner decides.
35. ~~Stingy buyers vs the planner.~~ **Resolved for 8b (ADR-021):** the refusal becomes a structured constraint and the re-plan respects it (live: the 10% cap was learned and the new plan asked for 10%).
29. ~~Contingencies~~ **Still open:** the contingency lists are unused; the re-search replaced them. Keep, drop, or use as search hints? UNKNOWN.
36. **Should a re-plan start automatically after needs_replan?** Today it is an explicit call (and nothing executes without the owner). UNKNOWN; the UI batch decides.
37. **Estimated inflows in the gate projection.** The projection counts the engine's estimated customer receipts. A stricter policy (confirmed inflows only) is possible but would deny more. UNKNOWN.
32. **Owner tolerances** remain open (zero by default); the buyer-deposit-plus-finance limit (ADR-020) makes tolerance less useful for combined plans.

## Status after Batch 9

- Closed: the overdue-invoice definition (ADR-023), the buyer-counter plus finance limitation (ADR-025), the shortage trigger (ADR-026), the scoreboard definition (ADR-027; minimal version).
- 29. Contingencies remain unused (the re-search replaced them). Still open.
- 38. **Overdue collection delays (14 and 30 days).** The defaults are assumptions, configurable. What would a real owner or accountant use, and should it differ by customer (the history of how late each customer was after the due date is already used for the typical-lateness shift)? UNKNOWN.
- 39. **Early-payment discount cap.** The demo mandate allows 1.5%; with cooperative buyers asking about 2% for 30 days this allows about 20 days early. Is that the owner's real appetite? UNKNOWN.
- 40. **Chase as a negotiation.** The simulated buyer promises a date; real buyers pay late regardless. Should the forecast keep some lateness after a promise? UNKNOWN (the engine uses the promised date as an upper bound).
- 41. **Shortage sensitivity.** The detector flags any weekly closing below zero or below the reserve in 20 weeks, baseline variant. Should it also look at the downside variant, a shorter horizon, or a minimum size to avoid noise? UNKNOWN.
- 42. **Scoreboard scope.** Success rate over scripted scenarios and blocked attacks are not in the minimal scoreboard. Batch 11.
