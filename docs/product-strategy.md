# SME Finance Copilot: Product Strategy v2

---

## 0. What changed from the first version

The first doc is a solid base. Its data foundation, engineering rules and finance explanations are all worth keeping. It was written as a startup plan for a pilot with real customers. We are now building for the FinTechathon (Topic E), where the theme is "AI as a Financial Participant", so the agent has to complete real tasks and prove it.

| | What happened to it |
|---|---|
| **Kept** | Customer focus, data foundation, deterministic calculations, engineering rules, evidence-backed answers, the finance concepts appendix |
| **Changed** | The product is now an agent that acts (in a sandbox, within limits the owner signs), not only a copilot that explains. Financing moves from "readiness guidance" to a comparison step inside the agent's plans. |
| **Added** | An action layer, a permission and limits system, a sandbox world with simulated counterparties, a verifier, an action log, and a scoreboard |
| **Moved to "later"** | Pricing, pilots, bank aggregators, accounting integrations, retention metrics, and the 12 to 16 week roadmap |

---

## 1. Product thesis

**In one line:** a finance agent for owner-run businesses that can act, not just advise. It deals with the outside world (customers, suppliers, lenders) within limits the owner signs, and it proves what it did.

The first doc's thesis ("know your numbers, anticipate problems, make better decisions") is still right. What we add is a fourth step. The agent doesn't stop at a recommendation. It carries out the approved plan, checks that it worked, and re-plans if reality changes.

**Why add the action layer?**
- The competition scores **task completion 40%**, **security and compliance 30%**, **innovation and interaction 30%**. The submission needs execution evidence, meaning sandbox logs of real actions.
- Forecasts, shortage alerts and chat assistants are already shipped by incumbents. Xero has Cash Flow Actions in beta and QuickBooks has AI forecasts and what-if scenarios (secondary sources, to verify). On their own they look generic.
- Judges can only reward what they can see working. An agent that completes and verifies actions is visible. A forecast is not.

**The product has five parts:**
1. **Senses:** data import, a deterministic cash engine, forecasts, metrics, evidence-backed explanations (most of the first doc).
2. **Brain:** an AI agent with tools. It reads messy documents, plans, asks questions and explains. Ordinary code does all the maths that matters.
3. **Hands:** action tools that really do things in a sandbox: send messages, propose terms, request early payment, submit a financing application, schedule a payment.
4. **Leash:** limits the owner signs, enforced by a rules engine (not by the AI), an independent verifier, and an append-only action log.
5. **World:** a sandbox with a fake bank and ledger, plus simulated counterparties (a buyer, a supplier, a lender) that behave differently.

---

## 2. Customer and the painful moment

**Primary customer (kept):** an owner-run business with about 2 to 20 employees, no full-time finance person, and records spread across a bank export, spreadsheets, invoices and PDFs. Best early fit: a B2B business that pays suppliers and costs before its customers pay.

**The two moments when the agent wakes up:**
1. **A shortage is coming.** The forecast shows cash dropping below the owner's reserve.
2. **A commitment arrives.** The owner forwards a big order, supplier quote or deposit request. Ledger-based tools can't see it yet because it isn't booked. This is the moment incumbents miss.

**Illustrative scenario (invented numbers):** Nadia runs a 14-person packaging distributor. A grocery chain sends a £180,000 purchase order on 60-day terms. Her supplier wants a 30% deposit now and the balance on shipment. She has £42,000, payroll of £28,000 every two weeks and a VAT payment due in week 7. Today she checks her balance and says yes, then finds a hole in week 6.

**Customer discovery questions (kept, plus two):**
- How do you know if you'll have enough cash in 4 to 12 weeks?
- What was your last cash surprise, and what caused it?
- Where do your transactions, invoices, bills and payroll records live?
- What would you do if the product warned you of a shortage?
- **New:** Would you let software message a customer or supplier for you, within limits you set?
- **New:** What is the last big order or deal you hesitated on, and why?

*We have not spoken to real owners yet. Everything here is inferred from research. A few conversations would help a lot.*

---

## 3. How the agent works (the core loop)

```
Trigger (shortage or forwarded commitment)
   -> Investigate (what is driving the gap)
   -> Plan options (with cash effect, cost, risk)
   -> Owner approval (within signed limits)
   -> Execute in the sandbox
   -> Verify the outcome
   -> Re-plan if something changes
   -> Log everything
```

