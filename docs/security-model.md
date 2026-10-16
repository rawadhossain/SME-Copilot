# Security model (seed of the self-assessment)

Status: Batch 5. Synthetic data, dev keys, sandbox only. Honest about what is and is not protected.

## Principles

1. The language model never decides what is allowed. A pure function (the gate) decides, from a signed mandate and structured inputs.
2. Limits are signed by the owner, verified on every evaluation, and enforced in code.
3. Document, email and counterparty text is untrusted data, never instructions.
4. Every proposal, approval and action is written to an append-only, hash-chained log.
5. An approval covers one exact action and can be used once.

## Permission tiers as implemented

| Tier | Examples | Gate result |
|---|---|---|
| read | read.state | allow |
| draft | draft.message | allow |
| external | send a proposal to a counterparty, submit a finance application | needs_approval inside the limits, deny outside |
| money | schedule or cancel a payment | needs_approval inside the limits (two confirmations above GBP 10,000), deny outside |

## Controls

- **Owner-signed mandate** (Ed25519). Editing one value, an expired or missing mandate, or one for another business denies all external and money actions (tested).
- **Approval binding.** Signature over {proposal id, payload hash, confirmations}; single use; expires; payload hash re-checked at execution (tested: modified payload, reused approval, expired approval).
- **Re-evaluation at execution.** The gate runs again against the situation at execution time (tested: payee bank details changed after approval).
- **Payee protection.** Approved payees only; no new payees; a bank-details change un-approves the payee and the payment's recorded hash no longer matches (tested).
- **Independent verifier.** A separate module checks facts against the approval and the mandate, and detects a tampered executed payment (tested).
- **Untrusted inbound text.** Every inbound sandbox message has `untrusted = true`, enforced by a database CHECK constraint. Request schemas strip unknown fields. Hostile free text changed no gate decision and no simulator outcome (tested).
- **Append-only log.** Database triggers block UPDATE, DELETE and TRUNCATE; the app role has INSERT and SELECT only; each record is hash-chained per business; an evidence export returns the head hash and count.
- **Separation of keys.** Only `src/gate/owner-signing.ts` reads the private key; `src/agent` cannot import it or the approval code (ESLint).
- **Single execution path.** Only `src/actions` calls sandbox write operations (ESLint blocks it elsewhere in the app).

## Document text is untrusted (Batch 6)

- **Quarantine.** The reader makes one structured-output call with no tools and a system prompt that treats the document as data. Even a fully manipulated model can only return a JSON claim: it cannot call anything, move money, change a limit or confirm an extraction.
- **Deterministic validation** checks every claim against the text (verbatim evidence, amounts that are in the document, consistent totals, real dates). A fabricated or inconsistent claim is rejected or flagged and the extraction becomes failed (tested).
- **Independent scan.** A pattern scan for instructions aimed at an AI or the reader runs without the model, so a model that was talked into silence still gets flagged (tested: the scan flags the injected order even when the model call fails).
- **Owner confirmation.** Nothing is used until the owner confirms. Confirmation is an owner-only code path (ESLint keeps the agent and the rest of the app out), and it is written to the hash-chained log with a hash of the confirmed result. Suspicious passages are logged at detection.
- **Mapping is deterministic.** Only a confirmed extraction maps to events, using the money helpers; the injected instructions changed nothing in the mapped events (tested).
- **Model output never directly drives money or limits.** Events from documents are scenario inputs for the forecast. Any action still goes through the gate, the mandate and the owner's approval.
- **Telemetry holds no document text or secrets;** recordings are refused if they look like they contain a key.

## Known-risk list (from the strategy) and where we are

| Risk | Status |
|---|---|
| Wrong document extraction | Evidence-checked, cross-checked, flagged, owner-confirmed. Tested with scripted responses only; real model accuracy is untested. |
| Wrong calculation | Calculations are deterministic code with sanity scripts. No large test suite. |
| Over-trust by the owner | Approval screens show the gate reasons and limits; the agent is not built yet. |
| Injection through documents or counterparties | Structured-only decisions; untrusted flag; tested with hostile text. No LLM is connected yet, so the prompt-injection surface is not exercised. |
| Unauthorised transfers | Mandate limits, approved payees, bank floor, two confirmations, verifier. Sandbox money only. |
| Privacy | Synthetic data only. No personal data. |

## What is NOT protected yet

