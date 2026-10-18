# Spec sheet: features, phases, status

Status as of 2026-10-16 (after Batch 14c). Sources: `product-strategy.md` (v2), the original strategy .docx, `progress.md`, a code search.
Legend: DONE = built and checked. PARTIAL = built with a gap. UNVERIFIED = built, not tested in a real browser or with a real model. NOT FOUND = I could not find it in the code or logs (a search, not a proof). NOT BUILT = known missing.

## 1. Phases built so far

| Phase | Batches | Result |
|---|---|---|
| A. Foundation | 1, 1B, 2 | Scaffold, Postgres, append-only hash-chained log, money library, synthetic company, CSV import |
| B. Senses | 3, 3B | Deterministic 13-week cash engine, scenarios, driver attribution, forecast page |
| C. World and leash | 4, 5 | Sandbox bank and counterparties, mandate, permission gate, approvals, action pipeline, verifier |
| D. Brain | 6, 7, 7.5 | AI gateway (record/replay), safe document reading, planning agent, plan search |
| E. Hands | 8a, 8b | Plan authorisation, negotiation, execution, agreed-terms verification, re-planning |
| F. Levers and scoreboard | 9 | Chase and early-payment levers, shortage trigger, scoreboard |
| G. Owner product | 10, 12 | Login, decision room, plain-language screens |
| H. Proof | 11 | Canonical recordings, evidence export with offline verifier, hardening, README and demo script |
| I. Owner control | 13, 14, 14b, 14c | Plan editor, assistant-assisted edit, partial revisions, proposal letters, drawn and typed signature, letter rewrite assistant |

## 2. Feature status by area

### Data foundation (strategy P0)
| Feature | Status |
|---|---|
| CSV import with validation, de-duplication, reconciliation | DONE |
| Synthetic company, labelled synthetic | DONE |
| Money as integer minor units | DONE |
| Manual entry of invoices, bills, recurring costs (screen) | NOT FOUND |
| Transaction categorisation | NOT FOUND |

### Senses (strategy P0)
| Feature | Status |
|---|---|
| Rolling 13-week forecast with provenance, reserve, shortage detection | DONE |
| Scenario overlays, downside variant | DONE |
| Driver attribution ("what is causing the gap") | DONE |
| Overdue-invoice collection model | DONE |
| Revenue, expenses, margins, period comparison (`get_financial_metrics`) | NOT FOUND |
| Anomalies and data-quality indicators | NOT FOUND |
| `explain_variance` between periods | NOT FOUND (driver removal exists) |
| Forecast backtesting | NOT FOUND |
| Alerts beyond the shortage trigger | NOT FOUND |
| Probability of staying above the buffer per plan | NOT FOUND |

### Brain
| Feature | Status |
|---|---|
| Provider-agnostic AI gateway, record/replay, telemetry | DONE |
| Quarantined document reading, validator, suspicious-text scan, owner confirm | DONE |
| Planning agent with tools, plan search, prose-number check, fallback | DONE |
| Plans compared with cash effect, cost, mandate checks | DONE |
| Grounded chat / natural-language Q&A with evidence links | NOT FOUND |
| `draft_message` and replies to free-text counterparty messages | PARTIAL (structured protocol only; letters are code-drafted) |
| Financing comparison: true cost, two yearly cost estimates, week-by-week cash effect, debt service coverage, stacking, "don't borrow" first, saved offers, signed limits, typed contract-vs-offer check, agent tool (Phase K) | DONE (contract document reading and a gated loan application NOT BUILT; page not clicked through in a browser) |

### Hands and world
| Feature | Status |
|---|---|
| Fake bank, ledger, payees, scheduled payments and receipts | DONE |
| Simulated counterparties with personalities, one hostile | DONE |
| Negotiation (counters, caps, tolerances), rollback, held agreements | DONE |
| Lender application, accept and withdraw | DONE |
| Chase and early-payment levers | DONE |
| Re-plan after rejection, out-of-terms counter, failed verification (max 2 agent rounds, 6 owner rounds) | DONE |
| Re-plan when a customer pays short during execution | NOT FOUND |
| Scheduling money actions with second confirmation | DONE |

