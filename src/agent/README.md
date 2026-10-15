# agent

The read-only planning agent (ADR-015): tool definitions, prompt, plan checking, scripted mock agents and the deterministic fallback. It reads and proposes plans; it cannot execute, send, schedule or approve.

- `tools.ts` the read-only tools (zod in and out, errors as structured results).
- `plan-builder.ts` validation, metrics, gate dry-run, assumptions. `prose.ts` checks numbers in model prose.
- `fallback.ts` deterministic plans from the search. `scripted.ts` the good and bad mock agents.
- `context.ts` the snapshot the orchestrator passes in; this code has no database access.

ESLint forbids importing `@/actions`, sandbox writes, `@/db`, owner-signing, approval or confirmation code. The orchestrator that writes to the database and the action log is `src/actions/agent-run.ts`.

The recommendation guard (`guard.ts`) is pure: it keeps a below-zero AI plan from being the recommendation when a feasible plan exists. Scripted agents: good, bad (validation) and weak (guard).

Batch 8a: unchanged and still read-only. Authorisation, execution and verification live in `src/actions/plan-*.ts`; the lint rule now also blocks `plan-authorise`, and `src/agent` cannot import anything from `src/actions`.

Batch 8b: the snapshot carries structured `constraints` learned from counterparty replies (`src/domain/constraints.ts`) and the lender fee to assume; `list_levers`, `search_plans`, the deterministic fallback and lever validation apply them. Still read-only and still no free text.

Batch 9: levers `chase_overdue` and `early_payment_discount` (bounds from the mandate and from which buyers have overdue / not-yet-due invoices); a shortage trigger gives the planner a structured reason instead of a document. Still read-only, still no free text.