**Step by step:**
1. **Trigger.** A shortage appears in the forecast, or the owner forwards an order or quote. For documents, the agent extracts the terms, marks anything it's unsure about, and asks the owner to confirm key fields.
2. **Investigate.** It removes each driver one at a time and shows how the gap changes: "40% of the shortfall is the supplier deposit, 35% is Customer X paying 3 weeks later than usual." Every figure links to a source record.
3. **Plan options.** Options can involve other parties: ask a customer to pay early for a discount, ask a supplier to split a deposit, claim late-payment interest, or compare financing. Each shows its cash effect, cost and a realistic chance of working. "Don't borrow" is always an option.
4. **Approval.** The owner approves a plan. Anything outside the signed limits needs separate approval.
5. **Execute.** The agent sends the messages, negotiates with the simulated counterparties, submits the application to a mock lender, schedules the payments.
6. **Verify.** It checks each action actually happened (a record in the sandbox bank, an application ID, a parsed reply). Failed steps are retried or reported.
7. **Re-plan.** If a customer pays short or a supplier refuses, the agent updates the plan and asks again.
8. **Log.** Every proposal, approval and action goes into an append-only log that can be exported as execution evidence.

**Financing comparison (replaces "financing readiness" as the headline).** When a gap remains after the other options, the agent compares financing on: total repayment, estimated annualised cost, the effect of repayments on cash week by week, and warnings about stacking (taking a new advance on top of old ones). If the owner picks one, the agent checks the contract against the offer and prepares the application. Free true-cost calculators already exist, so the value is the cash impact and the checking, not the calculator.

---

## 4. What the agent can do (tools)

| Tool | What it does | Tier |
|---|---|---|
| `get_cash_position` | Balances with source and freshness | Read |
| `get_cash_forecast` | Projected balances, assumptions, shortage dates | Read |
| `get_financial_metrics` | Revenue, expenses, margins | Read |
| `explain_variance` | Compare periods or remove one driver and show the effect | Read |
| `simulate_scenario` | Effect of a proposed event or deal on cash | Read |
| `extract_document_terms` | Read an order, quote or offer; mark uncertain fields | Read |
| `compare_financing_options` | True cost, cash impact, stacking check, contract vs offer | Read |
| `draft_message` | Write a message to a counterparty | Draft |
| `send_message` / `propose_terms` | Send or negotiate with a counterparty | External (approval, within limits) |
| `request_early_payment` | Ask a buyer to pay sooner for a discount | External |
| `submit_financing_application` | Send an application to the mock lender | External (explicit consent) |
| `schedule_payment` | Schedule a payment in the sandbox bank | Money (approval plus second confirmation) |
| `verify_outcome` | Check the result of an action | Read |
| `replan` | Update the plan after a change | Read |

**Rule:** the language model never does the arithmetic that matters and never decides whether an action is allowed. Both belong to code.

---

## 5. Trust and security (30% of the score)

- **Permission tiers:** read, draft, external message, money movement.
- **Owner-signed limits** ("mandate"), for example: "may offer up to 1.5% discount, never touch payroll, no new payees, maximum £10k a day." A rules engine enforces them, not the AI. Every action carries a reference to the limit that allowed it.
- **Independent verifier:** a second check re-validates every executed action against the limits and refuses anything out of bounds.
- **Untrusted text:** documents, emails and counterparty messages are treated as data, never as instructions. This covers prompt injection and manipulation.
- **Counterparty protection:** the owner's minimum acceptable terms are never put into prompts that counterparties can influence.
- **Append-only audit log:** each proposal, approval, action and verification.
- **Synthetic data only:** no real credentials, no real money, and all demo data is labelled as synthetic.
- **Known-risk list** (for the self-assessment): wrong document extraction, wrong calculation, over-trust by the owner, injection through documents or counterparties, unauthorised transfers, privacy.

*Blocking one injected invoice is a common hackathon demo and won't stand out on its own. The structure (signed limits, rules engine, verifier, log) is what makes the security story strong.*

---

## 6. What judges would see (demo and evidence)

