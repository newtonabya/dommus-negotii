import Link from "next/link";
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
  const nav = [
    { href: "/staff", label: "Home", show: true },
    {
      href: "/staff/members",
      label: "Members",
      show: hasPermission(user.assignments, "member.directory.read") || hasPermission(user.assignments, "member.kyc.read"),
    },
    {
      href: "/staff/members/invitations",
      label: "Invitations",
      show:
        hasPermission(user.assignments, "invitation.send") &&
        !hasPermission(user.assignments, "member.directory.read") &&
        !hasPermission(user.assignments, "member.kyc.read"),
    },
    {
      href: "/staff/members/profile-changes",
      label: "Profile changes",
      show: hasPermission(user.assignments, "member.profileChange.approve"),
    },
    { href: "/staff/evidence", label: "Evidence", show: hasPermission(user.assignments, "evidence.read") },
    { href: "/staff/audit", label: "Audit trail", show: hasPermission(user.assignments, "audit.read") },
    { href: "/staff/admin/users", label: "Users & roles", show: hasPermission(user.assignments, "users.manage") },
    { href: "/staff/admin/sources", label: "Remittance sources", show: hasPermission(user.assignments, "sources.manage") },
    { href: "/staff/admin/settings", label: "Settings", show: hasPermission(user.assignments, "settings.read") },
    { href: "/staff/admin/modules", label: "Modules", show: hasPermission(user.assignments, "modules.manage") },
    { href: "/staff/admin/jobs", label: "Jobs", show: hasPermission(user.assignments, "jobs.run") },
    { href: "/staff/admin/import-members", label: "Import members", show: hasPermission(user.assignments, "member.import.upload") },
    { href: "/staff/account", label: "My account", show: true },
  ];
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="font-semibold">Dommus Negotii</span>
          <nav className="flex flex-wrap gap-4 text-sm">
            {nav
              .filter((n) => n.show)
              .map((n) => (
                <Link key={n.href} href={n.href} className="text-muted hover:text-foreground">
                  {n.label}
                </Link>
              ))}
          </nav>
          <div className="ml-auto flex items-center gap-4 text-sm">
            <span className="text-muted">{user.name}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      {degraded.map((m) => (
        <div
          key={m.code}
          role="status"
          className={`px-4 py-2 text-center text-sm ${m.status === "OFFLINE" ? "bg-danger/10 text-danger" : "bg-accent/10 text-accent"}`}
        >
          <strong>{m.name}</strong> is {m.status === "OFFLINE" ? "offline: its actions are paused" : "running with problems"}
          {m.reason ? ` — ${m.reason}` : ""}.
        </div>
      ))}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
      <SessionActivity idleMinutes={STAFF_IDLE_MINUTES} />
    </div>
  );
}
