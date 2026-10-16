import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { sessionFromRequest } from "@/auth";
import { demoToolsEnabled } from "@/lib/demo-tools";

// Who am I, which business am I working in, and the CSRF token to send with changes.
export async function GET(req: Request) {
  const s = await sessionFromRequest(db, req);
  if (!s) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const [b] = await db.select().from(businesses).where(eq(businesses.id, s.businessId));
  const mine = await db.select({ id: businesses.id, name: businesses.name, isTest: businesses.isTest, createdAt: businesses.createdAt }).from(businesses);
  const allowed = mine
    .filter((x) => x.id === s.user.businessId || x.isTest)
    .sort((a, c) => c.createdAt.getTime() - a.createdAt.getTime());
  const current = allowed.find((x) => x.id === s.businessId);
  const rest = allowed.filter((x) => x.id !== s.businessId).slice(0, 14);
  const listed = (current ? [current, ...rest] : rest.slice(0, 15)).map((x) => ({ id: x.id, name: x.name, isTest: x.isTest }));
  return NextResponse.json({
    user: s.user, csrfToken: s.csrfToken, expiresAt: s.expiresAt,
    business: { id: b.id, name: b.name, currency: b.baseCurrency, isSynthetic: b.isSynthetic, isTest: b.isTest },
    businesses: listed,
    demoTools: demoToolsEnabled(),
  });
}
