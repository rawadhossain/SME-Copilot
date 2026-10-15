# gate

The permission gate and the owner-signed mandate (ADR-010).

- `mandate.ts`: the Mandate schema (limits) and the signed form (canonical JSON plus Ed25519 signature).
- `canonical.ts`: stable JSON used for hashing and signing.
- `owner-signing.ts`: **the only module that reads the owner private key.** Signs mandates and approvals. `src/agent` must never import it (ESLint enforces it). Not exported from `index.ts`.
- `verify.ts`: verification with the PUBLIC key only (mandate, approval signatures).
- `request.ts`: the structured requests the gate understands (read, draft, send proposal, schedule payment, submit application, cancel payment). Unknown fields are stripped, so free text cannot influence a decision.
- `evaluate.ts`: the pure `evaluate(signedMandate, state, request)` function. No database, no clock, no randomness. Returns allow, needs_approval or deny with reasons and the limits checked.

Dev keys: `bun run mandate:keygen`. This is a simplified stand-in for verifiable-credential style mandates (such as AP2); see docs/security-model.md for what is and is not protected. Check it with `bun run check:gate`.

Batch 8a: `sandbox.accept_offer` (take up a finance offer; fee and advance checked against the mandate) and `sandbox.withdraw` (compensation; allowed without a mandate because it only reduces exposure). `owner-signing.ts` also signs plan authorisations; `verify.ts` checks them with the public key (ADR-016).

Batch 8b: `sandbox.schedule_receipt` (backed by an agreed thread or accepted application) and a forecast-aware payment check: when the state carries a `projection` (built by code from the engine, backed receipts and scheduled payments) the lowest projected balance from the payment date onward must stay at or above the mandate floor; without a projection the old check applies (ADR-019). `sandbox.withdraw` also covers scheduled payments and receipts.
