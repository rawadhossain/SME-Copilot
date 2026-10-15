"use client";
// Session context and the single fetch helper for the decision room. Every change carries the session's CSRF token.
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export interface SessionInfo {
  user: { id: string; email: string; displayName: string; role: "owner" | "approver" };
  csrfToken: string;
  business: { id: string; name: string; currency: string; isSynthetic: boolean; isTest: boolean };
  businesses: { id: string; name: string; isTest: boolean }[];
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

/** Adds the CSRF token to same-origin changes made by the older /demo pages, which use plain fetch. */
export function CsrfFetch() {
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      const sameOrigin = url.startsWith("/") || url.startsWith(window.location.origin);
      if (sameOrigin && method !== "GET" && method !== "HEAD" && !url.includes("/api/auth/login")) {
        if (!csrf) {
          const r = await original("/api/auth/session");
          if (r.ok) csrf = ((await r.json()) as SessionInfo).csrfToken;
        }
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (!headers.has("x-csrf-token")) headers.set("x-csrf-token", csrf);
        return original(input, { ...init, headers });
      }
      return original(input, init);
    };
    return () => { window.fetch = original; };
  }, []);
  return null;
}