### Leash and security (30% of the score)
| Feature | Status |
|---|---|
| Owner-signed mandate (Ed25519), limits enforced in code | DONE |
| Pure gate with forecast-aware payment check | DONE |
| Independent verifier (per action and per plan) | DONE |
| Append-only log with hash chain, chain verify | DONE |
| Agent layer cannot import signing or approval code (ESLint) | DONE |
| Untrusted-text rule, documents and counterparty text as data | DONE |
| Password step-up, second approver, CSRF, rate limit, cookie flags | DONE |
| Evidence export (JSON/HTML) with offline re-verification | DONE (HTML self-verify UNVERIFIED in a real browser) |
| Server refuses a plan that breaks a payment limit at signing | NOT BUILT (flagged, demoted, stopped at run time) |
| Mandate lifecycle: expiry, renewal, revocation | NOT BUILT |
| Passkey / hardware signing | NOT BUILT |
| Attack lab screen | DROPPED (documents are scanned automatically; "Try to break it" exists) |

### Owner product and interaction (30% of the score)
| Feature | Status |
|---|---|
| Login, plain-language navigation, next-step bar | DONE |
| Today screen, commitments, decision room, results, limits, proof | DONE |
| Plan editor, assistant-assisted edit, partial revision | DONE (assistant has no real-model recording) |
| Proposal letters with locked terms, drawn signature | DONE |
| Typed (keyboard) signature | UNVERIFIED |
| Letter rewrite assistant | UNVERIFIED (untested by request, no recording) |
| Owner notes added to letters | DONE (not sent on counter-acceptance re-proposals) |
| Scoreboard (executed, verified, approvals) | PARTIAL |
| Scoreboard: attacks blocked, limits never broken, outcome vs naive baseline | NOT FOUND |
| Multi-language letters | NOT BUILT |
| Full real-browser QA of the decision room | NOT DONE |

### Submission
| Item | Status |
|---|---|
| README, demo script, demo walkthrough, security model | DONE |
| Mapping to the Topic E requirements | NOT DONE (requirements not provided) |
| Demo video, exported evidence for submission | NOT DONE |

## 3. Known defects
- Database login for `sme_app` fails on the main database (checks were run on a throwaway Postgres).
- `check:engine`, `check:agent`, `check:extract` fail on a fresh seed (date and recording dependent).
- Resubmitted plan for a different invoice amount keeps old letter wording.

## 4. Next phases

| Phase | Goal | Contents | Done when |
|---|---|---|---|
| J. Repair | Green baseline | Fix the database login; pin the seed date or re-record so the three checks pass; retire or re-record the stale live scripts | lint, typecheck, all `check:*`, `e2e:smoke`, `db:verify-chain` pass on the real database |
| K. Financing comparison | Topic E financing requirement | Deterministic module: total repayment, annualised cost, weekly cash effect, stacking check, contract-vs-offer check, "don't borrow" option; show in the decision room | One happy and one failure check; numbers come from code only |
| L. Proof of work | Task completion and security scoring | Pays-short re-plan trigger; scoreboard additions (attacks blocked, limits never broken, naive baseline); server refusal of unrunnable plans at signing; minimal mandate revoke/expiry | One happy and one failure check per item |
| M. Owner analysis | Complete the old P0 set | Small analysis page: revenue, expenses, margins, period comparison, anomalies, data quality; manual invoice/bill entry; basic categorisation | Page renders from engine data; no model arithmetic |
| N. Verify and polish | Close UNVERIFIED items | Browser click-through (typed signature, letter assistant, HTML export, decision room); one recorded real-model run each for plan edit and letter rewrite; crash-resume test | Results written into `progress.md` |
| O. Submission | Hand-in | Owner sends Topic E requirements; map each to feature, check, demo step; demo video; export evidence | Every requirement mapped |
| Optional | Only if time | Grounded Q&A chat; free-text counterparty replies; multi-language letters; passkey signing | Owner decides |

Recommended order: J, K, L, O (mapping early), M, N, then optional items.

## 5. Left in `docs/later-hardening.md` and open questions
Open questions 29, 32, 36, 37, 38 to 42; everything in `later-hardening.md`.
