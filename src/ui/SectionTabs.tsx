"use client";
// The five primary areas of the product, and the tab bar shared by the pages of a group. The old page paths ARE the tab targets: nothing redirects.
// Owner: Today, Books (Invoices & bills | Orders & quotes), Plans, Plan ahead (Simulator | Funding | Automations), Safety & records. An approver sees the same areas;
// Approvals sits beside Plans as a second tab, so it stays one click away.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "./session";

export interface NavTab { href: string; label: string }
export interface NavGroup { id: string; label: string; href: string; tabs: NavTab[] }

export function navGroups(role: "owner" | "approver"): NavGroup[] {
  return [
    { id: "today", label: "Today", href: "/room", tabs: [] },
    { id: "books", label: "Books", href: "/room/invoices", tabs: [{ href: "/room/invoices", label: "Invoices & bills" }, { href: "/room/commitments", label: "Orders & quotes" }, { href: "/room/analysis", label: "Analysis" }] },
    { id: "plans", label: "Plans", href: "/room/case", tabs: role === "approver" ? [{ href: "/room/case", label: "Plans" }, { href: "/room/approvals", label: "Approvals" }] : [] },
    { id: "ahead", label: "Plan ahead", href: "/room/simulator", tabs: [{ href: "/room/simulator", label: "Simulator" }, { href: "/room/funding", label: "Funding" }, { href: "/room/automations", label: "Automations" }] },
    { id: "safety", label: "Safety & records", href: "/room/safety", tabs: [] },
  ];
}

/** The group a path belongs to (Today only for /room itself). */
export function groupOf(path: string, groups: NavGroup[]): NavGroup | undefined {
  return groups.find((g) => (g.id === "today" ? path === "/room" : [g.href, ...g.tabs.map((t) => t.href)].some((h) => path === h || path.startsWith(`${h}/`))));
}

export function SectionTabs() {
  const { session } = useSession();
  const path = usePathname();
  const group = session ? groupOf(path, navGroups(session.user.role)) : undefined;
  if (!group || group.tabs.length < 2) return null;
  return (
    <nav aria-label={`${group.label} sections`} className="utabs mt-1 basis-full">
      {group.tabs.map((t) => {
        const on = path === t.href || path.startsWith(`${t.href}/`);
        return <Link key={t.href} href={t.href} aria-current={on ? "page" : undefined} className="utab">{t.label}</Link>;
      })}
    </nav>
  );
}
