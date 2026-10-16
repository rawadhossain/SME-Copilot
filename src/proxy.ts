// Authentication gate for the whole app (Next.js Proxy, Node runtime). Every /api route except sign-in needs a valid session;
// every change (not GET/HEAD) also needs the session's CSRF token in x-csrf-token and a same-origin Origin header.
// Pages redirect to /login. This is the single place that enforces it, so an owner route cannot be forgotten.
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { SESSION_COOKIE, csrfOk, getSession } from "@/auth";
import { demoToolsEnabled } from "@/lib/demo-tools";

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Demo tools are off in a production deployment: answer a real 404 (before anything else, so it does not even ask for sign-in).
  if (pathname === "/dev" && !demoToolsEnabled()) return NextResponse.rewrite(new URL("/__not-found", req.url), { status: 404 });
  const isApi = pathname.startsWith("/api/");
  const session = await getSession(db, req.cookies.get(SESSION_COOKIE)?.value);
  const method = req.method.toUpperCase();
  const changing = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

  // Same-origin check for every change, including sign-in (login CSRF).
  if (isApi && changing) {
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== req.headers.get("host")) return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }
  if (pathname === "/api/auth/login") return NextResponse.next();

  if (!session) {
    if (isApi) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    if (pathname === "/login") return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  if (pathname === "/login") return NextResponse.redirect(new URL("/room", req.url));
  // A session works in one business at a time: business-scoped routes for another business are refused.
  const m = pathname.match(/^\/api\/business\/([0-9a-f-]{36})(\/|$)/i);
  if (m && m[1].toLowerCase() !== session.businessId.toLowerCase()) return NextResponse.json({ error: "This session is working in a different business" }, { status: 403 });
  if (isApi && changing && !csrfOk(session, req.headers.get("x-csrf-token"))) return NextResponse.json({ error: "Missing or wrong CSRF token" }, { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*", "/room/:path*", "/dev", "/login"] };
