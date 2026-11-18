import { AppShell, type NavGroup, type NavItem } from "@/components/app-shell";
import { SessionActivity } from "@/components/session-activity";
import { getDb } from "@/lib/db";
import { isStaging } from "@/lib/stage";
import { workQueue } from "@/modules/credit/reports/work-queue";
import { requireStaff } from "@/shell/auth/session";
import { STAFF_IDLE_MINUTES } from "@/shell/auth/security";
import { modulesNotLive } from "@/shell/registry/registry";
import { hasPermission } from "@/shell/rbac/permissions";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<string, string> = {
  TREASURER: "Treasurer",
  FINANCE_MANAGER: "Finance Manager",
  CASHIER: "Cashier",
  LOAN_OFFICER: "Loan Officer",
  MANAGEMENT: "Management",
  AUDITOR: "Auditor",
  ADMIN: "Admin",
  GMD: "GMD",
  SECRETARY: "Secretary",
};

export default async function StaffLayout({ children }: LayoutProps<"/staff">) {
  const user = await requireStaff();
  const db = getDb();
  const can = (...actions: Parameters<typeof hasPermission>[1][]) => actions.some((a) => hasPermission(user.assignments, a));
  const [degraded, queue] = await Promise.all([modulesNotLive(db), workQueue(db, (a) => can(a))]);
  // What waits for this person, shown as a count beside the page that has the list.
  const waiting = new Map<string, number>();
  for (const q of queue) waiting.set(q.href, (waiting.get(q.href) ?? 0) + q.count);
  const memberLists = can("member.directory.read", "member.kyc.read");

  // Grouped by the work it serves; a group with nothing visible is left out.
  const groups: NavGroup[] = (
    [
      {
        title: null,
        items: [
          { href: "/staff", label: "Home", icon: "home", exact: true, show: true },
          { href: "/staff/dashboard", label: "Dashboard", icon: "dashboard", show: can("dashboard.gmd.read") },
        ],
      },
      {
        title: "Members",
        items: [
          { href: "/staff/members", label: "Members", icon: "users", show: memberLists },
          { href: "/staff/members/invitations", label: "Invitations", icon: "invite", show: can("invitation.send") && !memberLists },
          { href: "/staff/members/profile-changes", label: "Profile changes", icon: "userCheck", show: can("member.profileChange.approve") },
          { href: "/staff/announcements", label: "Announcements", icon: "megaphone", show: can("announcement.send") },
        ],
      },
      {
        title: "Loans",
        items: [
          { href: "/staff/loans", label: "Loans", icon: "loans", show: can("credit.read") },
          { href: "/staff/refunds", label: "Refunds", icon: "refund", show: can("credit.read") },
          { href: "/staff/legacy-loans", label: "Legacy loans", icon: "archive", show: can("legacyImport.upload", "legacyImport.commit") },
        ],
      },
      {
        title: "Money",
        items: [
          { href: "/staff/remittance", label: "Remittance", icon: "layers", show: can("credit.read", "sourceAdvice.upload", "schedule.upload") },
          { href: "/staff/bank", label: "Bank", icon: "bank", show: can("credit.read", "bankOpening.upload") },
          { href: "/staff/reconciliation", label: "Reconciliation", icon: "scale", show: can("credit.read") },
          { href: "/staff/exceptions", label: "Exceptions", icon: "alert", show: can("credit.read", "exception.close") },
        ],
      },
      {
        title: "Records",
        items: [
          { href: "/staff/reports", label: "Reports", icon: "reports", show: can("reports.read", "ledger.export", "invitation.read", "audit.read") },
          { href: "/staff/evidence", label: "Evidence", icon: "evidence", show: can("evidence.read") },
          { href: "/staff/audit", label: "Audit trail", icon: "audit", show: can("audit.read") },
        ],
      },
      {
        title: "Administration",
        items: [
          { href: "/staff/admin/users", label: "Users & roles", icon: "userCog", show: can("users.manage") },
          { href: "/staff/admin/import-members", label: "Import members", icon: "upload", show: can("member.import.upload") },
          { href: "/staff/admin/bank-accounts", label: "Bank accounts", icon: "card", show: can("bankAccounts.manage") },
          { href: "/staff/admin/sources", label: "Remittance sources", icon: "building", show: can("sources.manage") },
          { href: "/staff/admin/settings", label: "Settings", icon: "settings", show: can("settings.read") },
          { href: "/staff/admin/modules", label: "Modules", icon: "modules", show: can("modules.manage") },
          { href: "/staff/admin/jobs", label: "Jobs", icon: "clock", show: can("jobs.run") },
          { href: "/staff/admin/outbox", label: "Staging outbox", icon: "inbox", show: isStaging() && can("users.manage") },
        ],
      },
      { title: null, items: [{ href: "/staff/account", label: "My account", icon: "user", show: true }] },
    ] as Array<{ title: string | null; items: Array<NavItem & { show: boolean }> }>
  )
    .map((g) => ({
      title: g.title,
      items: g.items.filter((i) => i.show).map(({ href, label, icon, exact }) => ({ href, label, icon, exact, badge: waiting.get(href) })),
    }))
    .filter((g) => g.items.length > 0);

  const roles = [...new Set(user.assignments.map((a) => ROLE_LABELS[a.role]).filter(Boolean))];
  const banners = degraded.length ? (
    <div className="print:hidden">
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
    </div>
  ) : null;

  return (
    <>
      <AppShell
        area="Staff portal"
        homeHref="/staff"
        groups={groups}
        user={{ name: user.name, detail: roles.length > 2 ? `${roles.slice(0, 2).join(", ")} +${roles.length - 2}` : roles.join(", ") || "Staff", accountHref: "/staff/account" }}
        banners={banners}
      >
        {children}
      </AppShell>
      <SessionActivity idleMinutes={STAFF_IDLE_MINUTES} />
    </>
  );
}
