# actions

The action pipeline (ADR-011): propose -> gate -> owner approval -> execute -> independent verification, every step in the hash-chained log. This is the only code that calls sandbox write operations.

| File | Role |
|---|---|
| `propose.ts` | Validate, run the gate, store the proposal (idempotent), log action.proposed and gate.decision |
| `approve.ts` | **Owner-only.** Signs an approval bound to the exact payload. Imports the owner-signing module |
| `execute.ts` | Checks approval binding, single use, expiry and signature, re-runs the gate, then runs the sandbox operation. Also `runBankTick`, the bank's own due-payments job |
| `verify.ts` | Independent verifier. Does not import the executor |
| `cancel.ts` | Cancels unexecuted actions and scheduled payments. An executed payment is irreversible |
| `payees.ts` | **Owner-only.** Change bank details (un-approves the payee) and re-approve |
| `owner-console.ts` | **Owner-only.** The manual console: propose, approve, execute, verify in one call, through the same pipeline |
| `read.ts` | Action list with timelines, mandate status, evidence export (log in chain order, head hash, chain check) |
| `types.ts` | Event names (defined only here), statuses, error type |
| `index.ts` | What the agent may import. Deliberately excludes the owner-only files |

States: proposed, denied, approved, executing, executed, verified, failed, verification_failed, cancelled, expired.

Payments: a payment dated on the world date executes immediately; a future-dated payment stays scheduled and can be cancelled until the bank's job runs.

## Plan authorisation and execution (Batch 8a)

| File | Role |
|---|---|
| `plan-terms.ts` | Pure: the exact requests and acceptance bounds of a plan, reply classification, what the signed terms cover |
| `plan-authority.ts` | Public-key checks: signature, hashes, expiry, mandate version and hash, coverage |
| `plan-authorise.ts` | OWNER-ONLY (imports the signing module): propose, then approve and sign. Not exported from `index.ts` |
| `plan-exec.ts` | Executor: negotiate one round, commit, compensate on failure, then verify. Holds no key |
| `plan-verify.ts` | Independent verifier: recomputes the forecast from the resulting sandbox state and compares with the promise |
| `plan-read.ts` | Status and evidence trail for the API |

See ADR-016 to ADR-018. Check it with `bun run check:plan`.

Batch 8b additions: `plan-schedule.ts` (the payments and receipts the agreed terms imply, read from the log), `replan.ts` (re-planning with structured constraints, max 2 rounds, exhausted result). Payments and receipts of a plan stay scheduled until the bank's job runs, so they can be withdrawn. See ADR-019 to ADR-022.

Batch 9 additions: `shortage.ts` (deterministic detector, idempotent planning run, supersede), `scoreboard.ts` (do nothing against the executed plan, from the engine and the log). The finance application can be re-submitted for a recomputed invoice inside a signed maximum (ADR-025). See ADR-023 to ADR-027.