- **Dev keys live in .env** (and a dev pair is in .env.example). Anyone with the repository can sign as the owner. Real custody (device or hardware key) is not designed.
- **No authentication.** The approve endpoints take a name string; anyone who can reach the server can approve. The owner-facing routes are separated by convention and lint rules, not by login.
- **A superuser can disable the log triggers** or edit the tables (the tamper tests do exactly that to prove detection). The chain detects edits; it cannot detect deletion of the newest records unless an earlier head is kept (the evidence export exists for that; nothing stores heads externally yet).
- **The verifier shares the database with the executor.** It is independent code, not an independent system.
- **The simulators are simple.** The counterparty behaviour is deterministic and scripted.
- **No rate limiting, no CSRF protection, no input size limits beyond zod bounds.** Local demo only.
- **Time.** The pipeline uses the world date (latest balance date) for expiry and the gate, not the wall clock; a real deployment needs a trusted clock.
- **Mandate lifecycle.** No revocation list, no versions beyond the first, no cooling-off.
- **One live model, lightly exercised.** gpt-4o-mini was run once on the sample documents and the planning agent (see progress.md, Batch 7 live verification). Other models, hostile documents and the injected order have not been run live; the injection defences are still proven with scripted outputs only.
- **The scan is a pattern list.** A cleverly worded injection that avoids the patterns is not flagged by the scan; it is still ignored by design, but only the model's own report would catch it.
- **The API key** for a live provider sits in the local .env. Anyone with that file can use it. Keep it out of the repository and out of chat.
- **No PDF or image handling**, no size or rate limits on uploaded text beyond a 200,000 character cap.

## Planning agent (Batch 7)

- **Read-only by construction.** `src/agent` cannot import the action pipeline, sandbox writes, owner-signing, approval or database code (ESLint). The tools read a snapshot built by the orchestrator. submit_plans only validates and hands plans back; the orchestrator stores them.
- **Planner isolation.** The planner sees structured data only: confirmed extraction events, counterparty ids, names, types and history statistics. It never gets raw document text, counterparty free text or personality profiles. Tool results are data, not instructions.
- **Numbers.** The model submits no numbers. Metrics, costs and gate results come from the engine and the pure gate. A sentence of prose with a number found in no computed field or tool result is removed and the plan marked "prose flagged".
- **Bounded.** Step, tool-call, time and token limits; an unavailable or failing model falls back to the deterministic planner.
- **Recommendation guard.** Code, not the model, decides what may be recommended: an AI plan below zero is never ranked above a feasible plan (ADR-015 addendum).
- **Gate dry-run is advisory.** Each lever gets a dry-run decision for display. Nothing is proposed, approved or sent in this batch.
- **Still unprotected.** No live model has been exercised, so real tool-use behaviour is untested. The prose check catches amounts and percentages, not other misleading wording. Counterparty names are shown to the model and are text a counterparty could choose.

## Plan authorisation, negotiation and execution (Batch 8a)

- **One owner signature covers the whole plan.** Business, run, plan id, levers hash, exact requests and bounds hash, expiry, mandate version and mandate hash. Editing the stored plan, the terms, the expiry, or replacing or editing the mandate after signing makes execution refuse (tested). A forged or missing signature fails.
- **The agent never evaluates itself.** The gate runs at signing (propose, then again at approve) and again before every outbound action; the mandate version and hash are re-checked at execution. A plan beyond the mandate is stored as denied and cannot be signed (tested: a 95% advance against an 80% cap).
- **The executor holds no key.** `plan-exec.ts` and `plan-verify.ts` use the public key only; `plan-authorise.ts` (owner key) is blocked from `src/agent` and from app code except one owner route (ESLint; probe tested: importing plan-authorise, plan-exec, plan-verify or owner-signing from `src/agent` gives 5 lint errors).
- **Single use and replay.** The authorisation is consumed by a conditional update and has one execution row; a replay is refused and changes nothing (tested). Expiry uses world time (tested by moving the world date).
- **Counterparty text stays data.** Replies are classified from structured fields; free text is stored as untrusted and not copied into the execution outcome or the log.
- **No automatic acceptance outside the terms.** A counter beyond the signed bound is not accepted and nothing is committed (tested). With zero tolerance only the exact terms continue.
- **All-or-nothing by compensation.** A failure or denial at any step withdraws every agreement and application the plan made live (tested by injecting a failure before the finance take-up). Messages already sent cannot be recalled; they stay in the thread as history. Withdrawal needs no mandate (it only reduces exposure) but may only target things this authorisation created.
- **Independent verification.** The verifier recomputes the forecast from the resulting sandbox state and compares it to the promise; a mismatch is logged with `verification = failed` (tested by editing an agreed term after execution).
- **Still unprotected:** no owner login (the dev key signs; anyone who can reach the route can authorise); the authorise and execute routes have no rate limit; a crash between two sandbox operations is handled by resuming (idempotent steps), not by a distributed transaction, and resume is not tested; concurrent executes of one authorisation are guarded by a conditional update and a unique execution row, not tested under load; the planned supplier payments are not scheduled in the sandbox (see decisions, Batch 8a deviation).

## Real execution, agreed-terms verification and re-planning (Batch 8b)

