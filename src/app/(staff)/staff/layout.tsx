import { isStaging } from "@/lib/stage";
import Link from "next/link";
import { BrandMark } from "@/components/brand";
import { StaffMenuButton, StaffSidebar, type NavGroup, type NavItem } from "@/components/staff-nav";
import { SessionActivity } from "@/components/session-activity";
import { SignOutButton } from "@/components/sign-out-button";
import { requireStaff } from "@/shell/auth/session";
import { STAFF_IDLE_MINUTES } from "@/shell/auth/security";
import { getDb } from "@/lib/db";
import { modulesNotLive } from "@/shell/registry/registry";
import { hasPermission } from "@/shell/rbac/permissions";

export const dynamic = "force-dynamic";

export default async function StaffLayout({ children }: LayoutProps<"/staff">) {
  const user = await requireStaff();
  const degraded = await modulesNotLive(getDb());
  const can = (...actions: Parameters<typeof hasPermission>[1][]) => actions.some((a) => hasPermission(user.assignments, a));
  const memberLists = can("member.directory.read", "member.kyc.read");
  // Grouped by the work it serves; a group with nothing visible is left out.
  const groups: NavGroup[] = (
    [
      {
        title: null,
        items: [
          { href: "/staff", label: "Home", exact: true, show: true },
          { href: "/staff/dashboard", label: "Dashboard", show: can("dashboard.gmd.read") },
        ],
      },
      {
        title: "Members",
        items: [
          { href: "/staff/members", label: "Members", show: memberLists },
          { href: "/staff/members/invitations", label: "Invitations", show: can("invitation.send") && !memberLists },
          { href: "/staff/members/profile-changes", label: "Profile changes", show: can("member.profileChange.approve") },
          { href: "/staff/announcements", label: "Announcements", show: can("announcement.send") },
        ],
      },
      {
        title: "Loans",
        items: [
          { href: "/staff/loans", label: "Loans", show: can("credit.read") },
          { href: "/staff/refunds", label: "Refunds", show: can("credit.read") },
          { href: "/staff/legacy-loans", label: "Legacy loans", show: can("legacyImport.upload", "legacyImport.commit") },
        ],
      },
      {
        title: "Money",
        items: [
          { href: "/staff/remittance", label: "Remittance", show: can("credit.read", "sourceAdvice.upload", "schedule.upload") },
          { href: "/staff/bank", label: "Bank", show: can("credit.read", "bankOpening.upload") },
          { href: "/staff/reconciliation", label: "Reconciliation", show: can("credit.read") },
          { href: "/staff/exceptions", label: "Exceptions", show: can("credit.read", "exception.close") },
        ],
      },
      {
        title: "Records",
        items: [
          { href: "/staff/reports", label: "Reports", show: can("reports.read", "ledger.export", "invitation.read", "audit.read") },
          { href: "/staff/evidence", label: "Evidence", show: can("evidence.read") },
          { href: "/staff/audit", label: "Audit trail", show: can("audit.read") },
        ],
      },
      {
        title: "Administration",
        items: [
          { href: "/staff/admin/users", label: "Users & roles", show: can("users.manage") },
          { href: "/staff/admin/import-members", label: "Import members", show: can("member.import.upload") },
          { href: "/staff/admin/bank-accounts", label: "Bank accounts", show: can("bankAccounts.manage") },
          { href: "/staff/admin/sources", label: "Remittance sources", show: can("sources.manage") },
          { href: "/staff/admin/settings", label: "Settings", show: can("settings.read") },
          { href: "/staff/admin/modules", label: "Modules", show: can("modules.manage") },
          { href: "/staff/admin/jobs", label: "Jobs", show: can("jobs.run") },
          { href: "/staff/admin/outbox", label: "Staging outbox", show: isStaging() && can("users.manage") },
        ],
      },
      { title: null, items: [{ href: "/staff/account", label: "My account", show: true }] },
    ] as Array<{ title: string | null; items: Array<NavItem & { show: boolean }> }>
  )
    .map((g) => ({ title: g.title, items: g.items.filter((i) => i.show).map(({ href, label, exact }) => ({ href, label, exact })) }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
          <StaffMenuButton groups={groups} />
          <Link href="/staff" className="rounded-lg">
            <BrandMark subtitle="Staff" />
          </Link>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <Link href="/staff/account" className="hidden min-h-11 items-center rounded-xl px-3 font-semibold text-muted hover:bg-background hover:text-foreground sm:inline-flex">
              {user.name}
            </Link>
            <SignOutButton />
          </div>
        </div>
        <div className="brand-rule rounded-none" aria-hidden="true" />
      </header>
      {degraded.map((m) => (
        <div
          key={m.code}
          role="status"
          className={`px-4 py-2 text-center text-sm font-semibold ${m.status === "OFFLINE" ? "bg-danger/10 text-danger" : "bg-warning/10 text-warning"}`}
        >
          <strong>{m.name}</strong> is {m.status === "OFFLINE" ? "offline: its actions are paused" : "running with problems"}
          {m.reason ? ` — ${m.reason}` : ""}.
        </div>
      ))}
      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-8 px-4 py-6 sm:py-8">
        <StaffSidebar groups={groups} />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
      <SessionActivity idleMinutes={STAFF_IDLE_MINUTES} />
    </div>
  );
}
