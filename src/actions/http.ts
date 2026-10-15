// Maps pipeline errors to HTTP responses: 400 invalid input, 404 unknown, 409 conflict, 422 refused or denied.
import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { SandboxError } from "@/sandbox";
import { toJsonValue } from "@/sandbox/proposals";
import { ActionError } from "./types";

export const uuidSchema = z.string().uuid();

export const badId = (id: string): Response | null => (uuidSchema.safeParse(id).success ? null : NextResponse.json({ error: "Invalid id" }, { status: 400 }));

export async function readJson(req: Request): Promise<{ ok: true; data: unknown } | { ok: false; res: Response }> {
  try {
    return { ok: true, data: await req.json() };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "Body must be JSON" }, { status: 400 }) };
  }
}

export async function handle<T>(fn: () => Promise<T | null>, notFound = "Not found"): Promise<Response> {
  try {
    const result = await fn();
    if (result === null) return NextResponse.json({ error: notFound }, { status: 404 });
    return NextResponse.json(toJsonValue(result));
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ error: "Invalid request", issues: e.issues }, { status: 400 });
    if (e instanceof ActionError) {
      const status = e.code === "not_found" ? 404 : e.code === "conflict" ? 409 : e.code === "invalid" ? 400 : 422;
      return NextResponse.json({ error: e.message, details: e.details ? toJsonValue(e.details) : undefined }, { status });
    }
    if (e instanceof SandboxError) return NextResponse.json({ error: e.message }, { status: 422 });
    return NextResponse.json({ error: "Unexpected error" }, { status: 500 });
  }
}
