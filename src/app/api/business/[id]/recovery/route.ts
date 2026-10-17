import { NextResponse } from "next/server";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { eq } from "drizzle-orm";
import { badId, handle } from "@/actions/http";
import { listRecoveryCases, previewRecovery, runRecovery } from "@/actions/recovery";

// Cash-flow recovery. GET looks (what would be detected now, and the cases so far) and writes nothing. POST detects and, for a situation that has no
// case yet, proposes a recovery: it never signs, approves or executes anything, and the same situation returns the same case (idempotent).
export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/recovery">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(async () => ({ preview: await previewRecovery(db, id), cases: await listRecoveryCases(db, id) }));
}

export async function POST(_req: Request, ctx: RouteContext<"/api/business/[id]/recovery">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const [biz] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, id));
  if (!biz) return NextResponse.json({ error: "Business not found" }, { status: 404 });
  return handle(() => runRecovery(db, id).then(({ report, ...rest }) => ({ ...rest, report })));
}
