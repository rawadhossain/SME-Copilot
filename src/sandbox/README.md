# sandbox

The world the agent will act in: a fake bank, simulated counterparties and a proposal protocol. Synthetic only. See ADR-009.

## What it holds

- `proposals.ts`: the structured proposal kinds (zod discriminated union) and the structured response.
- `profile.ts`, `personalities.ts`: counterparty personalities (JSON in `counterparties.profile`) and the seed values.
- `simulators.ts`: pure `respond(profile, proposal)` functions. Same input, same output, no clock, no randomness.
- `index.ts`: database operations: `sendProposal`, `schedulePayment`, `executeDuePayments`, `submitApplication`, `getSandboxState`. The database is passed in; dates are passed in.
- `http.ts`: small helpers for the API routes.

## Proposal kinds

| Kind | Fields | Sent to |
|---|---|---|
| `buyer.request_deposit` | percentBps | customer |
| `buyer.request_early_payment` | daysEarly, discountBps | customer |
| `supplier.reduce_deposit` | percentBps | supplier |
| `supplier.defer_balance` | daysAfterShipment | supplier |
| `lender.apply_invoice_finance` | invoiceAmountMinor, currency, advanceBps | lender |

Outcomes: accept, counter, reject, offer, decline.

## The rule that matters

**Free text never drives decisions.** Only the structured fields of a proposal and the profile numbers decide an outcome. Counterparty notes are display text; every inbound message is stored with `untrusted = true` (a database CHECK enforces it), and a hostile counterparty's manipulation text changes nothing.

## What it does not do

It does not enforce owner limits, approvals or payee approval (the permission gate, a later batch, wraps these functions), it does not call any AI, and it does not write `action_records`.

Batch 8a: `acceptApplicationOffer`, `withdrawApplication` and `withdrawThread` (statuses accepted and withdrawn). Like the other writes, only `src/actions` calls them.

Batch 8b: `scheduleReceipt`, `cancelReceipt`, `executeDueReceipts` (table `sandbox_receipts`). Receipts are credited only by the bank's own end-of-day job.

Batch 9: proposal `buyer.chase_payment`; buyer personalities have `minDaysToPayOverdue`.
