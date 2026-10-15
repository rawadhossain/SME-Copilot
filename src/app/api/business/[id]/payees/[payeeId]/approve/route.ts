// OWNER-FACING: re-approve a payee at its current bank details.
import { z } from "zod";
import { db } from "@/db";
import { reapprovePayee } from "@/actions/payees";
import { badId, handle } from "@/actions/http";
import { stepUpOrRefuse } from "@/auth/route";

export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/payees/[payeeId]/approve">) {
  const { id, payeeId } = await ctx.params;
  const bad = badId(id) ?? badId(payeeId);
  if (bad) return bad;
  const raw = await req.json().catch(() => ({}));
  const refused = await stepUpOrRefuse(req, (raw as { password?: unknown })?.password, "re-approve a payee");
  if (refused) return refused;
  const body = z.object({ approvedBy: z.string().default("owner") }).safeParse(raw);
  return handle(() => reapprovePayee(db, id, payeeId, body.success ? body.data.approvedBy : "owner"));
}
