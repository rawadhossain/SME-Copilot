import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { getSimulatorOptions, simulateScenario } from "@/actions/flight-simulator";

// Financial flight simulator: read-only. GET lists what can be simulated; POST recomputes the forecast and every strategy for a hypothetical
// scenario. It changes no book, creates no proposal, approval or payment, and writes only one log record. Needs a session (and CSRF token for POST).
export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/simulate">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  return handle(() => getSimulatorOptions(db, id));
}

export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/simulate">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => simulateScenario(db, id, body.data));
}
