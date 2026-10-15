import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { eventsForConfirmed } from "@/ingest/documents";

// The CommitmentEvents mapped (deterministically) from a CONFIRMED extraction. Unconfirmed extractions return 409.
export async function GET(_req: Request, ctx: RouteContext<"/api/extractions/[id]/events">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => eventsForConfirmed(db, id));
}
