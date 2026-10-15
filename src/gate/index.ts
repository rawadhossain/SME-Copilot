// The permission gate: owner-signed mandate, request types and the pure evaluate() function.
// owner-signing.ts is deliberately NOT exported here (private key); import it directly where the owner acts.
export * from "./canonical";
export * from "./mandate";
export * from "./request";
export * from "./evaluate";
export { checkSignedMandate, verifyApprovalSignature, verifyPlanAuthorisationSignature, verifyText } from "./verify";
export type { ApprovalMessage, PlanAuthorisationMessage } from "./owner-signing-types";
