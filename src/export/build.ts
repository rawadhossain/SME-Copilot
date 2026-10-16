// Evidence export for one case (Batch 11): JSON bundle + a standalone HTML summary that re-verifies itself in the browser.
// The bundle holds: the case (runs, plans considered), every signed mandate version and plan authorisation WITH signatures, every action with
// its gate result, the verification results, the scoreboard entry, the business's hash-chained log with the head hash, and the owner PUBLIC key.
// It holds no private key, no password, no session and no raw document text (confirmed extractions appear in the log only as hashes; the log
// holds only fingerprints and lengths of suspicious text, never the text; older logs may still contain short snippets, counted below).
import { eq, inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actionProposals, businesses, mandates, planAuthorisations, planExecutions } from "@/db/schema";
import { toJsonValue } from "@/sandbox/proposals";
import { getEvidence } from "@/actions/read";
import { getScoreboard } from "@/actions/scoreboard";
import { getCase } from "@/actions/room";
import { ActionError, type Db } from "@/actions/types";

export async function buildCaseExport(db: Db, businessId: string, rootRunId: string) {
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  if (!biz) throw new ActionError("not_found", "Business not found");
  const c = (await getCase(db, businessId, rootRunId)) as { runs: any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const runIds = c.runs.map((r) => r.id as string);
  const auths = await db.select().from(planAuthorisations).where(inArray(planAuthorisations.runId, runIds));
  const authIds = auths.map((a) => a.id);
  const execs = authIds.length ? await db.select().from(planExecutions).where(inArray(planExecutions.authorisationId, authIds)) : [];
  const acts = authIds.length ? await db.select().from(actionProposals).where(inArray(actionProposals.authorisationId, authIds)) : [];
  const mand = await db.select().from(mandates).where(eq(mandates.businessId, businessId));
  const evidence = (await getEvidence(db, businessId)) as unknown as { count: number; head: { chainSeq: string; hash: string } | null; chain: { ok: boolean; brokenAt: string | null }; records: Record<string, unknown>[] };
  const sb = (await getScoreboard(db, businessId)) as unknown as { entries: { runId: string }[] };
  const suspicious = evidence.records.filter((r) => r.event === "security.suspicious_text_detected").length;

  return toJsonValue({
    format: "ledgerhand-evidence/1",
    exportedAt: new Date().toISOString(),
    synthetic: true,
    note: "All data is synthetic (sandbox). Re-verify this file offline with scripts/verify-export.mjs, or open the HTML export: it verifies itself.",
    business: { id: biz.id, name: biz.name, currency: biz.baseCurrency, isSynthetic: biz.isSynthetic },
    publicKey: process.env.OWNER_SIGNING_PUBLIC_KEY ?? null,
    mandates: mand.sort((a, b) => a.version - b.version).map((m) => ({ version: m.version, active: m.active, signedAt: m.signedAt, canonical: m.canonical, signature: m.signature })),
    rootRunId,
    runs: c.runs.map((r) => ({
      id: r.id, round: r.round, parentRunId: r.parentRunId, lifecycle: r.lifecycle, status: r.status, planSource: r.planSource, model: r.model, mode: r.mode, startedAt: r.startedAt,
      trigger: r.trigger, constraints: r.constraints, doNothing: r.doNothing, fallbackUsed: r.fallbackUsed, timeline: r.timeline.map((t: any) => ({ seq: t.seq, label: t.label, at: t.at })), // eslint-disable-line @typescript-eslint/no-explicit-any
      plans: r.plans,
    })),
    authorisations: auths.map((a) => {
      const ex = execs.find((e) => e.authorisationId === a.id);
      return {
        id: a.id, businessId: a.businessId, runId: a.runId, planId: a.planId, leversHash: a.leversHash, termsHash: a.termsHash, terms: a.terms, mandateVersion: a.mandateVersion, mandateHash: a.mandateHash,
        expiresAt: a.expiresAt.toISOString(), status: a.status, signature: a.signature, approvedBy: a.approvedBy, signedAt: a.signedAt, gateResult: a.gateResult,
        letters: a.letters ?? null, lettersHash: a.lettersHash ?? null, signatureImage: a.signatureImage ?? null, signatureHash: a.signatureHash ?? null,
        execution: ex ? { status: ex.status, outcome: ex.outcome, verification: ex.verification, startedAt: ex.startedAt, finishedAt: ex.finishedAt } : null,
        actions: acts.filter((x) => x.authorisationId === a.id).map((x) => ({ id: x.id, kind: x.kind, status: x.status, payload: x.payload, payloadHash: x.payloadHash, gateResult: x.gateResult, result: x.result, idempotencyKey: x.idempotencyKey })),
      };
    }),
    scoreboard: sb.entries.find((e) => e.runId === rootRunId) ?? null,
    log: { count: evidence.count, head: evidence.head, chainOkAtExport: evidence.chain.ok, suspiciousTextRecords: suspicious, records: evidence.records },
  });
}

/** The verifier source, embedded in the HTML export (the `export` keywords are removed so it runs as an inline module). */
export function verifierSource(): string {
  return readFileSync(join(process.cwd(), "src", "export", "verify-core.js"), "utf8").replace(/^export /gm, "");
}