- **The gate is forecast-aware, not weaker.** A payment is checked against the projected balance on its date and every later date (engine books flows, backed receipts, scheduled payments); every other limit is as before. An unbacked large payment is still denied (tested). Receipts count only when backed by an agreed thread or an accepted application, and a lender receipt cannot exceed the advance the lender offered.
- **The plan's payments stay withdrawable.** Plan payments and receipts stay `scheduled` until the bank's job runs, so compensation can cancel them (tested: failure after the take-up and two receipts rolled everything back).
- **Two confirmations are not bypassed.** A plan with supplier payments above the mandate threshold needs `confirmations: 2` in the signed terms.
- **What the signature does not fix.** The signature binds the levers and bounds; the exact payments and receipts follow from the AGREED terms through the engine. Coverage requires each scheduled item to equal an expected item computed from the log-recorded agreement; the verifier checks the same again afterwards.
- **Verification has a trusted reference.** The expected outcome comes from the hash-chained log, not from rows an executor writes (tested: editing an agreed term fails verification with a clear explanation).
- **Re-planning keeps the planner isolated.** Constraints are numbers and flags from structured replies; the planner still gets no counterparty free text (tested). A refused lever cannot be proposed again (validation rejects it). Nothing executes without a new owner authorisation. At most 2 rounds, then exhausted.
- **Still unprotected / limits (see docs/later-hardening.md):** the demo database keeps the old mandate until re-seeded; thread-backed receipts are not capped against the order amount in the gate (the engine-derived schedule and the verifier check it); the projection counts the engine's estimated inflows; the buyer-deposit plus finance combination cannot carry an accepted buyer counter.

## Chase, early payment, shortage trigger, scoreboard (Batch 9)

- **New levers are inside the signed bounds.** Chase needs `buyer.chase_payment` in the signed mandate (a pre-Batch-9 mandate makes it unavailable); the early-payment discount is capped by the mandate and denied at signing beyond it (tested). Counters outside a signed bound are not accepted; refusals become structured constraints. No free text reaches the planner.
- **The finance application amount is bounded by the signature.** The owner signs a maximum invoice; a re-submitted application above it is not covered (tested). The gate, the advance cap and the offered-advance cap on the lender receipt are unchanged.
- **The overdue assumption is explicit.** Overdue cash is no longer treated as received today; the assumption is configurable, documented and written into every affected forecast line, so the gate projection is not fed optimistic receipts.
- **The shortage trigger cannot execute anything.** It runs the same read-only agent; authorisation and execution still need the owner's signature. It is idempotent by forecast hash (tested), so a repeated check cannot flood the owner with plans, and a changed forecast supersedes old unexecuted runs. The automatic check after a confirmation can be switched off.
- **The scoreboard is computed, not claimed.** Executed-plan numbers come from the verifier's log record (engine output from the log-recorded agreed terms); counts come from the log. It reports a failed verification as failed.
- **Demo mandate v2** was signed with the dev owner key and logged; the same dev-key limitations as before apply (no owner login until Batch 10).
- **Still unprotected / limits:** see docs/later-hardening.md (thread-backed receipts are not capped against the order in the gate; the projection counts the engine's estimated inflows; the shortage check runs only after a confirmation and on request).

## Owner login and signing (Batch 10)

- **Login.** Owner accounts with scrypt-hashed passwords; server-side sessions behind an httpOnly, SameSite=Strict cookie (8 hours); a per-session CSRF token that every change must send; same-origin check on every change; sign-in rate limit (5 failures per 15 minutes per email and address; unknown emails cost the same time as wrong passwords). One place enforces it for every API route and page (`src/proxy.ts`), so an owner route cannot be forgotten; a session works in one business at a time. Tested through the real routes (`bun run e2e:smoke`).
- **Signing.** Signing a plan needs the signed-in owner to re-enter their password (step-up), and a plan with supplier payments above the mandate threshold then WAITS for a second confirmation from a DIFFERENT approver account, who signs in as themselves and re-enters their own password (the plan is not signed by the system until they do; the same person cannot give both; an approver cannot sign as the owner; nobody ever types another person's password). Declining ends the plan. The screen shows what is signed in plain language, built from the same terms that are hashed. Sign-ins, failed sign-ins, step-ups, second approvals and signings are written to the hash-chained log.
- **The key is held by the server.** The Ed25519 owner key is a development key in the server's environment. Anyone who controls the server, or can read its environment, can sign as the owner; the password step-up protects against a hijacked or unattended browser session, not against the server. In production the owner key would stay on the owner's device (a passkey or a hardware security key) and the server would only verify signatures. We do not claim more.
- **Not covered:** the older per-action approve, console and payee re-approval routes (developer tools) now also need the password (Batch 11), but have no second-approver flow; account creation, password change and recovery are not built; sessions are not bound to a device; the demo accounts have published synthetic passwords; cross-business access is blocked for business-scoped routes but not for routes addressed by action or run id (single-tenant demo).
