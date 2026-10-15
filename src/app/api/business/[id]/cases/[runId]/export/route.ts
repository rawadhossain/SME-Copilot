import { NextResponse } from "next/server";
import { db } from "@/db";
import { ACTION_EVENTS, appendActionRecord } from "@/actionlog";
import { badId, handle } from "@/actions/http";
import { buildCaseExport } from "@/export/build";
import { renderEvidenceHtml } from "@/export/html";

// OWNER-TRIGGERED evidence export for one case: ?format=json (default) or ?format=html (a readable summary that re-verifies itself).
// Needs a session (proxy). The export itself is logged AFTER it is built, so it never changes the file it describes.
export async function GET(req: Request, ctx: RouteContext<"/api/business/[id]/cases/[runId]/export">) {
  const { id, runId } = await ctx.params;
  const bad = badId(id) ?? badId(runId);
  if (bad) return bad;
  const format = new URL(req.url).searchParams.get("format") === "html" ? "html" : "json";
  const errored = await handle(async () => {
    const bundle = (await buildCaseExport(db, id, runId)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    await appendActionRecord(db, { businessId: id, event: ACTION_EVENTS.EVIDENCE_EXPORTED, actor: "owner", detail: { rootRunId: runId, format, records: bundle.log.count, headHash: bundle.log.head?.hash ?? null } });
    return bundle;
  });
  if (errored.status !== 200) return errored;
  const bundle = await errored.json();
  const file = `evidence-${runId.slice(0, 8)}`;
  if (format === "html") return new NextResponse(renderEvidenceHtml(bundle), { headers: { "content-type": "text/html; charset=utf-8", "content-disposition": `attachment; filename="${file}.html"` } });
  return new NextResponse(JSON.stringify(bundle, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${file}.json"` } });
}