1. The owner forwards an order. The agent extracts terms, asks about anything uncertain, and the cash timeline shows a hole with the causes ranked.
2. Two or three plans appear, each with the chance of staying above the cash buffer before and after.
3. The owner approves. The agent negotiates and executes in the sandbox while the log fills in.
4. A hostile counterparty (a teammate, or a judge if they're willing) tries to trick the agent. It refuses and logs the attempt.
5. A customer pays short. The agent re-plans.
6. A scoreboard: task success rate, limits never broken, attacks blocked, and cash or cost outcome against a naive baseline.

**Execution evidence for submission:** exported sandbox action logs plus the demo video. *UNKNOWN: whether simulated counterparties are accepted as evidence. The rules require sandbox or simulated-account logs for non-on-chain topics. We should say clearly that counterparties are simulated.*

---

## 7. Feature priorities (no timeline)

| Priority | Capability | Why |
|---|---|---|
| **P0** | Data foundation: CSV import, manual invoices, bills and recurring costs, a synthetic company | Everything depends on it |
| **P0** | Deterministic cash engine with a rolling 13-week forecast and scenario overlays | The senses; all maths in code |
| **P0** | Sandbox world: fake bank and ledger, a few simulated counterparties, exportable action log | Execution evidence |
| **P0** | Permission gate and owner-signed limits, with the verifier | Security score and trust |
| **P0** | Agent loop with tools: one trigger, one negotiation, one verified action, end to end | Task completion |
| **P1** | Second trigger (forwarded order or quote) with document extraction | The distinctive part |
| **P1** | Investigation (driver removal) and plan comparison | Makes the agent feel intelligent |
| **P1** | Financing comparison with cash impact and contract-vs-offer check | Topic E's financing requirement |
| **P1** | Re-planning, and the scoreboard | Proves the agent works |
| **P2** | More counterparty personalities and scenarios, polish, outcome tracking | Depth |

**Deferred (kept from the first doc, plus):** direct lending, automated underwriting, full payroll and tax, real payment initiation, many bank integrations, vector databases, and heavy microservices. Add only what a demonstrated need requires. Multi-agent orchestration is optional; one well-built agent with good tools is enough to start.

---

## 8. Architecture (proposed, not locked)

| Layer | Starting point | Note |
|---|---|---|
| Web app | Next.js + TypeScript | Cash timeline, case file per decision, approvals inbox, action log |
| Backend | TypeScript modules | Domain logic, tool endpoints, permission gate |
| Database | PostgreSQL | Financial data, mandates, action log |
| Finance engine | Plain deterministic code | Forecast, scenarios, cost calculations |
| AI | Model-agnostic gateway with tool calling | Provider UNKNOWN |
| Sandbox | A separate service | Fake bank and ledger, simulated counterparties |
| Jobs and storage | Add only if needed | Background jobs for forecast runs; file storage for documents |

**Data flow:** sources (CSV, documents) -> ingestion and validation -> normalised records -> finance engine -> forecast and scenarios -> agent (plans using tools) -> permission gate -> sandbox actions -> verifier -> action log -> dashboard and approvals.

**Core entities (kept, plus new ones):** Business and Membership, FinancialAccount and Transaction, Invoice and Bill, RecurringCommitment, ForecastRun and ForecastLine, Recommendation, FinancingOffer. **New:** Counterparty, Mandate (the owner's signed limits), Plan and ActionProposal, ActionRecord (the log entry with its verification), NegotiationMessage, EvalScenario and EvalRun.

**Engineering rules (kept, with additions):**
- Money is integer minor units with explicit currency; never floating point.
- Keep calculations, forecasts and AI interpretation as separate components.
- Preserve provenance and distinguish actuals, confirmed commitments, estimates and assumptions.
- Explicit owner approval for external messages, applications and money movement.
- The core dashboard stays useful if the AI provider is unavailable.
- **New:** every agent action goes through the permission gate; limits live in code, not prompts.
- **New:** untrusted text is never treated as instructions.
- **New:** every executed action is logged and verified.
- **New:** synthetic data is always labelled.

---

## 9. Differentiation and competitors

**What we build to be different:**
- Two triggers, including the forwarded commitment the books can't see yet.
- Cause investigation, with every number traced to a source record.
- Options that involve other parties (customers, suppliers, lenders), not only internal advice.
- Real negotiation against simulated counterparties, within limits the owner signs.
- Financing guidance that includes the option not to borrow, and checks the contract.
- A verifier, an audit log and a public scoreboard.

| Competitor type | Does well | Our position |
|---|---|---|
| Accounting platforms (QuickBooks, Xero) | Bookkeeping, forecasts, growing AI agents inside their own ledger | Work from bank exports and documents; handle commitments not yet booked; act with counterparties |
| Forecasting tools (Float, Fathom) | Scenario forecasts | Move from scenarios to executed, verified actions |
| AI CFO tools | Conversational insights | Actions under signed limits, with evidence |
| Lending marketplaces | Introductions to lenders | Check cost and cash impact first; don't stop at the introduction |
| Enterprise working-capital tools (SAP Taulia, Pactum, Causa Prima) | Negotiation for the buyer side at large companies | We act for the small business; we found no supplier-side equivalent (absence of evidence only) |
| Other hackathon entries (e.g. DuitDuit on GitHub) | Privacy pipeline, audit logs, financing readiness | Avoid looking like a copy; lead with the action loop |

*These are positioning hypotheses from secondary research, not claims that competitors lack every feature. Verify before using them in the submission.*

---

## 10. Risks

| Risk | What we do |
|---|---|
| Simulated counterparties feel fake | Give them real personalities (cooperative, stingy, hostile), declare them as simulated, show the benchmark |
| Scope is large | Get one full loop excellent first: one trigger, one negotiation, one verified action |
| Wrong document extraction | Confidence markers, owner confirms key fields |
| Wrong numbers | All maths in tested code; assumptions always visible |
| Owner over-trusts the agent | Show ranges, assumptions and evidence; require approval |
| Prompt injection or manipulation | Untrusted-text rule, rules engine, verifier, attack scenarios in the scoreboard |
| Looks generic | Lead with the commitment trigger, the negotiation and the scoreboard |
| Demo fails live | Rehearse only verified flows, keep a recorded fallback |

---

## 11. Open decisions for the team

1. **Which concept leads?** Candidates: Terms Desk (get paid sooner), Deal Desk (can I take this order), Offer Referee (check financing offers), Leashed Autopilot (safe bill pay), Payer Pulse (late-payer prediction). Or a combination. UNKNOWN.
2. Initial country and currency for the story. UNKNOWN.
3. Which counterparty personalities to build first. UNKNOWN.
4. Which AI model and provider. UNKNOWN.
5. Whether to keep multi-agent out of the first version. Recommended: yes.
6. Can we talk to 5 to 8 owners or accountants this week?

**Rules questions still open:** whether the 0 to 5 on-chain bonus applies to Topic E; how many teams reach the finals; how task completion is judged; whether simulated counterparties count as evidence.

---

## 12. Beyond the hackathon (moved from the first doc)

Kept for later, not for the competition:
- **Model:** subscription-first. Test indicative tiers of $19 to 39 and $49 to 99 a month.
- **Pilot:** 10 to 20 businesses with at least 3 months of transaction history, weekly interviews, retention and willingness to pay.
- **Integrations:** CSV first; then QuickBooks Online or Xero; a bank data aggregator for one country (Plaid, TrueLayer, Tink are candidates, not guarantees); then payment processors; verified lenders last.
- **Metrics:** onboarding in about 30 minutes, forecast error at 7, 30 and 90 days, alert usefulness, retention.
- **Regulation:** start with information and comparisons; get legal advice before any regulated activity.

---

## Appendix: finance concepts for the team

| Concept | Meaning | Why it matters here |
|---|---|---|
| Revenue | Value earned from sales | Not the same as cash received |
| Profit | Revenue minus costs | Economic performance |
| Cash flow | Cash in and out over time | Decides whether bills get paid |
| Accounts receivable | Money customers owe | Expected receipts, and collection risk |
| Accounts payable | Money owed to suppliers | Future payments |
| Working capital | Current assets minus current liabilities | Short-term capacity |
| Gross margin | Gross profit as a share of revenue | Pricing and product health |
| Runway | How long cash lasts at the current burn | Urgency |
| Debt-service coverage | Cash available for debt payments versus what is required | Whether a loan is affordable |
| Unit economics | Revenue and costs per order or customer | Whether growth is sustainable |

**Profit is not liquidity.** A profitable business can run out of cash when customers pay late, and a business can have cash because it borrowed while losing money. The product has to model both.
