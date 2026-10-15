import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { AuthError, SESSION_COOKIE, SESSION_HOURS, login } from "@/auth";

// Public route (everything else under /api needs a session; see src/proxy.ts). Rate limited per email and address.
export async function POST(req: Request) {
  const body = z.object({ email: z.string().max(200), password: z.string().max(200) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  try {
    const r = await login(db, body.data.email, body.data.password, ip);
    const res = NextResponse.json({ user: r.user, csrfToken: r.csrfToken });
    res.cookies.set(SESSION_COOKIE, r.token, { httpOnly: true, sameSite: "strict", path: "/", maxAge: SESSION_HOURS * 3600, secure: new URL(req.url).protocol === "https:" });
    return res;
  } catch (e) {
    if (e instanceof AuthError) {
      const res = NextResponse.json({ error: e.message }, { status: e.code === "locked" ? 429 : 401 });
      if (e.retryAfterSeconds) res.headers.set("retry-after", String(e.retryAfterSeconds));
      return res;
    }
    return NextResponse.json({ error: "Sign-in failed." }, { status: 500 });
  }
}
