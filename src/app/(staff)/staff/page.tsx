import type { Metadata } from "next";
import { Card } from "@/components/ui/form";
import { requireStaff } from "@/shell/auth/session";

export const metadata: Metadata = { title: "Staff home" };

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
  MEMBER: "Member",
};

export default async function StaffHome() {
  const user = await requireStaff();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Welcome, {user.name.split(" ")[0]}</h1>
      <Card title="Your roles">
        <ul className="flex flex-wrap gap-2 text-sm">
          {user.assignments.map((a) => (
            <li key={`${a.moduleCode}:${a.role}`} className="rounded-full border border-border px-3 py-1">
              {ROLE_LABELS[a.role] ?? a.role}
              <span className="ml-1 text-xs text-muted">({a.moduleCode === "SHELL" ? "portal-wide" : "Credit"})</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted">
          Loans, schedules and reconciliation arrive in later milestones. Your session ends after 30 minutes without activity.
        </p>
      </Card>
    </div>
  );
}
