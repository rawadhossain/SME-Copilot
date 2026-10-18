import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Security boundaries (ADR-010/011).
  {
    files: ["src/agent/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["**/gate/owner-signing", "**/actions/approve", "**/actions/owner-console", "**/actions/payees", "**/actions/plan-authorise", "**/documents/confirm"], message: "src/agent must never import the owner-signing or approval-signing code." },
          ],
        },
      ],
    },
  },
  {
    // Only src/actions (and the sandbox itself) may call sandbox write operations.
    files: ["src/app/**/*.{ts,tsx}", "src/agent/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/sandbox", importNames: ["sendProposal", "schedulePayment", "submitApplication", "executeDuePayments", "cancelPayment", "acceptApplicationOffer", "withdrawApplication", "withdrawThread", "scheduleReceipt", "cancelReceipt", "executeDueReceipts"], message: "Sandbox writes must go through src/actions (the gate)." },
          ],
          patterns: [
            { group: ["**/gate/owner-signing", "**/actions/approve", "**/actions/owner-console", "**/actions/payees", "**/actions/plan-authorise", "**/documents/confirm"], message: "Only the owner-facing API routes may import the owner-signing or approval code." },
          ],
        },
      ],
    },
  },
  // Owner-facing API routes are the only app code allowed to import the approval code.
  {
    files: ["src/app/api/actions/*/approve/route.ts", "src/app/api/business/*/approvals/route.ts", "src/app/api/plan-authorisations/*/second-approval/route.ts", "src/app/api/business/*/mandate/**/*.ts", "src/app/api/business/*/payees/**/*.ts", "src/app/api/business/*/console/route.ts", "src/app/api/business/*/plan-authorisations/**/route.ts", "src/app/api/demo/clone/route.ts", "src/app/api/extractions/*/confirm/route.ts", "src/app/api/extractions/*/reject/route.ts"],
    rules: { "no-restricted-imports": ["error", { paths: [{ name: "@/sandbox", importNames: ["sendProposal", "schedulePayment", "submitApplication", "executeDuePayments", "cancelPayment", "acceptApplicationOffer", "withdrawApplication", "withdrawThread", "scheduleReceipt", "cancelReceipt", "executeDueReceipts"], message: "Sandbox writes must go through src/actions (the gate)." }] }] },
  },
  // The Copilot (src/actions/copilot.ts and its route) is READ-ONLY apart from one log record per question: it must never import plan authorisation, execution,
  // approvals, sandbox writes, owner signing, the mandate code or the simulator hand-off.
  {
    files: ["src/actions/copilot.ts", "src/app/api/business/*/copilot/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "@/sandbox", importNames: ["sendProposal", "schedulePayment", "submitApplication", "executeDuePayments", "cancelPayment", "acceptApplicationOffer", "withdrawApplication", "withdrawThread", "scheduleReceipt", "cancelReceipt", "executeDueReceipts"], message: "The Copilot never writes to the sandbox." }],
          patterns: [{ group: ["**/gate/owner-signing", "**/actions/approve", "**/actions/owner-console", "**/actions/payees", "**/actions/plan-authorise", "**/actions/plan-exec", "**/actions/execute", "**/actions/propose", "**/actions/cancel", "**/actions/flight-handoff", "**/actions/revise", "**/actions/plan-edit", "**/documents/confirm", "**/actions/mandate*"], message: "The Copilot never signs, approves, executes, hands off or changes limits." }],
        },
      ],
    },
  },
  // The planning agent (src/agent) is READ-ONLY: it must not import the action pipeline, sandbox write operations, the
  // owner-signing or approval code, the document confirmation path, or the database. It may use pure engine functions,
  // the pure gate evaluate function, and the pure parts of the sandbox protocol. (ADR-015)
  {
    files: ["src/agent/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/sandbox", message: "src/agent is read-only: import pure types from @/sandbox/proposals only." },
            { name: "@/db", message: "src/agent has no database access; the orchestrator passes in a snapshot." },
            { name: "@/engine/loader", message: "src/agent has no database access." },
            { name: "@/engine/store", message: "src/agent must not write forecast runs." },
            { name: "@/actionlog", message: "The orchestrator logs, not src/agent." },
            { name: "@/auth", message: "src/agent has no access to owner login or sessions." },
          ],
          patterns: [
            { group: ["@/actions", "@/actions/**", "**/actions/*"], message: "src/agent must not import the action pipeline or the orchestrator." },
            { group: ["**/gate/owner-signing", "**/approve", "**/owner-console", "**/payees", "**/plan-authorise", "@/auth/**", "**/documents/confirm", "**/documents/store", "@/db/**", "@/ai/db-logger"], message: "src/agent is read-only: no owner-signing, approval, confirmation or database code." },
          ],
        },
      ],
    },
  },
  // The decision-room screens load their data from the API inside effects (the numbers must come from the API, not from server props).
  {
    files: ["src/ui/**/*.{ts,tsx}", "src/app/room/**/*.{ts,tsx}", "src/app/login/**/*.{ts,tsx}"],
    rules: { "react-hooks/set-state-in-effect": "off" },
  },
]);

export default eslintConfig;
