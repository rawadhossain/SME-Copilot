// OWNER-FACING: change a payee's bank details. The payee becomes unapproved until the owner re-approves.
import { z } from "zod";
import { db } from "@/db";
import { updatePayeeBankDetails } from "@/actions/payees";
import { badId, handle, readJson } from "@/actions/http";

const bodySchema = z.object({ accountRef: z.string(), changedBy: z.string().default("owner") });

export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/payees/[payeeId]/bank-details">) {
  const { id, payeeId } = await ctx.params;
  const bad = badId(id) ?? badId(payeeId);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(async () => {
    const b = bodySchema.parse(body.data);
    return updatePayeeBankDetails(db, id, payeeId, b.accountRef, b.changedBy);
  });
}
