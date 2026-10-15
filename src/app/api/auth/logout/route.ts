import { NextResponse } from "next/server";
import { db } from "@/db";
import { SESSION_COOKIE, logout, readCookie } from "@/auth";

export async function POST(req: Request) {
  await logout(db, readCookie(req.headers.get("cookie"), SESSION_COOKIE));
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
  return res;
}
