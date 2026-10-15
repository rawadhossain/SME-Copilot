// Small helpers shared by the sandbox API routes: id validation and consistent error responses.
import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { SandboxError } from "./index";
import { toJsonValue } from "./proposals";

export const uuidSchema = z.string().uuid();

export function badId(id: string): Response | null {
  return uuidSchema.safeParse(id).success ? null : NextResponse.json({ error: "Invalid business id" }, { status: 400 });
}

export async function readJson(req: Request): Promise<{ ok: true; data: unknown } | { ok: false; res: Response }> {
  try {
    return { ok: true, data: await req.json() };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "Body must be JSON" }, { status: 400 }) };
  }
}

export async function respond<T>(fn: () => Promise<T | null>): Promise<Response> {
  try {
    const result = await fn();
    if (result === null) return NextResponse.json({ error: "Business not found" }, { status: 404 });
    return NextResponse.json(toJsonValue(result));
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ error: "Invalid request", issues: e.issues }, { status: 400 });
    if (e instanceof SandboxError) return NextResponse.json({ error: e.message }, { status: 422 });
    return NextResponse.json({ error: "Sandbox error" }, { status: 500 });
  }
}
