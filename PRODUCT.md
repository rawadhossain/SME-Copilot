# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: the owner of a small business (about 2 to 20 people, no finance staff), whose records are scattered across bank exports, spreadsheets, invoices and PDFs. Persona: Nadia, who runs a packaging distributor and must decide on a large order before she can see the cash hole it opens.
Equal second audience: FinTechathon (2026 Shenzhen, Topic E) judges, who evaluate the working product and its evidence. Both audiences get the same product; the interface must serve an owner acting and a judge verifying without separate modes.

## Product Purpose

Ledgerhand is a finance agent for owner-run businesses that acts, not only advises. It watches cash, investigates shortages, proposes plans, and executes approved actions against a sandbox (fake bank, simulated customers, suppliers and lenders) inside limits the owner signs. Success: the owner understands position and risk in seconds, approves a plan, and sees verified proof of what changed.

## Positioning

Incumbent accounting tools forecast inside their own ledger. Ledgerhand handles commitments not yet booked (forwarded orders, quotes), negotiates with counterparties under owner-signed limits enforced by code, and proves every action with an independent verifier and an append-only log.

## Operating Context

Flow: Understand, Anticipate, Decide, Act, Verify. Everything runs in a sandbox with synthetic data, labelled as such. Desktop-first.

## Capabilities and Constraints

- Money is integer minor units; all numbers shown come from deterministic code, never model prose.
- The AI never decides whether an action is allowed; the permission gate does.
- No external CDN, fonts, scripts or analytics: everything is served locally.
- Interface languages: English and Simplified Chinese (not yet implemented in the UI; layout must tolerate both scripts).
- Existing routes, APIs and data flow stay intact.

## Brand Commitments

Name: Ledgerhand. Colour and theme follow the lovable-dummy reference (deep forest green, sage, warm-neutral paper, semantic green/amber/red). Interaction quality follows the upay-compass reference (springy press feedback, View-Transition-style route changes, restrained glass).

## Evidence on Hand

Synthetic demo company seeded by `bun run db:seed`. No real customers, testimonials or benchmarks exist; none may be invented.

## Product Principles

1. Clarity over anxiety: lead with position, risk and the next action.
2. Numbers are computed, labelled actual vs projected, and traceable.
3. Every action path shows its limits, approval and verification.
4. Fewer, better visualisations; whitespace over boxes.
5. Calm, trustworthy motion that explains state change.

## Accessibility & Inclusion

No formal standard recorded. Keep readable contrast, visible focus, keyboard operation, and honour prefers-reduced-motion.
