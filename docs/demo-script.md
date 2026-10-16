# Demo script (5 minutes)

Setup once: README "Run the demo". Open http://localhost:3000, sign in as the owner (owner@mercer-vale.example / Ledger-Owner-2026). Second approver: finance@mercer-vale.example / Ledger-Approver-2026. Everything is synthetic.

**Say first (15 s):** "The agent investigates and proposes. The owner signs the limits. The system acts only inside them, and everything is verified and logged. The strip at the top says it."

## 1. Start clean (20 s)
Open **/dev** (demo tools, not linked from the app) and click **Start a fresh demo** (on /dev). *"A new copy of the company, so we can replay this as often as we like. The log of everything else is untouched."*
Open **Cash desk**: healthy, no shortage. Point at **lowest projected** and the reserve line.

## 2. A new commitment (40 s)
**Commitments** → **Add both sample documents** → open each one.
Point at: green "found in the text" verdicts (the reader quotes evidence; deterministic code checks it), the total £96,000 quote and £180,000 order. *"The reader is quarantined: no tools, and its words are data."* Confirm the quote, then the purchase order (**Confirm** is the owner's act and is logged).
*"The agent plans once, after the last confirmation."*

## 3. The shortage (30 s)
Back on **Cash desk**: red banner, **below zero**, lowest about **−£61,227 in week 10, first negative week 5**. *"Found by a deterministic check, not by the model."* Click **Open the case**.

## 4. The plans (60 s)
**Shortage case** → timeline: tool calls only. *"The planner never sees document text or counterparty free text."*
Plan comparison: point at **Lowest balance**, **Weeks below zero**, **Cost**, **Parties to ask**, and **Your mandate: within your limits**. Click **Show on the chart**: dashed grey is doing nothing, teal is the plan.
*"Every number is from the cash engine; the agent's wording sits under an 'explanation' label and cannot change a figure."*

## 5. Sign (50 s)
On **Plan 3** (it offers Northgate Grocers a 1% early-payment discount) click **Review and sign…**. Read the dialog aloud: *"It will ask… it will accept… it will never… valid until… mandate version 2."* Enter the owner password and sign: this plan can schedule supplier payments above £10,000, so it now **waits for a second approver**. Sign out, sign in as finance@mercer-vale.example (Ledger-Approver-2026), open **Approvals**, read the plan and confirm it with their own password. Then sign back in as the owner and run it.
*"The signature covers exactly this text. Change anything later and execution refuses."*

## 6. The buyer says no (40 s)
**Run the plan.** One counterparty answers outside the signed terms: Northgate wants **at least 1.5%** (we offered 1%). Point at **Stopped: needs a re-plan**, the line **"Northgate wants at least a 1.5% discount"**, and the red **Rolled back** note. *"Nothing is half-applied. The agent did not improvise: a counter outside what you signed is not accepted."*

## 7. Re-plan and sign again (40 s)
Click **Ask the agent to re-plan** (round 1 of 2). The new plan respects the learned constraint. **Review and sign…** again (a new signature; nothing runs automatically).

## 8. Execute and verify (50 s)
**Run the plan.** Point at the counterparty table (agreed), the scheduled receipts and payments (they stay scheduled so they can be withdrawn), and **Verification passed**: *promised → agreed terms → recomputed from the sandbox*, all matching. *"A separate check, not the code that executed."*
Point at the executed plan's levers: 14-day deferral, invoice finance **and an early-payment discount (1.5%, to Harbourline, the buyer that accepts it)**.

## 9. Safety & records (40 s)
**Scoreboard**: lowest balance **−£61,227 if you do nothing, £37,171 with the executed plan** (£98,398 better), owner approvals 2, denied or blocked 0.
**Mandate & safety**: click **Try to break it** on "Pay payroll through the agent" and "a payment the projected balance cannot cover": refused, and the refusals are in the log.
**Evidence**: click **Verify the chain now**. On the case page click **Export evidence** and open the HTML: *"it re-checks the owner's signatures and the hash chain by itself, offline."* (Optionally edit the JSON and run `node scripts/verify-export.mjs` to show it fail.)

## Numbers worth pointing at
Do-nothing lowest balance −£61,227 (week 10); first negative week 5; executed plan lowest £37,171; quote £96,000, order £180,000; second confirmation above £10,000; per-payment limit £80,000; early-payment cap 1.5%; re-plan limit 2 rounds; evidence export 29+ checks.

## If something goes off-script
The recordings cover exactly this path. If you pick another plan the planner may say **fallback used** (still correct, deterministic). **Start a fresh demo** (on /dev) resets the story at any time.
