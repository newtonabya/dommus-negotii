import Link from "next/link";
import { SessionActivity } from "@/components/session-activity";
import { SignOutButton } from "@/components/sign-out-button";
import { requireStaff } from "@/shell/auth/session";
import { STAFF_IDLE_MINUTES } from "@/shell/auth/security";
import { hasPermission } from "@/shell/rbac/permissions";

export const dynamic = "force-dynamic";

export default async function StaffLayout({ children }: LayoutProps<"/staff">) {
  const user = await requireStaff();
  const nav = [
    { href: "/staff", label: "Home", show: true },
    { href: "/staff/admin/users", label: "Users & roles", show: hasPermission(user.assignments, "users.manage") },
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
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
      <SessionActivity idleMinutes={STAFF_IDLE_MINUTES} />
    </div>
  );
}
