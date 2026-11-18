import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { staffSummary, workQueue, type SummaryTile } from "@/modules/credit/reports/work-queue";
import { requireStaff } from "@/shell/auth/session";
import { STAFF_IDLE_MINUTES } from "@/shell/auth/security";
import { hasPermission } from "@/shell/rbac/permissions";

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

const TONE: Record<SummaryTile["tone"], string> = { blue: "border-accent-strong", green: "border-brand-green", sky: "border-brand-sky" };

function greeting(): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

export default async function StaffHome() {
  const user = await requireStaff();
  const can = (a: Parameters<typeof hasPermission>[1]) => hasPermission(user.assignments, a);
  const [queue, tiles] = await Promise.all([workQueue(getDb(), can), staffSummary(getDb(), can)]);
  const today = new Intl.DateTimeFormat("en-NG", { timeZone: "Africa/Lagos", dateStyle: "full" }).format(new Date());
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-muted">{today}</p>
        <h1 className="mt-1 text-2xl font-semibold">
          {greeting()}, {user.name.split(" ")[0]}
        </h1>
      </div>

      {tiles.length ? (
        <section aria-label="At a glance" className="grid gap-3 sm:grid-cols-3">
          {tiles.map((t) => (
            <div key={t.key} className={`rounded-2xl border-t-4 bg-surface p-4 shadow-[0_1px_2px_rgba(35,31,32,.06),0_4px_16px_rgba(35,31,32,.06)] ${TONE[t.tone]}`}>
              <p className="text-xs font-bold tracking-wide text-muted uppercase">{t.label}</p>
              <p className="mt-1 text-2xl font-extrabold tabular-nums">{t.value}</p>
              {t.note ? <p className="mt-0.5 text-xs text-muted">{t.note}</p> : null}
            </div>
          ))}
        </section>
      ) : null}

      <Card title="Waiting for you">
        {queue.length ? (
          <ul className="-my-1 divide-y divide-border">
            {queue.map((q) => (
              <li key={q.key}>
                <Link href={q.href} className="group flex min-h-12 items-center gap-3 py-2">
                  <span className="inline-grid h-8 min-w-8 place-items-center rounded-full bg-accent px-2 text-sm font-bold text-accent-foreground tabular-nums">{q.count}</span>
                  <span className="flex-1 text-sm font-semibold group-hover:text-accent">{q.label}</span>
                  <span aria-hidden="true" className="text-muted group-hover:text-accent">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted">
            <span aria-hidden="true" className="inline-grid h-6 w-6 place-items-center rounded-full bg-success/10 text-xs font-bold text-success">
              ✓
            </span>
            Nothing is waiting for you right now.
          </p>
        )}
      </Card>

      <Card title="Your roles" footer={`For your security you are signed out after ${STAFF_IDLE_MINUTES} minutes without activity.`}>
        <ul className="flex flex-wrap gap-2 text-sm">
          {user.assignments.map((a) => (
            <li key={`${a.moduleCode}:${a.role}`} className="rounded-full border border-border px-3 py-1">
              {ROLE_LABELS[a.role] ?? a.role}
              <span className="ml-1 text-xs text-muted">({a.moduleCode === "SHELL" ? "portal-wide" : "Credit"})</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
