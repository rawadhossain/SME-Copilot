// OWNER-FACING: confirming an extraction is an owner action (logged in the hash-chained action log).
// After a commitment is confirmed the deterministic shortage detector runs (ADR-026). If it finds a shortage with no run yet it starts the
// READ-ONLY planning run, which only proposes plans. Set SHORTAGE_AUTO_PLAN=off to skip the automatic check.
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { extractions } from "@/db/schema";
import { badId, handle, readJson } from "@/actions/http";
import { checkShortage } from "@/actions/shortage";
import { loadPlaybook } from "@/actions/playbook";
import { watchAfter } from "@/actions/monitor";
import { confirmExtraction } from "@/ingest/documents/confirm";

export async function POST(req: Request, ctx: RouteContext<"/api/extractions/[id]/confirm">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const res = await handle(async () => {
    const confirmed = await confirmExtraction(db, id, z.object({ confirmedBy: z.string() }).parse(body.data).confirmedBy);
    let shortage: unknown = { status: "skipped" };
    if (process.env.SHORTAGE_AUTO_PLAN !== "off") {
      try {
        const [row] = await db.select({ businessId: extractions.businessId }).from(extractions).where(eq(extractions.id, id));
        // Plan once per batch of documents: while another document still waits for the owner, the forecast is incomplete, so wait.
        const waiting = await db.select({ id: extractions.id }).from(extractions).where(and(eq(extractions.businessId, row.businessId), eq(extractions.status, "pending_confirmation"), ne(extractions.id, id)));
        if (waiting.length > 0) shortage = { status: "waiting_for_other_documents", pending: waiting.length };
        else if (!(await loadPlaybook(db, row.businessId)).autoPrepare) shortage = { status: "auto_prepare_off" }; // playbook: the owner starts planning
        else {
          const r = await checkShortage(db, row.businessId, { source: "commitment_confirmed" });
          shortage = { status: r.status, runId: r.runId, superseded: r.superseded, reason: r.detection.reason };
        }
      } catch (e) {
        shortage = { status: "error", message: e instanceof Error ? e.message : "shortage check failed" }; // never blocks the confirmation
      }
    }
    return { ...confirmed, shortage };
  });
  if (res.ok) {
    const [row] = await db.select({ businessId: extractions.businessId }).from(extractions).where(eq(extractions.id, id));
    if (row) void watchAfter(db, row.businessId, "document_confirmed");
  }
  return res;
}
