"use client";
// Session context and the single fetch helper for the decision room. Every change carries the session's CSRF token.
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export interface SessionInfo {
  user: { id: string; email: string; displayName: string; role: "owner" | "approver" };
  csrfToken: string;
  business: { id: string; name: string; currency: string; isSynthetic: boolean; isTest: boolean };
  businesses: { id: string; name: string; isTest: boolean }[];
  /** True only when demo tools are on (development, or DEMO_TOOLS=on): the /dev page and sample documents. */
  demoTools?: boolean;
}

let csrf = "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function call<T = any>(path: string, body?: unknown, method?: string): Promise<{ ok: boolean; status: number; data: T }> {
  const m = method ?? (body === undefined ? "GET" : "POST");
  const res = await fetch(path, {
    method: m,
    headers: { "content-type": "application/json", ...(m !== "GET" && csrf ? { "x-csrf-token": csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full reload on purpose: it resets all signed-in state
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth/login")) window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

interface Ctx { session: SessionInfo | null; refresh: () => Promise<void> }
const SessionContext = createContext<Ctx>({ session: null, refresh: async () => {} });
export const useSession = () => useContext(SessionContext);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const refresh = useCallback(async () => {
    const r = await call<SessionInfo>("/api/auth/session");
    if (r.ok) { csrf = r.data.csrfToken; setSession(r.data); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <SessionContext.Provider value={{ session, refresh }}>{children}</SessionContext.Provider>;
}

