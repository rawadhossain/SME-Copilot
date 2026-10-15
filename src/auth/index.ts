// Owner login (Batch 10). Hashed passwords (scrypt), server-side sessions behind an httpOnly cookie, a per-session CSRF token,
// login rate limiting, step-up re-authentication for signing, and a second approver for two-confirmation signing.
// The Ed25519 dev signing key stays on the server (src/gate/owner-signing.ts); this module never touches it.
// Logins, failed logins, step-ups and logouts are written to the hash-chained action log (for known accounts).
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { db as appDb } from "@/db";
import { ACTION_EVENTS, appendActionRecord } from "@/actionlog";
import { businesses, loginAttempts, ownerSessions, ownerUsers } from "@/db/schema";

type Db = typeof appDb;

export const SESSION_COOKIE = "sme_session";
export const SESSION_HOURS = 8;
export const MAX_FAILURES = 5;
export const WINDOW_MINUTES = 15;

export class AuthError extends Error {
  constructor(public code: "invalid" | "locked" | "forbidden", message: string, public retryAfterSeconds?: number) {
    super(message);
  }
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString("base64")}$${hash.toString("base64")}`;
}

// A fixed hash so an unknown email costs the same time as a wrong password.
const DUMMY = hashPassword("not-a-real-password");

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

export interface Session {
  id: string;
  user: { id: string; email: string; displayName: string; role: "owner" | "approver"; businessId: string };
  businessId: string;
  csrfToken: string;
  expiresAt: Date;
}

async function recentFailures(db: Db, key: string): Promise<{ count: number; oldest: Date | null }> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000);
  const rows = await db.select({ at: loginAttempts.at, ok: loginAttempts.ok }).from(loginAttempts).where(and(eq(loginAttempts.key, key), gt(loginAttempts.at, since))).orderBy(loginAttempts.at);
  // A success resets the count.
  const lastOk = rows.map((r) => r.ok).lastIndexOf(true);
  const fails = rows.slice(lastOk + 1).filter((r) => !r.ok);
  return { count: fails.length, oldest: fails[0]?.at ?? null };
}

export async function login(db: Db, emailInput: string, password: string, ip: string) {
  const email = emailInput.trim().toLowerCase();
  const key = `${email}|${ip}`;
  const f = await recentFailures(db, key);
  if (f.count >= MAX_FAILURES) {
    const wait = Math.max(1, Math.ceil(((f.oldest?.getTime() ?? Date.now()) + WINDOW_MINUTES * 60_000 - Date.now()) / 1000));
    throw new AuthError("locked", `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} minute(s).`, wait);
  }
  const [user] = await db.select().from(ownerUsers).where(eq(ownerUsers.email, email));
  const ok = verifyPassword(password, user?.passwordHash ?? DUMMY) && !!user;
  await db.insert(loginAttempts).values({ key, ok });
  if (!ok || !user) {
    if (user) await appendActionRecord(db, { businessId: user.businessId, event: ACTION_EVENTS.AUTH_LOGIN_FAILED, actor: "owner", detail: { email, ip, failuresInWindow: f.count + 1 } });
    throw new AuthError("invalid", "That email and password do not match.");
  }
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
  await db.insert(ownerSessions).values({ userId: user.id, businessId: user.businessId, tokenHash: sha(token), csrfToken, expiresAt });
  await appendActionRecord(db, { businessId: user.businessId, event: ACTION_EVENTS.AUTH_LOGIN, actor: "owner", detail: { email, role: user.role, ip } });
  return { token, expiresAt, csrfToken, user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role as "owner" | "approver", businessId: user.businessId } };
}

export async function getSession(db: Db, token: string | undefined | null): Promise<Session | null> {
  if (!token) return null;
  const [row] = await db
    .select({ s: ownerSessions, u: ownerUsers })
    .from(ownerSessions)
    .innerJoin(ownerUsers, eq(ownerUsers.id, ownerSessions.userId))
    .where(and(eq(ownerSessions.tokenHash, sha(token)), gt(ownerSessions.expiresAt, sql`now()`)));
  if (!row) return null;
  return {
    id: row.s.id, businessId: row.s.businessId, csrfToken: row.s.csrfToken, expiresAt: row.s.expiresAt,
    user: { id: row.u.id, email: row.u.email, displayName: row.u.displayName, role: row.u.role as "owner" | "approver", businessId: row.u.businessId },
  };
}

export async function logout(db: Db, token: string | undefined | null) {
  const session = await getSession(db, token);
  if (!session) return;
  await db.delete(ownerSessions).where(eq(ownerSessions.id, session.id));
  await appendActionRecord(db, { businessId: session.user.businessId, event: ACTION_EVENTS.AUTH_LOGOUT, actor: "owner", detail: { email: session.user.email } });
}

/** Step-up: the signed-in owner must re-enter their password before a signature is made. Logged either way. */
export async function verifyStepUp(db: Db, session: Session, password: unknown, purpose: string) {
  const [user] = await db.select().from(ownerUsers).where(eq(ownerUsers.id, session.user.id));
  const ok = typeof password === "string" && !!user && verifyPassword(password, user.passwordHash);
  await appendActionRecord(db, { businessId: session.businessId, event: ok ? ACTION_EVENTS.AUTH_STEP_UP : ACTION_EVENTS.AUTH_STEP_UP_FAILED, actor: "owner", detail: { email: session.user.email, purpose } });
  if (!ok) throw new AuthError("forbidden", "Your password was not accepted, so nothing was signed.");
}

/** The second confirmation: a DIFFERENT user with the approver role in the same business re-enters their own password. */
export async function verifySecondApprover(db: Db, session: Session, input: unknown, purpose: string): Promise<string> {
  const i = (input ?? {}) as { email?: unknown; password?: unknown };
  const email = typeof i.email === "string" ? i.email.trim().toLowerCase() : "";
  const [user] = email ? await db.select().from(ownerUsers).where(eq(ownerUsers.email, email)) : [];
  const ok = !!user && typeof i.password === "string" && verifyPassword(i.password, user.passwordHash) && user.id !== session.user.id && user.role === "approver" && user.businessId === session.user.businessId;
  await appendActionRecord(db, { businessId: session.businessId, event: ok ? ACTION_EVENTS.AUTH_SECOND_APPROVAL : ACTION_EVENTS.AUTH_SECOND_APPROVAL_FAILED, actor: "owner", detail: { by: email || null, requestedBy: session.user.email, purpose } });
  if (!ok || !user) throw new AuthError("forbidden", "The second approver was not accepted (it must be a different approver account in this business).");
  return user.displayName;
}

/** A session may work in its user's own business or in a business flagged as a demo clone. */
export async function switchBusiness(db: Db, session: Session, businessId: string) {
  const [b] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  if (!b || (b.id !== session.user.businessId && !b.isTest)) throw new AuthError("forbidden", "That business is not available to this account.");
  await db.update(ownerSessions).set({ businessId }).where(eq(ownerSessions.id, session.id));
}

export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export async function sessionFromRequest(db: Db, req: Request): Promise<Session | null> {
  return getSession(db, readCookie(req.headers.get("cookie"), SESSION_COOKIE));
}

export const csrfOk = (session: Session, header: string | null): boolean => {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(session.csrfToken);
  return a.length === b.length && timingSafeEqual(a, b);
};
