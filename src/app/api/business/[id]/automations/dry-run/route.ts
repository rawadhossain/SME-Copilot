import { z } from "zod";
import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { loadAutomation } from "@/actions/automation-admin";
import { dryRunFlow } from "@/actions/automations";
import { loadAutomationSnapshot } from "@/actions/monitor";
import { memberOrRefuse } from "@/auth/owner-only";

// Dry run: evaluate a saved automation (automationId) or a flow being edited ({name, graph}) on the current books. Changes nothing: no run is stored, no
// notification is made, nothing is logged and no planning run starts. Any signed-in member.
const bodySchema = z.union([z.strictObject({ automationId: z.string().uuid() }), z.strictObject({ name: z.string(), graph: z.unknown() })]);

export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/automations/dry-run">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const who = await memberOrRefuse(req, id);
  if (who instanceof Response) return who;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(async () => {
    const input = bodySchema.parse(body.data);
    const flow = "automationId" in input ? await loadAutomation(db, id, input.automationId) : { name: input.name, graph: input.graph };
    return dryRunFlow(db, id, flow.name, flow.graph, await loadAutomationSnapshot(db, id));
  });
}
