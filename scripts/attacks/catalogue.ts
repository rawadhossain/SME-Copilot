// THE ATTACK CATALOGUE. One reproducible list of attacks that assume the planner, a document or a counterparty is COMPROMISED. Each attack runs against a
// throwaway is_test clone (mock provider, pinned books date) and is judged on four things: the system refuses with the expected kind and reason code,
// nothing money-bearing changed, the attempt is in the audit log exactly where the design says, and nothing was signed or executed as a side effect.
// Nothing here makes a claim about how any real language model behaves.
import type { Attack } from "./types";
import { gateAttacks } from "./gate-attacks";
import { planAttacks } from "./plan-attacks";
import { untrustedAttacks } from "./untrusted-attacks";
import { privilegeAttacks } from "./privilege-attacks";
import { evidenceAiAttacks } from "./evidence-ai-attacks";
import { copilotAttacks } from "./copilot-attacks";
import { secretsAttacks } from "./secrets-attacks";

// The secrets scan runs last: it reads what every earlier attack stored.
export const CATALOGUE: Attack[] = [...gateAttacks, ...untrustedAttacks, ...planAttacks, ...privilegeAttacks, ...evidenceAiAttacks, ...copilotAttacks, ...secretsAttacks];
