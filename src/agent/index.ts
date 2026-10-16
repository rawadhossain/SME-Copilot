// The planning agent: READ-ONLY tools, prompts, plan validation and the deterministic fallback.
// Nothing in src/agent may import src/actions, sandbox write operations, the owner-signing module or approval code (ESLint).
// The orchestrator that writes to the database and the action log is src/actions/agent-run.ts.
export * from "./context";
export { buildAgentTools } from "./tools";
export { AGENT_PURPOSE, SYSTEM_PROMPT, buildMessages } from "./prompt";
export { deterministicPlans } from "./fallback";
export { guardRanking, demoteBlocked } from "./guard";
export { buildPlanView, doNothingSummary, leverBounds, leverProblems, dryRun, describeLever } from "./plan-builder";
export { ASSIST_PURPOSE, assistOutputSchema, buildAssistMessages, applyEdits, ruleEdits, type AssistChange, type AssistCounterparty } from "./edit-assist";
export { LETTER_ASSIST_PURPOSE, letterRewriteSchema, buildLetterRewriteMessages, ruleRewrite, type LetterRewrite } from "./letter-assist";
export { checkProse, collectNumbers, claimsIn } from "./prose";
import "./scripted";
export { BAD_AGENT_PURPOSE, WEAK_AGENT_PURPOSE } from "./scripted";
