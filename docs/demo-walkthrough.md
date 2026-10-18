# Demo walkthrough (API level; the UI is Batch 10)

All data is SYNTHETIC. The demo business is Mercer & Vale Packaging Ltd (GBP). Run `bun run db:up`, `bun run db:migrate`, `bun run db:seed`, then `bun run mandate:v2` once (signs the demo mandate v2). Start the app with `bun run dev`. Replace `{biz}` with the demo business id (50d04f73-3186-40b1-96fe-46f478ea6134).

## 1. The shortage-trigger story (the main story)

1. **A commitment arrives.** `POST /api/business/{biz}/documents` with the supplier quote and the purchase order (fixtures in `fixtures/`), then `POST /api/extractions/{id}/confirm` for each (owner action). The model reads documents in quarantine; nothing is used until confirmed.
2. **A shortage is detected.** The confirm response contains `shortage`: the deterministic detector found `below_zero` (lowest about -GBP 61,000 in week 10, first negative week 5) and started a read-only planning run. `GET /api/business/{biz}/shortage-check` shows the detection without a run; `POST` runs it explicitly. The same shortage returns the same run.
3. **The agent proposes plans.** `GET /api/agent/runs/{runId}`: 2 to 3 plans with every number computed by the engine (lowest balance, first negative week, cost, counterparties needed), the gate dry-run per lever, and the do-nothing baseline. The levers can include supplier deposit/deferral, a buyer deposit, invoice finance, chasing an overdue buyer and an early-payment discount.
4. **The owner signs one plan.** `POST /api/business/{biz}/plan-authorisations` with `{runId, planId, confirmations: 2, tolerances?}`. The gate checks every lever against the signed mandate first; a plan outside it is stored as denied. The signature binds the plan, the exact requests and bounds, the expiry and the mandate version and hash.
5. **Negotiation, one round.** `POST /api/plan-authorisations/{id}/execute`: one structured proposal per counterparty. Replies are read from structured fields only. A counter inside a signed bound is accepted; anything else stops the plan as `needs_replan` and withdraws what was agreed.
6. **Re-plan if refused.** `POST /api/plan-authorisations/{id}/replan`: the refusal becomes a structured constraint (for example "the buyer pays at most a 10% deposit"), the agent plans again inside it (at most 2 rounds), and the owner signs the NEW plan. In the recorded story the first plan asked the buyer for 20%, the buyer capped it at 10%, and the re-plan asked for 10%.
7. **Execution.** Receipts and payments the agreed terms imply are scheduled in the sandbox, each through the gate (which projects the balance on the payment date), the signed authorisation, execution and per-action verification, all in the hash-chained log. They stay `scheduled` until the bank's end-of-day job, so the whole plan can be withdrawn.
8. **Independent verification.** The verifier recomputes the forecast from the sandbox state and compares it with the outcome the agreed terms should give, and shows the promise against the agreed outcome. A failure is loud (`verification_failed`) and nothing is retried automatically.
9. **Scoreboard.** `GET /api/business/{biz}/scoreboard`: do nothing against the executed plan (lowest balance, weeks below zero, cost), the verification result, owner approvals, denied or blocked actions.
10. **Evidence.** `GET /api/business/{biz}/evidence` returns the log and its chain check; `bun run db:verify-chain` verifies it.

## 2. The commitment story (Batches 6 to 8)

Same as 1 but started by hand: `POST /api/business/{biz}/agent/runs` with `{trigger: {type: "commitment", extractionId}}`.

## 3. Things worth showing

- **A plan outside the mandate is denied at signing** (try an early-payment discount of 9000 basis points or an advance above the cap).
- **Tampering fails:** edit the stored plan or the mandate after signing and `execute` refuses.
- **Hostile counterparty text** (the `quickbuy` personality) changes no decision.
- **The same shortage twice** does not create a second run; a changed forecast supersedes the old run.

## 4. Offline and live

Everything runs with the mock provider and recorded replays (`bun run check:plan`, `bun run check:agent`). The recorded live runs are in `fixtures/llm-recordings-live`; replay them with `LLM_MODE=replay` and an empty `LLM_API_KEY` (script `live-shortage.ts`).
