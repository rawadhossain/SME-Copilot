import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { askAboutCash } from "@/actions/cash-ask";

// "Ask about my cash": read-only. Builds facts with deterministic code, may use one model call without tools to phrase the answer, and writes
// nothing but a log record. It cannot sign, approve, pay or send. Needs a session and CSRF token (proxy).
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/ask">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => askAboutCash(db, id, body.data));
}
